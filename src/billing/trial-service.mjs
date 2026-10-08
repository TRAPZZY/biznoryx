import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { AuthError } from "../auth/core.mjs";
import { monthlyPlanFromEnv, verifyPaystackWebhookSignature } from "./paystack.mjs";
import { TrialPaystackProvider } from "./trial-provider.mjs";
import { TrialReminderEmailSender } from "./trial-email-sender.mjs";

const DAY = 86_400_000;
const TERMS_VERSION = "seven-day-card-trial-v1";
const fail = (message, code = "VALIDATION_FAILED") => { throw new AuthError(message, code); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const iso = (value) => value == null ? null : new Date(value).toISOString();
const metadata = (value) => {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

export function trialConfiguration(env = process.env) {
  const plan = monthlyPlanFromEnv(env);
  const amount = Number(env.BIZNORYX_TRIAL_VERIFICATION_AMOUNT_MINOR);
  const encodedKey = String(env.BIZNORYX_BILLING_ENCRYPTION_KEY ?? "");
  const key = Buffer.from(encodedKey, "base64");
  let origin;
  try { origin = new URL(env.BIZNORYX_PUBLIC_URL ?? env.PUBLIC_APP_URL); } catch { origin = null; }
  if (!plan.providerConfigured || !Number.isSafeInteger(amount) || amount <= 0 || amount >= plan.amountMinor ||
      key.length !== 32 || key.toString("base64") !== encodedKey ||
      !origin || origin.username || origin.password || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(env.NODE_ENV !== "production" && origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)))) {
    fail("Trial billing configuration is incomplete or invalid.", "BILLING_PROVIDER_NOT_CONFIGURED");
  }
  return { plan, verificationAmountMinor: amount, key, origin: origin.origin };
}

