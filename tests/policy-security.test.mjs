import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import { createPostgresPool, withTransaction } from "../src/database/postgres.mjs";

test("PostgreSQL account policy evidence is persistent and visible only to its owner", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = createPostgresPool({ DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test" });
  const identity = new PostgresIdentityRepository(pool);
  const suffix = randomUUID();
  try {
    const owner = await identity.createUser({ email: `policy-security-${suffix}@example.test`, displayName: "Policy security owner", password: "PolicySecurityPassphrase2026!" });
    const other = await identity.createUser({ email: `policy-other-${suffix}@example.test`, displayName: "Other user", password: "PolicySecurityPassphrase2026!" });
    assert.equal((await identity.policyStatus(owner.id)).required, true);
    await identity.acceptCurrentPolicy({ userId: owner.id, acknowledgements: { termsAccepted: true, privacyAccepted: true, dataAuthorityAccepted: true, guideAcknowledged: true } });
    assert.equal((await identity.policyStatus(owner.id)).required, false);
    assert.equal((await identity.policyStatus(other.id)).required, true);
    const foreign = await withTransaction(pool, async (client) => {
      await client.query("select set_config('app.current_user_id', $1, true)", [other.id]);
      return client.query("select id from audit_events where actor_user_id = $1 and organization_id is null", [owner.id]);
    });
    assert.equal(foreign.rowCount, 0);
    const anonymous = await pool.query("select id from audit_events where actor_user_id = $1 and organization_id is null", [owner.id]);
    assert.equal(anonymous.rowCount, 0);
  } finally { await pool.end(); }
});
