import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import {
  AuditLog,
  AuthError,
  CAPABILITIES,
  EmailVerificationService,
  IdentityService,
  InvitationService,
  OrganizationService,
  SessionService,
  AuthorizationService,
  createEmptyStore,
  normalizeEmail,
  secureSessionCookie,
} from "../auth/core.mjs";
import {
  initializePaystackTransaction,
  localReviewCheckout,
  monthlyPlanFromEnv,
  planLabel,
  verifyPaystackTransaction,
  verifyPaystackWebhookSignature,
} from "../billing/paystack.mjs";
import { appShellState } from "../server/app-shell.mjs";
import { BusinessOnboardingService } from "../business/onboarding.mjs";
import {
  buildEvidenceReports,
  validateCustomerUploadFile,
  publicUpload,
  reportSourcesFromUploads,
} from "./customer-data.mjs";
import { buildBusinessReport, validateReportPolicy, validateRevenueMappingSource } from "../reports/evidence-engine.mjs";
import { sendEvidenceExport } from "../reports/export.mjs";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

const publicDir = join(process.cwd(), "web-app");
const reviewEmail = "owner@biznoryx.local";
const reviewPassword = "ReviewPassphrase2026!";

export function createReviewRuntime() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "The in-memory review runtime cannot serve production. Configure a durable application repository first.",
    );
  }
  const store = createEmptyStore();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const sessions = new SessionService(store, auditLog);
  const emailVerification = new EmailVerificationService(store, auditLog);
  const organizations = new OrganizationService(store, auditLog);
  const invitations = new InvitationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const uploads = new Map();
  const subscriptions = new Map();
  const checkoutSessions = new Map();
  const paystackWebhookEvents = new Map();
  const owner = identity.createUser({
    email: reviewEmail,
    displayName: "BIZNORYX Review Owner",
    password: reviewPassword,
    emailVerifiedAt: new Date(),
  });

  identity.acceptCurrentPolicy({
    userId: owner.id,
    acknowledgements: {
      termsAccepted: true,
      privacyAccepted: true,
      dataAuthorityAccepted: true,
      guideAcknowledged: true,
    },
  });
  const acme = organizations.createOrganization({
    name: "Acme Retail Group",
    slug: "acme-retail",
    actorUserId: owner.id,
  }).organization;
  const north = organizations.createOrganization({
    name: "Northstar Foods",
    slug: "northstar-foods",
    actorUserId: owner.id,
  }).organization;
  onboarding.createOrUpdateProfile({
    organizationId: acme.id,
    actorUserId: owner.id,
    profile: {
      legalName: "Acme Retail Group",
      industry: "Retail",
      businessModel: "Multi-location product sales",
      primaryCurrency: "USD",
      fiscalYearStartMonth: 1,
      timezone: "America/New_York",
    },
  });
  onboarding.createOrUpdateProfile({
    organizationId: north.id,
    actorUserId: owner.id,
    profile: {
      legalName: "Northstar Foods",
      industry: "Food service",
      businessModel: "Wholesale and prepared foods",
      primaryCurrency: "USD",
      fiscalYearStartMonth: 1,
      timezone: "America/New_York",
    },
  });
  store.auditEvents.length = 0;

  return {
    store,
    auditLog,
    identity,
    sessions,
    emailVerification,
    organizations,
    invitations,
    onboarding,
    uploads,
    reportPolicies: [],
    subscriptions,
    checkoutSessions,
    paystackWebhookEvents,
    authAttempts: new Map(),
    reviewAccount: { email: reviewEmail, password: reviewPassword },
    seededOrganizations: [acme.id, north.id],
  };
}

export function createReviewApp(runtime = createReviewRuntime()) {
  const server = createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, runtime });
    } catch (error) {
      sendError(response, error);
    }
  });
  return { server, runtime };
}

