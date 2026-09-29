import {
  randomBytes,
} from "node:crypto";

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";

import {
  join,
} from "node:path";

import {
  spawnSync,
} from "node:child_process";

const docker =
  process.env.DOCKER_BIN ??
  "docker";

const databaseName =
  `biznoryx_runtime_${randomBytes(6).toString("hex")}`;

const runtimePassword =
  process.env
    .BIZNORYX_APP_DB_PASSWORD ??
  readLocalEnvironmentValue(
    "BIZNORYX_APP_DB_PASSWORD",
  );

if (
  !runtimePassword
) {
  throw new Error(
    "BIZNORYX_APP_DB_PASSWORD must be configured in the environment or .env.local before running the PostgreSQL acceptance suite.",
  );
}

const admin = [
  "compose",
  "exec",
  "-T",
  "postgres",
  "psql",
  "-U",
  "biznoryx_admin",
];

try {
  run([
    ...admin,

    "-d",
    "postgres",

    "-v",
    "ON_ERROR_STOP=1",

    "-c",
    `create database ${databaseName}`,
  ]);

  for (
    const file of
      sqlFiles(
        "db/migrations",
      ).filter(
        (
          name,
        ) =>
          !name.endsWith(
            ".down.sql",
          ),
      )
  ) {
    run(
      [
        ...admin,

        "-d",
        databaseName,

        "-v",
        "ON_ERROR_STOP=1",

        "-f",
        "-",
      ],
      {
        input:
          readFileSync(
            file,
          ),
      },
    );
  }

  for (
    const file of
      sqlFiles(
        "db/bootstrap",
      )
  ) {
    run(
      [
        ...admin,

        "-d",
        databaseName,

        "-v",
        "ON_ERROR_STOP=1",

        "-v",
        `biznoryx_app_password=${runtimePassword}`,

        "-f",
        "-",
      ],
      {
        input:
          readFileSync(
            file,
          ),
      },
    );
  }

  const test =
    spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",

        "tests/postgres-runtime.test.mjs",

        "tests/postgres-business-onboarding.test.mjs",

        "tests/postgres-data-ingestion.test.mjs",

        "tests/postgres-processing-worker.test.mjs",

        "tests/postgres-verified-metrics.test.mjs",

        "tests/postgres-metric-comparisons.test.mjs",

        "tests/postgres-performance-findings.test.mjs",

        "tests/postgres-business-actions.test.mjs",
      ],
      {
        encoding:
          "utf8",

        env: {
          ...process.env,

          TEST_DATABASE_URL:
            `postgresql://biznoryx_app:${encodeURIComponent(
              runtimePassword,
            )}@127.0.0.1:5432/${databaseName}`,
        },
      },
    );

  process.stdout.write(
    test.stdout ??
      "",
  );

  process.stderr.write(
    test.stderr ??
      "",
  );

  if (
    test.status !==
    0
  ) {
    process.exitCode =
      test.status ??
      1;
  }
} finally {
  run(
    [
      ...admin,

      "-d",
      "postgres",

      "-v",
      "ON_ERROR_STOP=1",

      "-c",
      `drop database if exists ${databaseName} with (force)`,
    ],
    {
      allowFailure:
        true,
    },
  );
}

function run(
  args,
  {
    input,
    allowFailure = false,
  } = {},
) {
  const result =
    spawnSync(
      docker,
      args,
      {
        input,

        stdio:
          input
            ? [
                "pipe",
                "inherit",
                "inherit",
              ]
            : "inherit",
      },
    );

  if (
    !allowFailure &&
    result.status !==
      0
  ) {
    process.exit(
      result.status ??
      1,
    );
  }
}

function sqlFiles(
  directory,
) {
  return readdirSync(
    directory,
  )
    .filter(
      (
        name,
      ) =>
        name.endsWith(
          ".sql",
        ),
    )
    .sort()
    .map(
      (
        name,
      ) =>
        join(
          directory,
          name,
        ),
    );
}

function readLocalEnvironmentValue(
  key,
) {
  const file =
    ".env.local";

  if (
    !existsSync(
      file,
    )
  ) {
    return null;
  }

  const contents =
    readFileSync(
      file,
      "utf8",
    );

  for (
    const rawLine of
      contents.split(
        /\r?\n/,
      )
  ) {
    const line =
      rawLine.trim();

    if (
      !line ||
      line.startsWith(
        "#",
      )
    ) {
      continue;
    }

    const separator =
      line.indexOf(
        "=",
      );

    if (
      separator <
      1
    ) {
      continue;
    }

    const currentKey =
      line
        .slice(
          0,
          separator,
        )
        .trim();

    if (
      currentKey !==
      key
    ) {
      continue;
    }

    let value =
      line
        .slice(
          separator +
            1,
        )
        .trim();

    if (
      value.length >=
        2 &&
      (
        (
          value.startsWith(
            '"',
          ) &&
          value.endsWith(
            '"',
          )
        ) ||
        (
          value.startsWith(
            "'",
          ) &&
          value.endsWith(
            "'",
          )
        )
      )
    ) {
      value =
        value.slice(
          1,
          -1,
        );
    }

    return value ||
      null;
  }

  return null;
}