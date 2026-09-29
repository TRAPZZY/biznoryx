const DEPENDENCIES = Object.freeze(['database', 'objectStorage', 'worker']);

export function evaluateLiveness({ draining = false } = {}) {
  return { statusCode: 200, state: draining ? 'draining' : 'alive' };
}

// Probes receive { signal } and must resolve to true. They must use nonblocking
// I/O and honor cancellation; a timer cannot interrupt synchronous JavaScript.
export async function evaluateReadiness({
  probes = {},
  timeoutMs = 1000,
  lifecycle = { draining: false },
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Health probe timeout must be an integer from 1 to 30000 milliseconds.');
  }
  if (lifecycle.draining) return { statusCode: 503, state: 'draining', checks: {} };

  const results = await Promise.all(
    DEPENDENCIES.map(async (name) => [name, await probeStatus(probes[name], timeoutMs)]),
  );
  const checks = Object.fromEntries(results);
  // Drain may begin while dependency I/O is in flight.
  if (lifecycle.draining) return { statusCode: 503, state: 'draining', checks };
  const ready = results.every(([, status]) => status === 'healthy');
  return { statusCode: ready ? 200 : 503, state: ready ? 'ready' : 'not_ready', checks };
}

export function createHealthChecks({ probes = {}, timeoutMs = 1000 } = {}) {
  const lifecycle = { draining: false };
  return Object.freeze({
    beginDraining() { lifecycle.draining = true; },
    liveness() { return evaluateLiveness(lifecycle); },
    readiness() { return evaluateReadiness({ probes, timeoutMs, lifecycle }); },
  });
}

async function probeStatus(probe, timeoutMs) {
  if (typeof probe !== 'function') return 'unconfigured';
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
      controller.abort();
    }, timeoutMs);
  });
  // Consume both synchronous throws and late rejections without exposing errors.
  const operation = Promise.resolve()
    .then(() => probe({ signal: controller.signal }))
    .then((value) => value === true ? 'healthy' : 'unhealthy', () => 'unhealthy');
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
