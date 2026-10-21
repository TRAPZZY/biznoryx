# Action plans workspace

The `/actions` workspace exposes the existing verified-action repositories and
HTTP routes. Owners, admins and analysts can create an action from an active
verified finding. The authenticated actor is the default owner. Viewers can read
but cannot mutate. The server remains authoritative for roles, tenant scope,
finding eligibility, due-date validation and status transitions.

Each action preserves its source finding, metric and reporting period. One
durable action per finding makes a retried create idempotent; changing the title
does not create a second action for the same finding. Accepted findings disappear
from the creation selector. Planned actions can start or cancel; started actions
can block, complete or cancel; blocked actions can resume or cancel. Completed
and cancelled actions are terminal in the existing backend.

The page supports search, status filters, source details, loading, empty, error,
retry, disabled and read-only states. A failed write is not treated as proof that
nothing was saved: refresh before retrying an ambiguous response. Existing status
writes can commit before a downstream outcome refresh fails. This UI does not
change that backend contract or claim an unsaved state after such a failure.

## Boundaries

- No new migration, secret, service, production setting or notification flag.
  Existing migrations 0022/0023 and their grants are prerequisites already used
  by the dashboard. If these are missing, stop rather than replaying migrations.
- No financial outcome, profit, impact or causal attribution is invented. This
  first UI slice deliberately does not expose the existing outcome classifier.
- Steps/resources are an existing free-text description, not a structured budget
  or a verified availability claim. Team reassignment, explicit target acceptance,
  review dates, baseline-version comparison and conservative outcome extensions
  remain separate work. This is not the complete guided-plans roadmap.
- Notifications remain off until separately authorized schema/grant reconciliation
  and isolated-organization activation. Saving an action does not promise an
  email, push notification or scheduled reminder.
- The local review server has no durable actions backend. It truthfully reports
  unavailable; do not seed fake actions into customer dashboards to hide this.

## Verification and release

Run `npm run verify` and `npm run test:browser`. New browser tests explicitly mock
the action HTTP contract with synthetic data, including desktop/mobile creation,
filtering, escaping, status changes, read-only access, failed saves and missing
backend. They do not prove database persistence. The dedicated PostgreSQL CI step
runs `tests/postgres-business-actions.test.mjs` as the restricted runtime role:
real persisted actions and evidence chain, duplicate retries, HTTP CSRF and
session-derived scope, viewer/outsider denial and valid/invalid status changes.
Authentication in that HTTP contract uses a test identity adapter; the separate
native-auth/runtime suites cover the real authentication transport.

Release through the normal reviewed PR/main CI workflow. Observe automatic API
and worker rollout to the merged SHA, public health/readiness, and the new JS/CSS
assets. Keep the prior Northflank builds for runtime rollback; do not run down
migrations or change customer actions. Live authenticated customer writes and
physical Android behavior are unverified unless separately exercised safely.
