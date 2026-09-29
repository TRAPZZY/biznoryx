import { isAdditiveReportColumn } from "./evidence-engine.mjs";

const preferredMetrics = ["net_sales", "revenue", "sales", "gross_sales", "profit", "cost_amount", "cost", "total_amount", "amount", "quantity"];

export function reportSourcesFromSeries(series) {
  const sources = new Map();
  for (const metric of series) {
    if (metric.aggregation !== "sum" || !isAdditiveReportColumn(metric.sourceColumn)) continue;
    for (const point of metric.points) {
      const evidence = point.evidence ?? {};
      const analytics = evidence.reportAnalytics;
      const source = sources.get(point.ingestionRunId) ?? {
        id: point.ingestionRunId, seriesKey: metric.dataStream.id,
        dataSeries: metric.dataStream.displayName,
        period: String(point.periodStart instanceof Date ? point.periodStart.toISOString() : point.periodStart).slice(0, 7),
        fileName: evidence.fileName || metric.dataStream.displayName,
        checksum: evidence.checksumSha256 ?? null,
        rawDataObjectId: point.rawDataObjectId, metricPointIds: {},
        confirmedAt: point.createdAt,
        cube: { version: "evidence-v2", rowCount: point.sourceRowCount, schemaFingerprint: analytics?.schemaFingerprint ?? metric.dataStream.id, omittedDimensions: analytics?.omittedDimensions ?? [], metrics: [] },
      };
      source.metricPointIds[metric.sourceColumn] = point.id;
      source.cube.metrics.push(analytics?.metric ?? {
        column: metric.sourceColumn, label: metric.label,
        unitHint: metric.unit === "currency" ? "currency" : "number",
        all: { period: "all", value: point.value, rows: point.contributingRowCount,
          missing: point.sourceRowCount - point.contributingRowCount, invalid: 0,
          first: null, last: null, observedDays: 0, hasNegativeValues: Number(point.value) < 0, dimensions: [] },
        dates: [],
      });
      sources.set(source.id, source);
    }
  }
  return [...sources.values()].map((source) => ({
    ...source,
    cube: {
      ...source.cube,
      metrics: [...source.cube.metrics].sort((a, b) => metricRank(a.column) - metricRank(b.column) || a.column.localeCompare(b.column)),
    },
  }));
}

function metricRank(column) {
  const rank = preferredMetrics.indexOf(String(column).toLowerCase().replaceAll(" ", "_"));
  return rank < 0 ? 50 : rank;
}
