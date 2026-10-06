import { parseReportNumber as number, reportDecimal as decimal, SCALE } from "./decimal.mjs";

const method = "Matched products: price uses current quantities at the prior realized prices; total volume uses the prior product mix; mix is the remaining matched-product movement. Products with first or no recorded sales are separated. Effects use exact fractions, rounded to ten decimal places with any residual shown separately. This is an arithmetic explanation, not proof of cause.";
const definitions = [
  ["price", "Realized price", "Money received per unit changed, measured at current quantities. Discounts can affect this average; it is not necessarily the list price."],
  ["volume", "Total quantity", "More or fewer units sold, valued at the previous average price and product mix for matched products."],
  ["mix", "Product mix", "The share of units shifted between higher- and lower-priced matched products, using previous realized prices."],
  ["first_sales", "First recorded sales", "Revenue from products with no recorded units in the comparison period. This does not mean the products are newly launched."],
  ["no_sales", "No recorded sales", "Previous revenue from products with no recorded units this period. This does not mean the products were discontinued."],
];
function gcd(a, b) { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a || 1n; }
function fraction(n, d = 1n) { const g = gcd(n, d); return { n: n / g, d: d / g }; }
function add(a, b) { return fraction(a.n * b.d + b.n * a.d, a.d * b.d); }
function rounded({ n, d }) { const sign = n < 0n ? -1n : 1n; const a = n < 0n ? -n : n; return sign * ((a + d / 2n) / d); }

