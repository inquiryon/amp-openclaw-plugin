// Tier 1: K2 / H3 / L16 — a governed call only accepts the HITL decision for
// the work item it is waiting on. get-decision is instance-scoped and returns
// the newest resolved work item, so without this guard a call can be allowed
// by a previous call's approval.
//
// Default test config: 50 ms poll interval inside a 3 s HITL window.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];
const ok = (body) => ({ status: 200, body });
const pending = (workitemId) => ok(workitemId ? { status: 'pending', workitem_id: workitemId } : { status: 'pending' });
const done = (resolution, workitemId) => ok(workitemId
  ? { status: 'complete', resolution, workitem_id: workitemId }
  : { status: 'complete', resolution });

async function withPlugin(t, fn) {
  const p = await loadPlugin({ mode: 'allow' });
  t.after(() => p.cleanup());
  return fn(p);
}

const exec = (p) => p.callTool('exec', { command: 'echo hi' });

/** Call 1 on the instance: pending wi-1, approved wi-1 -> allowed. */
async function approvedFirstCall(p) {
  p.stub.script('POST /api/hitl/request', [pending('wi-1')]);
  p.stub.script('GET /api/hitl/get-decision', [done('approve', 'wi-1')]);
  assert.deepEqual(await exec(p), {}, 'call 1 should be allowed');
}

describe('K2 — bind each call to its own work item', () => {
  test('second call ignores the previous call\'s approval and waits for its own work item', (t) => withPlugin(t, async (p) => {
    await approvedFirstCall(p);
    const before = p.stub.count(...DECISION);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [
      done('approve', 'wi-1'),
      pending('wi-2'),
      done('reject', 'wi-2'),
    ]);
    const res = await exec(p);
    assert.equal(res?.block, true, `call 2 must not be allowed: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.ok(p.stub.count(...DECISION) - before >= 3, 'wi-1 approval must have been skipped');
  }));

  test('bound call never accepts another work item\'s approval (times out, blocks)', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending('wi-2')]);
    p.stub.script('GET /api/hitl/get-decision', [done('approve', 'wi-1')]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /timed out/);
    assert.ok(p.stub.count(...DECISION) > 1);
    const warns = p.stub.requests((r) => r.path === '/api/log'
      && r.body?.level === 'WARN' && /ignoring decision for other workitem/.test(r.body.message));
    assert.equal(warns.length, 1, 'mismatch is logged once at WARN');
  }));

  test('bound call keeps polling on a complete body without workitem_id', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending('wi-1')]);
    p.stub.script('GET /api/hitl/get-decision', [done('approve', null), done('reject', 'wi-1')]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.equal(p.stub.count(...DECISION), 2);
  }));

  test('unbound call ignores an id-less decision once the instance has seen work items', (t) => withPlugin(t, async (p) => {
    await approvedFirstCall(p);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [
      done('approve', null),
      pending('wi-2'),
      done('reject', 'wi-2'),
    ]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
  }));

  test('first call on a fresh instance still accepts an id-less decision (legacy backend)', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [done('approve', null)]);
    assert.deepEqual(await exec(p), {});
    assert.equal(p.stub.count(...DECISION), 1);
  }));

  test('a cancelled body for another work item is ignored', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending('wi-2')]);
    p.stub.script('GET /api/hitl/get-decision', [
      ok({ status: 'cancelled', workitem_id: 'wi-1' }),
      done('reject', 'wi-2'),
    ]);
    const res = await exec(p);
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.equal(p.stub.count(...DECISION), 2);
  }));

  test('two concurrent calls never both accept the same approval', (t) => withPlugin(t, async (p) => {
    await approvedFirstCall(p); // warm the instance so both calls share it
    p.stub.script('POST /api/hitl/request', [pending('wi-A'), pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [done('approve', 'wi-A')]);
    const results = await Promise.all([exec(p), exec(p)]);
    const allowed = results.filter((r) => r && Object.keys(r).length === 0);
    const blocked = results.filter((r) => r?.block === true);
    assert.equal(allowed.length, 1, JSON.stringify(results));
    assert.equal(blocked.length, 1, JSON.stringify(results));
    assert.match(blocked[0].blockReason, /timed out/);
  }));
});
