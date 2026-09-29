import { createHash, pbkdf2Sync, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const CAPABILITIES = Object.freeze({
  MANAGE_ORGANIZATION: 'organization.manage',
  MANAGE_MEMBERS: 'members.manage',
  INVITE_MEMBERS: 'members.invite',
  READ_BUSINESS_DATA: 'business.read',
  WRITE_BUSINESS_DATA: 'business.write',
  READ_AUDIT_LOG: 'audit.read'
});

export const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.values(CAPABILITIES),
  admin: [
    CAPABILITIES.MANAGE_MEMBERS,
    CAPABILITIES.INVITE_MEMBERS,
    CAPABILITIES.READ_BUSINESS_DATA,
    CAPABILITIES.WRITE_BUSINESS_DATA,
    CAPABILITIES.READ_AUDIT_LOG
  ],
  analyst: [
    CAPABILITIES.READ_BUSINESS_DATA,
    CAPABILITIES.WRITE_BUSINESS_DATA
  ],
  viewer: [
    CAPABILITIES.READ_BUSINESS_DATA
  ]
});

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 10;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;

export class AuthError extends Error {
  constructor(message, code = 'AUTHORIZATION_FAILED') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new AuthError('Password must be at least 12 characters.', 'WEAK_PASSWORD');
  }
  const digest = pbkdf2Sync(password, salt, 210000, 64, 'sha512').toString('hex');
  return `pbkdf2_sha512$210000$${salt}$${digest}`;
}

export function verifyPassword(password, encoded) {
  const [algorithm, iterations, salt, expected] = encoded.split('$');
  if (algorithm !== 'pbkdf2_sha512') return false;
  const actual = pbkdf2Sync(password, salt, Number(iterations), 64, 'sha512');
  return timingSafeEqual(Buffer.from(expected, 'hex'), actual);
}

