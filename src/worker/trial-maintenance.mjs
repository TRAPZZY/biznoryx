export function startTrialMaintenance({ service, intervalMs = 60_000, onError = () => {} }) {
  let stopping = false;
  let pending;
  const run = () => {
    if (stopping || pending) return;
    pending = service.processPending().then((result) => {
      for (const item of result.results || []) {
        if (item.errorCode) onError(Object.assign(new Error("Trial maintenance needs attention."), { code: item.errorCode }));
      }
    }).catch(onError).finally(() => { pending = null; });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  run();
  return async () => { stopping = true; clearInterval(timer); await pending; };
}
