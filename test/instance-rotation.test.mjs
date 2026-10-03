// Tier 1: K2.3 — instance rotation (OC-1/2/3). get-decision is scoped by
// caller_id (= the plugin's AMP instance) and returns that instance's newest
// work item. A call that ends without accepting the decision for its own work
// item may leave a work item behind (request landed, review created later); a
// later call on the same instance could bind it and run on its approval. So
// such a call retires its instance (setState finished, fire-and-forget) and
// the next call starts a fresh one. A process never reuses a persisted
// instance either, so restarts and two processes on one state dir never share
// a caller_id.
//
// Ported from the adversarial probes (scratchpad adv-oc/probe-binding); each
// probe asserted the unsafe outcome, these assert the safe one. The stub
// answers get-decision per caller_id, like the real backend.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlugin } from './helpers/load-plugin.mjs';

const ok = (body) => ({ status: 200, body });
const pending = (id) => ok(id ? { status: 'pending', workitem_id: id } : { status: 'pending' });
const done = (resolution, id) => ok({ status: 'complete', resolution, workitem_id: id, method: 'human' });
const idless = (extra) => ok({ status: 'complete', workitem_id: '', ...extra });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, extra = {}) {
  const p = await loadPlugin({ mode: 'allow', ...extra });
  t.after(() => p.cleanup());
  return p;
}

/** Answers get-decision per caller_id from `byCaller(callerId, nthPollOfThatCaller)`. */
function scopeDecisions(p, byCaller) {
  const polls = new Map();
  p.stub.respond('GET /api/hitl/get-decision', (req) => {
    const cid = req.query.caller_id;
    polls.set(cid, (polls.get(cid) ?? 0) + 1);
    return byCaller(cid, polls.get(cid));
  });
}

const requestsOf = (p) => p.stub.requests((r) => r.path === '/api/hitl/request');
const pollCallers = (p, from = 0) => p.stub.requests((r) => r.path === '/api/hitl/get-decision')
  .slice(from).map((r) => r.query.caller_id);
const finished = (p, id) => p.stub.requests((r) => r.path === '/api/agent/setState'
  && r.body?.instance_id === id && r.body?.state === 'finished');
const inits = (p) => p.stub.count('POST', '/api/agent/init');

