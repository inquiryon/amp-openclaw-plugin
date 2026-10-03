// A3 (OpenClaw half, operator override): when openclaw.json sets
// plugins.entries.amp-governance.hooks.timeouts.before_tool_call below the
// plugin's own budget, the plugin must finish first: block with its own
// message at min(HITL window, override - margin), stop polling and free the
// instance's review slot. Count-based asserts only (L3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const override = (hooks) => ({ plugins: { entries: { 'amp-governance': { enabled: true, hooks } } } });

async function load(t, { apiConfig, config, mode = 'hitl_slow' } = {}) {
  const p = await loadPlugin({ mode, apiConfig, config: { HITL_TIMEOUT_MINUTES: 1, HITL_POLL_INTERVAL_MS: 50, ...config } });
  t.after(() => p.cleanup());
  return p;
}

test('operator override shorter than the HITL window: plugin blocks first with its own message', { timeout: 20_000 }, async (t) => {
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 2000 } }) });
  p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.match(res.blockReason, /hooks\.timeouts\.before_tool_call/);
  const polls = p.stub.count(...DECISION);
  assert.ok(polls > 0 && polls < 100, `polls=${polls} (a full 60 s window would be ~1200)`);
  await delay(300);
  assert.equal(p.stub.count(...DECISION), polls, 'no polls after the plugin returned');
  // The instance review slot is free: the next call is evaluated at once.
  p.stub.setMode('allow');
  assert.deepEqual(await p.callTool('exec', { command: 'echo again' }), {});
});

test('hooks.timeoutMs is used when timeouts.before_tool_call is absent (host precedence)', { timeout: 20_000 }, async (t) => {
  const p = await load(t, { apiConfig: override({ timeoutMs: 2000 }) });
  p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.ok(p.stub.count(...DECISION) < 100);
});

test('register logs one error when the override is shorter than HITL + 30 s', async (t) => {
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 5000 } }) });
  assert.equal(p.loggerErrors.filter((m) => /hooks\.timeouts\.before_tool_call/.test(m)).length, 1, JSON.stringify(p.loggerErrors));
});

test('no error and no budget cut when the override covers HITL + 30 s', async (t) => {
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 600_000 } }), config: { HITL_TIMEOUT_MINUTES: 0.02 } });
  assert.deepEqual(p.loggerErrors, []);
  p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.match(res.blockReason, /timed out waiting for human approval/);
});

test('slow /api/log cannot carry the call past its hook budget', { timeout: 8_000 }, async (t) => {
  // Every log write hangs 30 s. Unbounded (15 s cap each) the call would need > 45 s;
  // bounded by the call budget it finishes well inside the 8 s test ceiling.
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 3000 } }) });
  p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
  p.stub.script('POST /api/log', [{ status: 200, body: { ok: true }, delayMs: 30_000 }]);
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
});

test('a policy check cut by the call budget is a budget block, not an AMP outage', { timeout: 10_000 }, async (t) => {
  // budget 1.5 s; /api/hitl/request answers after 4 s -> cut by the call deadline.
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 2000 } }), mode: 'allow' });
  p.stub.script('POST /api/hitl/request', [{ status: 200, body: { status: 'no-hitl' }, delayMs: 4000 }]);
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.doesNotMatch(res.blockReason, /did not answer|unreachable/);
});

test('an /api/agent/init cut by the call budget is a budget block, not an AMP outage', { timeout: 10_000 }, async (t) => {
  // budget 1.5 s; init answers after 4 s -> cut by the call deadline (W2).
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 2000 } }), mode: 'allow' });
  p.stub.script('POST /api/agent/init', [{ status: 200, body: { instance_id: 'inst-slow' }, delayMs: 4000 }]);
  await p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.doesNotMatch(res.blockReason, /unreachable/);
  await delay(200);
  const outage = p.runtimeCalls.filter((c) => /Unreachable/.test(JSON.stringify(c)));
  assert.deepEqual(outage, [], 'no outage notification for a budget miss');
  assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
});

