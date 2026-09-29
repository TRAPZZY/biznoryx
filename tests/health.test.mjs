import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthChecks, evaluateLiveness, evaluateReadiness } from '../src/server/health.mjs';

const healthy = () => ({ database: async () => true, objectStorage: async () => true, worker: async () => true });

test('liveness is independent of dependencies and remains alive during draining', () => {
  assert.deepEqual(evaluateLiveness(), { statusCode: 200, state: 'alive' });
  assert.deepEqual(evaluateLiveness({ draining: true }), { statusCode: 200, state: 'draining' });
});

test('readiness requires all three dependencies and fails closed when unconfigured', async () => {
  assert.deepEqual(await evaluateReadiness({ probes: healthy() }), {
    statusCode: 200, state: 'ready', checks: { database: 'healthy', objectStorage: 'healthy', worker: 'healthy' },
  });
  assert.deepEqual(await evaluateReadiness(), {
    statusCode: 503, state: 'not_ready', checks: { database: 'unconfigured', objectStorage: 'unconfigured', worker: 'unconfigured' },
  });
  for (const name of ['database', 'objectStorage', 'worker']) {
    const result = await evaluateReadiness({ probes: { ...healthy(), [name]: () => false } });
    assert.equal(result.statusCode, 503);
    assert.equal(result.checks[name], 'unhealthy');
  }
});

test('probe errors and arbitrary return values cannot disclose secrets or pass readiness', async () => {
  const secret = 'postgres://private:password@internal/database';
  const result = await evaluateReadiness({ probes: {
    database: () => { throw new Error(secret); },
    objectStorage: async () => { throw { credentials: secret }; },
    worker: () => ({ healthy: true, token: secret }),
    [secret]: () => true,
  } });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.checks, { database: 'unhealthy', objectStorage: 'unhealthy', worker: 'unhealthy' });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('a hung probe times out and receives cancellation even if it ignores the signal', async () => {
  let signal;
  const result = await evaluateReadiness({ timeoutMs: 10, probes: {
    ...healthy(), database: (context) => { signal = context.signal; return new Promise(() => {}); },
  } });
  assert.equal(result.statusCode, 503);
  assert.equal(result.checks.database, 'timeout');
  assert.equal(signal.aborted, true);
});

test('all probes start concurrently and a late rejection is consumed', async () => {
  const started = [];
  let rejectLate;
  const pending = evaluateReadiness({ timeoutMs: 10, probes: {
    database: () => { started.push('database'); return new Promise((resolve, reject) => { rejectLate = reject; }); },
    objectStorage: () => { started.push('objectStorage'); return true; },
    worker: () => { started.push('worker'); return true; },
  } });
  await Promise.resolve();
  assert.deepEqual(started, ['database', 'objectStorage', 'worker']);
  const result = await pending;
  rejectLate(new Error('private credentials'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.checks.database, 'timeout');
});

test('draining is irreversible, skips new probes, and overrides in-flight readiness', async () => {
  let finish;
  let calls = 0;
  const checks = createHealthChecks({ probes: {
    ...healthy(), database: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
  } });
  const pending = checks.readiness();
  await Promise.resolve();
  checks.beginDraining();
  checks.beginDraining();
  finish(true);
  assert.equal((await pending).state, 'draining');
  assert.deepEqual(await checks.readiness(), { statusCode: 503, state: 'draining', checks: {} });
  assert.equal(calls, 1);
  assert.deepEqual(checks.liveness(), { statusCode: 200, state: 'draining' });
});

test('successful probes release their timers without later aborting', async () => {
  let signal;
  const result = await evaluateReadiness({ timeoutMs: 10, probes: {
    ...healthy(), database: (context) => { signal = context.signal; return true; },
  } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result.statusCode, 200);
  assert.equal(signal.aborted, false);
});

test('invalid deadline configuration fails explicitly with a fixed message', async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 1.5, 30001, 'secret']) {
    await assert.rejects(evaluateReadiness({ timeoutMs }), {
      name: 'TypeError', message: 'Health probe timeout must be an integer from 1 to 30000 milliseconds.',
    });
  }
});
