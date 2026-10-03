// Tier 1: A7 — HITL notifications go through the runtime outbound adapter.
// OpenClaw >= 2026.9 removed api.runtime.channel.slack/whatsapp; the plugin
// must use api.runtime.channel.outbound.loadAdapter(channelId).sendText(...)
// and keep the legacy calls only for older hosts. notifyUser is fire-and-forget:
// it must never change a tool call's outcome.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const CFG = Object.freeze({ marker: 'runtime-config' });

/** Poll (no fixed sleep) until pred() is truthy; fails after maxPolls checks. */
async function waitFor(pred, what, maxPolls = 500) {
  for (let i = 0; i < maxPolls; i++) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function outboundRuntime(calls, adapterFor) {
  return {
    config: { current: () => CFG },
    channel: {
      outbound: {
        async loadAdapter(channelId) {
          calls.push({ name: 'loadAdapter', args: [channelId] });
          return adapterFor(channelId);
        },
      },
    },
  };
}

const recordingAdapter = (calls) => () => ({
  async sendText(args) { calls.push({ name: 'sendText', args: [args] }); },
});

/** Cache a Slack sender, then make a HITL-approved call that notifies the user. */
async function approvedCallFromSlack(p) {
  await p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });
  return p.callTool('exec', { command: 'echo hi' });
}

async function withPlugin(t, options, fn) {
  const p = await loadPlugin({ mode: 'hitl_approve', ...options });
  t.after(() => p.cleanup());
  return fn(p);
}

describe('A7 — notifyUser via runtime outbound adapter', () => {
  test('uses outbound.loadAdapter when present', (t) => {
    const calls = [];
    return withPlugin(t, { runtime: outboundRuntime(calls, recordingAdapter(calls)) }, async (p) => {
      assert.deepEqual(await approvedCallFromSlack(p), {});
      const sent = await waitFor(() => calls.find((c) => c.name === 'sendText'), 'sendText');
      assert.deepEqual(calls.find((c) => c.name === 'loadAdapter').args, ['slack']);
      const [args] = sent.args;
      assert.equal(args.to, 'channel:C1');
      assert.match(args.text, /^\[AMP\]/);
      assert.equal(args.cfg, CFG);
    });
  });

  test('falls back to legacy channel.slack on old runtimes', (t) => withPlugin(t, {}, async (p) => {
    assert.deepEqual(await approvedCallFromSlack(p), {});
    const sent = await waitFor(
      () => p.runtimeCalls.find((c) => c.name === 'slack.sendMessageSlack'),
      'slack.sendMessageSlack',
    );
    assert.equal(sent.args[0], 'channel:C1');
    assert.match(sent.args[1], /^\[AMP\]/);
  }));

  test('never throws when adapter missing', (t) => {
    const calls = [];
    return withPlugin(t, { runtime: outboundRuntime(calls, () => null) }, async (p) => {
      assert.deepEqual(await approvedCallFromSlack(p), {}, 'outcome unchanged');
      await waitFor(() => calls.filter((c) => c.name === 'loadAdapter').length >= 2, 'both notifications attempted');
      assert.equal(calls.some((c) => c.name === 'sendText'), false);
    });
  });

  test('never throws when loadAdapter rejects', (t) => {
    const calls = [];
    const runtime = outboundRuntime(calls, () => { throw new Error('boom'); });
    return withPlugin(t, { runtime }, async (p) => {
      assert.deepEqual(await approvedCallFromSlack(p), {}, 'outcome unchanged');
      await waitFor(() => calls.filter((c) => c.name === 'loadAdapter').length >= 2, 'both notifications attempted');
    });
  });

  test('rejected call stays blocked when the adapter is missing', (t) => {
    const calls = [];
    return withPlugin(t, { mode: 'hitl_reject', runtime: outboundRuntime(calls, () => null) }, async (p) => {
      const res = await approvedCallFromSlack(p);
      assert.equal(res.block, true);
    });
  });
});
