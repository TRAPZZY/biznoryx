import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { AuthError } from "../auth/core.mjs";
import { renderEvidenceReport, reportValue, periodName, escapeHtml } from "../../web-app/evidence-report.js";

const stylesheet = readFileSync(new URL("../../web-app/evidence-report.css", import.meta.url), "utf8");
const fonts = {
  regular: fileURLToPath(new URL("../../web-app/fonts/NotoSans-Regular.ttf", import.meta.url)),
  bold: fileURLToPath(new URL("../../web-app/fonts/NotoSans-Bold.ttf", import.meta.url)),
};
let activePdfExports = 0;

export async function sendEvidenceExport(response, report, format) {
  if (!report) throw new AuthError("No report is available to export.", "NOT_FOUND");
  if (!["pdf", "html", "csv"].includes(format)) throw new AuthError("Choose PDF, HTML or CSV export.", "VALIDATION_FAILED");
  let payload;
  if (format === "pdf") {
    if (activePdfExports >= 2) throw new AuthError("Two reports are being prepared. Retry in a moment.", "VALIDATION_FAILED");
    activePdfExports += 1;
    try { payload = await renderReportPdf(report); }
    finally { activePdfExports -= 1; }
  } else payload = format === "html" ? renderReportHtml(report) : renderReportCsv(report);
  response.setHeader("Content-Type", { pdf: "application/pdf", html: "text/html; charset=utf-8", csv: "text/csv; charset=utf-8" }[format]);
  response.setHeader("Content-Disposition", `attachment; filename="biznoryx-evidence-${report.current.period}.${format}"`);
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(payload);
}

export function renderReportHtml(report) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(report.organizationName)} - Evidence report - ${report.current.period}</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7f5;font-family:Arial,sans-serif}h1,h2,h3,h4,p{margin:0}${stylesheet}</style></head><body><main class="er-export-document">${renderEvidenceReport(report, { offline: true })}</main></body></html>`;
}

function csvCell(value) {
  let string = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(string) && !/^-?\d+(\.\d+)?$/.test(string)) string = `'${string}`;
  return `"${string.replaceAll('"', '""')}"`;
}

