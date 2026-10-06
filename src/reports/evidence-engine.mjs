import { createHash } from "node:crypto";
import { median, medianAbsoluteDeviation } from "simple-statistics";
import { AuthError } from "../auth/core.mjs";

import { validateCsvHeaderSizes } from "../ingestion/csv-limits.mjs";
import { parseReportNumber, reportDecimal } from "./decimal.mjs";
import { buildRevenueBreakdown } from "./revenue-breakdown.mjs";
import { buildReportExplainer } from "./report-explainer.mjs";
export { parseReportNumber, reportDecimal } from "./decimal.mjs";

export const REPORT_VERSION = "evidence-v2";
const MAX_METRICS = 12;
const MAX_DATES = 2;
const MAX_DIMENSIONS = 8;
const MAX_CATEGORIES = 80;
const MAX_MONTHS = 120;
const MAX_ANALYTICS_BYTES = 8 * 1024 * 1024;
const DATE_NAME = /(^date$|date$|_at$|^day$)/i;
const EXCLUDED_METRIC = /(^|[ _])(id|year|quarter|month|day|week|percent|percentage|rate|ratio|price|balance|stock|inventory|latitude|longitude|zip|postal|code|number|no|sku)([ _]|$)|_id$|percent|margin|unit_price/i;
const DIMENSION_NAME = /(^|[ _])(product|sku|item|service|channel|region|location|branch|category|segment|department|country)([ _]|$)/i;
const MONEY_NAME = /revenue|sales|amount|cost|profit|expense|payment|fee|spend/i;
const text = (value) => String(value ?? "").trim();
const label = (value) => text(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const fail = (message) => { throw new AuthError(message, "VALIDATION_FAILED"); };

export function isAdditiveReportColumn(column) {
  return !EXCLUDED_METRIC.test(column) && !DATE_NAME.test(column);
}

export function parseReportDate(value) {
  const raw = text(value);
  // Locale-dependent dates are deliberately not guessed.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?$/.test(raw)) return null;
  const day = raw.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

function metricRank(column) {
  const preferred = ["net_sales", "revenue", "sales", "gross_sales", "profit", "cost_amount", "cost", "total_amount", "amount", "quantity"];
  const rank = preferred.indexOf(column.toLowerCase().replaceAll(" ", "_"));
  return rank < 0 ? 50 : rank;
}

export function buildReportCube({ rows, columns = Object.keys(rows[0] ?? {}) }) {
  if (rows.length > 50000 || columns.length > 200) fail("Report analysis supports up to 50,000 rows and 200 columns per source.");
  validateCsvHeaderSizes(columns);
  // Charge conservative JSON byte bounds before allocating repeated metadata.
  // Six bytes per UTF-8 byte covers JSON escaping, including control characters.
  let analyticsBytes = 0;
  const reserve = (bytes) => {
    analyticsBytes += bytes;
    if (analyticsBytes > MAX_ANALYTICS_BYTES) fail("Report analytics exceed the 8 MB size budget. Split this source into smaller files.");
  };
  reserve(512 + columns.reduce((size, column) => size + 32 + 12 * Buffer.byteLength(column), 0));
  const dateColumns = columns.filter((column) => DATE_NAME.test(column) && rows.some((row) => parseReportDate(row[column]))).slice(0, MAX_DATES);
  const dimensionCandidates = columns.filter((column) => DIMENSION_NAME.test(column));
  const dimensions = dimensionCandidates.filter((column) => {
    const count = new Set(rows.map((row) => text(row[column]))).size;
    return (count > 1 || /(^|[ _])(product|sku|item)([ _]|$)/i.test(column)) && count <= MAX_CATEGORIES;
  }).slice(0, MAX_DIMENSIONS);
  const metricColumns = columns.filter(isAdditiveReportColumn).filter((column) => {
    const populated = rows.map((row) => text(row[column])).filter(Boolean);
    return populated.length > 0 && populated.filter((value) => parseReportNumber(value) !== null).length / populated.length >= 0.9;
  }).sort((a, b) => metricRank(a) - metricRank(b) || a.localeCompare(b)).slice(0, MAX_METRICS);
  const metrics = metricColumns.map((column) => buildMetricCube(rows, column, dimensions, dateColumns, reserve));
  return {
    version: REPORT_VERSION,
    rowCount: rows.length,
    schemaFingerprint: createHash("sha256").update(JSON.stringify([...columns].sort())).digest("hex"),
    metrics,
    excludedColumns: columns.filter((column) => !metricColumns.includes(column) && !dimensions.includes(column) && !dateColumns.includes(column)),
    omittedDimensions: dimensionCandidates.filter((column) => !dimensions.includes(column)),
  };
}

function newBucket(period, dimensions, reserve) {
  reserve(512 + dimensions.reduce((size, column) => size + 128 + 6 * (Buffer.byteLength(column) + Buffer.byteLength(label(column))), 0));
  return { period, total: 0n, rows: 0, missing: 0, invalid: 0, first: null, last: null, days: new Set(), negative: false, dimensions: new Map(dimensions.map((column) => [column, new Map()])) };
}

function addRow(bucket, value, row, date, reserve) {
  if (date) {
    bucket.first = !bucket.first || date < bucket.first ? date : bucket.first;
    bucket.last = !bucket.last || date > bucket.last ? date : bucket.last;
    bucket.days.add(date);
  }
  if (value === null) return;
  bucket.total += value;
  bucket.rows += 1;
  bucket.negative ||= value < 0n;
  for (const [column, entries] of bucket.dimensions) {
    const key = text(row[column]) || "(Unspecified)";
    let entry = entries.get(key);
    if (!entry) {
      reserve(128 + 6 * Buffer.byteLength(key));
      entry = { name: key, total: 0n, rows: 0 };
    }
    entry.total += value;
    entry.rows += 1;
    entries.set(key, entry);
  }
}

function serializeBucket(bucket) {
  return {
    period: bucket.period, value: reportDecimal(bucket.total), rows: bucket.rows,
    missing: bucket.missing, invalid: bucket.invalid,
    first: bucket.first, last: bucket.last, observedDays: bucket.days.size,
    hasNegativeValues: bucket.negative,
    dimensions: [...bucket.dimensions].map(([column, entries]) => ({
      column, label: label(column), entries: [...entries.values()].map((entry) => ({ name: entry.name, value: reportDecimal(entry.total), rows: entry.rows })),
    })),
  };
}

function buildMetricCube(rows, column, dimensions, dateColumns, reserve) {
  reserve(512 + 6 * (Buffer.byteLength(column) + Buffer.byteLength(label(column))));
  reserve(dateColumns.reduce((size, dateColumn) => size + 256 + 6 * Buffer.byteLength(dateColumn), 0));
  const all = newBucket("all", dimensions, reserve);
  const dates = dateColumns.map((dateColumn) => ({ column: dateColumn, invalidRows: 0, validRows: 0, first: null, last: null, months: new Map(), daily: new Map() }));
  for (const row of rows) {
    const raw = text(row[column]);
    const value = parseReportNumber(raw);
    if (!raw) all.missing += 1;
    else if (value === null) all.invalid += 1;
    addRow(all, value, row, null, reserve);
    for (const date of dates) {
      const day = parseReportDate(row[date.column]);
      if (!day) { date.invalidRows += 1; continue; }
      date.validRows += 1;
      date.first = !date.first || day < date.first ? day : date.first;
      date.last = !date.last || day > date.last ? day : date.last;
      const month = day.slice(0, 7);
      if (!date.months.has(month)) date.months.set(month, newBucket(month, dimensions, reserve));
      if (date.months.size > MAX_MONTHS) fail("A source can cover up to ten years. Split longer histories into separate sources.");
      const bucket = date.months.get(month);
      if (!raw) bucket.missing += 1;
      else if (value === null) bucket.invalid += 1;
      addRow(bucket, value, row, day, reserve);
      let daily = date.daily.get(day);
      if (!daily) {
        reserve(128);
        daily = { date: day, total: 0n, rows: 0 };
      }
      if (value !== null) { daily.total += value; daily.rows += 1; }
      date.daily.set(day, daily);
    }
  }
  return {
    column, label: label(column), unitHint: MONEY_NAME.test(column) ? "currency" : "number",
    all: serializeBucket(all),
    dates: dates.map((date) => ({ ...date,
      months: [...date.months.values()].map(serializeBucket).sort((a, b) => a.period.localeCompare(b.period)),
      daily: [...date.daily.values()].map((day) => ({ date: day.date, value: day.rows ? reportDecimal(day.total) : null, rows: day.rows })).sort((a, b) => a.date.localeCompare(b.date)),
    })),
  };
}

export function validateReportPolicy(body) {
  const polarity = text(body.polarity);
  const materialityPercent = Number(body.materialityPercent);
  const name = text(body.label);
  const unit = text(body.unit);
  if (!["higher", "lower", "neutral"].includes(polarity)) fail("Choose what a higher value means for this metric.");
  if (!Number.isFinite(materialityPercent) || materialityPercent < 0.1 || materialityPercent > 100) fail("Choose a review threshold between 0.1% and 100%.");
  if (!name || name.length > 120) fail("Metric name must contain 1 to 120 characters.");
  if (!["currency", "number"].includes(unit)) fail("Choose a metric unit.");
  let revenueBreakdown = null;
  if (body.revenueBreakdown != null) {
    const mapping = body.revenueBreakdown;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || mapping.confirmed !== true || unit !== "currency") fail("Confirm that this metric is revenue before enabling its breakdown.");
    const productColumn = text(mapping.productColumn), quantityColumn = text(mapping.quantityColumn), quantityUnit = text(mapping.quantityUnit), currency = text(mapping.currency);
    if (!productColumn || !quantityColumn || productColumn === quantityColumn || !quantityUnit || quantityUnit.length > 40 || !/^[A-Z]{3}$/.test(currency)) fail("Choose distinct product and quantity columns, a shared quantity unit and a reporting currency.");
    validateCsvHeaderSizes([productColumn, quantityColumn]);
    revenueBreakdown = { productColumn, quantityColumn, quantityUnit, currency, confirmed: true };
  }
  return { polarity, materialityPercent, label: name, unit, revenueBreakdown };
}

export function validateRevenueMappingSource(source, metricColumn, definition, currency) {
  const mapping = definition.revenueBreakdown;
  if (!mapping) return;
  const metric = source.cube.metrics.find((m) => m.column === metricColumn);
  const quantity = source.cube.metrics.find((m) => m.column === mapping.quantityColumn);
  if (mapping.currency !== currency || !quantity || quantity.column === metricColumn || mapping.productColumn === metricColumn || !metric?.all.dimensions.some((d) => d.column === mapping.productColumn) || !quantity.all.dimensions.some((d) => d.column === mapping.productColumn)) fail("The approved product, quantity and currency must match fields available in this source.");
}

function monthIndex(period) { const [year, month] = period.split("-").map(Number); return year * 12 + month - 1; }
function monthFromIndex(index) { return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`; }
function monthLastDay(period) { const [y, m] = period.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
function monthLabel(period) { return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${period}-01T00:00:00Z`)); }
function abs(value) { return value < 0n ? -value : value; }

