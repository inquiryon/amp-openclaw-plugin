// Tier 1: LOW6 — amp_config.json holds the AMP API key, so it must not be
// group/world readable. `openclaw amp connect` writes it 0600 (also when it
// replaces an existing file), and register() repairs an existing file whose
// group/other bits are set (best-effort; a no-op on filesystems without modes).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlugin } from './helpers/load-plugin.mjs';

const configPath = (p) => path.join(p.stateDir, 'hooks', 'amp', 'amp_config.json');
const modeOf = (file) => fs.statSync(file).mode & 0o777;

/** Minimal commander stand-in: every builder method chains; .action() records the handler. */
function fakeProgram() {
  const actions = {};
  let current = null;
  const node = new Proxy({}, {
    get(_, prop) {
      if (prop === 'command') return (name) => { current = name; return node; };
      if (prop === 'action') return (fn) => { actions[current] = fn; return node; };
      return () => node;
    },
  });
  return { program: node, actions };
}

/** Runs `openclaw amp connect` with no `openclaw` on PATH: the config is written, then the hook step fails. */
function runConnect(p) {
  const { program, actions } = fakeProgram();
  p.cliRegistrars[0].fn({ program });
  const prevPath = process.env.PATH;
  const prevExit = process.exitCode;
  process.env.PATH = path.join(p.stateDir, 'no-such-bin');
  try {
    actions.connect({
      apiKey: 'amp_k_secret', orgId: 'O-1', username: 'u@e.c', agentName: 'a', backendUrl: 'http://127.0.0.1:1', hitlTimeout: '10',
    });
    assert.equal(process.exitCode, 1, 'hook enable must fail without openclaw on PATH');
  } finally {
    process.env.PATH = prevPath;
    process.exitCode = prevExit;
  }
}

describe('LOW6 — amp_config.json is owner-only', { skip: process.platform === 'win32' && 'POSIX modes only' }, () => {
  test('openclaw amp connect writes a new config 0600', async (t) => {
    const p = await loadPlugin();
    t.after(() => p.cleanup());
    fs.rmSync(configPath(p));
    runConnect(p);
    assert.equal(JSON.parse(fs.readFileSync(configPath(p), 'utf8')).AMP_API_KEY, 'amp_k_secret');
    assert.equal(modeOf(configPath(p)).toString(8), '600');
  });

  test('openclaw amp connect tightens an existing 0644 config to 0600', async (t) => {
    const p = await loadPlugin();
    t.after(() => p.cleanup());
    fs.chmodSync(configPath(p), 0o644);
    runConnect(p);
    assert.equal(modeOf(configPath(p)).toString(8), '600');
  });

  test('register repairs an existing 0644 config to 0600', async (t) => {
    const p = await loadPlugin();
    t.after(() => p.cleanup());
    fs.chmodSync(configPath(p), 0o644);
    p.reregister();
    assert.equal(modeOf(configPath(p)).toString(8), '600');
  });

  test('register leaves an owner-only config alone and tolerates a missing one', async (t) => {
    const p = await loadPlugin();
    t.after(() => p.cleanup());
    fs.chmodSync(configPath(p), 0o400);
    p.reregister();
    assert.equal(modeOf(configPath(p)).toString(8), '400');
    fs.rmSync(configPath(p));
    assert.doesNotThrow(() => p.reregister());
  });
});
