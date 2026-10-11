// Tier 1: A6 / K3 — opt-in action_id correlation on /api/hitl/request and
// /api/hitl/get-decision. Default OFF: no action_id is sent at all.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body) => ({ status: 200, body });
const ON = { ACTION_ID_CORRELATION: true };

async function withPlugin(t, config, fn) {
  const p = await loadPlugin({ mode: 'allow', config });
  t.after(() => p.cleanup());
  return fn(p);
}

const hitlRequests = (p) => p.stub.requests((r) => r.method === 'POST' && r.path === '/api/hitl/request');
const polls = (p) => p.stub.requests((r) => r.method === 'GET' && r.path === '/api/hitl/get-decision');

describe('A6 — action_id correlation (ACTION_ID_CORRELATION: true)', () => {
  test('request and poll carry the toolCallId as action_id', (t) => withPlugin(t, ON, async (p) => {
    p.stub.script('POST /api/hitl/request', [ok({ status: 'pending', workitem_id: 'wi-1' })]);
    p.stub.script('GET /api/hitl/get-decision', [
      ok({ status: 'complete', resolution: 'approve', workitem_id: 'wi-1', action_id: 'tc-1' }),
    ]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(hitlRequests(p)[0].body.action_id, 'tc-1');
    assert.equal(polls(p)[0].query.action_id, 'tc-1');
  }));

  test('stale unscoped approval without action_id echo is not accepted', (t) => withPlugin(t, ON, async (p) => {
    p.stub.script('POST /api/hitl/request', [ok({ status: 'pending' })]);
    p.stub.script('GET /api/hitl/get-decision', [
      ok({ status: 'complete', resolution: 'approve', workitem_id: 'wi-OLD' }),
    ]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /echo/);
    assert.equal(p.stub.count(...DECISION), 1);
  }));

  test('watchdog blocks when no work item appears for the action', (t) => withPlugin(t, {
    ...ON, ACTION_ID_WATCHDOG_SECONDS: 0.3, HITL_POLL_INTERVAL_MS: 50, HITL_TIMEOUT_MINUTES: 1,
  }, async (p) => {
    p.stub.script('POST /api/hitl/request', [ok({ status: 'pending' })]);
    p.stub.script('GET /api/hitl/get-decision', [ok({ status: 'pending', action_id: 'tc-1' })]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true, `must block: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /action_id correlation/);
    const n = p.stub.count(...DECISION);
    assert.ok(n >= 1 && n < 100, `expected an early watchdog block, got ${n} polls`);
  }));

  test('falls back to a random UUID when the host omits toolCallId', (t) => withPlugin(t, ON, async (p) => {
    const res = await p.handlers.before_tool_call({ toolName: 'exec', params: { command: 'echo hi' } }, {});
    assert.deepEqual(res, {});
    assert.match(String(hitlRequests(p)[0].body.action_id), UUID_RE);
  }));
});

describe('A6 / K3 — flag off (default)', () => {
  test('sends no action_id on request or poll', (t) => withPlugin(t, {}, async (p) => {
    p.stub.script('POST /api/hitl/request', [ok({ status: 'pending', workitem_id: 'wi-1' })]);
    p.stub.script('GET /api/hitl/get-decision', [
      ok({ status: 'complete', resolution: 'approve', workitem_id: 'wi-1' }),
    ]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(Object.hasOwn(hitlRequests(p)[0].body, 'action_id'), false);
    assert.equal(Object.hasOwn(polls(p)[0].query, 'action_id'), false);
  }));

  for (const value of ['true', 1]) {
    test(`non-boolean ACTION_ID_CORRELATION ${JSON.stringify(value)} stays off`, (t) => withPlugin(t, { ACTION_ID_CORRELATION: value }, async (p) => {
      await p.callTool('exec', { command: 'echo hi' });
      assert.equal(Object.hasOwn(hitlRequests(p)[0].body, 'action_id'), false);
    }));
  }
});
