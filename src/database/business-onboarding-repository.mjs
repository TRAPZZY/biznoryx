import { randomUUID } from "node:crypto";

import {
  AuthError,
  CAPABILITIES,
  ROLE_CAPABILITIES,
} from "../auth/core.mjs";

import {
  withTenantTransaction,
} from "./postgres.mjs";

const REQUIRED_PROFILE_FIELDS = [
  "legalName",
  "industry",
  "businessModel",
  "primaryCurrency",
  "fiscalYearStartMonth",
  "timezone",
];

const PROFILE_COLUMNS = `
  id,
  organization_id,
  legal_name,
  trading_name,
  industry,
  business_model,
  primary_currency,
  fiscal_year_start_month,
  timezone,
  status,
  version,
  completed_at,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
`;

export class PostgresBusinessOnboardingRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async upsertProfile({
    organizationId,
    actorUserId,
    profile,
  }) {
    validateProfile(profile);

    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireWriteAccess({
          client,
          organizationId,
          actorUserId,
        });

        const existing =
          await client.query(
            `select
               ${PROFILE_COLUMNS}
             from business_profiles
             where organization_id = $1
             limit 1`,
            [organizationId],
          );

        const now = new Date();

        if (existing.rows[0]) {
          const current =
            existing.rows[0];

          const updated =
            await client.query(
              `update business_profiles
               set legal_name = $2,
                   trading_name = $3,
                   industry = $4,
                   business_model = $5,
                   primary_currency = $6,
                   fiscal_year_start_month = $7,
                   timezone = $8,
                   version = version + 1,
                   updated_by_user_id = $9,
                   updated_at = $10
               where id = $1
               returning
                 ${PROFILE_COLUMNS}`,
              [
                current.id,
                clean(profile.legalName),
                optionalClean(
                  profile.tradingName,
                ),
                clean(profile.industry),
                clean(
                  profile.businessModel,
                ),
                clean(
                  profile.primaryCurrency,
                ).toUpperCase(),
                profile.fiscalYearStartMonth,
                clean(profile.timezone),
                actorUserId,
                now,
              ],
            );

          await writeAudit({
            client,
            organizationId,
            actorUserId,
            eventType:
              "business_profile.updated",
            targetType:
              "business_profile",
            targetId:
              current.id,
          });

          return mapProfile(
            updated.rows[0],
          );
        }

        const id = randomUUID();

        const created =
          await client.query(
            `insert into business_profiles (
               id,
               organization_id,
               legal_name,
               trading_name,
               industry,
               business_model,
               primary_currency,
               fiscal_year_start_month,
               timezone,
               status,
               version,
               completed_at,
               created_by_user_id,
               updated_by_user_id,
               created_at,
               updated_at
             )
             values (
               $1,
               $2,
               $3,
               $4,
               $5,
               $6,
               $7,
               $8,
               $9,
               'draft',
               1,
               null,
               $10,
               $10,
               $11,
               $11
             )
             returning
               ${PROFILE_COLUMNS}`,
            [
              id,
              organizationId,
              clean(profile.legalName),
              optionalClean(
                profile.tradingName,
              ),
              clean(profile.industry),
              clean(
                profile.businessModel,
              ),
              clean(
                profile.primaryCurrency,
              ).toUpperCase(),
              profile.fiscalYearStartMonth,
              clean(profile.timezone),
              actorUserId,
              now,
            ],
          );

        await writeAudit({
          client,
          organizationId,
          actorUserId,
          eventType:
            "business_profile.created",
          targetType:
            "business_profile",
          targetId: id,
        });

        return mapProfile(
          created.rows[0],
        );
      },
    );
  }

  async getProfile({
    organizationId,
    actorUserId,
  }) {
    return withTenantTransaction(
      this.pool,
      {
        organizationId,
        actorUserId,
      },
      async (client) => {
        await requireReadAccess({
          client,
          organizationId,
          actorUserId,
        });

        const result =
          await client.query(
            `select
               ${PROFILE_COLUMNS}
             from business_profiles
             where organization_id = $1
             limit 1`,
            [organizationId],
          );

        return result.rows[0]
          ? mapProfile(
              result.rows[0],
            )
          : null;
      },
    );
  }
}

