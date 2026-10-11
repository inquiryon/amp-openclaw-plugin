// Tier 1: OC-4 / LOW1 — nothing on the before_tool_call path may hold the call
// (or the governance lock) on a side effect: user notifications are always
// fire-and-forget, and once the call's deadline has passed an AMP log write is
// fired without being awaited. Ported from the adversarial probes (scratchpad
// adv-oc/probe-hang); each probe asserted the call was held, these assert it is not.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

/** Outbound adapter whose sendText never settles (hung channel); records attempts. */
const hangingRuntime = (sends) => ({
  channel: {
    outbound: {
      loadAdapter: async () => ({ sendText: (args) => { sends.push(args.text); return new Promise(() => {}); } }),
    },
  },
});

async function setup(t, options) {
  const p = await loadPlugin(options);
  t.after(() => p.cleanup());
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  return { p, unhandled };
}

const fromSlack = (p) => p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });

/** Waits (no fixed sleep) until pred() is truthy. */
async function waitFor(pred, what, maxPolls = 500) {
  for (let i = 0; i < maxPolls; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// A held call never returns; the 10 s test timeout (> the 3 s call budget) is the failure.
describe('OC-4 — notifications never hold before_tool_call', () => {
  test('outage notification with a hung channel send', { timeout: 10_000 }, async (t) => {
    const sends = [];
    const { p, unhandled } = await setup(t, { mode: 'down', runtime: hangingRuntime(sends) });
    await fromSlack(p);
    const res = await p.callTool('exec', { command: 'x' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /unreachable/);
    await waitFor(() => sends.some((m) => /Unreachable/.test(m)), 'outage notification attempted');
    assert.deepEqual(unhandled.map(String), []);
  });

  test('recovery notification with a hung channel send', { timeout: 10_000 }, async (t) => {
    const sends = [];
    const { p, unhandled } = await setup(t, { mode: 'down', runtime: hangingRuntime(sends) });
    assert.equal((await p.callTool('exec', { command: 'x' })).block, true); // no sender yet: no notify
    await fromSlack(p);
    p.stub.setMode('allow');
    assert.deepEqual(await p.callTool('exec', { command: 'y' }), {});
    await waitFor(() => sends.some((m) => /Restored/.test(m)), 'recovery notification attempted');
    assert.deepEqual(unhandled.map(String), []);
  });

  test('config-missing notification with a hung channel send', { timeout: 10_000 }, async (t) => {
    const sends = [];
    const { p, unhandled } = await setup(t, { configText: '{not json', runtime: hangingRuntime(sends) });
    await fromSlack(p);
    const res = await p.callTool('exec', { command: 'x' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /not configured/);
    await waitFor(() => sends.some((m) => /Not Configured/.test(m)), 'config notification attempted');
    assert.equal(p.stub.requests().length, 0);
    assert.deepEqual(unhandled.map(String), []);
  });

  test('a hung notification never holds the governance lock for the next call', { timeout: 10_000 }, async (t) => {
    const sends = [];
    const { p } = await setup(t, { mode: 'hitl_reject', runtime: hangingRuntime(sends) });
    await fromSlack(p);
    assert.match((await p.callTool('exec', { command: 'one' })).blockReason, /rejected by a human reviewer/);
    p.stub.setMode('allow');
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
  });
});

describe('LOW1 — no awaited log after the call deadline', () => {
  test('small operator override + slow log sink: the plugin returns before the host timeout', { timeout: 15_000 }, async (t) => {
    const HOST_TIMEOUT_MS = 600; // plugin budget = 600 - min(5000, 25%) = 450 ms
    const { p } = await setup(t, {
      mode: 'allow',
      apiConfig: { plugins: { entries: { 'amp-governance': { hooks: { timeouts: { before_tool_call: HOST_TIMEOUT_MS } } } } } },
    });
    await p.callTool('exec', { command: 'warm' }); // instance init outside the measured call
    p.stub.script('POST /api/log', [{ status: 200, body: { ok: true }, delayMs: 5000 }]); // slow log sink
    const logsBefore = p.stub.count('POST', '/api/log');
    const t0 = Date.now();
    const res = await p.callTool('exec', { command: 'x' });
    const ms = Date.now() - t0;
    t.diagnostic(`returned at ${ms} ms`);
    assert.equal(res.block, true);
    assert.match(res.blockReason, /OpenClaw hook budget/);
    // Every log of the call was still sent (the post-deadline ones fire-and-forget) ...
    await waitFor(() => p.stub.count('POST', '/api/log') - logsBefore >= 3, 'the call\'s 3 log writes');
    // ... but only the pre-deadline one was waited on, and only up to the 450 ms budget.
    // The host's own timeout is the property under test, so this bound is that timeout
    // (the old 250 ms post-deadline floor per awaited log returned at ~950 ms).
    assert.ok(ms < HOST_TIMEOUT_MS, `returned at ${ms} ms (host timeout ${HOST_TIMEOUT_MS} ms)`);
  });
});
