/**
 * Private platform owner alerts. No user/tenant-facing routes or public API.
 * Delivery is at-least-once across network and DB commit failures; the
 * claim token makes stale-worker acknowledgement harmless.
 */
const ERROR_CODES = new Set([
  'TELEGRAM_TIMEOUT',
  'TELEGRAM_RATE_LIMIT',
  'TELEGRAM_HTTP',
  'TELEGRAM_REJECTED',
  'DELIVERY_EXCEPTION',
]);

export function ownerAlertConfiguration(env = process.env) {
  if (env.OWNER_ALERTS_ENABLED !== 'true') return { enabled: false };
  const token = env.OWNER_TELEGRAM_BOT_TOKEN;
  const chatId = env.OWNER_TELEGRAM_CHAT_ID;
  if (!/^\d{5,12}:[A-Za-z0-9_-]{25,}$/.test(token ?? '')) {
    return { enabled: false, errorCode: 'OWNER_ALERT_CONFIG_INVALID' };
  }
  if (!/^-?\d{1,20}$/.test(chatId ?? '')) {
    return { enabled: false, errorCode: 'OWNER_ALERT_CONFIG_INVALID' };
  }
  return { enabled: true, token, chatId };
}

function backoff(attempts, retryAfter = 0) {
  return Math.min(3600, Math.max(retryAfter, 30 * 2 ** Math.max(0, Math.min(5, attempts - 1))));
}

export async function deliverTelegramOwnerAlert(config, occurredAt, { fetchImpl = fetch } = {}) {
  if (!config.enabled) throw new Error('OWNER_ALERT_CONFIG_INVALID');
  const occurred = new Date(occurredAt);
  if (!Number.isFinite(occurred.getTime())) throw new Error('OWNER_ALERT_DATE_INVALID');
  const message = [
    'BIZNORYX | NEW USER REGISTRATION',
    '',
    'A new user has successfully completed email verification.',
    'Status: Email verified',
    `Registration verified: ${occurred.toISOString()}`,
    'Platform: BIZNORYX',
  ].join('\n');
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return { sent: false, code: 'TELEGRAM_TIMEOUT', retryAfter: 30 };
  }
  if (response.status === 429) {
    let retryAfter = Number(response.headers?.get?.('retry-after')) || 30;
    try {
      const body = await response.json();
      if (Number.isInteger(body?.parameters?.retry_after)) retryAfter = body.parameters.retry_after;
    } catch { /* no provider body is required */ }
    return { sent: false, code: 'TELEGRAM_RATE_LIMIT', retryAfter: Math.min(3600, Math.max(10, retryAfter)) };
  }
  if (!response.ok) {
    return { sent: false, code: 'TELEGRAM_HTTP', retryAfter: 30 };
  }
  try {
    const body = await response.json();
    if (body?.ok === true) return { sent: true };
    return { sent: false, code: 'TELEGRAM_REJECTED', retryAfter: 30 };
  } catch {
    return { sent: false, code: 'TELEGRAM_REJECTED', retryAfter: 30 };
  }
}

export async function deliverOwnerRegistrationAlerts(pool, config, { fetchImpl = fetch } = {}) {
  if (!config.enabled) return 0;
  const claimed = await pool.query(
    'select * from claim_platform_owner_registration_alerts($1)',
    [5],
  );
  let delivered = 0;
  for (const row of claimed.rows) {
    let outcome;
    try {
      outcome = await deliverTelegramOwnerAlert(config, row.occurred_at, { fetchImpl });
    } catch {
      outcome = { sent: false, code: 'DELIVERY_EXCEPTION', retryAfter: 30 };
    }
    const code = ERROR_CODES.has(outcome.code) ? outcome.code : 'DELIVERY_EXCEPTION';
    const attempts = Number(row.delivery_attempt || 1);
    const retryAfter = backoff(attempts, outcome.retryAfter);
    const completed = await pool.query(
      'select finish_platform_owner_registration_alert($1,$2,$3,$4,$5) as confirmed',
      [row.event_id, row.claim_token, outcome.sent === true, outcome.sent ? null : code, outcome.sent ? 0 : retryAfter],
    );
    if (outcome.sent && completed.rows[0]?.confirmed) delivered++;
  }
  return delivered;
}

export function startOwnerRegistrationAlerts({
  pool,
  onError = () => {},
  env = process.env,
  fetchImpl = fetch,
  intervalMs = 15000,
} = {}) {
  const config = ownerAlertConfiguration(env);
  if (!config.enabled) {
    if (config.errorCode) onError(new Error(config.errorCode));
    return async () => {};
  }
  let stopped = false;
  let active = null;
  const tick = () => {
    if (stopped || active) return;
    active = deliverOwnerRegistrationAlerts(pool, config, { fetchImpl })
      .catch(() => onError(new Error('OWNER_ALERT_DELIVERY_FAILED')))
      .finally(() => { active = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
