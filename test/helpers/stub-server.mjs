// In-process stub of the AMP SaaS backend for tier-1 tests (node:http only).
//
// Routes (same as test/fixtures/stub_amp.py):
//   POST /api/agent/init        -> {instance_id:'inst-<n>', status:'running'}
//   POST /api/log               -> {ok:true}
//   POST /api/agent/setState    -> {ok:true}
//   POST /api/hitl/request      -> depends on mode
//   GET  /api/hitl/get-decision -> depends on mode
//   POST /__mode {mode}         -> switch mode (400 on unknown mode; never a default allow)
//
// HITL modes model production (H3): /api/hitl/request answers {status:'pending'}
// with NO workitem_id; the first get-decision poll reports the new work item
// pending, later polls answer the mode's terminal body for it. Opt in to the
// legacy bound shape (request carries workitem_id) with
// setMode(name, {boundRequest: true}).
//
// Every /api/* request is recorded as {method, path, query, body, headers:{'x-api-key'}}.
// `stub.script('POST /api/hitl/request', [{status, body}|{status, raw}|{destroy:true}, ...])`
// overrides a route with a response queue; the last entry repeats. Any entry may
// add `delayMs` to hold its answer back (slow or hung backend).
// `stub.respond('GET /api/hitl/get-decision', (req) => response | undefined)` answers a
// route from the request ({method, path, query, body}) — e.g. scoped by caller_id like
// the real backend. It wins over script() and the mode; undefined falls through.
import http from 'node:http';

const json = (status, body) => ({ status, body });

function pendingRequest(state) {
  const workitemId = `wi-${++state.wiCounter}`;
  state.boundWorkitem = workitemId;
  state.polls = 0;
  if (state.modeOpts.boundRequest) return json(200, { status: 'pending', workitem_id: workitemId });
  return json(200, { status: 'pending' });
}

function complete(state, resolution, extra = {}) {
  return json(200, {
    status: 'complete',
    resolution,
    information: '',
    workitem_id: state.boundWorkitem,
    ...extra,
  });
}

// Each mode: { request(state, body) -> response, decision?(state) -> response }
const MODES = {
  allow: { request: () => json(200, { status: 'no-hitl', reason: 'stub: policy allows' }) },
  // Production shapes from proxy_hitl (backend fix/hitl-phase0 @ 1789116).
  no_policy: { request: () => json(200, { status: 'no_policy', policy_configured: false }) },
  policy_error: { request: () => json(500, { error: 'stub: evaluator crashed' }) },
  policy_error_200: {
    request: () => json(200, {
      policy: 'eval',
      eval_decision: 'hitl',
      status: 'policy_error',
      reason: 'policy_missing_hitl_routing',
      message: 'Missing field(s): who',
    }),
  },
  garbage: { request: () => json(200, { status: 'banana', weird: true }) },
  null_body: { request: () => ({ status: 200, raw: 'null' }) },
  hitl_approve: { request: pendingRequest, decision: (s) => complete(s, 'approve') },
  hitl_reject: {
    request: pendingRequest,
    decision: (s) => complete(s, 'reject', { information: 'stub reviewer says no' }),
  },
  hitl_modify: {
    request: pendingRequest,
    decision: (s) => complete(s, 'modify', {
      information: 'use a safer command',
      modified_action: { params: { command: 'echo safe' } },
    }),
  },
  hitl_cancelled: {
    request: pendingRequest,
    decision: (s) => json(200, {
      status: 'complete',
      resolution: 'reject',
      method: 'cancelled',
      workitem_status: 'Cancelled',
      workitem_id: s.boundWorkitem,
      information: 'workitem cancelled',
    }),
  },
  hitl_slow: {
    request: pendingRequest,
    decision: (s) => (s.polls <= s.modeOpts.pendingPolls
      ? json(200, { status: 'pending', workitem_id: s.boundWorkitem })
      : complete(s, 'approve')),
  },
  poll429: {
    request: pendingRequest,
    decision: () => json(429, { error: 'call_limit_reached' }),
  },
  down: { request: () => ({ destroy: true }), decision: () => ({ destroy: true }) },
};

export const MODE_NAMES = Object.freeze(Object.keys(MODES));

