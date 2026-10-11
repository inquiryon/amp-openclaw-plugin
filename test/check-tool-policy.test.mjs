// Tier 1: before_tool_call governance decisions against the in-process stub.
// Covers spec items A1 (fail closed on policy_error/unknown/null bodies),
// A2 (block modify until params can be applied), A3 (honour poll interval)
// A4 (fail fast when AMP rejects a decision poll) and B2/K1 (cancelled is terminal).
//
// The default test config polls every 50 ms (HITL_POLL_INTERVAL_MS) inside a
// 3 s HITL window (HITL_TIMEOUT_MINUTES 0.05).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './helpers/load-plugin.mjs';

const DECISION = ['GET', '/api/hitl/get-decision'];

async function withPlugin(t, mode, fn, modeOpts) {
  const p = await loadPlugin({ mode, modeOpts });
  t.after(() => p.cleanup());
  return fn(p);
}

// Scripted get-decision bodies below name wi-1 directly, so the request must
// bind the call to wi-1 (legacy bound shape) instead of the id-less default.
const BOUND = { boundRequest: true };

async function outcome(p) {
  try {
    const res = await p.callTool('exec', { command: 'echo hi' });
    if (res && res.block === true) return { kind: 'block', res };
    if (res && typeof res === 'object' && Object.keys(res).length === 0) return { kind: 'allow', res };
    return { kind: 'other', res };
  } catch (err) {
    return { kind: 'threw', error: String(err?.message || err) };
  }
}

describe('checkToolPolicy — current behaviour', () => {
  test('no-hitl allows', (t) => withPlugin(t, 'allow', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 1);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('no_policy blocks', (t) => withPlugin(t, 'no_policy', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /no active governance policy/);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('policy_error (HTTP 500) blocks, labelled as an AMP HTTP 500 (Wave 3 Note A)', (t) => withPlugin(t, 'policy_error', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /AMP returned HTTP 500 for the policy check/);
    assert.doesNotMatch(res.blockReason, /unreachable/);
  }));

  test('backend down blocks', (t) => withPlugin(t, 'down', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /unreachable/);
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 0);
  }));

  test('pending -> approve allows (id-less request: pending poll, then approve)', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count(...DECISION), 2);
  }));

  test('pending -> reject blocks with reviewer note', (t) => withPlugin(t, 'hitl_reject', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /rejected by a human reviewer/);
    assert.match(res.blockReason, /stub reviewer says no/);
  }));

  test('sends the configured API key on every AMP call', (t) => withPlugin(t, 'allow', async (p) => {
    await p.callTool('exec', { command: 'echo hi' });
    const reqs = p.stub.requests();
    assert.ok(reqs.length >= 3, `expected init + log + request, got ${reqs.length}`);
    for (const r of reqs) assert.equal(r.headers['x-api-key'], 'amp_k_test', `${r.method} ${r.path}`);
  }));
});

