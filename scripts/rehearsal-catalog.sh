#!/bin/sh
set -eu

# Reject inherited credentials before package installation or network access.
if ! awk 'BEGIN {
  for (key in ENVIRON) {
    if (ENVIRON[key] == "") continue;
    if (key ~ /^NF_BIZNORYX_DB_REPAIR_(HOST|PORT|DATABASE|ADMIN_USERNAME|ADMIN_PASSWORD)$/) continue;
    if (key == "PGPASSWORD" || key ~ /^NF_BIZNORYX_DB_/ ||
        key ~ /(^|_)(DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|PASSWORD|SECRET|API_KEY|ACCESS_KEY|ENCRYPTION_KEY|TOKEN)(_|$)/) exit 1;
  }
}' </dev/null; then
  echo 'REFUSED: unrelated credential environment'; exit 64
fi

# Run only in the temporary job with fork-specific Northflank references.
export PGHOST="${NF_BIZNORYX_DB_REPAIR_HOST:?Missing fork host}"
case "$PGHOST" in
  *biznoryx-db-repair*) ;;
  *) echo 'REFUSED: unexpected database host'; exit 64 ;;
esac
export PGPORT="${NF_BIZNORYX_DB_REPAIR_PORT:?Missing fork port}"
export PGDATABASE="${NF_BIZNORYX_DB_REPAIR_DATABASE:?Missing fork database}"
export PGUSER="${NF_BIZNORYX_DB_REPAIR_ADMIN_USERNAME:?Missing fork user}"
export PGPASSWORD="${NF_BIZNORYX_DB_REPAIR_ADMIN_PASSWORD:?Missing fork password}"
export PGSSLMODE=verify-full PGSSLROOTCERT=system PGCONNECT_TIMEOUT=10
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000'

if ! test -s /etc/ssl/certs/ca-certificates.crt; then
  echo 'CLIENT_CA_STORE_MISSING: installing standard Debian CA package in temporary container'
  apt-get update -qq >/tmp/rehearsal-ca-install 2>&1
  apt-get install --no-install-recommends -y ca-certificates >>/tmp/rehearsal-ca-install 2>&1
fi
test -s /etc/ssl/certs/ca-certificates.crt
echo 'CLIENT_CA_STORE_PRESENT'

if psql -X -w -A -t -v ON_ERROR_STOP=1 2>/tmp/rehearsal-catalog-error <<'SQL'
begin read only;
select json_build_object('probe', 'identity', 'version', current_setting('server_version'),
  'ssl', (select ssl from pg_stat_ssl where pid = pg_backend_pid()),
  'read_only', current_setting('transaction_read_only'),
  'superuser', (select rolsuper from pg_roles where rolname = current_user),
  'bypass_rls', (select rolbypassrls from pg_roles where rolname = current_user));
select jsonb_build_object('probe', 'table', 'item', to_jsonb(t))
from (select c.relname as name, pg_get_userbyid(c.relowner) as owner,
  c.relrowsecurity as rls, c.relforcerowsecurity as forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname in (
    'organizations', 'app_users', 'organization_memberships', 'ingestion_runs',
    'processing_jobs', 'subscriptions', 'billing_checkout_sessions', 'billing_payments',
    'billing_trials', 'billing_trial_audit_events', 'manual_entry_drafts',
    'manual_entry_submissions', 'manual_entry_delivery_attempts', 'period_sources',
    'actions', 'findings', 'outcomes', 'organization_features', 'notification_events',
    'notification_recipients', 'notification_preferences')) t order by t.name;
select jsonb_build_object('probe', 'function', 'item', to_jsonb(t))
from (select p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
  pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
  p.proconfig as settings, p.proacl::text as acl, md5(pg_get_functiondef(p.oid)) as definition_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and (
    p.proname like 'runtime_%' or p.proname in ('updates_member', 'deliver_source_updates',
    'enqueue_source_update', 'claim_ingestion_period_source'))) t order by t.name, t.args;
select jsonb_build_object('probe', 'role', 'item', to_jsonb(t))
from (select rolname as name, rolsuper as superuser, rolbypassrls as bypass_rls,
  rolcanlogin as login, rolcreaterole as create_role
  from pg_roles where rolname !~ '^pg_') t order by t.name;
select jsonb_build_object('probe', 'ledger', 'count', count(*), 'last', max(filename),
  'after_0024', coalesce(jsonb_agg(filename order by filename) filter (where filename >= '0025'), '[]'::jsonb))
from schema_migrations;
rollback;
SQL
then
  echo 'CATALOG_PROBE_PASSED'
else
  status=$?
  echo 'CATALOG_PROBE_FAILED'
  for category in 'certificate verify failed' 'does not match host name' \
    'root certificate file' 'SSL error' 'password authentication failed' \
    'could not translate host name' 'Connection refused' 'timeout expired' \
    'no pg_hba.conf entry' 'does not exist' 'permission denied'; do
    if grep -Fiq "$category" /tmp/rehearsal-catalog-error; then
      printf 'FAILURE_CATEGORY: %s\n' "$category"
    fi
  done
  if command -v openssl >/dev/null 2>&1; then
    openssl s_client -starttls postgres -connect "$PGHOST:$PGPORT" \
      -servername "$PGHOST" -verify_return_error -CAfile /etc/ssl/certs/ca-certificates.crt \
      </dev/null >/tmp/rehearsal-tls-result 2>&1 || true
    grep -E 'verify error:num=|Verification error:|Verify return code:' /tmp/rehearsal-tls-result || true
  fi
  exit "$status"
fi