async function requireWriteAccess({
  client,
  organizationId,
  actorUserId,
}) {
  const role =
    await membershipRole({
      client,
      organizationId,
      actorUserId,
    });

  const capabilities =
    ROLE_CAPABILITIES[role] ?? [];

  if (
    !capabilities.includes(
      CAPABILITIES.WRITE_BUSINESS_DATA,
    )
  ) {
    throw new AuthError(
      "Capability required: business.write",
      "CAPABILITY_DENIED",
    );
  }
}

async function requireReadAccess({
  client,
  organizationId,
  actorUserId,
}) {
  const role =
    await membershipRole({
      client,
      organizationId,
      actorUserId,
    });

  const capabilities =
    ROLE_CAPABILITIES[role] ?? [];

  if (
    !capabilities.includes(
      CAPABILITIES.READ_BUSINESS_DATA,
    )
  ) {
    throw new AuthError(
      "Capability required: business.read",
      "CAPABILITY_DENIED",
    );
  }
}

async function membershipRole({
  client,
  organizationId,
  actorUserId,
}) {
  const result =
    await client.query(
      `select
         role
       from organization_memberships
       where organization_id = $1
         and user_id = $2
         and status = 'active'
       limit 1`,
      [
        organizationId,
        actorUserId,
      ],
    );

  const membership =
    result.rows[0];

  if (!membership) {
    throw new AuthError(
      "Active organization membership required.",
      "ORG_ACCESS_DENIED",
    );
  }

  return membership.role;
}

async function writeAudit({
  client,
  organizationId,
  actorUserId,
  eventType,
  targetType,
  targetId,
}) {
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
       $3,
       $4,
       $5
     )`,
    [
      organizationId,
      actorUserId,
      eventType,
      targetType,
      targetId,
    ],
  );
}

function validateProfile(profile) {
  if (
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    throw new AuthError(
      "Business profile is required.",
      "VALIDATION_FAILED",
    );
  }

  for (
    const field of
    REQUIRED_PROFILE_FIELDS
  ) {
    if (
      profile[field] === undefined ||
      profile[field] === null ||
      clean(profile[field]) === ""
    ) {
      throw new AuthError(
        `Business profile ${field} is required.`,
        "VALIDATION_FAILED",
      );
    }
  }

  if (
    !/^[A-Z]{3}$/i.test(
      clean(
        profile.primaryCurrency,
      ),
    )
  ) {
    throw new AuthError(
      "Primary currency must be a three-letter ISO code.",
      "VALIDATION_FAILED",
    );
  }

  if (
    !Number.isInteger(
      profile.fiscalYearStartMonth,
    ) ||
    profile.fiscalYearStartMonth < 1 ||
    profile.fiscalYearStartMonth > 12
  ) {
    throw new AuthError(
      "Fiscal year start month must be 1 through 12.",
      "VALIDATION_FAILED",
    );
  }

  if (
    clean(profile.legalName).length >
      160 ||
    clean(profile.industry).length >
      160 ||
    clean(
      profile.businessModel,
    ).length > 500 ||
    clean(profile.timezone).length >
      120
  ) {
    throw new AuthError(
      "Business profile contains a value that is too long.",
      "VALIDATION_FAILED",
    );
  }

  const tradingName =
    optionalClean(
      profile.tradingName,
    );

  if (
    tradingName &&
    tradingName.length > 160
  ) {
    throw new AuthError(
      "Trading name is too long.",
      "VALIDATION_FAILED",
    );
  }
}

function mapProfile(row) {
  return {
    id: row.id,

    organizationId:
      row.organization_id,

    legalName:
      row.legal_name,

    tradingName:
      row.trading_name,

    industry:
      row.industry,

    businessModel:
      row.business_model,

    primaryCurrency:
      row.primary_currency,

    fiscalYearStartMonth:
      row.fiscal_year_start_month,

    timezone:
      row.timezone,

    status:
      row.status,

    version:
      row.version,

    completedAt:
      row.completed_at,

    createdByUserId:
      row.created_by_user_id,

    updatedByUserId:
      row.updated_by_user_id,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
  };
}

function clean(value) {
  return String(
    value ?? "",
  ).trim();
}

function optionalClean(value) {
  const result =
    clean(value);

  return result || null;
}