describe('checkToolPolicy — A1/A2 behaviour', () => {
  test('policy_error 200 blocks and surfaces backend message', (t) => withPlugin(t, 'policy_error_200', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /Missing field\(s\): who/);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('unknown status blocks', (t) => withPlugin(t, 'garbage', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /banana/);
  }));

  test('null / non-object body blocks', (t) => withPlugin(t, 'null_body', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
  }));

  // Allow set mirrors Hermes (amp-hermes-plugin/plugins/saas/__init__.py:772).
  for (const status of ['allow', 'allowed', 'approved']) {
    test(`${status} allows`, (t) => withPlugin(t, 'allow', async (p) => {
      p.stub.script('POST /api/hitl/request', [{ status: 200, body: { status } }]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.deepEqual(res, {});
      assert.equal(p.stub.count(...DECISION), 0);
    }));
  }

  for (const status of ['config_error', 'error']) {
    test(`${status} blocks`, (t) => withPlugin(t, 'allow', async (p) => {
      p.stub.script('POST /api/hitl/request', [{
        status: 200,
        body: { status, message: `stub ${status} detail`, workitem_id: 'wi-x' },
      }]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.equal(res?.block, true);
      assert.match(res.blockReason, new RegExp(`stub ${status} detail`));
      assert.equal(p.stub.count(...DECISION), 0);
    }));
  }

  test('array body blocks', (t) => withPlugin(t, 'allow', async (p) => {
    p.stub.script('POST /api/hitl/request', [{ status: 200, body: [{ status: 'no-hitl' }] }]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /unexpected status "missing"/);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  test('invalid JSON body blocks', (t) => withPlugin(t, 'allow', async (p) => {
    p.stub.script('POST /api/hitl/request', [{ status: 200, raw: '{"status":"no-hitl"' }]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /invalid response/);
    assert.equal(p.stub.count(...DECISION), 0);
  }));

  for (const resolution of ['modify', 'modified']) {
    test(`${resolution} resolution blocks (no params applied)`, (t) => withPlugin(t, 'hitl_modify', async (p) => {
      if (resolution !== 'modify') {
        p.stub.script('GET /api/hitl/get-decision', [{
          status: 200,
          body: {
            status: 'complete',
            resolution,
            information: 'use a safer command',
            modified_action: { params: { command: 'echo safe' } },
            workitem_id: 'wi-1',
          },
        }]);
      }
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.equal(res?.block, true);
      assert.equal(Object.hasOwn(res, 'params'), false);
      assert.match(res.blockReason, /modified version/);
      assert.match(res.blockReason, /Re-submit/);
      assert.match(res.blockReason, /use a safer command/);
    }, BOUND));
  }
});

// LOW2: AMP answered the policy check with a 4xx — it is up and refused this
// request (bad key, bad body, rate limit). Block with the status; it is not an
// outage (no unreachable state, no outage notification). The body is not a
// backend-native refusal, so agent-hitl may have created a work item: the
// instance is retired (K2.3; native refusals: instance-rotation.test.mjs).
describe('LOW2 — request-side HTTP 4xx is a rejection, not an outage', () => {
  for (const code of [400, 401, 403, 404, 409, 422, 429]) {
    test(`request ${code} blocks with the status, no outage, instance retired`, (t) => withPlugin(t, 'allow', async (p) => {
      await p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });
      p.stub.script('POST /api/hitl/request', [{ status: code, body: { error: `stub ${code}` } }, { status: 200, body: { status: 'no-hitl' } }]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.equal(res?.block, true);
      assert.equal(res.blockReason, `Tool call "exec" blocked — AMP rejected the policy check (HTTP ${code}).`);
      assert.deepEqual(await p.callTool('exec', { command: 'echo again' }), {});
      await new Promise((r) => setTimeout(r, 100)); // let fire-and-forget notifications settle
      const notes = p.runtimeCalls.map((c) => String(c.args[1]));
      assert.deepEqual(notes.filter((m) => /Unreachable|Restored/.test(m)), [], 'no outage / recovery notification');
      assert.equal(p.stub.count('POST', '/api/agent/init'), 2, 'instance retired');
      assert.equal(p.stub.count('POST', '/api/agent/setState'), 1);
    }));
  }

  test('request 5xx blocks as an AMP server error, with no outage alert (Wave 3 Note A)', (t) => withPlugin(t, 'allow', async (p) => {
    await p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });
    p.stub.script('POST /api/hitl/request', [{ status: 502, body: {} }, { status: 200, body: { status: 'no-hitl' } }]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /AMP returned HTTP 502 for the policy check/);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(p.runtimeCalls.filter((c) => /Unreachable/.test(JSON.stringify(c))), [], 'no outage alert for an HTTP answer');
    // The request may have reached agent-hitl: the instance is retired (K2.3).
    assert.deepEqual(await p.callTool('exec', { command: 'again' }), {});
    assert.equal(p.stub.count('POST', '/api/agent/init'), 2);
  }));

  test('transport failure on the request keeps the outage path', (t) => withPlugin(t, 'allow', async (p) => {
    await p.handlers.message_received({ from: 'slack:channel:C1' }, { channelId: 'slack' });
    p.stub.script('POST /api/hitl/request', [{ destroy: true }]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.match(res.blockReason, /unreachable/);
    for (let i = 0; i < 100 && !p.runtimeCalls.some((c) => /Unreachable/.test(JSON.stringify(c))); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(p.runtimeCalls.some((c) => /Unreachable/.test(JSON.stringify(c))), 'outage alert sent');
  }));
});

describe('pollHitlDecision — A4 fail fast on rejected polls', () => {
  const approve = { status: 200, body: { status: 'complete', resolution: 'approve', workitem_id: 'wi-1' } };

  for (const code of [400, 401, 403, 404, 429]) {
    test(`poll ${code} blocks fast`, (t) => withPlugin(t, 'hitl_approve', async (p) => {
      p.stub.script('GET /api/hitl/get-decision', [{ status: code, body: { error: `stub ${code}` } }]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.equal(res?.block, true);
      assert.match(res.blockReason, new RegExp(`HTTP ${code}`));
      assert.doesNotMatch(res.blockReason, /timed out/);
      assert.equal(p.stub.count(...DECISION), 1);
    }));
  }

  test('poll 500 keeps polling', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    p.stub.script('GET /api/hitl/get-decision', [
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
      approve,
    ]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count(...DECISION), 3);
  }, BOUND));

  test('network error while polling blocks as unreachable, not as a timeout', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    p.stub.script('GET /api/hitl/get-decision', [{ destroy: true }]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.equal(res.block, true);
    assert.match(res.blockReason, /unreachable while waiting for the AMP review/);
    assert.doesNotMatch(res.blockReason, /timed out/);
    assert.equal(p.stub.count(...DECISION), 1);
  }));

  test('invalid JSON / non-object poll bodies keep polling', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    p.stub.script('GET /api/hitl/get-decision', [
      { status: 200, raw: 'not json' },
      { status: 200, raw: 'null' },
      { status: 200, raw: '[{"status":"complete","resolution":"approve"}]' },
      approve,
    ]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count(...DECISION), 4);
  }, BOUND));
});

