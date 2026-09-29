export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const e = escapeHtml;
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
export const periodName = (period) => new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${period}-01T00:00:00Z`));
export function reportValue(value, metric, compact = false) {
  if (value === null || value === undefined) return "Not available";
  return new Intl.NumberFormat("en", {
    ...(metric.unit === "currency" ? { style: "currency", currency: metric.currency } : {}),
    maximumFractionDigits: compact ? 1 : 2,
    ...(compact ? { notation: "compact" } : {}),
  }).format(Number(value));
}
const percent = (value) => value === null || value === undefined ? "No valid percentage" : `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)}%`;
const sourceButton = (id, title = "View evidence") => `<button type="button" class="er-text-button" data-evidence="${e(id)}">${icon("scan-text")}${e(title)}</button>`;
const sectionHead = (number, title, subtitle = "", control = "") => `<header class="er-section-head"><div><span class="er-section-number">${number}</span><h2>${e(title)}</h2>${subtitle ? `<p>${e(subtitle)}</p>` : ""}</div>${control}</header>`;

export function reportControls(report) {
  const c = report.controls;
  const options = (items, selected, key, name) => items.map((item) => `<option value="${e(item[key])}" ${item[key] === selected ? "selected" : ""}>${e(item[name])}</option>`).join("");
  return `<form class="er-controls" id="report-controls" aria-label="Report filters">
    <label class="er-source-select">Source<select name="source">${options(c.sources, report.sourceId, "id", "name")}</select></label>
    <label>Metric<select name="metric">${options(c.metrics, report.metric.column, "column", "label")}</select></label>
    ${c.dates.length ? `<label>Date field<select name="dateColumn">${options(c.dates, c.dateColumn, "column", "label")}</select></label>` : ""}
    <label>Reporting period<select name="period">${[...c.periods].reverse().map((p) => `<option value="${e(p)}" ${p === report.current.period ? "selected" : ""}>${e(periodName(p))}</option>`).join("")}</select></label>
    <label>Compare with<select name="compare"><option value="none" ${!report.previous ? "selected" : ""}>No comparison</option>${c.periods.filter((p) => p < report.current.period).reverse().map((p) => `<option value="${e(p)}" ${p === report.previous?.period ? "selected" : ""}>${e(periodName(p))}</option>`).join("")}</select></label>
    ${c.dimensions.length ? `<label>Break down by<select name="dimension">${options(c.dimensions, c.dimension, "column", "label")}</select></label>` : ""}
  </form>`;
}

export function renderEvidenceReport(report, { offline = false } = {}) {
  const m = report.metric;
  const current = report.current;
  const movement = report.comparison;
  const health = { improving: "Improving", deteriorating: "Requires attention", stable: "Stable", insufficient_evidence: "Assessment limited" }[report.health];
  const topPriority = report.priorities.find((p) => p.id === "coverage") ?? report.priorities.find((p) => p.id === "movement") ?? report.priorities.find((p) => p.id === "concentration") ?? report.priorities.find((p) => p.quadrant === "fix_first") ?? report.priorities[0];
  const evidenceControl = offline ? "" : sourceButton("report");
  return `<article class="evidence-report" data-report-version="${e(report.version)}">
    <header class="er-masthead"><div><p class="er-eyebrow">${e(report.organizationName)} / Business intelligence</p><h2>Performance evidence report</h2><p>${e(periodName(current.period))}${report.previous ? ` <span aria-hidden="true">/</span> compared with ${e(periodName(report.previous.period))}` : " / baseline"}</p></div><div class="er-edition"><strong>BIZNORYX<span>.</span></strong><span>${e(new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(report.generatedAt)))} UTC</span><span>${e(report.evidenceQuality.label)} &middot; ${report.evidence.sources.length} source${report.evidence.sources.length === 1 ? "" : "s"}</span></div></header>
    <section class="er-story" aria-labelledby="er-story-title"><div class="er-story-main"><p class="er-eyebrow">01 / The business briefing</p><h3 id="er-story-title">${e(report.executive.headline)}</h3><p class="er-lead">${e(report.executive.story)}</p>${evidenceControl}</div><aside class="er-first-focus"><span class="er-eyebrow">First on the agenda</span><h3>${e(topPriority?.title || "Review the evidence")}</h3><p>${e(report.executive.focus)}</p>${offline ? "" : sourceButton(topPriority?.id || "report", "Why this matters")}</aside></section>
    <dl class="er-indicators"><div><dt>${e(m.label)} <span>${e(periodName(current.period))}</span></dt><dd>${e(reportValue(current.value, m))}</dd><small>${current.rows.toLocaleString("en")} contributing rows${current.partial ? " / partial date coverage" : ""}</small></div><div><dt>Previous period <span>${report.previous ? e(periodName(report.previous.period)) : "Not selected"}</span></dt><dd>${report.previous ? e(reportValue(report.previous.value, m)) : "&mdash;"}</dd><small>${report.previous ? `${report.previous.rows.toLocaleString("en")} contributing rows` : "More history needed"}</small></div><div><dt>Observed movement <span>${movement ? movement.direction === "up" ? "Increase" : movement.direction === "down" ? "Decrease" : "No change" : "No comparison"}</span></dt><dd>${movement ? e(percent(movement.percentChange)) : "&mdash;"}</dd><small>${movement ? e(reportValue(movement.absoluteChange, m)) + " absolute change" : "No inferred movement"}</small></div><div><dt>Business assessment <span>${m.policy ? `Definition v${m.policy.version}` : "Definition unconfirmed"}</span></dt><dd class="er-health er-${e(report.health)}">${e(health)}</dd><small>${e(report.evidenceQuality.label)}</small></div></dl>
    <section class="er-section er-performance">${sectionHead("02", "The performance story", report.trend.headline, offline ? "" : sourceButton("trend"))}
      <figure class="er-figure"><figcaption><strong>${e(m.label)} across observed periods</strong><span>${e(m.unit === "currency" ? m.currency : "Units")} / monthly totals / gaps remain unfilled</span></figcaption>${lineChart(report.timeline, m, { selected: current.period })}
      <div class="er-chart-caption"><span class="er-legend-dot"></span><span>${e(m.label)}</span><span>${report.timeline.filter((p) => p.value !== null).length} observed periods</span><span>${e(report.trend.persistent ? "Repeated direction observed" : "No sustained direction established")}</span></div></figure>
      <div class="er-performance-notes"><div><h3>What the pattern supports</h3><p>${e(report.trend.headline)}. ${report.trend.observations < 3 ? "More comparable periods are needed before a persistent pattern can be established." : "This describes the observed history; it does not predict the next period."}</p></div><div><h3>What to check next</h3><p>${e(report.executive.watch)}</p></div></div>
      ${report.daily.length ? `<details class="er-disclosure" ${offline ? "open" : ""}><summary>Inside ${e(periodName(current.period))}: daily activity <span>${report.daily.length} observed dates</span></summary><figure class="er-figure"><figcaption><strong>${e(m.label)} by actual record date</strong><span>Dates without records are gaps, not zeroes</span></figcaption>${dailyChart(report)}${dataTable(report.daily.map((d) => [d.date, reportValue(d.value, m), d.rows]), ["Date", m.label, "Rows"], false)}</figure></details>` : ""}
    </section>
    <section class="er-section">${sectionHead("03", "Where the change happened", report.drivers ? `${report.drivers.label} / ${report.drivers.hasComparison ? "contribution to the selected comparison" : "current-period composition"}` : "No supported category dimension in this source", offline ? "" : sourceButton("drivers"))}
      ${report.drivers ? `<div class="er-driver-layout"><figure class="er-figure"><figcaption><strong>${report.drivers.hasComparison ? "From the previous total to the current total" : `Where ${e(m.label.toLowerCase())} is recorded`}</strong><span>${e(report.drivers.reconciled ? "Contributions reconcile to the total" : "Reconciliation requires review")}</span></figcaption>${report.drivers.hasComparison ? waterfallChart(report) : rankedBars(report)}<p class="er-footnote">${e(report.drivers.note)}</p></figure><div class="er-driver-reading"><h3>${e(report.drivers.entries[0]?.name || report.drivers.label)} stands out</h3><p>${driverReading(report)}</p><h4>Management question</h4><p>What changed in this category's volume, mix, pricing or source coverage? Reconcile those records before choosing a response.</p>${offline ? "" : sourceButton("drivers", "Explain the contribution")}</div></div>
      ${dataTable(report.drivers.entries.map((d) => [d.name, reportValue(d.current, m), d.previous === null ? "Not available" : reportValue(d.previous, m), d.change === null ? "Not available" : reportValue(d.change, m), d.share === null ? "Not meaningful" : `${d.share.toFixed(1)}%`]), [report.drivers.label, "Current", "Previous", "Contribution", "Current share"], !offline)}
      ${report.heatmap.length && report.timeline.length > 1 ? `<details class="er-disclosure" ${offline ? "open" : ""}><summary>How the leading categories evolved <span>Last six observed periods</span></summary>${heatmap(report)}</details>` : ""}` : `<p class="er-empty-inline">Driver analysis needs a product, service, channel, region or segment field with reusable categories. No category contribution has been invented.</p>`}
    </section>
    <section class="er-section">${sectionHead("04", "The business agenda", "Investigation priorities, with the reasoning in view")}
      <div class="er-agenda-layout"><div class="er-priorities">${report.priorities.map((p, i) => `<article class="er-priority"><span class="er-priority-index">${String(i + 1).padStart(2, "0")}</span><div><p class="er-eyebrow">${e(p.kind)} / ${e(p.urgency)}</p><h3>${e(p.title)}</h3><p>${e(p.investigation)}</p><p class="er-success"><strong>Follow-up:</strong> ${e(p.success)}</p>${offline ? `<p class="er-footnote">${e(p.fact)} ${e(p.interpretation)}</p>` : sourceButton(p.id, "Why this matters")}</div></article>`).join("")}</div><div class="er-matrix-wrap"><h3>Focus priority matrix</h3><p class="er-footnote">Priority reflects measured movement, evidence readiness and the approved review threshold.</p><div class="er-matrix-axis">Greater measured impact</div><div class="er-matrix">${[["fix_first", "Fix first"], ["build_on", "Build on"], ["monitor", "Monitor"], ["low_priority", "Low priority"]].map(([key, name]) => `<section class="er-quadrant er-${key}"><h4>${name}</h4>${report.priorities.filter((p) => p.quadrant === key).map((p) => `<${offline ? "span" : "button"} ${offline ? "" : `type="button" data-evidence="${e(p.id)}"`} class="er-matrix-item">${e(p.title)}</${offline ? "span" : "button"}>`).join("") || '<p class="er-matrix-empty">No supported priority</p>'}</section>`).join("")}</div><div class="er-matrix-axis er-matrix-bottom"><span>Act or resolve now</span><span>Review over time</span></div></div></div>
    </section>
    <section class="er-section er-strengths">${sectionHead("05", "Strengths to protect", "A favorable direction needs to persist before it earns this label")}${report.strengths.length ? report.strengths.map((s) => `<div><h3>${e(s.title)}</h3><p>${e(s.explanation)}</p>${offline ? "" : sourceButton("trend", "View supporting history")}</div>`).join("") : `<p class="er-empty-inline">${e(report.executive.protect)}</p>`}</section>
    <section class="er-section er-evidence" id="report-evidence">${sectionHead("06", "Evidence & limitations", report.evidenceQuality.reason, offline ? "" : `<button class="er-text-button" data-definition>${icon("settings-2")}Metric definition</button>`)}
      <div class="er-evidence-summary"><span class="er-quality">${e(report.evidenceQuality.label)}</span><span>VERIFIED FACT: ${e(report.evidence.calculation)}</span><span>${e(report.controls.dateColumn || "Declared reporting month")}</span><span>${report.evidence.sourceRows.toLocaleString("en")} source rows</span></div>
      <ul class="er-limitations">${report.limitations.map((l) => `<li>${e(l.message)}</li>`).join("")}</ul>
      <details class="er-disclosure" ${offline ? "open" : ""}><summary>Source register & calculation method <span>${report.evidence.sources.length} source${report.evidence.sources.length === 1 ? "" : "s"}</span></summary><div class="er-method"><p>${e(report.evidence.policy)}</p><p>${e(report.evidence.priorityPolicy)}</p><p>Mapping ${m.policy ? `version ${m.policy.version}, approved ${e(new Date(m.policy.approvedAt).toISOString())}; ${e(m.policy.polarity)} preferred; ${e(m.policy.materialityPercent)}% review threshold.` : "has not been approved."}</p></div>${report.evidence.sources.map((s) => `<dl class="er-source"><div><dt>Source file</dt><dd>${e(s.fileName)}</dd></div><div><dt>Source rows</dt><dd>${s.rowCount.toLocaleString("en")}</dd></div><div><dt>Declared upload month</dt><dd>${e(s.declaredPeriod)}</dd></div><div><dt>SHA-256</dt><dd class="er-code">${e(s.checksum || "Not available")}</dd></div>${s.rawDataObjectId ? `<div><dt>Raw object</dt><dd class="er-code">${e(s.rawDataObjectId)}</dd></div>` : ""}${s.metricPointId ? `<div><dt>Verified metric</dt><dd class="er-code">${e(s.metricPointId)}</dd></div>` : ""}</dl>`).join("")}</details>
    </section><footer class="er-footer"><span>BIZNORYX / ${e(report.organizationName)}</span><span>${e(report.version)} / ${e(periodName(current.period))}</span></footer>
  </article>`;
}

function driverReading(report) {
  const d = report.drivers.entries[0];
  if (!d) return "No category records are available.";
  if (!report.drivers.hasComparison) return `${e(d.name)} has the largest observed total, ${e(reportValue(d.current, report.metric))}${d.share === null ? "" : `, accounting for ${d.share.toFixed(1)}% of this period's metric`}. This is composition, not a claim about performance quality.`;
  return `${e(d.name)} moved by ${e(reportValue(d.change, report.metric))}, from ${e(reportValue(d.previous, report.metric))} to ${e(reportValue(d.current, report.metric))}. It has the largest absolute contribution to the overall movement. Opposing category changes can partly cancel each other out.`;
}

function chartFrame(title, svg, extraClass = "") {
  return `<div class="er-chart-scroll"><svg class="er-chart ${extraClass}" viewBox="0 0 760 280" role="img" aria-label="${e(title)}"><title>${e(title)}</title>${svg}</svg></div>`;
}

export function lineChart(points, metric, { selected = null, daily = false } = {}) {
  const values = points.filter((p) => p.value !== null).map((p) => Number(p.value));
  if (!values.length) return '<p class="er-empty-inline">No observations are available for this chart.</p>';
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const x = (index) => 76 + index * 650 / Math.max(1, points.length - 1);
  const y = (value) => 226 - (Number(value) - min) * 190 / span;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = min + index * span / 4;
    const yy = y(value);
    return `<line x1="76" x2="730" y1="${yy}" y2="${yy}" stroke="#e2e6e5"/><text x="66" y="${yy + 4}" text-anchor="end" fill="#5d6763">${e(reportValue(value, metric, true))}</text>`;
  }).join("");
  let previous = null;
  const line = points.map((p, index) => {
    if (p.value === null) { previous = null; return ""; }
    const item = { x: x(index), y: y(p.value) };
    const segment = previous ? `<line x1="${previous.x}" y1="${previous.y}" x2="${item.x}" y2="${item.y}" stroke="#236f69" stroke-width="2.5"/>` : "";
    previous = item;
    return `${segment}<circle tabindex="0" aria-label="${e(p.period)}: ${e(reportValue(p.value, metric))}" cx="${item.x}" cy="${item.y}" r="${p.period === selected ? 5.5 : 3.5}" fill="${p.partial ? "#a16d26" : "#236f69"}" stroke="white" stroke-width="1.5"><title>${e(p.period)}: ${e(reportValue(p.value, metric))}${p.partial ? " (partial date coverage)" : ""}</title></circle>`;
  }).join("");
  const step = Math.max(1, Math.ceil(points.length / 6));
  const labels = points.map((p, index) => index % step === 0 || index === points.length - 1 ? `<text x="${x(index)}" y="255" text-anchor="${index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}" fill="#5d6763">${e(daily ? p.period.slice(-2) : periodName(p.period))}</text>` : "").join("");
  return chartFrame(`${metric.label} over ${points.length} ${daily ? "calendar dates" : "calendar months"}. Missing observations are gaps.`, grid + line + labels);
}

