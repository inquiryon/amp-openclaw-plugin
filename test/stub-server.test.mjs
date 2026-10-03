// Self-tests for the in-process stub, so harness bugs never masquerade as plugin behaviour.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStub, MODE_NAMES } from './helpers/stub-server.mjs';

describe('stub-server', () => {
  let stub;
  before(async () => { stub = await startStub(); });
  after(() => stub.close());
  beforeEach(() => stub.reset());

  const post = (path, body) => fetch(`${stub.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k1' },
    body: JSON.stringify(body),
  });
  const decision = () => fetch(`${stub.url}/api/hitl/get-decision?caller_id=inst-1`);

  test('unknown mode: setMode throws and POST /__mode returns 400 (M5)', async () => {
    assert.throws(() => stub.setMode('hitl_typo'), /unknown mode/);
    const res = await post('/__mode', { mode: 'hitl_typo' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'unknown mode' });
    assert.equal(stub.mode, 'allow');
  });

  test('POST /__mode switches to a known mode', async () => {
    const res = await post('/__mode', { mode: 'no_policy' });
    assert.equal(res.status, 200);
    assert.equal(stub.mode, 'no_policy');
  });

  test('records method, path, query, body and x-api-key', async () => {
    await post('/api/log', { message: 'hello' });
    await decision();
    const [log, dec] = stub.requests();
    assert.deepEqual(log, {
      method: 'POST', path: '/api/log', query: {}, body: { message: 'hello' }, headers: { 'x-api-key': 'k1' },
    });
    assert.deepEqual(dec.query, { caller_id: 'inst-1' });
    assert.equal(stub.count('GET', '/api/hitl/get-decision'), 1);
  });

  test('init returns sequential instance ids', async () => {
    const a = await (await post('/api/agent/init', {})).json();
    const b = await (await post('/api/agent/init', {})).json();
    assert.equal(a.instance_id, 'inst-1');
    assert.equal(b.instance_id, 'inst-2');
  });

  test('hitl decisions echo the workitem_id from the request', async () => {
    for (const mode of ['hitl_approve', 'hitl_reject', 'hitl_modify', 'hitl_cancelled']) {
      stub.setMode(mode);
      const req = await (await post('/api/hitl/request', {})).json();
      assert.equal(req.status, 'pending');
      const dec = await (await decision()).json();
      assert.equal(dec.workitem_id, req.workitem_id, mode);
      assert.equal(dec.status, 'complete', mode);
    }
  });

  test('hitl_cancelled returns the frozen K1 body', async () => {
    stub.setMode('hitl_cancelled');
    const req = await (await post('/api/hitl/request', {})).json();
    assert.deepEqual(await (await decision()).json(), {
      status: 'complete', resolution: 'reject', method: 'cancelled', workitem_status: 'Cancelled',
      workitem_id: req.workitem_id, information: 'workitem cancelled',
    });
  });

  test('hitl_modify carries modified_action.params', async () => {
    stub.setMode('hitl_modify');
    await post('/api/hitl/request', {});
    const dec = await (await decision()).json();
    assert.equal(dec.resolution, 'modify');
    assert.deepEqual(dec.modified_action, { params: { command: 'echo safe' } });
  });

  test('hitl_slow stays pending for N polls then approves', async () => {
    stub.setMode('hitl_slow', { pendingPolls: 3 });
    await post('/api/hitl/request', {});
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await (await decision()).json()).status);
    assert.deepEqual(statuses, ['pending', 'pending', 'pending', 'complete']);
  });

  test('poll429 answers get-decision with 429 call_limit_reached', async () => {
    stub.setMode('poll429');
    await post('/api/hitl/request', {});
    const res = await decision();
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'call_limit_reached' });
  });

  test('policy_error is HTTP 500; policy_error_200 is a 200 with message', async () => {
    stub.setMode('policy_error');
    assert.equal((await post('/api/hitl/request', {})).status, 500);
    stub.setMode('policy_error_200');
    const res = await post('/api/hitl/request', {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message, 'Missing field(s): who');
  });

  test('null_body returns literal null', async () => {
    stub.setMode('null_body');
    assert.equal(await (await post('/api/hitl/request', {})).text(), 'null');
  });

  test('down destroys the socket on /api/*', async () => {
    stub.setMode('down');
    await assert.rejects(post('/api/agent/init', {}));
    assert.equal(stub.count('POST', '/api/agent/init'), 1);
  });

  test('script() queues per-route responses; the last one repeats', async () => {
    stub.script('POST /api/hitl/request', [
      { status: 401, body: { error: 'bad key' } },
      { status: 200, body: { status: 'no-hitl' } },
    ]);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await post('/api/hitl/request', {})).status);
    assert.deepEqual(codes, [401, 200, 200]);
  });

  test('every named mode is accepted by setMode', () => {
    for (const m of MODE_NAMES) stub.setMode(m);
    assert.ok(MODE_NAMES.length >= 13);
  });
});
