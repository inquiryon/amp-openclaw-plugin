import * as fs from 'fs';
import * as path from 'path';

console.log('--- [AMP Hook] Logic Loaded — Phase 5 ---');

// Same resolution as plugin/index.js (and OpenClaw's own resolveConfigDir):
// OPENCLAW_STATE_DIR, then legacy CLAWDBOT_STATE_DIR, then ~/.openclaw.
function resolveStateDir(): string {
  const override = (process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || '').trim();
  if (override) return override;
  return path.join(process.env.HOME || '', '.openclaw');
}

// Loaded lazily and retried on every event until it parses, so a missing or
// broken amp_config.json never throws at import (that used to stop the hook loading).
let config: any = null;

function loadConfig(): any {
  if (config) return config;
  const configPath = path.join(resolveStateDir(), 'hooks/amp/amp_config.json');
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    console.error(`[AMP Hook] Config not loaded (${configPath}): ${err?.message || err}`);
    config = null;
  }
  return config;
}

function normalizeBackendUrl(raw: unknown): string {
  let base = String(raw || '').trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, '');
}

function buildAmpUrl(p: string): string {
  const base = normalizeBackendUrl(config?.AMP_BACKEND_URL);
  if (!base) throw new Error('AMP_BACKEND_URL missing');
  const suffix = p.startsWith('/') ? p : `/${p}`;
  return `${base}${suffix}`;
}

function getAmpApiKey(): string {
  let key = String(config?.AMP_API_KEY || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, '').trim();
  return key;
}

// Hook-owned session record. index.js keeps its own plugin-session.json next to
// it; each side only finalizes records tagged with its own writer (A13, #22/#23).
const SESSION_WRITER = 'hook';

function sessionFile(): string {
  return path.join(resolveStateDir(), 'hooks/amp/hook-session.json');
}
const COMMAND_THRESHOLD = 30;  // roll to new instance after this many tool calls

// In-memory state (cleared on process restart)
const sessionMap    = new Map<string, string>();  // convKey → instanceId
const commandCounts = new Map<string, number>();  // convKey → tool call count
const seenMessages  = new Set<string>();          // dedup guard

let _startupCleanupDone = false;

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function ampLog(instanceId: string, message: string, level: string = 'INFO'): Promise<void> {
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
        username:    config.AMP_USERNAME
      })
    });
  } catch (err) {
    console.error('[AMP Hook] ampLog failed:', err);
  }
}

async function setInstanceFinished(instanceId: string): Promise<void> {
  if (!config) return;
  try {
    const apiKey = getAmpApiKey();
    await fetch(buildAmpUrl('/api/agent/setState'), {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: config.AGENT_NAME, instance_id: instanceId, state: 'finished' })
    });
    console.log(`[AMP Hook] Instance ${instanceId} marked finished.`);
  } catch (err) {
    console.error('[AMP Hook] setInstanceFinished failed:', err);
  }
}

function writeSessionFile(instanceId: string, convKey: string): void {
  try {
    const file = sessionFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      instanceId,
      convKey,
      writer:    SESSION_WRITER,
      timestamp: new Date().toISOString()
    }), 'utf-8');
  } catch (err) {
    console.error('[AMP Hook] Failed to write session file:', err);
  }
}

function clearSessionFile(): void {
  try { fs.unlinkSync(sessionFile()); } catch {}
}

function conversationKey(event: any): string {
  const ctx = event.context || {};
  const convId  = ctx.conversationId || ctx.from || '';
  const channel = ctx.channelId || event.channel || 'whatsapp';
  return convId ? `${channel}:${convId}` : (event.taskId || 'global');
}

function buildToolMessage(event: any): string {
  const tool = event.toolName || event.tool || event.name || 'unknown-tool';
  const parts: string[] = [`Tool: ${tool}`];
  const raw_input = event.toolInput ?? event.input ?? event.args;
  if (raw_input != null) {
    const s = typeof raw_input === 'string' ? raw_input : JSON.stringify(raw_input);
    parts.push(`Input: ${s.substring(0, 200)}`);
  }
  const raw_output = event.toolOutput ?? event.output ?? event.result;
  if (raw_output != null) {
    const s = typeof raw_output === 'string' ? raw_output : JSON.stringify(raw_output);
    parts.push(`Output: ${s.substring(0, 200)}`);
  }
  if (event.durationMs != null) parts.push(`Duration: ${event.durationMs}ms`);
  if (event.success === false)   parts.push('Status: FAILED');
  return parts.join(' | ');
}

// ── INSTANCE LIFECYCLE ────────────────────────────────────────────────────────

/**
 * On first event after process restart, finalize any orphaned hook-owned
 * instance left in hook-session.json from the previous run, then clear the file.
 * Records not tagged writer:'hook' are never finalized, and the legacy shared
 * /tmp/amp-session-state.json is never read.
 */
async function startupCleanup(): Promise<void> {
  if (_startupCleanupDone) return;
  _startupCleanupDone = true;
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile(), 'utf-8'));
    if (session?.instanceId && session.writer === SESSION_WRITER) {
      console.log(`[AMP Hook] Startup: finalizing orphaned instance ${session.instanceId}`);
      await setInstanceFinished(session.instanceId);
    }
  } catch {} // No session file or parse error — nothing to clean up
  clearSessionFile();
}

