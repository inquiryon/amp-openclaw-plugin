// A3: before_tool_call must request a host timeout that covers the HITL
// window, honour the configured poll interval, and stop polling when the
// run is cancelled (ctx.abortSignal). Assertions use stub request counts,
// never short wall-clock bounds (L3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(t, config, mode = 'allow') {
  const p = await loadPlugin({ mode, config });
  t.after(() => p.cleanup());
  return p;
}

async function waitForPolls(stub, n, capMs = 20_000) {
  const until = Date.now() + capMs;
  while (stub.count(...DECISION) < n) {
    if (Date.now() > until) throw new Error(`stub saw ${stub.count(...DECISION)} polls, wanted ${n}`);
    await delay(10);
  }
}

test('registers before_tool_call with timeoutMs = HITL + 30s', async (t) => {
  const p = await load(t, { HITL_TIMEOUT_MINUTES: 1 });
  assert.equal(p.opts.before_tool_call?.timeoutMs, 90_000);
});

test('invalid HITL_TIMEOUT_MINUTES falls back to 10 minutes', async (t) => {
  const p = await load(t, { HITL_TIMEOUT_MINUTES: 'abc' });
  assert.equal(p.opts.before_tool_call?.timeoutMs, 10 * 60_000 + 30_000);
});

test('HITL_POLL_INTERVAL_MS is honoured', async (t) => {
  // 5 pending polls then approve, all inside a 3 s HITL window: only fits at 50 ms.
  const p = await load(t, { HITL_TIMEOUT_MINUTES: 0.05, HITL_POLL_INTERVAL_MS: 50 });
  p.stub.setMode('hitl_slow', { pendingPolls: 5 });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.deepEqual(res, {});
  assert.equal(p.stub.count(...DECISION), 6);
});

test('poll stops when ctx.abortSignal aborts', async (t) => {
  const p = await load(t, { HITL_TIMEOUT_MINUTES: 0.2, HITL_POLL_INTERVAL_MS: 50 });
  p.stub.setMode('hitl_slow', { pendingPolls: Number.MAX_SAFE_INTEGER });
  const ac = new AbortController();
  const pending = p.callTool('exec', { command: 'echo hi' }, { abortSignal: ac.signal });
  await waitForPolls(p.stub, 2);
  ac.abort();
  const res = await pending;
  assert.equal(res?.block, true);
  assert.match(res.blockReason, /cancelled/);
  const seen = p.stub.count(...DECISION);
  await delay(500); // 10 poll intervals
  assert.equal(p.stub.count(...DECISION), seen, 'polling continued after abort');
});

test('already-aborted signal blocks without polling', async (t) => {
  const p = await load(t, { HITL_POLL_INTERVAL_MS: 50 }, 'hitl_approve');
  const ac = new AbortController();
  ac.abort();
  const res = await p.callTool('exec', { command: 'echo hi' }, { abortSignal: ac.signal });
  assert.equal(res?.block, true);
  assert.match(res.blockReason, /cancelled/);
  assert.equal(p.stub.count(...DECISION), 0);
});
