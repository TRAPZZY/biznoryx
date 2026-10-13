import { AuthError } from "../auth/core.mjs";
import { withBillingTenant } from "../database/billing-repository.mjs";
import { disablePaystackSubscription, resolvePaystackSubscriptionIdentity, monthlyPlanFromEnv } from "../billing/paystack.mjs";

export class AccountDeletionService {
  constructor({ repository, pool, billing, trials, objectStorage, fetchImpl = fetch, env = process.env, onError = () => {} }) {
    Object.assign(this, { repository, pool, billing, trials, objectStorage, fetchImpl, env, onError });
  }

  async processPending() {
    for (const job of await this.repository.pending()) {
      await this.repository.withLock(job, async (fresh) => {
        try {
          for (const organizationId of fresh.closing_organizations) await this.closeWorkspace(organizationId);
          await this.repository.finish(fresh.id);
        } catch (error) {
          await this.repository.retry(fresh.id, error.code ?? "DELETION_RETRY_REQUIRED");
          this.onError(Object.assign(new Error("An account deletion requires retry.", { cause: error }), { code: error.code ?? "DELETION_RETRY_REQUIRED" }));
        }
      });
    }
  }

  async closeWorkspace(organizationId) {
    if (this.billing?.trials) {
      await this.billing.trials.withLock({ organizationId }, async (repo) => {
        const trial = await repo.get({ organizationId });
        if (!trial || trial.convertedAt) return;
        const config = this.trials.configuration();
        trial.cancelStatus = "requested";
        await repo.save({ organizationId, trial, eventType: "trial.account_deletion_cancel_requested" });
        if (trial.provisionStatus === "attempted" && !trial.subscriptionCode) await this.trials.provisionLocked(repo, trial, config, null);
        await this.trials.cancelLocked(repo, trial, config);
        await this.trials.refundLocked(repo, trial);
        if (!["processed", "not_required"].includes(trial.refundStatus)) {
          throw new AuthError("Verification refund is still processing.", "DELETION_BILLING_PENDING");
        }
        if (trial.verificationStatus === "pending") await this.trials.archiveClosedCheckout(repo,trial);
      });
    }
    const subscription = await this.billing.ensureSubscription({ organizationId, skipStoreRefresh: true });
    if (subscription.provider === "paystack" && ["active", "past_due"].includes(subscription.status)) {
      const identity = subscription.providerSubscriptionCode && subscription.providerEmailToken
        ? { subscriptionCode: subscription.providerSubscriptionCode, emailToken: subscription.providerEmailToken }
        : await resolvePaystackSubscriptionIdentity({ reference: subscription.checkoutReference,
          expectedSubscriptionCode: subscription.providerSubscriptionCode, organizationId,
          planCode: monthlyPlanFromEnv().planCode, fetchImpl: this.fetchImpl });
      await disablePaystackSubscription({ ...identity, fetchImpl: this.fetchImpl });
      await this.billing.cancelSubscription({ organizationId, ...identity,
        providerSubscriptionCode: identity.subscriptionCode, providerEmailToken: identity.emailToken });
    }
    const objects = await withBillingTenant(this.pool, { organizationId }, async (client) => {
      const leases = await client.query("select 1 from processing_jobs where organization_id = $1 and status = 'leased' and lease_expires_at > now() limit 1", [organizationId]);
      if (leases.rowCount) throw new AuthError("Processing is still finishing.", "DELETION_PROCESSING_PENDING");
      return (await client.query("select storage_key from raw_data_objects where organization_id = $1", [organizationId])).rows;
    });
    const storeAccount = await withBillingTenant(this.pool,{organizationId},async client=>
      (await client.query("select customer_id from organization_store_accounts where organization_id=$1",[organizationId])).rows[0]);
    if (storeAccount) {
      if (!this.env.REVENUECAT_SECRET_API_KEY) throw new AuthError("Store privacy cleanup is not configured.","DELETION_STORE_UNAVAILABLE");
      const removed = await this.fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(storeAccount.customer_id)}`,{
        method:"DELETE",headers:{Authorization:`Bearer ${this.env.REVENUECAT_SECRET_API_KEY}`},signal:AbortSignal.timeout(15000),redirect:"error"});
      if (![200,404].includes(removed.status)) throw new AuthError("Store privacy cleanup requires retry.","DELETION_STORE_PENDING");
    }
    if (objects.length && !this.objectStorage?.purgeObject) throw new AuthError("Storage deletion is not configured.", "DELETION_STORAGE_UNAVAILABLE");
    for (const object of objects) {
      if (!object.storage_key.startsWith(`organizations/${organizationId}/`)) {
        throw new AuthError("Object does not match this organization.", "DELETION_STORAGE_BINDING");
      }
      await this.objectStorage.purgeObject({ key: object.storage_key });
    }
  }
}

export function startAccountDeletionMaintenance({ service, intervalMs = 30_000, onError = () => {} }) {
  let pending; let stopping = false;
  const run = () => {
    if (stopping || pending) return;
    pending = service.processPending().catch(onError).finally(() => { pending = null; });
  };
  const timer = setInterval(run, intervalMs); timer.unref(); run();
  return async () => { stopping = true; clearInterval(timer); await pending; };
}
