export async function deliverUpdates(pool) {
  const schema = await pool.query("select to_regprocedure('public.deliver_source_updates(integer)') as delivery_function");
  if (!schema.rows[0]?.delivery_function) return 0;
  const result = await pool.query("select deliver_source_updates(20) as delivered");
  return result.rows[0].delivered;
}

export function startUpdatesMaintenance({ pool, onError, intervalMs = 30000 }) {
  let stopped = false, busy = false;
  let active = Promise.resolve();
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await deliverUpdates(pool); }
    catch { onError(new Error("In-app update delivery failed; inspect the notification outbox.")); }
    finally { busy = false; }
  };
  const run = () => { if (!busy && !stopped) active = tick(); };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  run();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
