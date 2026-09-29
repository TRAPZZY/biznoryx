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

  const memberships =
    await identityRepository.activeMemberships(
      user.id,
    );

  if (memberships.length === 0) {
    return {
      state: "empty",
      primaryAction: "create-organization",
      user: publicUser(user),
      organizations: [],
      activeOrganization: null,
    };
  }

  const activeMembership =
    memberships.find(
      (membership) =>
        membership.organizationId ===
        session.activeOrganizationId,
    ) ?? memberships[0];

  return {
    state: "ready",

    user: publicUser(user),

    activeOrganization: {
      id: activeMembership.organizationId,
      name: activeMembership.organizationName,
      slug: activeMembership.organizationSlug,
    },

    organizations: memberships.map(
      (membership) => ({
        id: membership.organizationId,
        name: membership.organizationName,
        role: membership.role,
      }),
    ),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}