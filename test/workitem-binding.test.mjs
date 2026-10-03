// Tier 1: K2 / H3 / L16 — a governed call only accepts the HITL decision for
// the work item it is waiting on. get-decision is instance-scoped and returns
// the newest resolved work item, so without this guard a call can be allowed
// by a previous call's approval.
//
// Default test config: 50 ms poll interval inside a 3 s HITL window.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

  test('first call on a fresh instance does not accept an id-less decision (times out, blocks)', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [done('approve', null)]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /timed out/);
    assert.ok(p.stub.count(...DECISION) > 1);
  }));

  test('after a restart the stale decision of the restored instance is never accepted', (t) => withPlugin(t, async (p) => {
    fs.writeFileSync(
      path.join(p.stateDir, 'hooks', 'amp', 'plugin-session.json'),
      JSON.stringify({ instanceId: 'inst-old', writer: 'plugin' }),
    );
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [
      done('approve', 'wi-old'),
      pending('wi-2'),
      done('reject', 'wi-2'),
    ]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.equal(p.stub.count('POST', '/api/agent/init'), 0, 'restored instance must be reused');
    assert.equal(p.stub.requests((r) => r.path === '/api/hitl/request')[0].body.instance_id, 'inst-old');
    assert.equal(p.stub.count(...DECISION), 3);
  }));

  test('unbound terminal ids are remembered and never accepted later', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [
      done('approve', 'wi-old'),
      pending('wi-old'),
      pending('wi-2'),
      done('reject', 'wi-2'),
    ]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
  }));

  test('request response with an already-seen workitem_id does not bind the call', (t) => withPlugin(t, async (p) => {
    await approvedFirstCall(p);
    p.stub.script('POST /api/hitl/request', [pending('wi-1')]);
    p.stub.script('GET /api/hitl/get-decision', [
      done('approve', 'wi-1'),
      pending('wi-2'),
      done('reject', 'wi-2'),
    ]);
    const res = await exec(p);
    assert.equal(res?.block, true, `must not allow: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
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

/** Poll (no fixed sleep) until pred() is truthy; fails after maxPolls checks. */
async function waitFor(pred, what, maxPolls = 500) {
  for (let i = 0; i < maxPolls; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Index in the stub log of every request matching method + path. */
const indexesOf = (p, method, urlPath) => p.stub.requests()
  .map((r, i) => (r.method === method && r.path === urlPath ? i : -1))
  .filter((i) => i >= 0);

const policyChecks = (p) => p.stub.requests((r) => r.path === '/api/log'
  && /^Policy check:/.test(r.body?.message || '')).length;

describe('C10 — one AMP review at a time per instance', () => {
  test('two concurrent unbound calls are serialized and cannot cross-bind', (t) => withPlugin(t, async (p) => {
    await approvedFirstCall(p); // warm the instance so both calls share it
    const base = p.stub.requests().length;
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [pending('wi-X'), done('approve', 'wi-X')]);
    const results = await Promise.all([exec(p), exec(p)]);
    const allowed = results.filter((r) => r && Object.keys(r).length === 0);
    assert.ok(allowed.length <= 1, `at most one call may run: ${JSON.stringify(results)}`);
    const reqs = indexesOf(p, 'POST', '/api/hitl/request').filter((i) => i >= base);
    const polls = indexesOf(p, ...DECISION).filter((i) => i >= base);
    assert.equal(reqs.length, 2);
    const approveIdx = polls[1]; // second poll of the run answered approve wi-X
    assert.ok(reqs[1] > approveIdx,
      `second /api/hitl/request (#${reqs[1]}) must follow the first call's decision poll (#${approveIdx})`);
  }));

  test('a no-hitl call behind a pending review completes after it', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending('wi-1'), ok({ status: 'no-hitl' })]);
    p.stub.script('GET /api/hitl/get-decision', [pending('wi-1'), pending('wi-1'), done('approve', 'wi-1')]);
    const first = exec(p);
    await waitFor(() => p.stub.count('POST', '/api/hitl/request') >= 1, 'first request');
    const second = exec(p);
    assert.deepEqual(await first, {});
    assert.deepEqual(await second, {});
    const reqs = indexesOf(p, 'POST', '/api/hitl/request');
    const polls = indexesOf(p, ...DECISION);
    assert.equal(reqs.length, 2);
    assert.equal(polls.length, 3);
    assert.ok(reqs[1] > polls[2], 'no-hitl request must wait for the pending review to finish');
  }));

  test('a call aborted while waiting for the instance blocks without a request', (t) => withPlugin(t, async (p) => {
    p.stub.script('POST /api/hitl/request', [pending('wi-1'), pending(null)]);
    p.stub.script('GET /api/hitl/get-decision', [pending('wi-1')]);
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const first = p.callTool('exec', { command: 'echo 1' }, { abortSignal: ac1.signal });
    await waitFor(() => p.stub.count(...DECISION) >= 1, 'first call polling');
    const second = p.callTool('exec', { command: 'echo 2' }, { abortSignal: ac2.signal });
    await waitFor(() => policyChecks(p) >= 2, 'second call policy check');
    ac2.abort();
    const res2 = await second;
    assert.equal(res2?.block, true, JSON.stringify(res2));
    assert.match(res2.blockReason, /another AMP review is in progress for this agent instance/);
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 1, 'aborted waiter must not send a request');
    ac1.abort();
    const res1 = await first;
    assert.equal(res1?.block, true);
  }));
});
