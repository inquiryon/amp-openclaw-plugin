// Tier 1: A13 — plugin/hook/handler.ts state isolation + correctness (#22/#23).
// The hook and index.js used to share /tmp/amp-session-state.json with different
// schemas, so either side could finalize the other's live AMP instance.
//
// handler.ts is imported directly (Node >= 22.18 type stripping).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStub } from './helpers/stub-server.mjs';
import { loadPlugin } from './helpers/load-plugin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(HERE, '../plugin/hook/handler.ts');
const LEGACY_SESSION_FILE = '/tmp/amp-session-state.json';

let caseCounter = 0;

const received = (messageId = 'm1') => ({
  type: 'message',
  action: 'received',
  context: { messageId, content: 'hi', from: 'u1', channelId: 'slack' },
});

const hookSessionFile = (stateDir) => path.join(stateDir, 'hooks', 'amp', 'hook-session.json');
const pluginSessionFile = (stateDir) => path.join(stateDir, 'hooks', 'amp', 'plugin-session.json');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function writeConfig(stateDir, stubUrl) {
  writeJson(path.join(stateDir, 'hooks', 'amp', 'amp_config.json'), {
    AMP_BACKEND_URL: stubUrl,
    AMP_API_KEY: 'amp_k_test',
    AMP_ORG_ID: 'O-1',
    AGENT_NAME: 'test-agent',
    AMP_USERNAME: 't@e.c',
  });
}

/** Set env for one case (HOME = empty temp dir, OPENCLAW_STATE_DIR = stateDir); restored by t.after. */
function isolateEnv(t, stateDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-oc-home-'));
  const saved = {
    HOME: process.env.HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
  };
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.CLAWDBOT_STATE_DIR;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
}

/** Fresh temp state dir + stub + env; config written unless withConfig is false. */
async function setup(t, { withConfig = true } = {}) {
  const stub = await startStub();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-oc-hook-'));
  isolateEnv(t, stateDir);
  if (withConfig) writeConfig(stateDir, stub.url);
  t.after(async () => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    await stub.close();
  });
  return { stub, stateDir };
}

const importHandler = async () => (await import(`${pathToFileURL(HANDLER).href}?case=${++caseCounter}`)).default;

const setStateFor = (stub, instanceId) => stub.requests(
  (r) => r.path === '/api/agent/setState' && r.body?.instance_id === instanceId,
);

function legacyFingerprint() {
  try { return fs.readFileSync(LEGACY_SESSION_FILE, 'utf8'); } catch { return null; }
}

describe('A13 — handler.ts state dir and config', () => {
  test('honours OPENCLAW_STATE_DIR', async (t) => {
    const { stub } = await setup(t);
    const handler = await importHandler();
    await handler(received());
    assert.equal(stub.count('POST', '/api/agent/init'), 1);
  });

  test('missing config does not throw at import', async (t) => {
    const { stub } = await setup(t, { withConfig: false });
    const handler = await importHandler();
    await handler(received());
    assert.equal(stub.requests().length, 0, 'no network when config is missing');
  });

  test('config is retried on the next event until it loads', async (t) => {
    const { stub, stateDir } = await setup(t, { withConfig: false });
    const handler = await importHandler();
    await handler(received('m1'));
    assert.equal(stub.requests().length, 0);
    writeConfig(stateDir, stub.url);
    await handler(received('m2'));
    assert.equal(stub.count('POST', '/api/agent/init'), 1);
  });
});

describe('A13 — handler.ts event filtering', () => {
  test('message:sent is not logged as User prompt', async (t) => {
    const { stub } = await setup(t);
    const handler = await importHandler();
    await handler({ type: 'message', action: 'sent', context: { messageId: 'm1', content: 'hi' } });
    const prompts = stub.requests((r) => r.path === '/api/log' && /User prompt/.test(r.body?.message ?? ''));
    assert.equal(prompts.length, 0);
    assert.equal(stub.count('POST', '/api/agent/init'), 0, 'an outbound reply must not init an instance');
  });
});