/** Waits (no fixed sleep) until pred() is truthy. */
async function waitFor(pred, what, maxPolls = 500) {
  for (let i = 0; i < maxPolls; i++) {
    if (pred()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * Backend model for the late-work-item probes: inst-1's work item wi-A (call A,
 * "ls /tmp") only shows up once call A has ended; any other instance has its
 * own work item wi-B, which the reviewer rejects.
 */
function lateWorkitemBackend(p, firstPolls) {
  let aEnded = false;
  let late = 0; // inst-1 polls since A ended: wi-A pending, then approved
  scopeDecisions(p, (cid, n) => {
    if (cid === 'inst-1') {
      if (!aEnded) return firstPolls(n);
      return ++late === 1 ? pending('wi-A') : done('approve', 'wi-A');
    }
    return n === 1 ? pending('wi-B') : done('reject', 'wi-B');
  });
  return () => { aEnded = true; };
}

async function assertCallBSafe(p, polledBefore) {
  const b = await p.callTool('exec', { command: 'rm -rf /important' });
  assert.equal(b?.block, true, `B must not run on A's approval: ${JSON.stringify(b)}`);
  assert.match(b.blockReason, /rejected by a human reviewer/);
  const bReq = requestsOf(p).at(-1);
  assert.notEqual(bReq.body.caller_id, 'inst-1', 'B must not reuse the retired instance');
  assert.ok(pollCallers(p, polledBefore).every((c) => c !== 'inst-1'), 'B never polls inst-1');
  await waitFor(() => finished(p, 'inst-1').length === 1, 'setState finished for inst-1');
}

describe('K2.3 — a call that ends without its decision retires the instance', () => {
  test('unverifiable id-less decision: the next call never binds the late work item', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    const aEnded = lateWorkitemBackend(p, () => idless({ method: 'auto', resolution: 'approve' }));
    const a = await p.callTool('exec', { command: 'ls /tmp' });
    assert.equal(a.block, true);
    aEnded();
    await assertCallBSafe(p, p.stub.count('GET', '/api/hitl/get-decision'));
  });

  test('run aborted while unbound: the next call never binds the late work item', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    const aEnded = lateWorkitemBackend(p, () => pending(null));
    const ac = new AbortController();
    const aP = p.callTool('exec', { command: 'ls /tmp' }, { abortSignal: ac.signal });
    await waitFor(() => p.stub.count('GET', '/api/hitl/get-decision') >= 1, 'A polling');
    ac.abort();
    assert.equal((await aP).block, true);
    aEnded();
    await assertCallBSafe(p, p.stub.count('GET', '/api/hitl/get-decision'));
  });

  test('poll 429 while unbound: the next call never binds the late work item', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    const aEnded = lateWorkitemBackend(p, () => ({ status: 429, body: { error: 'call_limit_reached' } }));
    assert.equal((await p.callTool('exec', { command: 'ls /tmp' })).block, true);
    aEnded();
    await assertCallBSafe(p, p.stub.count('GET', '/api/hitl/get-decision'));
  });

  test('timeout before the work item appears: the next call never binds it', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    const aEnded = lateWorkitemBackend(p, () => pending(null));
    assert.match((await p.callTool('exec', { command: 'ls /tmp' })).blockReason, /timed out/);
    aEnded();
    await assertCallBSafe(p, p.stub.count('GET', '/api/hitl/get-decision'));
  });

  test('request lost on the wire (5xx) retires the instance', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [{ status: 503, body: { error: 'busy' } }, ok({ status: 'no-hitl' })]);
    assert.equal((await p.callTool('exec', { command: 'one' })).block, true);
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.deepEqual(requestsOf(p).map((r) => r.body.caller_id), ['inst-1', 'inst-2']);
    await waitFor(() => finished(p, 'inst-1').length === 1, 'setState finished for inst-1');
  });

  test('2xx with invalid JSON may have landed: the instance is retired', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [{ status: 200, raw: '{"status":"pend' }, ok({ status: 'no-hitl' })]);
    assert.match((await p.callTool('exec', { command: 'one' })).blockReason, /invalid response/);
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.equal(inits(p), 2);
  });

  test('a review that ends with an accepted decision keeps the instance', async (t) => {
    const p = await setup(t, { mode: 'hitl_reject' });
    assert.match((await p.callTool('exec', { command: 'one' })).blockReason, /rejected by a human reviewer/);
    p.stub.setMode('hitl_approve');
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.equal(inits(p), 1);
    assert.equal(p.stub.count('POST', '/api/agent/setState'), 0);
  });

  for (const mode of ['allow', 'no_policy', 'policy_error_200']) {
    test(`${mode}: no work item can exist, the instance is kept`, async (t) => {
      const p = await setup(t, { mode });
      await p.callTool('exec', { command: 'one' });
      await p.callTool('exec', { command: 'two' });
      assert.equal(inits(p), 1);
      assert.equal(p.stub.count('POST', '/api/agent/setState'), 0);
    });
  }

  test('a hung or failing setState never holds a call or rejects unhandled', { timeout: 20_000 }, async (t) => {
    const p = await setup(t, { config: { AMP_REQUEST_TIMEOUT_MS: 200 } });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    p.stub.script('POST /api/agent/setState', [{ destroy: true }, { status: 200, body: { ok: true }, delayMs: 30_000 }]);
    p.stub.script('POST /api/hitl/request', [{ status: 503, body: {} }, { status: 503, body: {} }, ok({ status: 'no-hitl' })]);
    assert.equal((await p.callTool('exec', { command: 'one' })).block, true);
    assert.equal((await p.callTool('exec', { command: 'two' })).block, true);
    assert.deepEqual(await p.callTool('exec', { command: 'three' }), {});
    assert.equal(inits(p), 3);
    await delay(400); // past AMP_REQUEST_TIMEOUT_MS: the hung setState has been cut
    assert.deepEqual(unhandled.map(String), []);
  });
});

