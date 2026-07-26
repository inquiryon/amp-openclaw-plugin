import * as fs from 'fs';
import { normalizeTool } from './toolNormalization.js';

console.log('[AMP Governance] Plugin module loaded — Phase 4.');

const SESSION_FILE = '/tmp/amp-session-state.json';
const CONFIG_FILE = `${process.env.HOME}/.openclaw/hooks/amp/amp_config.json`;

// Tools that are internal/noisy — skip logging and policy checks
const SKIP_TOOLS = new Set(['session_status', 'heartbeat']);

const HITL_POLL_INTERVAL_MS = 3000; // 3 seconds between polls

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

// HITL timeout — configurable via HITL_TIMEOUT_MINUTES in amp_config.json (default: 10)
const HITL_TIMEOUT_MS = (config?.HITL_TIMEOUT_MINUTES ?? 10) * 60 * 1000;

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
 * files from the plugin's install directory into ~/.openclaw/hooks/amp/.
 * Never overwrites an existing amp_config.json so user credentials are safe.
 */
function deployHookFilesIfNeeded(pluginRootDir) {
  const hookSrc  = `${pluginRootDir}/hook`;
  const hookDest = `${process.env.HOME}/.openclaw/hooks/amp`;

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

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSession(instanceId) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ instanceId }), 'utf-8');
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
    });
  } catch (err) {
    console.error('[AMP Governance] ampLog failed:', err.message);
  }
}

// ── PROACTIVE NOTIFICATIONS ──────────────────────────────────────────────────

/**
 * Send a proactive WhatsApp message to the user without waiting for the agent
 * to finish. Uses the openclaw CLI so we don't need to reverse-engineer the
 * gateway REST API.  Fire-and-forget — errors are logged but never thrown.
 */
