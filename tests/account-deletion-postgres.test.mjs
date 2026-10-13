import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { PostgresAccountDeletionRepository } from "../src/database/account-deletion-repository.mjs";
import { PostgresBillingRepository } from "../src/database/billing-repository.mjs";
import { PostgresManualEntryRepository } from "../src/database/manual-entry-repository.mjs";
import { ManualEntryService } from "../src/ingestion/manual-entry.mjs";
import { AccountDeletionService } from "../src/compliance/account-deletion-service.mjs";
import { createProductionApp } from "../src/webapp/production-app.mjs";

const password = "DeletionAcceptancePassword2026!";
const connectionString = process.env.TEST_DATABASE_URL;

test("PostgreSQL account deletion revokes access, preserves shared tenants and purges confirmed closures", { skip: !connectionString }, async (t) => {
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString, options: "-c role=biznoryx_app" });
  const identity = new PostgresIdentityRepository(pool);
  const repository = new PostgresAccountDeletionRepository(pool);
  const billing = new PostgresBillingRepository(pool);
  const objects = new Map();
  const storage = { async headObject({key}) { return {exists:objects.has(key)}; },
    async putObject({key,body}) { objects.set(key, body); }, async purgeObject({key}) { objects.delete(key); } };
  const failures = [];
  const deletion = new AccountDeletionService({repository,pool,billing,objectStorage:storage,onError:error=>failures.push(error.cause)});
  async function user() {
    const value = await identity.createUser({email:`delete-${randomUUID()}@example.com`,displayName:"Deletion Owner",password});
    await admin.query("update app_users set email_verified_at = now() where id = $1",[value.id]);
    return value;
  }
  try {
    await t.test("wrong password and unconfirmed closure preserve the account", async () => {
      const owner = await user();
      await identity.createOrganization({actorUserId:owner.id,name:"Protected",slug:randomUUID()});
      await assert.rejects(repository.request({userId:owner.id,password:"incorrect",confirm:true}),{code:"INVALID_CREDENTIALS"});
      await assert.rejects(repository.request({userId:owner.id,password,confirm:true}),{code:"VALIDATION_FAILED"});
      assert.equal((await admin.query("select disabled_at from app_users where id = $1",[owner.id])).rows[0].disabled_at,null);
    });
    await t.test("transfer preserves company data and rejects foreign replacements", async () => {
      const owner = await user(); const successor = await user(); const foreign = await user();
      const organization = await identity.createOrganization({actorUserId:owner.id,name:"Shared business",slug:randomUUID()});
      await admin.query("insert into organization_memberships(organization_id,user_id,role) values($1,$2,'admin')",[organization.id,successor.id]);
      await assert.rejects(repository.request({userId:owner.id,password,confirm:true,transfers:{[organization.id]:foreign.id}}),{code:"VALIDATION_FAILED"});
      const result = await repository.request({userId:owner.id,password,confirm:true,transfers:{[organization.id]:successor.id}});
      await deletion.processPending();
      assert.deepEqual(failures, []);
      assert.equal((await repository.status(result.receipt)).status,"completed");
      assert.equal((await admin.query("select role from organization_memberships where organization_id = $1 and user_id = $2",[organization.id,successor.id])).rows[0].role,"owner");
      assert.equal((await admin.query("select disabled_at from organizations where id = $1",[organization.id])).rows[0].disabled_at,null);
      assert.equal((await admin.query("select email from app_users where id = $1",[owner.id])).rows[0].email,`deleted-${owner.id}@example.invalid`);
    });
    await t.test("confirmed closure purges immutable manual evidence and storage without affecting another tenant", async () => {
      const owner = await user(); const other = await user();
      const organization = await identity.createOrganization({actorUserId:owner.id,name:"Close me",slug:randomUUID()});
      const foreign = await identity.createOrganization({actorUserId:other.id,name:"Keep me",slug:randomUUID()});
      const manual = new ManualEntryService({repository:new PostgresManualEntryRepository(pool),objectStorage:storage});
      const scope = {organizationId:organization.id,actorUserId:owner.id};
      const saved = await manual.saveDraft({...scope,dataSeries:"Sales",period:"2026-10",rows:[["2026-10-01","A","1","2.00"]]});
      const validated = await manual.validateDraft({...scope,draftId:saved.draft.id,version:1});
      await manual.submit({...scope,draftId:saved.draft.id,version:1,validationId:validated.validationId});
      assert.equal(objects.size,1);
      const session = await identity.signIn({email:owner.email,password});
      const result = await repository.request({userId:owner.id,password,confirm:true,closeWorkspaces:true});
      const recoveryReference=`bnx_trial_${randomUUID()}`;
      await billing.trials.saveClosedCheckout({organizationId:organization.id,reference:recoveryReference,
        encryptedState:{v:1,data:"sealed-refund-recovery"},nextAttemptAt:new Date()});
      await assert.rejects(identity.authenticate({token:session.token}),{code:"SESSION_INVALID"});
      await deletion.processPending();
      assert.deepEqual(failures, []);
      assert.equal((await repository.status(result.receipt)).status,"completed");
      assert.equal(objects.size,0);
      assert.equal((await billing.trials.closedCheckout(recoveryReference)).organization_id,organization.id);
      assert.equal((await admin.query("select id from organizations where id = $1",[organization.id])).rowCount,0);
      assert.equal((await admin.query("select id from organizations where id = $1",[foreign.id])).rowCount,1);
      const request = (await admin.query("select contact_email,status from account_deletion_requests where user_id = $1",[owner.id])).rows[0];
      assert.deepEqual(request,{contact_email:null,status:"completed"});
      await assert.rejects(repository.status("invalid"),{code:"VALIDATION_FAILED"});
    });
    await t.test("mobile bearer sessions work without weakening browser cookie CSRF", async () => {
      const owner = await user();
      const {server} = createProductionApp({pool,emailVerificationRepository:{}});
      await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      try {
        const native = await fetch(`${origin}/api/sign-in`,{method:"POST",headers:{"Content-Type":"application/json","X-Biznoryx-Client":"mobile-v1"},body:JSON.stringify({email:owner.email,password})});
        const result = await native.json();
        assert.equal(native.status,200); assert.match(result.sessionToken,/^[\w-]{43}$/); assert.equal(native.headers.get("set-cookie"),null);
        const headers = {"Content-Type":"application/json","X-Biznoryx-Client":"mobile-v1",Authorization:`Bearer ${result.sessionToken}`};
        const context = await fetch(`${origin}/api/account/deletion`,{headers}); assert.equal(context.status,200);
        const spoofed=await fetch(`${origin}/api/account/deletion`,{headers:{...headers,Origin:origin,Cookie:`bnx_session=${result.sessionToken}`}});
        assert.equal(spoofed.status,401);
        const malformed=await fetch(`${origin}/api/account/deletion`,{headers:{...headers,Authorization:"Bearer invalid",Cookie:`bnx_session=${result.sessionToken}`}});
        assert.equal(malformed.status,401);
        const denied = await fetch(`${origin}/api/account/deletion`,{method:"POST",headers:{"Content-Type":"application/json",Cookie:`bnx_session=${result.sessionToken}`},body:JSON.stringify({password,confirm:true})});
        assert.equal(denied.status,403);
        const created = await fetch(`${origin}/api/account/deletion`,{method:"POST",headers,body:JSON.stringify({password,confirm:true})});
        assert.equal(created.status,202);
        const invalid = await fetch(`${origin}/api/account/deletion`,{headers}); assert.equal(invalid.status,401);
      } finally { await new Promise(resolve=>server.close(resolve)); }
    });
  } finally { await pool.end(); await admin.end(); }
});
