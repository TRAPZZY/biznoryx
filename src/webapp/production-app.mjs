import {
  createServer,
} from "node:http";

import {
  readFileSync,
} from "node:fs";

import {
  extname,
  join,
  normalize,
} from "node:path";

import {
  AuthError,
  normalizeEmail,
  secureSessionCookie,
} from "../auth/core.mjs";

import {
  PostgresIdentityRepository,
} from "../database/identity-repository.mjs";

import {
  PostgresEmailVerificationRepository,
} from "../database/email-verification-repository.mjs";

import {
  PostgresBusinessOnboardingRepository,
} from "../database/business-onboarding-repository.mjs";

import {
  PostgresDataIngestionRepository,
} from "../database/data-ingestion-repository.mjs";

import {
  PostgresProcessingJobRepository,
} from "../database/processing-job-repository.mjs";

import {
  PostgresVerifiedMetricsRepository,
} from "../database/verified-metrics-repository.mjs";

import {
  PostgresMetricComparisonRepository,
} from "../database/metric-comparison-repository.mjs";

import {
  PostgresPerformanceFindingsRepository,
} from "../database/performance-findings-repository.mjs";

import {
  BusinessActionError,
  PostgresBusinessActionsRepository,
} from "../database/business-actions-repository.mjs";

import {
  PostgresBusinessOutcomesRepository,
} from "../database/business-outcomes-repository.mjs";

import {
  ResendEmailSender,
} from "../email/resend-email-sender.mjs";

import {
  ProductionIngestionService,
} from "../ingestion/production-ingestion-service.mjs";

import {
  ObjectStorageError,
  S3ObjectStorage,
} from "../storage/s3-object-storage.mjs";

import {
  createHealthChecks,
} from "../server/health.mjs";

import {
  postgresAppShellState,
} from "../server/postgres-app-shell.mjs";

import {
  createWorkerHealthProbe,
} from "../server/worker-health-probe.mjs";
import { PostgresEvidenceReportRepository } from "../database/evidence-report-repository.mjs";
import { buildBusinessReport } from "../reports/evidence-engine.mjs";
import { reportSourcesFromSeries } from "../reports/production-sources.mjs";
import { sendEvidenceExport } from "../reports/export.mjs";

const CONTENT_TYPES =
  new Map([
    [
      ".html",
      "text/html; charset=utf-8",
    ],

    [
      ".css",
      "text/css; charset=utf-8",
    ],

    [
      ".js",
      "text/javascript; charset=utf-8",
    ],

    [
      ".json",
      "application/json; charset=utf-8",
    ],

    [
      ".svg",
      "image/svg+xml",
    ],

    [
      ".png",
      "image/png",
    ],

    [
      ".jpg",
      "image/jpeg",
    ],

    [
      ".jpeg",
      "image/jpeg",
    ],

    [
      ".webp",
      "image/webp",
    ],

    [
      ".ico",
      "image/x-icon",
    ],
  ]);

const AUTH_RATE_LIMIT_WINDOW_MS =
  60_000;

const AUTH_RATE_LIMIT_MAX =
  15;

const MAX_JSON_BODY_BYTES =
  32 * 1024 * 1024;

const WORKER_HEALTH_MAX_AGE_SECONDS =
  30;

export function createProductionApp({
  pool,
  identityRepository,
  emailVerificationRepository,
  businessOnboardingRepository,
  dataIngestionRepository,
  processingJobRepository,
  verifiedMetricsRepository,
  metricComparisonRepository,
  performanceFindingsRepository,
  businessActionsRepository,
  businessOutcomesRepository,
  evidenceReportRepository,
  objectStorage,
  ingestionService,
  healthChecks,
  publicDir = join(
    process.cwd(),
    "web-app",
  ),
  production =
    process.env.NODE_ENV ===
    "production",
} = {}) {
  if (
    !pool &&
    (
      !identityRepository ||
      !emailVerificationRepository
    )
  ) {
    throw new Error(
      "A PostgreSQL pool or production repositories are required.",
    );
  }

  const identity =
    identityRepository ??
    new PostgresIdentityRepository(
      pool,
      {
        production,
      },
    );

  const emailSender =
    emailVerificationRepository
      ? null
      : new ResendEmailSender();

  const emailVerification =
    emailVerificationRepository ??
    new PostgresEmailVerificationRepository(
      pool,
      {
        emailSender,
      },
    );

  const businessOnboarding =
    businessOnboardingRepository ??
    (
      pool
        ? new PostgresBusinessOnboardingRepository(
            pool,
          )
        : null
    );

  const dataIngestion =
    dataIngestionRepository ??
    (
      pool
        ? new PostgresDataIngestionRepository(
            pool,
          )
        : null
    );

  const processingJobs =
    processingJobRepository ??
    (
      pool
        ? new PostgresProcessingJobRepository(
            pool,
          )
        : null
    );

  const verifiedMetrics =
    verifiedMetricsRepository ??
    (
      pool
        ? new PostgresVerifiedMetricsRepository(
            pool,
          )
        : null
    );

  const metricComparisons =
    metricComparisonRepository ??
    (
      pool
        ? new PostgresMetricComparisonRepository(
            pool,
          )
        : null
    );

  const performanceFindings =
    performanceFindingsRepository ??
    (
      pool
        ? new PostgresPerformanceFindingsRepository(
            pool,
          )
        : null
    );

  const businessActions =
    businessActionsRepository ??
    (
      pool
        ? new PostgresBusinessActionsRepository(
            pool,
          )
        : null
    );

  const evidenceReports = evidenceReportRepository ?? (pool ? new PostgresEvidenceReportRepository(pool) : null);

  const businessOutcomes =
    businessOutcomesRepository ??
    (
      pool
        ? new PostgresBusinessOutcomesRepository(
            pool,
          )
        : null
    );

  const storage =
    objectStorage ??
    objectStorageFromEnvironment();

  const ingestion =
    ingestionService ??
    (
      dataIngestion &&
      storage
        ? new ProductionIngestionService({
            repository:
              dataIngestion,

            objectStorage:
              storage,
          })
        : null
    );

  const workerProbe =
    processingJobs
      ? createWorkerHealthProbe({
          repository:
            processingJobs,

          maxAgeSeconds:
            WORKER_HEALTH_MAX_AGE_SECONDS,
        })
      : undefined;

  const checks =
    healthChecks ??
    createHealthChecks({
      probes: {
        database:
          pool
            ? async () => {
                await pool.query(
                  "select 1",
                );

                return true;
              }
            : undefined,

        objectStorage:
          storage &&
          typeof storage.healthCheck ===
            "function"
            ? async () => {
                await storage
                  .healthCheck();

                return true;
              }
            : undefined,

        worker:
          workerProbe,
      },

      timeoutMs:
        2_000,
    });

  const runtime = {
    pool,

    identity,

    emailVerification,

    businessOnboarding,

    dataIngestion,

    processingJobs,

    verifiedMetrics,
    evidenceReports,

    metricComparisons,

    performanceFindings,

    businessActions,

    businessOutcomes,

    objectStorage:
      storage,

    ingestion,

    healthChecks:
      checks,

    publicDir,

    production,

    authAttempts:
      new Map(),
  };

  const server =
    createServer(
      async (
        request,
        response,
      ) => {
        try {
          await routeRequest({
            request,
            response,
            runtime,
          });
        } catch (error) {
          sendError(
            response,
            error,
          );
        }
      },
    );

  return {
    server,
    runtime,
  };
}

