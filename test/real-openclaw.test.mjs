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

// hostGate.blocked expected per mode on OpenClaw 2026.9.5. todo = item that fixes it.
const MODES = [
  { mode: 'allow', blocked: false },
  { mode: 'hitl_approve', blocked: false },
  { mode: 'hitl_reject', blocked: true },
  { mode: 'no_policy', blocked: true },
  { mode: 'policy_error', blocked: true },
  { mode: 'down', blocked: true },
  { mode: 'garbage', blocked: true, todo: 'A1' },
];

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
  execFile(process.execPath, [path.join(FIX, script), ...args], { env, maxBuffer: 32 * 1024 * 1024, timeout: 240_000 },
    (err, stdout, stderr) => (err ? reject(new Error(`${script} failed: ${err.message}\n${stderr}`)) : resolve(stdout)));
});

describe('real OpenClaw host', { skip: SKIP }, () => {
  let tmp; let stub; let env; let toolReport;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-oc-real-'));
    const port = await freePort();
    const stubUrl = `http://127.0.0.1:${port}`;
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(path.join(stateDir, 'hooks', 'amp'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'home'));
    fs.writeFileSync(path.join(stateDir, 'hooks', 'amp', 'amp_config.json'), JSON.stringify({
      AMP_BACKEND_URL: stubUrl, AMP_API_KEY: 'amp_k_test', AMP_ORG_ID: 'O-1',
      AGENT_NAME: 'test-agent', AMP_USERNAME: 't@e.c', HITL_TIMEOUT_MINUTES: 0.1,
    }));
    env = {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'), // absent -> driver synthesizes config
      STUB_URL: stubUrl,
      STUB_LOG: path.join(tmp, 'stub_requests.jsonl'),
    };
    stub = spawn(process.env.PYTHON || 'python3', [path.join(FIX, 'stub_amp.py')], {
      env: { ...env, STUB_PORT: String(port) }, stdio: 'ignore',
    });
    await waitForStub(stubUrl);
    const out = path.join(tmp, 'tool-result.json');
    await runNode('drive_tool_call.mjs', ['--modes', MODES.map((m) => m.mode).join(','), '--out', out], env);
    toolReport = JSON.parse(fs.readFileSync(out, 'utf8'));
  });

  after(() => {
    stub?.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('plugin loads and registers before_tool_call', () => {
    assert.equal(toolReport.steps.load?.status, 'loaded', JSON.stringify(toolReport.steps.load));
    assert.ok(toolReport.steps.typedHooks.includes('before_tool_call'));
  });

  for (const { mode, blocked, todo } of MODES) {
    test(`${mode}: host gate blocked=${blocked}`, todo ? { todo } : {}, () => {
      const r = toolReport.modes[mode];
      assert.equal(r?.hostGate?.blocked ?? false, blocked, JSON.stringify(r?.hostGate));
      if (r?.wrappedTool) assert.equal(r.wrappedTool.executed, !blocked, JSON.stringify(r.wrappedTool));
    });
  }

  test('internal hook loads without error', async () => {
    const out = path.join(tmp, 'hook-result.json');
    await runNode('drive_hook.mjs', ['--with-home-config', '--out', out], env);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.loadError, undefined, report.loadError);
  });
});
