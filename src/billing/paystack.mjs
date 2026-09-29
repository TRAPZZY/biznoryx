import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError } from '../auth/core.mjs';

const PAYSTACK_INITIALIZE_URL = 'https://api.paystack.co/transaction/initialize';
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
export const PAYSTACK_WEBHOOK_IPS = Object.freeze([
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220'
]);

export function monthlyPlanFromEnv(env = process.env) {
  const amountMinor = Number.parseInt(env.BIZNORYX_MONTHLY_PRICE_MINOR ?? '2000', 10);
  return {
    id: 'biznoryx_monthly',
    name: 'BIZNORYX Monthly',
    currency: env.PAYSTACK_CURRENCY ?? 'USD',
    amountMinor: Number.isFinite(amountMinor) && amountMinor > 0 ? amountMinor : 2000,
    interval: 'monthly',
    planCode: env.PAYSTACK_PLAN_CODE ?? null,
    providerConfigured: Boolean(env.PAYSTACK_SECRET_KEY)
  };
}

export function planLabel(plan = monthlyPlanFromEnv()) {
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: plan.currency,
    maximumFractionDigits: 2
  }).format(plan.amountMinor / 100);
}

export function createBillingReference(prefix = 'bnx') {
  return `${prefix}_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

export async function initializePaystackTransaction({
  env = process.env,
  fetchImpl = globalThis.fetch,
  customerEmail,
  organizationId,
  callbackUrl,
  reference = createBillingReference()
}) {
  const plan = monthlyPlanFromEnv(env);
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new AuthError('Paystack is not configured for this environment.', 'BILLING_PROVIDER_NOT_CONFIGURED');
  }
  const body = {
    email: customerEmail,
    amount: plan.amountMinor,
    currency: plan.currency,
    reference,
    callback_url: callbackUrl,
    metadata: {
      organization_id: organizationId,
      product: 'biznoryx',
      plan: plan.id
    }
  };
  if (plan.planCode) body.plan = plan.planCode;
  const response = await fetchImpl(PAYSTACK_INITIALIZE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== true || !payload?.data?.authorization_url) {
    throw new AuthError('Billing checkout could not be started.', 'BILLING_PROVIDER_FAILED');
  }
  return {
    provider: 'paystack',
    reference,
    authorizationUrl: payload.data.authorization_url,
    accessCode: payload.data.access_code ?? null,
    plan
  };
}

export async function verifyPaystackTransaction({
  env = process.env,
  fetchImpl = globalThis.fetch,
  reference
}) {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new AuthError('Paystack is not configured for this environment.', 'BILLING_PROVIDER_NOT_CONFIGURED');
  }
  const response = await fetchImpl(`${PAYSTACK_VERIFY_URL}/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== true) {
    throw new AuthError('Billing checkout could not be verified.', 'BILLING_PROVIDER_FAILED');
  }
  return payload.data;
}

export function localReviewCheckout({ customerEmail, organizationId, callbackUrl, reference = createBillingReference('bnx_review') }) {
  return {
    provider: 'local_review',
    reference,
    authorizationUrl: `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}checkout=${encodeURIComponent(reference)}`,
    accessCode: null,
    plan: monthlyPlanFromEnv(),
    customerEmail,
    organizationId
  };
}

export function paystackWebhookSignature({ payload, secret }) {
  if (!secret) {
    throw new AuthError('Paystack webhook secret is not configured.', 'BILLING_PROVIDER_NOT_CONFIGURED');
  }
  return createHmac('sha512', secret).update(payload).digest('hex');
}

export function verifyPaystackWebhookSignature({ payload, signature, secret }) {
  const expected = Buffer.from(paystackWebhookSignature({ payload, secret }), 'hex');
  const actual = Buffer.from(String(signature ?? ''), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
