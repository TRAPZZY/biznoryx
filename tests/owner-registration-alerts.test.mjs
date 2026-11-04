import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ownerAlertConfiguration,
  deliverTelegramOwnerAlert,
  deliverOwnerRegistrationAlerts,
  startOwnerRegistrationAlerts,
} from '../src/worker/owner-registration-alerts.mjs';

const token = '123456789:' + 'A'.repeat(35);
const env = { OWNER_ALERTS_ENABLED: 'true', OWNER_TELEGRAM_BOT_TOKEN: token, OWNER_TELEGRAM_CHAT_ID: '123456789' };
const configured = ownerAlertConfiguration(env);

test('owner alerts are disabled without explicit activation or valid secrets', async () => {
  assert.deepEqual(ownerAlertConfiguration({}), { enabled: false });
  assert.deepEqual(ownerAlertConfiguration({ OWNER_ALERTS_ENABLED: 'false' }), { enabled: false });
  assert.equal(ownerAlertConfiguration({ OWNER_ALERTS_ENABLED: 'true', OWNER_TELEGRAM_BOT_TOKEN: 'unsafe' }).errorCode, 'OWNER_ALERT_CONFIG_INVALID');
  assert.equal(configured.enabled, true);
  let queried = false;
  const stop = startOwnerRegistrationAlerts({
    pool: { query() { queried = true; throw new Error('should not query'); } },
    env: {},
  });
  await stop();
  assert.equal(queried, false);
});

test('Telegram message omits customer identifiers and interprets actual verification time', async () => {
  const calls = [];
  const outcome = await deliverTelegramOwnerAlert(configured, '2026-11-04T10:00:00Z', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(outcome.sent, true);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, env.OWNER_TELEGRAM_CHAT_ID);
  assert.match(body.text, /2026-11-04T10:00:00.000Z/);
  assert.doesNotMatch(body.text, /email address|password|OTP|token/i);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /sendMessage$/);
});

test('timeouts, rejected responses and Telegram 429 do not expose provider details', async () => {
  const fail = await deliverTelegramOwnerAlert(configured, new Date(), {
    fetchImpl: async () => { throw new Error('secret=' + token); },
  });
  assert.deepEqual(fail, { sent: false, code: 'TELEGRAM_TIMEOUT', retryAfter: 30 });
  assert.equal(JSON.stringify(fail).includes(token), false);
  const limited = await deliverTelegramOwnerAlert(configured, new Date(), {
    fetchImpl: async () => ({
      status: 429,
      headers: { get: () => '65' },
      json: async () => ({ parameters: { retry_after: 65 } }),
    }),
  });
  assert.deepEqual(limited, { sent: false, code: 'TELEGRAM_RATE_LIMIT', retryAfter: 65 });
  const rejected = await deliverTelegramOwnerAlert(configured, new Date(), {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ ok: false }) }),
  });
  assert.equal(rejected.code, 'TELEGRAM_REJECTED');
});

test('worker records claim receipt and finalized result, not customer data', async () => {
  const sql = [];
  const pool = { async query(statement, values) {
    sql.push({ statement, values });
    if (statement.includes('claim_platform_owner_registration_alerts')) {
      return { rows: [{ event_id: 'event', claim_token: 'nonce', occurred_at: '2026-11-04T10:00:00Z', delivery_attempt: 1 }] };
    }
    if (statement.includes('finish_platform_owner_registration_alert')) return { rows: [{ confirmed: true }] };
    throw new Error('Unexpected SQL');
  } };
  const delivered = await deliverOwnerRegistrationAlerts(pool, configured, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });
  assert.equal(delivered, 1);
  assert.equal(sql.length, 2);
  assert.deepEqual(sql[1].values, ['event', 'nonce', true, null, 0]);
});

test('migration makes collection default-off and only reacts to first verification', () => {
  const sql = readFileSync('db/migrations/0039_platform_owner_registration_alerts.sql', 'utf8');
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /old.email_verified_at is null and new.email_verified_at is not null/);
  assert.match(sql, /unique references app_users\(id\)/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /revoke all on function claim_platform_owner_registration_alerts\(integer\) from public/);
  assert.match(sql, /if not exists\(select 1 from platform_owner_alert_settings where singleton and enabled\)/);
});
