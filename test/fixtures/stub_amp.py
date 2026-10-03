#!/usr/bin/env python3
"""Stub AMP SaaS backend for amp-openclaw-plugin tier-2 tests (stdlib only).

Copied from the workspace compat harness (.tools/compat/openclaw/stub_amp.py)
with the M5 fixes: an unknown mode is an error, never a silent allow.

Implements every endpoint the plugin (index.js) and hook (handler.ts) call:
  POST /api/agent/init        -> {instance_id}
  POST /api/log               -> {ok}
  POST /api/agent/setState    -> {ok}
  POST /api/hitl/request      -> depends on mode
  GET  /api/hitl/get-decision -> depends on mode

Mode is switchable at runtime:  POST /__mode {"mode": "...", "bound_request": false}  or  GET /__mode?set=...
An unknown mode returns HTTP 400 {"error": "unknown mode"} and leaves the mode unchanged.
Modes:
  allow            hitl/request -> {"status":"no-hitl"}
  no_policy        hitl/request -> {"status":"no_policy"}
  policy_error     hitl/request -> HTTP 500
  policy_error_200 hitl/request -> 200 {"status":"policy_error","reason":..,"message":"Missing field(s): who"}
  garbage          hitl/request -> {"status":"banana"}      (unknown status)
  null_body        hitl/request -> 200 literal null
  hitl_approve     hitl/request -> {"status":"pending"} (no workitem_id, like production H3);
                   1st get-decision -> {"status":"pending","workitem_id":..}, then complete/approve
  hitl_reject      same, get-decision -> complete/reject
  hitl_modify      same, get-decision -> complete/modify + modified_action.params
  hitl_cancelled   same, get-decision -> K1 cancelled body (complete/reject, method cancelled)
  hitl_slow        same, get-decision stays "pending" for DECISION_DELAY_S then approve
  poll429          same request; every get-decision -> HTTP 429 {"error":"call_limit_reached"}
  down             every /api/* -> connection dropped (simulates backend down)
Work items and poll counts are scoped by caller_id, like the real backend.
bound_request=true (POST /__mode, or STUB_BOUND_REQUEST=1) restores the legacy shape:
hitl/request returns the workitem_id and the first poll is already the decision.
Every request is appended as a JSON line to STUB_LOG (default: a file in the system temp dir).
"""
import json
import os
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("STUB_PORT", "18999"))
LOG = os.environ.get("STUB_LOG", os.path.join(tempfile.gettempdir(), "amp-oc-stub_requests.jsonl"))
DECISION_DELAY_S = float(os.environ.get("STUB_DECISION_DELAY_S", "20"))

HITL_MODES = {"hitl_approve", "hitl_reject", "hitl_modify", "hitl_cancelled", "hitl_slow", "poll429"}
MODES = {"allow", "no_policy", "policy_error", "policy_error_200", "garbage", "null_body", "down"} | HITL_MODES

_initial = os.environ.get("STUB_MODE", "allow")
if _initial not in MODES:
    sys.exit(f"stub_amp: unknown STUB_MODE {_initial!r}")
STATE = {"mode": _initial, "pending_since": {}, "workitems": {}, "polls": {},
         "bound_request": os.environ.get("STUB_BOUND_REQUEST") == "1"}
LOCK = threading.Lock()


