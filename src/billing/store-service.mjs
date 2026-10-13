import { createHash } from "node:crypto";
import { AuthError } from "../auth/core.mjs";
import { withBillingTenant } from "../database/billing-repository.mjs";

export function verifiedStoreEntitlement(payload, {customerId,entitlement,products,allowSandbox=false,now=new Date()}) {
  const subscriber = payload?.subscriber;
  if (subscriber?.original_app_user_id !== customerId) throw new AuthError("Store purchase belongs to a different account.","BILLING_IDENTITY_CONFLICT");
  const access = subscriber.entitlements?.[entitlement];
  if (!access) return null;
  const product = access.product_identifier;
  const subscription = subscriber.subscriptions?.[product];
  if (!subscription || !["app_store","play_store"].includes(subscription.store) ||
      !products[subscription.store]?.includes(product) || typeof subscription.is_sandbox !== "boolean" ||
      subscription.is_sandbox && !allowSandbox || subscription.ownership_type !== "PURCHASED" || subscription.refunded_at) return null;
  const end = new Date(access.expires_date ?? "");
  const providerEnd = new Date(subscription.expires_date ?? "");
  const purchased = new Date(subscription.purchase_date ?? "");
  if (!Number.isFinite(end.getTime()) || !Number.isFinite(providerEnd.getTime()) || !Number.isFinite(purchased.getTime()) ||
      end > providerEnd || end <= now || purchased > now || end <= purchased || !subscription.store_transaction_id) return null;
  return {store:subscription.store,product,end,purchased,status:subscription.unsubscribe_detected_at?"non_renewing":"active",
    transactionHash:createHash("sha256").update(`${subscription.store}:${subscription.store_transaction_id}`).digest("hex")};
}

export class StoreBillingService {
  constructor({pool,billing,fetchImpl=fetch,env=process.env,now=()=>new Date()}) { Object.assign(this,{pool,billing,fetchImpl,env,now}); }

  configuration() {
    const key = this.env.REVENUECAT_SECRET_API_KEY;
    const entitlement = this.env.REVENUECAT_ENTITLEMENT_ID;
    const products = {app_store:(this.env.REVENUECAT_APPLE_PRODUCT_IDS || "").split(",").filter(Boolean),play_store:(this.env.REVENUECAT_GOOGLE_PRODUCT_IDS || "").split(",").filter(Boolean)};
    if (!key || !entitlement || !(products.app_store.length || products.play_store.length)) throw new AuthError("Store subscriptions are not configured yet.","SERVICE_UNAVAILABLE");
    return {key,entitlement,products,allowSandbox:this.env.NODE_ENV !== "production" && this.env.REVENUECAT_ALLOW_SANDBOX === "true"};
  }

  async context({organizationId,actorUserId}) {
    const config = this.configuration();
    await this.billing.trials.authorize({organizationId,actorUserId,owner:true});
    const subscription = await this.billing.ensureSubscription({organizationId,actorUserId,skipStoreRefresh:true});
    const trial = await this.billing.trials.get({organizationId});
    const conflict = !["app_store","play_store"].includes(subscription.provider) &&
      (["active","non_renewing","past_due","pending_checkout"].includes(subscription.status) || subscription.trial?.providerProvisioned);
    if (conflict || trial && !trial.canceledAt && !trial.convertedAt) throw new AuthError("An existing website subscription or card checkout must be resolved before adding a store subscription.","BILLING_OPERATION_IN_PROGRESS");
    const account = await withBillingTenant(this.pool,{organizationId},async client=>
      (await client.query("insert into organization_store_accounts(organization_id) values($1) on conflict(organization_id) do update set organization_id=excluded.organization_id returning customer_id",[organizationId])).rows[0]);
    return {customerId:account.customer_id,subscription,products:config.products};
  }

