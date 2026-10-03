import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeTool } from './toolNormalization.js';

console.log('[AMP Governance] Plugin module loaded — Phase 4.');

// Mirrors OpenClaw's own state-dir resolution (resolveConfigDir in its
// bundled source): OPENCLAW_STATE_DIR (or legacy CLAWDBOT_STATE_DIR) wins if
// set — which is how --profile/--dev relocate state to ~/.openclaw-<name> —
// otherwise fall back to ~/.openclaw. Hardcoding ~/.openclaw here would
// silently read/write the wrong file for any non-default profile.
function resolveOpenClawStateDir() {
  const override = (process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || '').trim();
  if (override) return override;
  return `${process.env.HOME}/.openclaw`;
}

const OPENCLAW_STATE_DIR = resolveOpenClawStateDir();
// Plugin-owned session record. The hook keeps its own hook-session.json next to
// it; records are tagged with their writer so neither side adopts or finalizes
// the other's instance (A13, #22/#23). The legacy shared /tmp file is never read.
const SESSION_WRITER = 'plugin';
const SESSION_FILE = path.join(OPENCLAW_STATE_DIR, 'hooks/amp/plugin-session.json');
const CONFIG_FILE = `${OPENCLAW_STATE_DIR}/hooks/amp/amp_config.json`;

// Tools that are internal/noisy — skip logging and policy checks
const SKIP_TOOLS = new Set(['session_status', 'heartbeat']);

let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  console.log('[AMP Governance] Config loaded. Backend:', config.AMP_BACKEND_URL);
} catch (err) {
  console.error('[AMP Governance] Failed to load config:', err.message);
}

function normalizeBackendUrl(raw) {
  let base = String(raw || '').trim();
  if (!base) return '';
  // If scheme is missing, default to HTTPS for server deployments.
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, '');
}

function buildAmpUrl(path) {
  const base = normalizeBackendUrl(config?.AMP_BACKEND_URL);
  if (!base) throw new Error('AMP_BACKEND_URL missing');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function getAmpApiKey() {
  let key = String(config?.AMP_API_KEY || '').trim();
  // tolerate accidental wrapping or "Bearer ..." pastes
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, '').trim();
  return key;
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// HITL timeout — configurable via HITL_TIMEOUT_MINUTES in amp_config.json (default: 10)
const HITL_TIMEOUT_MS = positiveNumber(config?.HITL_TIMEOUT_MINUTES, 10) * 60 * 1000;
// Poll interval — configurable via HITL_POLL_INTERVAL_MS in amp_config.json (default: 3000)
const HITL_POLL_INTERVAL_MS = positiveNumber(config?.HITL_POLL_INTERVAL_MS, 3000);
// Requested before_tool_call budget: the HITL window plus slack for the
// request/log round-trips. An operator override in openclaw.json wins.
const HOOK_TIMEOUT_MS = HITL_TIMEOUT_MS + 30_000;

const PLUGIN_ID = 'amp-governance';
// Per-call budget (lock wait + request + HITL poll). Starts as the HITL window;
// register() cuts it below a shorter operator hook timeout so the plugin
// returns its own block (and frees the instance slot) before the host does.
let _callBudgetMs = HITL_TIMEOUT_MS;
let _hookBudgetLimitMs = null; // operator before_tool_call timeout, when it binds
// Deadline of the before_tool_call in progress, so log/init writes made on its
// behalf never outlive its budget (they are best-effort; a cut write is dropped).
const _callScope = new AsyncLocalStorage();
const LOG_MIN_BUDGET_MS = 250;     // a block/audit log still gets this much after the deadline
const MIN_REQUEST_BUDGET_MS = 500; // below this, /api/hitl/request is not started

/** Block message when the call's own budget ran out. */
function budgetExhaustedMessage(tool) {
  return _hookBudgetLimitMs !== null
    ? `Tool call "${tool}" blocked — the AMP review did not complete within the ${Math.round(_hookBudgetLimitMs / 1000)}s OpenClaw hook budget (plugins.entries.${PLUGIN_ID}.hooks.timeouts.before_tool_call). Raise it (max 600000) for longer reviews.`
    : `Tool call "${tool}" timed out waiting for human approval — blocked.`;
}

/**
 * Operator override for before_tool_call from openclaw.json, with the host's
 * precedence: plugins.entries.<id>.hooks.timeouts.before_tool_call, then
 * hooks.timeoutMs. Missing / invalid values -> null (ignored).
 */
function operatorHookTimeoutMs(cfg) {
  const valid = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
  const entries = cfg?.plugins?.entries;
  const hooks = entries && typeof entries === 'object' ? entries[PLUGIN_ID]?.hooks : null;
  if (!hooks || typeof hooks !== 'object') return null;
  return valid(hooks.timeouts?.before_tool_call) ?? valid(hooks.timeoutMs);
}
// A6/K3: send action_id on request + poll only when explicitly enabled (strict true).
const ACTION_ID_CORRELATION = config?.ACTION_ID_CORRELATION === true;
// Block if no work item appears for this action_id within this window (default 60 s).
const ACTION_ID_WATCHDOG_MS = positiveNumber(config?.ACTION_ID_WATCHDOG_SECONDS, 60) * 1000;
// Cap on any single AMP HTTP request (default 15 s); also bounded by the call's deadline.
const AMP_REQUEST_TIMEOUT_MS = positiveNumber(config?.AMP_REQUEST_TIMEOUT_MS, 15_000);

/**
 * Signal for one AMP request: aborts when the caller's signal does, or after
 * AMP_REQUEST_TIMEOUT_MS, or at the call's deadline — whichever comes first.
 */
function requestSignal(signal, deadline) {
  const budget = deadline == null ? AMP_REQUEST_TIMEOUT_MS : Math.min(AMP_REQUEST_TIMEOUT_MS, deadline - Date.now());
  const ms = Math.max(1, Math.floor(budget));
  // Only a real AbortSignal can be composed; callers re-check signal.aborted anyway.
  const callerSignal = signal instanceof AbortSignal ? [signal] : [];
  return AbortSignal.any([...callerSignal, AbortSignal.timeout(ms)]);
}

/** True when err is our own request timeout (not a caller abort). */
const isRequestTimeout = (err, signal) => err?.name === 'TimeoutError' && !signal?.aborted;

// Module-level instance cache so we only init once per process lifetime
let _instanceId = null;

// Last known sender — populated by message_received, used for HITL notifications
let _lastSender = null;  // { from: string, channelId: string }

// Set by register() so notifyUser can use the runtime API directly
let _runtime = null;

// AMP reachability state — flips to false when a real AMP call fails,
// back to true the next time a real AMP call succeeds.
let _ampReachable = true;
let _ampDownNotified = false; // prevent notification spam while AMP is down

// ── HOOK AUTO-DEPLOY ─────────────────────────────────────────────────────────

/**
 * On first install (or if the hook dir is missing), copy the bundled hook
 * files from the plugin's install directory into the resolved OpenClaw state
 * dir's hooks/amp/ (see resolveOpenClawStateDir — respects OPENCLAW_STATE_DIR
 * / --profile / --dev, not just the ~/.openclaw default).
 * Never overwrites an existing amp_config.json so user credentials are safe.
 */
function deployHookFilesIfNeeded(pluginRootDir) {
  const hookSrc  = `${pluginRootDir}/hook`;
  const hookDest = `${OPENCLAW_STATE_DIR}/hooks/amp`;

  try {
    if (!fs.existsSync(hookSrc)) {
      console.warn('[AMP Governance] Hook source dir not found — skipping auto-deploy.');
      return;
    }
    fs.mkdirSync(hookDest, { recursive: true });

    for (const file of ['handler.ts', 'HOOK.md']) {
      const dest = `${hookDest}/${file}`;
      fs.copyFileSync(`${hookSrc}/${file}`, dest);
      console.log(`[AMP Governance] Deployed hook file: ${dest}`);
    }

    // Only write amp_config.json if it doesn't already exist
    const configDest = `${hookDest}/amp_config.json`;
    if (!fs.existsSync(configDest)) {
      fs.copyFileSync(`${hookSrc}/amp_config.json`, configDest);
      console.log(`[AMP Governance] Created config template: ${configDest}`);
      console.log('[AMP Governance] ACTION REQUIRED: edit amp_config.json with your AMP credentials.');
    }
  } catch (err) {
    console.error('[AMP Governance] Hook auto-deploy failed:', err.message);
  }
}

// ── `openclaw amp connect` ───────────────────────────────────────────────────
// Collapses the config-write + hook-enable + gateway-restart steps into one
// narrated command. Doesn't (and structurally can't) cover plugin install —
// a plugin's own CLI command only exists once the plugin is already loaded,
// so `openclaw plugins install @inquiryon/amp-governance` stays a separate
// first step. Shells out to the real `hooks enable` / `gateway restart`
// commands (stdio inherited) rather than reimplementing their internals, so
// behavior stays identical to running them by hand.
function runAmpConnect(opts) {
  console.log(`→ Writing config to ${CONFIG_FILE}`);
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const newConfig = {
      AMP_BACKEND_URL: opts.backendUrl,
      AMP_API_KEY: opts.apiKey,
      AGENT_NAME: opts.agentName,
      AMP_USERNAME: opts.username,
      AMP_ORG_ID: opts.orgId,
      HITL_TIMEOUT_MINUTES: Number(opts.hitlTimeout) || 10,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2) + '\n');
    console.log('✓ Config written.');
  } catch (err) {
    console.error(`✗ Failed to write config: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('→ Enabling AMP hook (openclaw hooks enable amp)...');
  try {
    execFileSync('openclaw', ['hooks', 'enable', 'amp'], { stdio: 'inherit' });
  } catch (err) {
    console.error(`✗ Failed to enable hook: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('→ Restarting OpenClaw gateway (openclaw gateway restart)...');
  try {
    execFileSync('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
  } catch (err) {
    console.error(`✗ Failed to restart gateway: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ Connected — agent "${opts.agentName}" is now governed by AMP.`);
}

function readSession() {
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    return session?.writer === SESSION_WRITER ? session : null;
  } catch {
    return null;
  }
}

function writeSession(instanceId) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ instanceId, writer: SESSION_WRITER }), 'utf-8');
  } catch (err) {
    console.error('[AMP Governance] writeSession failed:', err.message);
  }
}

function clearSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {}
}

// ── INSTANCE MANAGEMENT ──────────────────────────────────────────────────────

/**
 * Ensure an AMP instance exists for this session.
 * Priority: in-memory cache → session file → create new via /api/agent/init.
 */
async function ensureInstance() {
  if (!config) return null;

  if (_instanceId) return _instanceId;

  const session = readSession();
  if (session?.instanceId) {
    _instanceId = session.instanceId;
    return _instanceId;
  }

  try {
    const initUrl = buildAmpUrl('/api/agent/init');
    const apiKey = getAmpApiKey();
    const res = await fetch(initUrl, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_name: config.AGENT_NAME,
        org_id:     config.AMP_ORG_ID,
        username:   config.AMP_USERNAME,
        prompt:     'OpenClaw governance session',
        auto_start: true,
        config:     { agent_mode: 'polling' },
        metadata:   { source: 'openclaw-amp-plugin', owner: config.AMP_USERNAME },
      }),
      signal: requestSignal(undefined, _callScope.getStore()?.deadline),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error(`[AMP Governance] /api/agent/init returned ${res.status}${bodyText ? ` | body=${bodyText}` : ''}`);
      return null;
    }
    const data = await res.json();
    const id = data.instance_id;
    if (id) {
      _instanceId = id;
      writeSession(id);
      console.log(`[AMP Governance] AMP instance created: ${id}`);
      await notifyAmpRecovered();
    }
    return _instanceId || null;
  } catch (err) {
    const em = err && err.message ? err.message : String(err);
    const ec = err && err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : '';
    let target = '';
    try { target = buildAmpUrl('/api/agent/init'); } catch (_) {}
    console.error(`[AMP Governance] ensureInstance failed: ${em}${ec ? ` | cause=${ec}` : ''}${target ? ` | url=${target}` : ''}`);
    _ampReachable = false;
    return null;
  }
}

// ── AMP LOGGING ──────────────────────────────────────────────────────────────

/** Timeout for a log write: the call's remaining budget (floor LOG_MIN_BUDGET_MS), capped at AMP_REQUEST_TIMEOUT_MS. */
function logSignal() {
  const deadline = _callScope.getStore()?.deadline;
  const ms = deadline == null ? AMP_REQUEST_TIMEOUT_MS
    : Math.min(AMP_REQUEST_TIMEOUT_MS, Math.max(LOG_MIN_BUDGET_MS, deadline - Date.now()));
  return AbortSignal.timeout(Math.floor(ms));
}

