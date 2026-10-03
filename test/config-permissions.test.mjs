// Tier 1: LOW6 — amp_config.json holds the AMP API key, so it must not be
// group/world readable. `openclaw amp connect` writes it 0600 (also when it
// replaces an existing file), and register() repairs an existing file whose
// group/other bits are set (best-effort; a no-op on filesystems without modes).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

/**
 * Replaces fs.<name> (also for the plugin's `import * as fs`) for one test.
 * wrap(original) returns the replacement.
 */
function patchFs(t, name, wrap) {
  const original = fs[name];
  fs[name] = wrap(original);
  syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}

const dirEntries = (p) => fs.readdirSync(path.dirname(configPath(p))).sort();

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

  test('overwriting a 0644 config never writes the key into a group/other-readable file', async (t) => {
    const p = await loadPlugin();
    t.after(() => p.cleanup());
    fs.chmodSync(configPath(p), 0o644);
    const before = dirEntries(p);
    const exposed = [];
    patchFs(t, 'writeFileSync', (orig) => function (file, data, ...rest) {
      const out = orig.call(this, file, data, ...rest);
      if (typeof file === 'string' && String(data).includes('amp_k_secret') && (fs.statSync(file).mode & 0o077)) {
        exposed.push(`${file} ${(fs.statSync(file).mode & 0o777).toString(8)}`);
      }
      return out;
    });
    runConnect(p);
    assert.deepEqual(exposed, [], 'key written while group/other could read the file');
    assert.equal(JSON.parse(fs.readFileSync(configPath(p), 'utf8')).AMP_API_KEY, 'amp_k_secret');
    assert.equal(modeOf(configPath(p)).toString(8), '600');
    assert.deepEqual(dirEntries(p), before, 'no temp file left behind');
  });

  test('a failed replace leaves the old config and no temp file', async (t) => {
    const p = await loadPlugin();
    t.after(() => p.cleanup());
    const oldText = fs.readFileSync(configPath(p), 'utf8');
    const before = dirEntries(p);
    patchFs(t, 'renameSync', () => () => { throw new Error('stub rename failure'); });
    const prevExit = process.exitCode;
    try {
      const { program, actions } = fakeProgram();
      p.cliRegistrars[0].fn({ program });
      actions.connect({
        apiKey: 'amp_k_secret', orgId: 'O-1', username: 'u@e.c', agentName: 'a', backendUrl: 'http://127.0.0.1:1', hitlTimeout: '10',
      });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = prevExit;
    }
    assert.equal(fs.readFileSync(configPath(p), 'utf8'), oldText);
    assert.deepEqual(dirEntries(p), before, 'temp file removed');
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