function dailyChart(report) {
  const days = new Date(Number(report.current.period.slice(0, 4)), Number(report.current.period.slice(5)), 0).getDate();
  const points = Array.from({ length: days }, (_, i) => {
    const date = `${report.current.period}-${String(i + 1).padStart(2, "0")}`;
    return { period: date, value: report.daily.find((d) => d.date === date)?.value ?? null };
  });
  return lineChart(points, report.metric, { daily: true });
}

function waterfallEntries(report) {
  const all = report.drivers.entries;
  const chosen = all.slice(0, 5).map((d) => ({ name: d.name, value: Number(d.change) }));
  if (all.length > 5) chosen.push({ name: "Other categories", value: all.slice(5).reduce((sum, d) => sum + Number(d.change), 0) });
  let running = Number(report.previous.value);
  const entries = [{ name: periodName(report.previous.period), start: 0, end: running, total: true }];
  for (const item of chosen) { entries.push({ name: item.name, start: running, end: running + item.value, value: item.value }); running += item.value; }
  entries.push({ name: periodName(report.current.period), start: 0, end: Number(report.current.value), total: true });
  return entries;
}

export function waterfallChart(report) {
  const entries = waterfallEntries(report);
  const min = Math.min(0, ...entries.flatMap((d) => [d.start, d.end]));
  const max = Math.max(0, ...entries.flatMap((d) => [d.start, d.end]));
  const span = max - min || 1;
  const y = (value) => 218 - (value - min) / span * 165;
  const width = 650 / entries.length;
  const rects = entries.map((d, index) => {
    const x = 74 + width * index;
    const color = d.total ? "#334d59" : d.value >= 0 ? "#367d88" : "#ad7554";
    const title = `${d.name}: ${reportValue(d.total ? d.end : d.value, report.metric)}`;
    const short = d.name.length > 13 ? `${d.name.slice(0, 12)}...` : d.name;
    return `<g tabindex="0" aria-label="${e(title)}"><title>${e(title)}</title><rect x="${x + 7}" y="${Math.min(y(d.start), y(d.end))}" width="${Math.max(12, width - 14)}" height="${Math.max(1, Math.abs(y(d.start) - y(d.end)))}" rx="2" fill="${color}"/><text x="${x + width / 2}" y="${Math.min(y(d.start), y(d.end)) - 9}" text-anchor="middle" fill="#24352e">${e(reportValue(d.total ? d.end : d.value, report.metric, true))}</text><text x="${x + width / 2}" y="248" text-anchor="middle" fill="#5d6763">${e(short)}</text></g>`;
  }).join("");
  return chartFrame("Reconciled category contributions from the previous period to the current period", `<line x1="74" x2="727" y1="${y(0)}" y2="${y(0)}" stroke="#bac5c0"/>${rects}`);
}

