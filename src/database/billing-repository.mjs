import { createHash, randomUUID } from "node:crypto";

import { AuthError } from "../auth/core.mjs";
import { monthlyPlanFromEnv } from "../billing/paystack.mjs";
import { withTransaction } from "./postgres.mjs";

export class PostgresBillingRepository {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async ensureSubscription({ organizationId, actorUserId = null, provider = "paystack" }) {
    const plan = monthlyPlanFromEnv();
    const result = await withBillingTenant(this.pool, { organizationId, actorUserId }, async (client) => {
      const existing = await client.query(
        `select id, organization_id, provider, plan_id, plan_name, currency,
                amount_minor, billing_interval, status, checkout_reference,
                trial_ends_at, active_at, current_period_end, created_at,
                updated_at
           from organization_billing_subscriptions
          where organization_id = $1`,
        [organizationId],
      );
      if (existing.rows[0]) return existing.rows[0];
      const inserted = await client.query(
        `insert into organization_billing_subscriptions (
           id, organization_id, provider, plan_id, plan_name, currency,
           amount_minor, billing_interval, status, trial_ends_at,
           created_by_user_id, updated_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'trialing', $9, $10, $10)
         returning id, organization_id, provider, plan_id, plan_name, currency,
                   amount_minor, billing_interval, status, checkout_reference,
                   trial_ends_at, active_at, current_period_end, created_at,
                   updated_at`,
        [
          randomUUID(),
          organizationId,
          provider,
          plan.id,
          plan.name,
          plan.currency,
          plan.amountMinor,
          plan.interval,
          new Date(this.now().getTime() + 14 * 24 * 60 * 60 * 1000),
          actorUserId,
        ],
      );
      return inserted.rows[0];
    });
    return mapSubscription(result);
  }

  async createCheckoutSession({
    organizationId,
    actorUserId,
    provider,
    reference,
    authorizationUrl = null,
    accessCode = null,
    metadata = {}
  }) {
    const plan = monthlyPlanFromEnv();
    const result = await withBillingTenant(this.pool, { organizationId, actorUserId }, async (client) => {
      const checkout = await client.query(
        `insert into billing_checkout_sessions (
           id, organization_id, actor_user_id, provider, reference, status,
           authorization_url, access_code, plan_id, plan_name, currency,
           amount_minor, billing_interval, metadata
         ) values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13)
         returning id, organization_id, actor_user_id, provider, reference,
                   status, authorization_url, access_code, plan_id, plan_name,
                   currency, amount_minor, billing_interval, metadata,
                   completed_at, created_at, updated_at`,
        [
          randomUUID(),
          organizationId,
          actorUserId,
          provider,
          reference,
          authorizationUrl,
          accessCode,
          plan.id,
          plan.name,
          plan.currency,
          plan.amountMinor,
          plan.interval,
          metadata,
        ],
      );
      await client.query(
        `update organization_billing_subscriptions
            set status = 'pending_checkout',
                checkout_reference = $2,
                updated_by_user_id = $3,
                updated_at = $4
          where organization_id = $1`,
        [organizationId, reference, actorUserId, this.now()],
      );
      return checkout.rows[0];
    });
    return mapCheckout(result);
  }

  async applyWebhookEvent({
    organizationId,
    provider = "paystack",
    eventKey,
    eventName,
    reference = null,
    payload,
    action
  }) {
    const payloadSha256 = createHash("sha256").update(payload).digest("hex");
    const result = await withBillingTenant(this.pool, { organizationId, actorUserId: null }, async (client) => {
      const inserted = await client.query(
        `insert into billing_webhook_events (
           id, organization_id, provider, event_key, event_name, reference,
           payload_sha256, action, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
         on conflict (provider, event_key) do nothing
         returning id`,
        [
          randomUUID(),
          organizationId,
          provider,
          eventKey,
          eventName,
          reference,
          payloadSha256,
          action,
        ],
      );
      if (inserted.rowCount === 0) return { duplicate: true };
      await this.applySubscriptionAction(client, {
        organizationId,
        reference,
        action,
      });
      return { duplicate: false };
    });
    return result;
  }

  async applySubscriptionAction(client, { organizationId, reference, action }) {
    const status = new Map([
      ["subscription_activated", "active"],
      ["subscription_renewed", "active"],
      ["subscription_past_due", "past_due"],
      ["subscription_canceled", "canceled"],
      ["subscription_non_renewing", "non_renewing"],
      ["ignored", null],
    ]).get(action);
    if (status === undefined) {
      throw new AuthError("Unsupported billing webhook action.", "VALIDATION_FAILED");
    }
    if (!status) return;
    const now = this.now();
    await client.query(
      `update organization_billing_subscriptions
          set status = $2::billing_subscription_status,
              checkout_reference = coalesce($3, checkout_reference),
              active_at = case
                when $2::billing_subscription_status = 'active'::billing_subscription_status
                then coalesce(active_at, $4)
                else active_at
              end,
              current_period_end = case
                when $2::billing_subscription_status = 'active'::billing_subscription_status
                then $5
                else current_period_end
              end,
              updated_at = $4
        where organization_id = $1`,
      [
        organizationId,
        status,
        reference,
        now,
        new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      ],
    );
    if (reference) {
      await client.query(
        `update billing_checkout_sessions
            set status = 'completed',
                completed_at = coalesce(completed_at, $3),
                updated_at = $3
          where organization_id = $1 and reference = $2`,
        [organizationId, reference, now],
      );
    }
  }
}

export async function withBillingTenant(pool, { organizationId, actorUserId = null }, work) {
  if (!organizationId) {
    throw new AuthError("Organization is required for billing transactions.", "TENANT_CONTEXT_REQUIRED");
  }
  return withTransaction(pool, async (client) => {
    await client.query(
      "select set_config('app.current_organization_id', $1, true)",
      [organizationId],
    );
    if (actorUserId) {
      await client.query("select set_config('app.current_user_id', $1, true)", [
        actorUserId,
      ]);
    }
    return work(client);
  });
}

function mapSubscription(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    planId: row.plan_id,
    planName: row.plan_name,
    currency: row.currency,
    amountMinor: row.amount_minor,
    interval: row.billing_interval,
    status: row.status,
    checkoutReference: row.checkout_reference,
    trialEndsAt: row.trial_ends_at,
    activeAt: row.active_at,
    currentPeriodEnd: row.current_period_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCheckout(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    provider: row.provider,
    reference: row.reference,
    status: row.status,
    authorizationUrl: row.authorization_url,
    accessCode: row.access_code,
    planId: row.plan_id,
    planName: row.plan_name,
    currency: row.currency,
    amountMinor: row.amount_minor,
    interval: row.billing_interval,
    metadata: row.metadata,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