async function routeRequest({
  request,
  response,
  runtime,
}) {
  const url =
    new URL(
      request.url ??
        "/",

      `http://${request.headers.host ?? "localhost"}`,
    );

  applySecurityHeaders(
    response,
    runtime.production,
  );

  if (
    url.pathname ===
      "/healthz" &&
    request.method ===
      "GET"
  ) {
    const health =
      runtime.healthChecks
        .liveness();

    sendJson(
      response,
      health.statusCode,
      {
        status:
          health.state,
      },
    );

    return;
  }

  if (
    url.pathname ===
      "/readyz" &&
    request.method ===
      "GET"
  ) {
    const health =
      await runtime.healthChecks
        .readiness();

    sendJson(
      response,
      health.statusCode,
      {
        status:
          health.state,

        checks:
          health.checks,
      },
    );

    return;
  }

  enforceAllowedOrigin(
    request,
  );

  if (
    isAuthEndpoint(
      url.pathname,
    )
  ) {
    enforceAuthRateLimit(
      request,
      runtime,
    );
  }

  /*
   * ==================================================
   * AUTH — REGISTER
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/register" &&
    request.method ===
      "POST"
  ) {
    const body =
      await readJson(
        request,
      );

    validateCredentials(
      body,
    );

    validateEmail(
      body.email,
    );

    const user =
      await runtime.identity
        .createUser({
          email:
            body.email,

          displayName:
            assertText(
              body.displayName,
              "Your name is required.",
              120,
            ),

          password:
            body.password,
        });

    const verification =
      await runtime
        .emailVerification
        .issue({
          email:
            user.email,

          actorUserId:
            user.id,
        });

    sendJson(
      response,
      201,
      {
        requiresEmailVerification:
          true,

        email:
          user.email,

        expiresAt:
          verification
            .expiresAt,
      },
    );

    return;
  }

  /*
   * ==================================================
   * AUTH — RESEND EMAIL CODE
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/auth/resend-code" &&
    request.method ===
      "POST"
  ) {
    const body =
      await readJson(
        request,
      );

    validateEmail(
      body.email,
    );

    const verification =
      await runtime
        .emailVerification
        .issue({
          email:
            body.email,

          actorUserId:
            null,
        });

    sendJson(
      response,
      200,
      {
        sent:
          true,

        email:
          verification.email ??
          normalizeEmail(
            body.email,
          ),

        expiresAt:
          verification
            .expiresAt,
      },
    );

    return;
  }

  /*
   * ==================================================
   * AUTH — VERIFY EMAIL
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/auth/verify-email" &&
    request.method ===
      "POST"
  ) {
    const body =
      await readJson(
        request,
      );

    const user =
      await runtime
        .emailVerification
        .verify({
          email:
            assertText(
              body.email,
              "Email is required.",
            ),

          code:
            assertText(
              body.code,
              "Verification code is required.",
              32,
            ),
        });

    const result =
      await runtime.identity
        .createSessionForUser(
          user,
        );

    response.setHeader(
      "Set-Cookie",
      result.cookie,
    );

    const shell =
      await postgresAppShellState({
        user,

        session:
          result.session,

        identityRepository:
          runtime.identity,
      });

    sendJson(
      response,
      200,
      {
        authenticated:
          true,

        csrfToken:
          result.csrfToken,

        shell,
      },
    );

    return;
  }

  /*
   * ==================================================
   * AUTH — SIGN IN
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/sign-in" &&
    request.method ===
      "POST"
  ) {
    const body =
      await readJson(
        request,
      );

    validateCredentials(
      body,
    );

    validateEmail(
      body.email,
    );

    let result;

    try {
      result =
        await runtime.identity
          .signIn({
            email:
              body.email,

            password:
              body.password,

            requireVerifiedEmail:
              true,
          });
    } catch (error) {
      if (
        error instanceof
          AuthError &&
        error.code ===
          "EMAIL_VERIFICATION_REQUIRED"
      ) {
        const verification =
          await runtime
            .emailVerification
            .issue({
              email:
                body.email,

              actorUserId:
                null,
            });

        sendJson(
          response,
          403,
          {
            error:
              "EMAIL_VERIFICATION_REQUIRED",

            message:
              error.message,

            requiresEmailVerification:
              true,

            email:
              normalizeEmail(
                body.email,
              ),

            expiresAt:
              verification
                .expiresAt,
          },
        );

        return;
      }

      throw error;
    }

    response.setHeader(
      "Set-Cookie",
      result.cookie,
    );

    const shell =
      await postgresAppShellState({
        user:
          result.user,

        session:
          result.session,

        identityRepository:
          runtime.identity,
      });

    sendJson(
      response,
      200,
      {
        authenticated:
          true,

        csrfToken:
          result.csrfToken,

        shell,
      },
    );

    return;
  }

  /*
   * ==================================================
   * AUTH — SESSION
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/session" &&
    request.method ===
      "GET"
  ) {
    const token =
      sessionTokenFromRequest(
        request,
      );

    if (!token) {
      sendJson(
        response,
        200,
        {
          authenticated:
            false,

          shell:
            await postgresAppShellState({
              user:
                null,

              session:
                null,

              identityRepository:
                runtime.identity,
            }),
        },
      );

      return;
    }

    let context;

    try {
      context =
        await runtime.identity
          .authenticate({
            token,

            requireCsrf:
              false,
          });
    } catch (error) {
      if (
        error instanceof
          AuthError &&
        [
          "SESSION_INVALID",
          "USER_DISABLED",
          "MEMBERSHIP_DISABLED",
        ].includes(
          error.code,
        )
      ) {
        response.setHeader(
          "Set-Cookie",
          clearSessionCookie(
            runtime.production,
          ),
        );

        sendJson(
          response,
          200,
          {
            authenticated:
              false,

            shell:
              await postgresAppShellState({
                user:
                  null,

                session:
                  null,

                identityRepository:
                  runtime.identity,
              }),
          },
        );

        return;
      }

      throw error;
    }

    const csrfToken =
      await runtime.identity
        .rotateCsrfToken(
          context.session.id,
          context.user.id,
        );

    const shell =
      await postgresAppShellState({
        user:
          context.user,

        session:
          context.session,

        identityRepository:
          runtime.identity,
      });

    sendJson(
      response,
      200,
      {
        authenticated:
          true,

        csrfToken,

        shell,
      },
    );

    return;
  }

  /*
   * ==================================================
   * AUTH — SIGN OUT
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/sign-out" &&
    request.method ===
      "POST"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    await runtime.identity
      .revokeSession(
        context.session.id,
        context.user.id,
      );

    response.setHeader(
      "Set-Cookie",
      clearSessionCookie(
        runtime.production,
      ),
    );

    sendJson(
      response,
      200,
      {
        signedOut:
          true,
      },
    );

    return;
  }

  /*
   * ==================================================
   * ORGANIZATION — CREATE
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/organizations" &&
    request.method ===
      "POST"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    const body =
      await readJson(
        request,
      );

    const name =
      assertText(
        body.name,
        "Organization name is required.",
        160,
      );

    let organization;

    try {
      organization =
        await runtime.identity
          .createOrganization({
            actorUserId:
              context.user.id,

            name,

            slug:
              slugify(
                name,
              ),
          });
    } catch (error) {
      if (
        error?.code ===
        "23505"
      ) {
        throw new AuthError(
          "An organization with this name already exists.",
          "ORGANIZATION_EXISTS",
        );
      }

      throw error;
    }

    await runtime.identity
      .switchOrganization({
        sessionId:
          context.session.id,

        actorUserId:
          context.user.id,

        organizationId:
          organization.id,
      });

    const session = {
      ...context.session,

      activeOrganizationId:
        organization.id,
    };

    const shell =
      await postgresAppShellState({
        user:
          context.user,

        session,

        identityRepository:
          runtime.identity,
      });

    sendJson(
      response,
      201,
      {
        organization,
        shell,
      },
    );

    return;
  }

  /*
   * ==================================================
   * ORGANIZATION — SWITCH
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/organizations/switch" &&
    request.method ===
      "POST"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    const body =
      await readJson(
        request,
      );

    const organizationId =
      assertText(
        body.organizationId,
        "Organization is required.",
        64,
      );

    await runtime.identity
      .switchOrganization({
        sessionId:
          context.session.id,

        actorUserId:
          context.user.id,

        organizationId,
      });

    const session = {
      ...context.session,

      activeOrganizationId:
        organizationId,
    };

    const shell =
      await postgresAppShellState({
        user:
          context.user,

        session,

        identityRepository:
          runtime.identity,
      });

    sendJson(
      response,
      200,
      {
        shell,
      },
    );

    return;
  }

  /*
   * ==================================================
   * ONBOARDING — WRITE
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/onboarding/profile" &&
    request.method ===
      "POST"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before completing onboarding.",
      );

    if (
      !runtime
        .businessOnboarding
    ) {
      throw new Error(
        "Business onboarding repository is not configured.",
      );
    }

    const body =
      await readJson(
        request,
      );

    const profile =
      await runtime
        .businessOnboarding
        .upsertProfile({
          organizationId,

          actorUserId:
            context.user.id,

          profile: {
            legalName:
              body.legalName,

            tradingName:
              body.tradingName,

            industry:
              body.industry,

            businessModel:
              body.businessModel,

            primaryCurrency:
              body.primaryCurrency,

            fiscalYearStartMonth:
              body
                .fiscalYearStartMonth,

            timezone:
              body.timezone,
          },
        });

    sendJson(
      response,
      200,
      {
        profile,
      },
    );

    return;
  }

  /*
   * ==================================================
   * ONBOARDING — READ
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/onboarding/profile" &&
    request.method ===
      "GET"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          false,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before loading onboarding.",
      );

    if (
      !runtime
        .businessOnboarding
    ) {
      throw new Error(
        "Business onboarding repository is not configured.",
      );
    }

    const profile =
      await runtime
        .businessOnboarding
        .getProfile({
          organizationId,

          actorUserId:
            context.user.id,
        });

    sendJson(
      response,
      200,
      {
        profile,
      },
    );

    return;
  }

  /*
   * ==================================================
   * INGESTION
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/ingestion/upload" &&
    request.method ===
      "POST"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    /*
     * Freeze tenant identity before reading the
     * potentially large request body.
     */
    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before uploading business data.",
      );

    if (
      !runtime.ingestion
    ) {
      throw new AuthError(
        "Production ingestion is not available.",
        "SERVICE_UNAVAILABLE",
      );
    }

    const body =
      await readJson(
        request,
      );

    if (
      Array.isArray(
        body.files,
      )
    ) {
      const results =
        await runtime.ingestion
          .uploadBatch({
            organizationId,

            actorUserId:
              context.user.id,

            files:
              body.files,

            period:
              body.period,

            dataSeries:
              body.dataSeries ??
              "Business data",
          });

      sendJson(
        response,
        200,
        {
          uploads:
            results.map(
              mapIngestionResult,
            ),
        },
      );

      return;
    }

    const result =
      await runtime.ingestion
        .upload({
          organizationId,

          actorUserId:
            context.user.id,

          fileName:
            body.fileName,

          content:
            body.content,

          period:
            body.period,

          dataSeries:
            body.dataSeries ??
            "Business data",
        });

    sendJson(
      response,
      200,
      {
        upload:
          mapIngestionResult(
            result,
          ),
      },
    );

    return;
  }

  /*
   * ==================================================
   * ACTIONS — LIST
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/actions" &&
    request.method ===
      "GET"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          false,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before loading actions.",
      );

    if (
      !runtime.businessActions
    ) {
      throw new AuthError(
        "Business actions are not available.",
        "SERVICE_UNAVAILABLE",
      );
    }

    const actions =
      await runtime
        .businessActions
        .listActions({
          organizationId,

          actorUserId:
            context.user.id,
        });

    sendJson(
      response,
      200,
      {
        actions,
      },
    );

    return;
  }

  /*
   * ==================================================
   * ACTIONS — CREATE FROM VERIFIED FINDING
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/actions" &&
    request.method ===
      "POST"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before creating actions.",
      );

    if (
      !runtime.businessActions
    ) {
      throw new AuthError(
        "Business actions are not available.",
        "SERVICE_UNAVAILABLE",
      );
    }

    const body =
      await readJson(
        request,
      );

    const findingId =
      assertText(
        body.findingId,
        "Finding is required.",
        64,
      );

    const action =
      await runtime
        .businessActions
        .createFromFinding({
          organizationId,

          actorUserId:
            context.user.id,

          findingId,

          action: {
            title:
              body.title,

            description:
              body.description,

            ownerUserId:
              body.ownerUserId,

            dueDate:
              body.dueDate,
          },
        });

    sendJson(
      response,
      201,
      {
        action,
      },
    );

    return;
  }

  /*
   * ==================================================
   * ACTIONS — STATUS TRANSITION
   * ==================================================
   *
   * PATCH /api/actions/:id/status
   */

  const actionStatusMatch =
    /^\/api\/actions\/([^/]+)\/status$/.exec(
      url.pathname,
    );

  if (
    actionStatusMatch &&
    request.method ===
      "PATCH"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          true,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before updating actions.",
      );

    if (
      !runtime.businessActions
    ) {
      throw new AuthError(
        "Business actions are not available.",
        "SERVICE_UNAVAILABLE",
      );
    }

    const actionId =
      decodeURIComponent(
        actionStatusMatch[1],
      );

    if (
      !actionId ||
      actionId.length >
        128
    ) {
      throw new BusinessActionError(
        "Action is required.",
        "BUSINESS_ACTION_INVALID",
      );
    }

    const body =
      await readJson(
        request,
      );

    const status =
      assertText(
        body.status,
        "Action status is required.",
        32,
      );

    const action =
      await runtime
        .businessActions
        .updateStatus({
          organizationId,

          actorUserId:
            context.user.id,

          actionId,

          status,
        });

    if (
      runtime.businessOutcomes &&
      (
        action.status ===
          "in_progress" ||
        action.status ===
          "completed"
      )
    ) {
      await runtime
        .businessOutcomes
        .refreshForAction({
          organizationId,

          actorUserId:
            context.user.id,

          actionId:
            action.id,
        });
    }

    sendJson(
      response,
      200,
      {
        action,
      },
    );

    return;
  }

  /*
   * ==================================================
   * OUTCOMES — LIST
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/outcomes" &&
    request.method ===
      "GET"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          false,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before loading outcomes.",
      );

    if (
      !runtime.businessOutcomes
    ) {
      throw new AuthError(
        "Business outcomes are not available.",
        "SERVICE_UNAVAILABLE",
      );
    }

    await runtime
      .businessOutcomes
      .refreshForOrganization({
        organizationId,

        actorUserId:
          context.user.id,
      });

    const outcomes =
      await runtime
        .businessOutcomes
        .listOutcomes({
          organizationId,

          actorUserId:
            context.user.id,
        });

    sendJson(
      response,
      200,
      {
        outcomes,
      },
    );

    return;
  }

  /*
   * ==================================================
   * DASHBOARD
   * ==================================================
   */

  if (
    url.pathname ===
      "/api/dashboard" &&
    request.method ===
      "GET"
  ) {
    const {
      context,
    } =
      await authenticateRequest({
        request,
        runtime,

        requireCsrf:
          false,
      });

    const organizationId =
      requireActiveOrganization(
        context,
        "Select or create an organization before loading the workspace.",
      );

    if (
      !runtime
        .businessOnboarding
    ) {
      throw new Error(
        "Business onboarding repository is not configured.",
      );
    }

    const actorUserId =
      context.user.id;

    const [
      shell,
      profile,
      uploads,
      series,
      trendRows,
      findingModules,
      actions,
      outcomes,
    ] =
      await Promise.all([
        postgresAppShellState({
          user:
            context.user,

          session:
            context.session,

          identityRepository:
            runtime.identity,
        }),

        runtime
          .businessOnboarding
          .getProfile({
            organizationId,

            actorUserId,
          }),

        runtime.dataIngestion
          ? runtime
              .dataIngestion
              .listUploads({
                organizationId,

                actorUserId,
              })
          : Promise.resolve(
              [],
            ),

        runtime.verifiedMetrics
          ? runtime
              .verifiedMetrics
              .listSeries({
                organizationId,

                actorUserId,
              })
          : Promise.resolve(
              [],
            ),

        runtime.metricComparisons
          ? runtime
              .metricComparisons
              .listTrendRows({
                organizationId,

                actorUserId,
              })
          : Promise.resolve(
              [],
            ),

        runtime.performanceFindings
          ? runtime
              .performanceFindings
              .listDashboardModules({
                organizationId,

                actorUserId,
              })
          : Promise.resolve({
              signals:
                [],

              risks:
                [],

              opportunities:
                [],

              focusAreas:
                [],
            }),

        runtime.businessActions
          ? runtime
              .businessActions
              .listActions({
                organizationId,

                actorUserId,
              })
          : Promise.resolve(
              [],
            ),

        runtime.businessOutcomes
          ? runtime
              .businessOutcomes
              .listOutcomes({
                organizationId,

                actorUserId,
              })
          : Promise.resolve(
              [],
            ),
      ]);

    const seriesGroups =
      buildDashboardSeriesGroups(
        series,
      );

    sendJson(
      response,
      200,
      {
        shell,

        profile,

        uploads:
          uploads.map(
            mapDashboardUpload,
          ),

        series,

        seriesGroups,

        trendRows,

        signals:
          findingModules
            .signals ??
          [],

        risks:
          findingModules
            .risks ??
          [],

        opportunities:
          findingModules
            .opportunities ??
          [],

        focusAreas:
          findingModules
            .focusAreas ??
          [],

        /*
         * Durable decision memory.
         */
        actions,

        outcomes:
          outcomes,

        evidenceReports:
          reportSourcesFromSeries(series).map((source) => ({
            id: `evidence_${source.id}`, sourceId: source.id,
            title: `${source.dataSeries} evidence report`, period: source.period,
          })),

        auditTrail:
          [],

        subscription:
          null,
      },
    );

    return;
  }

  if (url.pathname === "/api/evidence-report" && request.method === "GET") {
    const { context } = await authenticateRequest({ request, runtime, requireCsrf: false });
    const organizationId = requireActiveOrganization(context, "Select an organization before reading a report.");
    if (!runtime.verifiedMetrics || !runtime.businessOnboarding) throw new AuthError("Evidence reports require verified metric storage.", "VALIDATION_FAILED");
    const tenant = { organizationId, actorUserId: context.user.id };
    const [series, profile, policies] = await Promise.all([
      runtime.verifiedMetrics.listSeries(tenant), runtime.businessOnboarding.getProfile(tenant),
      runtime.evidenceReports ? runtime.evidenceReports.listPolicies(tenant) : Promise.resolve([]),
    ]);
    const report = buildBusinessReport({ sources: reportSourcesFromSeries(series), profile, policies, options: Object.fromEntries(url.searchParams) });
    if (url.searchParams.has("format")) await sendEvidenceExport(response, report, url.searchParams.get("format"));
    else sendJson(response, 200, { report });
    return;
  }

  if (url.pathname === "/api/evidence-report/definition" && request.method === "POST") {
    const { context } = await authenticateRequest({ request, runtime, requireCsrf: true });
    const organizationId = requireActiveOrganization(context, "Select an organization before approving a definition.");
    if (!runtime.verifiedMetrics) throw new AuthError("Evidence reports require verified metric storage.", "VALIDATION_FAILED");
    const tenant = { organizationId, actorUserId: context.user.id };
    const body = await readJson(request);
    const sources = reportSourcesFromSeries(await runtime.verifiedMetrics.listSeries(tenant));
    const source = sources.find((s) => s.id === body.source);
    if (!source || !source.cube.metrics.some((m) => m.column === body.metric)) throw new AuthError("Report source not found.", "NOT_FOUND");
    if (!runtime.evidenceReports) throw new AuthError("Report definitions are not configured.", "VALIDATION_FAILED");
    const policy = await runtime.evidenceReports.approvePolicy({ ...tenant, seriesKey: source.seriesKey, column: body.metric, definition: body, expectedVersion: Number(body.expectedVersion ?? 0) });
    sendJson(response, 200, { policy });
    return;
  }

  /*
   * ==================================================
   * UNKNOWN API
   * ==================================================
   */

  if (
    url.pathname.startsWith(
      "/api/",
    )
  ) {
    throw new AuthError(
      "Endpoint not found.",
      "NOT_FOUND",
    );
  }

  serveStatic({
    request,
    response,
    url,

    publicDir:
      runtime.publicDir,
  });
}