def log(entry):
    entry["ts"] = time.time()
    entry["mode"] = STATE["mode"]
    with LOCK, open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send_raw(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, code, obj):
        self._send_raw(code, json.dumps(obj).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"null")
        except Exception:
            return raw.decode("utf-8", "replace")

    def _set_mode(self, method, body, q):
        requested = None
        bound = False
        if method == "POST" and isinstance(body, dict):
            requested = body.get("mode")
            bound = body.get("bound_request") is True
        elif "set" in q:
            requested = q["set"]
        if requested is None:
            return self._send(200, {"mode": STATE["mode"]})
        if requested not in MODES:
            return self._send(400, {"error": "unknown mode", "mode": STATE["mode"]})
        STATE["mode"] = requested
        STATE["bound_request"] = bound
        STATE["pending_since"].clear()
        STATE["workitems"].clear()
        STATE["polls"].clear()
        return self._send(200, {"mode": STATE["mode"]})

    def _decision(self, mode, cid):
        wi = STATE["workitems"].get(cid)
        STATE["polls"][cid] = STATE["polls"].get(cid, 0) + 1
        if mode == "poll429":
            return self._send(429, {"error": "call_limit_reached"})
        if not wi:
            # No work item for this caller (never requested, or another caller's): nothing to decide.
            return self._send(200, {"status": "pending"})
        if not STATE["bound_request"] and STATE["polls"][cid] == 1:
            # Id-less request (H3): the first poll is where the caller learns its work item.
            return self._send(200, {"status": "pending", "workitem_id": wi})
        if mode == "hitl_slow":
            since = STATE["pending_since"].get(cid, time.time())
            if time.time() - since < DECISION_DELAY_S:
                return self._send(200, {"status": "pending", "workitem_id": wi})
            return self._send(200, {"status": "complete", "resolution": "approve", "information": "", "workitem_id": wi})
        if mode == "hitl_approve":
            return self._send(200, {"status": "complete", "resolution": "approve", "information": "", "workitem_id": wi})
        if mode == "hitl_reject":
            return self._send(200, {"status": "complete", "resolution": "reject",
                                    "information": "stub reviewer says no", "workitem_id": wi})
        if mode == "hitl_modify":
            return self._send(200, {"status": "complete", "resolution": "modify", "information": "use a safer command",
                                    "modified_action": {"params": {"command": "echo safe"}}, "workitem_id": wi})
        if mode == "hitl_cancelled":
            return self._send(200, {"status": "complete", "resolution": "reject", "method": "cancelled",
                                    "workitem_status": "Cancelled", "workitem_id": wi,
                                    "information": "workitem cancelled"})
        # Non-HITL mode polled anyway: stay pending, never approve.
        return self._send(200, {"status": "pending", "workitem_id": wi})

    def _handle(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = self._body() if method == "POST" else None
        if u.path == "/__mode":
            return self._set_mode(method, body, q)
        if u.path == "/__health":
            return self._send(200, {"ok": True, "mode": STATE["mode"]})

        mode = STATE["mode"]
        log({"method": method, "path": u.path, "query": q, "body": body,
             "api_key": self.headers.get("X-API-Key")})
        if mode == "down" and u.path.startswith("/api/"):
            # drop connection without a response -> fetch() rejects
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except Exception:
                pass
            return

        if u.path == "/api/agent/init" and method == "POST":
            return self._send(200, {"instance_id": "inst-" + uuid.uuid4().hex[:8], "status": "running"})
        if u.path in ("/api/log", "/api/agent/setState") and method == "POST":
            return self._send(200, {"ok": True})
        if u.path == "/api/hitl/request" and method == "POST":
            if mode == "allow":
                return self._send(200, {"status": "no-hitl", "reason": "stub: policy allows"})
            if mode == "no_policy":
                return self._send(200, {"status": "no_policy"})
            if mode == "policy_error":
                return self._send(500, {"error": "stub: evaluator crashed"})
            if mode == "policy_error_200":
                return self._send(200, {"status": "policy_error", "reason": "policy_missing_hitl_routing",
                                        "message": "Missing field(s): who"})
            if mode == "garbage":
                return self._send(200, {"status": "banana", "weird": True})
            if mode == "null_body":
                return self._send_raw(200, b"null")
            if mode in HITL_MODES:
                cid = body.get("caller_id") if isinstance(body, dict) else None
                wi = "wi-" + uuid.uuid4().hex[:6]
                STATE["pending_since"][cid] = time.time()
                STATE["workitems"][cid] = wi
                STATE["polls"][cid] = 0
                if STATE["bound_request"]:
                    return self._send(200, {"status": "pending", "workitem_id": wi})
                return self._send(200, {"status": "pending"})
            return self._send(500, {"error": "stub: unhandled mode", "mode": mode})
        if u.path == "/api/hitl/get-decision" and method == "GET":
            return self._decision(mode, q.get("caller_id"))
        return self._send(404, {"error": "stub: unknown endpoint", "path": u.path})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"stub AMP on 127.0.0.1:{PORT} mode={STATE['mode']} log={LOG}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