describe('pollHitlDecision — B2/K1 cancelled work items are terminal', () => {
  const ok = (body) => ({ status: 200, body });
  const logs = (p) => p.stub.requests((r) => r.path === '/api/log').map((r) => r.body);

  function assertCancelledBlock(p, res) {
    assert.equal(res?.block, true);
    assert.match(res.blockReason, /cancelled/i);
    assert.doesNotMatch(res.blockReason, /rejected by/);
    assert.ok(
      logs(p).some((l) => l.level === 'WARN' && /cancelled/i.test(l.message)),
      'expected a WARN ampLog mentioning cancelled',
    );
  }

  test('hitl_cancelled mode blocks as cancelled, not rejected by a reviewer', (t) => withPlugin(t, 'hitl_cancelled', async (p) => {
    const res = await p.callTool('exec', { command: 'echo hi' });
    assertCancelledBlock(p, res);
    assert.equal(p.stub.count(...DECISION), 2);
  }));

  const terminalBodies = {
    'status cancelled (forward-compat)': { status: 'cancelled', workitem_id: 'wi-1' },
    'complete + method cancelled': { status: 'complete', resolution: 'reject', method: 'cancelled', workitem_id: 'wi-1' },
    'complete + workitem_status canceled': { status: 'complete', resolution: 'reject', workitem_status: 'canceled', workitem_id: 'wi-1' },
    'pending + workitem_status Cancelled': { status: 'pending', workitem_status: 'Cancelled', workitem_id: 'wi-1' },
  };
  for (const [name, body] of Object.entries(terminalBodies)) {
    test(`${name} blocks in one poll`, (t) => withPlugin(t, 'hitl_approve', async (p) => {
      p.stub.script('GET /api/hitl/get-decision', [ok(body)]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assertCancelledBlock(p, res);
      assert.equal(p.stub.count(...DECISION), 1);
    }, BOUND));
  }

  test('plain pending keeps polling', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    p.stub.script('GET /api/hitl/get-decision', [
      ok({ status: 'pending', workitem_status: 'Pending', workitem_id: 'wi-1' }),
      ok({ status: 'pending', workitem_id: 'wi-1' }),
      ok({ status: 'complete', resolution: 'approve', workitem_id: 'wi-1' }),
    ]);
    const res = await p.callTool('exec', { command: 'echo hi' });
    assert.deepEqual(res, {});
    assert.equal(p.stub.count(...DECISION), 3);
  }, BOUND));
});

