import { AuthError, CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import { withTenantTransaction } from "./postgres.mjs";
import { updateItem, updateOptions } from "../notifications/updates.mjs";

export class PostgresUpdatesRepository {
  constructor(pool) { this.pool = pool; }

  async scoped(scope, work) {
    return withTenantTransaction(this.pool, scope, async client => {
      const membership = await client.query(`select m.role from organization_memberships m
        join organizations o on o.id = m.organization_id and o.disabled_at is null
        join app_users u on u.id = m.user_id and u.disabled_at is null
        where m.organization_id = $1 and m.user_id = $2 and m.status = 'active'`, [scope.organizationId, scope.actorUserId]);
      if (!ROLE_CAPABILITIES[membership.rows[0]?.role]?.includes(CAPABILITIES.READ_BUSINESS_DATA)) {
        throw new AuthError("Business access is required.", "ORG_ACCESS_DENIED");
      }
      const schema = await client.query("select to_regclass('public.organization_features') as feature_table");
      if (!schema.rows[0]?.feature_table) return work(client, false);
      const feature = await client.query("select enabled from organization_features where organization_id = $1 and feature_key = 'in_app_updates'", [scope.organizationId]);
      return work(client, feature.rows[0]?.enabled === true);
    });
  }

  async list(input) {
    const { filter, category, offset, limit } = updateOptions(input);
    return this.scoped(input, async (client, enabled) => {
      if (!enabled) return { enabled: false, items: [], unreadCount: 0 };
      const snapshot = await client.query("select now() as snapshot_at");
      const result = await client.query(`select e.*, r.read_at, r.snoozed_until, rp.label as period_label
        from notification_events e join notification_recipients r on r.event_id = e.id and r.organization_id = e.organization_id
        join ingestion_runs ir on ir.id = e.ingestion_run_id and ir.organization_id = e.organization_id
        join reporting_periods rp on rp.id = ir.reporting_period_id and rp.organization_id = ir.organization_id
        where e.organization_id = $1 and r.user_id = $2
          and ($3 = 'all' or ($3 = 'unread' and r.read_at is null and (r.snoozed_until is null or r.snoozed_until <= now()))
            or ($3 = 'snoozed' and r.snoozed_until > now()))
          and ($4 = 'all' or ($4 = 'reports' and e.kind = 'report_ready') or ($4 = 'data' and e.kind = 'upload_attention'))
        order by e.created_at desc, e.id desc limit $5 offset $6`,
      [input.organizationId, input.actorUserId, filter, category, limit + 1, offset]);
      const count = await client.query(`select count(*)::integer as unread from notification_recipients
        where organization_id = $1 and user_id = $2 and read_at is null and (snoozed_until is null or snoozed_until <= now())`,
      [input.organizationId, input.actorUserId]);
      const preferences = await client.query("select category, enabled from notification_preferences where organization_id = $1 and user_id = $2", [input.organizationId, input.actorUserId]);
      return { enabled: true, items: result.rows.slice(0, limit).map(updateItem), hasMore: result.rows.length > limit,
        unreadCount: count.rows[0].unread, snapshotAt: snapshot.rows[0].snapshot_at,
        preferences: Object.fromEntries(["reports", "data"].map(key => [key, preferences.rows.find(p => p.category === key)?.enabled ?? true])) };
    });
  }

  async setState(input) {
    return this.scoped(input, async (client, enabled) => {
      requireEnabled(enabled);
      const { id, action, until } = input.change;
      const result = await client.query(`update notification_recipients
        set read_at = case when $4 = 'read' then now() when $4 = 'unread' then null else read_at end,
            snoozed_until = case when $4 = 'snooze' then $5::timestamptz else snoozed_until end
        where organization_id = $1 and user_id = $2 and event_id = $3 returning event_id`,
      [input.organizationId, input.actorUserId, id, action, until ?? null]);
      if (!result.rows.length) throw new AuthError("Update was not found.", "NOT_FOUND");
      return { saved: true };
    });
  }

  async markAllRead(input) {
    return this.scoped(input, async (client, enabled) => {
      requireEnabled(enabled);
      await client.query(`update notification_recipients r set read_at = now()
        from notification_events e where e.id = r.event_id and e.organization_id = r.organization_id
        and r.organization_id = $1 and r.user_id = $2 and r.read_at is null and e.created_at <= $3`,
      [input.organizationId, input.actorUserId, input.through]);
      return { saved: true };
    });
  }

  async setPreference(input) {
    return this.scoped(input, async (client, enabled) => {
      requireEnabled(enabled);
      await client.query(`insert into notification_preferences(organization_id, user_id, category, enabled)
        values ($1, $2, $3, $4) on conflict (organization_id, user_id, category)
        do update set enabled = excluded.enabled, updated_at = now()`,
      [input.organizationId, input.actorUserId, input.preference.category, input.preference.enabled]);
      return { saved: true };
    });
  }
}

function requireEnabled(enabled) {
  if (!enabled) throw new AuthError("Updates are not enabled for this business.", "SERVICE_UNAVAILABLE");
}