describe('A13 — session file ownership', () => {
  test('startup cleanup ignores plugin-owned session', async (t) => {
    const { stub, stateDir } = await setup(t);
    writeJson(pluginSessionFile(stateDir), { instanceId: 'inst-plugin', writer: 'plugin' });
    const handler = await importHandler();
    await handler(received());
    assert.equal(setStateFor(stub, 'inst-plugin').length, 0);
    assert.ok(fs.existsSync(pluginSessionFile(stateDir)), 'plugin session file left alone');
  });

  test('startup cleanup ignores an untagged hook-session record', async (t) => {
    const { stub, stateDir } = await setup(t);
    writeJson(hookSessionFile(stateDir), { instanceId: 'inst-untagged' });
    const handler = await importHandler();
    await handler(received());
    assert.equal(setStateFor(stub, 'inst-untagged').length, 0);
  });

  test('startup cleanup finalizes hook-owned orphan', async (t) => {
    const { stub, stateDir } = await setup(t);
    writeJson(hookSessionFile(stateDir), { instanceId: 'inst-hook-old', writer: 'hook', convKey: 'slack:u1' });
    const handler = await importHandler();
    await handler(received());
    const calls = setStateFor(stub, 'inst-hook-old');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.state, 'finished');
  });

  test('handler never reads the legacy /tmp session file', async (t) => {
    const before = legacyFingerprint();
    const { stub } = await setup(t);
    const handler = await importHandler();
    await handler(received());
    assert.equal(stub.count('POST', '/api/agent/setState'), 0, 'nothing to finalize in a fresh state dir');
    assert.equal(legacyFingerprint(), before, 'legacy /tmp file untouched');
  });

  test('index.js and handler use different files', async (t) => {
    const before = legacyFingerprint();
    const p = await loadPlugin({ mode: 'allow' });
    t.after(() => p.cleanup());
    // loadPlugin points OPENCLAW_STATE_DIR at p.stateDir; the handler reads the same config.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-oc-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    assert.deepEqual(await p.callTool('exec', { command: 'echo hi' }), {});
    const handler = await importHandler();
    await handler(received());

    const hookFile = hookSessionFile(p.stateDir);
    const pluginFile = pluginSessionFile(p.stateDir);
    assert.notEqual(hookFile, pluginFile);
    const hookRec = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
    const pluginRec = JSON.parse(fs.readFileSync(pluginFile, 'utf8'));
    assert.equal(hookRec.writer, 'hook');
    assert.equal(pluginRec.writer, 'plugin');
    assert.notEqual(hookRec.instanceId, pluginRec.instanceId);
    assert.equal(setStateFor(p.stub, pluginRec.instanceId).length, 0, 'hook must not finalize the plugin instance');
    assert.equal(legacyFingerprint(), before, 'legacy /tmp file untouched');
  });
});

describe('A13 — index.js session file', () => {
  test('plugin ignores an untagged plugin-session record', async (t) => {
    const p = await loadPlugin({ mode: 'allow' });
    t.after(() => p.cleanup());
    writeJson(pluginSessionFile(p.stateDir), { instanceId: 'inst-untagged' });
    assert.deepEqual(await p.callTool('exec', { command: 'echo hi' }), {});
    assert.equal(p.stub.count('POST', '/api/agent/init'), 1);
    assert.ok(p.stub.requests((r) => r.body?.instance_id === 'inst-untagged').length === 0);
  });

  // Read-only against the real file: it is only used when a previous install left one behind.
  const legacy = (() => {
    try { return JSON.parse(fs.readFileSync(LEGACY_SESSION_FILE, 'utf8')); } catch { return null; }
  })();
  const skip = legacy?.instanceId ? false : `no ${LEGACY_SESSION_FILE} with an instanceId on this machine; test never creates one`;

  test('legacy /tmp session file is ignored', { skip }, async (t) => {
    const before = legacyFingerprint();
    const p = await loadPlugin({ mode: 'allow' });
    t.after(() => p.cleanup());
    assert.deepEqual(await p.callTool('exec', { command: 'echo hi' }), {});
    assert.equal(p.stub.count('POST', '/api/agent/init'), 1, 'plugin creates its own instance');
    assert.equal(p.stub.requests((r) => r.body?.instance_id === legacy.instanceId).length, 0);
    assert.equal(legacyFingerprint(), before, 'legacy /tmp file untouched');
  });
});