function change(current, previous) {
  const a = parseReportNumber(current);
  const b = parseReportNumber(previous);
  if (a === null || b === null) return null;
  const delta = a - b;
  return { absoluteChange: reportDecimal(delta), percentChange: b <= 0n ? null : Number(delta * 100000n / b) / 1000, direction: delta > 0n ? "up" : delta < 0n ? "down" : "flat" };
}

function compactValue(value, unit, currency) {
  return new Intl.NumberFormat("en", { ...(unit === "currency" ? { style: "currency", currency } : {}), maximumFractionDigits: 2 }).format(value);
}

function selectSources(sources, selected, metric, dateColumn, limitations) {
  const compatible = sources.filter((source) => source.seriesKey === selected.seriesKey && source.cube?.metrics.some((m) => m.column === metric));
  const ordered = [selected, ...compatible.filter((s) => s.id !== selected.id).sort((a, b) => String(b.confirmedAt).localeCompare(String(a.confirmedAt)))];
  const accepted = [];
  const checksums = new Set();
  for (const source of ordered) {
    if (source.checksum && checksums.has(source.checksum)) {
      limitations.push({ code: "DUPLICATE_SOURCE", message: `${source.fileName} repeats an already included source. It is excluded from the calculation.` });
      continue;
    }
    const item = source.cube.metrics.find((m) => m.column === metric);
    const dates = item.dates.find((d) => d.column === dateColumn);
    if (source !== selected && source.cube.schemaFingerprint !== selected.cube.schemaFingerprint) {
      limitations.push({ code: "SCHEMA_DRIFT", message: `${source.fileName} has a different column structure and is excluded from comparisons.` });
      continue;
    }
    const overlaps = accepted.some((entry) => dates && entry.dates ? dates.first <= entry.dates.last && dates.last >= entry.dates.first : source.period === entry.source.period);
    if (overlaps || (dateColumn && !dates)) {
      limitations.push({ code: "OVERLAPPING_SOURCE", message: `${source.fileName} overlaps the selected source or lacks the same date field. Sources are not combined until the coverage can be reconciled.` });
      continue;
    }
    checksums.add(source.checksum);
    accepted.push({ source, item, dates });
  }
  return accepted;
}