async function ampLog(instanceId, message, level = 'INFO') {
  if (!config) return;
  try {
    const apiKey = getAmpApiKey();
    await fetch(buildAmpUrl('/api/log'), {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: instanceId,
        service:     config.AGENT_NAME,
        level,
        message,
        timestamp:   new Date().toISOString(),
        org_id:      config.AMP_ORG_ID,
        username:    config.AMP_USERNAME,
      }),
      signal: logSignal(),
    });
  } catch (err) {
    console.error('[AMP Governance] ampLog failed:', err?.message || String(err));
  }
}

// ── PROACTIVE NOTIFICATIONS ──────────────────────────────────────────────────

/**
 * Send a proactive message to the sender's channel via the runtime outbound
 * adapter. Fire-and-forget — errors are logged but never thrown.
 */
async function notifyUser(sender, message) {
  if (typeof sender?.from !== 'string' || !sender.from || !_runtime) return;
  try {
    const prefixed = `[AMP]\n${message}`;
    const channelId = sender.channelId || (sender.from.startsWith('slack:') ? 'slack' : 'whatsapp');
    // 'slack:channel:C1' -> 'channel:C1': channel senders expect the bare target.
    const to = sender.from.startsWith(`${channelId}:`) ? sender.from.slice(channelId.length + 1) : sender.from;
    console.log(`[AMP Governance] Sending notification to ${sender.from}: ${message}`);
    const outbound = _runtime.channel?.outbound;
    if (typeof outbound?.loadAdapter === 'function') {
      // OpenClaw >= 2026.9 (api.runtime.channel.outbound). sendText argument shape
      // unverified against a live gateway (R7) — NEEDS-LIVE.
      const adapter = await outbound.loadAdapter(channelId);
      if (typeof adapter?.sendText !== 'function') {
        throw new Error(`no outbound sendText for channel "${channelId}"`);
      }
      await adapter.sendText({ cfg: _runtime.config?.current?.() ?? undefined, to, text: prefixed });
      return;
    }
    // Legacy runtimes (OpenClaw 2026.7): per-channel send helpers.
    if (channelId === 'slack') await _runtime.channel.slack.sendMessageSlack(to, prefixed);
    else await _runtime.channel.whatsapp.sendMessageWhatsApp(sender.from, prefixed, { verbose: false });
  } catch (err) {
    console.warn('[AMP Governance] notifyUser failed:', err?.message || String(err));
  }
}

/**
 * Called whenever a real AMP call fails (init or hitl/request).
 * Sends a clear channel notification on the first occurrence, then stays quiet
 * until AMP recovers (to avoid flooding the user with repeated messages).
 */
async function notifyAmpDown(tool, errDetail) {
  const ampUrl = (() => { try { return buildAmpUrl('/'); } catch (_) { return config?.AMP_BACKEND_URL || 'unknown'; } })();

  if (!_ampDownNotified) {
    _ampDownNotified = true;
    const msg =
      `🚨 *AMP Governance Service Unreachable*\n\n` +
      `OpenClaw cannot connect to the AMP Governance service at:\n${ampUrl}\n\n` +
      `*All agent activities are now blocked* until AMP is back online. ` +
      `This is a safety measure — no tools (file reads, shell commands, web searches, etc.) ` +
      `will be executed while governance is unavailable.\n\n` +
      `*What to do:*\n` +
      `• Verify the AMP backend is running (check pm2 or your server)\n` +
      `• Confirm the AMP_BACKEND_URL in your amp_config.json is correct\n` +
      `• Once AMP is restored, send your request again and OpenClaw will resume normally\n\n` +
      `_Technical detail: ${errDetail}_`;
    await notifyUser(_lastSender, msg);
    console.error(`[AMP Governance] AMP unreachable — all tool calls blocked. URL: ${ampUrl} | Error: ${errDetail}`);
  }
}

/**
 * Called when a real AMP call succeeds after a period of being down.
 * Clears the down state so the next failure notifies again.
 */
async function notifyAmpRecovered() {
  if (!_ampReachable) {
    _ampReachable    = true;
    _ampDownNotified = false;
    await notifyUser(_lastSender,
      `✅ *AMP Governance Service Restored*\n\nThe AMP Governance service is back online. OpenClaw is resuming normal operation — your next request will be processed.`
    );
    console.log('[AMP Governance] AMP service recovered — resuming normal operation.');
  }
}

// ── HITL POLICY ENGINE ───────────────────────────────────────────────────────

// /api/hitl/request answered 2xx with a body that is not JSON.
class InvalidAmpResponseError extends Error {}

/**
 * Call /api/hitl/request with the tool call details.
 * The AMP backend eval engine decides allow vs HITL.
 */
