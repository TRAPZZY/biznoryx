import { randomBytes, randomUUID } from "node:crypto";

import {
  AuthError,
  hashPassword,
  hashSecret,
  normalizeEmail,
  secureSessionCookie,
  verifyPassword,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
  withTransaction,
} from "./postgres.mjs";

import {
  acknowledgementsComplete,
  createCurrentPolicyAcceptance,
  policyStatus as buildPolicyStatus,
} from "../compliance/user-policy.mjs";

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export class PostgresIdentityRepository {
  constructor(
    pool,
    {
      now = () => new Date(),
      production = false,
    } = {},
  ) {
    this.pool = pool;
    this.now = now;
    this.production = production;
  }

  async createUser({
    email,
    displayName,
    password,
  }) {
    const normalizedEmail =
      normalizeEmail(email);

    const userId = randomUUID();

    try {
      await withTransaction(
        this.pool,
        async (client) => {
          await client.query(
            `insert into app_users (
               id,
               email,
               display_name,
               password_hash
             )
             values ($1, $2, $3, $4)`,
            [
              userId,
              normalizedEmail,
              displayName,
              hashPassword(password),
            ],
          );

          await client.query(
            "select set_config('app.current_user_id', $1, true)",
            [userId],
          );

          await client.query(
            `insert into audit_events (
               actor_user_id,
               event_type,
               target_type,
               target_id
             )
             values (
               $1,
               'identity.user_created',
               'app_user',
               $1
             )`,
            [userId],
          );
        },
      );
    } catch (error) {
      if (error.code === "23505") {
        throw new AuthError(
          "Email is already registered.",
          "EMAIL_EXISTS",
        );
      }

      throw error;
    }

    return {
      id: userId,
      email: normalizedEmail,
      displayName,
      emailVerifiedAt: null,
      disabledAt: null,
    };
  }

  async register({
    email,
    displayName,
    password,
  }) {
    const user = await this.createUser({
      email,
      displayName,
      password,
    });

    return this.signIn({
      email: user.email,
      password,
      requireVerifiedEmail: false,
    });
  }

  async signIn({
    email,
    password,
    requireVerifiedEmail = true,
  }) {
    const result = await this.pool.query(
      `select
         id,
         email,
         display_name,
         password_hash,
         email_verified_at,
         disabled_at
       from app_users
       where email = $1`,
      [normalizeEmail(email)],
    );

    const user = result.rows[0];

    if (
      !user ||
      user.disabled_at ||
      !verifyPassword(
        password,
        user.password_hash,
      )
    ) {
      throw new AuthError(
        "Invalid credentials.",
        "INVALID_CREDENTIALS",
      );
    }

    if (
      requireVerifiedEmail &&
      !user.email_verified_at
    ) {
      throw new AuthError(
        "Enter the verification code sent to your work email.",
        "EMAIL_VERIFICATION_REQUIRED",
      );
    }

    return this.createSessionForUser(
      mapUser(user),
    );
  }

  async createSessionForUser(user) {
    if (!user || user.disabledAt) {
      throw new AuthError(
        "Invalid credentials.",
        "INVALID_CREDENTIALS",
      );
    }

    const memberships =
      await this.activeMemberships(user.id);

    const token = randomBytes(32).toString(
      "base64url",
    );

    const csrfToken =
      randomBytes(32).toString("base64url");

    const sessionId = randomUUID();

    const expiresAt = new Date(
      this.now().getTime() +
        SESSION_TTL_MS,
    );

    const activeOrganizationId =
      memberships[0]?.organizationId ??
      null;

    const createSession = async (
      client,
    ) => {
      await client.query(
        `insert into user_sessions (
           id,
           user_id,
           session_token_hash,
           csrf_token_hash,
           active_organization_id,
           expires_at
         )
         values ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          user.id,
          hashSecret(token),
          hashSecret(csrfToken),
          activeOrganizationId,
          expiresAt,
        ],
      );

      await client.query(
        `insert into audit_events (
           organization_id,
           actor_user_id,
           event_type,
           target_type,
           target_id
         )
         values (
           $1,
           $2,
           'identity.session_created',
           'user_session',
           $3
         )`,
        [
          activeOrganizationId,
          user.id,
          sessionId,
        ],
      );
    };

    if (activeOrganizationId) {
      await withTenantTransaction(
        this.pool,
        {
          organizationId:
            activeOrganizationId,
          actorUserId: user.id,
        },
        createSession,
      );
    } else {
      await withTransaction(
        this.pool,
        async (client) => {
          await client.query(
            "select set_config('app.current_user_id', $1, true)",
            [user.id],
          );

          await createSession(client);
        },
      );
    }

    return {
      user,

      session: {
        id: sessionId,
        userId: user.id,
        activeOrganizationId,
        expiresAt,
      },

      memberships,

      token,

      csrfToken,

      cookie: secureSessionCookie(
        token,
        this.production,
      ),
    };
  }

  async authenticate({
    token,
    csrfToken,
    requireCsrf = false,
  }) {
    const result = await this.pool.query(
      `select
         session_id,
         user_id,
         email,
         display_name,
         user_disabled_at,
         csrf_token_hash,
         active_organization_id,
         membership_role,
         membership_status,
         session_revoked_at,
         session_expires_at
       from runtime_session_context($1)`,
      [hashSecret(token ?? "")],
    );

    const context = result.rows[0];
    const now = this.now();

    if (
      !context ||
      context.session_revoked_at ||
      new Date(
        context.session_expires_at,
      ) <= now
    ) {
      throw new AuthError(
        "Session is not active.",
        "SESSION_INVALID",
      );
    }

    if (context.user_disabled_at) {
      throw new AuthError(
        "User is disabled.",
        "USER_DISABLED",
      );
    }

    if (
      requireCsrf &&
      hashSecret(csrfToken ?? "") !==
        context.csrf_token_hash
    ) {
      throw new AuthError(
        "Invalid CSRF token.",
        "CSRF_INVALID",
      );
    }

    if (
      context.active_organization_id &&
      context.membership_status !==
        "active"
    ) {
      await this.revokeSession(
        context.session_id,
        context.user_id,
      );

      throw new AuthError(
        "Membership is disabled.",
        "MEMBERSHIP_DISABLED",
      );
    }

    await withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [context.user_id],
        );

        await client.query(
          `update user_sessions
           set last_seen_at = $2
           where id = $1`,
          [
            context.session_id,
            now,
          ],
        );
      },
    );

    return mapContext(context);
  }

  async activeMemberships(userId) {
    const result =
      await withTransaction(
        this.pool,
        async (client) => {
          await client.query(
            "select set_config('app.current_user_id', $1, true)",
            [userId],
          );

          return client.query(
            `select
               membership_id,
               organization_id,
               organization_name,
               organization_slug,
               membership_role
             from runtime_active_memberships($1)`,
            [userId],
          );
        },
      );

    return result.rows.map(
      (row) => ({
        id: row.membership_id,

        organizationId:
          row.organization_id,

        organizationName:
          row.organization_name,

        organizationSlug:
          row.organization_slug,

        role: row.membership_role,
      }),
    );
  }

  async createOrganization({
    actorUserId,
    name,
    slug,
  }) {
    const organizationId =
      randomUUID();

    const membershipId = randomUUID();

    await withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await client.query(
          `insert into organizations (
             id,
             name,
             slug,
             created_by_user_id
           )
           values ($1, $2, $3, $4)`,
          [
            organizationId,
            name,
            slug,
            actorUserId,
          ],
        );

        await client.query(
          `insert into organization_memberships (
             id,
             organization_id,
             user_id,
             role
           )
           values ($1, $2, $3, 'owner')`,
          [
            membershipId,
            organizationId,
            actorUserId,
          ],
        );

        await client.query(
          `insert into audit_events (
             organization_id,
             actor_user_id,
             event_type,
             target_type,
             target_id
           )
           values (
             $1,
             $2,
             'organization.created',
             'organization',
             $1
           )`,
          [
            organizationId,
            actorUserId,
          ],
        );
      },
    );

    return {
      id: organizationId,
      name,
      slug,
    };
  }

  async switchOrganization({
    sessionId,
    actorUserId,
    organizationId,
  }) {
    const memberships =
      await this.activeMemberships(
        actorUserId,
      );

    if (
      !memberships.some(
        (item) =>
          item.organizationId ===
          organizationId,
      )
    ) {
      throw new AuthError(
        "Cannot switch to an organization without active membership.",
        "ORG_ACCESS_DENIED",
      );
    }

    await withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        const result =
          await client.query(
            `update user_sessions
             set active_organization_id = $3
             where id = $1
               and user_id = $2
               and revoked_at is null`,
            [
              sessionId,
              actorUserId,
              organizationId,
            ],
          );

        if (result.rowCount !== 1) {
          throw new AuthError(
            "Session is not active.",
            "SESSION_INVALID",
          );
        }

        await client.query(
          `insert into audit_events (
             organization_id,
             actor_user_id,
             event_type,
             target_type,
             target_id
           )
           values (
             $1,
             $2,
             'organization.switched',
             'organization',
             $1
           )`,
          [
            organizationId,
            actorUserId,
          ],
        );
      },
    );
  }

  async policyStatus(userId) {
    const result = await withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [userId],
        );

        return client.query(
          `select
             metadata,
             created_at
           from audit_events
           where actor_user_id = $1
             and organization_id is null
             and event_type = 'identity.policy_accepted'
             and target_type = 'app_user'
             and target_id = $1
           order by created_at desc
           limit 1`,
          [userId],
        );
      },
    );

    const row = result.rows[0];

    if (!row) {
      return buildPolicyStatus(null);
    }

    const metadata =
      row.metadata &&
      typeof row.metadata === "object"
        ? row.metadata
        : {};

    return buildPolicyStatus({
      termsVersion: metadata.termsVersion,
      privacyVersion: metadata.privacyVersion,
      dataUseVersion: metadata.dataUseVersion,
      guideVersion: metadata.guideVersion,
      acceptedAt: row.created_at,
    });
  }

  async acceptCurrentPolicy({
    userId,
    acknowledgements,
  }) {
    if (
      !acknowledgementsComplete(
        acknowledgements,
      )
    ) {
      throw new AuthError(
        "Confirm the account, data and recurring-series acknowledgements before continuing.",
        "POLICY_ACCEPTANCE_REQUIRED",
      );
    }

    const acceptance =
      createCurrentPolicyAcceptance(
        this.now(),
      );

    await withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [userId],
        );

        await client.query(
          `insert into audit_events (
             actor_user_id,
             event_type,
             target_type,
             target_id,
             metadata
           )
           values (
             $1,
             'identity.policy_accepted',
             'app_user',
             $1,
             $2::jsonb
           )`,
          [
            userId,
            JSON.stringify({
              termsVersion:
                acceptance.termsVersion,
              privacyVersion:
                acceptance.privacyVersion,
              dataUseVersion:
                acceptance.dataUseVersion,
              guideVersion:
                acceptance.guideVersion,
              source:
                "account_data_onboarding",
            }),
          ],
        );
      },
    );

    return buildPolicyStatus(acceptance);
  }

  async revokeSession(
    sessionId,
    userId,
  ) {
    await withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [userId],
        );

        await client.query(
          `update user_sessions
           set revoked_at = now()
           where id = $1
             and user_id = $2`,
          [
            sessionId,
            userId,
          ],
        );
      },
    );
  }

  async rotateCsrfToken(
    sessionId,
    userId,
  ) {
    const csrfToken =
      randomBytes(32).toString(
        "base64url",
      );

    const updated =
      await withTransaction(
        this.pool,
        async (client) => {
          await client.query(
            "select set_config('app.current_user_id', $1, true)",
            [userId],
          );

          return client.query(
            `update user_sessions
             set csrf_token_hash = $3,
                 last_seen_at = $4
             where id = $1
               and user_id = $2
               and revoked_at is null
               and expires_at > $4`,
            [
              sessionId,
              userId,
              hashSecret(csrfToken),
              this.now(),
            ],
          );
        },
      );

    if (updated.rowCount !== 1) {
      throw new AuthError(
        "Session is not active.",
        "SESSION_INVALID",
      );
    }

    return csrfToken;
  }
}

function mapUser(row) {
  return {
    id: row.id,

    email: row.email,

    displayName: row.display_name,

    emailVerifiedAt:
      row.email_verified_at ?? null,

    disabledAt: row.disabled_at,
  };
}

function mapContext(row) {
  return {
    user: {
      id: row.user_id,

      email: row.email,

      displayName: row.display_name,

      disabledAt:
        row.user_disabled_at,
    },

    session: {
      id: row.session_id,

      userId: row.user_id,

      activeOrganizationId:
        row.active_organization_id,

      expiresAt:
        row.session_expires_at,
    },

    membership:
      row.active_organization_id
        ? {
            organizationId:
              row.active_organization_id,

            role:
              row.membership_role,

            status:
              row.membership_status,
          }
        : null,
  };
}