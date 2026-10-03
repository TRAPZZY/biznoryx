import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  AuthError,
} from "../auth/core.mjs";

const PAYSTACK_INITIALIZE_URL =
  "https://api.paystack.co/transaction/initialize";

const PAYSTACK_VERIFY_URL =
  "https://api.paystack.co/transaction/verify";

const PAYSTACK_DISABLE_SUBSCRIPTION_URL =
  "https://api.paystack.co/subscription/disable";

const BIZNORYX_MONTHLY_AMOUNT_MINOR =
  4_000_000;

const BIZNORYX_CURRENCY =
  "NGN";

export const PAYSTACK_WEBHOOK_IPS =
  Object.freeze([
    "52.31.139.75",
    "52.49.173.169",
    "52.214.14.220",
  ]);

export function monthlyPlanFromEnv(
  env = process.env,
) {
  const configuredCurrency =
    String(
      env.PAYSTACK_CURRENCY ??
        BIZNORYX_CURRENCY,
    )
      .trim()
      .toUpperCase();

  if (
    configuredCurrency !==
    BIZNORYX_CURRENCY
  ) {
    throw new AuthError(
      "BIZNORYX billing only accepts NGN.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const configuredAmount =
    env.BIZNORYX_MONTHLY_AMOUNT_MINOR
      ? Number(
          env.BIZNORYX_MONTHLY_AMOUNT_MINOR,
        )
      : BIZNORYX_MONTHLY_AMOUNT_MINOR;

  if (
    !Number.isSafeInteger(
      configuredAmount,
    ) ||
    configuredAmount <= 0
  ) {
    throw new AuthError(
      "BIZNORYX monthly billing amount is invalid.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const planCode =
    String(
      env.PAYSTACK_PLAN_CODE ??
        "",
    ).trim() || null;

  const secretKey =
    String(
      env.PAYSTACK_SECRET_KEY ??
        "",
    ).trim() || null;

  return {
    id:
      "biznoryx_monthly_ngn_40000",

    name:
      "BIZNORYX Monthly",

    currency:
      BIZNORYX_CURRENCY,

    amountMinor:
      configuredAmount,

    interval:
      "monthly",

    planCode,

    providerConfigured:
      Boolean(
        secretKey &&
          planCode,
      ),
  };
}

export function planLabel({
  currency,
  amountMinor,
}) {
  const normalizedCurrency =
    String(
      currency ??
        BIZNORYX_CURRENCY,
    )
      .trim()
      .toUpperCase();

  const normalizedAmount =
    Number(
      amountMinor,
    );

  if (
    !Number.isFinite(
      normalizedAmount,
    )
  ) {
    return "₦40,000";
  }

  const majorAmount =
    normalizedAmount /
    100;

  try {
    return new Intl.NumberFormat(
      "en-NG",
      {
        style:
          "currency",

        currency:
          normalizedCurrency,

        minimumFractionDigits:
          0,

        maximumFractionDigits:
          0,
      },
    ).format(
      majorAmount,
    );
  } catch {
    return `₦${new Intl.NumberFormat(
      "en-NG",
      {
        maximumFractionDigits:
          0,
      },
    ).format(
      majorAmount,
    )}`;
  }
}

export function createBillingReference(
  prefix = "bnx",
) {
  return `${prefix}_${Date.now()}_${randomBytes(
    8,
  ).toString(
    "hex",
  )}`;
}

export async function initializePaystackTransaction({
  customerEmail,
  organizationId,
  callbackUrl,
  reference =
    createBillingReference(),
  env = process.env,
  fetchImpl = fetch,
}) {
  const plan =
    monthlyPlanFromEnv(
      env,
    );

  const secretKey =
    String(
      env.PAYSTACK_SECRET_KEY ??
        "",
    ).trim();

  if (
    !secretKey
  ) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  if (
    !plan.planCode
  ) {
    throw new AuthError(
      "The Paystack subscription plan is not configured.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const email =
    String(
      customerEmail ??
        "",
    ).trim();

  if (
    !email
  ) {
    throw new AuthError(
      "A customer email is required to start billing.",
      "VALIDATION_FAILED",
    );
  }

  const organization =
    String(
      organizationId ??
        "",
    ).trim();

  if (
    !organization
  ) {
    throw new AuthError(
      "An organization is required to start billing.",
      "VALIDATION_FAILED",
    );
  }

  const response =
    await fetchImpl(
      PAYSTACK_INITIALIZE_URL,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${secretKey}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            email,

            amount:
              plan.amountMinor,

            currency:
              plan.currency,

            plan:
              plan.planCode,

            reference,

            callback_url:
              callbackUrl,

            metadata: {
              organization_id:
                organization,

              organizationId:
                organization,

              billing_plan_id:
                plan.id,

              billing_plan_name:
                plan.name,

              billing_currency:
                plan.currency,

              billing_amount_minor:
                plan.amountMinor,

              billing_interval:
                plan.interval,

              product:
                "BIZNORYX",
            },
          }),
      },
    );

  let payload;

  try {
    payload =
      await response.json();
  } catch {
    payload =
      null;
  }

  if (
    !response.ok ||
    !payload?.status ||
    !payload?.data
  ) {
    throw new AuthError(
      payload?.message ||
        "Billing checkout could not be started.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const authorizationUrl =
    payload.data
      .authorization_url;

  const accessCode =
    payload.data
      .access_code;

  const returnedReference =
    payload.data.reference ||
    reference;

  if (
    !authorizationUrl ||
    !returnedReference
  ) {
    throw new AuthError(
      "Paystack did not return a valid checkout session.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  return {
    provider:
      "paystack",

    reference:
      returnedReference,

    authorizationUrl,

    accessCode:
      accessCode ??
      null,

    customerEmail:
      email,

    organizationId:
      organization,

    callbackUrl,

    plan,
  };
}

export async function verifyPaystackTransaction({
  reference,
  env = process.env,
  fetchImpl = fetch,
}) {
  const secretKey =
    String(
      env.PAYSTACK_SECRET_KEY ??
        "",
    ).trim();

  if (
    !secretKey
  ) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const normalizedReference =
    String(
      reference ??
        "",
    ).trim();

  if (
    !normalizedReference
  ) {
    throw new AuthError(
      "Billing reference is required.",
      "VALIDATION_FAILED",
    );
  }

  const response =
    await fetchImpl(
      `${PAYSTACK_VERIFY_URL}/${encodeURIComponent(
        normalizedReference,
      )}`,
      {
        method:
          "GET",

        headers: {
          Authorization:
            `Bearer ${secretKey}`,

          Accept:
            "application/json",
        },
      },
    );

  let payload;

  try {
    payload =
      await response.json();
  } catch {
    payload =
      null;
  }

  if (
    !response.ok ||
    !payload?.status ||
    !payload?.data
  ) {
    throw new AuthError(
      payload?.message ||
        "Billing checkout could not be verified.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const transaction =
    payload.data;

  /*
   * BIZNORYX is NGN-only.
   *
   * Reject any successful transaction returned in
   * another currency before it can activate a
   * subscription.
   */

  if (
    transaction.status ===
      "success" &&
    String(
      transaction.currency ??
        "",
    ).toUpperCase() !==
      BIZNORYX_CURRENCY
  ) {
    throw new AuthError(
      "The billing transaction currency does not match BIZNORYX NGN billing.",
      "VALIDATION_FAILED",
    );
  }

  return transaction;
}

export async function disablePaystackSubscription({
  subscriptionCode,
  emailToken,
  env = process.env,
  fetchImpl = fetch,
}) {
  const secretKey = String(
    env.PAYSTACK_SECRET_KEY ?? "",
  ).trim();

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const code = String(
    subscriptionCode ?? "",
  ).trim();

  const token = String(
    emailToken ?? "",
  ).trim();

  if (!code || !token) {
    throw new AuthError(
      "This subscription cannot be canceled automatically because its Paystack subscription identity is incomplete.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const response = await fetchImpl(
    PAYSTACK_DISABLE_SUBSCRIPTION_URL,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },

      body: JSON.stringify({
        code,
        token,
      }),
    },
  );

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (
    !response.ok ||
    payload?.status !== true
  ) {
    throw new AuthError(
      payload?.message ||
        "Paystack could not cancel this subscription.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  return payload.data ?? {
    disabled: true,
  };
}

export function localReviewCheckout({
  customerEmail,
  organizationId,
  callbackUrl,
  reference =
    createBillingReference(
      "bnx_review",
    ),
}) {
  const plan =
    monthlyPlanFromEnv({
      ...process.env,

      PAYSTACK_CURRENCY:
        BIZNORYX_CURRENCY,
    });

  return {
    provider:
      "local_review",

    reference,

    authorizationUrl:
      `${callbackUrl}${
        callbackUrl.includes(
          "?",
        )
          ? "&"
          : "?"
      }checkout=${encodeURIComponent(
        reference,
      )}`,

    accessCode:
      null,

    customerEmail,

    organizationId,

    callbackUrl,

    plan,
  };
}

export function paystackWebhookSignature({
  payload,
  secret,
}) {
  const normalizedSecret =
    String(
      secret ??
        "",
    ).trim();

  if (
    !normalizedSecret
  ) {
    throw new AuthError(
      "Paystack webhook secret is not configured.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const rawPayload =
    Buffer.isBuffer(
      payload,
    )
      ? payload
      : Buffer.from(
          typeof payload ===
            "string"
            ? payload
            : JSON.stringify(
                payload,
              ),
        );

  return createHmac(
    "sha512",
    normalizedSecret,
  )
    .update(
      rawPayload,
    )
    .digest(
      "hex",
    );
}

export function verifyPaystackWebhookSignature({
  payload,
  signature,
  secret,
}) {
  if (
    !signature
  ) {
    return false;
  }

  let expectedHex;

  try {
    expectedHex =
      paystackWebhookSignature({
        payload,
        secret,
      });
  } catch {
    return false;
  }

  const normalizedSignature =
    String(
      signature,
    )
      .trim()
      .toLowerCase();

  if (
    !/^[a-f0-9]{128}$/.test(
      normalizedSignature,
    )
  ) {
    return false;
  }

  const expected =
    Buffer.from(
      expectedHex,
      "hex",
    );

  const actual =
    Buffer.from(
      normalizedSignature,
      "hex",
    );

  if (
    expected.length !==
    actual.length
  ) {
    return false;
  }

  return timingSafeEqual(
    expected,
    actual,
  );
}