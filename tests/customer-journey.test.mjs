import test from "node:test";
import assert from "node:assert/strict";
import { createReviewApp } from "../src/webapp/review-app.mjs";
import {
  buildEvidenceReports,
  validateCustomerUpload,
} from "../src/webapp/customer-data.mjs";
import {
  monthlyPlanFromEnv,
  paystackWebhookSignature,
} from "../src/billing/paystack.mjs";

function assertEvidenceBackedFocusAreas(report) {
  assert.ok(
    report.focusAreas.length > 0,
    "Expected at least one evidence-backed focus area.",
  );

  const validClassifications = new Set([
    "VERIFIED FACT",
    "INFERENCE",
    "STATISTICAL SIGNAL",
    "RECOMMENDATION",
  ]);

  for (const item of report.focusAreas) {
    assert.ok(
      validClassifications.has(item.classification),
      `Unexpected focus-area classification: ${item.classification}`,
    );

    assert.equal(typeof item.label, "string");
    assert.ok(item.label.trim().length > 0);

    assert.equal(typeof item.value, "string");
    assert.ok(item.value.trim().length > 0);

    assert.equal(typeof item.evidence, "string");
    assert.ok(item.evidence.trim().length > 0);
  }
}

test("new customer registers, creates business, validates and confirms recurring data without fabricated metrics", async () => {
  const { server } = createReviewApp();

  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );

  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie;
  let csrf;

  async function call(path, body, expected = 200) {
    const response = await fetch(`${base}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.headers.get("set-cookie")) {
      cookie = response.headers.get("set-cookie");
    }

    const result = await response.json();

    assert.equal(
      response.status,
      expected,
      JSON.stringify(result),
    );

    return result;
  }

  try {
    const registration = await call(
      "register",
      {
        displayName: "Owner",
        email: "journey@example.com",
        password: "StrongCustomerPassword!",
      },
      201,
    );

    assert.equal(
      registration.requiresEmailVerification,
      true,
    );

    assert.match(registration.reviewCode, /^\d{8}$/);

    const verified = await call("auth/verify-email", {
      email: "journey@example.com",
      code: registration.reviewCode,
    });

    csrf = verified.csrfToken;

    assert.equal(verified.shell.state, "empty");

    await call(
      "organizations",
      {
        name: "Journey Business",
      },
      201,
    );

    const checkout = await call("billing/checkout", {});

    assert.equal(
      checkout.checkout.provider,
      "local_review",
    );

    const completedBilling = await call(
      "billing/review-complete",
      {
        reference: checkout.checkout.reference,
      },
    );

    assert.equal(
      completedBilling.subscription.status,
      "active",
    );

    await call("onboarding/profile", {
      legalName: "Journey Business",
      industry: "Retail",
      businessModel: "Online sales",
      primaryCurrency: "USD",
      fiscalYearStartMonth: 1,
      timezone: "UTC",
    });

    assert.deepEqual(
      (await call("dashboard")).series,
      [],
    );

    const upload = (
      await call("ingestion/upload", {
        fileName: "sales.csv",
        period: "2026-01",
        content:
          'product,revenue\n"A, quoted",10.10\nB,20.20\n',
      })
    ).upload;

    assert.equal(upload.revenueCents, "3030");
    assert.equal(upload.rowCount, 2);
    assert.equal(upload.content, undefined);

    assert.deepEqual(
      (await call("dashboard")).series,
      [],
    );

    await call("ingestion/confirm", {
      uploadId: upload.id,
    });

    await call("ingestion/confirm", {
      uploadId: upload.id,
    });

    assert.equal(
      (await call("dashboard")).series.length,
      1,
    );

    await call(
      "onboarding/profile",
      {
        legalName: "Journey Business",
        industry: "Retail",
        businessModel: "Online sales",
        primaryCurrency: "EUR",
        fiscalYearStartMonth: 1,
        timezone: "UTC",
      },
      400,
    );

    const changedMapping = (
      await call("ingestion/upload", {
        fileName: "drift.csv",
        period: "2026-03",
        content: "amount\n50.00",
        revenueColumn: "amount",
      })
    ).upload;

    await call(
      "ingestion/confirm",
      {
        uploadId: changedMapping.id,
      },
      400,
    );

    const invalid = (
      await call("ingestion/upload", {
        fileName: "bad.csv",
        period: "2026-02",
        content: "revenue\ninvalid\n",
      })
    ).upload;

    assert.equal(invalid.status, "rejected");

    await call(
      "ingestion/confirm",
      {
        uploadId: invalid.id,
      },
      400,
    );

    const next = (
      await call("ingestion/upload", {
        fileName: "next.csv",
        period: "2026-02",
        content:
          "product,revenue\nA,15.00\nC,25.00\n",
      })
    ).upload;

    await call("ingestion/confirm", {
      uploadId: next.id,
    });

    const dashboard = await call("dashboard");

    assert.deepEqual(
      dashboard.series.map((series) => series.revenueCents),
      ["3030", "4000"],
    );

    assert.equal(
      dashboard.evidenceReports.length,
      2,
    );

    assert.equal(
      dashboard.subscription.status,
      "active",
    );

    assert.match(
      dashboard.evidenceReports.at(-1).summary,
      /Revenue moved \+32.0%/,
    );

    assertEvidenceBackedFocusAreas(
      dashboard.evidenceReports.at(-1),
    );

    assert.ok(
      dashboard.evidenceReports.at(-1).driverFacts.length >
        0,
    );

    assert.equal(
      dashboard.evidenceReports.at(-1).sourceEvidence
        .calculation,
      "sum(revenue)",
    );

    const duplicate = (
      await call("ingestion/upload", {
        fileName: "duplicate.csv",
        period: "2026-02",
        content:
          "product,revenue\nA,15.00\nC,25.00\n",
      })
    ).upload;

    await call(
      "ingestion/confirm",
      {
        uploadId: duplicate.id,
      },
      400,
    );

    await call(
      "organizations",
      {
        name: "Separate Business",
      },
      201,
    );

    assert.deepEqual(
      (await call("dashboard")).series,
      [],
    );

    await call(
      "ingestion/confirm",
      {
        uploadId: upload.id,
      },
      404,
    );
  } finally {
    await new Promise((resolve) =>
      server.close(resolve),
    );
  }
});

test("generic transaction datasets create evidence reports without sales-specific fields", () => {
  const first = validateCustomerUpload(
    {
      fileName: "transactions.csv",
      period: "2026-01",
      dataSeries: "Transaction history",
      dataKind: "Transaction history",
      content:
        "transaction_id,channel,amount,transaction_date\n1001,Online,125.50,2026-01-01\n1002,Store,74.50,2026-01-02\n",
    },
    "org",
  );

  const second = validateCustomerUpload(
    {
      fileName: "transactions-feb.csv",
      period: "2026-02",
      dataSeries: "Transaction history",
      dataKind: "Transaction history",
      content:
        "transaction_id,channel,amount,transaction_date\n1003,Online,200.00,2026-02-01\n1004,Online,100.00,2026-02-02\n",
    },
    "org",
  );

  first.status = "confirmed";
  second.status = "confirmed";

  assert.equal(first.metricColumn, "amount");
  assert.equal(first.metricLabel, "Amount");
  assert.equal(first.revenueCents, "20000");
  assert.equal(
    first.dataKind,
    "Transaction history",
  );

  const reports = validateReports([
    first,
    second,
  ]);

  assert.equal(reports.length, 2);

  assert.match(
    reports[1].summary,
    /Amount moved \+50.0%/,
  );

  assert.match(
    reports[1].analystBrief.headline,
    /Amount increased/,
  );

  assert.match(
    reports[1].analystBrief.caution,
    /not causation/i,
  );

  assert.equal(
    reports[1].evidenceQuality.level,
    "high_evidence",
  );

  assert.ok(
    Array.isArray(reports[1].limitations),
  );

  assert.equal(
    reports[1].sourceEvidence.calculation,
    "sum(amount)",
  );

  assertEvidenceBackedFocusAreas(
    reports[1],
  );

  assert.ok(
    reports[1].driverFacts.length > 0,
  );
});

test("default upload series follows selected data type so unrelated schemas do not collide", () => {
  const sales = validateCustomerUpload(
    {
      fileName: "sales.csv",
      period: "2026-01",
      dataSeries: "Primary performance",
      dataKind: "Sales performance",
      content:
        "product,revenue,date\nA,125.50,2026-01-01\n",
    },
    "org",
  );

  const transactions = validateCustomerUpload(
    {
      fileName: "transactions.csv",
      period: "2026-01",
      dataSeries: "Primary performance",
      dataKind: "Transaction history",
      content:
        "transaction_id,channel,amount,transaction_date\n1001,Online,125.50,2026-01-01\n",
    },
    "org",
  );

  assert.equal(
    sales.dataSeries,
    "Primary performance",
  );

  assert.equal(
    transactions.dataSeries,
    "Transaction history",
  );

  assert.notEqual(
    sales.seriesKey,
    transactions.seriesKey,
  );

  assert.equal(
    transactions.status,
    "awaiting_confirmation",
  );
});

test("batch uploads validate multiple files and preserve individual review records", async () => {
  const { server } = createReviewApp();

  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );

  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie;
  let csrf;

  async function call(path, body, expected = 200) {
    const response = await fetch(`${base}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(csrf
          ? { "X-CSRF-Token": csrf }
          : {}),
      },
      body: body
        ? JSON.stringify(body)
        : undefined,
    });

    if (response.headers.get("set-cookie")) {
      cookie =
        response.headers.get("set-cookie");
    }

    const result = await response.json();

    assert.equal(
      response.status,
      expected,
      JSON.stringify(result),
    );

    return result;
  }

  try {
    const signedIn = await call("sign-in", {
      email: "owner@biznoryx.local",
      password: "ReviewPassphrase2026!",
    });

    csrf = signedIn.csrfToken;

    const batch = await call(
      "ingestion/upload",
      {
        period: "2026-04",
        dataSeries: "Store performance",
        dataKind: "Sales performance",
        files: [
          {
            fileName: "store-a.csv",
            content:
              "product,revenue\nA,10.00\n",
          },
          {
            fileName: "store-b.csv",
            content:
              "product,revenue\nB,15.00\n",
          },
        ],
      },
    );

    assert.equal(batch.uploads.length, 2);

    assert.deepEqual(
      batch.uploads.map(
        (upload) => upload.fileName,
      ),
      ["store-a.csv", "store-b.csv"],
    );

    assert.equal(
      (await call("dashboard")).uploads
        .length,
      2,
    );
  } finally {
    await new Promise((resolve) =>
      server.close(resolve),
    );
  }
});