export function buildRevenueBreakdown({ accepted, current, previous, policy, metric, currency, dateColumn, blocked }) {
  const unavailable = (status, reason) => ({ status, reason, effects: [], products: [], reconciled: false });
  const mapping = policy?.revenueBreakdown;
  if (mapping?.confirmed !== true) return unavailable("unconfigured", "Confirm a revenue column, stable product identifier and a shared quantity unit in the metric definition first.");
  if (policy.unit !== "currency" || mapping.currency !== currency) return unavailable("insufficient_evidence", "The approved revenue currency no longer matches the report. Reapprove the definition before comparing prices.");
  if (!previous) return unavailable("insufficient_evidence", "Select a comparable earlier period to separate price, quantity and product mix.");
  if (!dateColumn) return unavailable("insufficient_evidence", "Revenue and quantity need the same ISO date field to check comparable period coverage. A declared upload month alone is not enough.");
  if (blocked) return unavailable("insufficient_evidence", "Resolve incomplete dates or missing revenue before separating the revenue movement.");
  const relevant = accepted.filter(({ source }) => current.sourceIds.includes(source.id) || previous.sourceIds.includes(source.id));
  const buckets = new Map([[previous.period, []], [current.period, []]]);
  for (const { source, item, dates } of relevant) {
    const quantity = source.cube.metrics.find((m) => m.column === mapping.quantityColumn);
    if (!quantity || quantity.column === metric.column) return unavailable("insufficient_evidence", "An included source lacks the approved quantity column. Reconcile the source mapping.");
    const quantityDates = dateColumn ? quantity.dates.find((d) => d.column === dateColumn) : null;
    if (dateColumn && (!quantityDates || quantityDates.invalidRows)) return unavailable("insufficient_evidence", "Quantity and revenue need complete coverage using the same date field.");
    for (const period of buckets.keys()) {
      const revenueBucket = dates ? dates.months.find((b) => b.period === period) : source.period === period ? item.all : null;
      if (!revenueBucket) continue;
      const quantityBucket = dateColumn ? quantityDates.months.find((b) => b.period === period) : quantity.all;
      if (!quantityBucket || quantityBucket.missing || quantityBucket.invalid || revenueBucket.missing || revenueBucket.invalid || quantityBucket.rows !== revenueBucket.rows) return unavailable("insufficient_evidence", "Every included revenue row needs a valid quantity. Missing quantities are not treated as zero.");
      if (revenueBucket.hasNegativeValues || quantityBucket.hasNegativeValues) return unavailable("unsupported", "Negative revenue or quantities can represent refunds or adjustments. Reconcile these separately before interpreting price and volume.");
      const revenueEntries = revenueBucket.dimensions.find((d) => d.column === mapping.productColumn)?.entries;
      const quantityEntries = quantityBucket.dimensions.find((d) => d.column === mapping.productColumn)?.entries;
      if (!revenueEntries || !quantityEntries || revenueEntries.some((e) => e.name === "(Unspecified)")) return unavailable("insufficient_evidence", "A stable product identifier is missing or unavailable in an included source.");
      if (revenueEntries.reduce((sum, e) => sum + number(e.value), 0n) !== number(revenueBucket.value) || quantityEntries.reduce((sum, e) => sum + number(e.value), 0n) !== number(quantityBucket.value)) return unavailable("insufficient_evidence", "Product totals do not reconcile to the included revenue and quantities.");
      for (const entry of revenueEntries) {
        const q = quantityEntries.find((e) => e.name === entry.name);
        if (!q || q.rows !== entry.rows) return unavailable("insufficient_evidence", "Product quantities and revenue do not describe the same records.");
        buckets.get(period).push({ name: entry.name, revenue: number(entry.value), quantity: number(q.value) });
      }
    }
  }
  const totals = (entries) => {
    const result = new Map();
    for (const entry of entries) {
      const old = result.get(entry.name) ?? { revenue: 0n, quantity: 0n };
      result.set(entry.name, { revenue: old.revenue + entry.revenue, quantity: old.quantity + entry.quantity });
    }
    return result;
  };
  const before = totals(buckets.get(previous.period));
  const now = totals(buckets.get(current.period));
  if ([...before.values()].reduce((sum, p) => sum + p.revenue, 0n) !== number(previous.value) || [...now.values()].reduce((sum, p) => sum + p.revenue, 0n) !== number(current.value)) return unavailable("insufficient_evidence", "The product revenue does not reconcile to the report's selected totals. Reconcile the source aggregates before interpreting effects.");
  const names = [...new Set([...before.keys(), ...now.keys()])].sort();
  if (names.length > 80) return unavailable("insufficient_evidence", "The comparison exceeds the supported 80-product detail limit. Select a narrower, consistently mapped source.");
  let price = fraction(0n), priorRevenue = 0n, priorQuantity = 0n, newQuantity = 0n, matchedChange = 0n, firstSales = 0n, noSales = 0n;
  const products = [];
  for (const name of names) {
    const a = before.get(name) ?? { revenue: 0n, quantity: 0n };
    const b = now.get(name) ?? { revenue: 0n, quantity: 0n };
    if (a.quantity < 0n || b.quantity < 0n || a.revenue < 0n || b.revenue < 0n || (!a.quantity && a.revenue) || (!b.quantity && b.revenue)) return unavailable("unsupported", "Revenue without positive quantities cannot establish a realized unit price. Reconcile free units, adjustments and quantity definitions first.");
    if (a.quantity && b.quantity) {
      price = add(price, fraction(b.revenue * a.quantity - a.revenue * b.quantity, a.quantity));
      priorRevenue += a.revenue; priorQuantity += a.quantity; newQuantity += b.quantity; matchedChange += b.revenue - a.revenue;
    } else if (b.quantity) firstSales += b.revenue;
    else if (a.quantity) noSales -= a.revenue;
    products.push({ name, previousRevenue: decimal(a.revenue), currentRevenue: decimal(b.revenue), previousQuantity: decimal(a.quantity), currentQuantity: decimal(b.quantity), previousPrice: a.quantity ? decimal(rounded(fraction(a.revenue * SCALE, a.quantity))) : null, currentPrice: b.quantity ? decimal(rounded(fraction(b.revenue * SCALE, b.quantity))) : null });
  }
  const volume = priorQuantity ? fraction((newQuantity - priorQuantity) * priorRevenue, priorQuantity) : fraction(0n);
  const mix = add(add(fraction(matchedChange), fraction(-price.n, price.d)), fraction(-volume.n, volume.d));
  const values = [rounded(price), rounded(volume), rounded(mix), firstSales, noSales];
  const totalChange = number(current.value) - number(previous.value);
  const effects = definitions.map(([id, label, explanation], i) => ({ id, label, explanation, value: decimal(values[i]) }));
  const residual = totalChange - values.reduce((sum, v) => sum + v, 0n);
  if (residual < -2n || residual > 2n) return unavailable("insufficient_evidence", "The calculated effects do not reconcile within decimal rounding. Review the source aggregates.");
  if (residual) effects.push({ id: "rounding", label: "Decimal rounding", value: decimal(residual), explanation: "Residual from rounding individual effects to ten decimal places; retained so the change reconciles exactly." });
  return { status: "ready", totalChange: decimal(totalChange), previousQuantity: decimal([...before.values()].reduce((s, p) => s + p.quantity, 0n)), currentQuantity: decimal([...now.values()].reduce((s, p) => s + p.quantity, 0n)), quantityUnit: mapping.quantityUnit, effects, products, reconciled: true, method,
    evidence: { definitionVersion: policy.version, ...mapping, revenueColumn: metric.column, dateColumn, previousPeriod: previous.period, currentPeriod: current.period, sources: relevant.map(({ source }) => ({ id: source.id, checksum: source.checksum, rawDataObjectId: source.rawDataObjectId ?? null, revenueMetricPointId: source.metricPointIds?.[metric.column] ?? null, quantityMetricPointId: source.metricPointIds?.[mapping.quantityColumn] ?? null })) } };
}
