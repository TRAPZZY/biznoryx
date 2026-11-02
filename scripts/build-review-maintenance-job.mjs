import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { buildReviewedRecordsRelease } from "./build-reviewed-records-release.mjs";

// Generates a public, reviewable command only. Never reads credentials,
// connects to Northflank/PostgreSQL, creates a job, or activates the release.
export function buildReviewMaintenanceJob({ apply = false } = {}) {
  const certificate = readFileSync(
    new URL("./certs/isrg-root-x1.pem", import.meta.url),
    "utf8",
  );
  const ca = new X509Certificate(certificate);
  if (
    !ca.ca ||
    ca.fingerprint256.replaceAll(":", "").toLowerCase() !==
      "96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6"
  )
    throw new Error("Unexpected public CA certificate");
  const bundle = buildReviewedRecordsRelease();
  const digest = createHash("sha256").update(bundle).digest("hex");
  const check =
    bundle
      .slice(
        bundle.indexOf("begin;"),
        bundle.indexOf("-- Canonical migration:"),
      )
      .replace("begin;", "begin read only;") +
    "select json_build_object('preflight','passed','tls', (select ssl from pg_stat_ssl where pid=pg_backend_pid()));\nrollback;\n";
  const sql = apply ? bundle : check;
  const shell =
    `#!/bin/sh
set -eu
umask 077
: "\${PGHOST:?Bind only the approved production database host}"
: "\${PGPORT:?Bind the private database port}"
: "\${PGDATABASE:?Bind the production database name}"
: "\${PGUSER:?Bind the existing migration administrator username}"
: "\${PGPASSWORD:?Bind its existing private password reference}"
: "\${BIZNORYX_REVIEW_RUNTIME_ROLE:?Supply the verified existing API/worker role name}"
case "$PGHOST" in
  *biznoryx-db-repair*) echo 'REFUSED: test fork is not the production target'; exit 64 ;;
  *biznoryx-db*) ;;
  *) echo 'REFUSED: unexpected database target'; exit 64 ;;
esac
export PGSSLMODE=verify-full PGCONNECT_TIMEOUT=10
export PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=2000'
failure="$(mktemp)"
root_ca="$(mktemp)"
trap 'rm -f "$failure" "$root_ca"' EXIT HUP INT TERM
# Public provider-documented CA; no download, private key or credential is embedded.
cat > "$root_ca" <<'BIZNORYX_PUBLIC_CA'
${certificate}
BIZNORYX_PUBLIC_CA
export PGSSLROOTCERT="$root_ca"
` +
    (apply
      ? `
: "\${BIZNORYX_REVIEW_SNAPSHOT_ID:?Record the freshly verified recovery snapshot ID}"
test "\${BIZNORYX_REVIEW_ROTATION_CONFIRMED:-no}" = yes || {
  echo 'REFUSED: publisher confirmation of credential rotation is missing'; exit 64;
}
`
      : "") +
    `
printf '%s\\n' 'REVIEW_BUNDLE_SHA256=${digest}'
if timeout 120 psql -X -w -q -At -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -v "biznoryx_runtime_role=$BIZNORYX_REVIEW_RUNTIME_ROLE" 2>"$failure" <<'BIZNORYX_REVIEW_SQL'
${sql}
BIZNORYX_REVIEW_SQL
then
  printf '%s\\n' '${apply ? "MIGRATIONS_APPLIED_RELEASE_STILL_OFF" : "READ_ONLY_PREFLIGHT_PASSED"}'
else
  status=$?
  printf '%s\\n' 'MAINTENANCE_FAILED'
  # Do not print libpq connection details, SQL context or customer data.
  for category in 'certificate verify failed' 'does not match host name' 'password authentication failed' 'permission denied' 'timeout expired' '42501' '23514' 'P0001'; do
    if grep -Fiq "$category" "$failure"; then printf 'FAILURE_CATEGORY: %s\\n' "$category"; fi
  done
  exit "$status"
fi
`;
  return {
    mode: apply ? "apply" : "read-only",
    digest,
    shell,
    command:
      "/bin/sh -ceu 'printf %s " +
      Buffer.from(shell).toString("base64") +
      " | base64 -d | /bin/sh'",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const job = buildReviewMaintenanceJob({
    apply: process.argv.includes("--apply"),
  });
  process.stdout.write(
    process.argv.includes("--shell") ? job.shell : job.command + "\n",
  );
}
