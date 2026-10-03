// Tier 2: drive the plugin through a REAL OpenClaw install (loader, hook runner, tool gate).
// Skipped unless OC_PKG points at an installed `openclaw` package dir, e.g.
//   OC_PKG=<workspace>/.tools/openclaw/node_modules/openclaw npm run test:real
// Needs python3 (or $PYTHON) for test/fixtures/stub_amp.py. Never touches ~/.openclaw:
// HOME and OPENCLAW_STATE_DIR point at a fresh temp dir.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const OC_PKG = process.env.OC_PKG;
const SKIP = OC_PKG ? false : 'set OC_PKG=<openclaw package dir> to run real-host tests';

// hostGate.blocked expected per mode on OpenClaw 2026.9.5.
const MODES = [
  { mode: 'allow', blocked: false },
  { mode: 'hitl_approve', blocked: false },
  { mode: 'hitl_reject', blocked: true },
  { mode: 'no_policy', blocked: true },
  { mode: 'policy_error', blocked: true },
  { mode: 'policy_error_200', blocked: true },
  { mode: 'down', blocked: true },
  { mode: 'garbage', blocked: true },
  { mode: 'hitl_modify', blocked: true },
  // A3: decision arrives after STUB_DECISION_DELAY_S (20 s) — past OpenClaw's 15 s default.
  { mode: 'hitl_slow', blocked: false },
];
const DECISION_DELAY_S = 20;
const PROBE_HOOK_TIMEOUT_MS = 5000;

// OpenClaw refuses plugin candidates under world-writable paths (path_world_writable);
// /mnt/c (NTFS via WSL) reports mode 777, so load a 755 copy from the temp dir instead.
function copyPluginTo(dest) {
  fs.cpSync(path.resolve(HERE, '..', 'plugin'), dest, { recursive: true });
  const fix = (p) => {
    const st = fs.statSync(p);
    fs.chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) fix(path.join(p, f));
  };
  fix(dest);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function waitForStub(url) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${url}/__health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`stub_amp.py did not come up at ${url}`);
}

const runNode = (script, args, env) => new Promise((resolve, reject) => {
  execFile(process.execPath, [path.join(FIX, script), ...args], { env, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 },
    (err, stdout, stderr) => (err
      ? reject(new Error(`${script} failed (exit ${err.code}): ${err.message}\nstderr: ${stderr}\nstdout: ${String(stdout).slice(0, 4000)}`))
      : resolve(stdout)));
});