function rankedBars(report) {
  const entries = [...report.drivers.entries].sort((a, b) => Math.abs(Number(b.current)) - Math.abs(Number(a.current))).slice(0, 8);
  const max = Math.max(...entries.map((d) => Math.abs(Number(d.current))), 1);
  return `<div class="er-ranked-bars">${entries.map((d) => `<div><span>${e(d.name)}</span><div class="er-bar-track"><div style="width:${Math.abs(Number(d.current)) / max * 100}%" class="er-bar ${Number(d.current) < 0 ? "er-negative" : ""}"></div></div><strong>${e(reportValue(d.current, report.metric, true))}</strong></div>`).join("")}</div>`;
}

function heatmap(report) {
  const max = Math.max(...report.heatmap.flatMap((row) => row.values.map((v) => Math.abs(Number(v.value)))), 1);
  return `<div class="er-table-scroll"><table class="er-heatmap"><caption>${e(report.drivers.label)} totals, ${e(report.metric.unit === "currency" ? report.metric.currency : "units")}. Shading represents magnitude, not favorable performance.</caption><thead><tr><th scope="col">${e(report.drivers.label)}</th>${report.heatmap[0].values.map((v) => `<th scope="col">${e(periodName(v.period))}</th>`).join("")}</tr></thead><tbody>${report.heatmap.map((row) => `<tr><th scope="row">${e(row.name)}</th>${row.values.map((v) => `<td style="background:rgba(54,125,136,${0.04 + Math.abs(Number(v.value)) / max * 0.25})" title="${e(reportValue(v.value, report.metric))}">${e(reportValue(v.value, report.metric, true))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function dataTable(rows, headers, collapsed = true) {
  const table = `<div class="er-table-scroll"><table><thead><tr>${headers.map((h) => `<th scope="col">${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, index) => `<${index ? "td" : "th scope=\"row\""}>${e(value)}</${index ? "td" : "th"}>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  return collapsed ? `<details class="er-disclosure"><summary>View the underlying comparison <span>${rows.length} categories</span></summary>${table}</details>` : table;
}

export function evidenceDialog(report, id) {
  const item = report.priorities.find((p) => p.id === id);
  const pairs = item ? [["Fact", item.fact], ["Signal", item.signal], ["Interpretation", item.interpretation], ["Potential implication", item.implication], ["Recommended investigation", item.investigation], ["Measure the follow-up", item.success]] : [["What was compared", report.executive.story], ["What the pattern supports", report.trend.headline], ["Contribution", report.drivers?.note || "No category evidence is available."], ["Calculation", report.evidence.calculation], ["What cannot be concluded", "The records do not establish cause, statistical confidence, forecast performance or complete coverage of the business."]];
  return `<dialog class="er-dialog" id="evidence-dialog" aria-labelledby="evidence-dialog-title"><div class="er-dialog-head"><div><p class="er-eyebrow">Evidence trail</p><h2 id="evidence-dialog-title">${e(item?.title || "Why this conclusion appears")}</h2></div><button type="button" class="er-icon-button" data-close-dialog aria-label="Close evidence" title="Close evidence">${icon("x")}</button></div><div class="er-dialog-content">${pairs.map(([name, value]) => `<section><h3>${e(name)}</h3><p>${e(value)}</p></section>`).join("")}<dl class="er-source"><div><dt>Current period</dt><dd>${e(periodName(report.current.period))} / ${e(reportValue(report.current.value, report.metric))}</dd></div><div><dt>Comparison</dt><dd>${report.previous ? `${e(periodName(report.previous.period))} / ${e(reportValue(report.previous.value, report.metric))}` : "Not available"}</dd></div><div><dt>Evidence quality</dt><dd>${e(report.evidenceQuality.label)}</dd></div><div><dt>Mapping</dt><dd>${report.metric.policy ? `Approved version ${report.metric.policy.version}` : "Unconfirmed"}</dd></div></dl><p class="er-footnote">${e(report.evidence.priorityPolicy)}</p><h3>Sources</h3>${report.evidence.sources.map((s) => `<p>${e(s.fileName)} / ${s.rowCount.toLocaleString("en")} rows</p><p class="er-code">${e(s.checksum)}</p>`).join("")}<h3>Limitations</h3><ul>${report.limitations.map((l) => `<li>${e(l.message)}</li>`).join("")}</ul></div></dialog>`;
}

export function definitionDialog(report) {
  const p = report.metric.policy;
  return `<dialog class="er-dialog" id="definition-dialog" aria-labelledby="definition-title"><div class="er-dialog-head"><div><p class="er-eyebrow">${p ? `Version ${p.version} / new approval` : "Business confirmation"}</p><h2 id="definition-title">Define this metric</h2></div><button type="button" class="er-icon-button" data-close-dialog aria-label="Close definition" title="Close definition">${icon("x")}</button></div><form id="report-definition" class="er-definition-form"><p>${e(report.evidence.calculation)}. Confirm that the column contains additive values and that its name, unit and preferred direction match the business.</p><label>Business metric name<input name="label" required maxlength="120" value="${e(report.metric.label)}"></label><label>Unit<select name="unit"><option value="currency" ${report.metric.unit === "currency" ? "selected" : ""}>Reporting currency (${e(report.metric.currency)})</option><option value="number" ${report.metric.unit === "number" ? "selected" : ""}>Number / units</option></select></label><label>When this metric increases<select name="polarity" required><option value="">Choose the business meaning</option><option value="higher" ${p?.polarity === "higher" ? "selected" : ""}>Higher is favorable</option><option value="lower" ${p?.polarity === "lower" ? "selected" : ""}>Lower is favorable</option><option value="neutral" ${p?.polarity === "neutral" ? "selected" : ""}>Neither direction is inherently favorable</option></select></label><label>Review changes of at least (%)<input type="number" min="0.1" max="100" step="0.1" name="materialityPercent" required value="${p?.materialityPercent ?? 5}"></label><label class="er-checkbox"><input type="checkbox" required name="confirm">I confirm this definition and that summing this column is appropriate.</label><p class="form-message" role="status"></p><button class="primary" type="submit">${icon("check")}Approve definition</button></form></dialog>`;
}
