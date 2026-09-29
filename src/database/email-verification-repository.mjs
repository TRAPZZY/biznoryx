import {
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  AuthError,
  hashSecret,
  normalizeEmail,
} from "../auth/core.mjs";

import { EmailDeliveryError } from "../email/resend-email-sender.mjs";
import { withTransaction } from "./postgres.mjs";

const VERIFICATION_CODE_LENGTH = 8;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_ATTEMPTS = 5;

export class PostgresEmailVerificationRepository {
  constructor(
    pool,
    {
      now = () => new Date(),
      emailSender,
    } = {},
  ) {
    this.pool = pool;
    this.now = now;
    this.emailSender = emailSender;
  }

  async issue({
    email,
    purpose = "email_verification",
    actorUserId = null,
  }) {
    const normalizedEmail =
      normalizeEmail(email);

    const userResult =
      await this.pool.query(
        `select
           id,
           email
         from app_users
         where lower(email) = lower($1)
           and disabled_at is null
         limit 1`,
        [normalizedEmail],
      );

    const user = userResult.rows[0];

    /*
     * Prevent account enumeration.
     *
     * We intentionally return the same public
     * response whether or not the user exists.
     */
    if (!user) {
      return {
        sent: true,
        email: normalizedEmail,
        expiresAt: null,
      };
    }

    if (!this.emailSender) {
      throw new AuthError(
        "Email delivery is not configured.",
        "EMAIL_DELIVERY_FAILED",
      );
    }

    const issuedAt = this.now();

    const expiresAt = new Date(
      issuedAt.getTime() +
        VERIFICATION_TTL_MS,
    );

    const code =
      generateVerificationCode();

    const codeHash =
      hashSecret(code);

    const challengeId =
      randomUUID();

    await withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [user.id],
        );

        /*
         * A newly issued code invalidates every
         * previous unused code.
         */
        await client.query(
          `update email_verification_challenges
           set consumed_at = $3,
               superseded_at = $3
           where user_id = $1
             and purpose = $2
             and consumed_at is null`,
          [
            user.id,
            purpose,
            issuedAt,
          ],
        );

