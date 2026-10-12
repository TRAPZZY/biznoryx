import assert from "node:assert/strict";
import test from "node:test";
import {AccountDeletionService} from "../src/compliance/account-deletion-service.mjs";

test("store privacy cleanup retries after object deletion fails without re-verifying a deleted subscriber",async()=>{
  let deletes=0;let purges=0;let checks=0;
  const service=new AccountDeletionService({
    billing:{async ensureSubscription(input){checks++;assert.equal(input.skipStoreRefresh,true);return {provider:"app_store",status:"active"};}},
    pool:{async connect(){return {release(){},async query(sql){
      if(sql.startsWith("select storage_key"))return {rows:[{storage_key:"organizations/org-1/file.csv"}]};
      if(sql.startsWith("select customer_id"))return {rows:[{customer_id:"store-customer"}]};
      return {rows:[],rowCount:0};
    }};}},
    env:{REVENUECAT_SECRET_API_KEY:"test-secret"},
    async fetchImpl(url,options){
      assert.equal(url,"https://api.revenuecat.com/v1/subscribers/store-customer");
      assert.equal(options.method,"DELETE");deletes++;return {status:deletes===1?200:404};
    },
    objectStorage:{async purgeObject({key}){assert.equal(key,"organizations/org-1/file.csv");if(++purges===1)throw new Error("Temporary storage failure");}},
  });
  await assert.rejects(service.closeWorkspace("org-1"),/Temporary storage failure/);
  await service.closeWorkspace("org-1");
  assert.equal(deletes,2);assert.equal(purges,2);assert.equal(checks,2);
});
