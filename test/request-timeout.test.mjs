// Re-review finding 2: every AMP request is bounded by the call's remaining
// budget (and AMP_REQUEST_TIMEOUT_MS, default 15 s), and the poll sleep never
// runs past the call's deadline. A slow backend must not hold the hook — and
// the instance lock — past the HITL window.
//
// Default test config: 50 ms poll interval inside a 3 s HITL window; each case
// sets AMP_REQUEST_TIMEOUT_MS to 200 ms and delays a stub answer well past it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];
const ok = (body) => ({ status: 200, body });
const HUNG = 5000; // longer than the 3 s HITL window

async function withPlugin(t, config, fn) {
  const p = await loadPlugin({ mode: 'allow', config: { AMP_REQUEST_TIMEOUT_MS: 200, ...config } });
  t.after(() => p.cleanup());
  return fn(p);
}

const exec = (p, ctx) => p.callTool('exec', { command: 'echo hi' }, ctx);

describe('per-request timeouts', () => {
  test('a slow /api/hitl/request blocks the call (not reported as cancelled)', (t) => withPlugin(t, {}, async (p) => {
    p.stub.script('POST /api/hitl/request', [{ ...ok({ status: 'no-hitl' }), delayMs: HUNG }]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.doesNotMatch(res.blockReason, /cancel/i);
    assert.match(res.blockReason, /did not answer/);
  }));

  test('caller abort during /api/hitl/request is reported as cancelled', (t) => withPlugin(t, {}, async (p) => {
    p.stub.script('POST /api/hitl/request', [{ ...ok({ status: 'no-hitl' }), delayMs: HUNG }]);
    const ac = new AbortController();
    const pending = exec(p, { abortSignal: ac.signal });
    for (let i = 0; i < 500 && p.stub.count('POST', '/api/hitl/request') < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    const res = await pending;
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /cancelled/);
  }));

  test('a hung get-decision is retried; the next poll\'s approval allows', (t) => withPlugin(t, {}, async (p) => {
    p.stub.script('POST /api/hitl/request', [ok({ status: 'pending', workitem_id: 'wi-1' })]);
    p.stub.script('GET /api/hitl/get-decision', [
      { ...ok({ status: 'pending', workitem_id: 'wi-1' }), delayMs: HUNG },
      ok({ status: 'complete', resolution: 'approve', workitem_id: 'wi-1' }),
    ]);
    assert.deepEqual(await exec(p), {});
    assert.equal(p.stub.count(...DECISION), 2);
  }));

  test('a hung /api/agent/init blocks the call', (t) => withPlugin(t, {}, async (p) => {
    p.stub.script('POST /api/agent/init', [{ ...ok({ instance_id: 'inst-slow' }), delayMs: HUNG }]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /unreachable/);
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
  }));

  test('slow /api/log calls are cut off and never block an allowed call', { timeout: 30000 }, (t) => withPlugin(t, {}, async (p) => {
    p.stub.script('POST /api/log', [{ ...ok({ ok: true }), delayMs: HUNG }]);
    const started = Date.now();
    assert.deepEqual(await exec(p), {});
    // 3 sequential logs at 5 s each would take >= 15 s unbounded.
    assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
  }));
});

describe('poll sleep is capped by the call deadline', () => {
  test('a 10-minute poll interval cannot outlive a 0.6 s HITL window', { timeout: 20000 }, (t) => withPlugin(t, {
    HITL_TIMEOUT_MINUTES: 0.01,
    HITL_POLL_INTERVAL_MS: 600000,
  }, async (p) => {
    p.stub.script('POST /api/hitl/request', [ok({ status: 'pending', workitem_id: 'wi-1' })]);
    p.stub.script('GET /api/hitl/get-decision', [ok({ status: 'pending', workitem_id: 'wi-1' })]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /timed out/);
    // One 600 s sleep would hang the test; the capped sleep ends at the deadline
    // (a timer may fire a ms early, allowing at most one last poll).
    assert.ok(p.stub.count(...DECISION) <= 1, `polls: ${p.stub.count(...DECISION)}`);
  }));
});