function combinedPeriods(accepted) {
  const buckets = new Map();
  for (const { source, item, dates } of accepted) {
    const periods = dates ? dates.months : [{ ...item.all, period: source.period }];
    for (const point of periods) {
      const previous = buckets.get(point.period);
      const mapped = { ...point, sourceIds: [source.id] };
      if (!previous) { buckets.set(point.period, mapped); continue; }
      previous.value = reportDecimal(parseReportNumber(previous.value) + parseReportNumber(point.value));
      previous.rows += point.rows;
      previous.missing += point.missing;
      previous.invalid += point.invalid;
      previous.observedDays += point.observedDays;
      previous.hasNegativeValues ||= point.hasNegativeValues;
      previous.first = [previous.first, point.first].filter(Boolean).sort()[0] ?? null;
      previous.last = [previous.last, point.last].filter(Boolean).sort().at(-1) ?? null;
      previous.sourceIds.push(source.id);
      for (const dimension of point.dimensions) {
        const target = previous.dimensions.find((d) => d.column === dimension.column);
        if (!target) continue;
        target.entries = target.entries.map((entry) => ({ ...entry }));
        for (const entry of dimension.entries) {
          const existing = target.entries.find((e) => e.name === entry.name);
          if (!existing) target.entries.push({ ...entry });
          else { existing.value = reportDecimal(parseReportNumber(existing.value) + parseReportNumber(entry.value)); existing.rows += entry.rows; }
        }
      }
    }
  }
  return [...buckets.values()].map((point) => ({ ...point, partial: Boolean(point.first && (point.first !== `${point.period}-01` || point.last !== monthLastDay(point.period))) })).sort((a, b) => a.period.localeCompare(b.period));
}