describe('K2.3 — restart and second process never reuse a persisted instance', () => {
  const sessionFile = (p) => path.join(p.stateDir, 'hooks', 'amp', 'plugin-session.json');

  test('restart: a fresh instance is created; the old instance\'s abandoned work item is never seen', async (t) => {
    const p = await setup(t);
    fs.writeFileSync(sessionFile(p), JSON.stringify({ instanceId: 'inst-old', writer: 'plugin' }));
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    scopeDecisions(p, (cid, n) => {
      if (cid === 'inst-old') return n === 1 ? pending('wi-old') : done('approve', 'wi-old');
      return n === 1 ? pending('wi-new') : done('reject', 'wi-new');
    });
    const res = await p.callTool('exec', { command: 'rm -rf /important' });
    assert.equal(res?.block, true, `must not run on the old approval: ${JSON.stringify(res)}`);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.equal(inits(p), 1);
    assert.equal(requestsOf(p)[0].body.caller_id, 'inst-1');
    assert.ok(pollCallers(p).every((c) => c === 'inst-1'));
  });

  test('two processes on one state dir get distinct instances and their own decisions', async (t) => {
    const p1 = await loadPlugin({ mode: 'allow' });
    const p2 = await loadPlugin({ mode: 'allow', stub: p1.stub, stateDir: p1.stateDir });
    t.after(async () => { await p2.cleanup(); await p1.cleanup(); });
    fs.writeFileSync(sessionFile(p1), JSON.stringify({ instanceId: 'inst-shared', writer: 'plugin' }));
    p1.stub.script('POST /api/hitl/request', [pending(null)]);
    const verdict = new Map(); // caller_id -> resolution for that process's own work item
    scopeDecisions(p1, (cid, n) => {
      if (cid === 'inst-shared') return done('approve', 'wi-shared');
      return n === 1 ? pending(`wi-${cid}`) : done(verdict.get(cid) ?? 'reject', `wi-${cid}`);
    });
    const a = await p1.callTool('exec', { command: 'rm -rf /important' });
    const p2Instance = 'inst-2';
    verdict.set(p2Instance, 'approve');
    const b = await p2.callTool('exec', { command: 'ls' });
    const callers = requestsOf(p1).map((r) => r.body.caller_id);
    assert.deepEqual(callers, ['inst-1', p2Instance], 'distinct caller ids, never the persisted one');
    assert.equal(a?.block, true, `process 1 must not run on another approval: ${JSON.stringify(a)}`);
    assert.match(a.blockReason, /rejected by a human reviewer/);
    assert.deepEqual(b, {});
  });

  test('after_tool_call does not log under a persisted instance of another process', async (t) => {
    const p = await setup(t);
    fs.writeFileSync(sessionFile(p), JSON.stringify({ instanceId: 'inst-old', writer: 'plugin' }));
    await p.handlers.after_tool_call({ toolName: 'exec', result: 'hi' });
    await p.handlers.message_sending({ content: 'hello' });
    assert.equal(p.stub.requests((r) => r.body?.instance_id === 'inst-old').length, 0);
  });
});

