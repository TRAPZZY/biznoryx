import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID,createHash} from "node:crypto";
import pg from "pg";
import {PostgresIdentityRepository} from "../src/database/identity-repository.mjs";
import {PostgresBillingRepository} from "../src/database/billing-repository.mjs";
import {StoreBillingService} from "../src/billing/store-service.mjs";
import {subscriptionHasPremiumAccess} from "../src/billing/entitlements.mjs";
import {PostgresAccountDeletionRepository} from "../src/database/account-deletion-repository.mjs";
import {AccountDeletionService} from "../src/compliance/account-deletion-service.mjs";

test("PostgreSQL store billing verifies provider access and isolates identities and receipts",{skip:!process.env.TEST_DATABASE_URL},async()=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:"-c role=biznoryx_app"});
  const identity=new PostgresIdentityRepository(pool); const billing=new PostgresBillingRepository(pool);
  const now=new Date("2026-10-11T12:00:00Z"); let payload;
  const service=new StoreBillingService({pool,billing,now:()=>now,env:{REVENUECAT_SECRET_API_KEY:"test-secret",REVENUECAT_ENTITLEMENT_ID:"business",REVENUECAT_APPLE_PRODUCT_IDS:"monthly",REVENUECAT_GOOGLE_PRODUCT_IDS:"monthly"},fetchImpl:async(url,options)=>{
    assert.match(url,/^https:\/\/api\.revenuecat\.com\/v1\/subscribers\/[\w-]+$/);assert.equal(options.headers.Authorization,"Bearer test-secret");return {ok:true,json:async()=>payload};
  }});
  billing.store=service;
  try {
    const owner=await identity.createUser({email:`store-${randomUUID()}@example.com`,displayName:"Store Owner",password:"StoreAcceptancePassword2026!"});
    const org=await identity.createOrganization({actorUserId:owner.id,name:"Store business",slug:randomUUID()});
    const second=await identity.createOrganization({actorUserId:owner.id,name:"Second business",slug:randomUUID()});
    const scope={organizationId:org.id,actorUserId:owner.id}; const first=await service.context(scope); const other=await service.context({...scope,organizationId:second.id});
    assert.notEqual(first.customerId,other.customerId);
    payload={subscriber:{original_app_user_id:first.customerId,entitlements:{business:{product_identifier:"monthly",expires_date:"2026-11-10T12:00:00Z"}},subscriptions:{monthly:{store:"app_store",is_sandbox:false,ownership_type:"PURCHASED",purchase_date:"2026-10-10T12:00:00Z",expires_date:"2026-11-10T12:00:00Z",store_transaction_id:"known-"+randomUUID()}}}};
    await billing.trials.withLock(scope,async()=>{
      await assert.rejects(service.sync(scope),{code:"BILLING_OPERATION_IN_PROGRESS"});
    });
    await service.sync(scope);
    const active=await billing.ensureSubscription({...scope,skipStoreRefresh:true});
    assert.equal(active.provider,"app_store");assert.equal(active.amountMinor,null);assert.equal(active.currency,null);
    assert.equal(subscriptionHasPremiumAccess(active,{now:()=>now}),true);
    await assert.rejects(service.sync({...scope,organizationId:second.id}),{code:"BILLING_IDENTITY_CONFLICT"});
    payload.subscriber.original_app_user_id=other.customerId;
    await assert.rejects(service.sync({...scope,organizationId:second.id}),{code:"BILLING_IDENTITY_CONFLICT"});
    const transactionId=payload.subscriber.subscriptions.monthly.store_transaction_id;
    const trial={id:randomUUID(),reference:`bnx_trial_${randomUUID()}`,status:"pending_checkout",verificationStatus:"pending",refundStatus:"not_required"};
    await billing.trials.save({organizationId:second.id,actorUserId:owner.id,trial,eventType:"trial.checkout_requested"});
    payload.subscriber.subscriptions.monthly.store_transaction_id=`pending-${randomUUID()}`;
    await assert.rejects(service.sync({...scope,organizationId:second.id}),{code:"BILLING_OPERATION_IN_PROGRESS"});
    await billing.trials.save({organizationId:second.id,actorUserId:owner.id,trial:{...trial,convertedAt:now.toISOString()},eventType:"trial.fixture_resolved"});
    payload.subscriber.subscriptions.monthly.store_transaction_id=transactionId;
    payload.subscriber.original_app_user_id=first.customerId;payload.subscriber.subscriptions.monthly.refunded_at=now.toISOString();
    await service.sync(scope);
    assert.equal(subscriptionHasPremiumAccess(await billing.ensureSubscription({...scope,skipStoreRefresh:true}),{now:()=>now}),false);
    await assert.rejects(billing.createCheckoutSession({...scope,provider:"paystack",reference:`boundary-${randomUUID()}`}),{code:"VALIDATION_FAILED"});
    assert.equal((await billing.ensureSubscription({...scope,skipStoreRefresh:true})).provider,"app_store");
    assert.equal((await billing.ensureSubscription({organizationId:second.id,skipStoreRefresh:true})).provider,"paystack");
    const repository=new PostgresAccountDeletionRepository(pool);const failures=[];const removed=[];
    const deletion=new AccountDeletionService({repository,pool,billing,env:{REVENUECAT_SECRET_API_KEY:"test-secret"},onError:error=>failures.push(error.cause),fetchImpl:async(url,options)=>{
      assert.equal(options.method,"DELETE");removed.push(url);return {status:200};
    }});
    const requested=await repository.request({userId:owner.id,password:"StoreAcceptancePassword2026!",confirm:true,closeWorkspaces:true});
    await deletion.processPending();assert.deepEqual(failures,[]);assert.equal((await repository.status(requested.receipt)).status,"completed");
    assert.equal(removed.length,2);
    const verified=await pool.query("select runtime_store_transaction_retired($1) as retired",[createHash("sha256").update(`app_store:${payload.subscriber.subscriptions.monthly.store_transaction_id}`).digest("hex")]);
    assert.equal(verified.rows[0].retired,true);
  } finally {await pool.end();}
});