async function authenticateRequest({
  request,
  runtime,
  requireCsrf = false,
}) {
  const token =
    sessionTokenFromRequest(
      request,
    );

  if (!token) {
    throw new AuthError(
      "Session is not active.",
      "SESSION_INVALID",
    );
  }

  const csrfToken =
    request.headers[
      "x-csrf-token"
    ];

  const context =
    await runtime.identity
      .authenticate({
        token,

        csrfToken,

        requireCsrf,
      });

  return {
    token,
    context,
  };
}

function requireActiveOrganization(
  context,
  message,
) {
  const organizationId =
    context?.session
      ?.activeOrganizationId;

  if (
    !organizationId
  ) {
    throw new AuthError(
      message,
      "ORG_ACCESS_DENIED",
    );
  }

  return organizationId;
}

function sessionTokenFromRequest(
  request,
) {
  return parseCookies(
    request.headers.cookie ??
      "",
  ).bnx_session;
}

function applySecurityHeaders(
  response,
  production,
) {
  response.setHeader(
    "Referrer-Policy",
    "same-origin",
  );

  response.setHeader(
    "X-Frame-Options",
    "DENY",
  );

  response.setHeader(
    "X-Content-Type-Options",
    "nosniff",
  );

  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' https://images.unsplash.com data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join(
      "; ",
    ),
  );

  if (
    production
  ) {
    response.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

function enforceAllowedOrigin(
  request,
) {
  if (
    ![
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ].includes(
      request.method ??
        "",
    )
  ) {
    return;
  }

  const origin =
    request.headers.origin;

  if (!origin) {
    return;
  }

  let originUrl;

  try {
    originUrl =
      new URL(
        origin,
      );
  } catch {
    throw new AuthError(
      "Request origin is not allowed.",
      "CSRF_INVALID",
    );
  }

  if (
    originUrl.host !==
    request.headers.host
  ) {
    throw new AuthError(
      "Request origin is not allowed.",
      "CSRF_INVALID",
    );
  }
}

function enforceAuthRateLimit(
  request,
  runtime,
) {
  const now =
    Date.now();

  for (
    const [
      key,
      record,
    ] of runtime.authAttempts
  ) {
    if (
      record.expiresAt <=
      now
    ) {
      runtime.authAttempts
        .delete(
          key,
        );
    }
  }

  const key =
    request.socket
      .remoteAddress ??
    "unknown";

  const existing =
    runtime.authAttempts
      .get(
        key,
      );

  const record =
    !existing ||
    existing.expiresAt <=
      now
      ? {
          count:
            0,

          expiresAt:
            now +
            AUTH_RATE_LIMIT_WINDOW_MS,
        }
      : existing;

  record.count +=
    1;

  runtime.authAttempts
    .set(
      key,
      record,
    );

  if (
    record.count >
    AUTH_RATE_LIMIT_MAX
  ) {
    throw new AuthError(
      "Too many attempts. Please try again in a minute.",
      "RATE_LIMITED",
    );
  }
}

function isAuthEndpoint(
  pathname,
) {
  return [
    "/api/register",
    "/api/sign-in",
    "/api/auth/verify-email",
    "/api/auth/resend-code",
  ].includes(
    pathname,
  );
}

async function readJson(
  request,
) {
  const chunks =
    [];

  let size =
    0;

  for await (
    const chunk of
      request
  ) {
    size +=
      chunk.length;

    if (
      size >
      MAX_JSON_BODY_BYTES
    ) {
      throw new AuthError(
        "The request is too large.",
        "VALIDATION_FAILED",
      );
    }

    chunks.push(
      chunk,
    );
  }

  if (
    chunks.length ===
    0
  ) {
    return {};
  }

  const raw =
    Buffer.concat(
      chunks,
    ).toString(
      "utf8",
    );

  try {
    const value =
      JSON.parse(
        raw,
      );

    if (
      !value ||
      typeof value !==
        "object" ||
      Array.isArray(
        value,
      )
    ) {
      throw new Error(
        "JSON object required.",
      );
    }

    return value;
  } catch {
    throw new AuthError(
      "Request body must be valid JSON.",
      "INVALID_JSON",
    );
  }
}

function sendJson(
  response,
  status,
  body,
) {
  response.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",

      "X-Content-Type-Options":
        "nosniff",
    },
  );

  response.end(
    JSON.stringify(
      body,
    ),
  );
}