async function notifyUser(sender, message) {
  if (!sender?.from || !_runtime) return;
  const prefixed = `[AMP]\n${message}`;
  console.log(`[AMP Governance] Sending notification to ${sender.from}: ${message}`);
  try {
    const channelId = sender.channelId || '';
    if (channelId === 'slack' || sender.from.startsWith('slack:')) {
      // Strip the 'slack:' prefix — sendMessageSlack expects 'channel:<id>' or 'user:<id>', not 'slack:channel:<id>'
      const slackTarget = sender.from.startsWith('slack:') ? sender.from.slice('slack:'.length) : sender.from;
      await _runtime.channel.slack.sendMessageSlack(slackTarget, prefixed);
    } else {
      await _runtime.channel.whatsapp.sendMessageWhatsApp(sender.from, prefixed, { verbose: false });
    }
  } catch (err) {
    console.warn('[AMP Governance] notifyUser failed:', err.message);
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

/**
 * Call /api/hitl/request with the tool call details.
 * The AMP backend eval engine decides allow vs HITL.
 */
async function requestHitlEval(instanceId, tool, params) {
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
      hitl: {
        enable: true,
        when:   'policy',
        // who/what/where resolved by the backend from the policy's hitl_spec
      },
    }),
  });
  if (!res.ok) throw new Error(`/api/hitl/request returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Poll /api/hitl/get-decision until we get a 'complete' status or time out.
 */
async function pollHitlDecision(callerId) {
  const apiKey = getAmpApiKey();
  const deadline = Date.now() + HITL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, HITL_POLL_INTERVAL_MS));
    const res = await fetch(
      `${buildAmpUrl('/api/hitl/get-decision')}?caller_id=${encodeURIComponent(callerId)}`,
      { headers: { 'X-API-Key': apiKey } }
    );
    if (!res.ok) {
      console.warn(`[AMP Governance] get-decision returned ${res.status}, retrying...`);
      continue;
    }
    const data = await res.json();
    if (data.status === 'complete') return data;
    console.log(`[AMP Governance] Waiting for human decision... (${data.status})`);
  }
  throw new Error(`HITL decision timed out after ${HITL_TIMEOUT_MS / 60000} minutes`);
}

/**
 * Full governance check for a single tool call.
 * Returns normally if the call is allowed (or approved by a human).
 * Throws an Error with a clear reason if the call is blocked or rejected.
 * Fails open (returns without throwing) if AMP backend is unreachable.
 */
/**
 * Returns {} to allow, or { block: true, blockReason } to block.
 * Never throws — errors fail open so infra issues don't break the agent.
 */
async function checkToolPolicy(instanceId, tool, params) {
  const paramSummary = formatInput(tool, params);
  await ampLog(instanceId, `Policy check: ${tool} | ${paramSummary}`);

  let hitlResponse;
  try {
    hitlResponse = await requestHitlEval(instanceId, tool, params);
    // Successful contact with AMP — clear any prior down state
    await notifyAmpRecovered();
  } catch (err) {
    const em = err && err.message ? err.message : String(err);
    console.error(`[AMP Governance] HITL request failed — blocking tool "${tool}": ${em}`);
    await ampLog(instanceId, `AMP governance check failed — tool "${tool}" blocked: ${em}`, 'ERROR');
    _ampReachable = false;
    await notifyAmpDown(tool, em);
    return { block: true, blockReason: `AMP Governance service is unreachable. Tool "${tool}" was blocked as a safety measure. Restore the AMP backend and retry.` };
  }

  const status = hitlResponse.status;
  const rawReason = hitlResponse.reason || hitlResponse.information || '';
  const reason = typeof rawReason === 'string' ? rawReason : JSON.stringify(rawReason);
  await ampLog(instanceId, `Policy decision: ${tool} | status=${status}${reason ? ` | ${reason}` : ''}`);

  // ── No policy configured — block ─────────────────────────────────────────
  if (status === 'no_policy') {
    const msg = `Tool call "${tool}" blocked — no active governance policy for agent "${config.AGENT_NAME}". Contact your administrator.`;
    await ampLog(instanceId, msg, 'WARN');
    return { block: true, blockReason: msg };
  }

  // ── Eval engine approved — allow ─────────────────────────────────────────
  if (status === 'no-hitl') {
    console.log(`[AMP Governance] Policy approved: ${tool} (${reason || 'ok'})`);
    return {};
  }

  // ── HITL required — wait for human decision ──────────────────────────────
  if (status === 'pending' || status === 'waiting-for-response' || hitlResponse.workitem_id) {
    console.log(`[AMP Governance] HITL required for "${tool}" — waiting for human decision...`);
    await ampLog(instanceId, `HITL requested for tool: ${tool} — awaiting human approval in AMP`, 'WARN');

    // Notify the user immediately so they aren't staring at silence
    notifyUser(_lastSender, `I need a reviewer to approve "${tool}" before I can proceed. I'll follow up once the decision is made — this may take a few minutes.`);

    let decision;
    try {
      decision = await pollHitlDecision(instanceId);
    } catch (err) {
      const msg = `Tool call "${tool}" timed out waiting for human approval — blocked.`;
      await ampLog(instanceId, msg, 'ERROR');
      notifyUser(_lastSender, `No response from the reviewer — "${tool}" was blocked due to timeout.`);
      return { block: true, blockReason: msg };
    }

    const resolution = String(decision.resolution || '').toLowerCase().trim();
    console.log(`[AMP Governance] HITL decision for "${tool}": ${resolution}`);

    if (resolution === 'approve' || resolution === 'approved') {
      await ampLog(instanceId, `HITL approved: ${tool} | workitem: ${decision.workitem_id}`);
      notifyUser(_lastSender, `The reviewer approved "${tool}" — continuing now.`);
      return {};
    }

    if (resolution === 'modify' || resolution === 'modified') {
      await ampLog(instanceId, `HITL approved with modification: ${tool} | workitem: ${decision.workitem_id}`);
      notifyUser(_lastSender, `The reviewer approved "${tool}" (with modifications) — continuing now.`);
      return {};
    }

    // Rejected
    const info = decision.information ? ` Reviewer note: ${decision.information}` : '';
    const msg = `Tool call "${tool}" was rejected by a human reviewer.${info}`;
    await ampLog(instanceId, `HITL rejected: ${tool} | workitem: ${decision.workitem_id}`, 'WARN');
    notifyUser(_lastSender, `The reviewer rejected "${tool}".${info}`);
    return { block: true, blockReason: msg };
  }

  // Unknown response — fail open
  console.warn('[AMP Governance] Unexpected HITL response:', JSON.stringify(hitlResponse));
  await ampLog(instanceId, `Unexpected HITL response for ${tool}: ${JSON.stringify(hitlResponse)}`, 'WARN');
  return {};
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

    // ── HOOK AUTO-DEPLOY on gateway start ────────────────────────────────────
    api.on('gateway_start', () => {
      if (api.rootDir) deployHookFilesIfNeeded(api.rootDir);
    });

    // ── SESSION RESET: clear instance cache on /new or /reset ────────────────
    api.on('session_start', () => {
      console.log('[AMP Governance] Session started — clearing instance cache.');
      _instanceId = null;
      clearSession();
    });

    // ── INBOUND MESSAGE: cache sender for HITL/outage notifications ──────────
    api.on('message_received', async (event, ctx) => {
      if (event.from && ctx.channelId) {
        _lastSender = { from: event.from, channelId: ctx.channelId };
        console.log(`[AMP Governance] Sender cached: ${event.from} on ${ctx.channelId}`);
      }
    });

    // ── BEFORE TOOL CALL: governance check + logging ─────────────────────────
    api.on('before_tool_call', async (event) => {
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
            `~/.openclaw/hooks/amp/amp_config.json`
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
      return await checkToolPolicy(instanceId, tool, event.params);
    });

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