async function routeRequest({ request, response, runtime }) {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (
    request.method === "POST" &&
    [
      "/api/register",
      "/api/sign-in",
      "/api/auth/verify-email",
      "/api/auth/resend-code",
      "/api/auth/password-reset/request",
      "/api/auth/password-reset/confirm",
    ].includes(url.pathname)
  ) {
    const now = Date.now();
    for (const [key, value] of runtime.authAttempts) {
      if (value.expiresAt <= now) runtime.authAttempts.delete(key);
    }
    const key = `${request.socket.remoteAddress ?? "unknown"}:${url.pathname}`;
    const attempt = runtime.authAttempts.get(key) ?? {
      count: 0,
      expiresAt: now + 60000,
    };
    attempt.count += 1;
    runtime.authAttempts.set(key, attempt);
    if (attempt.count > 15)
      throw new AuthError(
        "Too many attempts. Please try again in a minute.",
        "RATE_LIMITED",
      );
  }
  if (
    request.method === "POST" &&
    request.headers.origin &&
    new URL(request.headers.origin).host !== request.headers.host
  ) {
    throw new AuthError("Request origin is not allowed.", "CSRF_INVALID");
  }
  if (url.pathname === "/api/register" && request.method === "POST") {
    const body = await readJson(request);
    validateCredentials(body);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email ?? ""))
      throw new AuthError("Enter a valid email address.", "VALIDATION_FAILED");
    const user = runtime.identity.createUser({
      email: body.email,
      displayName: assertText(body.displayName, "Your name is required."),
      password: body.password,
    });
    const verification = runtime.emailVerification.issue({
      email: user.email,
      actorUserId: user.id,
    });
    sendJson(response, 201, {
      requiresEmailVerification: true,
      email: user.email,
      expiresAt: verification.expiresAt,
      reviewCode: verification.reviewCode,
    });
    return;
  }

  if (url.pathname === "/api/auth/resend-code" && request.method === "POST") {
    const body = await readJson(request);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email ?? ""))
      throw new AuthError("Enter a valid email address.", "VALIDATION_FAILED");
    const verification = runtime.emailVerification.issue({
      email: body.email,
      actorUserId: null,
    });
    sendJson(response, 200, {
      sent: true,
      email: verification.email,
      expiresAt: verification.expiresAt,
    });
    return;
  }

  if (
    url.pathname === "/api/auth/password-reset/request" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email ?? ""))
      throw new AuthError("Enter a valid email address.", "VALIDATION_FAILED");
    const reset = runtime.emailVerification.issue({
      email: body.email,
      purpose: "password_reset",
    });
    sendJson(response, 202, {
      sent: true,
      message:
        "If an account exists for that email, a password reset code has been sent.",
      reviewCode: reset.reviewCode,
    });
    return;
  }

  if (
    url.pathname === "/api/auth/password-reset/confirm" &&
    request.method === "POST"
  ) {
    const body = await readJson(request);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email ?? ""))
      throw new AuthError("Enter a valid email address.", "VALIDATION_FAILED");
    runtime.emailVerification.resetPassword({
      email: body.email,
      code: assertText(body.code, "Reset code is required."),
      newPassword: body.newPassword,
    });
    sendJson(response, 200, {
      reset: true,
      message: "Password reset. Sign in with your new password.",
    });
    return;
  }

  if (url.pathname === "/api/auth/verify-email" && request.method === "POST") {
    const body = await readJson(request);
    const user = runtime.emailVerification.verify({
      email: assertText(body.email, "Email is required."),
      code: assertText(body.code, "Verification code is required."),
      newPassword: body.newPassword,
    });
    const result = runtime.sessions.createSessionForUser(user);
    response.setHeader("Set-Cookie", result.cookie);
    sendJson(response, 200, {
      csrfToken: result.csrfToken,
      shell: appShellState({
        user,
        session: result.session,
        store: runtime.store,
      }),
    });
    return;
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    const context = authenticateFromRequest(request, runtime, {
      required: false,
      requirePolicy: false,
    });
    if (!context) {
      sendJson(response, 200, {
        authenticated: false,
        shell: appShellState({
          user: null,
          session: null,
          store: runtime.store,
        }),
      });
      return;
    }
    sendJson(response, 200, {
      authenticated: true,
      csrfToken: context.csrfToken,
      shell: appShellState({
        user: context.user,
        session: context.session,
        store: runtime.store,
      }),
    });
    return;
  }

  if (url.pathname === "/api/sign-in" && request.method === "POST") {
    const body = await readJson(request);
    validateCredentials(body);
    let result;
    try {
      result = runtime.sessions.signIn({
        email: body.email,
        password: body.password,
        requireVerifiedEmail: true,
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === "EMAIL_VERIFICATION_REQUIRED") {
        const verification = runtime.emailVerification.issue({
          email: body.email,
          actorUserId: null,
        });
        sendJson(response, 403, {
          error: error.code,
          message: error.message,
          requiresEmailVerification: true,
          email: normalizeEmail(body.email),
          expiresAt: verification.expiresAt,
          reviewCode: verification.reviewCode,
        });
        return;
      }
      throw error;
    }
    response.setHeader("Set-Cookie", result.cookie);
    sendJson(response, 200, {
      csrfToken: result.csrfToken,
      shell: appShellState({
        user: runtime.store.users.get(result.session.userId),
        session: result.session,
        store: runtime.store,
      }),
    });
    return;
  }

  if (
    url.pathname === "/api/account/policy-acceptance" &&
    request.method === "POST"
  ) {
    const context = authenticateFromRequest(
      request,
      runtime,
      {
        requireCsrf: true,
        requirePolicy: false,
      },
    );

    const body = await readJson(request);

    const policy =
      runtime.identity.acceptCurrentPolicy({
        userId: context.user.id,
        acknowledgements: body,
      });

    sendJson(response, 200, {
      accepted: true,
      policy,
      shell: appShellState({
        user: context.user,
        session: context.session,
        store: runtime.store,
      }),
    });

    return;
  }

  if (url.pathname === "/api/sign-out" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
      requirePolicy: false,
    });
    runtime.sessions.signOut(context.session.id, context.user.id);
    response.setHeader("Set-Cookie", clearSessionCookie());
    sendJson(response, 200, { signedOut: true });
    return;
  }

  if (url.pathname === "/api/organizations" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const body = await readJson(request);
    const organization = runtime.organizations.createOrganization({
      name: assertText(body.name, "Organization name is required."),
      slug: slugify(body.name),
      actorUserId: context.user.id,
    }).organization;
    runtime.organizations.switchOrganization({
      sessionId: context.session.id,
      organizationId: organization.id,
      actorUserId: context.user.id,
    });
    sendJson(response, 201, {
      organization,
      shell: appShellState({
        user: context.user,
        session: context.session,
        store: runtime.store,
      }),
    });
    return;
  }

  if (
    url.pathname === "/api/organizations/switch" &&
    request.method === "POST"
  ) {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const body = await readJson(request);
    runtime.organizations.switchOrganization({
      sessionId: context.session.id,
      organizationId: assertText(
        body.organizationId,
        "Organization is required.",
      ),
      actorUserId: context.user.id,
    });
    sendJson(response, 200, {
      shell: appShellState({
        user: context.user,
        session: context.session,
        store: runtime.store,
      }),
    });
    return;
  }

  if (url.pathname === "/api/invitations" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.INVITE_MEMBERS,
    ).organizationId;
    const body = await readJson(request);
    const invitation = runtime.invitations.createInvitation({
      organizationId,
      email: assertText(body.email, "Invitation email is required."),
      role: body.role ?? "viewer",
      actorUserId: context.user.id,
    });
    sendJson(response, 201, {
      invitation: {
        id: invitation.invitation.id,
        email: invitation.invitation.email,
        role: invitation.invitation.role,
        status: invitation.invitation.status,
        expiresAt: invitation.invitation.expiresAt,
      },
    });
    return;
  }

  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    const context = authenticateFromRequest(request, runtime, {
      required: true,
    });
    requireCapability(runtime, context, CAPABILITIES.READ_BUSINESS_DATA);
    sendJson(response, 200, buildDashboardState(runtime, context));
    return;
  }

  if (
    url.pathname === "/api/billing/paystack/webhook" &&
    request.method === "POST"
  ) {
    const rawBody = await readRawBody(request, 2 * 1024 * 1024);
    const signature = request.headers["x-paystack-signature"];
    if (
      !verifyPaystackWebhookSignature({
        payload: rawBody,
        signature,
        secret: process.env.PAYSTACK_SECRET_KEY,
      })
    ) {
      throw new AuthError(
        "Paystack webhook signature is invalid.",
        "PAYSTACK_SIGNATURE_INVALID",
      );
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new AuthError("Webhook body must be valid JSON.", "INVALID_JSON");
    }
    const result = applyPaystackWebhookEvent(runtime, event);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === "/api/billing/subscription" && request.method === "GET") {
    const context = authenticateFromRequest(request, runtime, {
      required: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.READ_BUSINESS_DATA,
    ).organizationId;
    sendJson(response, 200, {
      subscription: publicSubscription(
        ensureSubscription(runtime, organizationId),
      ),
    });
    return;
  }

  if (url.pathname === "/api/billing/history" && request.method === "GET") {
    const context = authenticateFromRequest(request, runtime, {
      required: true,
    });
    requireCapability(
      runtime,
      context,
      CAPABILITIES.MANAGE_ORGANIZATION,
    );
    sendJson(response, 200, { payments: [] });
    return;
  }

  if (url.pathname === "/api/billing/checkout" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.MANAGE_ORGANIZATION,
    ).organizationId;
    const publicUrl = (process.env.PUBLIC_APP_URL ?? `http://${request.headers.host}`).replace(/\/$/, "");
    const callbackUrl = `${publicUrl}/#/billing`;
    const plan = monthlyPlanFromEnv();
    const checkout = plan.providerConfigured
      ? await initializePaystackTransaction({
          customerEmail: context.user.email,
          organizationId,
          callbackUrl,
        })
      : localReviewCheckout({
          customerEmail: context.user.email,
          organizationId,
          callbackUrl,
        });
    runtime.checkoutSessions.set(checkout.reference, {
      reference: checkout.reference,
      provider: checkout.provider,
      organizationId,
      actorUserId: context.user.id,
      status: "pending",
      createdAt: new Date(),
      plan: checkout.plan,
    });
    const subscription = ensureSubscription(runtime, organizationId);
    subscription.status = "pending_checkout";
    subscription.checkoutReference = checkout.reference;
    subscription.updatedAt = new Date();
    runtime.auditLog.record({
      organizationId,
      actorUserId: context.user.id,
      eventType: "billing.checkout_started",
      targetType: "organization_subscription",
      targetId: subscription.id,
      metadata: { provider: checkout.provider, reference: checkout.reference },
    });
    sendJson(response, 200, {
      checkout: {
        provider: checkout.provider,
        reference: checkout.reference,
        authorizationUrl: checkout.authorizationUrl,
      },
      subscription: publicSubscription(subscription),
    });
    return;
  }

  if (url.pathname === "/api/billing/verify" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.MANAGE_ORGANIZATION,
    ).organizationId;
    const body = await readJson(request);
    const checkout = runtime.checkoutSessions.get(
      assertText(body.reference, "Billing reference is required."),
    );
    if (!checkout || checkout.organizationId !== organizationId)
      throw new AuthError("Billing checkout was not found.", "NOT_FOUND");
    if (checkout.provider !== "paystack")
      throw new AuthError(
        "This checkout must be completed from the local review billing page.",
        "VALIDATION_FAILED",
      );
    const verified = await verifyPaystackTransaction({
      reference: checkout.reference,
    });
    if (verified.status !== "success")
      throw new AuthError("Billing checkout is not complete.", "VALIDATION_FAILED");
    activateSubscription({ runtime, checkout, actorUserId: context.user.id });
    sendJson(response, 200, {
      subscription: publicSubscription(
        ensureSubscription(runtime, organizationId),
      ),
    });
    return;
  }

  if (url.pathname === "/api/billing/review-complete" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.MANAGE_ORGANIZATION,
    ).organizationId;
    const body = await readJson(request);
    const checkout = runtime.checkoutSessions.get(
      assertText(body.reference, "Billing reference is required."),
    );
    if (!checkout || checkout.organizationId !== organizationId)
      throw new AuthError("Billing checkout was not found.", "NOT_FOUND");
    if (checkout.provider !== "local_review")
      throw new AuthError("Use Paystack verification for this checkout.", "VALIDATION_FAILED");
    activateSubscription({ runtime, checkout, actorUserId: context.user.id });
    sendJson(response, 200, {
      subscription: publicSubscription(
        ensureSubscription(runtime, organizationId),
      ),
    });
    return;
  }

  if (url.pathname === "/api/onboarding/profile" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.WRITE_BUSINESS_DATA,
    ).organizationId;
    const body = await readJson(request);
    const existingProfile = [...runtime.store.businessProfiles.values()].find(
      (item) => item.organizationId === organizationId,
    );
    const hasUploads = [...runtime.uploads.values()].some(
      (item) => item.organizationId === organizationId,
    );
    if (hasUploads && existingProfile?.primaryCurrency !== body.primaryCurrency)
      throw new AuthError(
        "Reporting currency cannot change after data has been uploaded.",
        "VALIDATION_FAILED",
      );
    if (
      ![
        "USD",
        "GBP",
        "EUR",
        "NGN",
        "CAD",
        "AUD",
        "INR",
        "GHS",
        "KES",
        "ZAR",
      ].includes(body.primaryCurrency)
    )
      throw new AuthError(
        "Choose a supported reporting currency.",
        "VALIDATION_FAILED",
      );
    try {
      new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format();
    } catch {
      throw new AuthError("Enter a valid time zone.", "VALIDATION_FAILED");
    }
    runtime.onboarding.createOrUpdateProfile({
      organizationId,
      actorUserId: context.user.id,
      profile: body,
    });
    sendJson(response, 200, {
      saved: true,
      dashboard: buildDashboardState(runtime, context),
    });
    return;
  }

  if (url.pathname === "/api/ingestion/upload" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.WRITE_BUSINESS_DATA,
    ).organizationId;
    const body = await readJson(request);
    if (
      ![...runtime.store.businessProfiles.values()].some(
        (item) => item.organizationId === organizationId,
      )
    )
      throw new AuthError(
        "Complete your business profile before uploading data.",
        "VALIDATION_FAILED",
      );
    const payloads = Array.isArray(body.files)
      ? body.files.map((file) => ({
          ...body,
          ...file,
          files: undefined,
        }))
      : [body];
    if (payloads.length === 0 || payloads.length > 10)
      throw new AuthError(
        "Upload between 1 and 10 business files at a time.",
        "VALIDATION_FAILED",
      );
    const uploads = await Promise.all(
      payloads.map((payload) =>
        validateCustomerUploadFile(payload, organizationId),
      ),
    );
    const retainedBytes = [...runtime.uploads.values()]
      .filter((item) => item.organizationId === organizationId)
      .reduce((total, item) => total + (item.sourceSizeBytes ?? Buffer.byteLength(item.content)), 0);
    const incomingBytes = uploads.reduce(
      (total, item) => total + (item.sourceSizeBytes ?? Buffer.byteLength(item.content)),
      0,
    );
    if (retainedBytes + incomingBytes > 250 * 1024 * 1024)
      throw new AuthError(
        "This workspace has reached its current upload capacity.",
        "VALIDATION_FAILED",
      );
    for (const upload of uploads) {
      runtime.uploads.set(upload.id, upload);
      runtime.auditLog.record({
        organizationId,
        actorUserId: context.user.id,
        eventType: "ingestion.validated",
        targetType: "upload",
        targetId: upload.id,
        metadata: { fileName: upload.fileName, rowCount: upload.rowCount },
      });
    }
    sendJson(response, 200, {
      upload: publicUpload(uploads[0]),
      uploads: uploads.map(publicUpload),
    });
    return;
  }

  if (url.pathname === "/api/ingestion/confirm" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, {
      requireCsrf: true,
    });
    const organizationId = requireCapability(
      runtime,
      context,
      CAPABILITIES.WRITE_BUSINESS_DATA,
    ).organizationId;
    const body = await readJson(request);
    const upload = runtime.uploads.get(body.uploadId);
    if (!upload || upload.organizationId !== organizationId)
      throw new AuthError("Upload not found.", "NOT_FOUND");
    if (upload.issues.length)
      throw new AuthError(
        "Resolve the validation errors before importing.",
        "VALIDATION_FAILED",
      );
    const baseline = [...runtime.uploads.values()].find(
      (item) =>
        item.organizationId === upload.organizationId &&
        item.seriesKey === upload.seriesKey &&
        item.status === "confirmed",
    );
    if (
      baseline &&
      (baseline.metricColumn !== upload.metricColumn ||
        JSON.stringify([...baseline.columns].sort()) !==
          JSON.stringify([...upload.columns].sort()))
    )
      throw new AuthError(
        "The columns or metric mapping differ from this data series baseline. Use the same schema for recurring periods or create a separate data series.",
        "VALIDATION_FAILED",
      );
    const existing = [...runtime.uploads.values()].find(
      (item) =>
        item.id !== upload.id &&
        item.organizationId === upload.organizationId &&
        item.seriesKey === upload.seriesKey &&
        item.period === upload.period &&
        item.status === "confirmed",
    );
    if (existing)
      throw new AuthError(
        "This reporting month already has confirmed data. Choose another month.",
        "VALIDATION_FAILED",
      );
    if (upload.status !== "confirmed") {
      upload.status = "confirmed";
      upload.confirmedAt = new Date();
      runtime.auditLog.record({
        organizationId: upload.organizationId,
        actorUserId: context.user.id,
        eventType: "ingestion.confirmed",
        targetType: "upload",
        targetId: upload.id,
      });
    }
    sendJson(response, 200, { upload: publicUpload(upload) });
    return;
  }

  if (url.pathname === "/api/evidence-report" && request.method === "GET") {
    const context = authenticateFromRequest(request, runtime);
    const { organizationId } = requireCapability(runtime, context, CAPABILITIES.READ_BUSINESS_DATA);
    const sources = reportSourcesFromUploads([...runtime.uploads.values()].filter((u) => u.organizationId === organizationId));
    const profile = [...runtime.store.businessProfiles.values()].find((p) => p.organizationId === organizationId);
    const policies = runtime.reportPolicies.filter((p) => p.organizationId === organizationId);
    const report = buildBusinessReport({ sources, profile, policies, options: Object.fromEntries(url.searchParams) });
    if (url.searchParams.has("format")) await sendEvidenceExport(response, report, url.searchParams.get("format"));
    else sendJson(response, 200, { report });
    return;
  }

  if (url.pathname === "/api/evidence-report/definition" && request.method === "POST") {
    const context = authenticateFromRequest(request, runtime, { requireCsrf: true });
    const { organizationId } = requireCapability(runtime, context, CAPABILITIES.WRITE_BUSINESS_DATA);
    const body = await readJson(request);
    const sources = reportSourcesFromUploads([...runtime.uploads.values()].filter((u) => u.organizationId === organizationId));
    const source = sources.find((s) => s.id === body.source);
    if (!source || !source.cube.metrics.some((m) => m.column === body.metric)) throw new AuthError("Report source not found.", "NOT_FOUND");
    const definition = validateReportPolicy(body);
    const profile = [...runtime.store.businessProfiles.values()].find((p) => p.organizationId === organizationId);
    validateRevenueMappingSource(source, body.metric, definition, profile?.primaryCurrency || "USD");
    const previous = runtime.reportPolicies.filter((p) => p.organizationId === organizationId && p.seriesKey === source.seriesKey && p.column === body.metric).at(-1);
    if (Number(body.expectedVersion ?? 0) !== (previous?.version ?? 0)) throw new AuthError("This definition changed. Refresh the report before saving again.", "VALIDATION_FAILED");
    const policy = { ...definition, organizationId, seriesKey: source.seriesKey, column: body.metric,
      version: (previous?.version ?? 0) + 1, approvedAt: new Date(), approvedByUserId: context.user.id };
    runtime.reportPolicies.push(policy);
    runtime.auditLog.record({ organizationId, actorUserId: context.user.id, eventType: "report.definition_approved", targetType: "report_metric", targetId: source.id, metadata: { column: body.metric, version: policy.version } });
    sendJson(response, 200, { policy });
    return;
  }

  if (url.pathname.startsWith("/api/"))
    throw new AuthError("Endpoint not found.", "NOT_FOUND");
  serveStatic(url, response);
}

