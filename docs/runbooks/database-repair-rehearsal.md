# Database repair rehearsal record

## Verified boundary

The owner requested repair of the existing notification implementation, not a
replacement. Preserve the current production API/worker, all customer evidence,
authentication, subscription states and original source files. Current upstream
main was last verified as ef014a524847914113a81e030f8c1132f0787778 (PR 20). The original unfinished
checkout and unrelated worktrees are not repair targets.

The Northflank supported fork procedure was checked against its official docs:
https://northflank.com/docs/v1/application/databases-and-persistence/fork-an-addon

The new independent addon `biznoryx-db-repair` uses source `biznoryx-db`, explicit
disk snapshot `biznoryx-preflight-20261021`, PostgreSQL major version 18, one
nf-compute-20 instance, 512 MB, 6 GB NVMe, private networking and TLS. It was paused
on 2026-10-26 and must remain paused under the owner's latest instruction.
No in-place production restore was submitted. The production application is not
connected to this copy. No raw customer records or credentials belong in this
repository, test logs, screenshots of secret screens or GitHub evidence.

## Cost and permissions

The owner approved the quoted $0.0088/hour / $6.31/month base rate and a $1
compute/storage authorization budget, with no auto-resize. On 2026-10-26 the
provider displayed $1.02 ($0.87 deployment and $0.15 volume), exceeding that budget.
The fork was paused to contain further compute cost. The owner declined another
$1 and instructed local work only. Storage remains billable while paused;
tax, transfer and additional backup billing remain unverified.
Never represent an authorization budget as an automatic cloud spending cap.

CLI access was approved only for this fork. The existing selectable token role
is Owner, which is not authorized. No CLI token or RBAC role was created or saved;
the pending login was cancelled. Do not use a broad role merely because it is
available, expose the database publicly, or route rehearsal load through the
production application process.

The owner approved and the agent created manual job `biznoryx-db-rehearsal`.
No reusable build service was offered by the UI, so it uses the official
`postgres:18` client image without another build. Its initial command is
`psql --version`, not the image's database-server command. A runtime-only secret
group `biznoryx-db-rehearsal-only` links only the fork's connection fields and is
restricted to that single job, not either production service. That group itself
omits production, payment and email credentials. However, the separate existing
`biznoryx-production` group is unrestricted and also injects production values
into the job. The repair guard rejected that resolved environment before any
repair SQL. The job is therefore NOT credential-isolated. The owner explicitly
instructed that the production group remain unchanged. Approved rate: $0.25/1,000 run-minutes,
up to 60 run-minutes ($0.015 compute estimate), within the combined $1 budget.
No schedule, image-change runs or retries; 600-second per-run deadline. This
resource approval has been received. Separate deletion approval is required for
the temporary resources and secret group after evidence is saved.

## Work still required

1. Before any future cloud run, obtain renewed resource authorization and establish
   job-only credential isolation without changing the production secret group.
   Verify resolved values, not only the fork group's restrictions. Fail closed on a
   production hostname, unexpected database identity, insecure TLS or wrong addon.
   Do not print URLs, passwords, session tokens or connection-string errors.
2. Read catalogs, functions, owners, policies, grants, constraints, indexes and
   migration ledger; compare exact definitions with migrations 0025-0033. Presence
   or a ledger entry alone does not prove equivalence. Do not mark history blindly.
3. Snapshot counts/integrity evidence without exporting customer data. State-changing
   functional fixtures must be new synthetic users/organizations on the fork only.
4. Rehearse independently reviewed payment-history, trial-function, RLS-role and
   notification changes. Preserve genuine subscriptions; disclose the existing
   0025 checkout-history backfill rather than substituting an empty guessed table.
5. Prove non-owner/non-BYPASSRLS behavior, definer-function ownership, missing and
   foreign tenant contexts, API/session/CSRF compatibility and worker delivery.
6. Run full applicable verification on disposable databases or synthetic fixtures.
   Do not point the fresh-database acceptance runner at the restored app database:
   it replays every migration and is not a reconciliation tool. Do not weaken local
   isolation guards in tests to make them run against a cloud copy.
7. Prepare exact production SQL, lock/availability assessment, compatibility proof,
   approved fresh production snapshot and recovery procedure. STOP for explicit
   approval before any production SQL, role/grant or connection/settings operation.
8. After approved repair, leave all organizations disabled. Obtain separate approval
   for one isolated test organization before activating or generating live events.

The existing migration 0033 has no historical notification backfill and no enabled
organization rows. Runtime grants target named roles that were absent in the prior
production catalog. Do not replay the full ledger or grant to PUBLIC. Unknown
function ownership and owner-bypassed RLS require rehearsal, not blind FORCE RLS.

## Current result

The fork exists and is paused. Read-only SQL access and a fresh-schema reference
rehearsal succeeded on 2026-10-22. The restored source repair, original-customer-data
preservation proof, restored-fork functional tests, production SQL and notification
activation are NOT complete. The preceding checkpoint was local-only. The latest
request authorizes GitHub delivery and a safe production release, but does not
remove the declined spending authorization, unchanged production secret-group
boundary or the existing exact-production-SQL and scoped-activation gates.
The production worker's later five-restart/crash warning needs separate scoped
diagnosis; historical trial 42501 errors alone do not prove its cause. Public
health/readiness 200 is not evidence that the worker or every business feature is
healthy. Record exact pass/fail/skip counts only after executing the relevant checks.