async function requestHitlEval(instanceId, tool, params, actionId, { signal, deadline } = {}) {
  const apiKey = getAmpApiKey();
  const { tool: normTool, action: normAction } = normalizeTool(tool, params);
  const res = await fetch(buildAmpUrl('/api/hitl/request'), {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      caller_id:  instanceId,
      instance_id: instanceId,
      org_id:     config.AMP_ORG_ID,
      agent_name: config.AGENT_NAME,
      tool:       normTool,
      action:     normAction,
      context:    params || {},
      ...(actionId ? { action_id: actionId } : {}),
      hitl: {
        enable: true,
        when:   'policy',
        // who/what/where resolved by the backend from the policy's hitl_spec
      },
    }),
    signal: requestSignal(signal, deadline),
  });
  if (!res.ok) throw new Error(`/api/hitl/request returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (err) {
    throw new InvalidAmpResponseError(`/api/hitl/request returned invalid JSON: ${err?.message || err}`);
  }
}


/** Resolves after ms; rejects early (and clears the timer) when signal aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Poll statuses that will not change by retrying (auth, unknown route, call limit).
const POLL_FATAL_STATUS = new Set([401, 403, 404, 429]);

/** A6: the correlated poll cannot be trusted (no echo, or no work item in time). */
class ActionIdCorrelationError extends Error {}

/** The call's HITL window ended without a decision for its work item. */
class HitlTimeoutError extends Error {}

class PollFatalError extends Error {
  constructor(status, body) {
    super(`get-decision returned HTTP ${status}`);
    this.status = status;
    this.body = String(body || '').slice(0, 200);
  }
}

/**
 * True when a get-decision body says the work item was cancelled (K1/B2):
 * forward-compat `status:'cancelled'`, backend `method:'cancelled'` on a
 * complete body, or any body whose workitem_status reads cancelled/canceled.
 * A cancellation is the absence of a decision — never report it as a reject.
 */
function isCancelledDecision(data) {
  const wiStatus = String(data.workitem_status || '').toLowerCase().trim();
  return data.status === 'cancelled'
    || (data.status === 'complete' && data.method === 'cancelled')
    || wiStatus === 'cancelled' || wiStatus === 'canceled';
}

// ── WORK-ITEM BINDING (K2 / H3 / L16) ───────────────────────────────────────
// get-decision is instance-scoped and returns the newest resolved work item, so
// a call can receive another call's decision. Each instance keeps the ids that
// any call has already bound, consumed or abandoned; a call accepts only the
// decision for the work item it is bound to.
const SEEN_WORKITEMS_CAP = 500;
const _seenWorkitems = new Map(); // instanceId -> Set<workitem_id>

function seenWorkitemsFor(instanceId) {
  if (!_seenWorkitems.has(instanceId)) _seenWorkitems.set(instanceId, new Set());
  return _seenWorkitems.get(instanceId);
}

/** Records a work item id (most recent last); drops the oldest past the cap. */
function rememberWorkitem(seen, workitemId) {
  seen.delete(workitemId);
  seen.add(workitemId);
  while (seen.size > SEEN_WORKITEMS_CAP) seen.delete(seen.values().next().value);
}

const nonEmptyId = (v) => (typeof v === 'string' && v !== '' ? v : null);

// get-decision `method` values that come without a work item (legacy path).
const UNVERIFIABLE_METHODS = new Set(['auto', 'fallback']);

/**
 * Pure verdict for one get-decision body. Returns { action, bind?, remember? }
 * where action is 'accept' (terminal, ours), 'ignore' (terminal, not provably
 * ours) or 'wait' (not terminal); bind = id this call binds to now; remember =
 * id to add to the instance's seen set without binding.
 * A call only accepts a decision for a work item it has already seen pending
 * (request response or pending poll). An unbound call never accepts a terminal
 * body: after a restart the seen set is empty and get-decision returns the
 * restored instance's last resolved work item (H3). Fail-closed: a review that
 * resolves before the first poll times out and blocks.
 */
function classifyDecision(data, bound, seen) {
  const id = nonEmptyId(data.workitem_id);
  const terminal = data.status === 'complete' || isCancelledDecision(data);
  if (!terminal) return !bound && id && !seen.has(id) ? { action: 'wait', bind: id } : { action: 'wait' };
  if (bound) return { action: id === bound ? 'accept' : 'ignore' };
  if (!id && UNVERIFIABLE_METHODS.has(data.method)) return { action: 'unverifiable' };
  return id ? { action: 'ignore', remember: id } : { action: 'ignore' };
}

/**
 * The backend's legacy get-decision path answers an unbound call with an
 * id-less auto/fallback decision (no work item; read from the instance's
 * progress log, so possibly stale). It can never be tied to this call, and no
 * work item will follow — block at once rather than wait out the HITL window.
 */
class UnverifiableDecisionError extends Error {
  constructor(data) {
    const safe = typeof data.fallback_action === 'string' && data.fallback_action
      ? ` Safe action: ${data.fallback_action}` : '';
    super(`AMP returned a decision with no work item (method=${data.method}) that cannot be tied to this call — blocked.${safe}`);
  }
}

/** One get-decision round-trip: parsed object body, or null to retry. */
async function fetchDecisionBody(apiKey, callerId, actionId, signal, deadline) {
  const actionQuery = actionId ? `&action_id=${encodeURIComponent(actionId)}` : '';
  const res = await fetch(
    `${buildAmpUrl('/api/hitl/get-decision')}?caller_id=${encodeURIComponent(callerId)}${actionQuery}`,
    { headers: { 'X-API-Key': apiKey }, signal: requestSignal(signal, deadline) }
  );
  if (POLL_FATAL_STATUS.has(res.status)) {
    throw new PollFatalError(res.status, await res.text().catch(() => ''));
  }
  if (!res.ok) {
    console.warn(`[AMP Governance] get-decision returned ${res.status}, retrying...`);
    return null;
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn('[AMP Governance] get-decision returned a non-object body, retrying...');
    return null;
  }
  return data;
}

/**
 * A6: with correlation on, a terminal body must echo our action_id. A missing
 * or different echo means the backend ignored the scope — block, never fall
 * back to an unscoped decision.
 */
function checkActionIdEcho(data, actionId) {
  const terminal = data.status === 'complete' || isCancelledDecision(data);
  if (actionId && terminal && data.action_id !== actionId) {
    throw new ActionIdCorrelationError('AMP did not echo action_id — decision correlation unsupported; blocked.');
  }
}

/** A6: no work item bound for this action_id within the watchdog window — block. */
function checkActionIdWatchdog(actionId, bound, started) {
  if (actionId && !bound && Date.now() - started >= ACTION_ID_WATCHDOG_MS) {
    throw new ActionIdCorrelationError(
      `AMP has not created a review for this action after ${ACTION_ID_WATCHDOG_MS / 1000}s (action_id correlation may be unsupported by the HITL service); blocked.`
    );
  }
}

/**
 * Poll /api/hitl/get-decision until this call's work item is complete (or
 * cancelled) or the call's deadline passes. Binds to `boundWorkitemId`, else to the
 * first unseen workitem_id in a pending body (see classifyDecision).
 * Throws PollFatalError on HTTP 401/403/404/429; other failures keep polling.
 * Rejects as soon as `signal` aborts (run cancelled). A bound id stays in the
 * instance set on every exit, so an abandoned work item is never accepted later.
 */
async function pollHitlDecision(callerId, { signal, boundWorkitemId, actionId, deadline: callDeadline } = {}) {
  const apiKey = getAmpApiKey();
  const seen = seenWorkitemsFor(callerId);
  let bound = nonEmptyId(boundWorkitemId);
  let warnedOther = false;
  const started = Date.now();
  // C10: the call's budget includes any wait for the instance lock.
  const deadline = callDeadline ?? started + HITL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Never sleep past the call's deadline; skip the poll once it has passed.
    await sleep(Math.min(HITL_POLL_INTERVAL_MS, deadline - Date.now()), signal);
    if (Date.now() >= deadline) break;
    let data;
    try {
      data = await fetchDecisionBody(apiKey, callerId, actionId, signal, deadline);
    } catch (err) {
      if (!isRequestTimeout(err, signal)) throw err;
      console.warn('[AMP Governance] get-decision timed out, retrying...');
      data = null; // transient: keep polling until the deadline
    }
    if (!data) { checkActionIdWatchdog(actionId, bound, started); continue; }
    checkActionIdEcho(data, actionId);
    // Bind synchronously with the check so a concurrent call cannot take the id.
    const verdict = classifyDecision(data, bound, seen);
    if (verdict.bind) {
      rememberWorkitem(seen, verdict.bind);
      bound = verdict.bind;
    }
    if (verdict.remember) rememberWorkitem(seen, verdict.remember);
    if (verdict.action === 'accept') return data;
    if (verdict.action === 'unverifiable') throw new UnverifiableDecisionError(data);
    if (verdict.action === 'ignore' && !warnedOther) {
      warnedOther = true;
      const msg = `HITL: ignoring decision for other workitem ${data.workitem_id || '(none)'} — waiting for ${bound || 'own workitem'}`;
      console.warn(`[AMP Governance] ${msg}`);
      await ampLog(callerId, msg, 'WARN');
    } else if (verdict.action === 'wait') {
      console.log(`[AMP Governance] Waiting for human decision... (${data.status})`);
    }
    checkActionIdWatchdog(actionId, bound, started);
  }
  throw new HitlTimeoutError(`HITL decision timed out after ${HITL_TIMEOUT_MS / 60000} minutes`);
}

// ── PER-INSTANCE REVIEW LOCK (C10) ──────────────────────────────────────────
// get-decision is instance-scoped, so two calls waiting on the same instance
// could bind each other's work item. Only one governance request/review is in
// flight per instance in this process ("one approval at a time").
const _instanceLocks = new Map(); // instanceId -> tail of the promise chain

/** Resolves true once `prev` settles in time; false at `deadline` or on abort. */
function waitForTurn(prev, deadline, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    let timer;
    const finish = (ok) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    prev.then(() => finish(Date.now() < deadline && !signal?.aborted));
  });
}

/** Queues for the instance lock; returns a release function, or null (blocked). */
async function acquireInstanceLock(instanceId, deadline, signal) {
  const prev = _instanceLocks.get(instanceId) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  _instanceLocks.set(instanceId, tail);
  tail.then(() => {
    if (_instanceLocks.get(instanceId) === tail) _instanceLocks.delete(instanceId);
  });
  if (await waitForTurn(prev, deadline, signal)) return release;
  release(); // give up our slot; later waiters still wait for `prev`
  return null;
}

/**
 * Full governance check for a single tool call.
 * Returns {} to allow, or { block: true, blockReason } to block. Never throws.
 * Fails closed on unreachable AMP, non-2xx, no_policy, policy_error,
 * unknown status, poll timeout, and a lock wait past the call's deadline.
 */
async function checkToolPolicy(instanceId, tool, params, { signal, actionId, deadline } = {}) {
  const callDeadline = deadline ?? Date.now() + HITL_TIMEOUT_MS;
  const paramSummary = formatInput(tool, params);
  await ampLog(instanceId, `Policy check: ${tool} | ${paramSummary}`);

  const contended = _instanceLocks.has(instanceId);
  const release = await acquireInstanceLock(instanceId, callDeadline, signal);
  if (!release) {
    const why = contended ? 'another AMP review is in progress for this agent instance' : 'the call could not start its AMP review in time';
    const msg = !contended && !signal?.aborted && _hookBudgetLimitMs !== null
      ? budgetExhaustedMessage(tool)
      : `Tool call "${tool}" blocked — ${why}${signal?.aborted ? ' (run cancelled while waiting)' : ''}.`;
    console.warn(`[AMP Governance] ${msg}`);
    await ampLog(instanceId, msg, 'WARN');
    return { block: true, blockReason: msg };
  }
  try {
    return await requestAndAwaitDecision(instanceId, tool, params, { signal, actionId, deadline: callDeadline });
  } finally {
    release();
  }
}

/** Request + HITL wait for one call; runs while holding the instance lock. */
async function requestAndAwaitDecision(instanceId, tool, params, { signal, actionId, deadline }) {
  // Too little budget left to get an answer: block as a budget miss, not as an AMP outage.
  if (deadline != null && deadline - Date.now() < MIN_REQUEST_BUDGET_MS) {
    const msg = budgetExhaustedMessage(tool);
    console.error(`[AMP Governance] ${msg}`);
    await ampLog(instanceId, msg, 'ERROR');
    return { block: true, blockReason: msg };
  }
  let hitlResponse;
  try {
    hitlResponse = await requestHitlEval(instanceId, tool, params, actionId, { signal, deadline });
    // Successful contact with AMP — clear any prior down state (notification is fire-and-forget)
    notifyAmpRecovered().catch(() => {});
  } catch (err) {
    const em = err && err.message ? err.message : String(err);
    console.error(`[AMP Governance] HITL request failed — blocking tool "${tool}": ${em}`);
    await ampLog(instanceId, `AMP governance check failed — tool "${tool}" blocked: ${em}`, 'ERROR');
    if (err instanceof InvalidAmpResponseError) {
      return { block: true, blockReason: `AMP returned an invalid response to the policy check. Tool "${tool}" was blocked as a safety measure.` };
    }
    if (signal?.aborted) {
      return { block: true, blockReason: `Tool call "${tool}" blocked — run cancelled before AMP answered the policy check.` };
    }
    // Cut by this call's own deadline (not the per-request cap): a budget miss, not an outage.
    if (isRequestTimeout(err, signal) && deadline != null && deadline - Date.now() < 50) {
      const msg = budgetExhaustedMessage(tool);
      console.error(`[AMP Governance] ${msg}`);
      return { block: true, blockReason: msg };
    }
    _ampReachable = false;
    notifyAmpDown(tool, em).catch(() => {}); // fire-and-forget: never holds the call or the instance slot
    if (isRequestTimeout(err, signal)) {
      return { block: true, blockReason: `AMP Governance service did not answer the policy check in time. Tool "${tool}" was blocked as a safety measure.` };
    }
    return { block: true, blockReason: `AMP Governance service is unreachable. Tool "${tool}" was blocked as a safety measure. Restore the AMP backend and retry.` };
  }

  // Never dereference hitlResponse directly: null / array / scalar bodies fail closed below.
  const body = hitlResponse && typeof hitlResponse === 'object' && !Array.isArray(hitlResponse) ? hitlResponse : {};
  // K2: bind to the request's work item at once, before any await — unless the
  // instance has already seen that id (stale or another call's): then stay unbound.
  const seen = seenWorkitemsFor(instanceId);
  const requestWorkitemId = nonEmptyId(body.workitem_id);
  const boundWorkitemId = requestWorkitemId && !seen.has(requestWorkitemId) ? requestWorkitemId : null;
  if (boundWorkitemId) rememberWorkitem(seen, boundWorkitemId);
  const status = typeof body.status === 'string' ? body.status : '';
  const rawReason = body.reason || body.information || '';
  const reason = typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason);
  await ampLog(instanceId, `Policy decision: ${tool} | status=${status}${reason ? ` | ${reason}` : ''}`);

  // ── No policy configured — block ─────────────────────────────────────────
  if (status === 'no_policy') {
    const msg = `Tool call "${tool}" blocked — no active governance policy for agent "${config.AGENT_NAME}". Contact your administrator.`;
    await ampLog(instanceId, msg, 'WARN');
    return { block: true, blockReason: msg };
  }

  // ── Eval engine approved — allow (set mirrors Hermes HP __init__.py:772) ──
  if (status === 'no-hitl' || status === 'allow' || status === 'allowed' || status === 'approved') {
    if (signal?.aborted) {
      const msg = `Tool call "${tool}" blocked — run cancelled before the AMP allow could be applied.`;
      await ampLog(instanceId, msg, 'WARN');
      return { block: true, blockReason: msg };
    }
    console.log(`[AMP Governance] Policy approved: ${tool} (${reason || 'ok'})`);
    return {};
  }

  // ── Policy / config error (HTTP 200 from the backend) — block ────────────
  if (status === 'policy_error' || status === 'config_error' || status === 'error') {
    const detail = body.message || reason || 'AMP policy is misconfigured';
    const msg = `Tool call "${tool}" blocked — AMP policy error (${body.reason || status}): ${detail}`;
    console.error(`[AMP Governance] ${msg}`);
    await ampLog(instanceId, msg, 'ERROR');
    return { block: true, blockReason: msg };
  }

  // ── HITL required — wait for human decision ──────────────────────────────
  if (status === 'pending' || status === 'waiting-for-response' || requestWorkitemId) {
    console.log(`[AMP Governance] HITL required for "${tool}" — waiting for human decision...`);
    await ampLog(instanceId, `HITL requested for tool: ${tool} — awaiting human approval in AMP`, 'WARN');

    // Notify the user immediately so they aren't staring at silence
    notifyUser(_lastSender, `I need a reviewer to approve "${tool}" before I can proceed. I'll follow up once the decision is made — this may take a few minutes.`);

    let decision;
    try {
      decision = await pollHitlDecision(instanceId, { signal, boundWorkitemId, actionId, deadline });
    } catch (err) {
      if (signal?.aborted) {
        const msg = `Tool call "${tool}" blocked — run cancelled while waiting for AMP review.`;
        await ampLog(instanceId, msg, 'WARN');
        return { block: true, blockReason: msg };
      }
      if (err instanceof ActionIdCorrelationError) {
        const msg = `Tool call "${tool}" blocked — ${err.message}`;
        console.error(`[AMP Governance] ${msg}`);
        await ampLog(instanceId, msg, 'ERROR');
        notifyUser(_lastSender, `AMP could not correlate the review for "${tool}" — the call was blocked.`);
        return { block: true, blockReason: msg };
      }
      if (err instanceof UnverifiableDecisionError) {
        console.error(`[AMP Governance] Tool call "${tool}": ${err.message}`);
        await ampLog(instanceId, `Tool call "${tool}": ${err.message}`, 'ERROR');
        notifyUser(_lastSender, `AMP returned a decision for "${tool}" that could not be tied to the call — it was blocked.`);
        return { block: true, blockReason: err.message };
      }
      if (err instanceof PollFatalError) {
        const msg = `Tool call "${tool}" blocked — AMP rejected the HITL decision poll (HTTP ${err.status}).`;
        console.error(`[AMP Governance] ${msg} ${err.body}`);
        await ampLog(instanceId, `${msg} ${err.body}`, 'ERROR');
        notifyUser(_lastSender, `AMP rejected the review check for "${tool}" (HTTP ${err.status}) — the call was blocked.`);
        return { block: true, blockReason: msg };
      }
      if (!(err instanceof HitlTimeoutError)) {
        // Network failure (not our request timeout): AMP is unreachable, not the reviewer slow.
        const em = err?.cause?.code || (err && err.message ? err.message : String(err));
        const msg = `Tool call "${tool}" blocked — AMP became unreachable while waiting for the AMP review (${em}).`;
        console.error(`[AMP Governance] ${msg}`);
        await ampLog(instanceId, msg, 'ERROR');
        notifyUser(_lastSender, `AMP became unreachable during the review for "${tool}" — the call was blocked.`);
        return { block: true, blockReason: msg };
      }
      const msg = budgetExhaustedMessage(tool);
      await ampLog(instanceId, msg, 'ERROR');
      notifyUser(_lastSender, `No response from the reviewer — "${tool}" was blocked due to timeout.`);
      return { block: true, blockReason: msg };
    }

    if (isCancelledDecision(decision)) {
      const msg = `Tool call "${tool}" blocked — the AMP review was cancelled before a decision was made.`;
      await ampLog(instanceId, `HITL cancelled — blocked: ${tool} | workitem: ${decision.workitem_id}`, 'WARN');
      notifyUser(_lastSender, `The review for "${tool}" was cancelled — the call was blocked.`);
      return { block: true, blockReason: msg };
    }

    const resolution = String(decision.resolution || '').toLowerCase().trim();
    console.log(`[AMP Governance] HITL decision for "${tool}": ${resolution}`);

    if (resolution === 'approve' || resolution === 'approved') {
      await ampLog(instanceId, `HITL approved: ${tool} | workitem: ${decision.workitem_id}`);
      // Last check after the final await: a run cancelled meanwhile must not proceed.
      if (signal?.aborted) {
        const msg = `Tool call "${tool}" blocked — run cancelled before the AMP approval could be applied.`;
        await ampLog(instanceId, `${msg} | workitem: ${decision.workitem_id}`, 'WARN');
        return { block: true, blockReason: msg };
      }
      notifyUser(_lastSender, `The reviewer approved "${tool}" — continuing now.`);
      return {};
    }

    const info = decision.information ? ` Reviewer note: ${decision.information}` : '';

    // Modified params cannot be applied exactly yet — block the original call.
    if (resolution === 'modify' || resolution === 'modified') {
      const msg = `Tool call "${tool}" was not executed: the reviewer approved a modified version, which AMP cannot apply to this call yet. Re-submit with the reviewer's changes.${info}`;
      await ampLog(instanceId, `HITL modify not applied — blocked: ${tool} | workitem: ${decision.workitem_id}`, 'WARN');
      notifyUser(_lastSender, `The reviewer modified "${tool}" — the original call was blocked; please re-submit.`);
      return { block: true, blockReason: msg };
    }

    if (resolution === 'reject' || resolution === 'rejected') {
      const msg = `Tool call "${tool}" was rejected by a human reviewer.${info}`;
      await ampLog(instanceId, `HITL rejected: ${tool} | workitem: ${decision.workitem_id}`, 'WARN');
      notifyUser(_lastSender, `The reviewer rejected "${tool}".${info}`);
      return { block: true, blockReason: msg };
    }

    // Empty, expired or unknown resolution: no decision to act on (K5).
    const msg = `Tool call "${tool}": AMP returned no usable decision (resolution=${resolution}) — blocked.`;
    console.error(`[AMP Governance] ${msg}`);
    await ampLog(instanceId, `${msg} | workitem: ${decision.workitem_id}`, 'ERROR');
    notifyUser(_lastSender, `AMP returned no usable decision for "${tool}" — the call was blocked.`);
    return { block: true, blockReason: msg };
  }

  // ── Unknown response — fail CLOSED ───────────────────────────────────────
  const msg = `Tool call "${tool}" blocked — AMP returned an unexpected status "${status || 'missing'}".`;
  console.error('[AMP Governance] Unexpected HITL response:', JSON.stringify(hitlResponse));
  await ampLog(instanceId, `${msg} Body: ${JSON.stringify(hitlResponse)}`, 'ERROR');
  return { block: true, blockReason: msg };
}

