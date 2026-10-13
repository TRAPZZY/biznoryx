import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runRetentionMaintenance } from "../src/compliance/retention-maintenance.mjs";
import { validateComplianceManifest } from "../src/compliance/controls.mjs";

function harness({ authorized = true, failure = null } = {}) {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({sql,values});
    if (sql.includes("rolsuper")) return { rows: [{authorized}] };
    if (failure && sql.includes(failure)) throw new Error("Injected database failure");
    if (sql.includes("as sessions")) return { rows: [{sessions:2,challenges:3}] };
    if (sql.includes("as outstanding")) return { rows: [{outstanding:2,overdue:1,attention:1}] };
    return { rows: [], rowCount:1 };
  }, release() { calls.push({sql:"release"}); } };
  return { pool: { async connect() { return client; } }, calls };
}

test("retention dry run is read-only, reports missed deletion targets and never exposes record identities", async () => {
  const {pool,calls} = harness();
  const result = await runRetentionMaintenance({pool,now:new Date("2026-10-12T00:00:00Z")});
  assert.equal(calls[1].sql,"set transaction read only");
  assert.equal(calls.some(call=>call.sql.startsWith("delete") || call.sql.includes("with expired")),false);
  assert.equal(result.credentialCutoff,"2026-07-14T00:00:00.000Z");
  assert.deepEqual(result.candidates,{sessions:2,challenges:3});
  assert.deepEqual(result.removed,{sessions:0,challenges:0});
  assert.equal(result.deletion.overdue,1);
  assert.equal(result.infrastructure,"unverified");
  assert.equal(JSON.stringify(result).includes("user_id"),false);
});

test("retention rejects an application role instead of returning misleading RLS-filtered counts", async () => {
  const {pool,calls} = harness({authorized:false});
  await assert.rejects(runRetentionMaintenance({pool}),{code:"RETENTION_ROLE_REQUIRED"});
  assert.equal(calls.some(call=>call.sql.includes("as sessions")),false);
  assert.ok(calls.some(call=>call.sql==="rollback"));
});

test("retention applies only bounded old inactive credential cleanup and rolls back on any failure", async () => {
  const {pool,calls} = harness({failure:"delete from email_verification_challenges"});
  await assert.rejects(runRetentionMaintenance({pool,apply:true,batchSize:2}),/Injected/);
  assert.ok(calls.some(call=>call.sql.includes("delete from user_sessions") && call.values[2]===2));
  assert.equal(calls.some(call=>/delete from (billing|audit|raw_data|app_users)/.test(call.sql)),false);
  assert.ok(calls.some(call=>call.sql==="rollback"));
  assert.equal(calls.some(call=>call.sql==="commit"),false);
});

test("retention refuses invalid dates, implicit apply values and excessive batches before connecting", async () => {
  for (const options of [{now:new Date("invalid")},{apply:"yes"},{batchSize:0},{batchSize:5001}]) {
    await assert.rejects(runRetentionMaintenance(options),TypeError);
  }
});

test("repository retention claims stay blocked until infrastructure evidence exists", async () => {
  const manifest = JSON.parse(await readFile("compliance/security-controls.manifest.json","utf8"));
  const gate = validateComplianceManifest(manifest);
  assert.equal(gate.state,"blocked");
  assert.ok(gate.findings.some(item=>item.message.includes("data_retention")));
  assert.ok(gate.findings.some(item=>item.message.includes("backup_recovery")));
  assert.equal(manifest.dataProtection.classes.some(item=>item.retention==="seven_years"),false);
});
