import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AuthError } from "../src/auth/core.mjs";
import { PostgresBillingRepository } from "../src/database/billing-repository.mjs";
import { PostgresEmailVerificationRepository } from "../src/database/email-verification-repository.mjs";
import { PostgresIdentityRepository } from "../src/database/identity-repository.mjs";

import {
  createPostgresPool,
  withTenantTransaction,
} from "../src/database/postgres.mjs";

const databaseUrl =
  process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL runtime persists identity, sessions, organizations, and RLS isolation",
  {
    skip: !databaseUrl,
  },
  async () => {
    const pool =
      createPostgresPool({
        DATABASE_URL:
          databaseUrl,

        NODE_ENV:
          "test",

        BIZNORYX_DB_POOL_MAX:
          "3",
      });

    const repository =
      new PostgresIdentityRepository(
        pool,
      );

    /*
     * Never use the real Resend provider
     * during automated database tests.
     *
     * The test email sender captures the
     * OTP exactly where a production email
     * provider would receive it.
     */
    const deliveredCodes = [];

    const testEmailSender = {
      async sendVerificationCode({
        code,
        purpose,
      }) {
        deliveredCodes.push({
          code,
          purpose,
        });

        return {
          provider: "test",

          messageId:
            "postgres-runtime-test",
        };
      },
    };

    const emailVerification =
      new PostgresEmailVerificationRepository(
        pool,
        {
          emailSender:
            testEmailSender,
        },
      );

    const billing =
      new PostgresBillingRepository(
        pool,
      );

    const suffix =
      randomUUID().slice(0, 8);

    const password =
      "DurableRuntimePassphrase2026!";

    try {
      /*
       * Register first user.
       */
      const first =
        await repository.register({
          email:
            `owner-${suffix}@example.test`,

          displayName:
            "Durable Owner",

          password,
        });

      assert.equal(
        first.memberships.length,
        0,
      );

      /*
       * Issue durable email verification.
       */
      const verification =
        await emailVerification.issue({
          email:
            first.user.email,

          actorUserId:
            first.user.id,
        });

      assert.equal(
        verification.sent,
        true,
      );

      /*
       * The verification code must have
       * been delivered to the email
       * transport.
       */
      assert.match(
        deliveredCodes[0].code,
        /^\d{8}$/,
      );

      /*
       * Security requirement:
       * never expose the OTP from issue().
       */
      assert.equal(
        Object.hasOwn(
          verification,
          "reviewCode",
        ),
        false,
      );

      /*
       * Verify using the code captured
       * by the fake email provider.
       */
      const verifiedUser =
        await emailVerification.verify({
          email:
            first.user.email,

          code:
            deliveredCodes[0].code,
        });

      assert.equal(
        verifiedUser.email,
        first.user.email,
      );

      assert.ok(
        verifiedUser.emailVerifiedAt
          instanceof Date,
      );

      /*
       * Create first organization.
       */
      const firstOrganization =
        await repository.createOrganization(
          {
            actorUserId:
              first.user.id,

            name:
              "Durable Retail",

            slug:
              `durable-retail-${suffix}`,
          },
        );

      /*
       * Billing state persists through
       * PostgreSQL.
       */
      const subscription =
        await billing.ensureSubscription({
          organizationId:
            firstOrganization.id,

          actorUserId:
            first.user.id,
        });

      assert.equal(
        subscription.status,
        "trialing",
      );

      const checkout =
        await billing.createCheckoutSession(
          {
            organizationId:
              firstOrganization.id,

            actorUserId:
              first.user.id,

            provider:
              "paystack",

            reference:
              `paystack-${suffix}`,

            authorizationUrl:
              "https://checkout.paystack.com/test",

            accessCode:
              "access-test",
          },
        );

      assert.equal(
        checkout.status,
        "pending",
      );

      /*
       * First webhook must process.
       */
      const webhook =
        await billing.applyWebhookEvent({
          organizationId:
            firstOrganization.id,

          eventKey:
            `charge.success:${suffix}`,

          eventName:
            "charge.success",

          reference:
            checkout.reference,

          payload:
            Buffer.from(
              `{"reference":"${checkout.reference}"}`,
            ),

          action:
            "subscription_activated",
        });

      assert.equal(
        webhook.duplicate,
        false,
      );

      /*
       * Same webhook must be idempotent.
       */
      const duplicateWebhook =
        await billing.applyWebhookEvent({
          organizationId:
            firstOrganization.id,

          eventKey:
            `charge.success:${suffix}`,

          eventName:
            "charge.success",

          reference:
            checkout.reference,

          payload:
            Buffer.from(
              `{"reference":"${checkout.reference}"}`,
            ),

          action:
            "subscription_activated",
        });

      assert.equal(
        duplicateWebhook.duplicate,
        true,
      );

      /*
       * Activate first organization
       * on the user's session.
       */
      await repository.switchOrganization(
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
       * Authenticate using the original
       * session and CSRF token.
       */
      const authenticated =
        await repository.authenticate({
          token:
            first.token,

          csrfToken:
            first.csrfToken,

          requireCsrf:
            true,
        });

      assert.equal(
        authenticated.session
          .activeOrganizationId,
        firstOrganization.id,
      );

      assert.equal(
        authenticated.membership.role,
        "owner",
      );

      /*
       * Rotate CSRF token.
       */
      const rotatedCsrfToken =
        await repository.rotateCsrfToken(
          first.session.id,
          first.user.id,
        );

      /*
       * Previous CSRF token must no
       * longer authenticate mutations.
       */
      await assert.rejects(
        repository.authenticate({
          token:
            first.token,

          csrfToken:
            first.csrfToken,

          requireCsrf:
            true,
        }),

        (error) =>
          error instanceof
            AuthError &&
          error.code ===
            "CSRF_INVALID",
      );

      /*
       * Rotated token must work.
       */
      await repository.authenticate({
        token:
          first.token,

        csrfToken:
          rotatedCsrfToken,

        requireCsrf:
          true,
      });

      /*
       * Create a new repository instance
       * to simulate an application restart.
       */
      const restartedRepository =
        new PostgresIdentityRepository(
          pool,
        );

      const signedInAgain =
        await restartedRepository.signIn({
          email:
            first.user.email,

          password,
        });

      assert.equal(
        signedInAgain
          .memberships[0]
          .organizationId,
        firstOrganization.id,
      );

      const passwordReset =
        await emailVerification.issue({
          email:
            first.user.email,

          purpose:
            "password_reset",
        });

      assert.equal(
        passwordReset.sent,
        true,
      );

      assert.equal(
        Object.hasOwn(
          passwordReset,
          "reviewCode",
        ),
        false,
      );

      assert.equal(
        deliveredCodes[1].purpose,
        "password_reset",
      );

      const replacementPassword =
        "RecoveredRuntimePassword2026!";

      await emailVerification.resetPassword({
        email:
          first.user.email,

        code:
          deliveredCodes[1].code,

        newPassword:
          replacementPassword,
      });

      await assert.rejects(
        repository.authenticate({
          token:
            first.token,
        }),
        (error) =>
          error instanceof AuthError &&
          error.code === "SESSION_INVALID",
      );

      await assert.rejects(
        emailVerification.resetPassword({
          email:
            first.user.email,

          code:
            deliveredCodes[1].code,

          newPassword:
            "AnotherRecoveredPassword2026!",
        }),
        (error) =>
          error instanceof AuthError &&
          error.code === "EMAIL_CODE_INVALID",
      );

      const signedInAfterReset =
        await restartedRepository.signIn({
          email:
            first.user.email,

          password:
            replacementPassword,
        });

      assert.equal(
        signedInAfterReset.user.id,
        first.user.id,
      );

      await assert.rejects(
        restartedRepository.signIn({
          email:
            first.user.email,

          password,
        }),
        (error) =>
          error instanceof AuthError &&
          error.code === "INVALID_CREDENTIALS",
      );

      /*
       * Create unrelated second tenant.
       */
      const second =
        await repository.register({
          email:
            `outsider-${suffix}@example.test`,

          displayName:
            "Outside Owner",

          password,
        });

      const secondOrganization =
        await repository.createOrganization(
          {
            actorUserId:
              second.user.id,

            name:
              "Outside Company",

            slug:
              `outside-company-${suffix}`,
          },
        );

      /*
       * First user must never be able to
       * switch into the second tenant.
       */
      await assert.rejects(
        repository.switchOrganization({
          sessionId:
            first.session.id,

          actorUserId:
            first.user.id,

          organizationId:
            secondOrganization.id,
        }),

        (error) =>
          error instanceof
            AuthError &&
          error.code ===
            "ORG_ACCESS_DENIED",
      );

      /*
       * RLS must expose only the active
       * tenant's organization.
       */
      const visibleOrganizations =
        await withTenantTransaction(
          pool,
          {
            organizationId:
              firstOrganization.id,

            actorUserId:
              first.user.id,
          },
          (client) =>
            client.query(
              `select id
               from organizations
               order by id`,
            ),
        );

      assert.deepEqual(
        visibleOrganizations.rows,
        [
          {
            id:
              firstOrganization.id,
          },
        ],
      );
    } finally {
      await pool.end();
    }
  },
);