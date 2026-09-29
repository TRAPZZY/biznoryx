import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const docker =
  process.env.DOCKER_BIN ?? "docker";

const databaseName = "biznoryx";
const adminUser = "biznoryx_admin";

const runtimePassword =
  process.env.BIZNORYX_APP_DB_PASSWORD;

if (!runtimePassword) {
  throw new Error(
    "BIZNORYX_APP_DB_PASSWORD is required.",
  );
}

const admin = [
  "compose",
  "exec",
  "-T",
  "postgres",
  "psql",
  "-U",
  adminUser,
  "-d",
  databaseName,
  "-v",
  "ON_ERROR_STOP=1",
];

log("Checking local PostgreSQL...");

run([
  "compose",
  "exec",
  "-T",
  "postgres",
  "pg_isready",
  "-U",
  adminUser,
  "-d",
  databaseName,
]);

ensureMigrationTable();

const trackedCount = Number(
  query([
    ...admin,
    "-At",
    "-c",
    "select count(*) from schema_migrations",
  ]),
);

const existingFoundation = query([
  ...admin,
  "-At",
  "-c",
  "select to_regclass('public.app_users') is not null",
]);

if (
  trackedCount === 0 &&
  existingFoundation === "t"
) {
  throw new Error(
    [
      "The local database already contains an untracked BIZNORYX schema.",
      "Do not continue automatically because migrations could be applied twice.",
      "Reset the local development database before running this setup.",
    ].join(" "),
  );
}

const migrations = migrationFiles();

for (const file of migrations) {
  const name =
    file.split(/[\\/]/).at(-1);

  const alreadyApplied = query([
    ...admin,
    "-At",
    "-c",
    `select exists(
       select 1
       from schema_migrations
       where filename = ${sqlLiteral(name)}
     )`,
  ]);

  if (alreadyApplied === "t") {
    log(
      `Skipping ${name} — already applied.`,
    );

    continue;
  }

  log(`Applying ${name}...`);

  run(admin, {
    input: readFileSync(file),
  });

  run([
    ...admin,
    "-c",
    `insert into schema_migrations (filename)
     values (${sqlLiteral(name)})`,
  ]);
}

log(
  "Configuring restricted runtime database role...",
);

run(
  [
    ...admin,
    "-v",
    `biznoryx_app_password=${runtimePassword}`,
    "-f",
    "-",
  ],
  {
    input: readFileSync(
      "db/bootstrap/001_runtime_role.sql",
    ),
  },
);

log("Verifying runtime role...");

const runtimeRole = query([
  "compose",
  "exec",
  "-T",
  "-e",
  `PGPASSWORD=${runtimePassword}`,
  "postgres",
  "psql",
  "-h",
  "127.0.0.1",
  "-U",
  "biznoryx_app",
  "-d",
  databaseName,
  "-At",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  "select current_user",
]);

if (runtimeRole !== "biznoryx_app") {
  throw new Error(
    `Unexpected runtime role: ${runtimeRole}`,
  );
}

log();
log(
  "BIZNORYX local database is ready.",
);
log(`Database: ${databaseName}`);
log(`Runtime role: ${runtimeRole}`);

function ensureMigrationTable() {
  run([
    ...admin,
    "-c",
    `create table if not exists schema_migrations (
       filename text primary key,
       applied_at timestamptz not null default now()
     )`,
  ]);
}

function migrationFiles() {
  return readdirSync("db/migrations")
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        !name.endsWith(".down.sql"),
    )
    .sort()
    .map((name) =>
      join(
        "db",
        "migrations",
        name,
      ),
    );
}

function run(
  args,
  { input } = {},
) {
  const result = spawnSync(
    docker,
    args,
    {
      input,
      encoding: "utf8",

      stdio: input
        ? [
            "pipe",
            "inherit",
            "inherit",
          ]
        : "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}.`,
    );
  }
}

function query(args) {
  const result = spawnSync(
    docker,
    args,
    {
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(
      result.stderr ?? "",
    );

    throw new Error(
      `Database query failed with exit code ${result.status}.`,
    );
  }

  return String(
    result.stdout ?? "",
  ).trim();
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll(
    "'",
    "''",
  )}'`;
}

function log(message = "") {
  process.stdout.write(
    `${message}\n`,
  );
}