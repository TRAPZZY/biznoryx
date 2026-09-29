import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export function appShellState({ user, session, store }) {
  if (!user || !session) {
    return { state: 'loading', redirectTo: '/sign-in' };
  }
  if (user.disabledAt) {
    return { state: 'disabled', message: 'This account is disabled.' };
  }
  const memberships = [...store.memberships.values()].filter((membership) => membership.userId === user.id && membership.status === 'active');
  if (memberships.length === 0) {
    return { state: 'empty', primaryAction: 'create-organization' };
  }
  const activeMembership = memberships.find((membership) => membership.organizationId === session.activeOrganizationId) ?? memberships[0];
  const organization = store.organizations.get(activeMembership.organizationId);
  return {
    state: 'ready',
    user: { id: user.id, email: user.email, displayName: user.displayName },
    activeOrganization: { id: organization.id, name: organization.name, slug: organization.slug },
    organizations: memberships.map((membership) => {
      const item = store.organizations.get(membership.organizationId);
      return { id: item.id, name: item.name, role: membership.role };
    })
  };
}

export function protectedRoute({ user, organizationId, capability, store, handler }) {
  try {
    new AuthorizationService(store).requireCapability({ userId: user.id, organizationId, capability });
    return handler();
  } catch (error) {
    if (error instanceof AuthError) {
      return { state: 'error', status: error.code === 'CAPABILITY_DENIED' ? 403 : 404, message: 'Not available.' };
    }
    throw error;
  }
}

export function requireBusinessRead(args) {
  return protectedRoute({ ...args, capability: CAPABILITIES.READ_BUSINESS_DATA });
}
