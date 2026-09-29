import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export function createTrendStoreShape(store) {
  store.metricPeriodComparisons ??= new Map();
  store.metricTrendSummaries ??= new Map();
  return store;
}

export class HistoricalTrendService {
  constructor(store, auditLog) {
    this.store = createTrendStoreShape(store);
    this.auditLog = auditLog;
  }

  compareLatestPeriod({ organizationId, actorUserId, kpiDefinitionId }) {
    this.requireWrite({ organizationId, actorUserId });
    const kpi = this.requireOwned(this.store.kpiDefinitions, organizationId, kpiDefinitionId, 'KPI definition not found.');
    const runs = metricRunsForKpi(this.store, organizationId, kpi.id);
    const current = runs.at(-1);
    if (!current) throw new AuthError('No verified metric runs exist for this KPI.', 'COMPARISON_NOT_READY');
    const previous = runs.at(-2) ?? null;
    const comparison = previous
      ? calculatedComparison({ organizationId, actorUserId, kpi, current, previous })
      : notReadyComparison({ organizationId, actorUserId, kpi, current });
    this.store.metricPeriodComparisons.set(comparison.id, comparison);
    this.auditLog?.record({ organizationId, actorUserId, eventType: `metric_comparison.${comparison.status}`, targetType: 'metric_period_comparison', targetId: comparison.id });
    return comparison;
  }

  summarizeTrend({ organizationId, actorUserId, kpiDefinitionId }) {
    this.requireWrite({ organizationId, actorUserId });
    const kpi = this.requireOwned(this.store.kpiDefinitions, organizationId, kpiDefinitionId, 'KPI definition not found.');
    const runs = metricRunsForKpi(this.store, organizationId, kpi.id);
    const summary = buildTrendSummary({ organizationId, actorUserId, kpi, runs });
    this.store.metricTrendSummaries.set(summary.id, summary);
    this.auditLog?.record({ organizationId, actorUserId, eventType: `metric_trend.${summary.status}`, targetType: 'metric_trend_summary', targetId: summary.id });
    return summary;
  }

  getTrendState({ organizationId, actorUserId, kpiDefinitionId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    const comparisons = [...this.store.metricPeriodComparisons.values()].filter((item) => item.organizationId === organizationId && item.kpiDefinitionId === kpiDefinitionId);
    const summaries = [...this.store.metricTrendSummaries.values()].filter((item) => item.organizationId === organizationId && item.kpiDefinitionId === kpiDefinitionId);
    return {
      state: summaries.at(-1)?.status === 'calculated' ? 'ready' : 'not_ready',
      latestComparison: comparisons.at(-1) ?? null,
      latestSummary: summaries.at(-1) ?? null
    };
  }

  requireWrite({ organizationId, actorUserId }) {
    return new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.WRITE_BUSINESS_DATA });
  }

  requireOwned(map, organizationId, id, message) {
    const record = map?.get(id);
    if (!record || record.organizationId !== organizationId) throw new AuthError(message, 'NOT_FOUND');
    return record;
  }
}

export function calculateChange(currentValue, previousValue) {
  const absoluteChange = currentValue - previousValue;
  const percentChange = previousValue === 0 ? null : (absoluteChange / Math.abs(previousValue)) * 100;
  return {
    absoluteChange,
    percentChange,
    direction: absoluteChange > 0 ? 'up' : absoluteChange < 0 ? 'down' : 'flat'
  };
}

function calculatedComparison({ organizationId, actorUserId, kpi, current, previous }) {
  const change = calculateChange(Number(current.value), Number(previous.value));
  return {
    id: randomUUID(),
    organizationId,
    kpiDefinitionId: kpi.id,
    currentMetricRunId: current.id,
    previousMetricRunId: previous.id,
    currentReportingPeriodId: current.reportingPeriodId,
    previousReportingPeriodId: previous.reportingPeriodId,
    status: 'calculated',
    currentValue: current.value,
    previousValue: previous.value,
    absoluteChange: change.absoluteChange,
    percentChange: change.percentChange,
    direction: change.direction,
    readiness: { periodComparison: 'ready' },
    evidence: { currentMetricRunId: current.id, previousMetricRunId: previous.id },
    createdByUserId: actorUserId,
    createdAt: new Date()
  };
}

function notReadyComparison({ organizationId, actorUserId, kpi, current }) {
  return {
    id: randomUUID(),
    organizationId,
    kpiDefinitionId: kpi.id,
    currentMetricRunId: current.id,
    previousMetricRunId: null,
    currentReportingPeriodId: current.reportingPeriodId,
    previousReportingPeriodId: null,
    status: 'not_ready',
    currentValue: current.value,
    previousValue: null,
    absoluteChange: null,
    percentChange: null,
    direction: 'unknown',
    readiness: { periodComparison: 'not_enough_history', requiredPoints: 2, actualPoints: 1 },
    evidence: { currentMetricRunId: current.id },
    createdByUserId: actorUserId,
    createdAt: new Date()
  };
}

function buildTrendSummary({ organizationId, actorUserId, kpi, runs }) {
  if (runs.length < 2) {
    return {
      id: randomUUID(),
      organizationId,
      kpiDefinitionId: kpi.id,
      status: 'not_ready',
      points: runs.length,
      direction: 'unknown',
      latestMetricRunId: runs.at(-1)?.id ?? null,
      summary: 'Not enough verified history for a trend.',
      evidence: { requiredPoints: 2, actualPoints: runs.length },
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
  }
  const first = runs[0];
  const latest = runs.at(-1);
  const change = calculateChange(Number(latest.value), Number(first.value));
  return {
    id: randomUUID(),
    organizationId,
    kpiDefinitionId: kpi.id,
    status: 'calculated',
    points: runs.length,
    direction: change.direction,
    latestMetricRunId: latest.id,
    summary: `${kpi.name} is ${change.direction} across ${runs.length} verified periods.`,
    evidence: { firstMetricRunId: first.id, latestMetricRunId: latest.id, absoluteChange: change.absoluteChange, percentChange: change.percentChange },
    createdByUserId: actorUserId,
    createdAt: new Date()
  };
}

function metricRunsForKpi(store, organizationId, kpiDefinitionId) {
  const periods = store.reportingPeriods ?? new Map();
  return [...store.verifiedMetricRuns.values()]
    .filter((run) => run.organizationId === organizationId && run.kpiDefinitionId === kpiDefinitionId && run.status === 'calculated')
    .sort((a, b) => {
      const periodA = periods.get(a.reportingPeriodId)?.periodStart ?? '';
      const periodB = periods.get(b.reportingPeriodId)?.periodStart ?? '';
      return periodA.localeCompare(periodB);
    });
}