function buildDashboardState(runtime, context) {
  const shell = appShellState({
    user: context.user,
    session: context.session,
    store: runtime.store,
  });
  const uploads = [...runtime.uploads.values()].filter(
    (item) => item.organizationId === context.session.activeOrganizationId,
  );
  const profile =
    [...runtime.store.businessProfiles.values()].find(
      (item) => item.organizationId === context.session.activeOrganizationId,
    ) ?? null;
  const uploadsWithCurrency = uploads.map((upload) => ({
    ...upload,
    primaryCurrency: profile?.primaryCurrency ?? "USD",
  }));
  const confirmedWithCurrency = uploadsWithCurrency
    .filter((item) => item.status === "confirmed")
    .sort((a, b) =>
      `${a.seriesKey}:${a.period}`.localeCompare(`${b.seriesKey}:${b.period}`),
    );
  const seriesGroups = buildSeriesGroups(confirmedWithCurrency);
  const activeGroup = chooseActiveSeriesGroup(seriesGroups);
  const subscription = context.session.activeOrganizationId
    ? ensureSubscription(runtime, context.session.activeOrganizationId)
    : null;
  return {
    shell,
    profile,
    subscription: subscription ? publicSubscription(subscription) : null,
    uploads: uploadsWithCurrency.map(publicUpload),
    series: activeGroup?.points ?? [],
    seriesGroups,
    evidenceReports: buildEvidenceReports(confirmedWithCurrency, profile),
    kpis: [],
    auditTrail: canReadAudit(runtime, context)
      ? runtime.store.auditEvents
          .filter(
            (event) =>
              event.organizationId === context.session.activeOrganizationId,
          )
          .map(presentAuditEvent)
          .filter(Boolean)
          .slice(-8)
      : [],
  };
}