function sendError(
  response,
  error,
) {
  if (
    error instanceof
    BusinessActionError
  ) {
    const status =
      new Map([
        [
          "BUSINESS_ACTION_INVALID",
          400,
        ],

        [
          "ACTION_STATUS_TRANSITION_INVALID",
          409,
        ],

        [
          "FINDING_NOT_ACTIONABLE",
          409,
        ],
      ]).get(
        error.code,
      ) ??
      400;

    sendJson(
      response,
      status,
      {
        error:
          error.code,

        message:
          error.message,
      },
    );

    return;
  }

  if (
    error instanceof
    AuthError
  ) {
    const status =
      new Map([
        [
          "INVALID_CREDENTIALS",
          401,
        ],

        [
          "USER_DISABLED",
          401,
        ],

        [
          "MEMBERSHIP_DISABLED",
          401,
        ],

        [
          "EMAIL_VERIFICATION_REQUIRED",
          403,
        ],

        [
          "EMAIL_CODE_INVALID",
          400,
        ],

        [
          "EMAIL_DELIVERY_FAILED",
          503,
        ],

        [
          "EMAIL_EXISTS",
          409,
        ],

        [
          "WEAK_PASSWORD",
          400,
        ],

        [
          "RATE_LIMITED",
          429,
        ],

        [
          "SESSION_INVALID",
          401,
        ],

        [
          "CSRF_INVALID",
          403,
        ],

        [
          "CAPABILITY_DENIED",
          403,
        ],

        [
          "ORG_ACCESS_DENIED",
          404,
        ],

        [
          "ORGANIZATION_EXISTS",
          409,
        ],

        [
          "NOT_FOUND",
          404,
        ],

        [
          "VALIDATION_FAILED",
          400,
        ],

        [
          "INVALID_JSON",
          400,
        ],

        [
          "SERVICE_UNAVAILABLE",
          503,
        ],
      ]).get(
        error.code,
      ) ??
      400;

    sendJson(
      response,
      status,
      {
        error:
          error.code,

        message:
          error.message,
      },
    );

    return;
  }

  if (
    error instanceof
    ObjectStorageError
  ) {
    sendJson(
      response,
      503,
      {
        error:
          "OBJECT_STORAGE_UNAVAILABLE",

        message:
          "Object storage is temporarily unavailable.",
      },
    );

    return;
  }

  console.error(
    "Unhandled production application error:",
    error,
  );

  sendJson(
    response,
    500,
    {
      error:
        "INTERNAL_SERVER_ERROR",

      message:
        "The request could not be completed.",
    },
  );
}