test("Paystack webhooks require a valid signature and update subscription state idempotently", async () => {
  const previousSecret =
    process.env.PAYSTACK_SECRET_KEY;

  process.env.PAYSTACK_SECRET_KEY =
    "sk_test_webhook_secret";

  const app = createReviewApp();

  const organizationId =
    app.runtime.seededOrganizations[0];

  app.runtime.checkoutSessions.set(
    "ps_ref_001",
    {
      reference: "ps_ref_001",
      provider: "paystack",
      organizationId,
      actorUserId: null,
      status: "pending",
      createdAt: new Date(),
      plan: monthlyPlanFromEnv(),
    },
  );

  await new Promise((resolve) =>
    app.server.listen(
      0,
      "127.0.0.1",
      resolve,
    ),
  );

  const base = `http://127.0.0.1:${app.server.address().port}`;

  const payload = Buffer.from(
    JSON.stringify({
      event: "charge.success",
      data: {
        id: 12345,
        status: "success",
        reference: "ps_ref_001",
        metadata: {
          organization_id:
            organizationId,
        },
      },
    }),
  );

  try {
    const rejected = await fetch(
      `${base}/api/billing/paystack/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          "x-paystack-signature":
            "bad-signature",
        },
        body: payload,
      },
    );

    assert.equal(rejected.status, 401);

    assert.equal(
      app.runtime.subscriptions.get(
        organizationId,
      )?.status,
      undefined,
    );

    const signature =
      paystackWebhookSignature({
        payload,
        secret:
          process.env
            .PAYSTACK_SECRET_KEY,
      });

    const accepted = await fetch(
      `${base}/api/billing/paystack/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          "x-paystack-signature":
            signature,
        },
        body: payload,
      },
    );

    assert.equal(accepted.status, 200);

    assert.equal(
      app.runtime.subscriptions.get(
        organizationId,
      ).status,
      "active",
    );

    const duplicate = await fetch(
      `${base}/api/billing/paystack/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          "x-paystack-signature":
            signature,
        },
        body: payload,
      },
    );

    assert.equal(
      duplicate.status,
      200,
    );

    assert.equal(
      (await duplicate.json()).duplicate,
      true,
    );
  } finally {
    process.env.PAYSTACK_SECRET_KEY =
      previousSecret;

    await new Promise((resolve) =>
      app.server.close(resolve),
    );
  }
});

test("authentication rejects cross-origin mutations and throttles repeated attempts", async () => {
  const { server } = createReviewApp();

  await new Promise((resolve) =>
    server.listen(
      0,
      "127.0.0.1",
      resolve,
    ),
  );

  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const crossOrigin = await fetch(
      `${base}/api/register`,
      {
        method: "POST",
        headers: {
          origin:
            "https://untrusted.example",
          "content-type":
            "application/json",
        },
        body: "{}",
      },
    );

    assert.equal(
      crossOrigin.status,
      403,
    );

    let status;

    for (
      let attempt = 0;
      attempt < 16;
      attempt += 1
    ) {
      status = (
        await fetch(
          `${base}/api/sign-in`,
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json",
            },
            body: JSON.stringify({
              email:
                "missing@example.com",
              password:
                "IncorrectPassword!",
            }),
          },
        )
      ).status;
    }

    assert.equal(status, 429);

    const resendCode = await fetch(
      `${base}/api/auth/resend-code`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "missing@example.com",
        }),
      },
    );

    assert.equal(resendCode.status, 200);
  } finally {
    await new Promise((resolve) =>
      server.close(resolve),
    );
  }
});

test("CSV validation handles BOM, decimal cents and rejects malformed or ambiguous inputs", () => {
  const body = {
    fileName: "sales.csv",
    period: "2026-01",
    content:
      "\ufeffrevenue\n0.10\n0.20\n-0.05\n",
  };

  assert.equal(
    validateCustomerUpload(body, "org")
      .revenueCents,
    "25",
  );

  for (const content of [
    "revenue,revenue\n1,2",
    'revenue\n"unterminated',
    "revenue\n",
    "",
  ]) {
    assert.throws(() =>
      validateCustomerUpload(
        {
          ...body,
          content,
        },
        "org",
      ),
    );
  }

  assert.equal(
    validateCustomerUpload(
      {
        ...body,
        content:
          "revenue\n1.001",
      },
      "org",
    ).status,
    "rejected",
  );

  assert.throws(() =>
    validateCustomerUpload(
      {
        ...body,
        period: "2026-13",
      },
      "org",
    ),
  );
});

function validateReports(uploads) {
  return buildEvidenceReports(uploads, {
    legalName: "Journey Business",
  });
}