function buildSeriesGroups(uploads) {
  const groups = new Map();
  for (const upload of uploads) {
    const group = groups.get(upload.seriesKey) ?? {
      key: upload.seriesKey,
      name: upload.dataSeries,
      dataKind: upload.dataKind,
      metricLabel: upload.metricLabel,
      metricType: upload.metricType,
      metricColumn: upload.metricColumn,
      points: [],
    };
    group.points.push({
      period: upload.period,
      metricLabel: upload.metricLabel,
      metricColumn: upload.metricColumn,
      metricType: upload.metricType,
      metricCents: upload.metricCents,
      metricValue: upload.metricValue,
      revenueCents: upload.revenueCents,
      rowCount: upload.rowCount,
      fileName: upload.fileName,
      dataKind: upload.dataKind,
      dataSeries: upload.dataSeries,
      sourceFormat: upload.sourceFormat,
      fileExtension: upload.fileExtension,
    });
    groups.set(upload.seriesKey, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    points: group.points.sort((a, b) => a.period.localeCompare(b.period)),
  }));
}

function chooseActiveSeriesGroup(groups) {
  return [...groups].sort((a, b) => {
    const aLatest = a.points.at(-1)?.period ?? "";
    const bLatest = b.points.at(-1)?.period ?? "";
    return bLatest.localeCompare(aLatest) || a.name.localeCompare(b.name);
  })[0];
}

