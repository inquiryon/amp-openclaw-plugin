// Drive the AMP plugin's before_tool_call through OpenClaw's REAL plugin loader
// + REAL global hook runner + REAL tool-call gate (runBeforeToolCallHook /
// wrapToolWithBeforeToolCallHook) — no LLM, no gateway.
//
// Copied from the workspace compat harness (.tools/compat/openclaw); only default paths changed.
// Usage (driven by test/real-openclaw.test.mjs):
//   node drive_tool_call.mjs [--modes allow,hitl_approve,...] [--out result.json] [--signal]
//   --signal: pass a caller-owned AbortSignal to the host gate (becomes ctx.abortSignal) and
//             record get-decision polls made after the host gate returned (abort probe).
// Env: OC_PKG (openclaw package dir), OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH,
//      PLUGIN_DIR (defaults to this repo's plugin/), STUB_URL (default http://127.0.0.1:18999),
//      STUB_LOG (defaults to <tmpdir>/amp-oc-stub_requests.jsonl, same as stub_amp.py)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OC_PKG = process.env.OC_PKG;
const PLUGIN_DIR = process.env.PLUGIN_DIR || path.resolve(HERE, '..', '..', 'plugin');
const STUB = process.env.STUB_URL || 'http://127.0.0.1:18999';
const STUB_LOG = process.env.STUB_LOG || path.join(os.tmpdir(), 'amp-oc-stub_requests.jsonl');
const MODES = arg('--modes', 'allow,hitl_approve,hitl_reject,no_policy,policy_error,garbage,down,hitl_slow').split(',');
const OUT = arg('--out', null);
const WITH_SIGNAL = argv.includes('--signal');
const SLOW_WAIT_MS = Number(process.env.SLOW_WAIT_MS || 25000);
const dist = path.join(OC_PKG, 'dist');
const imp = (p) => import(pathToFileURL(p).href);
const report = { openclawVersion: JSON.parse(fs.readFileSync(path.join(OC_PKG, 'package.json'))).version, steps: {}, modes: {} };

function findChunkExport(prefixRe, symbol) {
  for (const f of fs.readdirSync(dist)) {
    if (!prefixRe.test(f)) continue;
    const src = fs.readFileSync(path.join(dist, f), 'utf8');
    const m = src.match(new RegExp(`\\b${symbol} as ([\\w$]+)`));
    if (m && src.includes(`function ${symbol}`)) return { file: f, alias: m[1] };
  }
  return null;
}

async function setMode(mode) {
  const r = await fetch(`${STUB}/__mode`, { method: 'POST', body: JSON.stringify({ mode }), headers: { 'content-type': 'application/json' } });
  return (await r.json()).mode;
}
const logOffset = () => (fs.existsSync(STUB_LOG) ? fs.statSync(STUB_LOG).size : 0);
function stubEntriesSince(off) {
  if (!fs.existsSync(STUB_LOG)) return [];
  const buf = fs.readFileSync(STUB_LOG).subarray(off).toString('utf8');
  return buf.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function stubRequestsSince(off) {
  return stubEntriesSince(off).map((e) => `${e.method} ${e.path}${e.query && Object.keys(e.query).length ? '?' + new URLSearchParams(e.query) : ''}`);
}

// ── 1. config ────────────────────────────────────────────────────────────────
let config = {};
const cfgPath = process.env.OPENCLAW_CONFIG_PATH;
if (cfgPath && fs.existsSync(cfgPath)) {
  try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); report.steps.config = `loaded ${cfgPath}`; }
  catch (e) {
    const JSON5 = (await imp(path.join(OC_PKG, '..', 'json5', 'lib', 'index.js'))).default;
    config = JSON5.parse(fs.readFileSync(cfgPath, 'utf8')); report.steps.config = `loaded (json5) ${cfgPath}`;
  }
} else {
  config = { plugins: { load: { paths: [PLUGIN_DIR] }, entries: { 'amp-governance': { enabled: true } } } };
  report.steps.config = 'synthesized (no openclaw.json): plugins.load.paths=[PLUGIN_DIR]';
}
report.steps.pluginsConfig = config.plugins;

// ── 2. real loader ───────────────────────────────────────────────────────────
const loaderMod = await imp(path.join(dist, 'plugins', 'loader.js'));
const hrg = await imp(path.join(dist, 'plugins', 'hook-runner-global.js'));
let registry;
try {
  registry = loaderMod.loadOpenClawPlugins({ config, onlyPluginIds: ['amp-governance'], cache: false, activate: true, workspaceDir: process.env.OPENCLAW_STATE_DIR });
} catch (e) {
  report.steps.load = `THREW: ${e.stack || e}`;
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}
const rec = registry.plugins.find((p) => p.id === 'amp-governance');
report.steps.load = rec ? { status: rec.status, enabled: rec.enabled, origin: rec.origin, source: rec.source, error: rec.error, activated: rec.activated } : 'amp-governance NOT in registry';
report.steps.typedHooks = registry.typedHooks.filter((h) => h.pluginId === 'amp-governance').map((h) => h.hookName);
report.steps.legacyHooks = (registry.hooks || []).filter((h) => h.pluginId === 'amp-governance').map((h) => h.events);
report.steps.cliRegistrations = (registry.cliRegistrars || registry.cliRegistrations || []).filter((c) => c.pluginId === 'amp-governance').map((c) => c.commands);
report.steps.diagnostics = (registry.diagnostics || []).filter((d) => !d.pluginId || d.pluginId === 'amp-governance').map((d) => `${d.level}: ${d.message}`);
if (!rec || rec.status !== 'loaded') { console.log(JSON.stringify(report, null, 2)); process.exit(3); }