async function finalizeInstance(convKey: string, reason: string): Promise<void> {
  const instanceId = sessionMap.get(convKey);
  if (!instanceId) return;
  console.log(`[AMP Hook] Finalizing ${instanceId} (${reason})`);
  await setInstanceFinished(instanceId);
  sessionMap.delete(convKey);
  commandCounts.delete(convKey);
  clearSessionFile();
}

async function initInstance(convKey: string, prompt: string, metadata: object): Promise<string | null> {
  if (!config) return null;
  try {
    const initUrl = buildAmpUrl('/api/agent/init');
    const apiKey = getAmpApiKey();
    const response = await fetch(initUrl, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_name: config.AGENT_NAME,
        prompt,
        auto_start: true,
        config:     { agent_mode: 'polling' },
        metadata:   { source: 'openclaw-whatsapp', org_id: config.AMP_ORG_ID, ...metadata }
      })
    });
    const data = await response.json().catch(() => ({} as any));
    const errText = (data && (data.error || data.detail || data.message)) ? String(data.error || data.detail || data.message) : '';
    console.log(`[AMP Hook] Init response: ${response.status} | instance: ${data.instance_id || 'NONE'}${errText ? ` | error: ${errText}` : ''}`);
    if (data.instance_id) {
      sessionMap.set(convKey, data.instance_id);
      commandCounts.set(convKey, 0);
      writeSessionFile(data.instance_id, convKey);
      return data.instance_id;
    }
  } catch (err: any) {
    const em = err?.message || String(err);
    const ec = err?.cause ? (err.cause.code || err.cause.message || String(err.cause)) : '';
    let target = '';
    try { target = buildAmpUrl('/api/agent/init'); } catch {}
    console.error(`[AMP Hook] initInstance failed: ${em}${ec ? ` | cause=${ec}` : ''}${target ? ` | url=${target}` : ''}`);
  }
  return null;
}

/**
 * Check command threshold. If reached: log, finalize current instance,
 * start a new one. Returns the (possibly new) active instanceId.
 */
async function checkThreshold(convKey: string): Promise<string | null> {
  const count = (commandCounts.get(convKey) || 0) + 1;
  commandCounts.set(convKey, count);

  if (count >= COMMAND_THRESHOLD) {
    const oldInstanceId = sessionMap.get(convKey);
    if (oldInstanceId) {
      const msg = `Reached ${COMMAND_THRESHOLD}-command threshold — rolling to a new agent instance.`;
      console.log(`[AMP Hook] ${msg}`);
      await ampLog(oldInstanceId, msg, 'INFO');
      await finalizeInstance(convKey, `${COMMAND_THRESHOLD}-command threshold`);
    }
    // Start fresh instance (reuse last known prompt/metadata not available here — use placeholder)
    const newId = await initInstance(convKey, 'Continued session (threshold rollover)', {});
    if (newId) commandCounts.set(convKey, 1); // count the current call
    return newId;
  }

  return sessionMap.get(convKey) || null;
}

// ── MAIN HOOK ─────────────────────────────────────────────────────────────────

export default async function ampHook(event: any) {
  if (!loadConfig()) return;  // not configured: no network, no state

  const type    = event.type;
  const convKey = conversationKey(event);

  const ctx         = event.context || {};
  const messageText = ctx.content || event.text || event.input || 'WhatsApp Inbound';
  const senderName  = ctx.metadata?.senderName || ctx.from || 'unknown';
  const messageId   = ctx.messageId || '';

  console.log(`[AMP Hook] Event: ${type} | Conv: ${convKey} | Sender: ${senderName}`);

  // ── STARTUP CLEANUP ────────────────────────────────────────────────────────
  await startupCleanup();

  // ── 1. INBOUND MESSAGE ─────────────────────────────────────────────────────
  // Init a new instance only if this conversation has no active instance.
  // Subsequent messages in the same conversation reuse the existing instance.
  // Only user-originated messages: OpenClaw also emits message:sent for agent replies.
  const isInbound = type === 'message' && event.action === 'received' && !!messageId;

  if (isInbound) {
    // Deduplicate repeated message events
    if (seenMessages.has(messageId)) return;
    seenMessages.add(messageId);
    if (seenMessages.size > 50) seenMessages.delete(seenMessages.values().next().value);

    if (!sessionMap.has(convKey)) {
      // No active instance for this conversation — create one
      console.log(`[AMP Hook] New conversation. Init AMP instance for: ${messageText.substring(0, 60)}`);
      const instanceId = await initInstance(convKey, messageText, {
        channel:      ctx.channelId || 'whatsapp',
        sender:       senderName,
        sender_phone: ctx.from || '',
        message_id:   messageId,
      });
      if (instanceId) {
        await ampLog(instanceId, `User prompt: '${messageText}'`);
      }
    } else {
      // Existing instance — log the new message and reuse
      const instanceId = sessionMap.get(convKey)!;
      console.log(`[AMP Hook] Existing instance ${instanceId} — reusing for new message.`);
      await ampLog(instanceId, `User prompt: '${messageText}'`);
    }
  }

  // ── 2. TOOL LOGGING + THRESHOLD CHECK ─────────────────────────────────────
  if (typeof type === 'string' && type.startsWith('tool:')) {
    const instanceId = await checkThreshold(convKey);
    if (instanceId) {
      try {
        const message = buildToolMessage(event);
        console.log(`[AMP Hook] Logging tool: ${message.substring(0, 100)}`);
        await ampLog(instanceId, message, event.success === false ? 'ERROR' : 'INFO');
      } catch (err) {
        console.error('[AMP Hook] Tool log failed:', err);
      }
    }
  }

}
