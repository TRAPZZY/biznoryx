export function createWorkerHealthProbe({
  repository,
  maxAgeSeconds = 30,
}) {
  if (!repository) {
    throw new TypeError(
      "Worker repository is required.",
    );
  }

  if (
    !Number.isInteger(
      maxAgeSeconds,
    ) ||
    maxAgeSeconds < 5 ||
    maxAgeSeconds > 300
  ) {
    throw new TypeError(
      "Worker heartbeat age is invalid.",
    );
  }

  return async function workerHealthProbe() {
    const healthy =
      await repository
        .hasHealthyWorker({
          maxAgeSeconds,
        });

    if (!healthy) {
      throw new Error(
        "No healthy production worker heartbeat is available.",
      );
    }

    return true;
  };
}