// ── TEXT FORMATTING HELPERS ──────────────────────────────────────────────────

function extractText(obj) {
  if (obj === undefined || obj === null) return '(empty)';
  if (typeof obj === 'string') {
    try { return extractText(JSON.parse(obj)); } catch { return obj; }
  }
  if (Array.isArray(obj)) {
    return obj.map(extractText).filter(Boolean).join('\n');
  }
  if (typeof obj === 'object') {
    if (obj.content && Array.isArray(obj.content)) {
      return obj.content
        .filter(c => c.text !== undefined)
        .map(c => extractText(c.text))
        .join('\n');
    }
    if (typeof obj.text === 'string') return extractText(obj.text);
    return Object.entries(obj)
      .filter(([k]) => k !== 'type')
      .map(([k, v]) => `${k}: ${extractText(v)}`)
      .join(' | ');
  }
  return String(obj);
}

function formatInput(tool, params) {
  if (!params) return '';
  try {
    switch (tool) {
      case 'web_search':
        return `query: "${params.query}"${params.count ? ` (top ${params.count})` : ''}`;
      case 'read':
        return `path: ${params.path || params.file_path || JSON.stringify(params)}`;
      case 'write':
      case 'edit':
        return `path: ${params.path || params.file_path || '?'}`;
      case 'bash':
      case 'shell':
        return `cmd: ${String(params.command || params.cmd || '').substring(0, 120)}`;
      default:
        return extractText(params).substring(0, 200);
    }
  } catch {
    return String(params).substring(0, 200);
  }
}