function decompose(current, previous, dimension) {
  const now = current.dimensions.find((d) => d.column === dimension);
  const before = previous?.dimensions.find((d) => d.column === dimension);
  if (!now) return null;
  const currentEntries = new Map(now.entries.map((e) => [e.name, e]));
  const previousEntries = new Map((before?.entries ?? []).map((e) => [e.name, e]));
  const entries = [...new Set([...currentEntries.keys(), ...previousEntries.keys()])].map((name) => {
    const a = currentEntries.get(name);
    const b = previousEntries.get(name);
    const movement = before ? change(a?.value ?? "0", b?.value ?? "0") : null;
    return { name, current: a?.value ?? "0", previous: before ? b?.value ?? "0" : null, change: movement?.absoluteChange ?? null, percentChange: movement?.percentChange ?? null, rows: a?.rows ?? 0,
      share: !current.hasNegativeValues && parseReportNumber(current.value) > 0n ? Number(parseReportNumber(a?.value ?? "0") * 100000n / parseReportNumber(current.value)) / 1000 : null };
  }).sort((a, b) => Number(abs(parseReportNumber(b.change ?? b.current)) - abs(parseReportNumber(a.change ?? a.current))));
  const sum = entries.reduce((total, e) => total + parseReportNumber(e.change ?? e.current), 0n);
  const target = before ? parseReportNumber(current.value) - parseReportNumber(previous.value) : parseReportNumber(current.value);
  return { column: dimension, label: now.label, entries, totalChange: before ? reportDecimal(target) : null, reconciled: sum === target, hasComparison: Boolean(before), note: "Contributions explain where the measured change occurred. They do not establish its cause." };
}

function trendSummary(points, current, policy, blocked) {
  const values = points.filter((p) => p.value !== null);
  const last = values.slice(-3);
  const contiguous = last.length === 3 && monthIndex(last[2].period) - monthIndex(last[0].period) === 2;
  const movements = last.slice(1).map((p, index) => change(p.value, last[index].value));
  const sameDirection = movements.length === 2 && movements[0].direction === movements[1].direction;
  const persistent = contiguous && sameDirection && movements[0].direction !== "flat" && !last.some((p) => p.partial || p.missing || p.invalid);
  let headline = values.length < 2 ? "One period establishes the starting point" : `${label(policy?.label || "Performance")} ${sameDirection && contiguous ? `moved ${movements[0].direction === "up" ? "up" : movements[0].direction === "down" ? "down" : "sideways"} for two consecutive comparisons` : "has varied across the observed periods"}`;
  if (current.partial) headline = "The latest period has incomplete date coverage";
  const historical = values.filter((p) => p.period < current.period && !p.partial).slice(-12).map((p) => Number(p.value));
  let unusual = null;
  if (!blocked && !current.partial && historical.length >= 6) {
    const center = median(historical);
    const spread = medianAbsoluteDeviation(historical);
    if (spread > 0 && Math.abs(Number(current.value) - center) > 3 * spread) unusual = { median: center, deviation: spread, observations: historical.length, rule: "Outside the prior-period median by more than three median absolute deviations", caveat: "A descriptive review flag, not a probability, forecast, or seasonal adjustment." };
  }
  return { headline, persistent: persistent && !blocked, direction: persistent ? movements[0].direction : "mixed", observations: values.length, unusual };
}