// LOW5: the budget-cut checks used to compare Date.now() with the deadline when the
// request's timer fired. Timers run on the monotonic clock; the wall clock can lag it
// (loop-time caching, WSL clock drift), so the cut read as an outage ~1 in 10 runs.
// Step the wall clock back 200 ms once the request is on the wire to make that
// deterministic: the cut must still be recognised from the abort itself.
function stepWallClockBackOnce(t, p, routePath) {
  const realNow = Date.now;
  Date.now = () => realNow() - (p.stub.count('POST', routePath) > 0 ? 200 : 0);
  t.after(() => { Date.now = realNow; });
}

test('LOW5: a budget-cut /api/agent/init stays a budget block when the wall clock lags the timer', { timeout: 10_000 }, async (t) => {
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 2000 } }), mode: 'allow' });
  p.stub.script('POST /api/agent/init', [{ status: 200, body: { instance_id: 'inst-slow' }, delayMs: 4000 }]);
  stepWallClockBackOnce(t, p, '/api/agent/init');
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
});

test('LOW5: a budget-cut policy check stays a budget block when the wall clock lags the timer', { timeout: 10_000 }, async (t) => {
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 2000 } }), mode: 'allow' });
  p.stub.script('POST /api/hitl/request', [{ status: 200, body: { status: 'no-hitl' }, delayMs: 4000 }]);
  stepWallClockBackOnce(t, p, '/api/hitl/request');
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.doesNotMatch(res.blockReason, /did not answer|unreachable/);
});

test('budget too small to start a request blocks without an AMP outage', async (t) => {
  // override 400 -> budget 300 ms: below the 500 ms floor for /api/hitl/request.
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 400 } }), mode: 'allow' });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.equal(res.block, true);
  assert.match(res.blockReason, /OpenClaw hook budget/);
  assert.doesNotMatch(res.blockReason, /did not answer|unreachable/);
  assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
});

test('re-registering without the override restores the full HITL budget', async (t) => {
  // HITL 3 s; override 2000 cuts it to 1.5 s. After re-registering without it: full 3 s window.
  const p = await load(t, { apiConfig: override({ timeouts: { before_tool_call: 2000 } }), config: { HITL_TIMEOUT_MINUTES: 0.05 } });
  p.reregister({ config: undefined });
  p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
  const res = await p.callTool('exec', { command: 'echo hi' });
  assert.match(res.blockReason, /timed out waiting for human approval/);
});

for (const [name, hooks, budgetCut] of [
  ['both keys: timeouts.before_tool_call wins over timeoutMs', { timeouts: { before_tool_call: 2000 }, timeoutMs: 600_000 }, true],
  ['float override is floored and honoured', { timeouts: { before_tool_call: 2500.9 } }, true],
  ['zero override is ignored', { timeouts: { before_tool_call: 0 } }, false],
  ['Infinity override is ignored', { timeouts: { before_tool_call: Infinity } }, false],
  ['string "2000" override is ignored', { timeouts: { before_tool_call: '2000' } }, false],
  ['non-object hooks is ignored', 5, false],
  ['non-object timeouts is ignored', { timeouts: 'x' }, false],
]) {
  test(`parsing: ${name}`, { timeout: 20_000 }, async (t) => {
    const p = await load(t, { apiConfig: override(hooks), config: { HITL_TIMEOUT_MINUTES: 0.05 } });
    p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.match(res.blockReason, budgetCut ? /OpenClaw hook budget/ : /timed out waiting for human approval/);
  });
}

for (const [name, apiConfig] of [
  ['missing api.config', undefined],
  ['non-numeric override', override({ timeouts: { before_tool_call: 'abc' } })],
  ['negative override', override({ timeouts: { before_tool_call: -5 } })],
  ['malformed entries', { plugins: { entries: 'nope' } }],
]) {
  test(`${name} is ignored`, async (t) => {
    const p = await load(t, { apiConfig, config: { HITL_TIMEOUT_MINUTES: 0.02 } });
    assert.deepEqual(p.loggerErrors, []);
    p.stub.setMode('hitl_slow', { pendingPolls: 1_000_000 });
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.match(res.blockReason, /timed out waiting for human approval/);
  });
}