describe('K2.3 — one process-wide governance lock', () => {
  test('a call queued behind a retiring call runs on a fresh instance', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending(null)]);
    scopeDecisions(p, (cid, n) => {
      if (cid === 'inst-1') return n === 1 ? pending(null) : idless({ method: 'auto', resolution: 'approve' });
      return n === 1 ? pending('wi-B') : done('approve', 'wi-B');
    });
    const a = p.callTool('exec', { command: 'one' });
    const b = p.callTool('exec', { command: 'two' });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.block, true);
    assert.match(ra.blockReason, /no work item/);
    assert.deepEqual(rb, {});
    assert.deepEqual(requestsOf(p).map((r) => [r.body.context.command, r.body.caller_id]),
      [['one', 'inst-1'], ['two', 'inst-2']]);
  });

  test('instance init happens inside the lock: concurrent first calls create one instance', async (t) => {
    const p = await setup(t);
    const results = await Promise.all([1, 2, 3].map((n) => p.callTool('exec', { command: `c${n}` })));
    assert.deepEqual(results, [{}, {}, {}]);
    assert.equal(inits(p), 1);
  });
});

// Gate-2 HIGH: the backend proxies agent-hitl's status + body unchanged
// (inquiryon_amp_backend app.py:10000-10019), so a 4xx or an error body may
// come from agent-hitl after it created a work item. Only early returns the
// backend itself makes before proxying (recognised by body shape) keep the instance.
describe('K2.3 — a refused or failed policy check that may have reached agent-hitl retires the instance', () => {
  const mayHaveLanded = [
    ['HTTP 409 from agent-hitl', { status: 409, body: { error: 'agent-hitl conflict' } }],
    ['HTTP 400 non-JSON body', { status: 400, raw: '<html>bad request</html>' }],
    ['HTTP 422 without an error field', { status: 422, body: { message: 'unprocessable' } }],
    ['200 status error', ok({ status: 'error', message: 'notify failed' })],
    ['200 status config_error', ok({ status: 'config_error', message: 'bad config' })],
    ['200 policy_error with another reason', ok({ status: 'policy_error', reason: 'evaluator_crashed' })],
  ];
  for (const [name, first] of mayHaveLanded) {
    test(`${name}: the next call never binds the late work item`, async (t) => {
      const p = await setup(t);
      p.stub.script('POST /api/hitl/request', [first, pending(null)]);
      const aEnded = lateWorkitemBackend(p, () => pending(null));
      assert.equal((await p.callTool('exec', { command: 'ls /tmp' })).block, true);
      aEnded();
      await assertCallBSafe(p, p.stub.count('GET', '/api/hitl/get-decision'));
    });
  }

  const backendNative = [
    ['call_limit_reached', { status: 429, body: { error: 'call_limit_reached', used: 5, limit: 5 } }],
    ['authentication_required', { status: 401, body: { error: 'authentication_required' } }],
    ['instance_not_owned', { status: 403, body: { error: 'instance_not_owned' } }],
    ['invalid_caller_id', { status: 400, body: { error: 'invalid_caller_id' } }],
    ['org_id_required', { status: 400, body: { error: 'org_id_required' } }],
    ['callback_url_required', { status: 400, body: { error: 'callback_url_required' } }],
    ['policy_error policy_invalid_hitl_assignee', ok({ status: 'policy_error', reason: 'policy_invalid_hitl_assignee', message: 'bad who' })],
  ];
  for (const [name, first] of backendNative) {
    test(`backend-native refusal ${name}: no work item can exist, the instance is kept`, async (t) => {
      const p = await setup(t);
      p.stub.script('POST /api/hitl/request', [first, ok({ status: 'no-hitl' })]);
      assert.equal((await p.callTool('exec', { command: 'one' })).block, true);
      assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
      assert.deepEqual(requestsOf(p).map((r) => r.body.caller_id), ['inst-1', 'inst-1']);
      assert.equal(p.stub.count('POST', '/api/agent/setState'), 0);
    });
  }
});

