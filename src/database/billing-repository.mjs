import { createHash, randomUUID } from "node:crypto";

import { AuthError } from "../auth/core.mjs";
import { monthlyPlanFromEnv } from "../billing/paystack.mjs";
import { withTransaction } from "./postgres.mjs";

export class PostgresBillingRepository {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async ensureSubscription({
    organizationId,
    actorUserId = null,
    provider = "paystack",
  }) {
    const plan = monthlyPlanFromEnv();

    const result = await withBillingTenant(
      this.pool,
      { organizationId, actorUserId },
      async (client) => {
        const existing = await client.query(
          `select id, organization_id, provider, provider_customer_code,
                  provider_subscription_code, provider_email_token,
                  cancellation_requested_at,
                  plan_id, plan_name, currency,
                  amount_minor, billing_interval, status, checkout_reference,
                  trial_ends_at, active_at, current_period_end, created_at,
                  updated_at
             from organization_billing_subscriptions
            where organization_id = $1`,
          [organizationId],
        );

        if (existing.rows[0]) {
          const current = existing.rows[0];

          const planIsStale =
            current.provider !== provider ||
            current.plan_id !== plan.id ||
            current.plan_name !== plan.name ||
            String(current.currency).toUpperCase() !==
              String(plan.currency).toUpperCase() ||
            Number(current.amount_minor) !== Number(plan.amountMinor) ||
            current.billing_interval !== plan.interval;

          /*
           * Only unpaid trial subscriptions are automatically
           * reconciled with the current BIZNORYX plan.
           *
           * This means an old $20 trial will automatically
           * become the current ₦40,000 NGN plan.
           *
           * Active customers are never silently repriced.
           */
          if (current.status === "trialing" && planIsStale) {
            const updated = await client.query(
              `update organization_billing_subscriptions
                  set provider = $2,
                      plan_id = $3,
                      plan_name = $4,
                      currency = $5,
                      amount_minor = $6,
                      billing_interval = $7,
                      updated_by_user_id =
                        coalesce($8, updated_by_user_id),
                      updated_at = $9
                where organization_id = $1
                  and status = 'trialing'
                returning id, organization_id, provider,
                          provider_customer_code,
                          provider_subscription_code,
                          provider_email_token,
                          cancellation_requested_at,
                          plan_id, plan_name, currency,
                          amount_minor, billing_interval,
                          status, checkout_reference,
                          trial_ends_at, active_at,
                          current_period_end, created_at,
                          updated_at`,
              [
                organizationId,
                provider,
                plan.id,
                plan.name,
                plan.currency,
                plan.amountMinor,
                plan.interval,
                actorUserId,
                this.now(),
              ],
            );

            return updated.rows[0] ?? current;
          }

          return current;
        }

        const inserted = await client.query(
          `insert into organization_billing_subscriptions (
             id,
             organization_id,
             provider,
             plan_id,
             plan_name,
             currency,
             amount_minor,
             billing_interval,
             status,
             trial_ends_at,
             created_by_user_id,
             updated_by_user_id
           )
           values (
             $1,
             $2,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8,
             'trialing',
             $9,
             $10,
             $10
           )
           returning id,
                     organization_id,
                     provider,
                     provider_customer_code,
                     provider_subscription_code,
                     provider_email_token,
                     cancellation_requested_at,
                     plan_id,
                     plan_name,
                     currency,
                     amount_minor,
                     billing_interval,
                     status,
                     checkout_reference,
                     trial_ends_at,
                     active_at,
                     current_period_end,
                     created_at,
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
      },
    );

    return mapSubscription(result);
  }

  async createCheckoutSession({
    organizationId,
    actorUserId,
    provider,
    reference,
    authorizationUrl = null,
    accessCode = null,
    metadata = {},
  }) {
    const plan = monthlyPlanFromEnv();

    const result = await withBillingTenant(
      this.pool,
      { organizationId, actorUserId },
      async (client) => {
        const checkout = await client.query(
          `insert into billing_checkout_sessions (
             id,
             organization_id,
             actor_user_id,
             provider,
             reference,
             status,
             authorization_url,
             access_code,
             plan_id,
             plan_name,
             currency,
             amount_minor,
             billing_interval,
             metadata
           )
           values (
             $1,
             $2,
             $3,
             $4,
             $5,
             'pending',
             $6,
             $7,
             $8,
             $9,
             $10,
             $11,
             $12,
             $13
           )
           returning id,
                     organization_id,
                     actor_user_id,
                     provider,
                     reference,
                     status,
                     authorization_url,
                     access_code,
                     plan_id,
                     plan_name,
                     currency,
                     amount_minor,
                     billing_interval,
                     metadata,
                     completed_at,
                     created_at,
                     updated_at`,
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

        /*
         * Synchronize the subscription with the exact plan
         * being used for the checkout.
         *
         * This prevents a stale USD subscription from being
         * paired with a new NGN checkout.
         */
        const subscriptionUpdate = await client.query(
          `update organization_billing_subscriptions
                set provider = $4,
                    plan_id = $5,
                    plan_name = $6,
                    currency = $7,
                    amount_minor = $8,
                    billing_interval = $9,
                    status = 'pending_checkout',
                    checkout_reference = $2,
                    updated_by_user_id = $3,
                    updated_at = $10
              where organization_id = $1
                and status <> 'active'
              returning id`,
          [
            organizationId,
            reference,
            actorUserId,
            provider,
            plan.id,
            plan.name,
            plan.currency,
            plan.amountMinor,
            plan.interval,
            this.now(),
          ],
        );

        /*
         * Do not accidentally replace an already-active
         * customer's commercial terms.
         *
         * Throwing here rolls back the checkout insert because
         * this entire operation runs in one transaction.
         */
        if (subscriptionUpdate.rowCount !== 1) {
          throw new AuthError(
            "An active subscription does not require a new checkout.",
            "VALIDATION_FAILED",
          );
        }

        return checkout.rows[0];
      },
    );

    return mapCheckout(result);
  }

  async recordPayment({
    organizationId,
    provider = "paystack",
    reference,
    status,
    amountMinor,
    currency,
    channel = null,
    paidAt,
  }) {
    const normalizedReference = String(reference ?? "").trim();
    const normalizedCurrency = String(currency ?? "")
      .trim()
      .toUpperCase();
    const normalizedChannel =
      channel == null || String(channel).trim() === ""
        ? null
        : String(channel).trim();
    const paymentDate = new Date(paidAt);

    if (
      provider !== "paystack" ||
      !normalizedReference ||
      normalizedReference.length > 160 ||
      status !== "success" ||
      !Number.isSafeInteger(Number(amountMinor)) ||
      Number(amountMinor) <= 0 ||
      !/^[A-Z]{3}$/.test(normalizedCurrency) ||
      (normalizedChannel && normalizedChannel.length > 80) ||
      !Number.isFinite(paymentDate.getTime())
    ) {
      throw new AuthError(
        "Verified billing payment details are invalid.",
        "VALIDATION_FAILED",
      );
    }

    const row = await withBillingTenant(
      this.pool,
      { organizationId },
      async (client) => {
        const inserted = await client.query(
          `insert into billing_payments (
             organization_id,
             provider,
             reference,
             status,
             amount_minor,
             currency,
             channel,
             paid_at
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (provider, reference) do nothing
           returning id, organization_id, provider, reference, status,
                     amount_minor, currency, channel, paid_at, created_at`,
          [
            organizationId,
            provider,
            normalizedReference,
            status,
            Number(amountMinor),
            normalizedCurrency,
            normalizedChannel,
            paymentDate,
          ],
        );

        if (inserted.rows[0]) {
          return inserted.rows[0];
        }

        const existing = await client.query(
          `select id, organization_id, provider, reference, status,
                  amount_minor, currency, channel, paid_at, created_at
             from billing_payments
            where organization_id = $1
              and provider = $2
              and reference = $3
            limit 1`,
          [organizationId, provider, normalizedReference],
        );

        if (!existing.rows[0]) {
          throw new AuthError(
            "Billing payment reference is already associated with another workspace.",
            "BILLING_REFERENCE_CONFLICT",
          );
        }

        return existing.rows[0];
      },
    );

    return mapPayment(row);
  }

  async listPayments({ organizationId, actorUserId, limit = 50 }) {
    const safeLimit = Number.isInteger(limit)
      ? Math.max(1, Math.min(limit, 100))
      : 50;

    const result = await withBillingTenant(
      this.pool,
      { organizationId, actorUserId },
      (client) =>
        client.query(
          `select id, organization_id, provider, reference, status,
                  amount_minor, currency, channel, paid_at, created_at
             from billing_payments
            where organization_id = $1
            order by paid_at desc, id desc
            limit $2`,
          [organizationId, safeLimit],
        ),
    );

    return result.rows.map(mapPayment);
  }

  async applyWebhookEvent({
    organizationId,
    provider = "paystack",
    eventKey,
    eventName,
    reference = null,
    payload,
    action,
    providerCustomerCode = null,
    providerSubscriptionCode = null,
    providerEmailToken = null,
  }) {
    const payloadSha256 = createHash("sha256").update(payload).digest("hex");

    const result = await withBillingTenant(
      this.pool,
      {
        organizationId,
        actorUserId: null,
      },
      async (client) => {
        const inserted = await client.query(
          `insert into billing_webhook_events (
             id,
             organization_id,
             provider,
             event_key,
             event_name,
             reference,
             payload_sha256,
             action,
             metadata
           )
           values (
             $1,
             $2,
             $3,
             $4,
             $5,
             $6,
             $7,
             $8,
             '{}'::jsonb
           )
           on conflict (provider, event_key)
           do nothing
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

        if (inserted.rowCount === 0) {
          return {
            duplicate: true,
          };
        }

        await this.applySubscriptionAction(client, {
          organizationId,
          reference,
          action,
          providerCustomerCode,
          providerSubscriptionCode,
          providerEmailToken,
        });

        return {
          duplicate: false,
        };
      },
    );

    return result;
  }

  async cancelSubscription({ organizationId, actorUserId }) {
    const result = await withBillingTenant(
      this.pool,
      { organizationId, actorUserId },
      async (client) => {
        const updated = await client.query(
          `update organization_billing_subscriptions
              set status = 'non_renewing',
                  cancellation_requested_at = coalesce(cancellation_requested_at, $3),
                  updated_by_user_id = coalesce($2, updated_by_user_id),
                  updated_at = $3
            where organization_id = $1
              and status in ('active', 'past_due')
            returning id, organization_id, provider,
                      provider_customer_code,
                      provider_subscription_code,
                      provider_email_token,
                      cancellation_requested_at,
                      plan_id, plan_name, currency,
                      amount_minor, billing_interval,
                      status, checkout_reference,
                      trial_ends_at, active_at,
                      current_period_end, created_at,
                      updated_at`,
          [organizationId, actorUserId, this.now()],
        );

        if (updated.rows[0]) {
          return updated.rows[0];
        }

        const current = await client.query(
          `select id, organization_id, provider,
                  provider_customer_code,
                  provider_subscription_code,
                  provider_email_token,
                  cancellation_requested_at,
                  plan_id, plan_name, currency,
                  amount_minor, billing_interval,
                  status, checkout_reference,
                  trial_ends_at, active_at,
                  current_period_end, created_at,
                  updated_at
             from organization_billing_subscriptions
            where organization_id = $1
            limit 1`,
          [organizationId],
        );

        if (!current.rows[0]) {
          throw new AuthError(
            "Billing subscription was not found.",
            "NOT_FOUND",
          );
        }

        return current.rows[0];
      },
    );

    return mapSubscription(result);
  }

  async renewSubscription({ organizationId, actorUserId }) {
    const result = await withBillingTenant(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        const updated = await client.query(
          `update organization_billing_subscriptions
                  set status = 'active',
                      cancellation_requested_at = null,
                      updated_by_user_id =
                        coalesce(
                          $2,
                          updated_by_user_id
                        ),
                      updated_at = $3
                where organization_id = $1
                  and status = 'non_renewing'
                returning id,
                          organization_id,
                          provider,
                          provider_customer_code,
                          provider_subscription_code,
                          provider_email_token,
                          cancellation_requested_at,
                          plan_id,
                          plan_name,
                          currency,
                          amount_minor,
                          billing_interval,
                          status,
                          checkout_reference,
                          trial_ends_at,
                          active_at,
                          current_period_end,
                          created_at,
                          updated_at`,
          [organizationId, actorUserId, this.now()],
        );

        if (updated.rows[0]) {
          return updated.rows[0];
        }

        const existing = await client.query(
          `select id,
                      organization_id,
                      provider,
                      provider_customer_code,
                      provider_subscription_code,
                      provider_email_token,
                      cancellation_requested_at,
                      plan_id,
                      plan_name,
                      currency,
                      amount_minor,
                      billing_interval,
                      status,
                      checkout_reference,
                      trial_ends_at,
                      active_at,
                      current_period_end,
                      created_at,
                      updated_at
                 from organization_billing_subscriptions
                where organization_id = $1
                limit 1`,
          [organizationId],
        );

        if (!existing.rows[0]) {
          throw new AuthError(
            "Billing subscription was not found.",
            "NOT_FOUND",
          );
        }

        if (existing.rows[0].status === "active") {
          return existing.rows[0];
        }

        throw new AuthError(
          "Only a non-renewing subscription can resume renewal.",
          "VALIDATION_FAILED",
        );
      },
    );

    return mapSubscription(result);
  }

  async applySubscriptionAction(
    client,
    {
      organizationId,
      reference,
      action,
      providerCustomerCode = null,
      providerSubscriptionCode = null,
      providerEmailToken = null,
    },
  ) {
    const status = new Map([
      ["subscription_activated", "active"],
      ["subscription_renewed", "active"],
      ["subscription_past_due", "past_due"],
      ["subscription_canceled", "canceled"],
      ["subscription_non_renewing", "non_renewing"],
      ["ignored", null],
    ]).get(action);

    if (status === undefined) {
      throw new AuthError(
        "Unsupported billing webhook action.",
        "VALIDATION_FAILED",
      );
    }

    if (!status) {
      return;
    }

    const now = this.now();

    if (reference) {
      const existing = await client.query(
        `select id, status, completed_at
           from billing_checkout_sessions
           where organization_id = $1
             and reference = $2
           limit 1`,
        [organizationId, reference],
      );

      if (existing.rows[0]?.status === "completed") {
        return;
      }
    }

    await client.query(
      `update organization_billing_subscriptions
          set status =
                $2::billing_subscription_status,

              provider_customer_code =
                coalesce(
                  $6,
                  provider_customer_code
                ),

              provider_subscription_code =
                coalesce(
                  $7,
                  provider_subscription_code
                ),

              provider_email_token =
                coalesce(
                  $8,
                  provider_email_token
                ),

              checkout_reference =
                coalesce(
                  $3,
                  checkout_reference
                ),

              active_at =
                case
                  when
                    $2::billing_subscription_status =
                    'active'::billing_subscription_status
                  then
                    coalesce(
                      active_at,
                      $4
                    )
                  else
                    active_at
                end,

              current_period_end =
                case
                  when
                    $2::billing_subscription_status =
                    'active'::billing_subscription_status
                  then
                    $5
                  else
                    current_period_end
                end,

              updated_at = $4

        where organization_id = $1`,
      [
        organizationId,
        status,
        reference,
        now,
        new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        providerCustomerCode,
        providerSubscriptionCode,
        providerEmailToken,
      ],
    );

    if (reference) {
      await client.query(
        `update billing_checkout_sessions
            set status = 'completed',
                completed_at =
                  coalesce(
                    completed_at,
                    $3
                  ),
                updated_at = $3
          where organization_id = $1
            and reference = $2`,
        [organizationId, reference, now],
      );
    }
  }
}

export async function withBillingTenant(
  pool,
  { organizationId, actorUserId = null },
  work,
) {
  if (!organizationId) {
    throw new AuthError(
      "Organization is required for billing transactions.",
      "TENANT_CONTEXT_REQUIRED",
    );
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

    providerCustomerCode: row.provider_customer_code,

    providerSubscriptionCode: row.provider_subscription_code,

    providerEmailToken: row.provider_email_token,

    cancellationRequestedAt: row.cancellation_requested_at,

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

function mapPayment(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    reference: row.reference,
    status: row.status,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    channel: row.channel,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}
