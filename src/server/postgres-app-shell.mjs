import {
  CURRENT_POLICY_VERSIONS,
  POLICY_EFFECTIVE_DATE,
} from "../compliance/user-policy.mjs";

export async function postgresAppShellState({
  user,
  session,
  identityRepository,
}) {
  if (!user || !session) {
    return {
      state: "loading",
      redirectTo: "/sign-in",
    };
  }

  if (user.disabledAt) {
    return {
      state: "disabled",
      message: "This account is disabled.",
    };
  }

  const policy =
    typeof identityRepository.policyStatus === "function"
      ? await identityRepository.policyStatus(user.id)
      : {
          required: false,
          effectiveDate: POLICY_EFFECTIVE_DATE,
          ...CURRENT_POLICY_VERSIONS,
          acceptedAt: null,
        };

  if (policy.required) {
    return {
      state: "policy_required",
      primaryAction: "accept-policy",
      user: publicUser(user),
      policy,
      organizations: [],
      activeOrganization: null,
    };
  }

  const memberships = await identityRepository.activeMemberships(user.id);

  if (memberships.length === 0) {
    return {
      state: "empty",
      primaryAction: "create-organization",
      user: publicUser(user),
      policy,
      organizations: [],
      activeOrganization: null,
    };
  }

  const activeMembership =
    memberships.find(
      (membership) =>
        membership.organizationId === session.activeOrganizationId,
    ) ?? memberships[0];

  return {
    state: "ready",

    user: publicUser(user),

    policy,

    activeOrganization: {
      id: activeMembership.organizationId,
      name: activeMembership.organizationName,
      slug: activeMembership.organizationSlug,
    },

    organizations: memberships.map((membership) => ({
      id: membership.organizationId,
      name: membership.organizationName,
      role: membership.role,
    })),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}