// Gate-2 MEDIUM: a throw inside the governance path must never reach the host
// (older or other hosts may fail open on a throwing hook) and, once the
// request may have landed, must retire the instance like any other exit
// without an accepted decision.
describe('K2.3 — a throw in the governance path retires and blocks', () => {
  const UNEXPECTED = /AMP governance failed unexpectedly — blocked/;
  // JSON a helper cannot stringify: String({toString: 1}) throws a TypeError.
  const unprintable = { toString: 1 };

  test('a decision body that makes a helper throw: blocked, instance retired', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending('wi-A'), ok({ status: 'no-hitl' })]);
    scopeDecisions(p, () => ok({ status: 'complete', resolution: unprintable, workitem_id: 'wi-A' }));
    let a;
    await assert.doesNotReject(async () => { a = await p.callTool('exec', { command: 'one' }); });
    assert.equal(a?.block, true);
    assert.match(a.blockReason, UNEXPECTED);
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.deepEqual(requestsOf(p).map((r) => r.body.caller_id), ['inst-1', 'inst-2']);
    await waitFor(() => finished(p, 'inst-1').length === 1, 'setState finished for inst-1');
  });

  test('a request body that makes a helper throw: blocked, instance retired', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [ok({ status: 'error', reason: unprintable }), ok({ status: 'no-hitl' })]);
    let a;
    await assert.doesNotReject(async () => { a = await p.callTool('exec', { command: 'one' }); });
    assert.match(a?.blockReason ?? '', UNEXPECTED);
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.deepEqual(requestsOf(p).map((r) => r.body.caller_id), ['inst-1', 'inst-2']);
  });

  const throwingHosts = [
    ['event params getter', () => ({ toolName: 'exec', toolCallId: 'tc-x', get params() { throw new Error('host boom'); } }), () => ({})],
    ['ctx abortSignal getter', () => ({ toolName: 'exec', toolCallId: 'tc-x', params: {} }), () => ({ get abortSignal() { throw new Error('host boom'); } })],
  ];
  for (const [name, event, ctx] of throwingHosts) {
    test(`a throwing host object (${name}) is blocked, never rethrown; the lock is released`, async (t) => {
      const p = await setup(t);
      let res;
      await assert.doesNotReject(async () => { res = await p.handlers.before_tool_call(event(), ctx()); });
      assert.equal(res?.block, true);
      assert.match(res.blockReason, UNEXPECTED);
      assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
      assert.deepEqual(await p.callTool('exec', { command: 'next' }), {});
    });
  }
});

// Gate-2 LOW4: session_start (/new, /reset) drops the instance; it must also
// finish it in AMP, without interrupting a call still running on it.
describe('K2.3 — session_start finishes the AMP instance', () => {
  test('session_start: setState finished for the old instance; the next call inits a fresh one', async (t) => {
    const p = await setup(t);
    assert.deepEqual(await p.callTool('exec', { command: 'one' }), {});
    p.handlers.session_start({}, {});
    await waitFor(() => finished(p, 'inst-1').length === 1, 'setState finished for inst-1');
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.deepEqual(requestsOf(p).map((r) => r.body.caller_id), ['inst-1', 'inst-2']);
  });

  test('session_start with no instance yet sends no setState', async (t) => {
    const p = await setup(t);
    p.handlers.session_start({}, {});
    await delay(50);
    assert.equal(p.stub.count('POST', '/api/agent/setState'), 0);
  });

  test('a call in flight keeps its instance; its own retire does not finish it twice', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [pending(null), ok({ status: 'no-hitl' })]);
    scopeDecisions(p, () => pending(null));
    const aP = p.callTool('exec', { command: 'one' });
    await waitFor(() => p.stub.count('GET', '/api/hitl/get-decision') >= 1, 'A polling');
    p.handlers.session_start({}, {});
    const pollsAtReset = p.stub.count('GET', '/api/hitl/get-decision');
    assert.match((await aP).blockReason, /timed out/);
    assert.ok(p.stub.count('GET', '/api/hitl/get-decision') > pollsAtReset, 'A kept polling after session_start');
    assert.ok(pollCallers(p).every((c) => c === 'inst-1'));
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.equal(requestsOf(p).at(-1).body.caller_id, 'inst-2');
    await delay(100); // let fire-and-forget setState calls land
    assert.equal(finished(p, 'inst-1').length, 1, 'inst-1 finished exactly once');
  });
});