        await client.query(
          `insert into email_verification_challenges (
             id,
             user_id,
             email,
             purpose,
             code_hash,
             attempts,
             max_attempts,
             expires_at,
             created_at
           )
           values (
             $1,
             $2,
             $3,
             $4,
             $5,
             0,
             $6,
             $7,
             $8
           )`,
          [
            challengeId,
            user.id,
            normalizedEmail,
            purpose,
            codeHash,
            MAX_VERIFICATION_ATTEMPTS,
            expiresAt,
            issuedAt,
          ],
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
             'identity.email_verification_issued',
             'app_user',
             $2,
             $3::jsonb
           )`,
          [
            actorUserId ?? user.id,
            user.id,
            JSON.stringify({
              purpose,
            }),
          ],
        );
      },
    );

    try {
      await this.emailSender.sendVerificationCode(
        {
          to: normalizedEmail,
          code,
          expiresAt,
          challengeId,
        },
      );
    } catch (error) {
      /*
       * Never leave an undelivered code active.
       */
      await this.invalidateChallenge({
        challengeId,
        userId: user.id,
      }).catch(() => undefined);

      if (
        error instanceof
        EmailDeliveryError
      ) {
        throw new AuthError(
          "We could not send your verification email. Please try again.",
          "EMAIL_DELIVERY_FAILED",
        );
      }

      throw error;
    }

    return {
      sent: true,
      email: normalizedEmail,
      expiresAt,
    };
  }

  async verify({
    email,
    code,
    purpose = "email_verification",
  }) {
    const normalizedEmail =
      normalizeEmail(email);

    const now = this.now();

    const normalizedCode =
      String(code ?? "").trim();

    if (
      !/^\d{8}$/.test(
        normalizedCode,
      )
    ) {
      throw invalidVerificationCode();
    }

    const userResult =
      await this.pool.query(
        `select
           id,
           email,
           display_name,
           disabled_at,
           email_verified_at
         from app_users
         where lower(email) = lower($1)
         limit 1`,
        [normalizedEmail],
      );

    const user =
      userResult.rows[0];

    if (
      !user ||
      user.disabled_at
    ) {
      throw invalidVerificationCode();
    }

    const result =
      await withTransaction(
        this.pool,
        async (client) => {
          await client.query(
            "select set_config('app.current_user_id', $1, true)",
            [user.id],
          );

          const challengeResult =
            await client.query(
              `select
                 id,
                 code_hash,
                 attempts,
                 max_attempts,
                 expires_at
               from email_verification_challenges
               where user_id = $1
                 and email = $2
                 and purpose = $3
                 and consumed_at is null
                 and superseded_at is null
               order by created_at desc
               limit 1
               for update`,
              [
                user.id,
                normalizedEmail,
                purpose,
              ],
            );

          const challenge =
            challengeResult.rows[0];

          if (!challenge) {
            return {
              verified: false,
            };
          }

          const expiresAt =
            new Date(
              challenge.expires_at,
            );

          if (
            expiresAt <= now ||
            Number(
              challenge.attempts,
            ) >=
              Number(
                challenge.max_attempts,
              )
          ) {
            await client.query(
              `update email_verification_challenges
               set consumed_at = $2
               where id = $1
                 and consumed_at is null`,
              [
                challenge.id,
                now,
              ],
            );

            return {
              verified: false,
            };
          }

          const nextAttempts =
            Number(
              challenge.attempts,
            ) + 1;

          const suppliedHash =
            hashSecret(
              normalizedCode,
            );

          const valid =
            secretsMatch(
              suppliedHash,
              challenge.code_hash,
            );

          if (!valid) {
            await client.query(
              `update email_verification_challenges
               set attempts = $2,
                   consumed_at =
                     case
                       when $2 >= max_attempts
                       then $3
                       else consumed_at
                     end
               where id = $1`,
              [
                challenge.id,
                nextAttempts,
                now,
              ],
            );

            return {
              verified: false,
            };
          }

          await client.query(
            `update email_verification_challenges
             set attempts = $2,
                 consumed_at = $3
             where id = $1`,
            [
              challenge.id,
              nextAttempts,
              now,
            ],
          );

          await client.query(
            `update app_users
             set email_verified_at = $2,
                 updated_at = $2
             where id = $1`,
            [
              user.id,
              now,
            ],
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
               'identity.email_verified',
               'app_user',
               $1
             )`,
            [user.id],
          );

          return {
            verified: true,
          };
        },
      );

    if (!result.verified) {
      throw invalidVerificationCode();
    }

    return {
      id: user.id,
      email: user.email,
      displayName:
        user.display_name,
      emailVerifiedAt: now,
      disabledAt:
        user.disabled_at,
    };
  }

  async invalidateChallenge({
    challengeId,
    userId,
  }) {
    await withTransaction(
      this.pool,
      async (client) => {
        await client.query(
          "select set_config('app.current_user_id', $1, true)",
          [userId],
        );

        await client.query(
          `update email_verification_challenges
           set consumed_at = coalesce(
                 consumed_at,
                 $2
               ),
               superseded_at = coalesce(
                 superseded_at,
                 $2
               )
           where id = $1`,
          [
            challengeId,
            this.now(),
          ],
        );
      },
    );
  }
}

function generateVerificationCode() {
  const maximum =
    10 **
    VERIFICATION_CODE_LENGTH;

  return randomInt(
    0,
    maximum,
  )
    .toString()
    .padStart(
      VERIFICATION_CODE_LENGTH,
      "0",
    );
}

function secretsMatch(
  actualHash,
  expectedHash,
) {
  const actual =
    Buffer.from(
      actualHash,
      "hex",
    );

  const expected =
    Buffer.from(
      expectedHash,
      "hex",
    );

  if (
    actual.length !==
    expected.length
  ) {
    return false;
  }

  return timingSafeEqual(
    actual,
    expected,
  );
}

function invalidVerificationCode() {
  return new AuthError(
    "Verification code is invalid or expired.",
    "EMAIL_CODE_INVALID",
  );
}