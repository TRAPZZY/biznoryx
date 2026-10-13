# Retention controls and verified boundaries

## Operator targets, not published commitments

The operator proposed verified account/data deletion within 30 calendar days with prompt access revocation, backups no longer than 30 days, operational/security logs no longer than 90 days unless legally required, and justified minimum financial-record retention. These targets are not evidence that Northflank or third parties already enforce them. Public privacy wording has not been changed to promise these periods.

`deploy/production.manifest.json` declares 30-day PostgreSQL backups, but is not a Northflank account export. The compliance manifest previously asserted implemented retention using its own file as evidence, plus unsupported account/audit schedules. Retention and backup recovery now remain explicitly pending verification. Company evidence/audit records are not interchangeable with container diagnostic logs.

## Available inspection, 12 October 2026

- The workspace database configuration points to local PostgreSQL. No Northflank access token or production object-storage configuration was available. Actual backup schedules, permanently retained/manual/imported backups, object lock/versioning/lifecycle, log drains and scheduled provider cleanup could not be inspected.
- The existing deletion worker revokes access at a verified request, retries cleanup, purges exact object versions, and anonymizes shared-tenant actor identities. This requires inherited migrations/grants and an approved matching deployment; no production deletion occurred in this task.
- Deletion jobs enter `attention` after repeated failures and require an operator response. The maintenance command reports attention/overdue counts without identifiers. It never labels outstanding requests completed.
- The existing closed-workspace finalizer removes tenant billing rows. Financial/legal retention requirements and provider-held records must be assessed before deploying this finalizer; do not assume a guessed accounting period or delete retained billing evidence merely to satisfy a general TTL.

## Implemented credential cleanup

`node scripts/retention-maintenance.mjs` is an operator-only, read-only dry run by default. It uses `DATABASE_URL` through the existing verified-TLS production connection setup. Do not use the application's RLS-limited connection: that can produce misleading zero counts. The command requires a separately approved privileged maintenance connection, never credentials embedded in code or command output.

The explicit `--apply` mode removes at most 500 records from each of two fixed tables per transaction: sessions created more than 90 days ago that are expired or revoked, and verification challenges created more than 90 days ago that have expired. It uses row locks with skip-locked batching, a statement timeout and atomic rollback. Active sessions, unexpired challenges, users, uploads, company audit records and financial records are not modified. The 90-day credential cutoff is not proof of provider-log retention.

Run the dry report, review incident/legal preservation requirements, then separately approve any apply-mode job. Schedule only the approved job in the operator's infrastructure; it has not been scheduled or applied in production here. Exit 2 indicates overdue/attention deletion requests, exit 1 an inspection/cleanup failure, and exit 0 successful execution. Exit 0 does not certify infrastructure retention. Keep maintenance output inside the same operator-approved log retention boundary.

## Provider findings

- Northflank supports backup schedule retention and an indefinite-retain override. A verified 30-day maximum must include every schedule, manual/imported backup, retained override and exported copy, not just a schedule field. [Backup documentation](https://northflank.com/docs/v1/application/databases-and-persistence/backup-restore-and-import-data).
- Northflank documents up to 30 days of container-log retention. External log aggregators and platform audit records need separate inspection; a generic 90-day promise cannot cover unidentified drains. [Container logs](https://northflank.com/docs/v1/application/observe/view-logs).
- Resend's published policy describes 30-day email/log retention on Free, Pro and Scale and up to 90 days for remaining customer data after account termination. A blanket 30-day backup commitment cannot be extended to all Resend-held data from that policy alone. Confirm the actual plan/DPA and request support-assisted deletion where necessary; alternatively disclose verified provider-specific residual retention. [Resend security](https://resend.com/security).
- 3CX's Live Chat documentation places chat data on the PBX instance and describes administrator-controlled auto-deletion. Its generic WebMeeting/transcription policy is not evidence of this live-chat installation's retention. Obtain the PBX purge configuration and backup schedule before stating a duration. [3CX Live Chat](https://www.3cx.com/blog/unified-communications/secure-live-chat/).
- Paystack states some KYC/transaction data remains for statutory obligations after closure, but the cited FAQ does not establish one universal retention period for BIZNORYX. Obtain applicable processor/financial schedules and document the reason, fields and expiry instead of guessing. [Paystack privacy FAQ](https://support.paystack.com/en/articles/2132162).

Do not put a blanket 30-day expiration rule on live organization uploads: it would destroy customers' active historical evidence. Backup expiry, raw-data request deletion and orphan-object reconciliation are separate controls. Preserve a deletion suppression register through backup restoration so erased personal data is not silently reactivated.

Before publishing commitments, require actual account configuration exports, provider confirmations, scheduled-job evidence, successful failure/recovery tests, financial/legal sign-off and proof that restored backups reapply outstanding erasures. No private provider settings were changed by this patch.