// Every named stub mode with its expected outcome. todo = the item that makes it true.
const MATRIX = [
  { mode: 'allow', expect: 'allow' },
  { mode: 'no_policy', expect: 'block' },
  { mode: 'policy_error', expect: 'block' },
  { mode: 'policy_error_200', expect: 'block' },
  { mode: 'garbage', expect: 'block' },
  { mode: 'null_body', expect: 'block' },
  { mode: 'down', expect: 'block' },
  { mode: 'hitl_approve', expect: 'allow' },
  { mode: 'hitl_reject', expect: 'block' },
  { mode: 'hitl_modify', expect: 'block' },
  { mode: 'hitl_cancelled', expect: 'block' },
  // 2 pending polls then approve: needs the 50 ms poll interval (A3) to fit the 3 s timeout.
  { mode: 'hitl_slow', expect: 'allow' },
  { mode: 'poll429', expect: 'block' },
];

describe('modes matrix', () => {
  for (const { mode, expect, todo } of MATRIX) {
    test(`${mode} -> ${expect}`, todo ? { todo } : {}, (t) => withPlugin(t, mode, async (p) => {
      const got = await outcome(p);
      assert.equal(got.kind, expect, `mode ${mode}: ${JSON.stringify(got)}`);
    }));
  }
});

describe('L — vocabulary: only reject/rejected reads as a reviewer rejection', () => {
  const ok = (body) => ({ status: 200, body });

  for (const resolution of ['reject', 'rejected']) {
    test(`resolution ${resolution} blocks as rejected by a reviewer`, (t) => withPlugin(t, 'hitl_approve', async (p) => {
      p.stub.script('GET /api/hitl/get-decision', [ok({ status: 'complete', resolution, workitem_id: 'wi-1' })]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.equal(res?.block, true);
      assert.match(res.blockReason, /rejected by a human reviewer/);
    }, BOUND));
  }

  for (const resolution of ['', 'expired', 'banana', null]) {
    test(`resolution ${JSON.stringify(resolution)} blocks with "no usable decision"`, (t) => withPlugin(t, 'hitl_approve', async (p) => {
      p.stub.script('GET /api/hitl/get-decision', [ok({ status: 'complete', resolution, workitem_id: 'wi-1' })]);
      const res = await p.callTool('exec', { command: 'echo hi' });
      assert.equal(res?.block, true, JSON.stringify(res));
      const shown = String(resolution ?? '').toLowerCase();
      assert.ok(
        res.blockReason.includes(`AMP returned no usable decision (resolution=${shown}) — blocked`),
        res.blockReason,
      );
      assert.doesNotMatch(res.blockReason, /rejected by/);
    }, BOUND));
  }
});

describe('L — an aborted run never proceeds on an allow status', () => {
  test('signal aborted by the time the request returns no-hitl -> block', (t) => withPlugin(t, 'allow', async (p) => {
    // Reads not-aborted until AMP has received the request, aborted afterwards.
    const signal = {
      get aborted() { return p.stub.count('POST', '/api/hitl/request') > 0; },
      addEventListener() {},
      removeEventListener() {},
    };
    const res = await p.callTool('exec', { command: 'echo hi' }, { abortSignal: signal });
    assert.equal(res?.block, true, JSON.stringify(res));
    assert.match(res.blockReason, /run cancelled/);
    assert.equal(p.stub.count('POST', '/api/hitl/request'), 1);
  }));

  test('signal aborted by the time the poll returns approve -> block', (t) => withPlugin(t, 'hitl_approve', async (p) => {
    // Reads not-aborted until AMP has answered the first poll, aborted afterwards.
    const signal = {
      get aborted() { return p.stub.count(...DECISION) > 0; },
      addEventListener() {},
      removeEventListener() {},
    };
    const res = await p.callTool('exec', { command: 'echo hi' }, { abortSignal: signal });
    assert.equal(res?.block, true, JSON.stringify(res));
    assert.match(res.blockReason, /run cancelled/);
    assert.equal(p.stub.count(...DECISION), 1);
  }));
});
