import { createHash, randomUUID } from "node:crypto";

import { AuthError, CAPABILITIES, ROLE_CAPABILITIES } from "../auth/core.mjs";
import { monthlyPlanFromEnv } from "../billing/paystack.mjs";
import { withTransaction } from "./postgres.mjs";

export class PostgresBillingRepository {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
    this.trials = new PostgresTrialRepository(pool, { now });
  }

  async organizationForSubscription({ providerSubscriptionCode }) {
    if (typeof providerSubscriptionCode !== "string" || !providerSubscriptionCode || providerSubscriptionCode.length > 160) {
      return null;
    }
    const result = await this.pool.query(
      "select runtime_paystack_subscription_organization($1) as organization_id",
      [providerSubscriptionCode],
    );
    return result.rows[0]?.organization_id ?? null;
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
          if (current.status === "trialing" && planIsStale && !current.provider_subscription_code) {
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
                  and not exists (select 1 from billing_trials where organization_id = $1)
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

    const subscription = mapSubscription(result);
    const trial = await this.trials.get({ organizationId });
    subscription.trial = trial ? {
      status: trial.status, cardSetup: { verified: Boolean(trial.cardVerifiedAt) },
      providerProvisioned: Boolean(trial.subscriptionCode && trial.provisionStatus === "confirmed" &&
        trial.subscriptionCode === subscription.providerSubscriptionCode),
      startedAt: trial.startedAt, endsAt: trial.endsAt, canceledAt: trial.canceledAt,
      convertedAt: trial.convertedAt,
    } : null;
    return subscription;
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
        const membership = await client.query(
          `select role from organization_memberships
            where organization_id = $1 and user_id = $2 and status = 'active'`,
          [organizationId, actorUserId],
        );
        if (!ROLE_CAPABILITIES[membership.rows[0]?.role]?.includes(CAPABILITIES.MANAGE_ORGANIZATION)) {
          throw new AuthError("Organization owner access is required to start billing.", "ORG_ACCESS_DENIED");
        }
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
                and (status not in ('active', 'non_renewing')
                     or current_period_end is null or current_period_end <= $10)
                and not exists (
                  select 1 from billing_trials trial
                   where trial.organization_id = $1
                     and trial.converted_at is null
                     and ((trial.canceled_at is null and trial.state->>'verificationStatus' = 'pending') or
                          trial.ends_at > $10 or
                          (trial.state->>'provisionStatus' = 'attempted' and trial.canceled_at is null) or
                          (trial.provider_subscription_code is not null and trial.canceled_at is null))
                )
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
      normalizedReference.startsWith("bnx_trial_") ||
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
    paidAt = null,
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

        const applied = await this.applySubscriptionAction(client, {
          organizationId,
          reference,
          action,
          providerCustomerCode,
          providerSubscriptionCode,
          providerEmailToken,
          paidAt,
        });

        return {
          duplicate: false,
          action: applied === false ? "ignored" : action,
        };
      },
    );

    return result;
  }

  async cancelSubscription({ organizationId, actorUserId, providerSubscriptionCode = null, providerEmailToken = null }) {
    const result = await withBillingTenant(
      this.pool,
      { organizationId, actorUserId },
      async (client) => {
        const updated = await client.query(
          `update organization_billing_subscriptions
              set status = 'non_renewing',
                  provider_subscription_code = coalesce($4, provider_subscription_code),
                  provider_email_token = coalesce($5, provider_email_token),
                  cancellation_requested_at = coalesce(cancellation_requested_at, $3),
                  updated_by_user_id = coalesce($2, updated_by_user_id),
                  updated_at = $3
            where organization_id = $1
              and status in ('active', 'past_due')
              and (provider_subscription_code is null or $4::text is null or provider_subscription_code = $4)
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
          [organizationId, actorUserId, this.now(), providerSubscriptionCode, providerEmailToken],
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

  async renewSubscription({
    organizationId,
    actorUserId,
    providerSubscriptionCode = null,
    providerEmailToken = null,
  }) {
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
                      provider_subscription_code =
                        coalesce(
                          $3,
                          provider_subscription_code
                        ),
                      provider_email_token =
                        coalesce(
                          $4,
                          provider_email_token
                        ),
                      updated_by_user_id =
                        coalesce(
                          $2,
                          updated_by_user_id
                        ),
                      updated_at = $5
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
          [
            organizationId,
            actorUserId,
            providerSubscriptionCode,
            providerEmailToken,
            this.now(),
          ],
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
      paidAt = null,
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
      return false;
    }

    const now = this.now();

    const currentResult = await client.query(
      `select provider_subscription_code, checkout_reference, status, current_period_end
         from organization_billing_subscriptions
        where organization_id = $1
        for update`,
      [organizationId],
    );
    const current = currentResult.rows[0];
    if (!current) return false;

    // Verification charges and scheduled subscription notifications are never paid activation.
    if (reference?.startsWith("bnx_trial_")) return false;
    if (status === "active") {
      const trial = await client.query(
        `select id from billing_trials where organization_id = $1
          and converted_at is null and provider_subscription_code = $2`,
        [organizationId, providerSubscriptionCode],
      );
      if (trial.rowCount && !paidAt) return false;
      if (trial.rowCount) {
        const payment = await client.query(
          `select id from billing_payments where organization_id = $1 and reference = $2
             and amount_minor = (select amount_minor from organization_billing_subscriptions where organization_id = $1)
             and currency = (select currency from organization_billing_subscriptions where organization_id = $1)`,
          [organizationId, reference],
        );
        if (!payment.rowCount) return false;
      }
    }

    // Lifecycle notifications may only change the subscription currently bound to this tenant.
    if (status !== "active" && (!providerSubscriptionCode || providerSubscriptionCode !== current.provider_subscription_code)) {
      return false;
    }

    let pendingCheckout = false;
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
        return false;
      }
      pendingCheckout = existing.rows[0]?.status === "pending" &&
        current.status === "pending_checkout" && current.checkout_reference === reference;
    }

    if (status === "active" && !pendingCheckout &&
        (!providerSubscriptionCode || providerSubscriptionCode !== current.provider_subscription_code)) {
      return false;
    }

    const paymentDate = paidAt == null ? now : new Date(paidAt);
    if (!Number.isFinite(paymentDate.getTime())) {
      throw new AuthError("Payment date is invalid.", "VALIDATION_FAILED");
    }
    const paidThrough = new Date(paymentDate);
    const billingDay = Math.min(paymentDate.getUTCDate(), 28);
    paidThrough.setUTCDate(1);
    paidThrough.setUTCMonth(paidThrough.getUTCMonth() + 1);
    paidThrough.setUTCDate(billingDay);

    if (status === "active" && !pendingCheckout && current.current_period_end &&
        paidThrough <= new Date(current.current_period_end)) return false;

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
        paidThrough,
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
    return true;
  }
}

// Session advisory locks serialize requests and recovery across processes. Each
// save commits independently so a provider timeout cannot erase mutation intent.
export class PostgresTrialRepository {
  constructor(pool, { now = () => new Date() } = {}) {
    this.pool = pool;
    this.now = now;
  }

  async withLock({ organizationId, actorUserId = null, owner = true }, work) {
    if (!organizationId) throw new AuthError("Organization is required.", "TENANT_CONTEXT_REQUIRED");
    const client = await this.pool.connect();
    let locked = false;
    let broken = false;
    const scopedPool = {
      async connect() { return { query: client.query.bind(client), release() {} }; },
    };
    const scoped = new PostgresTrialRepository(scopedPool, { now: this.now });
    scoped.billing = new PostgresBillingRepository(scopedPool, { now: this.now });
    try {
      const lock = await client.query(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
        [`billing-trial:${organizationId}`],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new AuthError("A billing operation is already running. Please retry.", "BILLING_OPERATION_IN_PROGRESS");
      if (actorUserId) await scoped.authorize({ organizationId, actorUserId, owner });
      return await work(scoped);
    } finally {
      if (locked) {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`billing-trial:${organizationId}`]);
        } catch { broken = true; }
      }
      client.release(broken);
    }
  }

  async authorize({ organizationId, actorUserId, owner = false }) {
    if (!actorUserId) throw new AuthError("An authenticated actor is required.", "ORG_ACCESS_DENIED");
    return withBillingTenant(this.pool, { organizationId, actorUserId }, async (client) => {
      const result = await client.query(
        `select membership.role from organization_memberships membership
           join organizations org on org.id = membership.organization_id
           join app_users usr on usr.id = membership.user_id
          where membership.organization_id = $1 and membership.user_id = $2
            and membership.status = 'active' and org.disabled_at is null and usr.disabled_at is null`,
        [organizationId, actorUserId],
      );
      const capabilities = ROLE_CAPABILITIES[result.rows[0]?.role];
      if (!capabilities || (owner && !capabilities.includes(CAPABILITIES.MANAGE_ORGANIZATION))) {
        throw new AuthError("Organization billing access is required.", "ORG_ACCESS_DENIED");
      }
    });
  }

  async get({ organizationId }) {
    return withBillingTenant(this.pool, { organizationId }, async (client) => {
      const result = await client.query(
        `select id, state, card_verified_at, started_at, ends_at, canceled_at, converted_at,
                provider_subscription_code from billing_trials where organization_id = $1`,
        [organizationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { ...row.state, id: row.id, cardVerifiedAt: row.card_verified_at,
        startedAt: row.started_at, endsAt: row.ends_at, canceledAt: row.canceled_at,
        convertedAt: row.converted_at, subscriptionCode: row.provider_subscription_code };
    });
  }

  async save({ organizationId, actorUserId = null, trial, eventType }) {
    return withBillingTenant(this.pool, { organizationId, actorUserId }, async (client) => {
      const result = await client.query(
        `insert into billing_trials (id, organization_id, reference, provider_subscription_code,
          card_verified_at, started_at, ends_at, canceled_at, converted_at, state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (organization_id) do update set
          provider_subscription_code = excluded.provider_subscription_code,
          card_verified_at = excluded.card_verified_at, started_at = excluded.started_at,
          ends_at = excluded.ends_at, canceled_at = excluded.canceled_at,
          converted_at = excluded.converted_at, state = excluded.state,
          version = billing_trials.version + 1, updated_at = $11
         where billing_trials.reference = excluded.reference
         returning id, version`,
        [trial.id, organizationId, trial.reference, trial.subscriptionCode ?? null,
          trial.cardVerifiedAt ?? null, trial.startedAt ?? null, trial.endsAt ?? null,
          trial.canceledAt ?? null, trial.convertedAt ?? null, trial, this.now()],
      );
      if (!result.rowCount) throw new AuthError("A trial already exists.", "BILLING_TRIAL_INELIGIBLE");
      await client.query(
        `insert into billing_trial_audit (organization_id, trial_id, actor_user_id, version, event_type, metadata)
         values ($1,$2,$3,$4,$5,$6)`,
        [organizationId, trial.id, actorUserId, result.rows[0].version, eventType,
          { reference: trial.reference, status: trial.status, refundStatus: trial.refundStatus }],
      );
    });
  }

  async hasPaidHistory({ organizationId }) {
    return withBillingTenant(this.pool, { organizationId }, async (client) => {
      const result = await client.query(
        `select 1 from organization_billing_subscriptions where organization_id = $1
          and (active_at is not null or status in ('active','non_renewing','past_due','pending_checkout')
               or provider_subscription_code is not null)
         union all select 1 from billing_payments where organization_id = $1 limit 1`,
        [organizationId],
      );
      return result.rowCount > 0;
    });
  }

  async publishSubscription({ organizationId, actorUserId = null, trial }) {
    return withBillingTenant(this.pool, { organizationId, actorUserId }, async (client) => {
      const result = await client.query(
        `update organization_billing_subscriptions set status = 'trialing',
          provider_customer_code = $2, provider_subscription_code = $3,
          trial_ends_at = $4, updated_at = $5
         where organization_id = $1 and active_at is null
          and status in ('trialing','pending_checkout','canceled')
          and (provider_subscription_code is null or provider_subscription_code = $3)
         returning id`,
        [organizationId, trial.customerCode, trial.subscriptionCode, trial.endsAt, this.now()],
      );
      if (!result.rowCount) throw new AuthError("Subscription changed during trial setup.", "BILLING_TRIAL_INELIGIBLE");
    });
  }

  async resolve({ reference = null, subscriptionCode = null }) {
    const result = await this.pool.query("select runtime_paystack_trial_organization($1,$2) as organization_id", [reference, subscriptionCode]);
    return result.rows[0]?.organization_id ?? null;
  }

  async pendingOrganizations({ limit = 100 } = {}) {
    const result = await this.pool.query("select organization_id from runtime_pending_trial_organizations($1)", [limit]);
    return result.rows.map((row) => row.organization_id);
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
