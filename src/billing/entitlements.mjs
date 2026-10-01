import {
  AuthError,
} from "../auth/core.mjs";

export function subscriptionHasPremiumAccess(
  subscription,
  {
    now = () => new Date(),
  } = {},
) {
  if (!subscription) {
    return false;
  }

  if (
    subscription.status ===
    "active"
  ) {
    return true;
  }

  if (
    subscription.status ===
    "non_renewing"
  ) {
    if (
      !subscription.currentPeriodEnd
    ) {
      return false;
    }

    const periodEnd =
      new Date(
        subscription.currentPeriodEnd,
      ).getTime();

    if (
      !Number.isFinite(
        periodEnd,
      )
    ) {
      return false;
    }

    return (
      periodEnd >
      now().getTime()
    );
  }

  return false;
}

export async function requirePremiumSubscription({
  billingRepository,
  organizationId,
  actorUserId = null,
  now = () => new Date(),
}) {
  if (
    !billingRepository ||
    typeof billingRepository
      .ensureSubscription !==
      "function"
  ) {
    throw new AuthError(
      "Billing is temporarily unavailable.",
      "SERVICE_UNAVAILABLE",
    );
  }

  if (!organizationId) {
    throw new AuthError(
      "Select a business workspace before using this feature.",
      "ORG_ACCESS_DENIED",
    );
  }

  const subscription =
    await billingRepository
      .ensureSubscription({
        organizationId,

        actorUserId,

        provider:
          "paystack",
      });

  if (
    subscriptionHasPremiumAccess(
      subscription,
      {
        now,
      },
    )
  ) {
    return subscription;
  }

  throw new AuthError(
    subscriptionRequiredMessage(
      subscription,
    ),
    "SUBSCRIPTION_REQUIRED",
  );
}

function subscriptionRequiredMessage(
  subscription,
) {
  switch (
    subscription?.status
  ) {
    case "trialing":
      return "Activate your BIZNORYX subscription to upload and process production business data.";

    case "pending_checkout":
      return "Complete your BIZNORYX payment to unlock this feature.";

    case "past_due":
      return "Your BIZNORYX subscription payment requires attention before this feature can be used.";

    case "non_renewing":
      return "Your paid BIZNORYX subscription period has ended. Reactivate billing to continue.";

    case "canceled":
      return "Your BIZNORYX subscription is canceled. Activate a subscription to continue.";

    default:
      return "An active BIZNORYX subscription is required to use this feature.";
  }
}