export function renderReportCsv(report) {
  const rows = [["Kind", "Period", "Comparison period", "Metric", "Category", "Current value", "Previous value", "Absolute movement", "Percent movement", "Definition version", "Report version"]];
  for (const point of report.timeline) rows.push(["Monthly observation", point.period, "", report.metric.label, "", point.value, "", "", "", report.metric.policy?.version ?? "Unconfirmed", report.version]);
  for (const entry of report.drivers?.entries ?? []) rows.push(["Category contribution", report.current.period, report.previous?.period ?? "", report.metric.label, entry.name, entry.current, entry.previous, entry.change, entry.percentChange, report.metric.policy?.version ?? "Unconfirmed", report.version]);
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export async function renderReportPdf(report) {
  const doc = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: `${report.organizationName} - Evidence report`, Author: "BIZNORYX", Subject: `${periodName(report.current.period)} - ${report.metric.label}` } });
  doc.registerFont("Report", fonts.regular);
  doc.registerFont("ReportBold", fonts.bold);
  const chunks = [];
  const ready = new Promise((resolve, reject) => { doc.on("data", (chunk) => chunks.push(chunk)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const width = doc.page.width - 88;
  const bottom = doc.page.height - 70;
  const color = "#24382e";
  let y = 44;
  function newPage() { doc.addPage(); y = 46; }
  function reserve(height) { if (y + height > bottom) newPage(); }
  function paragraph(value, { size = 10, bold = false, ink = color, gap = 10 } = {}) {
    doc.font(bold ? "ReportBold" : "Report").fontSize(size).fillColor(ink);
    const height = doc.heightOfString(String(value), { width, lineGap: 3 });
    reserve(height + gap);
    doc.text(String(value), 44, y, { width, lineGap: 3 });
    y += height + gap;
  }
  function heading(value, number) {
    reserve(75);
    y += 8;
    doc.moveTo(44, y).lineTo(44 + width, y).lineWidth(0.6).strokeColor("#dce5de").stroke();
    y += 16;
    paragraph(`${number} / ${value}`, { size: 15, bold: true, gap: 13 });
  }
  function table(headers, rows, columnWidths) {
    function drawRow(values, header = false) {
      doc.font(header ? "ReportBold" : "Report").fontSize(8);
      const heights = values.map((value, index) => doc.heightOfString(String(value), { width: columnWidths[index] - 14, lineGap: 2 }));
      const height = Math.max(...heights, 13) + 15;
      if (y + height > bottom) { newPage(); if (!header) drawRow(headers, true); }
      let x = 44;
      values.forEach((value, index) => {
        if (header) doc.rect(x, y, columnWidths[index], height).fill("#f0f5f1");
        doc.fillColor(color).font(header ? "ReportBold" : "Report").fontSize(8).text(String(value), x + 7, y + 7, { width: columnWidths[index] - 14, lineGap: 2 });
        x += columnWidths[index];
      });
      y += height;
      doc.moveTo(44, y).lineTo(44 + width, y).lineWidth(0.4).strokeColor("#e3e9e4").stroke();
    }
    drawRow(headers, true);
    rows.forEach((row) => drawRow(row));
    y += 13;
  }
  function trendChart() {
    reserve(220);
    const top = y + 16;
    const points = report.timeline;
    const values = points.filter((p) => p.value !== null).map((p) => Number(p.value));
    if (!values.length) return;
    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    const span = maximum - minimum || 1;
    const chartX = 100;
    const chartW = width - 67;
    const px = (i) => chartX + i / Math.max(points.length - 1, 1) * chartW;
    const py = (value) => top + 145 - (value - minimum) / span * 140;
    for (let index = 0; index < 5; index += 1) {
      const value = minimum + index * span / 4;
      doc.moveTo(chartX, py(value)).lineTo(chartX + chartW, py(value)).lineWidth(0.4).strokeColor("#e1e8e2").stroke();
      doc.font("Report").fontSize(8).fillColor("#647668").text(reportValue(value, report.metric, true), 44, py(value) - 5, { width: 49, align: "right" });
    }
    let prior = null;
    points.forEach((point, index) => {
      if (point.value === null) { prior = null; return; }
      const position = { x: px(index), y: py(Number(point.value)) };
      if (prior) doc.moveTo(prior.x, prior.y).lineTo(position.x, position.y).lineWidth(1.8).strokeColor("#286f68").stroke();
      doc.circle(position.x, position.y, 2.7).fill(point.partial ? "#a47527" : "#286f68");
      prior = position;
      if (index % Math.max(1, Math.ceil(points.length / 4)) === 0 || index === points.length - 1) doc.font("Report").fontSize(7).fillColor("#647668").text(periodName(point.period), Math.min(position.x - 20, 44 + width - 45), top + 155, { width: 47, align: "center" });
    });
    y = top + 184;
    paragraph(`${report.metric.label} / ${report.metric.unit === "currency" ? report.metric.currency : "Units"}. Gaps are missing observations; amber points have partial date coverage.`, { size: 8, ink: "#647668" });
  }
  paragraph("BIZNORYX / PERFORMANCE EVIDENCE", { size: 10, bold: true, ink: "#276e51" });
  paragraph(report.organizationName, { size: 23, bold: true });
  paragraph(`${periodName(report.current.period)}${report.previous ? ` compared with ${periodName(report.previous.period)}` : " / Baseline"}`, { size: 12 });
  paragraph(`Generated ${new Date(report.generatedAt).toISOString()} | ${report.evidenceQuality.label} | ${report.evidence.sources.length} source(s)`, { size: 8, ink: "#617669" });
  heading("The business briefing", "01");
  paragraph(report.executive.headline, { size: 17, bold: true });
  paragraph(report.executive.story);
  table([report.metric.label, "Previous period", "Observed change"], [[reportValue(report.current.value, report.metric), report.previous ? reportValue(report.previous.value, report.metric) : "Not available", report.comparison ? `${reportValue(report.comparison.absoluteChange, report.metric)} (${report.comparison.percentChange === null ? "no valid percentage" : report.comparison.percentChange.toFixed(1) + "%"})` : "No comparison"]], [width / 3, width / 3, width / 3]);
  paragraph("First on the agenda", { size: 10, bold: true });
  paragraph(report.executive.focus || "Review the source coverage.");
  heading("The performance story", "02");
  paragraph(report.trend.headline, { size: 11, bold: true });
  trendChart();
  paragraph(report.executive.watch, { size: 9 });
  newPage();
  heading("Where the change happened", "03");
  if (report.drivers) {
    paragraph(`${report.drivers.label}: ${report.drivers.reconciled ? "contributions reconcile to the selected totals" : "reconciliation needs review"}.`, { bold: true });
    const leading = report.drivers.entries[0];
    if (leading) paragraph(`${leading.name} has the largest ${report.drivers.hasComparison ? "absolute contribution to the change" : "observed category total"}. Review its underlying records before deciding on a response.`);
    table([report.drivers.label, "Current", "Previous", "Contribution"], report.drivers.entries.map((entry) => [entry.name, reportValue(entry.current, report.metric), entry.previous === null ? "Not available" : reportValue(entry.previous, report.metric), entry.change === null ? "Not available" : reportValue(entry.change, report.metric)]), [width * 0.34, width * 0.22, width * 0.22, width * 0.22]);
    paragraph(report.drivers.note, { size: 9, ink: "#647668" });
  } else paragraph("No reusable category dimension is available. Category contributions have not been inferred.");
  heading("The business agenda", "04");
  for (const priority of report.priorities) {
    reserve(180);
    paragraph(priority.title, { size: 12, bold: true });
    paragraph(`${priority.quadrant.replaceAll("_", " ").toUpperCase()} / ${priority.kind} / ${priority.evidenceQuality}`, { size: 8, ink: "#647668" });
    for (const [name, value] of [["Fact", priority.fact], ["Signal", priority.signal], ["Interpretation", priority.interpretation], ["Potential implication", priority.implication], ["Recommended investigation", priority.investigation], ["Follow-up", priority.success]]) paragraph(`${name}: ${value}`, { size: 9, gap: 7 });
    y += 9;
  }
  heading("Strengths to protect", "05");
  paragraph(report.executive.protect);
  newPage();
  heading("Evidence and limitations", "06");
  paragraph(`${report.evidenceQuality.label}: ${report.evidenceQuality.reason}`, { bold: true });
  for (const limitation of report.limitations) paragraph(`- ${limitation.message}`, { size: 9 });
  paragraph("Calculation and decision rules", { size: 12, bold: true });
  paragraph(`${report.evidence.calculation} | Date field: ${report.evidence.dateColumn || "Declared upload period"} | ${report.evidence.sourceRows} source rows`, { size: 9 });
  paragraph(report.evidence.policy, { size: 9 });
  paragraph(report.evidence.priorityPolicy, { size: 9 });
  paragraph(report.metric.policy ? `Approved definition version ${report.metric.policy.version}: ${report.metric.policy.label}, ${report.metric.policy.polarity} preferred, ${report.metric.policy.materialityPercent}% materiality threshold.` : "Metric meaning has not been approved.", { size: 9 });
  for (const source of report.evidence.sources) {
    reserve(110);
    paragraph(source.fileName, { size: 11, bold: true });
    paragraph(`Rows: ${source.rowCount} | Declared upload month: ${source.declaredPeriod}`, { size: 8 });
    paragraph(`SHA-256: ${source.checksum || "Not available"}`, { size: 8 });
    if (source.rawDataObjectId) paragraph(`Raw object: ${source.rawDataObjectId}`, { size: 8 });
    if (source.metricPointId) paragraph(`Verified metric point: ${source.metricPointId}`, { size: 8 });
  }
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    const footerY = doc.page.height - 43;
    doc.moveTo(44, footerY - 11).lineTo(44 + width, footerY - 11).lineWidth(0.5).strokeColor("#dce5de").stroke();
    doc.font("Report").fontSize(8).fillColor("#6a7b70").text(`BIZNORYX / ${report.version}`, 44, footerY, { lineBreak: false });
    doc.text(`${index + 1} / ${range.count}`, 44 + width - 45, footerY, { width: 45, align: "right", lineBreak: false });
  }
  doc.end();
  return ready;
}
