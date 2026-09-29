import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AuthError } from "../src/auth/core.mjs";
import { PostgresBusinessOnboardingRepository } from "../src/database/business-onboarding-repository.mjs";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";
import {
  createPostgresPool,
} from "../src/database/postgres.mjs";

const databaseUrl =
  process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL business onboarding persists profiles and enforces tenant isolation",
  {
    skip: !databaseUrl,
  },
  async () => {
    const pool =
      createPostgresPool({
        DATABASE_URL:
          databaseUrl,

        NODE_ENV: "test",

        BIZNORYX_DB_POOL_MAX:
          "4",
      });

    const identity =
      new PostgresIdentityRepository(
        pool,
      );

    const onboarding =
      new PostgresBusinessOnboardingRepository(
        pool,
      );

    const suffix =
      randomUUID()
        .replaceAll("-", "")
        .slice(0, 10);

    const password =
      "DurableOnboardingPass2026!";

    try {
      /*
       * First tenant.
       */
      const first =
        await identity.register({
          email:
            `onboarding-owner-${suffix}@example.test`,

          displayName:
            "Onboarding Owner",

          password,
        });

      const firstOrganization =
        await identity.createOrganization(
          {
            actorUserId:
              first.user.id,

            name:
              `Onboarding Company ${suffix}`,

            slug:
              `onboarding-company-${suffix}`,
          },
        );

      await identity.switchOrganization(
        {
          sessionId:
            first.session.id,

          actorUserId:
            first.user.id,

          organizationId:
            firstOrganization.id,
        },
      );

      /*
       * There should be no profile yet.
       */
      const emptyProfile =
        await onboarding.getProfile({
          organizationId:
            firstOrganization.id,

          actorUserId:
            first.user.id,
        });

      assert.equal(
        emptyProfile,
        null,
      );

      /*
       * Create the persistent business profile.
       */
      const created =
        await onboarding.upsertProfile({
          organizationId:
            firstOrganization.id,

          actorUserId:
            first.user.id,

          profile: {
            legalName:
              "Durable Retail Limited",

            tradingName:
              "Durable Retail",

            industry:
              "Retail",

            businessModel:
              "Online and physical retail sales",

            primaryCurrency:
              "USD",

            fiscalYearStartMonth:
              1,

            timezone:
              "UTC",
          },
        });

      assert.equal(
        created.organizationId,
        firstOrganization.id,
      );

      assert.equal(
        created.legalName,
        "Durable Retail Limited",
      );

      assert.equal(
        created.tradingName,
        "Durable Retail",
      );

      assert.equal(
        created.industry,
        "Retail",
      );

      assert.equal(
        created.businessModel,
        "Online and physical retail sales",
      );

      assert.equal(
        created.primaryCurrency,
        "USD",
      );

      assert.equal(
        created.fiscalYearStartMonth,
        1,
      );

      assert.equal(
        created.timezone,
        "UTC",
      );

      assert.equal(
        created.status,
        "draft",
      );

      assert.equal(
        created.version,
        1,
      );

      /*
       * Create a completely new repository
       * instance to simulate an application
       * process restart.
       */
      const restartedOnboarding =
        new PostgresBusinessOnboardingRepository(
          pool,
        );

      const persisted =
        await restartedOnboarding.getProfile(
          {
            organizationId:
              firstOrganization.id,

            actorUserId:
              first.user.id,
          },
        );

      assert.ok(persisted);

      assert.equal(
        persisted.id,
        created.id,
      );

      assert.equal(
        persisted.organizationId,
        firstOrganization.id,
      );

      assert.equal(
        persisted.legalName,
        "Durable Retail Limited",
      );

      assert.equal(
        persisted.tradingName,
        "Durable Retail",
      );

      /*
       * Update the same profile.
       * This must update the existing row,
       * not create a second profile.
       */
      const updated =
        await restartedOnboarding.upsertProfile(
          {
            organizationId:
              firstOrganization.id,

            actorUserId:
              first.user.id,

            profile: {
              legalName:
                "Durable Retail Limited",

              tradingName:
                "Durable Commerce",

              industry:
                "Retail",

              businessModel:
                "Omnichannel retail",

              primaryCurrency:
                "USD",

              fiscalYearStartMonth:
                1,

              timezone:
                "Africa/Lagos",
            },
          },
        );

      assert.equal(
        updated.id,
        created.id,
      );

      assert.equal(
        updated.version,
        2,
      );

      assert.equal(
        updated.tradingName,
        "Durable Commerce",
      );

      assert.equal(
        updated.businessModel,
        "Omnichannel retail",
      );

      assert.equal(
        updated.timezone,
        "Africa/Lagos",
      );

      /*
       * Read it again to prove the update
       * was committed to PostgreSQL.
       */
      const persistedUpdate =
        await onboarding.getProfile({
          organizationId:
            firstOrganization.id,

          actorUserId:
            first.user.id,
        });

      assert.equal(
        persistedUpdate.id,
        created.id,
      );

      assert.equal(
        persistedUpdate.version,
        2,
      );

      assert.equal(
        persistedUpdate.tradingName,
        "Durable Commerce",
      );

      /*
       * Create a second unrelated tenant.
       */
      const outsider =
        await identity.register({
          email:
            `onboarding-outsider-${suffix}@example.test`,

          displayName:
            "Outside Owner",

          password,
        });

      const outsideOrganization =
        await identity.createOrganization(
          {
            actorUserId:
              outsider.user.id,

            name:
              `Outside Company ${suffix}`,

            slug:
              `outside-onboarding-${suffix}`,
          },
        );

      /*
       * The outsider may create a profile
       * inside their own organization.
       */
      const outsideProfile =
        await onboarding.upsertProfile({
          organizationId:
            outsideOrganization.id,

          actorUserId:
            outsider.user.id,

          profile: {
            legalName:
              "Outside Company",

            tradingName:
              null,

            industry:
              "Services",

            businessModel:
              "Professional services",

            primaryCurrency:
              "EUR",

            fiscalYearStartMonth:
              1,

            timezone:
              "UTC",
          },
        });

      assert.equal(
        outsideProfile.organizationId,
        outsideOrganization.id,
      );

      /*
       * But they must never be able to read
       * the first tenant's profile.
       */
      await assert.rejects(
        onboarding.getProfile({
          organizationId:
            firstOrganization.id,

          actorUserId:
            outsider.user.id,
        }),

        (error) =>
          error instanceof
            AuthError &&
          error.code ===
            "ORG_ACCESS_DENIED",
      );

      /*
       * Nor may they modify it.
       */
      await assert.rejects(
        onboarding.upsertProfile({
          organizationId:
            firstOrganization.id,

          actorUserId:
            outsider.user.id,

          profile: {
            legalName:
              "Unauthorized Change",

            tradingName:
              null,

            industry:
              "Retail",

            businessModel:
              "Unauthorized",

            primaryCurrency:
              "USD",

            fiscalYearStartMonth:
              1,

            timezone:
              "UTC",
          },
        }),

        (error) =>
          error instanceof
            AuthError &&
          error.code ===
            "ORG_ACCESS_DENIED",
      );

      /*
       * Ensure the denied attempt did not
       * alter the first tenant's data.
       */
      const afterDeniedWrite =
        await onboarding.getProfile({
          organizationId:
            firstOrganization.id,

          actorUserId:
            first.user.id,
        });

      assert.equal(
        afterDeniedWrite.legalName,
        "Durable Retail Limited",
      );

      assert.equal(
        afterDeniedWrite.tradingName,
        "Durable Commerce",
      );

      assert.equal(
        afterDeniedWrite.version,
        2,
      );
    } finally {
      await pool.end();
    }
  },
);