hrg.initializeGlobalHookRunner(registry);
const runner = hrg.getGlobalHookRunner();
report.steps.hasBeforeToolCallHooks = runner.hasHooks('before_tool_call');

// ── 3. real gate function ────────────────────────────────────────────────────
const gateRe = /^agent-tools\.before-tool-call-[A-Za-z0-9_-]+\.m?js$/;
const gate = findChunkExport(gateRe, 'runBeforeToolCallHook');
const wrap = findChunkExport(gateRe, 'wrapToolWithBeforeToolCallHook');
report.steps.gateChunk = gate; report.steps.wrapChunk = wrap;
const gateMod = gate ? await imp(path.join(dist, gate.file)) : null;
const runBeforeToolCallHook = gateMod?.[gate.alias];
const wrapTool = wrap ? gateMod?.[wrap.alias] : null;

// Raw plugin handler, for its own return value (bypasses host timeout/merge).
const rawHandler = registry.typedHooks.find((h) => h.pluginId === 'amp-governance' && h.hookName === 'before_tool_call')?.handler;

let n = 0;
for (const mode of MODES) {
  const r = { mode };
  await setMode(mode);
  const ctx = { agentId: 'main', sessionKey: 'agent:main:compat', sessionId: 'compat-session', runId: `run-${mode}` };
  const params = { command: 'echo hi' };

  // (a) host gate: what the runtime decides
  let off = logOffset(); let t0 = Date.now();
  const ac = WITH_SIGNAL ? new AbortController() : null;
  try {
    const out = runBeforeToolCallHook
      ? await runBeforeToolCallHook({ toolName: 'exec', params, toolCallId: `tc-${++n}`, ctx, ...(ac ? { signal: ac.signal } : {}) })
      : { note: 'runBeforeToolCallHook not found' };
    r.hostGate = { blocked: out.blocked, kind: out.kind, deniedReason: out.deniedReason, reason: out.reason };
  } catch (e) { r.hostGate = { threw: String(e) }; }
  r.hostGateMs = Date.now() - t0;
  r.hostGateEndTs = Date.now() / 1000;
  r.hostGateLogOffset = logOffset();
  r.callerSignalAborted = ac ? ac.signal.aborted : null;
  r.stubDuringHostGate = stubRequestsSince(off);

  // (b) wrapped tool: does the fake exec tool actually execute?
  // The abort probe measures only the host-gate call; extra calls would add their own polls.
  if (wrapTool && !WITH_SIGNAL) {
    let executed = false;
    const fakeExec = { name: 'exec', label: 'exec', description: 'fake exec', parameters: { type: 'object', properties: { command: { type: 'string' } } },
      execute: async () => { executed = true; return { content: [{ type: 'text', text: 'hi' }] }; } };
    t0 = Date.now(); off = logOffset();
    try {
      const w = wrapTool(fakeExec, ctx);
      const res = await w.execute(`tc-w-${++n}`, params, undefined, undefined);
      r.wrappedTool = { executed, resultText: res?.content?.[0]?.text?.slice(0, 160), details: res?.details };
    } catch (e) { r.wrappedTool = { executed, threw: String(e).slice(0, 300) }; }
    r.wrappedToolMs = Date.now() - t0;
    r.stubDuringWrapped = stubRequestsSince(off);
  }

  // (c) raw plugin return value (no host timeout). Skip for slow mode.
  if (rawHandler && mode !== 'hitl_slow' && !WITH_SIGNAL) {
    t0 = Date.now();
    try { r.pluginReturn = await rawHandler({ toolName: 'exec', params }, ctx); } catch (e) { r.pluginReturn = { threw: String(e) }; }
    r.pluginReturnMs = Date.now() - t0;
  }
  report.modes[mode] = r;
  console.error(`[driver] ${mode}: host=${JSON.stringify(r.hostGate)} ${r.hostGateMs}ms wrapped=${JSON.stringify(r.wrappedTool)}`);
}
if (MODES.includes('hitl_slow')) {
  // let the orphaned (timed-out) plugin promise finish so we can see what it would have returned
  await new Promise((res) => setTimeout(res, SLOW_WAIT_MS));
  const slow = report.modes.hitl_slow;
  slow.stubAfterWait = stubRequestsSince(0).slice(-6);
  // Polls the plugin made after the host gate had already returned: >0 after a host
  // timeout means the hook's ctx.abortSignal was NOT aborted by the timeout.
  slow.pollsAfterHostGate = stubEntriesSince(slow.hostGateLogOffset)
    .filter((e) => e.path === '/api/hitl/get-decision' && e.ts >= slow.hostGateEndTs).length;
}
await setMode('allow');
const json = JSON.stringify(report, null, 2);
if (OUT) fs.writeFileSync(OUT, json);
console.log(json);
process.exit(0);
