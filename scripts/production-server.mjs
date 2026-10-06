import {
  checkDatabaseHealth,
  createPostgresPool,
} from "../src/database/postgres.mjs";
import { validateProductionEnvironment } from "../src/release/readiness.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

const production =
  process.env.NODE_ENV === "production";

if (production) {
  const validation =
    validateProductionEnvironment(
      process.env,
    );

  if (validation.state !== "ready") {
    for (const finding of validation.findings) {
      process.stderr.write(
        `[production-config] ${finding.message}\n`,
      );
    }

    throw new Error(
      "Production environment configuration is not ready.",
    );
  }
}

const port = parsePort(
  process.env.PORT ?? "4175",
);

const host =
  process.env.HOST ??
  (production
    ? "0.0.0.0"
    : "127.0.0.1");

const pool = createPostgresPool();

const { server, runtime } =
  createProductionApp({
    pool,
    production,
  });

let shuttingDown = false;

async function start() {
  /*
   * Fail startup immediately if PostgreSQL
   * cannot be reached.
   */
  const database =
    await checkDatabaseHealth(pool);

  process.stdout.write(
    `PostgreSQL connected: ${database.database}\n`,
  );

  await new Promise(
    (resolve, reject) => {
      server.once("error", reject);

      server.listen(
        port,
        host,
        () => {
          server.off(
            "error",
            reject,
          );

          resolve();
        },
      );
    },
  );

  process.stdout.write(
    `BIZNORYX production runtime listening on http://${host}:${port}\n`,
  );
}

async function shutdown(
  signal,
  exitCode = 0,
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  process.stdout.write(
    `Received ${signal}. Beginning graceful shutdown.\n`,
  );

  runtime.healthChecks.beginDraining();

  const forceTimer = setTimeout(
    () => {
      process.stderr.write(
        "Graceful shutdown deadline exceeded.\n",
      );

      process.exit(1);
    },
    10_000,
  );

  forceTimer.unref();

  try {
    if (server.listening) {
      await new Promise(
        (resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        },
      );
    }

    await pool.end();

    clearTimeout(forceTimer);

    process.stdout.write(
      "BIZNORYX runtime stopped cleanly.\n",
    );

    process.exitCode =
      exitCode;
  } catch (error) {
    clearTimeout(forceTimer);

    process.stderr.write(
      `Shutdown failed: ${error.message}\n`,
    );

    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on(
  "unhandledRejection",
  (error) => {
    const message =
      error instanceof Error
        ? error.stack ??
          error.message
        : String(error);

    process.stderr.write(
      `Unhandled rejection: ${message}\n`,
    );

    void shutdown(
      "unhandledRejection",
      1,
    );
  },
);

process.on(
  "uncaughtException",
  (error) => {
    process.stderr.write(
      `Uncaught exception: ${
        error.stack ??
        error.message
      }\n`,
    );

    void shutdown(
      "uncaughtException",
      1,
    );
  },
);

try {
  await start();
} catch (error) {
  process.stderr.write(
    `BIZNORYX startup failed: ${
      error.stack ??
      error.message
    }\n`,
  );

  await pool.end().catch(
    () => undefined,
  );

  process.exitCode = 1;
}

function parsePort(value) {
  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 65_535
  ) {
    throw new Error(
      "PORT must be an integer between 1 and 65535.",
    );
  }

  return parsed;
}
