// Tier 1: before_tool_call governance decisions against the in-process stub.
// Non-todo tests pin today's behaviour; `todo` tests are the target behaviour
// for spec items A1 (fail closed on policy_error/unknown/null bodies),
// A2 (block modify until params can be applied) and A3 (honour poll interval).
//
// Until A3 lands index.js polls every 3000 ms (hard-coded), so each HITL case
// here costs ~3 s: HITL_TIMEOUT_MINUTES 0.05 (= 3 s) allows exactly one poll.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];

async function withPlugin(t, mode, fn) {
  const p = await loadPlugin({ mode });
  t.after(() => p.cleanup());
  return fn(p);
}

async function outcome(p) {
  try {
    const res = await p.callTool('exec', { command: 'echo hi' });
    if (res && res.block === true) return { kind: 'block', res };
    if (res && typeof res === 'object' && Object.keys(res).length === 0) return { kind: 'allow', res };
    return { kind: 'other', res };
  } catch (err) {
    return { kind: 'threw', error: String(err?.message || err) };
  }
}

describe('checkToolPolicy — current behaviour', () => {
  test('no-hitl allows', (t) => withPlugin(t, 'allow', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 1);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('no_policy blocks', (t) => withPlugin(t, 'no_policy', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /no active governance policy/);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('policy_error (HTTP 500) blocks', (t) => withPlugin(t, 'policy_error', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /unreachable/);
  }));

  test('backend down blocks', (t) => withPlugin(t, 'down', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /unreachable/);
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
  }));

  test('pending -> approve allows', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count(...DECISION), 1);
  }));

  test('pending -> reject blocks with reviewer note', (t) => withPlugin(t, 'hitl_reject', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.match(res.blockReason, /stub reviewer says no/);
  }));

  test('sends the configured API key on every AMP call', (t) => withPlugin(t, 'allow', async (p) => {
    await p.callTool('exec', { command: 'echo hi' });
    const reqs = p.stub.requests();
    assert.ok(reqs.length >= 3, `expected init + log + request, got ${reqs.length}`);
    for (const r of reqs) assert.equal(r.headers['x-api-key'], 'amp_k_test', `${r.method} ${r.path}`);
  }));
});

describe('checkToolPolicy — A1/A2 target behaviour', () => {
  test('policy_error 200 blocks and surfaces backend message', { todo: 'A1' }, (t) => withPlugin(t, 'policy_error_200', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /Missing field\(s\): who/);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('unknown status blocks', { todo: 'A1' }, (t) => withPlugin(t, 'garbage', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /banana/);
  }));

  test('null / non-object body blocks', { todo: 'A1' }, (t) => withPlugin(t, 'null_body', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
  }));

  test('modify resolution blocks (no params applied)', { todo: 'A2' }, (t) => withPlugin(t, 'hitl_modify', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.equal(Object.hasOwn(res, 'params'), false);
  }));
});

// Every named stub mode with its expected outcome. todo = the item that makes it true.
const MATRIX = [
  { mode: 'allow', expect: 'allow' },
  { mode: 'no_policy', expect: 'block' },
  { mode: 'policy_error', expect: 'block' },
  { mode: 'policy_error_200', expect: 'block', todo: 'A1' },
  { mode: 'garbage', expect: 'block', todo: 'A1' },
  { mode: 'null_body', expect: 'block', todo: 'A1' },
  { mode: 'down', expect: 'block' },
  { mode: 'hitl_approve', expect: 'allow' },
  { mode: 'hitl_reject', expect: 'block' },
  { mode: 'hitl_modify', expect: 'block', todo: 'A2' },
  { mode: 'hitl_cancelled', expect: 'block' },
  // 2 pending polls then approve: needs the 50 ms poll interval (A3) to fit the 3 s timeout.
  { mode: 'hitl_slow', expect: 'allow', todo: 'A3' },
  { mode: 'poll429', expect: 'block' },
];

describe('modes matrix', () => {
  for (const { mode, expect, todo } of MATRIX) {
    test(`${mode} -> ${expect}`, todo ? { todo } : {}, (t) => withPlugin(t, mode, async (p) => {
      const got = await outcome(p);
      assert.equal(got.kind, expect, `mode ${mode}: ${JSON.stringify(got)}`);
    }));
  }
});