function freshState() {
  return {
    mode: 'allow',
    modeOpts: { pendingPolls: 2, boundRequest: false },
    records: [],
    scripts: new Map(),
    responders: new Map(),
    instCounter: 0,
    wiCounter: 0,
    boundWorkitem: undefined,
    polls: 0,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

function send(res, req, response) {
  if (response.delayMs > 0) {
    // Hold the answer back (slow/hung backend); skipped if the client gave up.
    setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) send(res, req, { ...response, delayMs: 0 });
    }, response.delayMs);
    return;
  }
  if (response.destroy) {
    req.socket.destroy();
    return;
  }
  const payload = response.raw !== undefined ? response.raw : JSON.stringify(response.body ?? null);
  res.writeHead(response.status ?? 200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function routeResponse(state, method, path, body, query) {
  const key = `${method} ${path}`;
  const responder = state.responders.get(key);
  const answer = responder ? responder({ method, path, query, body }) : undefined;
  if (answer !== undefined) {
    if (key === 'GET /api/hitl/get-decision') state.polls += 1;
    return answer;
  }
  const queue = state.scripts.get(key);
  if (queue && queue.length) {
    // Scripted responses still advance the poll counter for hitl_slow bookkeeping.
    if (key === 'GET /api/hitl/get-decision') state.polls += 1;
    return queue.length > 1 ? queue.shift() : queue[0];
  }
  const mode = MODES[state.mode];
  if (mode === MODES.down) return { destroy: true };
  if (key === 'POST /api/agent/init') {
    return json(200, { instance_id: `inst-${++state.instCounter}`, status: 'running' });
  }
  if (key === 'POST /api/log' || key === 'POST /api/agent/setState') return json(200, { ok: true });
  if (key === 'POST /api/hitl/request') return mode.request(state, body);
  if (key === 'GET /api/hitl/get-decision') {
    state.polls += 1;
    if (!mode.decision) {
      // Non-HITL mode polled anyway: answer pending so a buggy caller never gets an approve.
      return json(200, { status: 'pending', workitem_id: state.boundWorkitem });
    }
    // Id-less request (H3): the first poll is where the caller learns its work item.
    // poll429 rejects every poll, the first one included.
    if (!state.modeOpts.boundRequest && state.polls === 1 && state.boundWorkitem && mode !== MODES.poll429) {
      return json(200, { status: 'pending', workitem_id: state.boundWorkitem });
    }
    return mode.decision(state);
  }
  return json(404, { error: 'stub: unknown endpoint', path });
}

export async function startStub() {
  let state = freshState();

  const setMode = (name, opts = {}) => {
    if (!Object.hasOwn(MODES, name)) throw new Error(`unknown mode: ${name}`);
    state.mode = name;
    // boundRequest is per setMode call; pendingPolls stays until changed.
    state.modeOpts = { ...state.modeOpts, boundRequest: false, ...opts };
    state.polls = 0;
    state.boundWorkitem = undefined;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (u.pathname === '/__mode' && req.method === 'POST') {
      try {
        setMode(body?.mode, body?.opts || {});
        return send(res, req, json(200, { mode: state.mode }));
      } catch {
        return send(res, req, json(400, { error: 'unknown mode' }));
      }
    }
    const query = Object.fromEntries(u.searchParams);
    state.records.push({
      method: req.method,
      path: u.pathname,
      query,
      body,
      headers: { 'x-api-key': req.headers['x-api-key'] },
    });
    send(res, req, routeResponse(state, req.method, u.pathname, body, query));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    setMode,
    get mode() { return state.mode; },
    script(routeKey, responses) {
      if (!Array.isArray(responses) || responses.length === 0) {
        throw new Error('script() needs a non-empty array of responses');
      }
      state.scripts.set(routeKey, [...responses]);
    },
    respond(routeKey, fn) {
      if (typeof fn !== 'function') throw new Error('respond() needs a function');
      state.responders.set(routeKey, fn);
    },
    requests(filterFn = () => true) {
      return state.records.filter(filterFn);
    },
    count(method, path) {
      return state.records.filter((r) => r.method === method && r.path === path).length;
    },
    reset() {
      state = freshState();
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