function ensureSubscription(runtime, organizationId) {
  const existing = runtime.subscriptions.get(organizationId);
  if (existing) return existing;
  const plan = monthlyPlanFromEnv();
  const subscription = {
    id: `sub_${organizationId}`,
    organizationId,
    status: "trialing",
    planId: plan.id,
    planName: plan.name,
    currency: plan.currency,
    amountMinor: plan.amountMinor,
    interval: plan.interval,
    provider: "paystack",
    providerConfigured: plan.providerConfigured,
    checkoutReference: null,
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    activeAt: null,
    currentPeriodEnd: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  runtime.subscriptions.set(organizationId, subscription);
  return subscription;
}

function publicSubscription(subscription) {
  const plan = {
    currency: subscription.currency,
    amountMinor: subscription.amountMinor,
  };
  return {
    id: subscription.id,
    status: subscription.status,
    planId: subscription.planId,
    planName: subscription.planName,
    priceLabel: `${planLabel(plan)}/mo`,
    currency: subscription.currency,
    amountMinor: subscription.amountMinor,
    interval: subscription.interval,
    provider: subscription.provider,
    providerConfigured: subscription.providerConfigured,
    checkoutReference: subscription.checkoutReference,
    trialEndsAt: subscription.trialEndsAt,
    activeAt: subscription.activeAt,
    currentPeriodEnd: subscription.currentPeriodEnd,
    nextStep: subscriptionNextStep(subscription),
  };
}

function subscriptionNextStep(subscription) {
  if (subscription.status === "active") return "Subscription active";
  if (subscription.status === "pending_checkout")
    return "Complete checkout to activate billing";
  if (subscription.status === "trialing")
    return "Activate the $20 monthly plan before public launch";
  return "Review billing status";
}

function activateSubscription({ runtime, checkout, actorUserId }) {
  if (checkout.status === "completed") return checkout;
  const subscription = ensureSubscription(runtime, checkout.organizationId);
  const now = new Date();
  subscription.status = "active";
  subscription.provider = checkout.provider === "local_review" ? "local_review" : "paystack";
  subscription.checkoutReference = checkout.reference;
  subscription.activeAt = now;
  subscription.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  subscription.updatedAt = now;
  checkout.status = "completed";
  checkout.completedAt = now;
  runtime.auditLog.record({
    organizationId: checkout.organizationId,
    actorUserId,
    eventType: "billing.subscription_activated",
    targetType: "organization_subscription",
    targetId: subscription.id,
    metadata: { provider: checkout.provider, reference: checkout.reference },
  });
  return checkout;
}

function applyPaystackWebhookEvent(runtime, event) {
  const eventName = assertText(event?.event, "Webhook event is required.");
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const reference = data.reference ?? data.transaction?.reference ?? null;
  const organizationId =
    data.metadata?.organization_id ??
    data.metadata?.organizationId ??
    lookupOrganizationIdForReference(runtime, reference);
  const eventKey = `${eventName}:${data.id ?? reference ?? JSON.stringify(data).slice(0, 120)}`;
  if (runtime.paystackWebhookEvents.has(eventKey)) {
    return { received: true, duplicate: true };
  }
  runtime.paystackWebhookEvents.set(eventKey, {
    event: eventName,
    reference,
    organizationId: organizationId ?? null,
    receivedAt: new Date(),
  });
  if (eventName === "charge.success" && data.status === "success") {
    const checkout = checkoutForWebhook({
      runtime,
      reference,
      organizationId,
    });
    activateSubscription({ runtime, checkout, actorUserId: null });
    return { received: true, action: "subscription_activated" };
  }
  if (eventName === "invoice.update" && data.paid === true) {
    const checkout = checkoutForWebhook({
      runtime,
      reference,
      organizationId,
    });
    activateSubscription({ runtime, checkout, actorUserId: null });
    return { received: true, action: "subscription_renewed" };
  }
  if (eventName === "invoice.payment_failed") {
    updateSubscriptionFromWebhook({
      runtime,
      organizationId,
      status: "past_due",
      eventType: "billing.payment_failed",
      reference,
    });
    return { received: true, action: "subscription_past_due" };
  }
  if (["subscription.disable", "subscription.not_renew"].includes(eventName)) {
    updateSubscriptionFromWebhook({
      runtime,
      organizationId,
      status: eventName === "subscription.disable" ? "canceled" : "non_renewing",
      eventType:
        eventName === "subscription.disable"
          ? "billing.subscription_canceled"
          : "billing.subscription_non_renewing",
      reference,
    });
    return { received: true, action: "subscription_status_updated" };
  }
  return { received: true, action: "ignored" };
}

function checkoutForWebhook({ runtime, reference, organizationId }) {
  if (reference && runtime.checkoutSessions.has(reference)) {
    const checkout = runtime.checkoutSessions.get(reference);
    checkout.provider = "paystack";
    return checkout;
  }
  if (!organizationId)
    throw new AuthError(
      "Webhook event does not include an organization reference.",
      "VALIDATION_FAILED",
    );
  const checkout = {
    reference: reference ?? `paystack_${Date.now()}`,
    provider: "paystack",
    organizationId,
    actorUserId: null,
    status: "pending",
    createdAt: new Date(),
    plan: monthlyPlanFromEnv(),
  };
  runtime.checkoutSessions.set(checkout.reference, checkout);
  return checkout;
}

function updateSubscriptionFromWebhook({
  runtime,
  organizationId,
  status,
  eventType,
  reference,
}) {
  if (!organizationId)
    throw new AuthError(
      "Webhook event does not include an organization reference.",
      "VALIDATION_FAILED",
    );
  const subscription = ensureSubscription(runtime, organizationId);
  subscription.status = status;
  subscription.provider = "paystack";
  subscription.checkoutReference = reference ?? subscription.checkoutReference;
  subscription.updatedAt = new Date();
  runtime.auditLog.record({
    organizationId,
    actorUserId: null,
    eventType,
    targetType: "organization_subscription",
    targetId: subscription.id,
    metadata: { provider: "paystack", reference },
  });
  return subscription;
}

function lookupOrganizationIdForReference(runtime, reference) {
  if (!reference) return null;
  return runtime.checkoutSessions.get(reference)?.organizationId ?? null;
}

function presentAuditEvent(event) {
  const map = {
    "organization.created": ["Business workspace created", "Organization"],
    "business_profile.created": ["Business profile created", "Business profile"],
    "business_profile.updated": ["Business profile updated", "Business profile"],
    "business_model_entry.created": ["Business model entry added", "Business model"],
    "business_fact.created": ["Business fact captured", "Business fact"],
    "business_term.created": ["Business term added", "Business term"],
    "business_goal.created": ["Business goal added", "Business goal"],
    "kpi_definition.created": ["KPI definition added", "KPI definition"],
    "business_onboarding.completed": ["Business onboarding completed", "Business profile"],
    "ingestion.validated": ["Data file validated", event.metadata?.fileName ?? "Upload"],
    "ingestion.confirmed": ["Data file confirmed", "Upload"],
    "billing.checkout_started": ["Billing checkout started", "Subscription"],
    "billing.subscription_activated": ["Subscription activated", "Subscription"],
    "billing.subscription_canceled": ["Subscription canceled", "Subscription"],
    "billing.subscription_non_renewing": ["Subscription set non-renewing", "Subscription"],
    "billing.payment_failed": ["Subscription payment failed", "Subscription"],
    "invitation.created": ["Member invitation sent", "Invitation"],
    "invitation.accepted": ["Member invitation accepted", "Invitation"],
    "membership.created": ["Member added", "Membership"],
    "membership.disabled": ["Member disabled", "Membership"],
  };
  const match = map[event.eventType];
  if (!match) return null;
  return {
    label: match[0],
    detail: match[1],
    eventType: event.eventType,
    targetType: event.targetType,
    createdAt: event.createdAt,
  };
}

function authenticateFromRequest(request, runtime, options = {}) {
  const token =
    parseCookies(request.headers.cookie ?? "").bnx_session;

  if (!token && options.required === false) {
    return null;
  }

  const csrfToken =
    request.headers["x-csrf-token"];

  const context =
    runtime.sessions.authenticate({
      token,
      csrfToken,
      requireCsrf:
        options.requireCsrf === true,
    });

  if (options.requirePolicy !== false) {
    const policy =
      runtime.identity.policyStatus(
        context.user.id,
      );

    if (policy.required) {
      throw new AuthError(
        "Accept the current BIZNORYX account and data terms before using the workspace.",
        "POLICY_ACCEPTANCE_REQUIRED",
      );
    }
  }

  return {
    ...context,
    csrfToken: readSessionCsrf(
      runtime,
      context.session,
    ),
  };
}

function requireCapability(runtime, context, capability) {
  const organizationId = context.session.activeOrganizationId;
  const authorization = new AuthorizationService(
    runtime.store,
  ).requireCapability({
    userId: context.user.id,
    organizationId,
    capability,
  });
  return { ...authorization, organizationId };
}

function readSessionCsrf(runtime, session) {
  return session.csrfTokenForResponse ?? null;
}

function canReadAudit(runtime, context) {
  try {
    requireCapability(runtime, context, CAPABILITIES.READ_AUDIT_LOG);
    return true;
  } catch (error) {
    if (error instanceof AuthError) return false;
    throw error;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 110 * 1024 * 1024)
      throw new AuthError("The request is too large.", "VALIDATION_FAILED");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Object required.");
    return value;
  } catch {
    throw new AuthError("Request body must be valid JSON.", "INVALID_JSON");
  }
}

