import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresIdentityRepository } from '../src/database/identity-repository.mjs';

const connectionString = process.env.UPDATES_TEST_ADMIN_DATABASE_URL;

test('first confirmed email verification commits exactly one private owner event when enabled', { skip: !connectionString }, async () => {
  const admin = new pg.Pool({ connectionString });
  let user;
  try {
    const identity = new PostgresIdentityRepository(admin);
    user = await identity.createUser({
      email: `owner-alert-${randomUUID()}@example.com`,
      displayName: 'Synthetic Owner Alert',
      password: 'SyntheticOwnerAlertPassword2026!',
    });
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('update platform_owner_alert_settings set enabled = true where singleton');
      await client.query('update app_users set email_verified_at = now() where id = $1', [user.id]);
      await client.query('update app_users set email_verified_at = now() where id = $1', [user.id]);
      assert.equal((await client.query(
        'select count(*)::integer as count from platform_owner_registration_alerts where user_id = $1',
        [user.id],
      )).rows[0].count, 1);
      const first = await client.query('select event_id, claim_token, occurred_at, delivery_attempt from claim_platform_owner_registration_alerts($1)', [1]);
      assert.equal(first.rows.length, 1);
      const row = first.rows[0];
      assert.equal(row.delivery_attempt, 1);
      const acknowledged = await client.query(
        'select finish_platform_owner_registration_alert($1,$2,$3,$4,$5) as confirmed',
        [row.event_id, row.claim_token, true, null, 0],
      );
      assert.equal(acknowledged.rows[0].confirmed, true);
      const replay = await client.query(
        'select finish_platform_owner_registration_alert($1,$2,$3,$4,$5) as confirmed',
        [row.event_id, row.claim_token, true, null, 0],
      );
      assert.equal(replay.rows[0].confirmed, false);
      await client.query('rollback');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    assert.equal((await admin.query(
      'select count(*)::integer as count from platform_owner_registration_alerts where user_id = $1',
      [user.id],
    )).rows[0].count, 0);
    const client2 = await admin.connect();
    try {
      await client2.query('begin');
      await client2.query('update platform_owner_alert_settings set enabled = false where singleton');
      await client2.query('update app_users set email_verified_at = now() where id = $1', [user.id]);
      assert.equal((await client2.query(
        'select count(*)::integer as count from platform_owner_registration_alerts where user_id = $1',
        [user.id],
      )).rows[0].count, 0);
      await client2.query('rollback');
    } catch (error) {
      await client2.query('rollback');
      throw error;
    } finally {
      client2.release();
    }
  } finally {
    if (user) await admin.query('delete from app_users where id = $1', [user.id]);
    await admin.end();
  }
});
