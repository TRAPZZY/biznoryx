const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const option = (value, label, selected) =>
  `<option value="${escape(value)}" ${value === selected ? "selected" : ""}>${escape(label)}</option>`;
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const message = '<p class="form-message" role="status" aria-live="polite"></p>';
const blockerLabel = (code) =>
  ({
    SOURCE_CHECKLIST_UNCONFIRMED:
      "Confirm the required source checklist for this month",
    REQUIRED_SOURCE_NOT_READY: "Finish processing every required source",
    MAPPING_UNCONFIRMED: "Confirm the metric definition in Evidence reports",
    EMPTY_METRICS: "Add verified records for this month",
    INCOMPLETE_COVERAGE: "Resolve incomplete source coverage",
    PARTIAL_PERIOD: "Complete the reporting period",
    FINANCIAL_EVIDENCE_LIMIT:
      "Reduce the financial evidence to the supported packet size",
  })[code] ?? String(code).toLowerCase().replaceAll("_", " ");
const table = (headers, rows) =>
  `<div class="br-table-scroll"><table><thead><tr>${headers.map((h) => `<th scope="col">${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
export function validationIssueCsv(issues) {
  const cell = (value) =>
    '"' +
    String(value ?? "")
      .replace(/^[\s]*[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return (
    "row,column,problem\r\n" +
    issues
      .map((issue) =>
        [issue.row, issue.column, issue.message].map(cell).join(","),
      )
      .join("\r\n") +
    "\r\n"
  );
}
function showError(root, error) {
  const node = root.querySelector(".form-message");
  if (node) {
    node.textContent = error.message;
    node.setAttribute("role", "alert");
  }
  const issues = error.payload?.issues;
  if (Array.isArray(issues) && issues.length) {
    let region = root.querySelector(".br-errors");
    if (!region) {
      region = document.createElement("div");
      region.className = "br-errors";
      root.append(region);
    }
    region.innerHTML =
      table(
        ["Source record", "Column", "Problem"],
        issues
          .slice(0, 100)
          .map(
            (issue) =>
              `<tr><td>${escape(issue.row)}</td><td>${escape(issue.column)}</td><td>${escape(issue.message)}</td></tr>`,
          ),
      ) + '<button type="button">Download issues (CSV)</button>';
    region.querySelector("button").onclick = () => {
      const url = URL.createObjectURL(
        new Blob([validationIssueCsv(issues)], {
          type: "text/csv;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "biznoryx-import-issues.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };
  }
}
function bind(root, selector, action) {
  root.querySelector(selector)?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = event.submitter ?? form.querySelector('button[type="submit"], button:not([type])');
    if (button?.disabled) return;
    const status = form.querySelector(".form-message");
    form.querySelector(".br-errors")?.remove();
    if (status) {
      status.setAttribute("role", "status");
      status.textContent = "Working…";
    }
    if (button) button.disabled = true;
    try {
      await action(new FormData(form));
    } catch (error) {
      if (form.isConnected) showError(form, error);
    } finally {
      if (status?.textContent === "Working…") status.textContent = "";
      if (button?.isConnected) button.disabled = false;
    }
  });
}
export const reviewNavigation = ({ moneyTrail = true, monthlyClose = true } = {}) =>
  `<nav class="br-navigation" aria-label="Report views"><a href="#/reports">Evidence report</a>
    ${moneyTrail ? '<a href="#/money-trail">Sales &amp; receipts</a>' : ""}
    ${monthlyClose ? '<a href="#/monthly-review">Monthly review</a>' : ""}</nav>`;

export function mountImportReview({
  root,
  result,
  payload,
  uploads,
  api,
  onComplete,
  initialSourceRole = "other",
  initialAmountColumn,
}) {
  const { preview, profile } = result,
    definition = profile?.definition;
  let currentProfile = profile;
  const names = preview.columns.map((c) => c.name);
  const mapping = definition?.mapping ?? { amount: names.includes(initialAmountColumn) ? initialAmountColumn : undefined };
  const selectColumn = (key, label) =>
    `<label>${label}<select name="${key}">${option("", "Not mapped", mapping[key])}${names.map((n) => option(n, n, mapping[key])).join("")}</select></label>`;
  root.innerHTML = `<section class="br-panel"><p class="eyebrow">REVIEW IMPORT</p><h2>${escape(preview.fileName)}</h2>
    <p>${preview.rowCount} source records · ${names.length} columns · ${escape(payload.period)}${preview.selectedSheet ? ` · Sheet: ${escape(preview.selectedSheet)}` : ""}</p>
    ${table(
      names,
      preview.previewRows.map(
        (row) => `<tr>${row.map((v) => `<td>${escape(v)}</td>`).join("")}</tr>`,
      ),
    )}
    <form id="reviewed-import-form"><div class="br-form-grid"><label>These records describe<select name="sourceRole">${[
      ["other", "Other business records"],
      ["sales", "Recorded sales / invoices"],
      ["receipts", "Customer receipts"],
      ["expenses", "Business expenses"],
      ["supplier_purchases", "Supplier purchases"],
      ["bank_transactions", "Bank transactions"],
    ]
      .map(([v, l]) => option(v, l, definition?.sourceRole ?? initialSourceRole))
      .join("")}</select></label>
    <label>Source currency<input name="currency" required maxlength="3" pattern="[A-Z]{3}" value="${escape(definition?.currency ?? "NGN")}"></label><label>Date convention<select name="dateConvention">${[
      ["ISO", "YYYY-MM-DD"],
      ["DMY", "DD/MM/YYYY"],
      ["MDY", "MM/DD/YYYY"],
    ]
      .map(([v, l]) => option(v, l, definition?.dateConvention ?? "ISO"))
      .join("")}</select></label>
    ${selectColumn("date", "Record date")}${selectColumn("amount", "Amount column")}${selectColumn("reference", "Reference")}${selectColumn("description", "Description")}
    <label>Corrects an existing upload<select name="supersedesRunId">${option("", "New period / no correction", "")}${uploads
      .filter(
        (u) =>
          u.period === payload.period && u.dataSeries === payload.dataSeries,
      )
      .map((u) => option(u.id, u.fileName, ""))
      .join("")}</select></label></div>
    <p class="br-note">The original file is retained for download. This mapping is saved for the next period. Missing payment information will stay unknown; it does not establish debt or profit. Review errors before importing.</p>
    <label class="br-check"><input type="checkbox" required name="confirmed"> I reviewed the source, reporting month and mapping.</label>
    <button class="primary" type="submit">Approve mapping &amp; import</button>${message}</form></section>`;
  root.scrollIntoView({ behavior: "smooth", block: "start" });
  bind(root, "#reviewed-import-form", async (data) => {
    const approved = {
      sourceRole: data.get("sourceRole"),
      currency: data.get("currency"),
      dateConvention: data.get("dateConvention"),
      columns: names,
      mapping: {},
      units: definition?.units ?? {},
    };
    for (const key of ["date", "amount", "reference", "description"])
      if (data.get(key)) approved.mapping[key] = data.get(key);
    if (
      !currentProfile ||
      canonical(currentProfile.definition) !== canonical(approved)
    ) {
      currentProfile = (
        await api("ingestion/profile", {
          dataStreamId: preview.dataStream.id,
          expectedVersion: currentProfile?.version ?? 0,
          definition: approved,
        })
      ).profile;
    }
    const response = await api(
      payload.uploadId ? "ingestion/map-existing" : "ingestion/reviewed",
      {
        ...payload,
        profileId: currentProfile.id,
        reviewedChecksum: preview.checksumSha256,
        supersedesRunId: data.get("supersedesRunId") || undefined,
      },
    );
    await onComplete(response);
  });
}

export async function mountMoneyTrail({ root, api, uploads, period, capabilities }) {
  root.innerHTML =
    reviewNavigation(capabilities) + '<p role="status">Reading sales and receipts…</p>';
  try {
    const report = await api(
      "money-trail" + (period ? "?period=" + encodeURIComponent(period) : ""),
    );
    const records = report.records ?? [],
      sales = records.filter((r) => r.kind === "sale"),
      receipts = records.filter((r) =>
        ["receipt", "credit", "refund"].includes(r.kind),
      );
    root.innerHTML =
      reviewNavigation(capabilities) +
      `<section class="br-panel"><h1>Sales &amp; receipts</h1><p>Review how recorded sales connect to customer payments. Amounts are NGN. These are live reviewed balances, including payments received after the sale’s month.</p>
      <form id="money-period"><label>Reporting month<input type="month" name="period" value="${escape(period ?? "")}"></label><button>Apply month</button></form>
      <dl class="br-totals">${[
        ["recordedSales", "Recorded sales"],
        ["customerReceipts", "Customer receipts"],
        ["allocatedReceipts", "Receipts allocated to sales"],
        ["confirmedBalance", "Confirmed remaining balance"],
        ["unallocatedReceipts", "Unallocated receipts"],
      ]
        .map(
          ([k, l]) =>
            `<div><dt>${l}</dt><dd>₦${escape(report.totals[k] ?? "0.00")}</dd></div>`,
        )
        .join("")}</dl>
      <p class="br-note">${report.limitations.map(escape).join(" ")}</p>
      <h2>Bring in reviewed source records</h2><form id="money-source"><label>Source upload<select required name="uploadId"><option value="">Choose an approved mapped upload</option>${uploads.map((u) => option(u.id, `${u.fileName} · ${u.period}`, "")).join("")}</select></label><label>Replaces prior reviewed source (correction only)<select name="supersedesRunId"><option value="">No financial source correction</option>${uploads.map((u) => option(u.id, u.fileName + " · " + u.period, "")).join("")}</select></label><label>Correction reason<input name="correctionReason" maxlength="1000"></label><button ${uploads.length ? "" : "disabled"}>Review records</button>${message}</form><div id="money-preview"></div>
      <h2>Source records</h2>${
        records.length
          ? table(
              [
                "Date",
                "Type",
                "Description / reference",
                "Amount",
                "Payment status",
                "Review",
              ],
              records.map(
                (r) =>
                  `<tr><td>${escape(r.date)}</td><td>${escape(r.kind.replaceAll("_", " "))}</td><td>${escape(r.description)}<small>${escape(r.reference)}</small><a href="#/data?upload=${encodeURIComponent(r.ingestionRunId)}">Source · ${escape(r.sourceRowLocator)}</a></td><td>₦${escape(r.amount)}</td><td>${escape(r.paymentStatus.replaceAll("_", " "))}</td><td><button type="button" data-classify="${escape(r.id)}">Review meaning</button></td></tr>`,
              ),
            )
          : "<p>No financial records reviewed yet. Start with a sales or receipts source mapped in Data &amp; uploads.</p>"
      }
      ${report.hasMoreRecords ? "<p>Showing the first 500 records. Select a reporting month to narrow the list. Totals cover the full selected period.</p>" : ""}
      <div id="classification-panel"></div><h2>Approve an allocation</h2><form id="money-allocation"><div class="br-form-grid"><label>Sale<select required name="saleId">${option("", "Select sale", "")}${sales.map((r) => option(r.id, `${r.date} · ${r.reference || r.description} · ₦${r.amount}`, "")).join("")}</select></label><label>Receipt, credit or refund<select required name="receiptId">${option("", "Select receipt or adjustment", "")}${receipts.map((r) => option(r.id, `${r.date} · ${r.reference || r.description} · ₦${r.amount}`, "")).join("")}</select></label><label>Amount (NGN)<input required name="amount" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" placeholder="60000.00"></label></div><button ${sales.length && receipts.length ? "" : "disabled"}>Approve allocation</button>${message}</form>
      <p>Suggestions from confirmed references: ${report.suggestions.length}. Each allocation requires your approval; no match is automatic.</p>
      <h2>Source correction history</h2>${report.sourceCorrections.map((c) => "<p>" + escape(c.reason) + ' · <a href="#/data?upload=' + encodeURIComponent(c.previousRunId) + '">Prior source</a> → <a href="#/data?upload=' + encodeURIComponent(c.replacementRunId) + '">Replacement source</a></p>').join("") || "<p>No financial sources superseded.</p>"}<h2>Allocation history</h2>${
        report.allocations.length
          ? table(
              ["Type", "Amount", "Sale / receipt dates", "State", "Review"],
              report.allocations.map(
                (a) =>
                  `<tr><td>${escape(a.kind)}</td><td>₦${escape(a.amount)}</td><td>${escape(a.saleDate)} / ${escape(a.receiptDate)}</td><td>${a.reversalId ? "Reversed" : "Approved"}</td><td>${a.reversalId ? "" : `<button data-reverse="${escape(a.id)}">Review reversal</button>`}</td></tr>`,
              ),
            )
          : "<p>No allocations approved.</p>"
      }<div id="reversal-panel"></div></section>`;
    bind(root, "#money-period", (data) => {
      location.hash =
        "/money-trail?period=" + encodeURIComponent(data.get("period"));
    });
    const reload = () => mountMoneyTrail({ root, api, uploads, period, capabilities });
    bind(root, "#money-source", async (data) => {
      const uploadId = data.get("uploadId"),
        preview = await api("money-trail/preview", { uploadId }),
        panel = root.querySelector("#money-preview");
      panel.innerHTML = `<h3>Review ${preview.rowCount} source records</h3>${table(
        ["Source row", "Date", "Type", "Amount", "Description"],
        preview.records.map(
          (r) =>
            `<tr><td>${escape(r.sourceRowLocator)}</td><td>${escape(r.date)}</td><td>${escape(r.kind)}</td><td>₦${escape(r.amount)}</td><td>${escape(r.description)}</td></tr>`,
        ),
      )}${preview.issues.length ? `<p role="alert">${preview.issues.map((i) => `Row ${i.row}: ${escape(i.message)}`).join("<br>")}</p><button id="download-source-errors">Download row issues (CSV)</button>` : `<form id="confirm-money-source"><label class="br-check"><input type="checkbox" required> I confirm the proposed records match this source. Payment status remains unknown.</label><button>Import reviewed records</button>${message}</form>`}`;
      const errorDownload = panel.querySelector("#download-source-errors");
      if (errorDownload)
        errorDownload.onclick = () => {
          const url = URL.createObjectURL(
            new Blob([validationIssueCsv(preview.issues)], {
              type: "text/csv;charset=utf-8",
            }),
          );
          const a = document.createElement("a");
          a.href = url;
          a.download = "biznoryx-row-issues.csv";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
      bind(panel, "#confirm-money-source", async () => {
        await api("money-trail/import", {
          uploadId,
          reviewedChecksum: preview.checksum,
          supersedesRunId: data.get("supersedesRunId") || undefined,
          correctionReason: data.get("correctionReason"),
        });
        await reload();
      });
    });
    bind(root, "#money-allocation", async (data) => {
      const sale = records.find((r) => r.id === data.get("saleId")),
        receipt = records.find((r) => r.id === data.get("receiptId"));
      if (!sale || !receipt) throw new Error("Select both source records.");
      await api("money-trail/allocate", {
        saleId: sale.id,
        receiptId: receipt.id,
        amount: data.get("amount"),
        expectedSaleVersion: sale.version,
        expectedReceiptVersion: receipt.version,
      });
      await reload();
    });
    root.querySelectorAll("[data-classify]").forEach(
      (button) =>
        (button.onclick = () => {
          const record = records.find((r) => r.id === button.dataset.classify),
            panel = root.querySelector("#classification-panel");
          panel.innerHTML = `<h3>Review record meaning</h3><p>${escape(record.description)} · ₦${escape(record.amount)}</p><form id="money-classify"><div class="br-form-grid"><label>Record type<select name="kind">${["sale", "receipt", "owner_movement", "unknown", "credit", "refund"].map((v) => option(v, v.replaceAll("_", " "), record.kind)).join("")}</select></label><label>Payment evidence<select name="paymentStatus">${option("unknown", "Unknown", record.paymentStatus)}${option("confirmed_receivable", "Confirmed receivable (sale only)", record.paymentStatus)}</select></label><label>Confirmed due date (optional)<input type="date" name="dueDate" value="${escape(record.dueDate ?? "")}"></label><label>Reason<input required maxlength="1000" name="reason"></label></div><label class="br-check"><input type="checkbox" name="referenceConfirmed" ${record.referenceConfirmed ? "checked" : ""}> The source reference has been checked.</label><button>Save reviewed meaning</button>${message}</form>`;
          bind(panel, "#money-classify", async (data) => {
            await api("money-trail/classify", {
              id: record.id,
              expectedVersion: record.version,
              classification: {
                kind: data.get("kind"),
                paymentStatus: data.get("paymentStatus"),
                dueDate: data.get("dueDate") || null,
                referenceConfirmed: data.get("referenceConfirmed") === "on",
                reason: data.get("reason"),
              },
            });
            await reload();
          });
          panel.scrollIntoView({ behavior: "smooth" });
        }),
    );
    root.querySelectorAll("[data-reverse]").forEach(
      (button) =>
        (button.onclick = () => {
          const panel = root.querySelector("#reversal-panel");
          panel.innerHTML = `<form id="reverse-money"><label>Reason for reversing this allocation<input required maxlength="1000" name="reason"></label><button>Confirm reversal</button>${message}</form>`;
          bind(panel, "#reverse-money", async (data) => {
            await api("money-trail/reverse", {
              allocationId: button.dataset.reverse,
              reason: data.get("reason"),
            });
            await reload();
          });
          panel.scrollIntoView({ behavior: "smooth" });
        }),
    );
  } catch (error) {
    root.innerHTML =
      reviewNavigation(capabilities) +
      `<section class="br-panel"><h1>Sales &amp; receipts</h1><p role="alert">${escape(error.message)}</p><button id="money-retry">Retry</button></section>`;
    root.querySelector("#money-retry").onclick = () =>
      mountMoneyTrail({ root, api, uploads, period, capabilities });
  }
}

export async function mountMonthlyReview({ root, api, capabilities }) {
  root.innerHTML =
    reviewNavigation(capabilities) + '<p role="status">Reading monthly review…</p>';
  try {
    const [{ items }, { report }] = await Promise.all([
      api("monthly-close"),
      api("evidence-report"),
    ]);
    const selectedPeriod =
      report?.current.period ?? new Date().toISOString().slice(0, 7);
    let requirements = await api(
      "monthly-close/sources?period=" + encodeURIComponent(selectedPeriod),
    );
    root.innerHTML =
      reviewNavigation(capabilities) +
      `<section class="br-panel"><h1>Monthly review</h1><p>Prepare a frozen version of the selected evidence report, review its limitations, then approve it as an owner or admin. Later corrections create a new version.</p>
      ${
        report
          ? `<form id="monthly-draft"><div class="br-form-grid"><label>Report source<select name="sourceId">${report.controls.sources.map((s) => option(s.id, `${s.series} · ${s.name}`, report.sourceId)).join("")}</select></label><label>Metric<select name="metric">${report.controls.metrics.map((m) => option(m.column, m.label, report.metric.column)).join("")}</select></label><label>Reporting month<input type="month" required name="period" value="${escape(report.current.period)}"></label><label>Corrects approved packet<select name="supersedesId">${option("", "First approval / no correction", "")}${items
              .filter((i) => i.status === "approved")
              .map((i) => option(i.id, `${i.period} · v${i.version}`, ""))
              .join(
                "",
              )}</select></label></div><p class="br-note">This version covers the supplied source records and the chosen metric. It does not establish that every business source is complete or that cash has been reconciled.</p><button>Prepare draft</button>${message}</form>`
          : "<p>Process a source and confirm its metric definition in Evidence reports before preparing a monthly review.</p>"
      }
      <h2>Required source checklist</h2><form id="monthly-sources"><label>Checklist month<input required type="month" name="period" value="${escape(selectedPeriod)}"></label>
      ${requirements.options.map((s) => `<label class="br-check"><input type="checkbox" name="dataStreamIds" value="${escape(s.id)}" ${requirements.checklist.sources.some((r) => r.streamId === s.id) ? "checked" : ""}>${escape(s.name)}</label>`).join("")}
      <p class="br-note">Choose every series required for this month. Confirmation creates a versioned checklist. A draft cannot be approved while a required source is missing, partial or still processing.</p><button>Confirm required sources</button>${message}</form><div id="monthly-source-status">${requirements.checklist.sources.map((s) => `<p>${escape(s.name)}: ${escape(s.status.replaceAll("_", " "))}</p>`).join("")}</div>
      <h2>Saved review versions</h2>${
        items.length
          ? table(
              [
                "Month",
                "Version",
                "State",
                "Prepared by",
                "Source records",
                "Review",
              ],
              items.map(
                (i) =>
                  `<tr><td>${escape(i.period)}</td><td>${i.version}</td><td>${escape(i.status)}</td><td>${escape(i.createdByName)}</td><td>${escape(i.evidenceStatus)}</td><td><button data-close="${escape(i.id)}">Open packet</button></td></tr>`,
              ),
            )
          : "<p>No monthly packets prepared yet.</p>"
      }<div id="monthly-packet"></div></section>`;
    bind(root, "#monthly-sources", async (data) => {
      const period = data.get("period");
      if (period !== requirements.checklist.period)
        requirements = await api(
          "monthly-close/sources?period=" + encodeURIComponent(period),
        );
      const saved = await api("monthly-close/sources", {
        period,
        dataStreamIds: data.getAll("dataStreamIds"),
        expectedVersion: requirements.checklist.version,
      });
      requirements.checklist = saved.checklist;
      root.querySelector("#monthly-source-status").innerHTML =
        saved.checklist.sources
          .map(
            (s) =>
              `<p>${escape(s.name)}: ${escape(s.status.replaceAll("_", " "))}</p>`,
          )
          .join("");
      root.querySelector("#monthly-sources .form-message").textContent =
        "Required sources confirmed.";
    });
    bind(root, "#monthly-draft", async (data) => {
      await api("monthly-close/draft", {
        period: data.get("period"),
        supersedesId: data.get("supersedesId") || null,
        idempotencyKey: crypto.randomUUID(),
        report: {
          sourceId: data.get("sourceId"),
          metric: { column: data.get("metric") },
          evidence: { dateColumn: null },
          previous: { period: "none" },
        },
      });
      await mountMonthlyReview({ root, api, capabilities });
    });
    root.querySelectorAll("[data-close]").forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          try {
            const { item } = await api(
                "monthly-close?id=" + encodeURIComponent(button.dataset.close),
              ),
              panel = root.querySelector("#monthly-packet");
            panel.innerHTML = `<h2>${escape(item.period)} · version ${item.version}</h2><p>${escape(item.report.metric.label)}: ${escape(item.report.current.value)}</p><p>State: ${escape(item.status)} · Source evidence: ${escape(item.evidenceStatus)}</p><ul>${item.limitations.map((l) => `<li>${escape(l.message)}</li>`).join("")}</ul><p>Approved by: ${escape(item.approvedByName ?? "Not approved")}</p><h3>Required sources</h3>${(item.evidenceManifest?.sourceChecklist?.sources ?? []).map((source) => "<p>" + escape(source.name) + ": " + escape(source.status.replaceAll("_", " ")) + "</p>").join("")}
        ${item.evidenceManifest?.moneyTrail ? "<h3>Reviewed sales and receipts at preparation</h3><p>NGN recorded sales: " + escape(item.evidenceManifest.moneyTrail.totals.recordedSales) + " · Receipts dated this month: " + escape(item.evidenceManifest.moneyTrail.totals.customerReceipts) + " · Allocated receipts for these sales (including later receipts): " + escape(item.evidenceManifest.moneyTrail.totals.allocatedReceipts) + "</p>" : ""}
        <details><summary>Evidence details</summary><p class="br-hash">Integrity checksum: ${escape(item.contentHash)}</p></details><button id="download-packet">Download evidence packet (JSON)</button>${item.status === "draft" ? `<form id="approve-close"><label class="br-check"><input required type="checkbox"> I reviewed this packet and its stated limitations.</label><button ${item.approvalBlockers.length || item.evidenceStatus !== "available" ? "disabled" : ""}>Approve this version</button><p>${item.approvalBlockers.length ? "Resolve before approval: " + item.approvalBlockers.map((code) => escape(blockerLabel(code))).join(", ") : ""}</p>${message}</form>` : ""}`;
            panel.querySelector("#download-packet").onclick = () => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(item, null, 2)], {
                  type: "application/json",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = `biznoryx-monthly-${item.period}-v${item.version}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 30000);
            };
            bind(panel, "#approve-close", async () => {
              await api("monthly-close/approve", {
                id: item.id,
                expectedVersion: item.version,
              });
              await mountMonthlyReview({ root, api, capabilities });
            });
            panel.scrollIntoView({ behavior: "smooth" });
          } catch (error) {
            root.querySelector("#monthly-packet").innerHTML =
              `<p role="alert">${escape(error.message)}</p>`;
          } finally {
            button.disabled = false;
          }
        }),
    );
  } catch (error) {
    root.innerHTML =
      reviewNavigation(capabilities) +
      `<section class="br-panel"><h1>Monthly review</h1><p role="alert">${escape(error.message)}</p><button id="monthly-retry">Retry</button></section>`;
    root.querySelector("#monthly-retry").onclick = () =>
      mountMonthlyReview({ root, api, capabilities });
  }
}
