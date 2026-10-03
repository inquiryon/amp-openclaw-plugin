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
