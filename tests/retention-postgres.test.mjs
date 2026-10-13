import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { runRetentionMaintenance } from "../src/compliance/retention-maintenance.mjs";

test("PostgreSQL retention dry run and bounded apply preserve active identity and business records", {skip:!process.env.TEST_DATABASE_URL}, async () => {
  const pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const user = randomUUID();
  const now = new Date("2026-10-12T00:00:00Z");
  const old = "2026-01-01T00:00:00Z";
  const expired = "2026-10-01T00:00:00Z";
  const future = "2026-11-01T00:00:00Z";
  const sessionIds = Array.from({length:4},()=>randomUUID());
  const challengeIds = Array.from({length:3},()=>randomUUID());
  try {
    await pool.query("insert into app_users(id,email,display_name,password_hash) values($1,$2,'Retention test','synthetic-local-only')",[user,`${user}@test.invalid`]);
    for (let index=0;index<4;index++) await pool.query(`insert into user_sessions(id,user_id,session_token_hash,csrf_token_hash,created_at,expires_at,revoked_at)
      values($1,$2,$3,$3,$4,$5,$6)`,[sessionIds[index],user,randomUUID(),index===3?"2026-09-01T00:00:00Z":old,index===0?expired:future,index===1?expired:null]);
    for (let index=0;index<3;index++) await pool.query(`insert into email_verification_challenges(id,user_id,email,code_hash,created_at,expires_at)
      values($1,$2,$3,$4,$5,$6)`,[challengeIds[index],user,`${user}@test.invalid`,"a".repeat(64),index===2?"2026-09-01T00:00:00Z":old,index===1?future:expired]);
    const protectedSql = "select (select count(*) from app_users) as users, (select count(*) from billing_payments) as payments, (select count(*) from audit_events) as audit, (select count(*) from raw_data_objects) as objects";
    const before = (await pool.query(protectedSql)).rows[0];
    const dry = await runRetentionMaintenance({pool,now});
    assert.equal(dry.mode,"dry-run");
    assert.equal((await pool.query("select count(*)::integer as n from user_sessions where user_id=$1",[user])).rows[0].n,4);
    const first = await runRetentionMaintenance({pool,now,apply:true,batchSize:1});
    assert.deepEqual(first.removed,{sessions:1,challenges:1});
    await runRetentionMaintenance({pool,now,apply:true,batchSize:1});
    const remaining = await pool.query("select id from user_sessions where user_id=$1 order by id",[user]);
    assert.deepEqual(remaining.rows.map(row=>row.id).sort(),sessionIds.slice(2).sort());
    const challenges = await pool.query("select id from email_verification_challenges where user_id=$1 order by id",[user]);
    assert.deepEqual(challenges.rows.map(row=>row.id).sort(),challengeIds.slice(1).sort());
    assert.deepEqual((await pool.query(protectedSql)).rows[0],before);
    const repeated = await runRetentionMaintenance({pool,now,apply:true});
    assert.equal(repeated.removed.sessions,0);
    assert.equal(repeated.removed.challenges,0);
    const client = await pool.connect();
    try {
      await client.query("set role biznoryx_app");
      const runtime = {async connect(){return {query:(...args)=>client.query(...args),release(){}};}};
      await assert.rejects(runRetentionMaintenance({pool:runtime,now}),{code:"RETENTION_ROLE_REQUIRED"});
      await client.query("reset role");
    } finally {client.release();}
  } finally {await pool.end();}
});
