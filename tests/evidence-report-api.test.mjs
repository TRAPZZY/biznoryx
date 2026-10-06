import assert from "node:assert/strict";
import test from "node:test";
import { createReviewApp } from "../src/webapp/review-app.mjs";

test("review evidence report explains dated trends, accepts governed definitions and exports safely", async () => {
  const { server } = createReviewApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  let csrf;

  async function call(path, body, expected = 200, headers = {}) {
    const response = await fetch(`${base}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie");
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }

  async function download(format, expectedType) {
    const response = await fetch(`${base}/api/evidence-report?format=${format}`, { headers: { cookie } });
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    assert.match(response.headers.get("content-type"), expectedType);
    return format === "pdf" ? Buffer.from(await response.arrayBuffer()) : await response.text();
  }

  try {
    const signedIn = await call("sign-in", {
      email: "owner@biznoryx.local",
      password: "ReviewPassphrase2026!",
    });
    csrf = signedIn.csrfToken;

    const upload = (await call("ingestion/upload", {
      fileName: "evidence-trend.csv",
      period: "2026-03",
      dataSeries: "Monthly sales",
      dataKind: "Sales performance",
      content: [
        "order_date,year,product_category,sales_channel,net_sales,profit_margin_percent,quantity",
        "2026-01-01,2026,Core,Online,40.00,40,4",
        "2026-01-31,2026,Core,Online,60.00,39,6",
        "2026-02-01,2026,Core,Online,100.00,41,10",
        "2026-02-28,2026,Expansion,Partner,60.00,35,3",
        "2026-03-01,2026,Core,Online,145.00,42,10",
        "2026-03-31,2026,=FormulaLookalike,Partner,45.00,38,3",
      ].join("\n"),
    })).upload;

    await call("ingestion/confirm", { uploadId: upload.id });

    const initial = (await call("evidence-report")).report;
    assert.deepEqual(initial.timeline.map((point) => point.period), ["2026-01", "2026-02", "2026-03"]);
    assert.equal(initial.current.value, "190");
    assert.equal(initial.previous.value, "160");
    assert.equal(initial.comparison.absoluteChange, "30");
    assert.equal(initial.drivers.reconciled, true);
    assert.ok(initial.drivers.entries.some((entry) => entry.name === "=FormulaLookalike"));
    assert.ok(!initial.controls.metrics.some((metric) => /year|percent/i.test(metric.column)));
    assert.ok(initial.limitations.some((item) => item.code === "MAPPING_UNCONFIRMED"));
    assert.equal(initial.health, "insufficient_evidence");

    const rejected = await fetch(`${base}/api/evidence-report/definition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        source: initial.sourceId,
        metric: initial.metric.column,
        label: "Net sales",
        unit: "currency",
        polarity: "higher",
        materialityPercent: 5,
        expectedVersion: 0,
      }),
    });
    assert.equal(rejected.status, 403);

    const definition = await call("evidence-report/definition", {
      source: initial.sourceId,
      metric: initial.metric.column,
      label: "Net sales",
      unit: "currency",
      polarity: "higher",
      materialityPercent: 5,
      expectedVersion: 0,
      revenueBreakdown: { productColumn: "product_category", quantityColumn: "quantity", quantityUnit: "items", currency: "USD", confirmed: true },
    });
    assert.equal(definition.policy.version, 1);
    assert.equal(definition.policy.revenueBreakdown.quantityColumn, "quantity");
    await call("evidence-report/definition", {
      source: initial.sourceId, metric: initial.metric.column, label: "Net sales", unit: "currency", polarity: "higher", materialityPercent: 5, expectedVersion: 1,
      revenueBreakdown: { productColumn: "product_category", quantityColumn: "not_available", quantityUnit: "items", currency: "USD", confirmed: true },
    }, 400);

    await call("evidence-report/definition", {
      source: initial.sourceId,
      metric: initial.metric.column,
      label: "Net sales",
      unit: "currency",
      polarity: "higher",
      materialityPercent: 5,
      expectedVersion: 0,
    }, 400);

    const approved = (await call("evidence-report")).report;
    assert.equal(approved.health, "improving");
    assert.equal(approved.revenueBreakdown.status, "ready");
    assert.equal(approved.revenueBreakdown.totalChange, "30");
    assert.equal(approved.revenueBreakdown.effects.find((effect) => effect.id === "price").value, "45");
    assert.match(approved.explainer.questions.find((q) => q.id === "amount").answer, /190\.00/);
    assert.equal(approved.strengths.length, 1);
    assert.match(approved.executive.story, /Net sales/i);
    assert.ok(approved.evidence.policy.includes("fixed-point arithmetic"));

    const html = await download("html", /text\/html/);
    assert.match(html, /Performance evidence report/);
    assert.match(html, /<svg class="er-chart/);
    assert.doesNotMatch(html, /<script/i);

    const csv = await download("csv", /text\/csv/);
    assert.match(csv, /Category contribution/);
    assert.match(csv, /'=""?FormulaLookalike|"'=FormulaLookalike"/);

    const pdf = await download("pdf", /application\/pdf/);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
    assert.ok(pdf.length > 5000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
