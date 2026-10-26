import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const referenceDatabase = "biznoryx_repair_reference_20261022";

export function buildReferenceRehearsal() {
  const probe = readFileSync(
    join(root, "scripts/rehearsal-catalog.sh"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const marker = "if psql -X -w -A -t -v ON_ERROR_STOP=1";
  if (probe.split(marker).length !== 2)
    throw new Error("Probe boundary changed.");
  const setup = probe.slice(0, probe.indexOf(marker));
  const phases = [];
  const addSql = (label, sql) => {
    const delimiter = `REHEARSAL_SQL_${phases.length}`;
    if (sql.split(/\r?\n/).includes(delimiter))
      throw new Error("SQL delimiter collision.");
    phases.push(`run_sql '${label}' <<'${delimiter}'\n${sql}\n${delimiter}\n`);
  };
  for (const name of sqlFiles("db/migrations").filter(
    (n) => !n.endsWith(".down.sql"),
  )) {
    addSql(
      `migration:${name}`,
      readFileSync(join(root, "db/migrations", name), "utf8"),
    );
  }
  for (const name of sqlFiles("db/bootstrap")) {
    let sql = readFileSync(join(root, "db/bootstrap", name), "utf8");
    if (name === "001_runtime_role.sql") {
      const grants = "grant usage on schema public to biznoryx_app;";
      if (sql.split(grants).length !== 2)
        throw new Error("Runtime grants boundary changed.");
      // Use a non-login rehearsal identity, never bootstrap a password in a job.
      sql = sql.slice(sql.indexOf(grants));
    }
    addSql(`bootstrap:${name}`, sql);
  }
  for (const name of sqlFiles("db/acceptance")) {
    addSql(
      `acceptance:${name}`,
      readFileSync(join(root, "db/acceptance", name), "utf8"),
    );
  }
  const signatures = readFileSync(
    join(root, "db/diagnostics/schema-fingerprints.sql"),
    "utf8",
  );
  return `${setup}
RESTORED_DATABASE="$PGDATABASE"
REFERENCE_DATABASE='${referenceDatabase}'
export PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=2000'
if ! createdb -w --maintenance-db="$RESTORED_DATABASE" --template=template0 "$REFERENCE_DATABASE" 2>/tmp/rehearsal-reference-error; then
  echo 'REFERENCE_REFUSED: could not create a new isolated reference database; never reusing or dropping an existing database'
  exit 65
fi
export PGDATABASE="$REFERENCE_DATABASE"
run_sql() {
  if psql -qXw -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate >/tmp/rehearsal-reference-output 2>/tmp/rehearsal-reference-error; then
    case "$1" in acceptance:*) printf 'REFERENCE_PHASE_PASSED: %s\\n' "$1" ;; esac
  else
    printf 'REFERENCE_PHASE_FAILED: %s\\n' "$1"
    grep -Eo '(ERROR|FATAL):[[:space:]]+[A-Z0-9]{5}' /tmp/rehearsal-reference-error || true
    exit 1
  fi
}
run_sql 'isolated-nonlogin-role' <<'ROLE_SQL'
do $$
begin
  if exists(select 1 from pg_roles where rolname = 'biznoryx_app') then
    raise exception 'Rehearsal role already exists; review before reuse';
  end if;
end $$;
create role biznoryx_app nologin nosuperuser nobypassrls nocreatedb nocreaterole;
grant biznoryx_app to current_user;
ROLE_SQL
${phases.join("\n")}
echo 'REFERENCE_SQL_PHASES_PASSED: ${phases.length + 1}'
psql -qXw -A -t -v ON_ERROR_STOP=1 -v probe_scope=reference <<'REFERENCE_SIGNATURES'
${signatures}
REFERENCE_SIGNATURES
export PGDATABASE="$RESTORED_DATABASE"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000'
psql -qXw -A -t -v ON_ERROR_STOP=1 -v probe_scope=restored <<'RESTORED_SIGNATURES'
${signatures}
RESTORED_SIGNATURES
echo 'REFERENCE_REHEARSAL_PASSED'
`;
}

export function jobCommand(script) {
  const encoded = gzipSync(Buffer.from(script)).toString("base64");
  return `-ceu 'printf %s ${encoded} | base64 -d | gzip -d | /bin/sh'`;
}

export function buildDetailsRehearsal() {
  const probe = readFileSync(
    join(root, "scripts/rehearsal-catalog.sh"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const marker = "if psql -X -w -A -t -v ON_ERROR_STOP=1";
  if (probe.split(marker).length !== 2)
    throw new Error("Probe boundary changed.");
  const setup = probe.slice(0, probe.indexOf(marker));
  const sql = readFileSync(
    join(root, "db/diagnostics/rehearsal-access.sql"),
    "utf8",
  );
  return `${setup}
psql -qXw -A -t -v ON_ERROR_STOP=1 -v probe_scope=restored <<'RESTORED_DETAILS'
${sql}
RESTORED_DETAILS
export PGDATABASE='${referenceDatabase}'
psql -qXw -A -t -v ON_ERROR_STOP=1 -v probe_scope=reference <<'REFERENCE_DETAILS'
${sql}
REFERENCE_DETAILS
echo 'DETAILS_REHEARSAL_PASSED'
`;
}

function sqlFiles(relative) {
  return readdirSync(join(root, relative))
    .filter((n) => n.endsWith(".sql"))
    .sort();
}

export function buildRepairRehearsal(baseline) {
  if (
    !Array.isArray(baseline) ||
    baseline.filter((r) => r.scope === "restored").length <= 20
  ) {
    throw new Error("A verified restored schema baseline is required.");
  }
  const probe = readFileSync(
    join(root, "scripts/rehearsal-catalog.sh"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const marker = "if psql -X -w -A -t -v ON_ERROR_STOP=1";
  if (probe.split(marker).length !== 2)
    throw new Error("Probe boundary changed.");
  const setup = probe.slice(0, probe.indexOf(marker));
  const files = [
    [
      "scripts/rehearse-db-repair.mjs",
      readFileSync(join(root, "scripts/rehearse-db-repair.mjs"), "utf8"),
    ],
    [
      "db/diagnostics/schema-fingerprints.sql",
      readFileSync(
        join(root, "db/diagnostics/schema-fingerprints.sql"),
        "utf8",
      ),
    ],
    [
      "db/repairs/20261022_runtime_ownership.sql",
      readFileSync(
        join(root, "db/repairs/20261022_runtime_ownership.sql"),
        "utf8",
      ),
    ],
    [".rehearsal-baseline.json", JSON.stringify(baseline)],
  ];
  return `${setup}
apt-get install --no-install-recommends -y curl xz-utils >/tmp/rehearsal-client-install 2>&1
mkdir -p /tmp/biznoryx-rehearsal/node /tmp/biznoryx-rehearsal/source
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 \
  https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o /tmp/biznoryx-rehearsal/node.tar.xz
printf '%s\\n' '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  /tmp/biznoryx-rehearsal/node.tar.xz' | sha256sum --check --status
tar -xJf /tmp/biznoryx-rehearsal/node.tar.xz -C /tmp/biznoryx-rehearsal/node --strip-components=1
export PATH="/tmp/biznoryx-rehearsal/node/bin:$PATH"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 \
  https://codeload.github.com/TRAPZZY/biznoryx/tar.gz/ef014a524847914113a81e030f8c1132f0787778 -o /tmp/biznoryx-rehearsal/source.tar.gz
tar -xzf /tmp/biznoryx-rehearsal/source.tar.gz -C /tmp/biznoryx-rehearsal/source --strip-components=1
cd /tmp/biznoryx-rehearsal/source
umask 077
mkdir -p db/diagnostics db/repairs
${files.map(([name, content]) => `printf %s ${Buffer.from(content).toString("base64")} | base64 -d > '${name}'`).join("\n")}
if ! npm ci --ignore-scripts --omit=dev --no-audit --no-fund >/tmp/rehearsal-npm-install 2>&1; then
  echo 'REHEARSAL_DEPENDENCY_INSTALL_FAILED'; exit 1
fi
unset PGOPTIONS
export BIZNORYX_REHEARSAL_CONFIRM=isolated-fork-only
echo 'REHEARSAL_RUNTIME: Node 24.22.1; application ef014a524847914113a81e030f8c1132f0787778'
node scripts/rehearse-db-repair.mjs
`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!["--reference", "--details", "--repair"].includes(process.argv[2])) {
    throw new Error(
      "Use --reference, --details or --repair <baseline.json>; generation never connects to a database.",
    );
  }
  const script =
    process.argv[2] === "--repair"
      ? buildRepairRehearsal(JSON.parse(readFileSync(process.argv[3], "utf8")))
      : process.argv[2] === "--reference"
        ? buildReferenceRehearsal()
        : buildDetailsRehearsal();
  process.stdout.write(jobCommand(script));
}