// Gate-2 LOW5: /api/agent/init runs inside the process-wide lock; a cancelled
// run must abort it at once instead of holding the lock up to the request cap.
describe('K2.3 — a cancelled run aborts AMP instance creation', () => {
  test('abort during /api/agent/init blocks as cancelled, no outage alert, lock freed', { timeout: 12_000 }, async (t) => {
    const p = await setup(t, { config: { AMP_REQUEST_TIMEOUT_MS: 60_000 } });
    await p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });
    p.stub.script('POST /api/agent/init', [
      { status: 200, body: { instance_id: 'inst-late', status: 'running' }, delayMs: 30_000 },
      { status: 200, body: { instance_id: 'inst-2', status: 'running' } },
    ]);
    const ac = new AbortController();
    const aP = p.callTool('exec', { command: 'one' }, { abortSignal: ac.signal });
    await waitFor(() => inits(p) === 1, 'init sent');
    ac.abort();
    const a = await aP;
    assert.equal(a?.block, true);
    assert.match(a.blockReason, /run cancelled/);
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
    assert.deepEqual(await p.callTool('exec', { command: 'two' }), {});
    assert.equal(requestsOf(p).at(-1).body.caller_id, 'inst-2');
    await delay(100); // let fire-and-forget notifications settle
    const notes = p.runtimeCalls.map((c) => String(c.args[1]));
    assert.deepEqual(notes.filter((m) => /Unreachable|Restored/.test(m)), [], 'no outage / recovery notification');
  });
});

// Gate-2 LOW6: remaining K2.3 claims, with caller-scoped responses.
describe('K2.3 — remaining rotation claims', () => {
  test('init fails after a retire: the call blocks and never reuses the old id', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [{ status: 503, body: { error: 'busy' } }, ok({ status: 'no-hitl' })]);
    p.stub.script('POST /api/agent/init', [ok({ instance_id: 'inst-1', status: 'running' }), { status: 500, body: { error: 'init down' } }]);
    assert.equal((await p.callTool('exec', { command: 'one' })).block, true);
    for (const cmd of ['two', 'three']) {
      const r = await p.callTool('exec', { command: cmd });
      assert.equal(r?.block, true, `${cmd} must block without an instance: ${JSON.stringify(r)}`);
      assert.match(r.blockReason, /unreachable/);
    }
    assert.deepEqual(requestsOf(p).map((r) => r.body.caller_id), ['inst-1'], 'no request on the retired id');
    assert.equal(p.stub.count('GET', '/api/hitl/get-decision'), 0);
    assert.equal(inits(p), 3);
  });

  test('unexpected status "denied" with a workitem_id: the next call never binds the late work item', async (t) => {
    const p = await setup(t);
    p.stub.script('POST /api/hitl/request', [ok({ status: 'denied', workitem_id: 'wi-A' }), pending(null)]);
    const aEnded = lateWorkitemBackend(p, () => pending(null));
    assert.match((await p.callTool('exec', { command: 'ls /tmp' })).blockReason, /unexpected status "denied"/);
    aEnded();
    await assertCallBSafe(p, p.stub.count('GET', '/api/hitl/get-decision'));
  });

  test('request cut by the call budget: the next call never binds the late work item', { timeout: 15_000 }, async (t) => {
    const apiConfig = { plugins: { entries: { 'amp-governance': { hooks: { timeouts: { before_tool_call: 2000 } } } } } };
    const p = await setup(t, { apiConfig });
    p.stub.script('POST /api/hitl/request', [{ ...pending(null), delayMs: 10_000 }, pending(null)]);
    const aEnded = lateWorkitemBackend(p, () => pending(null));
    assert.match((await p.callTool('exec', { command: 'ls /tmp' })).blockReason, /OpenClaw hook budget/);
    assert.equal(p.stub.count('GET', '/api/hitl/get-decision'), 0, 'A never got to poll');
    aEnded();
    await assertCallBSafe(p, 0);
  });
});
