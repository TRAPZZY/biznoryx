import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { AuthError } from "../auth/core.mjs";

const PAYSTACK_INITIALIZE_URL =
  "https://api.paystack.co/transaction/initialize";

const PAYSTACK_VERIFY_URL = "https://api.paystack.co/transaction/verify";

const PAYSTACK_DISABLE_SUBSCRIPTION_URL =
  "https://api.paystack.co/subscription/disable";

const PAYSTACK_ENABLE_SUBSCRIPTION_URL =
  "https://api.paystack.co/subscription/enable";

const PAYSTACK_SUBSCRIPTIONS_URL = "https://api.paystack.co/subscription";

const PAYSTACK_REQUEST_TIMEOUT_MS = 15_000;

async function paystackFetchWithTimeout({
  fetchImpl,
  url,
  options,
  operation,
}) {
  const controller = new AbortController();

  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();

      reject(
        new AuthError(
          `Paystack did not respond while ${operation}. Please try again.`,
          "BILLING_PROVIDER_FAILED",
        ),
      );
    }, PAYSTACK_REQUEST_TIMEOUT_MS);
  });

  const request = Promise.resolve().then(() =>
    fetchImpl(url, {
      ...options,

      signal: controller.signal,
    }),
  );

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new AuthError(
        `Paystack did not respond while ${operation}. Please try again.`,
        "BILLING_PROVIDER_FAILED",
      );
    }

    throw new AuthError(
      `Paystack could not be reached while ${operation}. Please try again.`,
      "BILLING_PROVIDER_FAILED",
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

const BIZNORYX_MONTHLY_AMOUNT_MINOR = 4_000_000;

const BIZNORYX_CURRENCY = "NGN";

export const PAYSTACK_WEBHOOK_IPS = Object.freeze([
  "52.31.139.75",
  "52.49.173.169",
  "52.214.14.220",
]);

export function monthlyPlanFromEnv(env = process.env) {
  const configuredCurrency = String(env.PAYSTACK_CURRENCY ?? BIZNORYX_CURRENCY)
    .trim()
    .toUpperCase();

  if (configuredCurrency !== BIZNORYX_CURRENCY) {
    throw new AuthError(
      "BIZNORYX billing only accepts NGN.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const configuredAmount = env.BIZNORYX_MONTHLY_AMOUNT_MINOR
    ? Number(env.BIZNORYX_MONTHLY_AMOUNT_MINOR)
    : BIZNORYX_MONTHLY_AMOUNT_MINOR;

  if (!Number.isSafeInteger(configuredAmount) || configuredAmount <= 0) {
    throw new AuthError(
      "BIZNORYX monthly billing amount is invalid.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const planCode = String(env.PAYSTACK_PLAN_CODE ?? "").trim() || null;

  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim() || null;

  return {
    id: "biznoryx_monthly_ngn_40000",

    name: "BIZNORYX Monthly",

    currency: BIZNORYX_CURRENCY,

    amountMinor: configuredAmount,

    interval: "monthly",

    planCode,

    providerConfigured: Boolean(secretKey && planCode),
  };
}

export function planLabel({ currency, amountMinor }) {
  const normalizedCurrency = String(currency ?? BIZNORYX_CURRENCY)
    .trim()
    .toUpperCase();

  const normalizedAmount = Number(amountMinor);

  if (!Number.isFinite(normalizedAmount)) {
    return "₦40,000";
  }

  const majorAmount = normalizedAmount / 100;

  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",

      currency: normalizedCurrency,

      minimumFractionDigits: 0,

      maximumFractionDigits: 0,
    }).format(majorAmount);
  } catch {
    return `₦${new Intl.NumberFormat("en-NG", {
      maximumFractionDigits: 0,
    }).format(majorAmount)}`;
  }
}

export function createBillingReference(prefix = "bnx") {
  return `${prefix}_${Date.now()}_${randomBytes(8).toString("hex")}`;
}

export async function initializePaystackTransaction({
  customerEmail,
  organizationId,
  callbackUrl,
  reference = createBillingReference(),
  env = process.env,
  fetchImpl = fetch,
}) {
  const plan = monthlyPlanFromEnv(env);

  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  if (!plan.planCode) {
    throw new AuthError(
      "The Paystack subscription plan is not configured.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const email = String(customerEmail ?? "").trim();

  if (!email) {
    throw new AuthError(
      "A customer email is required to start billing.",
      "VALIDATION_FAILED",
    );
  }

  const organization = String(organizationId ?? "").trim();

  if (!organization) {
    throw new AuthError(
      "An organization is required to start billing.",
      "VALIDATION_FAILED",
    );
  }

  const response = await fetchImpl(PAYSTACK_INITIALIZE_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${secretKey}`,

      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      email,

      amount: plan.amountMinor,

      currency: plan.currency,

      plan: plan.planCode,

      reference,

      callback_url: callbackUrl,

      metadata: {
        organization_id: organization,

        organizationId: organization,

        billing_plan_id: plan.id,

        billing_plan_name: plan.name,

        billing_currency: plan.currency,

        billing_amount_minor: plan.amountMinor,

        billing_interval: plan.interval,

        product: "BIZNORYX",
      },
    }),
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.status || !payload?.data) {
    throw new AuthError(
      payload?.message || "Billing checkout could not be started.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const authorizationUrl = payload.data.authorization_url;

  const accessCode = payload.data.access_code;

  const returnedReference = payload.data.reference || reference;

  if (!authorizationUrl || !returnedReference) {
    throw new AuthError(
      "Paystack did not return a valid checkout session.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  return {
    provider: "paystack",

    reference: returnedReference,

    authorizationUrl,

    accessCode: accessCode ?? null,

    customerEmail: email,

    organizationId: organization,

    callbackUrl,

    plan,
  };
}

export async function verifyPaystackTransaction({
  reference,
  env = process.env,
  fetchImpl = fetch,
}) {
  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const normalizedReference = String(reference ?? "").trim();

  if (!normalizedReference) {
    throw new AuthError("Billing reference is required.", "VALIDATION_FAILED");
  }

  const response = await paystackFetchWithTimeout({
    fetchImpl,

    url: `${PAYSTACK_VERIFY_URL}/${encodeURIComponent(normalizedReference)}`,

    options: {
      method: "GET",

      headers: {
        Authorization: `Bearer ${secretKey}`,

        Accept: "application/json",
      },
    },

    operation: "verifying your billing transaction",
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.status || !payload?.data) {
    throw new AuthError(
      payload?.message || "Billing checkout could not be verified.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const transaction = payload.data;

  /*
   * BIZNORYX is NGN-only.
   *
   * Reject any successful transaction returned in
   * another currency before it can activate a
   * subscription.
   */

  if (
    transaction.status === "success" &&
    String(transaction.currency ?? "").toUpperCase() !== BIZNORYX_CURRENCY
  ) {
    throw new AuthError(
      "The billing transaction currency does not match BIZNORYX NGN billing.",
      "VALIDATION_FAILED",
    );
  }

  return transaction;
}

export async function resolvePaystackSubscriptionIdentity({
  reference,
  organizationId,
  planCode,
  expectedSubscriptionCode = null,
  includeInactive = false,
  env = process.env,
  fetchImpl = fetch,
}) {
  const normalizedReference = String(reference ?? "").trim();

  const normalizedOrganizationId = String(organizationId ?? "").trim();

  const normalizedPlanCode = String(planCode ?? "").trim();

  const persistedSubscriptionCode = String(
    expectedSubscriptionCode ?? "",
  ).trim();

  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (
    !normalizedOrganizationId ||
    (!persistedSubscriptionCode &&
      (!normalizedReference || !normalizedPlanCode))
  ) {
    throw new AuthError(
      "The existing subscription cannot be matched safely to Paystack.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  let selected = null;
  let customerId = null;
  let subscriptionCode = persistedSubscriptionCode;

  if (!subscriptionCode) {
    const transaction = await verifyPaystackTransaction({
      reference: normalizedReference,
      env,
      fetchImpl,
    });

    if (
      transaction.status !== "success" ||
      transaction.reference !== normalizedReference
    ) {
      throw new AuthError(
        "The existing subscription requires a verified successful transaction.",
        "BILLING_PROVIDER_FAILED",
      );
    }

    const transactionOrganizationId = directPaystackOrganizationId(transaction);

    if (
      transactionOrganizationId &&
      transactionOrganizationId !== normalizedOrganizationId
    ) {
      throw new AuthError(
        "The Paystack transaction does not belong to this workspace.",
        "ORG_ACCESS_DENIED",
      );
    }

    customerId = Number(transaction?.customer?.id);

    if (!Number.isSafeInteger(customerId) || customerId <= 0) {
      throw new AuthError(
        "Paystack did not return the customer attached to this subscription.",
        "BILLING_PROVIDER_FAILED",
      );
    }

    const listUrl = new URL(PAYSTACK_SUBSCRIPTIONS_URL);

    listUrl.searchParams.set("customer", String(customerId));
    listUrl.searchParams.set("perPage", "100");

    const response = await paystackFetchWithTimeout({
      fetchImpl,
      url: listUrl,
      options: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json",
        },
      },
      operation: "finding your existing subscription",
    });

    let payload;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (
      !response.ok ||
      payload?.status !== true ||
      !Array.isArray(payload?.data)
    ) {
      throw new AuthError(
        payload?.message || "Paystack subscriptions could not be loaded.",
        "BILLING_PROVIDER_FAILED",
      );
    }

    // A customer (and payment method) may be shared by multiple workspaces.
    const matching = payload.data.filter((item) => {
      const candidatePlanCode = String(
        item?.plan?.plan_code ?? item?.plan_code ?? "",
      ).trim();
      return (
        candidatePlanCode === normalizedPlanCode &&
        directPaystackOrganizationId(item) === normalizedOrganizationId &&
        (includeInactive || !paystackSubscriptionIsInactive(item))
      );
    });

    const active = matching.filter(
      (item) => String(item?.status ?? "").toLowerCase() === "active",
    );

    selected =
      active.length === 1
        ? active[0]
        : matching.length === 1
          ? matching[0]
          : null;

    if (!selected) {
      throw new AuthError(
        "BIZNORYX could not uniquely identify a Paystack subscription bound to this workspace.",
        "BILLING_PROVIDER_FAILED",
      );
    }

    subscriptionCode = String(selected.subscription_code ?? "").trim();

    if (!subscriptionCode) {
      throw new AuthError(
        "Paystack returned an incomplete subscription identity.",
        "BILLING_PROVIDER_FAILED",
      );
    }
  }

  const detailResponse = await paystackFetchWithTimeout({
    fetchImpl,

    url: `${PAYSTACK_SUBSCRIPTIONS_URL}/${encodeURIComponent(
      subscriptionCode,
    )}`,

    options: {
      method: "GET",

      headers: {
        Authorization: `Bearer ${secretKey}`,

        Accept: "application/json",
      },
    },

    operation: "loading your subscription details",
  });

  let detailPayload;

  try {
    detailPayload = await detailResponse.json();
  } catch {
    detailPayload = null;
  }

  if (
    !detailResponse.ok ||
    detailPayload?.status !== true ||
    !detailPayload?.data
  ) {
    throw new AuthError(
      detailPayload?.message ||
        "Paystack subscription details could not be loaded.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const detail = detailPayload.data;
  const detailOrganizationId = directPaystackOrganizationId(detail);
  const detailPlanCode = String(
    detail?.plan?.plan_code ?? detail?.plan_code ?? "",
  ).trim();

  if (
    String(detail.subscription_code ?? "").trim() !== subscriptionCode ||
    (detailOrganizationId &&
      detailOrganizationId !== normalizedOrganizationId) ||
    (!persistedSubscriptionCode &&
      detailPlanCode &&
      detailPlanCode !== normalizedPlanCode) ||
    (customerId &&
      detail.customer?.id != null &&
      Number(detail.customer.id) !== customerId) ||
    (!includeInactive && paystackSubscriptionIsInactive(detail))
  ) {
    throw new AuthError(
      "Paystack subscription details do not match the workspace's subscription.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const emailToken = String(
    detail.email_token ?? selected?.email_token ?? "",
  ).trim();

  if (!emailToken) {
    throw new AuthError(
      "Paystack returned an incomplete cancellation token.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  return {
    subscriptionCode,
    emailToken,
  };
}

function directPaystackOrganizationId(record) {
  let metadata = record?.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const organizationId = String(metadata.organization_id ?? "").trim();
  const legacyOrganizationId = String(metadata.organizationId ?? "").trim();
  if (
    organizationId &&
    legacyOrganizationId &&
    organizationId !== legacyOrganizationId
  ) {
    throw new AuthError(
      "Paystack workspace metadata is inconsistent.",
      "ORG_ACCESS_DENIED",
    );
  }
  return organizationId || legacyOrganizationId || null;
}

function paystackSubscriptionIsInactive(subscription) {
  return [
    "complete",
    "completed",
    "disabled",
    "cancelled",
    "canceled",
  ].includes(
    String(subscription?.status ?? "")
      .trim()
      .toLowerCase(),
  );
}

export async function disablePaystackSubscription({
  subscriptionCode,
  emailToken,
  env = process.env,
  fetchImpl = fetch,
}) {
  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const code = String(subscriptionCode ?? "").trim();

  const token = String(emailToken ?? "").trim();

  if (!code || !token) {
    throw new AuthError(
      "This subscription cannot be canceled automatically because its Paystack subscription identity is incomplete.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const response = await fetchImpl(PAYSTACK_DISABLE_SUBSCRIPTION_URL, {
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
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.status !== true) {
    throw new AuthError(
      payload?.message || "Paystack could not cancel this subscription.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  return (
    payload.data ?? {
      disabled: true,
    }
  );
}

export async function enablePaystackSubscription({
  subscriptionCode,
  emailToken,
  env = process.env,
  fetchImpl = fetch,
}) {
  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const code = String(subscriptionCode ?? "").trim();

  const token = String(emailToken ?? "").trim();

  if (!code || !token) {
    throw new AuthError(
      "This subscription cannot be renewed automatically because its Paystack subscription identity is incomplete.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const response = await paystackFetchWithTimeout({
    fetchImpl,

    url: PAYSTACK_ENABLE_SUBSCRIPTION_URL,

    options: {
      method: "POST",

      headers: {
        Authorization: "Bearer " + secretKey,

        "Content-Type": "application/json",

        Accept: "application/json",
      },

      body: JSON.stringify({
        code,
        token,
      }),
    },

    operation: "restoring automatic renewal",
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.status !== true) {
    const providerMessage = String(
      payload?.message || "Paystack could not resume this subscription.",
    ).trim();

    const normalizedMessage = providerMessage.toLowerCase();

    const requiresReplacement =
      (normalizedMessage.includes("cancelled") ||
        normalizedMessage.includes("canceled")) &&
      normalizedMessage.includes("reactivat");

    throw new AuthError(
      providerMessage,
      requiresReplacement
        ? "BILLING_SUBSCRIPTION_RECREATE_REQUIRED"
        : "BILLING_PROVIDER_FAILED",
    );
  }

  return (
    payload.data ?? {
      enabled: true,
    }
  );
}

export async function createPaystackSubscription({
  customer,
  planCode,
  startDate,
  env = process.env,
  fetchImpl = fetch,
}) {
  const secretKey = String(env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (!secretKey) {
    throw new AuthError(
      "Paystack is not configured for this environment.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const normalizedCustomer = String(customer ?? "").trim();

  const normalizedPlanCode = String(planCode ?? "").trim();

  const parsedStartDate = new Date(startDate);

  if (
    !normalizedCustomer ||
    !normalizedPlanCode ||
    !Number.isFinite(parsedStartDate.getTime())
  ) {
    throw new AuthError(
      "The replacement Paystack subscription details are incomplete.",
      "VALIDATION_FAILED",
    );
  }

  const response = await paystackFetchWithTimeout({
    fetchImpl,

    url: PAYSTACK_SUBSCRIPTIONS_URL,

    options: {
      method: "POST",

      headers: {
        Authorization: "Bearer " + secretKey,

        "Content-Type": "application/json",

        Accept: "application/json",
      },

      body: JSON.stringify({
        customer: normalizedCustomer,

        plan: normalizedPlanCode,

        start_date: parsedStartDate.toISOString(),
      }),
    },

    operation: "creating your replacement subscription",
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.status !== true || !payload?.data) {
    throw new AuthError(
      payload?.message ||
        "Paystack could not create the replacement subscription.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  const subscriptionCode = String(payload.data.subscription_code ?? "").trim();

  const emailToken = String(payload.data.email_token ?? "").trim();

  if (!subscriptionCode || !emailToken) {
    throw new AuthError(
      "Paystack created the replacement subscription but returned an incomplete subscription identity.",
      "BILLING_PROVIDER_FAILED",
    );
  }

  return {
    subscriptionCode,

    emailToken,

    status: String(payload.data.status ?? "active"),

    nextPaymentDate:
      payload.data.next_payment_date ?? parsedStartDate.toISOString(),
  };
}

export function localReviewCheckout({
  customerEmail,
  organizationId,
  callbackUrl,
  reference = createBillingReference("bnx_review"),
}) {
  const plan = monthlyPlanFromEnv({
    ...process.env,

    PAYSTACK_CURRENCY: BIZNORYX_CURRENCY,
  });

  return {
    provider: "local_review",

    reference,

    authorizationUrl: `${callbackUrl}${
      callbackUrl.includes("?") ? "&" : "?"
    }checkout=${encodeURIComponent(reference)}`,

    accessCode: null,

    customerEmail,

    organizationId,

    callbackUrl,

    plan,
  };
}

export function paystackWebhookSignature({ payload, secret }) {
  const normalizedSecret = String(secret ?? "").trim();

  if (!normalizedSecret) {
    throw new AuthError(
      "Paystack webhook secret is not configured.",
      "BILLING_PROVIDER_NOT_CONFIGURED",
    );
  }

  const rawPayload = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );

  return createHmac("sha512", normalizedSecret)
    .update(rawPayload)
    .digest("hex");
}

export function verifyPaystackWebhookSignature({ payload, signature, secret }) {
  if (!signature) {
    return false;
  }

  let expectedHex;

  try {
    expectedHex = paystackWebhookSignature({
      payload,
      secret,
    });
  } catch {
    return false;
  }

  const normalizedSignature = String(signature).trim().toLowerCase();

  if (!/^[a-f0-9]{128}$/.test(normalizedSignature)) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");

  const actual = Buffer.from(normalizedSignature, "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
