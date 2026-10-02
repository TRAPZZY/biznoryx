import {
  spawn,
} from "node:child_process";
import {
  createRequire,
} from "node:module";

const require =
  createRequire(
    import.meta.url,
  );

const playwrightCli =
  require.resolve(
    "@playwright/test/cli",
  );

const port =
  Number(
    process.env.PORT ??
      4186,
  );

const baseURL =
  `http://127.0.0.1:${port}`;

const server =
  spawn(
    process.execPath,
    [
      "scripts/app-server.mjs",
    ],
    {
      env: {
        ...process.env,

        PORT:
          String(
            port,
          ),
      },

      stdio:
        [
          "ignore",
          "inherit",
          "inherit",
        ],
    },
  );

let stopping =
  false;

try {
  await waitForServer(
    baseURL,
  );

  const result =
    await runPlaywright();

  await stopServer();

  process.exit(
    result,
  );
} catch (error) {
  process.stderr.write(
    `${error.message}\n`,
  );

  await stopServer();

  process.exit(
    1,
  );
}

function runPlaywright() {
  return new Promise(
    (
      resolve,
    ) => {
      const child =
        spawn(
          process.execPath,
          [
            playwrightCli,
            "test",
          ],
          {
            env: {
              ...process.env,

              BIZNORYX_SKIP_PLAYWRIGHT_WEBSERVER:
                "1",
            },

            stdio:
              "inherit",
          },
        );

      child.once(
        "exit",
        (
          code,
          signal,
        ) => {
          if (
            signal
          ) {
            resolve(
              1,
            );

            return;
          }

          resolve(
            code ?? 1,
          );
        },
      );
    },
  );
}

async function waitForServer(
  url,
) {
  const startedAt =
    Date.now();

  while (
    Date.now() -
      startedAt <
    15_000
  ) {
    try {
      const response =
        await fetch(
          url,
        );

      if (
        response.ok
      ) {
        return;
      }
    } catch {
      /*
       * Keep waiting until the app has bound
       * the local test port.
       */
    }

    await new Promise(
      (
        resolve,
      ) =>
        setTimeout(
          resolve,
          250,
        ),
    );
  }

  throw new Error(
    `Timed out waiting for ${url}.`,
  );
}

function stopServer() {
  if (
    stopping
  ) {
    return Promise.resolve();
  }

  stopping =
    true;

  if (
    server.exitCode !==
      null ||
    server.signalCode !==
      null
  ) {
    return Promise.resolve();
  }

  return new Promise(
    (
      resolve,
    ) => {
      const forceTimer =
        setTimeout(
          () => {
            server.kill(
              "SIGKILL",
            );

            resolve();
          },
          3_000,
        );

      server.once(
        "exit",
        () => {
          clearTimeout(
            forceTimer,
          );

          resolve();
        },
      );

      server.kill(
        "SIGTERM",
      );
    },
  );
}