function buildFindings({ current, previous, comparison, policy, blocked, drivers, trend, metricLabel, fmt, quality }) {
  const priorities = [];
  const material = Boolean(comparison && (comparison.percentChange === null ? comparison.absoluteChange !== "0" : Math.abs(comparison.percentChange) >= (policy?.materialityPercent ?? 5)));
  const known = policy && policy.polarity !== "neutral";
  const favorable = known && comparison && (policy.polarity === "higher" ? comparison.direction === "up" : comparison.direction === "down");
  let health = !known || !comparison || blocked ? "insufficient_evidence" : !material ? "stable" : favorable ? "improving" : "deteriorating";
  const fact = comparison ? `${metricLabel} moved from ${fmt(previous.value)} in ${monthLabel(previous.period)} to ${fmt(current.value)} in ${monthLabel(current.period)}.` : `${metricLabel} totals ${fmt(current.value)} in ${monthLabel(current.period)}.`;
  const contributors = drivers?.hasComparison ? drivers.entries.filter((e) => e.change !== "0") : [];
  const leading = contributors[0];
  const opposingLeading = Boolean(leading && comparison && ((comparison.direction === "up" && parseReportNumber(leading.change) < 0n) || (comparison.direction === "down" && parseReportNumber(leading.change) > 0n)));
  if (blocked) priorities.push({ id: "coverage", title: "Reconcile the coverage before changing course", quadrant: "fix_first", impact: "High", urgency: "Before acting", kind: "Data limitation", fact,
    signal: "Coverage or missing values limit the comparison.", interpretation: "Some movement may reflect the way the source was assembled.", implication: "Treating unequal coverage as performance could direct attention to the wrong area.", investigation: "Check the start and end dates, missing amounts and source extracts for both periods. Confirm equal coverage with the data owner.", success: "Comparable source coverage and no unresolved missing metric values.", evidenceQuality: quality });
  if (comparison && !blocked) priorities.push({ id: "movement", title: leading ? `Start with ${leading.name} in ${drivers.label.toLowerCase()}` : `Review the movement in ${metricLabel.toLowerCase()}`,
    quadrant: opposingLeading ? "monitor" : health === "deteriorating" && material ? "fix_first" : health === "improving" && material ? "build_on" : "monitor",
    impact: material ? "High" : "Low", urgency: health === "deteriorating" && material ? "Next review" : "Track next period", kind: "Recommended investigation", fact,
    signal: leading ? `${leading.name} has the largest absolute contribution to the change: ${fmt(leading.change)}.` : `The observed movement is ${comparison.direction === "flat" ? "unchanged" : comparison.direction === "up" ? "upward" : "downward"}.`,
    interpretation: opposingLeading ? "This category's movement opposes the overall change. The total and this category should not receive the same favorable or adverse label." : health === "deteriorating" ? "The direction is unfavorable under the business's confirmed metric definition." : health === "improving" ? "The direction is favorable under the business's confirmed metric definition." : "The movement is measurable; its business value depends on the metric's purpose.",
    implication: opposingLeading ? "Other categories more than offset this movement. The overall assessment does not describe every category; review whether the shift was intentional." : health === "deteriorating" ? "Continued movement in this direction would move this metric away from its preferred direction." : health === "improving" ? "This area may be worth protecting, subject to capacity, cost and customer evidence." : "A larger total is not automatically a better business outcome.",
    investigation: leading ? `Review the underlying ${leading.name} records with the ${drivers.label.toLowerCase()} owner. Check changes in volume, mix, pricing and coverage before choosing a response.` : `Ask the metric owner to reconcile the ${monthLabel(previous.period)} and ${monthLabel(current.period)} extracts and identify what changed operationally.`,
    success: `Recheck ${metricLabel.toLowerCase()} and the same contribution next period using unchanged definitions.`, evidenceQuality: quality });
  const dominant = drivers?.entries.filter((e) => e.share !== null).sort((a, b) => b.share - a.share)[0];
  if (dominant?.share >= 50) priorities.push({ id: "concentration", title: `${dominant.name} carries most of this metric`, quadrant: "monitor", impact: "High", urgency: "Track next period", kind: "Observed concentration",
    fact: `${dominant.name} accounts for ${dominant.share.toFixed(1)}% of ${metricLabel.toLowerCase()} in the selected period.`, signal: `More than half of the measured total sits in one ${drivers.label.toLowerCase()} category.`,
    interpretation: "Performance is concentrated. Concentration alone does not prove a business risk.", implication: "A change in this category would have a disproportionate effect on the total.", investigation: `Check whether dependence on ${dominant.name} is intentional, and what alternatives or capacity are available.`, success: "Review the share and contribution next period; agree whether the concentration is acceptable.", evidenceQuality: quality });
  if (!policy) priorities.push({ id: "mapping", title: `Confirm what ${metricLabel.toLowerCase()} means`, quadrant: "fix_first", impact: "High", urgency: "Before acting", kind: "Definition required", fact: `The calculation sums the selected source column.`, signal: "No approved direction or materiality threshold is recorded.", interpretation: "An increase may be good, bad or neutral depending on the business definition.", implication: "Strength and deterioration labels remain withheld.", investigation: "Confirm the metric name, unit, preferred direction and review threshold in the metric definition.", success: "An owner-approved, versioned definition.", evidenceQuality: quality });
  if (!comparison) priorities.push({ id: "history", title: "Establish a comparable second period", quadrant: "monitor", impact: "Low", urgency: "Next data update", kind: "History required", fact, signal: "Only a baseline is available for the selected period.", interpretation: "The mix can be described, but there is no prior period to measure change against.", implication: "There is not enough history to identify a persistent strength or decline.", investigation: "Add or select an earlier comparable period using the same metric and source structure.", success: "Two comparable observed periods.", evidenceQuality: quality });
  if (trend.unusual) priorities.push({ id: "unusual", title: "This period differs from its recent history", quadrant: "monitor", impact: "High", urgency: "Next review", kind: "Descriptive signal", fact: `${metricLabel} lies outside the recent historical range used by the review rule.`, signal: trend.unusual.rule, interpretation: "An unusual observation merits investigation but is not proof of a problem.", implication: "An event, seasonal pattern or extract issue could be relevant.", investigation: "Compare the source records with promotions, closures, price changes or reporting changes in this period.", success: "An evidence-linked explanation, followed by a comparable next period.", evidenceQuality: quality });
  const strengths = health === "improving" && trend.persistent ? [{ title: `${metricLabel} has sustained favorable movement`, explanation: "The confirmed preferred direction was met across two consecutive monthly comparisons, with no known gaps or partial boundary periods.", evidenceIds: ["movement"], magnitude: comparison, quality }] : [];
  return { health, priorities, strengths };
}