export function secureSessionCookie(token, isProduction = true) {
  return [
    `bnx_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
    isProduction ? 'Secure' : null
  ].filter(Boolean).join('; ');
}

export function createEmptyStore() {
  return {
    users: new Map(),
    organizations: new Map(),
    memberships: new Map(),
    invitations: new Map(),
    emailVerifications: new Map(),
    outboundEmails: [],
    sessions: new Map(),
    auditEvents: []
  };
}

export class AuditLog {
  constructor(store) {
    this.store = store;
  }

  record(event) {
    const auditEvent = {
      id: randomUUID(),
      organizationId: event.organizationId ?? null,
      actorUserId: event.actorUserId ?? null,
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? {},
      createdAt: new Date()
    };
    this.store.auditEvents.push(auditEvent);
    return auditEvent;
  }
}

export class IdentityService {
  constructor(store, auditLog = new AuditLog(store)) {
    this.store = store;
    this.auditLog = auditLog;
  }

  createUser({ email, displayName, password, emailVerifiedAt = null }) {
    const normalizedEmail = normalizeEmail(email);
    if ([...this.store.users.values()].some((user) => user.email === normalizedEmail)) {
      throw new AuthError('Email is already registered.', 'EMAIL_EXISTS');
    }
    const user = {
      id: randomUUID(),
      email: normalizedEmail,
      displayName,
      passwordHash: hashPassword(password),
      emailVerifiedAt,
      disabledAt: null,
      createdAt: new Date()
    };
    this.store.users.set(user.id, user);
    this.auditLog.record({
      actorUserId: user.id,
      eventType: 'identity.user_created',
      targetType: 'app_user',
      targetId: user.id
    });
    return user;
  }

  disableUser(userId, actorUserId) {
    const user = mustGet(this.store.users, userId, 'User not found.');
    user.disabledAt = new Date();
    for (const session of this.store.sessions.values()) {
      if (session.userId === userId) session.revokedAt = new Date();
    }
    this.auditLog.record({
      actorUserId,
      eventType: 'identity.user_disabled',
      targetType: 'app_user',
      targetId: userId
    });
  }
}

export class SessionService {
  constructor(store, auditLog = new AuditLog(store), now = () => new Date()) {
    this.store = store;
    this.auditLog = auditLog;
    this.now = now;
  }

  signIn({ email, password, requireVerifiedEmail = false }) {
    const user = [...this.store.users.values()].find((item) => item.email === normalizeEmail(email));
    if (!user || user.disabledAt || !verifyPassword(password, user.passwordHash)) {
      throw new AuthError('Invalid credentials.', 'INVALID_CREDENTIALS');
    }
    if (requireVerifiedEmail && !user.emailVerifiedAt) {
      throw new AuthError('Enter the verification code sent to your work email.', 'EMAIL_VERIFICATION_REQUIRED');
    }
    return this.createSessionForUser(user);
  }

  createSessionForUser(user) {
    if (!user || user.disabledAt) {
      throw new AuthError('Invalid credentials.', 'INVALID_CREDENTIALS');
    }
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const memberships = activeMembershipsForUser(this.store, user.id);
    const session = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashSecret(token),
      csrfTokenHash: hashSecret(csrfToken),
      activeOrganizationId: memberships[0]?.organizationId ?? null,
      revokedAt: null,
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      csrfTokenForResponse: csrfToken
    };
    this.store.sessions.set(session.id, session);
    this.auditLog.record({
      organizationId: session.activeOrganizationId,
      actorUserId: user.id,
      eventType: 'identity.session_created',
      targetType: 'user_session',
      targetId: session.id
    });
    return { session, token, csrfToken, cookie: secureSessionCookie(token, process.env.NODE_ENV === 'production') };
  }

  authenticate({ token, csrfToken, requireCsrf = false }) {
    const tokenHash = hashSecret(token ?? '');
    const session = [...this.store.sessions.values()].find((item) => item.tokenHash === tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= this.now()) {
      throw new AuthError('Session is not active.', 'SESSION_INVALID');
    }
    const user = mustGet(this.store.users, session.userId, 'User not found.');
    if (user.disabledAt) throw new AuthError('User is disabled.', 'USER_DISABLED');
    if (requireCsrf && hashSecret(csrfToken ?? '') !== session.csrfTokenHash) {
      throw new AuthError('Invalid CSRF token.', 'CSRF_INVALID');
    }
    if (session.activeOrganizationId) {
      const membership = findMembership(this.store, session.activeOrganizationId, user.id);
      if (!membership || membership.status !== 'active') {
        session.revokedAt = this.now();
        throw new AuthError('Membership is disabled.', 'MEMBERSHIP_DISABLED');
      }
    }
    session.lastSeenAt = this.now();
    return { session, user };
  }

  signOut(sessionId, actorUserId) {
    const session = mustGet(this.store.sessions, sessionId, 'Session not found.');
    session.revokedAt = this.now();
    this.auditLog.record({
      organizationId: session.activeOrganizationId,
      actorUserId,
      eventType: 'identity.session_revoked',
      targetType: 'user_session',
      targetId: sessionId
    });
  }
}

export class EmailVerificationService {
  constructor(store, auditLog = new AuditLog(store), now = () => new Date()) {
    this.store = store;
    this.auditLog = auditLog;
    this.now = now;
  }

  issue({ email, purpose = 'email_verification', actorUserId = null }) {
    const normalizedEmail = normalizeEmail(email);
    const user = [...this.store.users.values()].find((item) => item.email === normalizedEmail);
    const issuedAt = this.now();
    if (!user) {
      return { sent: true, email: normalizedEmail, expiresAt: null };
    }

    for (const challenge of this.store.emailVerifications.values()) {
      if (challenge.userId === user.id && challenge.purpose === purpose && !challenge.consumedAt) {
        challenge.consumedAt = issuedAt;
        challenge.supersededAt = issuedAt;
      }
    }

    const code = generateNumericCode(8);
    const challenge = {
      id: randomUUID(),
      userId: user.id,
      email: normalizedEmail,
      purpose,
      codeHash: hashSecret(code),
      attempts: 0,
      maxAttempts: EMAIL_VERIFICATION_MAX_ATTEMPTS,
      expiresAt: new Date(issuedAt.getTime() + EMAIL_VERIFICATION_TTL_MS),
      consumedAt: null,
      supersededAt: null,
      createdAt: issuedAt
    };
    this.store.emailVerifications.set(challenge.id, challenge);
    const outbound = {
      id: randomUUID(),
      to: normalizedEmail,
      purpose,
      subject: 'Your BIZNORYX verification code',
      body: `Your BIZNORYX verification code is ${code}. It expires in 10 minutes.`,
      code: process.env.NODE_ENV === 'production' ? undefined : code,
      createdAt: issuedAt,
      expiresAt: challenge.expiresAt
    };
    this.store.outboundEmails.push(outbound);
    this.auditLog.record({
      actorUserId: actorUserId ?? user.id,
      eventType: 'identity.email_verification_issued',
      targetType: 'app_user',
      targetId: user.id,
      metadata: { purpose }
    });
    return {
      sent: true,
      email: normalizedEmail,
      expiresAt: challenge.expiresAt,
      challengeId: challenge.id,
      reviewCode: process.env.NODE_ENV === 'production' ? undefined : code
    };
  }

  verify({ email, code, purpose = 'email_verification' }) {
    const normalizedEmail = normalizeEmail(email);
    const now = this.now();
    const challenge = [...this.store.emailVerifications.values()]
      .filter((item) => item.email === normalizedEmail && item.purpose === purpose && !item.consumedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!challenge || challenge.expiresAt <= now || challenge.attempts >= challenge.maxAttempts) {
      throw new AuthError('Verification code is invalid or expired.', 'EMAIL_CODE_INVALID');
    }
    challenge.attempts += 1;
    if (hashSecret(String(code ?? '').trim()) !== challenge.codeHash) {
      throw new AuthError('Verification code is invalid or expired.', 'EMAIL_CODE_INVALID');
    }
    challenge.consumedAt = now;
    const user = mustGet(this.store.users, challenge.userId, 'User not found.');
    user.emailVerifiedAt = now;
    this.auditLog.record({
      actorUserId: user.id,
      eventType: 'identity.email_verified',
      targetType: 'app_user',
      targetId: user.id
    });
    return user;
  }
}

export class OrganizationService {
  constructor(store, auditLog = new AuditLog(store)) {
    this.store = store;
    this.auditLog = auditLog;
  }

  createOrganization({ name, slug, actorUserId }) {
    const organization = {
      id: randomUUID(),
      name,
      slug,
      createdByUserId: actorUserId,
      disabledAt: null,
      createdAt: new Date()
    };
    this.store.organizations.set(organization.id, organization);
    const membership = this.addMembership({
      organizationId: organization.id,
      userId: actorUserId,
      role: 'owner',
      actorUserId
    });
    this.auditLog.record({
      organizationId: organization.id,
      actorUserId,
      eventType: 'organization.created',
      targetType: 'organization',
      targetId: organization.id
    });
    return { organization, membership };
  }

  addMembership({ organizationId, userId, role, actorUserId }) {
    mustGet(this.store.organizations, organizationId, 'Organization not found.');
    mustGet(this.store.users, userId, 'User not found.');
    if (actorUserId !== userId) {
      new AuthorizationService(this.store).requireCapability({
        userId: actorUserId,
        organizationId,
        capability: CAPABILITIES.MANAGE_MEMBERS
      });
    }
    const existing = findMembership(this.store, organizationId, userId);
    if (existing) throw new AuthError('Membership already exists.', 'MEMBERSHIP_EXISTS');
    const membership = {
      id: randomUUID(),
      organizationId,
      userId,
      role,
      status: 'active',
      disabledAt: null,
      createdAt: new Date()
    };
    this.store.memberships.set(membership.id, membership);
    this.auditLog.record({
      organizationId,
      actorUserId,
      eventType: 'membership.created',
      targetType: 'organization_membership',
      targetId: membership.id,
      metadata: { role }
    });
    return membership;
  }

  addMembershipFromAcceptedInvitation({ organizationId, userId, role, invitedByUserId }) {
    mustGet(this.store.organizations, organizationId, 'Organization not found.');
    mustGet(this.store.users, userId, 'User not found.');
    const invitation = [...this.store.invitations.values()].find((item) =>
      item.organizationId === organizationId
      && item.email === mustGet(this.store.users, userId, 'User not found.').email
      && item.invitedByUserId === invitedByUserId
      && item.status === 'pending'
    );
    if (!invitation) throw new AuthError('Accepted invitation context is required.', 'INVITATION_REQUIRED');
    const existing = findMembership(this.store, organizationId, userId);
    if (existing) throw new AuthError('Membership already exists.', 'MEMBERSHIP_EXISTS');
    const membership = {
      id: randomUUID(),
      organizationId,
      userId,
      role,
      status: 'active',
      disabledAt: null,
      createdAt: new Date()
    };
    this.store.memberships.set(membership.id, membership);
    this.auditLog.record({
      organizationId,
      actorUserId: invitedByUserId,
      eventType: 'membership.created',
      targetType: 'organization_membership',
      targetId: membership.id,
      metadata: { role, source: 'accepted_invitation' }
    });
    return membership;
  }

  disableMembership({ organizationId, userId, actorUserId }) {
    new AuthorizationService(this.store).requireCapability({
      userId: actorUserId,
      organizationId,
      capability: CAPABILITIES.MANAGE_MEMBERS
    });
    const membership = findMembership(this.store, organizationId, userId);
    if (!membership) throw new AuthError('Membership not found.', 'MEMBERSHIP_NOT_FOUND');
    membership.status = 'disabled';
    membership.disabledAt = new Date();
    for (const session of this.store.sessions.values()) {
      if (session.userId === userId && session.activeOrganizationId === organizationId) {
        session.revokedAt = new Date();
      }
    }
    this.auditLog.record({
      organizationId,
      actorUserId,
      eventType: 'membership.disabled',
      targetType: 'organization_membership',
      targetId: membership.id
    });
  }

  switchOrganization({ sessionId, organizationId, actorUserId }) {
    const session = mustGet(this.store.sessions, sessionId, 'Session not found.');
    const membership = findMembership(this.store, organizationId, actorUserId);
    if (!membership || membership.status !== 'active') {
      throw new AuthError('Cannot switch to an organization without active membership.', 'ORG_ACCESS_DENIED');
    }
    session.activeOrganizationId = organizationId;
    this.auditLog.record({
      organizationId,
      actorUserId,
      eventType: 'organization.switched',
      targetType: 'organization',
      targetId: organizationId
    });
    return session;
  }
}

export class InvitationService {
  constructor(store, auditLog = new AuditLog(store), now = () => new Date()) {
    this.store = store;
    this.auditLog = auditLog;
    this.now = now;
  }

  createInvitation({ organizationId, email, role, actorUserId }) {
    new AuthorizationService(this.store).requireCapability({
      userId: actorUserId,
      organizationId,
      capability: CAPABILITIES.INVITE_MEMBERS
    });
    const token = randomBytes(32).toString('base64url');
    const invitation = {
      id: randomUUID(),
      organizationId,
      email: normalizeEmail(email),
      role,
      tokenHash: hashSecret(token),
      status: 'pending',
      invitedByUserId: actorUserId,
      acceptedByUserId: null,
      expiresAt: new Date(this.now().getTime() + INVITATION_TTL_MS),
      acceptedAt: null,
      revokedAt: null,
      createdAt: this.now()
    };
    this.store.invitations.set(invitation.id, invitation);
    this.auditLog.record({
      organizationId,
      actorUserId,
      eventType: 'invitation.created',
      targetType: 'organization_invitation',
      targetId: invitation.id,
      metadata: { role, email: invitation.email }
    });
    return { invitation, token };
  }

  acceptInvitation({ token, acceptingUserId }) {
    const invitation = [...this.store.invitations.values()].find((item) => item.tokenHash === hashSecret(token ?? ''));
    if (!invitation || invitation.status !== 'pending') {
      throw new AuthError('Invitation is not valid.', 'INVITATION_INVALID');
    }
    if (invitation.expiresAt <= this.now()) {
      invitation.status = 'expired';
      throw new AuthError('Invitation has expired.', 'INVITATION_EXPIRED');
    }
    const user = mustGet(this.store.users, acceptingUserId, 'User not found.');
    if (user.email !== invitation.email) {
      throw new AuthError('Invitation email does not match the signed-in user.', 'INVITATION_EMAIL_MISMATCH');
    }
    const orgService = new OrganizationService(this.store, this.auditLog);
    const membership = orgService.addMembershipFromAcceptedInvitation({
      organizationId: invitation.organizationId,
      userId: acceptingUserId,
      role: invitation.role,
      invitedByUserId: invitation.invitedByUserId
    });
    invitation.status = 'accepted';
    invitation.acceptedByUserId = acceptingUserId;
    invitation.acceptedAt = this.now();
    this.auditLog.record({
      organizationId: invitation.organizationId,
      actorUserId: acceptingUserId,
      eventType: 'invitation.accepted',
      targetType: 'organization_invitation',
      targetId: invitation.id
    });
    return membership;
  }
}

export class AuthorizationService {
  constructor(store) {
    this.store = store;
  }

  requireCapability({ userId, organizationId, capability }) {
    const membership = findMembership(this.store, organizationId, userId);
    if (!membership || membership.status !== 'active') {
      throw new AuthError('Active organization membership is required.', 'ORG_ACCESS_DENIED');
    }
    const capabilities = ROLE_CAPABILITIES[membership.role] ?? [];
    if (!capabilities.includes(capability)) {
      throw new AuthError(`Capability required: ${capability}`, 'CAPABILITY_DENIED');
    }
    return { membership, capabilities };
  }
}

export async function withOrganizationTransaction(db, { organizationId, actorUserId }, work) {
  if (!organizationId || !actorUserId) {
    throw new AuthError('Organization and actor are required for tenant transactions.', 'TENANT_CONTEXT_REQUIRED');
  }
  await db.query('begin');
  try {
    await db.query("select set_config('app.current_organization_id', $1, true)", [organizationId]);
    await db.query("select set_config('app.current_user_id', $1, true)", [actorUserId]);
    const result = await work(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function mustGet(map, id, message) {
  const item = map.get(id);
  if (!item) throw new AuthError(message, 'NOT_FOUND');
  return item;
}

function activeMembershipsForUser(store, userId) {
  return [...store.memberships.values()].filter((membership) => membership.userId === userId && membership.status === 'active');
}

function findMembership(store, organizationId, userId) {
  return [...store.memberships.values()].find((membership) => membership.organizationId === organizationId && membership.userId === userId);
}

function generateNumericCode(length) {
  return Array.from({ length }, () => String(randomInt(0, 10))).join('');
}