function serveStatic({
  request,
  response,
  url,
  publicDir,
}) {
  if (
    request.method !==
      "GET" &&
    request.method !==
      "HEAD"
  ) {
    response.writeHead(
      405,
    );

    response.end();

    return;
  }

  if (
    url.pathname ===
    "/vendor/lucide.js"
  ) {
    const body =
      readFileSync(
        join(
          process.cwd(),
          "node_modules/lucide/dist/umd/lucide.min.js",
        ),
      );

    response.writeHead(
      200,
      {
        "Content-Type":
          "text/javascript; charset=utf-8",

        "X-Content-Type-Options":
          "nosniff",
      },
    );

    if (
      request.method ===
      "GET"
    ) {
      response.end(
        body,
      );
    } else {
      response.end();
    }

    return;
  }

  const pathname =
    url.pathname ===
    "/"
      ? "/index.html"
      : url.pathname;

  const safePath =
    normalize(
      pathname,
    ).replace(
      /^(\.\.[/\\])+/,
      "",
    );

  const filePath =
    join(
      publicDir,
      safePath,
    );

  if (
    !filePath.startsWith(
      publicDir,
    )
  ) {
    response.writeHead(
      403,
    );

    response.end(
      "Forbidden",
    );

    return;
  }

  try {
    const body =
      readFileSync(
        filePath,
      );

    response.writeHead(
      200,
      {
        "Content-Type":
          CONTENT_TYPES.get(
            extname(
              filePath,
            ),
          ) ??
          "application/octet-stream",

        "X-Content-Type-Options":
          "nosniff",
      },
    );

    if (
      request.method ===
      "GET"
    ) {
      response.end(
        body,
      );
    } else {
      response.end();
    }
  } catch {
    response.writeHead(
      404,
    );

    response.end(
      "Not found",
    );
  }
}