function agendaPriority(priorities) {
  return priorities.find((p) => p.id === "coverage")
    ?? priorities.find((p) => p.id === "movement")
    ?? priorities.find((p) => p.id === "concentration")
    ?? priorities.find((p) => p.quadrant === "fix_first")
    ?? priorities[0]
    ?? null;
}

export function buildBusinessReport({ sources, profile = {}, options = {}, policies = [], now = new Date() }) {
  const eligible = sources.filter((s) => s.cube?.metrics?.length);
  if (!eligible.length) return null;
  const selected = options.source ? eligible.find((s) => s.id === options.source) : [...eligible].sort((a, b) => String(b.confirmedAt).localeCompare(String(a.confirmedAt)))[0];
  if (!selected) throw new AuthError("Report source not found.", "NOT_FOUND");
  const metric = options.metric ? selected.cube.metrics.find((m) => m.column === options.metric) : selected.cube.metrics[0];
  if (!metric) fail("Choose a metric available in the selected source.");
  const dateColumn = options.dateColumn || metric.dates[0]?.column || null;
  if (dateColumn && !metric.dates.some((d) => d.column === dateColumn)) fail("Choose a date field available in this source.");
  const limitations = [];
  const accepted = selectSources(eligible, selected, metric.column, dateColumn, limitations);
  // Clone aggregate metadata before combining disjoint extracts; cached cubes stay immutable.
  const periods = combinedPeriods(structuredClone(accepted));
  const current = options.period ? periods.find((p) => p.period === options.period) : periods.at(-1);
  if (!current) fail("Choose an observed reporting period.");
  const previousPeriods = periods.filter((p) => p.period < current.period);
  const previous = options.compare === "none" ? null : options.compare ? previousPeriods.find((p) => p.period === options.compare) : previousPeriods.at(-1) ?? null;
  if (options.compare && options.compare !== "none" && !previous) fail("Choose an earlier observed comparison period.");
  const policy = policies.filter((p) => p.seriesKey === selected.seriesKey && p.column === metric.column).sort((a, b) => b.version - a.version)[0] ?? null;
  const metricLabel = policy?.label ?? metric.label;
  const unit = policy?.unit ?? metric.unitHint;
  const currency = profile?.primaryCurrency || "USD";
  const fmt = (value) => compactValue(value, unit, currency);
  const relevant = accepted.filter(({ source }) => current.sourceIds.includes(source.id) || previous?.sourceIds.includes(source.id));
  const invalidDates = relevant.reduce((sum, e) => sum + (e.dates?.invalidRows ?? 0), 0);
  const missingMetric = relevant.reduce((sum, e) => sum + e.item.all.missing + e.item.all.invalid, 0);
  if (invalidDates) limitations.push({ code: "INVALID_DATES", message: `${invalidDates} source row(s) have missing, invalid or ambiguous dates. They are excluded from date-based analysis.` });
  if (missingMetric) limitations.push({ code: "MISSING_METRIC", message: `${missingMetric} source row(s) have missing or invalid amounts. Missing amounts are not converted to zero.` });
  if (dateColumn && relevant.some((e) => e.dates && (e.dates.first.slice(0, 7) !== e.source.period || e.dates.last.slice(0, 7) !== e.source.period))) limitations.push({ code: "DECLARED_PERIOD_MISMATCH", message: "The dates inside the source do not match its upload month. This report uses the actual record dates, not the month entered during upload." });
  if (!dateColumn) limitations.push({ code: "NO_DATE_FIELD", message: "No unambiguous ISO date field is available. Only declared upload periods can be compared; within-period timing is unknown." });
  if (metric.dates.length > 1) limitations.push({ code: "DATE_CHOICE", message: `This source contains multiple dates. The report currently uses ${dateColumn}; selecting another date changes the analysis.` });
  if (!policy) limitations.push({ code: "MAPPING_UNCONFIRMED", message: "The selected column is not yet an approved business KPI. Confirm its meaning before favorable or adverse labels are assigned." });
  if (current.partial || previous?.partial) limitations.push({ code: "PARTIAL_PERIOD", message: "A boundary period starts after the first day or ends before the last day of its month. The observed total may represent a partial period; direct comparisons need a coverage check." });
  if (previous && monthIndex(current.period) - monthIndex(previous.period) !== 1) limitations.push({ code: "NON_ADJACENT_COMPARISON", message: "These are not consecutive months. The comparison is between the selected periods, not month-on-month growth." });
  if (!previous) limitations.push({ code: "NO_COMPARISON", message: "No earlier period is selected. Movement and recurring strengths cannot yet be assessed." });
  if (previous && parseReportNumber(previous.value) <= 0n) limitations.push({ code: "NONPOSITIVE_BASE", message: "The comparison value is zero or negative. Percentage change is not meaningful; the absolute movement is retained." });
  if (selected.cube.omittedDimensions?.length) limitations.push({ code: "DIMENSION_LIMIT", message: `Some fields have too many categories or exceed the report's dimension limit: ${selected.cube.omittedDimensions.join(", ")}. They are not silently combined.` });
  limitations.push({ code: "SOURCE_SCOPE", message: "Verified calculations describe the supplied records. They do not establish that all business activity was supplied, or explain causation." });
  const comparison = previous ? change(current.value, previous.value) : null;
  const blocked = Boolean(current.partial || previous?.partial || invalidDates || current.missing || current.invalid || previous?.missing || previous?.invalid);
  const evidenceQuality = { level: blocked ? "limited_evidence" : policy && previous && accepted.every((e) => e.source.checksum) ? "high_evidence" : "moderate_evidence",
    label: blocked ? "Limited evidence" : policy && previous && accepted.every((e) => e.source.checksum) ? "High evidence" : "Moderate evidence",
    reason: blocked ? "Coverage or missing values restrict interpretation." : !policy ? "Calculations are traceable; business meaning still needs confirmation." : !previous ? "A traceable baseline is available, but a comparison is missing." : "Approved metric, traceable sources and comparable observed periods. This is evidence coverage, not statistical confidence." };
  const dimension = options.dimension || current.dimensions[0]?.column || null;
  if (dimension && !current.dimensions.some((d) => d.column === dimension)) fail("Choose a dimension available in the selected period.");
  const drivers = dimension ? decompose(current, previous, dimension) : null;
  if (!drivers) limitations.push({ code: "NO_DIMENSIONS", message: "No reusable product, channel, region or segment dimension exists for this metric. Contribution analysis is unavailable." });
  const timeline = [];
  const historical = periods.filter((p) => p.period <= current.period);
  if (monthIndex(current.period) - monthIndex(historical[0].period) > 239) fail("Choose a history spanning fewer than twenty years.");
  for (let index = monthIndex(historical[0].period); index <= monthIndex(current.period); index += 1) {
    const period = monthFromIndex(index);
    const point = historical.find((p) => p.period === period);
    timeline.push(point ? { period, value: point.value, rows: point.rows, partial: point.partial, missing: point.missing, invalid: point.invalid } : { period, value: null, rows: null, partial: false, missing: 0, invalid: 0 });
  }
  if (timeline.some((p) => p.value === null)) limitations.push({ code: "MISSING_PERIODS", message: "Gaps in the historical chart are missing periods, not zero performance. No line bridges an unobserved month." });
  const trend = trendSummary(timeline, current, { ...policy, label: metricLabel }, blocked);
  const { health, priorities, strengths } = buildFindings({ current, previous, comparison, policy, blocked, drivers, trend, metricLabel, fmt, quality: evidenceQuality.label });
  const leading = drivers?.entries[0];
  const firstAgendaItem = agendaPriority(priorities);
  const direction = comparison?.direction === "up" ? "rose" : comparison?.direction === "down" ? "fell" : "held steady";
  const executive = {
    headline: blocked ? `${metricLabel}: resolve the coverage question first` : !comparison ? `${metricLabel}: a starting point, with the mix in view` : `${metricLabel} ${direction}${leading && drivers.hasComparison ? `, with ${leading.name} contributing the largest movement` : " in the selected period"}`,
    story: comparison ? `In ${monthLabel(current.period)}, ${metricLabel.toLowerCase()} ${direction} compared with ${monthLabel(previous.period)}. ${leading && drivers.hasComparison ? `${leading.name} contributed the largest absolute change within ${drivers.label.toLowerCase()}.` : "The source has no comparable category breakdown to locate the change."} ${blocked ? "Check coverage before treating this as a change in business performance." : health === "deteriorating" ? "This is an area requiring attention under the confirmed metric definition." : health === "improving" ? "The direction supports the business's confirmed preference for this metric." : "Its business significance depends on the definition and operating context."}` : `The supplied records establish ${metricLabel.toLowerCase()} for ${monthLabel(current.period)}. ${leading ? `${leading.name} is the largest observed category within ${drivers.label.toLowerCase()}.` : "No category breakdown is available."} A comparable earlier period is needed to explain movement.`,
    focus: firstAgendaItem?.investigation,
    protect: strengths[0]?.explanation ?? "No sustained strength is established yet. A single favorable movement is not enough to justify that label.",
    watch: trend.unusual ? "Check this unusually large or small observation against operational events and the source extract." : `Track the same metric and ${drivers ? drivers.label.toLowerCase() : "source coverage"} in the next comparable period.`,
  };
  const daily = accepted.flatMap((e) => e.dates?.daily ?? []).filter((d) => d.date.startsWith(current.period)).sort((a, b) => a.date.localeCompare(b.date));
  const heatmap = drivers ? drivers.entries.slice(0, 8).map((entry) => ({ name: entry.name, values: historical.slice(-6).map((p) => ({ period: p.period, value: p.dimensions.find((d) => d.column === dimension)?.entries.find((e) => e.name === entry.name)?.value ?? "0" })) })) : [];
  const revenueBreakdown = buildRevenueBreakdown({ accepted, current, previous, policy, metric, currency, dateColumn, blocked });
  const report = {
    version: REPORT_VERSION, id: `evidence_${selected.id}`, sourceId: selected.id, seriesKey: selected.seriesKey,
    organizationName: profile?.legalName || profile?.tradingName || "Business report", title: "Performance evidence report", generatedAt: now.toISOString(),
    metric: { column: metric.column, label: metricLabel, unit, currency, policy },
    controls: { sources: eligible.map((s) => ({ id: s.id, name: s.fileName, series: s.dataSeries || s.seriesKey })), metrics: selected.cube.metrics.map((m) => ({ column: m.column, label: m.label, unitHint: m.unitHint })), dates: metric.dates.map((d) => ({ column: d.column, label: label(d.column) })), dateColumn, periods: periods.map((p) => p.period), dimensions: current.dimensions.map((d) => ({ column: d.column, label: d.label })), dimension },
    current: { period: current.period, value: current.value, rows: current.rows, first: current.first, last: current.last, observedDays: current.observedDays, partial: current.partial },
    previous: previous ? { period: previous.period, value: previous.value, rows: previous.rows, partial: previous.partial } : null,
    comparison, timeline, daily, drivers, heatmap, trend, executive, health, priorities, strengths, evidenceQuality, limitations, revenueBreakdown,
    evidence: { calculation: `sum(${metric.column})`, dateColumn, aggregation: "sum", mappingVersion: policy?.version ?? null, sourceRows: accepted.reduce((s, e) => s + e.source.cube.rowCount, 0), contributingRows: current.rows,
      sources: accepted.map(({ source }) => ({ id: source.id, fileName: source.fileName, checksum: source.checksum, rawDataObjectId: source.rawDataObjectId ?? null, metricPointId: source.metricPointIds?.[metric.column] ?? null, confirmedAt: source.confirmedAt, declaredPeriod: source.period, rowCount: source.cube.rowCount })),
      policy: "All observations are grouped by the selected ISO source date. Sums use decimal fixed-point arithmetic. Missing periods remain gaps. Higher/lower assessments require owner confirmation. A persistent strength needs three consecutive observed months, two favorable movements, complete known metric/date coverage and no partial boundary month.",
      priorityPolicy: `A movement reaches the materiality threshold at ${policy?.materialityPercent ?? 5}%. High-impact adverse movement is Fix first; favorable movement is Build on; unclassified movement is Monitor. A leading category that opposes the total stays Monitor, not the total's favorable/adverse label. Coverage and definition issues take precedence. Concentration is reviewed at a 50% share, only for nonnegative contributions.`,
    },
  };
  report.explainer = buildReportExplainer(report);
  return report;
}