export function encryptTrialAuthorization(value, { key, organizationId, reference }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${organizationId}:${reference}:v1`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") };
}

export function decryptTrialAuthorization(value, { key, organizationId, reference }) {
  try {
    if (value?.v !== 1) throw new Error("Unsupported version");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(`${organizationId}:${reference}:v1`));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8"));
  } catch { fail("Billing authorization could not be decrypted.", "BILLING_PROVIDER_NOT_CONFIGURED"); }
}

export function publicTrial(trial, { configured, eligible, actorUserId, verificationAmountMinor, currency = "NGN", now = () => new Date() }) {
  const end = trial?.endsAt ? new Date(trial.endsAt).getTime() : null;
  const expired = end !== null && end <= now().getTime();
  return {
    eligible, configured,
    checkoutReference: trial?.reference ?? null,
    canStartCheckout: Boolean(configured && (eligible || (trial?.actorUserId === actorUserId &&
      trial.verificationStatus === "pending" && !trial.cardVerifiedAt && !trial.canceledAt))),
    canVerify: Boolean(configured && trial && !trial.canceledAt && !trial.convertedAt && !expired &&
      ["pending_checkout", "trialing"].includes(trial.status)),
    status: trial?.convertedAt ? "converted" : expired ? "expired" : trial?.status ?? "eligible",
    cardSetup: { verified: Boolean(trial?.cardVerifiedAt), verifiedAt: iso(trial?.cardVerifiedAt) },
    startedAt: iso(trial?.startedAt), endsAt: iso(trial?.endsAt),
    firstBillingDate: iso(trial?.firstBillingDate), canceledAt: iso(trial?.canceledAt),
    convertedAt: iso(trial?.convertedAt),
    providerProvisioned: Boolean(trial?.subscriptionCode && trial.provisionStatus === "confirmed"),
    paymentUpdateAvailable: Boolean(trial?.paymentUpdateRequired && trial?.subscriptionCode && !trial?.canceledAt),
    canCancel: Boolean(trial && !trial.convertedAt && !trial.canceledAt &&
      (trial.subscriptionCode || trial.provisionStatus === "attempted")),
    verificationAmountMinor: trial?.verificationAmountMinor ?? verificationAmountMinor ?? null,
    currency: trial?.currency ?? currency,
    verificationCharge: { status: trial?.verificationStatus ?? "not_started", reference: trial?.reference ?? null },
    refundStatus: trial?.refundStatus ?? "not_required",
    cancellationStatus: trial?.cancelStatus ?? "not_requested",
    paymentUpdateRequired: Boolean(trial?.paymentUpdateRequired),
    recoveryRequired: trial?.provisionStatus === "attempted" || trial?.refundStatus === "attempted" ||
      trial?.cancelStatus === "requested" || trial?.status === "setup_failed",
    daysRemaining: end === null ? 0 : Math.max(0, Math.ceil((end - now().getTime()) / DAY)),
    termsVersion: TERMS_VERSION,
  };
}

export class SevenDayTrialService {
  constructor({ billingRepository, env = process.env, fetchImpl = fetch, now = () => new Date(), provider, emailSender } = {}) {
    if (!billingRepository?.trials) fail("Trial repository is required.", "SERVICE_UNAVAILABLE");
    this.billing = billingRepository;
    this.repository = billingRepository.trials;
    this.env = env;
    this.now = now;
    this.provider = provider ?? new TrialPaystackProvider({ env, fetchImpl });
    this.fetchImpl = fetchImpl;
    this.emailSender = emailSender ?? new TrialReminderEmailSender({ apiKey: env.RESEND_API_KEY,
      from: env.BIZNORYX_EMAIL_FROM ?? env.RESEND_FROM, fetchImpl });
  }

  configuration() { return trialConfiguration(this.env); }
  assertActor(actorUserId) { if (!actorUserId) fail("An authenticated actor is required.", "ORG_ACCESS_DENIED"); }
  async getTrial({ organizationId, actorUserId }) {
    this.assertActor(actorUserId);
    await this.repository.authorize({ organizationId, actorUserId });
    return this.view(organizationId, undefined, actorUserId);
  }
  async view(organizationId, trial, actorUserId) {
    let config;
    try { config = this.configuration(); } catch (error) {
      if (error.code !== "BILLING_PROVIDER_NOT_CONFIGURED") throw error;
    }
    trial ??= await this.repository.get({ organizationId });
    return publicTrial(trial, {
      configured: Boolean(config), eligible: !trial && !(await this.repository.hasPaidHistory({ organizationId })),
      verificationAmountMinor: config?.verificationAmountMinor, now: this.now, actorUserId,
    });
  }
  billingFor(repo) { return repo?.billing ?? this.billing; }
  async response(organizationId, actorUserId, trial, repo) {
    return { trial: await this.view(organizationId, trial, actorUserId),
      subscription: await this.billingFor(repo).ensureSubscription({ organizationId, actorUserId }) };
  }
  seal(value, trial, config) {
    return encryptTrialAuthorization(value, { key: config.key, organizationId: trial.organizationId, reference: trial.reference });
  }
  unseal(trial, config) {
    return decryptTrialAuthorization(trial.authorization, { key: config.key, organizationId: trial.organizationId, reference: trial.reference });
  }

  async startCheckout({ organizationId, actorUserId, email, callbackUrl, consent }) {
    this.assertActor(actorUserId);
    const config = this.configuration();
    if (consent !== true) fail("Accept the disclosed verification charge and recurring billing terms before checkout.");
    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) fail("A valid billing email is required.");
    let callback;
    try { callback = new URL(callbackUrl); } catch { fail("Invalid trial callback."); }
    if (callback.origin !== config.origin || callback.pathname !== "/billing/paystack/trial/callback" ||
        callback.username || callback.password || callback.search || callback.hash) fail("Invalid trial callback.");
    return this.repository.withLock({ organizationId, actorUserId }, async (repo) => {
      let trial = await repo.get({ organizationId });
      if (trial) {
        if (trial.email !== normalizedEmail || trial.actorUserId !== actorUserId || trial.callbackUrl !== callback.href) {
          fail("Existing trial checkout belongs to a different billing request.", "BILLING_TRIAL_INELIGIBLE");
        }
        if (trial.checkout && !trial.cardVerifiedAt && !trial.canceledAt) {
          return { checkout: trial.checkout, trial: await this.view(organizationId, trial, actorUserId) };
        }
        if (trial.cardVerifiedAt || trial.canceledAt || trial.verificationStatus !== "pending") {
          fail("This organization has already requested its trial.", "BILLING_TRIAL_INELIGIBLE");
        }
      }
      if (await repo.hasPaidHistory({ organizationId })) fail("This organization is not eligible for another trial.", "BILLING_TRIAL_INELIGIBLE");
      await this.billingFor(repo).ensureSubscription({ organizationId, actorUserId });
      const plan = await this.provider.plan(config.plan.planCode);
      this.validatePlan(plan, config.plan);
      if (!trial) {
        trial = { id: randomUUID(), organizationId, actorUserId, email: normalizedEmail,
        reference: `bnx_trial_${randomUUID()}`, callbackUrl: callback.href,
        status: "pending_checkout", verificationStatus: "pending", refundStatus: "not_required",
        verificationAmountMinor: config.verificationAmountMinor, currency: config.plan.currency,
        plan: { ...config.plan, providerPlanId: plan.id },
        consent: { accepted: true, termsVersion: TERMS_VERSION, acceptedAt: this.now().toISOString(),
          verificationAmountMinor: config.verificationAmountMinor, currency: config.plan.currency,
          monthlyAmountMinor: config.plan.amountMinor, interval: config.plan.interval },
      };
        await repo.save({ organizationId, actorUserId, trial, eventType: "trial.checkout_requested" });
      }
      const checkout = await this.provider.initialize({
        email: trial.email, amount: trial.verificationAmountMinor, currency: trial.currency,
        reference: trial.reference, callback_url: trial.callbackUrl, channels: ["card"],
        metadata: { organization_id: organizationId, actor_user_id: actorUserId,
          billing_purpose: "trial_card_verification", trial_id: trial.id, terms_version: TERMS_VERSION },
      });
      let hostedUrl;
      try { hostedUrl = new URL(checkout.authorization_url); } catch { fail("Invalid hosted checkout.", "BILLING_PROVIDER_FAILED"); }
      if (checkout.reference !== trial.reference || hostedUrl.origin !== "https://checkout.paystack.com" ||
          hostedUrl.username || hostedUrl.password) fail("Invalid hosted checkout.", "BILLING_PROVIDER_FAILED");
      trial.checkout = { reference: trial.reference, authorizationUrl: hostedUrl.href, provider: "paystack" };
      await repo.save({ organizationId, actorUserId, trial, eventType: "trial.checkout_initialized" });
      return { checkout: trial.checkout, trial: await this.view(organizationId, trial, actorUserId) };
    });
  }

  validatePlan(actual, expected) {
    if (actual?.plan_code !== expected.planCode || Number(actual.amount) !== expected.amountMinor ||
        actual.currency !== expected.currency || actual.interval !== "monthly" || !actual.id) {
      fail("Paystack plan does not match the disclosed billing terms.", "BILLING_PROVIDER_NOT_CONFIGURED");
    }
  }
  validateVerification(transaction, trial) {
    const meta = metadata(transaction.metadata);
    if (transaction.reference !== trial.reference || transaction.status !== "success" ||
        Number(transaction.amount) !== trial.verificationAmountMinor || transaction.currency !== trial.currency ||
        meta.organization_id !== trial.organizationId || meta.actor_user_id !== trial.actorUserId ||
        meta.trial_id !== trial.id || meta.billing_purpose !== "trial_card_verification" ||
        String(transaction.customer?.email ?? "").toLowerCase() !== trial.email ||
        !transaction.customer?.customer_code || !Number.isSafeInteger(transaction.customer.id) ||
        !Number.isSafeInteger(transaction.id)) fail("Verification transaction does not match this trial.", "BILLING_BINDING_MISMATCH");
    if (trial.customerCode && trial.customerCode !== transaction.customer.customer_code) fail("Customer changed during trial setup.", "BILLING_BINDING_MISMATCH");
    if (trial.transactionId && trial.transactionId !== transaction.id) fail("Transaction changed during trial setup.", "BILLING_BINDING_MISMATCH");
  }
  reusableCard(transaction) {
    const auth = transaction.authorization;
    return transaction.channel === "card" && auth?.channel === "card" && auth.reusable === true &&
      typeof auth.authorization_code === "string" && auth.authorization_code.startsWith("AUTH_");
  }

  async verifyCheckout({ organizationId, actorUserId, reference }) {
    this.assertActor(actorUserId);
    const config = this.configuration();
    return this.repository.withLock({ organizationId, actorUserId }, async (repo) => {
      const trial = await repo.get({ organizationId });
      if (!trial || trial.reference !== reference) fail("Trial checkout was not found.", "NOT_FOUND");
      await this.verifyLocked(repo, trial, config, actorUserId);
      return this.response(organizationId, actorUserId, trial, repo);
    });
  }

  async verifyLocked(repo, trial, config, actorUserId = null) {
    const save = (eventType) => repo.save({ organizationId: trial.organizationId, actorUserId, trial, eventType });
    if (trial.verificationStatus === "non_reusable_card") {
      await this.refundLocked(repo, trial, actorUserId);
      fail("A reusable card authorization is required.", "BILLING_CARD_NOT_REUSABLE");
    }
    if (!trial.cardVerifiedAt) {
      const transaction = await this.provider.verify(trial.reference);
      this.validateVerification(transaction, trial);
      trial.customerCode = transaction.customer.customer_code;
      trial.customerId = transaction.customer.id;
      trial.transactionId = transaction.id;
      trial.verificationStatus = "success";
      trial.refundStatus = "pending";
      if (!this.reusableCard(transaction)) {
        trial.status = "setup_failed";
        trial.verificationStatus = "non_reusable_card";
        await save("trial.card_rejected");
        await this.refundLocked(repo, trial, actorUserId);
        fail("A reusable card authorization is required. The verification charge will be refunded.", "BILLING_CARD_NOT_REUSABLE");
      }
      trial.cardVerifiedAt = this.now().toISOString();
      trial.authorizationDigest = hash(transaction.authorization.authorization_code);
      trial.authorization = this.seal({ code: transaction.authorization.authorization_code }, trial, config);
      await save("trial.card_verified");
    }
    await this.refundLocked(repo, trial, actorUserId);
    if (trial.canceledAt || trial.convertedAt) return;
    if (!trial.subscriptionCode) await this.provisionLocked(repo, trial, config, actorUserId);
    else if (trial.status === "trialing") {
      await repo.publishSubscription({ organizationId: trial.organizationId, actorUserId, trial });
    }
    if (trial.cancelStatus === "requested") await this.cancelLocked(repo, trial, config, actorUserId);
  }

  subscriptionMatches(subscription, trial, authorization) {
    const customer = subscription?.customer;
    const plan = subscription?.plan;
    const customerMatches = typeof customer === "object"
      ? customer?.customer_code === trial.customerCode && Number(customer.id) === trial.customerId &&
        String(customer.email ?? "").toLowerCase() === trial.email
      : Number(customer) === trial.customerId;
    const planMatches = typeof plan === "object"
      ? plan?.plan_code === trial.plan.planCode && Number(plan.id) === Number(trial.plan.providerPlanId) &&
        Number(plan.amount) === trial.plan.amountMinor && plan.currency === trial.currency && plan.interval === "monthly"
      : Number(plan) === Number(trial.plan.providerPlanId);
    const firstDebit = subscription?.next_payment_date ??
      (Number.isFinite(Number(subscription?.start)) ? new Date(Number(subscription.start) * 1000).toISOString() : null);
    return customerMatches && planMatches &&
      subscription.authorization?.authorization_code === authorization.code &&
      subscription.authorization?.reusable === true && subscription.authorization?.channel === "card" &&
      Number(subscription.amount) === trial.plan.amountMinor && firstDebit &&
      new Date(firstDebit).getTime() === new Date(trial.firstBillingDate).getTime() &&
      typeof subscription.subscription_code === "string" && subscription.subscription_code.startsWith("SUB_");
  }

  async provisionLocked(repo, trial, config, actorUserId) {
    const save = (eventType) => repo.save({ organizationId: trial.organizationId, actorUserId, trial, eventType });
    const authorization = this.unseal(trial, config);
    let subscription;
    if (trial.provisionStatus === "attempted") {
      const candidates = (await this.provider.listSubscriptions(trial.customerId))
        .filter((item) => this.subscriptionMatches(item, trial, authorization));
      if (candidates.length !== 1) fail("Scheduled billing needs provider reconciliation before retry.", "BILLING_RECONCILIATION_REQUIRED");
      subscription = await this.provider.subscription(candidates[0].subscription_code);
    } else {
      if (await repo.hasPaidHistory({ organizationId: trial.organizationId })) fail("Paid billing has already started.", "BILLING_TRIAL_INELIGIBLE");
      this.validatePlan(await this.provider.plan(trial.plan.planCode), trial.plan);
      // Persist the schedule and intent before the non-idempotent provider POST.
      // Entitlement is published only once the provider confirms this schedule.
      trial.provisionRequestedAt = new Date(Math.ceil(this.now().getTime() / 1000) * 1000).toISOString();
      // Allow provider confirmation time without scheduling a debit before seven
      // full days of access. The debit can be at most one minute after expiry.
      trial.firstBillingDate = new Date(new Date(trial.provisionRequestedAt).getTime() + 7 * DAY + 60_000).toISOString();
      trial.provisionStatus = "attempted";
      await save("trial.provision_requested");
      subscription = await this.provider.createSubscription({ customer: trial.customerCode,
        plan: trial.plan.planCode, authorization: authorization.code, start_date: trial.firstBillingDate });
    }
    if (!this.subscriptionMatches(subscription, trial, authorization) || !subscription.email_token ||
        subscription.status !== "active") fail("Scheduled subscription binding could not be confirmed.", "BILLING_RECONCILIATION_REQUIRED");
    const confirmedCreation = new Date(subscription.createdAt ?? subscription.created_at);
    const trialEnd = new Date(confirmedCreation.getTime() + 7 * DAY);
    if (!Number.isFinite(confirmedCreation.getTime()) || confirmedCreation < new Date(trial.provisionRequestedAt) ||
        trialEnd > new Date(trial.firstBillingDate)) {
      fail("Provider creation time does not confirm seven full trial days.", "BILLING_RECONCILIATION_REQUIRED");
    }
    trial.subscriptionCode = subscription.subscription_code;
    trial.authorization = this.seal({ code: authorization.code, emailToken: subscription.email_token }, trial, config);
    trial.provisionStatus = "confirmed";
    trial.startedAt = confirmedCreation.toISOString();
    trial.endsAt = trialEnd.toISOString();
    trial.status = "trialing";
    await save("trial.started");
    try {
      await repo.publishSubscription({ organizationId: trial.organizationId, actorUserId, trial });
    } catch (error) {
      trial.cancelStatus = "requested";
      trial.status = "setup_failed";
      await save("trial.subscription_publish_failed");
      await this.cancelLocked(repo, trial, config, actorUserId);
      throw error;
    }
  }

  validateRefund(refund, trial) {
    const transaction = refund?.transaction;
    const transactionId = typeof transaction === "object" ? transaction?.id : transaction;
    if (String(transactionId) !== String(trial.transactionId) || Number(refund?.amount) !== trial.verificationAmountMinor ||
        refund.currency !== trial.currency || !refund.id ||
        !["pending", "processing", "processed", "failed", "needs-attention"].includes(refund.status)) {
      fail("Refund binding could not be confirmed.", "BILLING_RECONCILIATION_REQUIRED");
    }
  }
  async refundLocked(repo, trial, actorUserId = null) {
    if (!trial.transactionId || ["processed", "not_required"].includes(trial.refundStatus)) return;
    const save = (eventType) => repo.save({ organizationId: trial.organizationId, actorUserId, trial, eventType });
    let refund;
    if (trial.refundId) {
      refund = await this.provider.refund(trial.refundId);
    } else if (trial.refundStatus === "attempted") {
      const candidates = await this.provider.listRefunds(trial.transactionId);
      if (candidates.length !== 1) fail("Verification refund needs reconciliation before retry.", "BILLING_RECONCILIATION_REQUIRED");
      refund = candidates[0];
    } else {
      trial.refundStatus = "attempted";
      await save("trial.refund_requested");
      refund = await this.provider.createRefund({ transaction: trial.reference,
        amount: trial.verificationAmountMinor, currency: trial.currency,
        merchant_note: `BIZNORYX card verification ${trial.id}`, customer_note: "Refund of trial card verification charge" });
    }
    this.validateRefund(refund, trial);
    trial.refundId = String(refund.id);
    trial.refundStatus = refund.status;
    await save("trial.refund_reconciled");
  }

  async cancelTrial({ organizationId, actorUserId }) {
    this.assertActor(actorUserId);
    const config = this.configuration();
    return this.repository.withLock({ organizationId, actorUserId }, async (repo) => {
      const trial = await repo.get({ organizationId });
      if (!trial) fail("Trial was not found.", "NOT_FOUND");
      if (trial.convertedAt) {
        fail("Trial has converted. Use the paid subscription cancellation workflow.");
      }
      if (!trial.canceledAt) {
        trial.cancelStatus = "requested";
        await repo.save({ organizationId, actorUserId, trial, eventType: "trial.cancel_requested" });
        if (trial.provisionStatus === "attempted" && !trial.subscriptionCode) {
          await this.provisionLocked(repo, trial, config, actorUserId);
        }
        await this.cancelLocked(repo, trial, config, actorUserId);
      }
      return this.response(organizationId, actorUserId, trial, repo);
    });
  }
  async cancelLocked(repo, trial, config, actorUserId = null) {
    if (trial.canceledAt) return;
    if (trial.subscriptionCode) {
      const subscription = await this.provider.subscription(trial.subscriptionCode);
      const auth = this.unseal(trial, config);
      if (subscription.subscription_code !== trial.subscriptionCode ||
          subscription.authorization?.authorization_code !== auth.code ||
          (typeof subscription.customer === "object" ? subscription.customer?.customer_code !== trial.customerCode :
            Number(subscription.customer) !== trial.customerId)) fail("Cancellation binding does not match.", "BILLING_BINDING_MISMATCH");
      if (!["non-renewing", "cancelled", "completed"].includes(subscription.status)) {
        if (!auth.emailToken) fail("Provider cancellation token is unavailable.", "BILLING_RECONCILIATION_REQUIRED");
        await this.provider.disable(trial.subscriptionCode, auth.emailToken);
      }
    } else if (trial.provisionStatus === "attempted") {
      fail("Trial cancellation requires scheduled subscription reconciliation.", "BILLING_RECONCILIATION_REQUIRED");
    }
    trial.canceledAt = this.now().toISOString();
    trial.cancelStatus = "confirmed";
    trial.status = "canceled";
    await repo.save({ organizationId: trial.organizationId, actorUserId, trial, eventType: "trial.canceled" });
  }

  async handleWebhook({ event, rawBody, signature }) {
    if (!verifyPaystackWebhookSignature({ payload: rawBody, signature, secret: this.env.PAYSTACK_SECRET_KEY })) {
      fail("Invalid Paystack webhook signature.", "ORG_ACCESS_DENIED");
    }
    try { event = JSON.parse(rawBody.toString()); } catch { fail("Invalid Paystack webhook."); }
    const data = event.data ?? {};
    const reference = data.reference ?? data.transaction?.reference ?? null;
    const subscriptionCode = data.subscription_code ?? data.subscription?.subscription_code ?? null;
    const organizationId = await this.repository.resolve({ reference, subscriptionCode });
    if (!organizationId) return { handled: false };
    const config = this.configuration();
    return this.repository.withLock({ organizationId }, async (repo) => {
      const trial = await repo.get({ organizationId });
      if ((subscriptionCode && trial.subscriptionCode !== subscriptionCode) ||
          (reference?.startsWith("bnx_trial_") && reference !== trial.reference)) fail("Webhook identity does not match this trial.", "BILLING_BINDING_MISMATCH");
      if (reference === trial.reference) {
        if (event.event === "charge.success") await this.verifyLocked(repo, trial, config);
        else if (event.event.startsWith("refund.")) await this.refundLocked(repo, trial);
        return { handled: true, received: true, action: "trial_verification", trial: await this.view(organizationId, trial) };
      }
      if (["subscription.create", "invoice.create"].includes(event.event)) {
        return { handled: true, received: true, action: "trial_scheduled" };
      }
      if (["subscription.not_renew", "subscription.disable"].includes(event.event) && !trial.convertedAt) {
        await this.cancelLocked(repo, trial, config);
        return { handled: true, received: true, action: "trial_canceled" };
      }
      if (event.event === "invoice.payment_failed" && !trial.convertedAt) {
        const details = await this.provider.subscription(trial.subscriptionCode);
        if (details.subscription_code !== trial.subscriptionCode || details.status !== "attention") {
          fail("Payment failure could not be confirmed.", "BILLING_BINDING_MISMATCH");
        }
        trial.paymentUpdateRequired = true;
        await repo.save({ organizationId, trial, eventType: "trial.payment_update_required" });
        return { handled: true, received: true, action: "trial_payment_update_required" };
      }
      if ((event.event === "charge.success" || (event.event === "invoice.update" && data.paid === true)) && reference && !trial.convertedAt) {
        await this.activatePaidLocked(repo, trial, config, reference, event, rawBody);
        return { handled: true, received: true, action: "subscription_activated" };
      }
      return { handled: trial.convertedAt ? false : true, received: true, action: "ignored" };
    });
  }

  async activatePaidLocked(repo, trial, config, reference, event, rawBody) {
    const verified = await this.provider.verify(reference);
    const auth = this.unseal(trial, config);
    const paidAt = new Date(verified.paid_at ?? verified.transaction_date);
    const details = await this.provider.subscription(trial.subscriptionCode);
    const invoice = details?.most_recent_invoice;
    const invoiceTransactionId = typeof invoice?.transaction === "object" ? invoice.transaction?.id : invoice?.transaction;
    const signedSubscription = event.data?.subscription?.subscription_code ?? event.data?.subscription_code;
    const exactProviderInvoice = invoice && String(invoiceTransactionId) === String(verified.id) &&
      Number(invoice.amount) === trial.plan.amountMinor && (invoice.paid === true || invoice.paid === 1);
    // The signed invoice event binds the verified payment to this subscription.
    // A generic charge event additionally needs provider invoice corroboration.
    const exactSignedInvoice = event.event === "invoice.update" && event.data?.paid === true &&
      signedSubscription === trial.subscriptionCode && event.data?.transaction?.reference === reference;
    if (trial.canceledAt || trial.cancelStatus === "requested" || reference.startsWith("bnx_trial_") ||
        verified.status !== "success" || verified.reference !== reference ||
        Number(verified.amount) !== trial.plan.amountMinor || verified.currency !== trial.currency ||
        verified.customer?.customer_code !== trial.customerCode || Number(verified.customer?.id) !== trial.customerId ||
        String(verified.customer?.email ?? "").toLowerCase() !== trial.email ||
        verified.authorization?.authorization_code !== auth.code ||
        details.subscription_code !== trial.subscriptionCode ||
        details.authorization?.authorization_code !== auth.code ||
        (!exactProviderInvoice && !exactSignedInvoice) ||
        !Number.isFinite(paidAt.getTime()) || paidAt < new Date(trial.firstBillingDate) || paidAt > this.now()) {
      fail("Paid charge does not match the scheduled trial subscription.", "BILLING_BINDING_MISMATCH");
    }
    const billing = this.billingFor(repo);
    await billing.recordPayment({ organizationId: trial.organizationId, reference, status: "success",
      amountMinor: verified.amount, currency: verified.currency, channel: verified.channel, paidAt });
    await billing.applyWebhookEvent({ organizationId: trial.organizationId,
      eventKey: `trial-paid:${reference}`, eventName: event.event, reference, payload: rawBody,
      action: "subscription_activated", providerCustomerCode: trial.customerCode,
      providerSubscriptionCode: trial.subscriptionCode, paidAt });
    const subscription = await billing.ensureSubscription({ organizationId: trial.organizationId });
    if (!["active", "non_renewing"].includes(subscription.status) ||
        subscription.providerSubscriptionCode !== trial.subscriptionCode || !subscription.currentPeriodEnd ||
        new Date(subscription.currentPeriodEnd) <= paidAt) fail("Paid activation needs reconciliation.", "BILLING_RECONCILIATION_REQUIRED");
    trial.convertedAt = paidAt.toISOString();
    trial.paymentUpdateRequired = false;
    await repo.save({ organizationId: trial.organizationId, trial, eventType: "trial.converted" });
  }

  async paymentUpdateLink({ organizationId, actorUserId }) {
    this.assertActor(actorUserId);
    await this.repository.authorize({ organizationId, actorUserId, owner: true });
    const trial = await this.repository.get({ organizationId });
    if (!trial?.paymentUpdateRequired || !trial.subscriptionCode || trial.canceledAt) fail("No trial payment update is required.");
    const result = await this.provider.updateLink(trial.subscriptionCode);
    const url = new URL(result.link);
    if (url.protocol !== "https:" || !["paystack.com", "checkout.paystack.com"].includes(url.hostname) || url.username || url.password) {
      fail("Invalid provider payment update link.", "BILLING_PROVIDER_FAILED");
    }
    return { authorizationUrl: url.href, provider: "paystack" };
  }

  async processPending({ organizationId } = {}) {
    const config = this.configuration();
    if (!organizationId) {
      const results = [];
      for (const tenantId of await this.repository.pendingOrganizations({ limit: 100 })) {
        try { results.push({ organizationId: tenantId, ...(await this.processPending({ organizationId: tenantId })) }); }
        catch (error) { results.push({ organizationId: tenantId, errorCode: error.code ?? "BILLING_PROVIDER_FAILED" }); }
      }
      return { results };
    }
    return this.repository.withLock({ organizationId }, async (repo) => {
      const trial = await repo.get({ organizationId });
      if (!trial) return { processed: false };
      try {
      if (trial.cancelStatus === "requested") {
        if (trial.provisionStatus === "attempted" && !trial.subscriptionCode) await this.provisionLocked(repo, trial, config, null);
        await this.cancelLocked(repo, trial, config);
      }
      await this.refundLocked(repo, trial);
      if (!trial.canceledAt && !trial.convertedAt && trial.cardVerifiedAt && !trial.subscriptionCode) {
        await this.provisionLocked(repo, trial, config, null);
      }
      if (!trial.cardVerifiedAt && trial.verificationStatus === "pending" && !trial.canceledAt) {
        await this.verifyLocked(repo, trial, config);
      }
      if (trial.startedAt && !trial.canceledAt && !trial.convertedAt && !trial.reminderSentAt &&
          new Date(trial.endsAt).getTime() - this.now().getTime() <= DAY && new Date(trial.endsAt) > this.now()) {
        await this.sendReminder(trial);
        trial.reminderSentAt = this.now().toISOString();
        await repo.save({ organizationId, trial, eventType: "trial.reminder_sent" });
      }
      return { processed: true, trial: await this.view(organizationId, trial) };
      } finally {
        trial.nextProcessAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
        await repo.save({ organizationId, trial, eventType: "trial.maintenance_checked" });
      }
    });
  }

  async sendReminder(trial) {
    if (typeof this.emailSender?.sendTrialReminder !== "function") fail("Trial email sender must support sendTrialReminder.", "SERVICE_UNAVAILABLE");
    return this.emailSender.sendTrialReminder({
      to: trial.email, trialId: trial.id, endsAt: iso(trial.endsAt),
      monthlyAmountMinor: trial.plan.amountMinor, currency: trial.currency,
      billingUrl: `${this.configuration().origin}/#/billing`,
    });
  }
}