function parseCookies(
  header,
) {
  return Object.fromEntries(
    header
      .split(
        ";",
      )
      .filter(
        Boolean,
      )
      .map(
        (
          part,
        ) => {
          const [
            key,
            ...value
          ] =
            part
              .trim()
              .split(
                "=",
              );

          return [
            key,

            value.join(
              "=",
            ),
          ];
        },
      ),
  );
}

function clearSessionCookie(
  production,
) {
  return secureSessionCookie(
    "",
    production,
  ).replace(
    /Max-Age=\d+/,
    "Max-Age=0",
  );
}

function assertText(
  value,
  message,
  maxLength = 254,
) {
  const text =
    String(
      value ??
        "",
    ).trim();

  if (
    !text ||
    text.length >
      maxLength
  ) {
    throw new AuthError(
      message,
      "VALIDATION_FAILED",
    );
  }

  return text;
}

function validateEmail(
  email,
) {
  if (
    typeof email !==
      "string" ||
    email.length >
      254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email,
    )
  ) {
    throw new AuthError(
      "Enter a valid email address.",
      "VALIDATION_FAILED",
    );
  }
}

function validateCredentials(
  body,
) {
  if (
    typeof body.email !==
      "string" ||
    body.email.length >
      254 ||
    typeof body.password !==
      "string" ||
    body.password.length >
      128 ||
    !body.password
  ) {
    throw new AuthError(
      "Enter an email address and password.",
      "VALIDATION_FAILED",
    );
  }
}

