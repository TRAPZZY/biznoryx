import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorizationService,
  CAPABILITIES,
  IdentityService,
  InvitationService,
  OrganizationService,
  SessionService,
  createEmptyStore,
  withOrganizationTransaction
} from '../src/auth/core.mjs';
import { appShellState, requireBusinessRead } from '../src/server/app-shell.mjs';

function fixture() {
  const store = createEmptyStore();
  const identity = new IdentityService(store);
  const orgs = new OrganizationService(store);
  const sessions = new SessionService(store);
  const invitations = new InvitationService(store);
  const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice', password: 'correct horse battery' });
  const bob = identity.createUser({ email: 'bob@example.com', displayName: 'Bob', password: 'another correct horse' });
  const acme = orgs.createOrganization({ name: 'Acme Retail', slug: 'acme-retail', actorUserId: alice.id }).organization;
  const beta = orgs.createOrganization({ name: 'Beta Services', slug: 'beta-services', actorUserId: bob.id }).organization;
  return { store, identity, orgs, sessions, invitations, alice, bob, acme, beta };
}

test('sign-in issues a secure session and validates CSRF for unsafe requests', () => {
  const { sessions, alice } = fixture();
  const issued = sessions.signIn({ email: 'alice@example.com', password: 'correct horse battery' });

  assert.equal(issued.session.userId, alice.id);
  assert.match(issued.cookie, /HttpOnly/);
  assert.match(issued.cookie, /SameSite=Lax/);
  assert.throws(() => sessions.authenticate({ token: issued.token, csrfToken: 'wrong', requireCsrf: true }), /Invalid CSRF/);
  assert.equal(sessions.authenticate({ token: issued.token, csrfToken: issued.csrfToken, requireCsrf: true }).user.id, alice.id);
});

test('capability checks deny cross-organization access to prevent IDOR and BOLA', () => {
  const { store, alice, beta } = fixture();
  const authz = new AuthorizationService(store);

  assert.throws(() => authz.requireCapability({
    userId: alice.id,
    organizationId: beta.id,
    capability: CAPABILITIES.READ_BUSINESS_DATA
  }), /Active organization membership/);

  const response = requireBusinessRead({
    user: alice,
    organizationId: beta.id,
    store,
    handler: () => ({ state: 'ready', secret: 'beta data' })
  });
  assert.equal(response.status, 404);
  assert.equal(response.message, 'Not available.');
});

test('disabled organization membership revokes active sessions for that organization', () => {
  const { orgs, sessions, alice, acme } = fixture();
  const issued = sessions.signIn({ email: 'alice@example.com', password: 'correct horse battery' });
  orgs.switchOrganization({ sessionId: issued.session.id, organizationId: acme.id, actorUserId: alice.id });

  orgs.disableMembership({ organizationId: acme.id, userId: alice.id, actorUserId: alice.id });

  assert.throws(() => sessions.authenticate({ token: issued.token }), /Session is not active|Membership is disabled/);
});

test('invitation lifecycle is single-use, email-bound, audited, and grants role capabilities', () => {
  const { store, invitations, alice, bob, acme } = fixture();
  const { token } = invitations.createInvitation({
    organizationId: acme.id,
    email: bob.email,
    role: 'viewer',
    actorUserId: alice.id
  });

  const membership = invitations.acceptInvitation({ token, acceptingUserId: bob.id });

  assert.equal(membership.organizationId, acme.id);
  assert.equal(membership.role, 'viewer');
  assert.throws(() => invitations.acceptInvitation({ token, acceptingUserId: bob.id }), /Invitation is not valid/);
  assert.doesNotThrow(() => new AuthorizationService(store).requireCapability({
    userId: bob.id,
    organizationId: acme.id,
    capability: CAPABILITIES.READ_BUSINESS_DATA
  }));
  assert.throws(() => new AuthorizationService(store).requireCapability({
    userId: bob.id,
    organizationId: acme.id,
    capability: CAPABILITIES.MANAGE_MEMBERS
  }), /Capability required/);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'invitation.accepted'));
});

test('member and invitation mutations require capabilities at the service boundary', () => {
  const { store, invitations, alice, bob, acme } = fixture();
  const { token } = invitations.createInvitation({
    organizationId: acme.id,
    email: bob.email,
    role: 'viewer',
    actorUserId: alice.id
  });
  invitations.acceptInvitation({ token, acceptingUserId: bob.id });

  assert.throws(() => invitations.createInvitation({
    organizationId: acme.id,
    email: 'new@example.com',
    role: 'viewer',
    actorUserId: bob.id
  }), /Capability required/);

  assert.throws(() => new OrganizationService(store).disableMembership({
    organizationId: acme.id,
    userId: alice.id,
    actorUserId: bob.id
  }), /Capability required/);
});

test('invitation acceptance rejects mismatched signed-in users', () => {
  const { identity, invitations, alice, acme } = fixture();
  const charlie = identity.createUser({ email: 'charlie@example.com', displayName: 'Charlie', password: 'charlie password ok' });
  const { token } = invitations.createInvitation({
    organizationId: acme.id,
    email: 'not-charlie@example.com',
    role: 'viewer',
    actorUserId: alice.id
  });

  assert.throws(() => invitations.acceptInvitation({ token, acceptingUserId: charlie.id }), /does not match/);
});

test('app shell exposes loading, empty, ready, and disabled states', () => {
  const { store, identity, sessions, alice } = fixture();
  const issued = sessions.signIn({ email: 'alice@example.com', password: 'correct horse battery' });
  assert.equal(appShellState({ user: null, session: null, store }).state, 'loading');
  assert.equal(appShellState({ user: alice, session: issued.session, store }).state, 'ready');

  const solo = identity.createUser({ email: 'solo@example.com', displayName: 'Solo', password: 'solo password ok' });
  assert.equal(appShellState({ user: solo, session: { activeOrganizationId: null }, store }).state, 'empty');
  identity.disableUser(solo.id, alice.id);
  assert.equal(appShellState({ user: solo, session: { activeOrganizationId: null }, store }).state, 'disabled');
});

test('organization-aware transaction sets RLS context and rolls back on failure', async () => {
  const calls = [];
  const db = { query: async (sql, params = []) => calls.push({ sql, params }) };

  await assert.rejects(
    () => withOrganizationTransaction(db, { organizationId: 'org-1', actorUserId: 'user-1' }, async () => {
      throw new Error('boom');
    }),
    /boom/
  );

  assert.deepEqual(calls.map((call) => call.sql), [
    'begin',
    "select set_config('app.current_organization_id', $1, true)",
    "select set_config('app.current_user_id', $1, true)",
    'rollback'
  ]);
});