describe('real OpenClaw host', { skip: SKIP }, () => {
  let tmp; let stub; let env; let toolReport; let probeReport; let abortReport;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-oc-real-'));
    const port = await freePort();
    const stubUrl = `http://127.0.0.1:${port}`;
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(path.join(stateDir, 'hooks', 'amp'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'home'));
    const pluginDir = path.join(tmp, 'plugin-copy');
    copyPluginTo(pluginDir);
    fs.writeFileSync(path.join(stateDir, 'hooks', 'amp', 'amp_config.json'), JSON.stringify({
      AMP_BACKEND_URL: stubUrl, AMP_API_KEY: 'amp_k_test', AMP_ORG_ID: 'O-1',
      AGENT_NAME: 'test-agent', AMP_USERNAME: 't@e.c', HITL_TIMEOUT_MINUTES: 1, HITL_POLL_INTERVAL_MS: 500,
    }));
    env = {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'), // absent -> driver synthesizes config
      STUB_URL: stubUrl,
      STUB_LOG: path.join(tmp, 'stub_requests.jsonl'),
      PLUGIN_DIR: pluginDir,
    };
    stub = spawn(process.env.PYTHON || 'python3', [path.join(FIX, 'stub_amp.py')], {
      env: { ...env, STUB_PORT: String(port), STUB_DECISION_DELAY_S: String(DECISION_DELAY_S) }, stdio: 'ignore',
    });
    await waitForStub(stubUrl);
    const out = path.join(tmp, 'tool-result.json');
    await runNode('drive_tool_call.mjs', ['--modes', MODES.map((m) => m.mode).join(','), '--out', out], env);
    toolReport = JSON.parse(fs.readFileSync(out, 'utf8'));

    // Hook-budget probe: an operator override shortens the hook to 5 s. OpenClaw never aborts
    // ctx.abortSignal on hook timeout, so the plugin must finish first with its own block.
    const defaultCfg = path.join(tmp, 'openclaw-default.json');
    fs.writeFileSync(defaultCfg, JSON.stringify({ plugins: { load: { paths: [pluginDir] }, entries: {
      'amp-governance': { enabled: true } } } }));
    const probeCfg = path.join(tmp, 'openclaw-probe.json');
    fs.writeFileSync(probeCfg, JSON.stringify({ plugins: { load: { paths: [pluginDir] }, entries: {
      'amp-governance': { enabled: true, hooks: { timeouts: { before_tool_call: PROBE_HOOK_TIMEOUT_MS } } } } } }));
    const runProbe = async (name, extraArgs, cfgPath = probeCfg) => {
      const out = path.join(tmp, `${name}-result.json`);
      const state = path.join(tmp, `state-${name}`); // fresh state -> fresh AMP instance per probe
      fs.cpSync(stateDir, state, { recursive: true });
      for (const f of ['plugin-session.json', 'hook-session.json']) fs.rmSync(path.join(state, 'hooks', 'amp', f), { force: true });
      await runNode('drive_tool_call.mjs', ['--modes', 'hitl_slow', '--signal', ...extraArgs, '--out', out],
        { ...env, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: cfgPath });
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    };
    probeReport = await runProbe('probe', []);
    // Abort probe: no override; the caller (run) aborts 2 s into a 20 s review -> the plugin
    // must see ctx.abortSignal, block as cancelled and stop polling.
    abortReport = await runProbe('abort', ['--abort-after-ms', '2000'], defaultCfg);
  });

  after(() => {
    stub?.kill();
    // Optional evidence export: AMP_REAL_REPORT_DIR=<dir> keeps the driver reports.
    const keep = process.env.AMP_REAL_REPORT_DIR;
    if (keep && tmp) {
      fs.mkdirSync(keep, { recursive: true });
      for (const f of ['tool-result.json', 'probe-result.json', 'abort-result.json', 'hook-result.json']) {
        const src = path.join(tmp, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(keep, f));
      }
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('plugin loads and registers before_tool_call', () => {
    assert.equal(toolReport.steps.load?.status, 'loaded', JSON.stringify(toolReport.steps.load));
    assert.ok(toolReport.steps.typedHooks.includes('before_tool_call'));
  });

  // Codex #7: the real tool wrapper is required — a missing wrapper must fail, never skip.
  test('the real tool wrapper (wrapToolWithBeforeToolCallHook) was found', () => {
    assert.ok(toolReport.steps.wrapChunk, JSON.stringify(toolReport.steps.wrapChunk));
    assert.ok(toolReport.steps.gateChunk, JSON.stringify(toolReport.steps.gateChunk));
  });

  for (const { mode, blocked } of MODES) {
    test(`${mode}: host gate blocked=${blocked}, wrapped tool executed=${!blocked}`, () => {
      const r = toolReport.modes[mode];
      assert.ok(r?.hostGate && !r.hostGate.threw, JSON.stringify(r?.hostGate));
      assert.equal(r.hostGate.blocked ?? false, blocked, JSON.stringify(r.hostGate));
      assert.ok(r.wrappedTool, `no wrapped-tool run for ${mode}`);
      assert.equal(r.wrappedTool.executed, !blocked, JSON.stringify(r.wrappedTool));
    });
  }

  // The stub's HITL request is id-less like production (H3): the plugin learns its work
  // item from the first (pending) poll and only then accepts that work item's decision.
  for (const mode of ['hitl_approve', 'hitl_reject', 'hitl_modify']) {
    test(`${mode}: id-less request, decision taken from the second poll`, () => {
      const polls = toolReport.modes[mode].stubDuringHostGate.filter((l) => l.startsWith('GET /api/hitl/get-decision'));
      assert.equal(polls.length, 2, JSON.stringify(toolReport.modes[mode].stubDuringHostGate));
    });
  }

  test('A3: plugin timeoutMs is honoured — a 20 s review approves past the 15 s default', () => {
    const r = toolReport.modes.hitl_slow;
    assert.equal(r.hostGate.blocked ?? false, false, JSON.stringify(r.hostGate));
    assert.ok(r.hostGateMs >= DECISION_DELAY_S * 1000 && r.hostGateMs < 30_000, `hostGateMs=${r.hostGateMs}`);
  });

  test('A3: a 5 s operator hook timeout gets the plugin\'s own block first, 0 polls after', () => {
    const r = probeReport.modes.hitl_slow;
    assert.equal(r.hostGate.blocked, true, JSON.stringify(r.hostGate));
    assert.equal(r.hostGate.kind, 'veto', JSON.stringify(r.hostGate)); // plugin block, not a host timeout
    assert.match(r.hostGate.reason || r.hostGate.deniedReason || '', /OpenClaw hook budget/, JSON.stringify(r.hostGate));
    assert.ok(r.hostGateMs < PROBE_HOOK_TIMEOUT_MS, `hostGateMs=${r.hostGateMs}`);
    assert.equal(r.pollsAfterHostGate, 0, `pollsAfterHostGate=${r.pollsAfterHostGate}`);
  });

  test('A3: the plugin receives ctx.abortSignal and stops polling when the run aborts', () => {
    const r = abortReport.modes.hitl_slow;
    assert.equal(r.callerSignalAborted, true);
    assert.equal(r.hostGate.blocked, true, JSON.stringify(r.hostGate));
    assert.equal(r.hostGate.kind, 'veto', JSON.stringify(r.hostGate));
    assert.match(r.hostGate.reason || r.hostGate.deniedReason || '', /cancelled/, JSON.stringify(r.hostGate));
    assert.ok(r.hostGateMs < DECISION_DELAY_S * 1000, `hostGateMs=${r.hostGateMs}`);
    assert.equal(r.pollsAfterHostGate, 0, `pollsAfterHostGate=${r.pollsAfterHostGate}`);
  });

  test('internal hook loads without error', async () => {
    const out = path.join(tmp, 'hook-result.json');
    await runNode('drive_hook.mjs', ['--with-home-config', '--out', out], env);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.loadError, undefined, report.loadError);
  });
});
