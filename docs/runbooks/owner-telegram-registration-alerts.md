# Platform-owner Telegram registration alerts

Status: **implementation proposed; production OFF**. This is a private operator integration,
not a customer Updates notification and not an Android push or customer data export.

## Trigger and lifecycle

A PostgreSQL trigger on `app_users.email_verified_at` creates one outbox record in
the same transaction as **the first** successful verification, only when an
administrator-enabled singleton setting is active. Repeat verification,
logins, failed verification, disabled configuration and rolled-back
verification create no event. Unique `user_id` prevents repeats.

The worker leases up to five due events with `FOR UPDATE SKIP LOCKED`,
sends an HTTPS Telegram Bot API `sendMessage` to a fixed private destination,
and acknowledges the matching lease token. Retries have bounded backoff; five
attempts become dead. A send can succeed even if its network response or
database acknowledgement is lost, so delivery is **at-least-once** rather than
provably exactly-once across Telegram and PostgreSQL. Repeated messages in this
rare situation do not create duplicate accounts or events.

The message includes only a verified timestamp and product name; no email,
name, organization, password, OTP, session, or customer records are sent.

## Configuration

Only the separate Northflank **worker** needs the protected settings:

- `OWNER_ALERTS_ENABLED=false` (safe default; change to true only after approval)
- `OWNER_TELEGRAM_BOT_TOKEN` (replacement token from BotFather, never paste in chat)
- `OWNER_TELEGRAM_CHAT_ID` (private chat ID; send /start to the bot first)

The worker does not emit tokens or Telegram error bodies. No webhook or
public trigger endpoint exists. Missing/invalid active configuration logs only
`OWNER_ALERT_CONFIG_INVALID` and leaves the unrelated worker running.

The bot token previously disclosed in chat must be revoked in BotFather.
Do **not** use it.

## Production release prerequisites (not authorized by code merge)

1. Inspect actual deployed API and worker commits, live database migration
   ledger, backup/restore readiness, and the actual restricted worker DB role.
2. Rehearse migration `db/migrations/0039_platform_owner_registration_alerts.sql`
   against disposable PostgreSQL and check table ACLs, effective inherited
   privileges, and trigger owner identity. Migration installs the singleton
   **disabled** and grants neither table nor function access to public clients.
3. Obtain separate production migration approval. Apply the migration using an
   authorized owner; it does **not** change existing verification/account rows.
4. Identify the actual **worker** role. The code intentionally does not guess
   a database role or grant PUBLIC privileges. Approve and apply only:
   ```sql
   -- Replace <observed_worker_role> with the actual SQL-quoted role name.
   -- Do not run until the operator has verified role membership/least privilege.
   grant execute on function claim_platform_owner_registration_alerts(integer)
     to <observed_worker_role>;
   grant execute on function finish_platform_owner_registration_alert(uuid,uuid,boolean,text,integer)
     to <observed_worker_role>;
   ```
   No direct table SELECT/UPDATE/INSERT permission is needed by the worker.
   Existing provider default privileges must be inspected for excess access.
5. Deploy compatible reviewed worker; configure secrets through Northflank.
   Do not print their values.
6. After separate owner approval, activate the **database collection gate**:
   ```sql
   begin;
   update platform_owner_alert_settings set enabled = true, updated_at = now()
     where singleton = true and enabled = false;
   commit;
   ```
   Then set the worker's `OWNER_ALERTS_ENABLED=true` and verify worker startup.
7. Perform one isolated real registration with a consented test address and
   confirm **one** Telegram message. Verify disabled/invalid token behavior,
   no customer impact, and no unbounded queue growth. Check dead events using
   operator-only database access.
8. Emergency disable: set worker `OWNER_ALERTS_ENABLED=false` and
   `platform_owner_alert_settings.enabled=false` in a privileged transaction.
   Already leased requests may complete. The additive schema remains in place.

Do not run the destructive `.down.sql` against production history.

## Read-only operator checks after migration

```sql
select enabled, updated_at from platform_owner_alert_settings;
select status, count(*), min(created_at) as oldest
  from platform_owner_registration_alerts group by status;
select count(*) as dead_count
  from platform_owner_registration_alerts where status = 'dead';
```

Do not expose rows or user IDs to a public dashboard.

## Verification and rollback

Run `npm run verify`, `npm run test:browser`, and on a disposable admin
PostgreSQL environment `tests/postgres-owner-registration-alerts.test.mjs`.
Mocks must not call Telegram in CI. Merge code independently of production SQL
approval. The usual prior worker build is the runtime rollback; disable the
two gates first. Report actual CI/deployment status rather than assuming that a
merged PR is serving live traffic.