function objectStorageFromEnvironment(
  env = process.env,
) {
  const bucket =
    cleanEnvironmentValue(
      env
        .BIZNORYX_OBJECT_STORAGE_BUCKET,
    );

  const accessKeyId =
    cleanEnvironmentValue(
      env
        .BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID,
    );

  const secretAccessKey =
    cleanEnvironmentValue(
      env
        .BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY,
    );

  const endpoint =
    cleanEnvironmentValue(
      env
        .BIZNORYX_OBJECT_STORAGE_ENDPOINT,
    );

  const region =
    cleanEnvironmentValue(
      env
        .BIZNORYX_OBJECT_STORAGE_REGION,
    );

  const configured = [
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint,
    region,
  ].some(
    Boolean,
  );

  if (
    !configured
  ) {
    return null;
  }

  if (
    !bucket ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new Error(
      "Object storage configuration is incomplete.",
    );
  }

  return new S3ObjectStorage({
    endpoint:
      endpoint ??
      undefined,

    region:
      region ??
      "us-east-1",

    bucket,

    accessKeyId,

    secretAccessKey,

    forcePathStyle:
      parseEnvironmentBoolean(
        env
          .BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE,

        false,
      ),
  });
}

function mapIngestionResult(
  result,
) {
  return {
    id:
      result.ingestionRun
        .id,

    rawObjectId:
      result.rawObject
        .id,

    fileName:
      result.rawObject
        .originalFilename,

    period:
      reportingMonth(
        result.reportingPeriod
          .periodStart,
      ),

    periodLabel:
      result.reportingPeriod
        .label,

    dataSeries:
      result.dataStream
        .displayName,

    status:
      result.ingestionRun
        .status,

    schemaDrift:
      result.ingestionRun
        .schemaDrift,

    rowCount:
      result.ingestionRun
        .rowCount,

    columnCount:
      result.ingestionRun
        .columnCount,

    byteSize:
      result.rawObject
        .byteSize,

    contentType:
      result.rawObject
        .contentType,

    checksumSha256:
      result.rawObject
        .checksumSha256,

    validationResults:
      result.validationResults ??
      [],

    createdAt:
      result.ingestionRun
        .createdAt,
  };
}