  async sync({organizationId,actorUserId=null,force=true}) {
    if (actorUserId) await this.billing.trials.authorize({organizationId,actorUserId,owner:true});
    const config = this.configuration();
    return withBillingTenant(this.pool,{organizationId},async client=>{
      const lock = await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked",[`billing-trial:${organizationId}`]);
      if (!lock.rows[0]?.locked) throw new AuthError("A billing operation is already running. Please retry.","BILLING_OPERATION_IN_PROGRESS");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`store-billing:${organizationId}`]);
      const account = (await client.query("select customer_id,checked_at from organization_store_accounts where organization_id=$1 for update",[organizationId])).rows[0];
      if (!account) throw new AuthError("Open store billing before restoring purchases.","VALIDATION_FAILED");
      if (!force && account.checked_at && this.now()-new Date(account.checked_at)<60000) return;
      const response = await this.fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(account.customer_id)}`,{
        headers:{Authorization:`Bearer ${config.key}`,Accept:"application/json"},signal:AbortSignal.timeout(15000),redirect:"error"});
      if (!response.ok) throw new AuthError("Unable to verify store subscription. Please retry.","SERVICE_UNAVAILABLE");
      const sandboxOrganizations = (this.env.REVENUECAT_SANDBOX_ORGANIZATION_IDS || "").split(",");
      const access = verifiedStoreEntitlement(await response.json(),{...config,
        allowSandbox:config.allowSandbox || sandboxOrganizations.includes(organizationId),customerId:account.customer_id,now:this.now()});
      const current = (await client.query("select provider,status,provider_subscription_code from organization_billing_subscriptions where organization_id=$1 for update",[organizationId])).rows[0];
      if (!current) throw new AuthError("Billing account is unavailable.","SERVICE_UNAVAILABLE");
      if (["app_store","play_store"].includes(current.provider) && !config.products[current.provider].length) {
        throw new AuthError("This subscription's store is not configured. Restore its configuration before verification.","SERVICE_UNAVAILABLE");
      }
      if (access) {
        const pendingTrial = await client.query("select 1 from billing_trials where organization_id=$1 and canceled_at is null and converted_at is null limit 1",[organizationId]);
        if (pendingTrial.rowCount) throw new AuthError("Resolve the website trial before adding store billing.","BILLING_OPERATION_IN_PROGRESS");
        if ((await client.query("select runtime_store_transaction_retired($1) as retired",[access.transactionHash])).rows[0].retired) {
          throw new AuthError("This purchase belonged to a closed workspace.","BILLING_IDENTITY_CONFLICT");
        }
        if (!["app_store","play_store"].includes(current.provider) && (current.provider_subscription_code || !["trialing","canceled"].includes(current.status))) {
          throw new AuthError("A website billing operation is already bound to this workspace.","BILLING_OPERATION_IN_PROGRESS");
        }
        const bound = await client.query("insert into store_billing_transactions(transaction_hash,organization_id,store,product_id) values($1,$2,$3,$4) on conflict(transaction_hash) do nothing returning transaction_hash",[access.transactionHash,organizationId,access.store,access.product]);
        if (!bound.rowCount && !(await client.query("select 1 from store_billing_transactions where transaction_hash=$1 and organization_id=$2",[access.transactionHash,organizationId])).rowCount) {
          throw new AuthError("This purchase is already bound to another workspace.","BILLING_IDENTITY_CONFLICT");
        }
        await client.query(`update organization_billing_subscriptions set provider=$2::billing_provider,
          provider_customer_code=$3,provider_subscription_code=$3,provider_email_token=null,
          checkout_reference=null,amount_minor=null,currency=null,plan_id=$4,plan_name='BIZNORYX Monthly',status=$5::billing_subscription_status,
          current_period_end=$6,active_at=coalesce(active_at,$7),trial_ends_at=null,updated_at=$8 where organization_id=$1`,
          [organizationId,access.store,account.customer_id,access.product,access.status,access.end,access.purchased,this.now()]);
      } else if (["app_store","play_store"].includes(current.provider)) {
        await client.query("update organization_billing_subscriptions set status='canceled',current_period_end=$2,updated_at=$2 where organization_id=$1",[organizationId,this.now()]);
      }
      await client.query("update organization_store_accounts set checked_at=$2 where organization_id=$1",[organizationId,this.now()]);
    });
  }
}
