export async function processSourceDeletionBatch({ pool, objectStorage }) {
  const schema = await pool.query(
    "select to_regprocedure('public.claim_source_file_deletions(integer)') as ready"
  );

  if (!schema.rows[0]?.ready) return 0;

  const claimed = await pool.query(
    "select id, organization_id, storage_key, lease_token, attempts from claim_source_file_deletions($1)",
    [5]
  );

  let completed = 0;

  for (const item of claimed.rows) {
    const org = String(item.organization_id);
    const key = String(item.storage_key ?? "");

    const owned =
      key.startsWith("organizations/" + org + "/uploads/") ||
      key.startsWith("org/" + org + "/raw/");

    let success = false;
    let errorCode = null;

    try {
      if (!owned) {
        errorCode = "KEY_REJECTED";
      } else {
        await objectStorage.deleteObject({ key });
        success = true;
      }
    } catch {
      errorCode = "STORAGE_ERROR";
    }

    const attempt = Number(item.attempts ?? 1);
    const retry = Math.min(3600, 30 * 2 ** Math.min(7, attempt - 1));

    const response = await pool.query(
      "select finish_source_file_deletion($1,$2,$3,$4,$5) as acknowledged",
      [
        item.id,
        item.lease_token,
        success,
        errorCode,
        success ? 0 : retry
      ]
    );

    if (success && response.rows[0]?.acknowledged) completed++;
  }

  return completed;
}

export function startSourceDeletionMaintenance({
  pool, objectStorage, onError = () => {}, intervalMs = 15000
}) {
  let stopped = false;
  let running = null;

  function tick() {
    if (stopped || running) return;

    running = processSourceDeletionBatch({ pool, objectStorage })
      .catch(() => {
        onError(new Error("SOURCE_DELETION_RECONCILIATION_FAILED"));
      })
      .finally(() => { running = null; });
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