function stripWrapper(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')
    .replace(/<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')
    .replace(/Source:\s*Web Search\s*---/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getRawText(result) {
  try {
    const obj = typeof result === 'string' ? JSON.parse(result) : result;
    if (obj?.content && Array.isArray(obj.content)) {
      const item = obj.content.find(c => c.text !== undefined);
      if (item) return String(item.text);
    }
    if (typeof obj?.text === 'string') return obj.text;
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return typeof result === 'string' ? result : '';
  }
}

function formatOutput(tool, result) {
  if (result === undefined || result === null) return '(empty)';
  try {
    switch (tool) {
      case 'web_search': {
        const raw = getRawText(result);
        try {
          const tavily = JSON.parse(raw);
          const results = tavily?.externalContent?.results || tavily?.results || [];
          if (results.length > 0) {
            const lines = results.slice(0, 3).map((r, i) => {
              const title   = stripWrapper(r.title || '');
              const url     = r.url || '';
              const snippet = stripWrapper(r.content || r.snippet || '').substring(0, 200);
              return `[${i + 1}] ${title} › ${url} › ${snippet}`;
            });
            return `${results.length} result(s): ${lines.join(' ◆ ')}`;
          }
        } catch (e) {
          console.error('[AMP Governance] web_search parse failed:', e.message);
        }
        return stripWrapper(raw).substring(0, 400);
      }
      case 'read': {
        const text = extractText(result);
        return text.substring(0, 300);
      }
      default:
        return extractText(result).substring(0, 400);
    }
  } catch {
    return String(result).substring(0, 300);
  }
}

// ── PLUGIN REGISTRATION ──────────────────────────────────────────────────────

export default {
  id: 'amp-governance',
  name: 'AMP Governance',
  description: 'AMP transparency, accountability, and HITL integration for OpenClaw',
  register(api) {
    api.logger.info('AMP Governance registered. Phase 4 - eval policy enforcement active.');
    _runtime = api.runtime;

    // ── HOOK BUDGET: fit inside a shorter operator hook timeout (A3) ─────────
    // Recomputed on every register() so a removed/raised override does not linger.
    _callBudgetMs = HITL_TIMEOUT_MS;
    _hookBudgetLimitMs = null;
    const override = operatorHookTimeoutMs(api.config);
    if (override !== null) {
      const margin = Math.min(5000, 0.25 * override);
      _callBudgetMs = Math.min(HITL_TIMEOUT_MS, override - margin);
      if (_callBudgetMs < HITL_TIMEOUT_MS) _hookBudgetLimitMs = override;
      if (override < HOOK_TIMEOUT_MS) {
        const msg = `AMP Governance: plugins.entries.${PLUGIN_ID}.hooks.timeouts.before_tool_call=${override}ms is shorter than HITL_TIMEOUT_MINUTES + 30 s (${HOOK_TIMEOUT_MS}ms); AMP reviews longer than ~${Math.round(_callBudgetMs / 1000)}s will be blocked. Raise it (max 600000).`;
        api.logger?.error?.(msg);
        console.error(`[AMP Governance] ${msg}`);
      }
    }

    // ── HOOK AUTO-DEPLOY on registration ─────────────────────────────────────
    // `api.rootDir` does not exist on this SDK's plugin api (only `api.source`,
    // the absolute path to this entry file) — derive the plugin root from that.
    // Deploy directly here rather than deferring to a 'gateway_start' listener:
    // register() is guaranteed to run on every plugin load, whereas relying on
    // a later event left this silently dead (api.rootDir was always undefined).
    if (api.source) deployHookFilesIfNeeded(path.dirname(api.source));

    // ── CLI: `openclaw amp connect` ───────────────────────────────────────────
    if (typeof api.registerCli === 'function') {
      api.registerCli(({ program }) => {
        const amp = program.command('amp').description('AMP governance commands');
        amp.command('connect')
          .description('Connect this OpenClaw agent to AMP: writes config, enables the hook, restarts the gateway')
          .requiredOption('--api-key <key>', 'AMP API key')
          .requiredOption('--org-id <id>', 'AMP org id')
          .requiredOption('--username <email>', 'AMP account username')
          .requiredOption('--agent-name <name>', 'Name for this agent')
          .option('--backend-url <url>', 'AMP backend URL', 'http://localhost:3000')
          .option('--hitl-timeout <minutes>', 'HITL approval timeout in minutes', '10')
          .action(runAmpConnect);
      }, { commands: ['amp'] });
    }

    // ── SESSION RESET: clear instance cache on /new or /reset ────────────────
    api.on('session_start', () => {
      console.log('[AMP Governance] Session started — clearing instance cache.');
      _instanceId = null;
      clearSession();
    });

    // ── INBOUND MESSAGE: cache sender for HITL/outage notifications ──────────
    api.on('message_received', async (event, ctx) => {
      if (typeof event?.from === 'string' && event.from && ctx?.channelId) {
        _lastSender = { from: event.from, channelId: ctx.channelId };
        console.log(`[AMP Governance] Sender cached: ${event.from} on ${ctx.channelId}`);
      }
    });

    // ── BEFORE TOOL CALL: governance check + logging ─────────────────────────
    api.on('before_tool_call', async (event, ctx) => {
      // C10: one budget per call, shared by the lock wait and the HITL poll.
      const callDeadline = Date.now() + _callBudgetMs;
      return _callScope.run({ deadline: callDeadline }, () => beforeToolCall(event, ctx, callDeadline));
    }, { timeoutMs: HOOK_TIMEOUT_MS });

    async function beforeToolCall(event, ctx, callDeadline) {
      const tool = event.toolName || event.name || 'unknown-tool';
      if (SKIP_TOOLS.has(tool)) return {};

      const instanceId = await ensureInstance();
      if (!instanceId) {
        const reason = !config
          ? 'AMP Governance plugin is not configured (amp_config.json missing or invalid).'
          : 'AMP Governance service is unreachable.';
        console.error(`[AMP Governance] No instance available — blocking tool "${tool}". Reason: ${reason}`);
        if (!config) {
          await notifyUser(_lastSender,
            `🚨 *AMP Governance Not Configured*\n\n` +
            `The AMP Governance plugin has no valid configuration. ` +
            `All OpenClaw activities are blocked until amp_config.json is set up correctly.\n\n` +
            `Please configure AMP_BACKEND_URL, AMP_API_KEY, and AMP_ORG_ID in:\n` +
            CONFIG_FILE
          );
        } else {
          await notifyAmpDown(tool, 'Could not establish an AMP session — backend may be down or unreachable.');
        }
        return { block: true, blockReason: reason };
      }

      // Log the incoming tool call
      const message = `Tool call: ${tool} | Input: ${formatInput(tool, event.params)}`;
      console.log(`[AMP Governance] before_tool_call: ${tool} | instance: ${instanceId}`);
      await ampLog(instanceId, message);

      // Governance check — returns {} to allow or { block, blockReason } to block
      const actionId = ACTION_ID_CORRELATION ? (event.toolCallId || randomUUID()) : null;
      return await checkToolPolicy(instanceId, tool, event.params, { signal: ctx?.abortSignal, actionId, deadline: callDeadline });
    }

    // ── AFTER TOOL CALL: result logging ──────────────────────────────────────
    api.on('after_tool_call', async (event) => {
      const tool = event.toolName || event.name || 'unknown-tool';
      if (SKIP_TOOLS.has(tool)) return;

      const instanceId = _instanceId || readSession()?.instanceId;
      if (!instanceId) return;

      const result   = event.result ?? event.output ?? event.toolOutput;
      const status   = event.success === false ? 'FAILED' : 'OK';
      const duration = event.durationMs != null ? ` (${event.durationMs}ms)` : '';
      const output   = formatOutput(tool, result);
      const message  = `Tool result: ${tool} | Status: ${status}${duration} | ${output}`;

      console.log(`[AMP Governance] after_tool_call: ${tool} | status: ${status}`);
      await ampLog(instanceId, message, event.success === false ? 'ERROR' : 'INFO');
    });

    // ── OUTBOUND MESSAGE LOGGING ──────────────────────────────────────────────
    api.on('message_sending', async (event) => {
      const instanceId = _instanceId || readSession()?.instanceId;
      const msgText    = event.content || event.text || event.message || JSON.stringify(event);
      const preview    = msgText.substring(0, 100);
      if (instanceId) {
        await ampLog(instanceId, `Agent reply: ${preview}`);
      }
    });
  },
};
