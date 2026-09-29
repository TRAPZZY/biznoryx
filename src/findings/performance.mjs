import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export function createFindingStoreShape(store) {
  store.performanceFindings ??= new Map();
  store.findingEvidence ??= new Map();
  return store;
}

export class PerformanceFindingService {
  constructor(store, auditLog) {
    this.store = createFindingStoreShape(store);
    this.auditLog = auditLog;
  }

  generateFindingsForComparison({ organizationId, actorUserId, metricPeriodComparisonId }) {
    this.requireWrite({ organizationId, actorUserId });
    const comparison = this.requireOwned(this.store.metricPeriodComparisons, organizationId, metricPeriodComparisonId, 'Metric comparison not found.');
    if (comparison.status !== 'calculated') throw new AuthError('Findings require a calculated comparison.', 'FINDING_NOT_READY');
    const kpi = this.requireOwned(this.store.kpiDefinitions, organizationId, comparison.kpiDefinitionId, 'KPI definition not found.');
    const signal = this.createFinding({
      organizationId,
      actorUserId,
      kpi,
      comparison,
      kind: 'statistical_signal',
      severity: severityForChange(comparison.percentChange),
      title: `${kpi.name} moved ${comparison.direction}`,
      explanation: `${kpi.name} changed by ${comparison.absoluteChange} from the previous verified period. This is a verified period-over-period signal, not a causation claim.`
    });
    const directional = comparison.direction === 'down'
      ? this.createFinding({
        organizationId,
        actorUserId,
        kpi,
        comparison,
        kind: 'risk',
        severity: severityForChange(comparison.percentChange),
        title: `${kpi.name} decline requires review`,
        explanation: `${kpi.name} declined versus the previous verified period. Review related business events, data quality, and operating changes before assigning cause.`
      })
      : comparison.direction === 'up'
        ? this.createFinding({
          organizationId,
          actorUserId,
          kpi,
          comparison,
          kind: 'opportunity',
          severity: severityForChange(comparison.percentChange),
          title: `${kpi.name} improvement may be repeatable`,
          explanation: `${kpi.name} improved versus the previous verified period. Identify confirmed drivers before scaling any action.`
        })
        : null;
    const recommendation = this.createFinding({
      organizationId,
      actorUserId,
      kpi,
      comparison,
      kind: 'recommendation',
      severity: 'medium',
      title: `Investigate ${kpi.name} movement`,
      explanation: `Compare business events, channel mix, product/service performance, and data health for the two verified periods. Treat any driver as a hypothesis until supported by evidence.`
    });
    return [signal, directional, recommendation].filter(Boolean);
  }

  listFindings({ organizationId, actorUserId, kind = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return [...this.store.performanceFindings.values()]
      .filter((finding) => finding.organizationId === organizationId)
      .filter((finding) => !kind || finding.kind === kind)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  createFinding({ organizationId, actorUserId, kpi, comparison, kind, severity, title, explanation }) {
    const finding = {
      id: randomUUID(),
      organizationId,
      kpiDefinitionId: kpi.id,
      metricPeriodComparisonId: comparison.id,
      kind,
      severity,
      status: 'open',
      title,
      explanation,
      evidence: {
        comparisonId: comparison.id,
        currentMetricRunId: comparison.currentMetricRunId,
        previousMetricRunId: comparison.previousMetricRunId,
        direction: comparison.direction,
        absoluteChange: comparison.absoluteChange,
        percentChange: comparison.percentChange
      },
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.performanceFindings.set(finding.id, finding);
    const evidenceId = randomUUID();
    this.store.findingEvidence.set(evidenceId, {
      id: evidenceId,
      organizationId,
      findingId: finding.id,
      evidenceType: 'metric_period_comparison',
      evidenceId: comparison.id,
      label: `${kpi.name} verified comparison`,
      metadata: finding.evidence,
      createdAt: new Date()
    });
    this.auditLog?.record({ organizationId, actorUserId, eventType: `performance_finding.${kind}.created`, targetType: 'performance_finding', targetId: finding.id });
    return finding;
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

export function severityForChange(percentChange) {
  if (percentChange === null || percentChange === undefined) return 'medium';
  const magnitude = Math.abs(percentChange);
  if (magnitude >= 20) return 'high';
  if (magnitude >= 5) return 'medium';
  return 'low';
}