async function readRawBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes)
      throw new AuthError("The request is too large.", "VALIDATION_FAILED");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  if (error instanceof AuthError) {
    const status =
      new Map([
        ["INVALID_CREDENTIALS", 401],
        ["USER_DISABLED", 401],
        ["MEMBERSHIP_DISABLED", 401],
        ["EMAIL_VERIFICATION_REQUIRED", 403],
        ["POLICY_ACCEPTANCE_REQUIRED", 403],
        ["RATE_LIMITED", 429],
        ["SESSION_INVALID", 401],
        ["CSRF_INVALID", 403],
        ["CAPABILITY_DENIED", 403],
        ["ORG_ACCESS_DENIED", 404],
        ["NOT_FOUND", 404],
        ["BILLING_PROVIDER_NOT_CONFIGURED", 503],
        ["BILLING_PROVIDER_FAILED", 502],
        ["PAYSTACK_SIGNATURE_INVALID", 401],
      ]).get(error.code) ?? 400;
    sendJson(response, status, { error: error.code, message: error.message });
    return;
  }
  sendJson(response, 500, {
    error: "INTERNAL_SERVER_ERROR",
    message: "The request could not be completed.",
  });
}

function serveStatic(url, response) {
  if (url.pathname === "/vendor/lucide.js") {
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
    });
    response.end(
      readFileSync(
        join(process.cwd(), "node_modules/lucide/dist/umd/lucide.min.js"),
      ),
    );
    return;
  }
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const body = readFileSync(filePath);
    response.writeHead(200, {
      "Content-Type":
        contentTypes.get(extname(filePath)) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key, value.join("=")];
      }),
  );
}

function clearSessionCookie() {
  return secureSessionCookie("", process.env.NODE_ENV === "production").replace(
    /Max-Age=\d+/,
    "Max-Age=0",
  );
}

function assertText(value, message) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 254)
    throw new AuthError(message, "VALIDATION_FAILED");
  return text;
}

function validateCredentials(body) {
  if (
    typeof body.email !== "string" ||
    body.email.length > 254 ||
    typeof body.password !== "string" ||
    body.password.length > 128 ||
    !body.password
  )
    throw new AuthError(
      "Enter an email address and password.",
      "VALIDATION_FAILED",
    );
}

function slugify(name) {
  return assertText(name, "Organization name is required.")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
