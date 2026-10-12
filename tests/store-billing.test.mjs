import assert from "node:assert/strict";
import test from "node:test";
import { verifiedStoreEntitlement } from "../src/billing/store-service.mjs";

const customerId = "18f31a25-7020-4f13-87b3-846b900bb49b";
const config = {customerId,entitlement:"business",products:{app_store:["biznoryx.monthly"],play_store:["biznoryx_monthly:monthly"]},now:new Date("2026-10-11T12:00:00Z")};
function fixture() {
  return {subscriber:{original_app_user_id:customerId,entitlements:{business:{product_identifier:"biznoryx.monthly",expires_date:"2026-11-10T12:00:00Z"}},
    subscriptions:{"biznoryx.monthly":{store:"app_store",is_sandbox:false,ownership_type:"PURCHASED",purchase_date:"2026-10-10T12:00:00Z",expires_date:"2026-11-10T12:00:00Z",store_transaction_id:"transaction-1"}}}};
}
test("verified store access uses provider dates, supports cancellation through the paid period",()=>{
  const payload=fixture(); const access=verifiedStoreEntitlement(payload,config);
  assert.equal(access.status,"active"); assert.equal(access.end.toISOString(),"2026-11-10T12:00:00.000Z"); assert.equal(access.transactionHash.length,64);
  payload.subscriber.subscriptions["biznoryx.monthly"].unsubscribe_detected_at="2026-10-11T11:00:00Z";
  assert.equal(verifiedStoreEntitlement(payload,config).status,"non_renewing");
});
test("store access rejects a different customer identity",()=>{
  const payload=fixture(); payload.subscriber.original_app_user_id="another-workspace";
  assert.throws(()=>verifiedStoreEntitlement(payload,config),{code:"BILLING_IDENTITY_CONFLICT"});
});
test("store access rejects unapproved products, refunds, family sharing and sandbox production purchases",()=>{
  for (const patch of [{store:"promotional"},{is_sandbox:true},{ownership_type:"FAMILY_SHARED"},{refunded_at:"2026-10-11T10:00:00Z"},{store_transaction_id:null},{expires_date:"2026-10-10T12:00:00Z"}]) {
    const payload=fixture(); Object.assign(payload.subscriber.subscriptions["biznoryx.monthly"],patch);
    assert.equal(verifiedStoreEntitlement(payload,config),null);
  }
  assert.equal(verifiedStoreEntitlement(fixture(),{...config,products:{app_store:["different-product"]}}),null);
  const payload=fixture();payload.subscriber.subscriptions["biznoryx.monthly"].is_sandbox=true;
  assert.equal(verifiedStoreEntitlement(payload,{...config,allowSandbox:true}).status,"active");
});
test("expired or malformed entitlements never grant perpetual access",()=>{
  for (const expires_date of [null,"bad-date","2026-10-11T12:00:00Z","2027-01-01T00:00:00Z"]) {
    const payload=fixture();payload.subscriber.entitlements.business.expires_date=expires_date;
    assert.equal(verifiedStoreEntitlement(payload,config),null);
  }
});