## Completed evidence

On 2026-10-22, reference run `a8888e33-076a-4427-af4e-2bfa2bb136e6`
applied 34 forward migrations, 12 grant scripts and 15 SQL acceptance scripts to
a newly created empty database inside the fork cluster. Including role setup,
all 62 phases passed. This did not repair the restored source database.

Catalog comparison recorded 59 selected reference/restored signatures and 14
differing objects: missing billing history and notification objects, missing
provider-identity index/helper, outdated session helper, audit policies and
notification indexes/triggers. Later manual/trial objects existed despite a
ledger ending at 0024. The actual runtime owned early tables, bypassing their RLS,
and lacked trial helper grants. Presence alone was not treated as migration proof.

Repair run `057e8974-9290-48ae-9dd2-1ae14bfd2866` stopped at its configuration
guard because unrelated production credentials were present. It did not connect
to or repair the source database. Logs disclosed no credential values.

On 2026-10-26, local tooling was tightened to reject inherited database aliases,
email/payment/storage/signing credentials and tokens before downloads, dependency
installation or SQL. No production secret-group values or scope were changed.
Runtime privilege and disabled-feature assertions now precede the repair commit.

Docker provided a disposable PostgreSQL 18 cluster bound only to loopback port
55438 with tmpfs storage and synthetic credentials/data. Existing local containers,
volumes and databases were not reused or reset. Results:

- Canonical schema: all 61 SQL phases passed (34 migrations, 12 bootstraps,
  15 acceptance scripts).
- Canonical runtime: 13 checks passed, no failures/skips.
- Canonical manual entry, trial and Updates: 17 checks passed, no failures/skips.
- Synthetic drift reconstruction: 4 checks passed, including rollback of the
  ownership repair, canonical schema equivalence, unchanged seeded organizations,
  existing checkout payment backfill and restricted runtime tenant boundaries.
- Repaired synthetic runtime: 13 checks passed, no failures/skips.
- Repaired synthetic manual entry, trial and Updates: 17 checks passed, no
  failures/skips. Notification enablement in these tests was synthetic/local only.
- `npm run verify`: format, lint, typecheck, migration/security checks and build
  passed; 397 tests passed, zero failed, 17 skipped without database environment
  variables. Applicable PostgreSQL checks were separately executed above.
- Seven focused rehearsal-tool checks passed, including executable early secret
  rejection with no value disclosure. These are included in the 397-test result.
- The earlier 2026-10-22 browser run passed 52 tests. It was not repeated for
  this operations-only continuation; no frontend or application code changed.

The opt-in repair test is `tests/postgres-database-repair.test.mjs`, selected by
`LOCAL_DB_REPAIR_TEST_URL`. It requires an empty isolated local cluster and exact
database name `biznoryx_local_repair_test`, refuses non-loopback hosts and connection
overrides, and creates a separate canonical reference. It never accepts the cloud
fork URL or production credentials. The cloud runner's fork/TLS guards remain intact.

Local logs are outside Git in
`C:/Users/traph/.codex/backups/biznoryx-db-repair-20261021/evidence/` with
`local-*-20261026.log` and `repaired-*-20261026.log` names. Synthetic reconstruction
does not establish preservation of the restored customer's data, exact provider
privileges, production lock behavior, recovery readiness or a successful live
notification activation. Those remain required before a production repair proposal.

## Release continuation

On 2026-10-26, GitHub main and the Northflank API/worker were rechecked at
`ef014a524847914113a81e030f8c1132f0787778`. Both services showed Running with five
historical restarts and a crash-warning indicator. The cause is still unverified;
do not classify those warnings as resolved. Public `/healthz` and `/readyz`
returned HTTP 200, which does not demonstrate notification or worker correctness.
Worker log entries observed on 2026-10-26 still contain both
`runtime_pending_trial_organizations` failures and SQLSTATE `42501` at recurring
one-minute intervals. This is an ongoing trial-maintenance failure, not merely
the historical restart indicator. No customer data or credential values were
copied into this record.

The local ownership draft now rejects privilege escalation through preexisting
application-group memberships, including CREATEDB access. The added negative test
proves the entire change rolls back. The updated synthetic repair has five passing
checks; together with seven tooling checks the focused run passed 12 with no skips.

The acceptance workflow now gives synthetic repair its own disposable PostgreSQL
18 service, separate from the canonical acceptance job. It runs the guarded
tooling, synthetic repair and the existing 30 database-backed runtime/manual/trial/
Updates checks against the repaired synthetic schema. No Northflank credentials,
real customer records, environment secrets or cloud-fork access are used by CI.
The private baseline filename is ignored by Git. This workflow never deploys SQL
or activates production notifications. CI status must be checked on the actual PR.

A GitHub merge would automatically trigger production builds. There is no runtime
application change in this repair-tooling branch. Do not trigger a production
restart merely to publish a rehearsal script or represent a merge as a schema fix.
The restored-fork rehearsal remains blocked by its declined additional budget and
unresolved inherited-credential environment. No production repair, global feature
enablement, resource deletion or paid-fork resume has been performed.

Final local review also tightened schema equality: unexpected or duplicate object
signatures now fail before the repair transaction commits. Only the explicitly
partial historical baseline comparison accepts additional catalog objects. The
regression check passed; tooling now has eight passing checks. Final full local
verification passed 398 tests, zero failed, 17 skipped in the no-database run.