function mapDashboardUpload(
  upload,
) {
  return {
    id:
      upload.id,

    fileName:
      upload.rawObject
        .originalFilename,

    period:
      reportingMonth(
        upload
          .reportingPeriod
          .periodStart,
      ),

    periodLabel:
      upload
        .reportingPeriod
        .label,

    dataSeries:
      upload
        .dataStream
        .displayName,

    status:
      upload.status,

    schemaDrift:
      upload.schemaDrift,

    rowCount:
      upload.rowCount,

    columnCount:
      upload.columnCount,

    byteSize:
      upload
        .rawObject
        .byteSize,

    contentType:
      upload
        .rawObject
        .contentType,

    checksumSha256:
      upload
        .rawObject
        .checksumSha256,

    createdAt:
      upload.createdAt,

    rawObject:
      upload.rawObject,

    reportingPeriod:
      upload
        .reportingPeriod,

    dataStream:
      upload.dataStream,
  };
}

function buildDashboardSeriesGroups(
  series,
) {
  const groups =
    new Map();

  for (
    const item of
      series
  ) {
    const stream =
      item?.dataStream;

    if (
      !stream?.id
    ) {
      continue;
    }

    let group =
      groups.get(
        stream.id,
      );

    if (
      !group
    ) {
      group = {
        id:
          stream.id,

        name:
          stream.name,

        displayName:
          stream.displayName,

        seriesIds:
          [],
      };

      groups.set(
        stream.id,
        group,
      );
    }

    group.seriesIds.push(
      item.id,
    );
  }

  return [
    ...groups.values(),
  ];
}

function reportingMonth(
  value,
) {
  if (
    value instanceof
      Date &&
    !Number.isNaN(
      value.getTime(),
    )
  ) {
    return value
      .toISOString()
      .slice(
        0,
        7,
      );
  }

  const text =
    String(
      value ??
        "",
    ).trim();

  const match =
    /^(\d{4}-\d{2})/.exec(
      text,
    );

  return match
    ? match[1]
    : text;
}

function cleanEnvironmentValue(
  value,
) {
  const text =
    String(
      value ??
        "",
    ).trim();

  return text ||
    null;
}

function parseEnvironmentBoolean(
  value,
  fallback,
) {
  if (
    value ===
      undefined ||
    value ===
      null ||
    String(
      value,
    ).trim() ===
      ""
  ) {
    return fallback;
  }

  const normalized =
    String(
      value,
    )
      .trim()
      .toLowerCase();

  if (
    [
      "1",
      "true",
      "yes",
      "on",
    ].includes(
      normalized,
    )
  ) {
    return true;
  }

  if (
    [
      "0",
      "false",
      "no",
      "off",
    ].includes(
      normalized,
    )
  ) {
    return false;
  }

  throw new Error(
    "BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE must be true or false.",
  );
}

function slugify(
  name,
) {
  const slug =
    name
      .toLowerCase()
      .normalize(
        "NFKD",
      )
      .replace(
        /[\u0300-\u036f]/g,
        "",
      )
      .replace(
        /[^a-z0-9]+/g,
        "-",
      )
      .replace(
        /^-|-$/g,
        "",
      )
      .slice(
        0,
        48,
      );

  if (
    !slug
  ) {
    throw new AuthError(
      "Organization name must contain letters or numbers.",
      "VALIDATION_FAILED",
    );
  }

  return slug;
}
