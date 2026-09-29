import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export function createDashboardStoreShape(store) {
  store.dashboardSnapshots ??= new Map();
  store.dashboardSnapshotMetrics ??= new Map();
  return store;
}

export class BaselineDashboardService {
  constructor(store, auditLog) {
    this.store = createDashboardStoreShape(store);
    this.auditLog = auditLog;
  }

  buildDashboard({ organizationId, actorUserId, businessProfileId, reportingPeriodId = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    const profile = this.requireOwned(this.store.businessProfiles, organizationId, businessProfileId, 'Business profile not found.');
    if (profile.status !== 'completed') throw new AuthError('Business onboarding must be completed before dashboard generation.', 'DASHBOARD_NOT_READY');
    const metricRuns = this.metricRunsForPeriod(organizationId, reportingPeriodId);
    const kpis = this.kpiRows(organizationId, metricRuns);
    const dataHealth = this.dataHealth(organizationId);
    const findings = this.findingRows(organizationId);
    const actions = this.actionRows(organizationId);
    const outcomes = this.outcomeRows(organizationId);
    const reports = this.reportRows(organizationId);
    const integrations = this.integrationRows(organizationId);
    const alerts = this.alertRows(organizationId);
    const forecasts = this.forecastRows(organizationId);
    const enterprise = this.enterpriseRows(organizationId);
    const summary = {
      businessName: profile.tradingName ?? profile.legalName,
      reportingPeriodId,
      pulse: businessPulse(kpis, dataHealth),
      modules: relevantModules({ kpis, dataHealth, findings, actions, outcomes, reports, integrations, alerts, forecasts, enterprise, store: this.store, organizationId })
    };
    const snapshot = {
      id: randomUUID(),
      organizationId,
      businessProfileId,
      reportingPeriodId,
      status: dataHealth.status === 'healthy' ? 'generated' : 'stale',
      generatedByUserId: actorUserId,
      generatedAt: new Date(),
      summary,
      dataHealth,
      evidence: metricRuns.map((run) => ({ verifiedMetricRunId: run.id, ingestionRunId: run.ingestionRunId, kpiDefinitionId: run.kpiDefinitionId }))
    };
    this.store.dashboardSnapshots.set(snapshot.id, snapshot);
    for (const row of kpis) {
      const id = randomUUID();
      this.store.dashboardSnapshotMetrics.set(id, {
        id,
        organizationId,
        dashboardSnapshotId: snapshot.id,
        kpiDefinitionId: row.kpiDefinitionId,
        verifiedMetricRunId: row.verifiedMetricRunId,
        label: row.label,
        value: row.value,
        unit: row.unit,
        status: row.status,
        evidence: row.evidence,
        createdAt: new Date()
      });
    }
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'dashboard_snapshot.generated', targetType: 'dashboard_snapshot', targetId: snapshot.id });
    return {
      state: kpis.length === 0 ? 'empty' : 'ready',
      snapshot,
      kpis,
      dataHealth,
      trends: this.trendRows(organizationId),
      findings,
      actions,
      outcomes,
      reports,
      integrations,
      alerts,
      forecasts,
      enterprise,
      risks: [...dataHealth.risks, ...findings.filter((finding) => finding.kind === 'risk').map((finding) => finding.title)],
      opportunities: findings.filter((finding) => finding.kind === 'opportunity')
    };
  }

  getDashboardSnapshot({ organizationId, actorUserId, dashboardSnapshotId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    const snapshot = this.requireOwned(this.store.dashboardSnapshots, organizationId, dashboardSnapshotId, 'Dashboard snapshot not found.');
    const kpis = [...this.store.dashboardSnapshotMetrics.values()].filter((row) => row.organizationId === organizationId && row.dashboardSnapshotId === snapshot.id);
    return { state: kpis.length === 0 ? 'empty' : 'ready', snapshot, kpis };
  }

  metricRunsForPeriod(organizationId, reportingPeriodId) {
    return [...this.store.verifiedMetricRuns.values()]
      .filter((run) => run.organizationId === organizationId && run.status === 'calculated')
      .filter((run) => !reportingPeriodId || run.reportingPeriodId === reportingPeriodId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  kpiRows(organizationId, metricRuns) {
    return metricRuns.map((run) => {
      const kpi = this.requireOwned(this.store.kpiDefinitions, organizationId, run.kpiDefinitionId, 'KPI definition not found.');
      return {
        kpiDefinitionId: kpi.id,
        verifiedMetricRunId: run.id,
        label: kpi.name,
        value: run.value,
        unit: kpi.valueType,
        status: run.value === null ? 'unavailable' : 'verified',
        evidence: { metricRunId: run.id, ingestionRunId: run.ingestionRunId, reportingPeriodId: run.reportingPeriodId }
      };
    });
  }

  dataHealth(organizationId) {
    const runs = [...(this.store.ingestionRuns?.values() ?? [])].filter((run) => run.organizationId === organizationId);
    const rejected = runs.filter((run) => run.status === 'rejected').length;
    const validated = runs.filter((run) => run.status === 'validated').length;
    const schemaWarnings = runs.filter((run) => ['potentially_compatible', 'breaking'].includes(run.schemaDrift)).length;
    const risks = [];
    if (runs.length === 0) risks.push('No ingestion runs exist.');
    if (rejected > 0) risks.push(`${rejected} ingestion run(s) rejected.`);
    if (schemaWarnings > 0) risks.push(`${schemaWarnings} schema drift issue(s) require attention.`);
    return {
      status: risks.length === 0 ? 'healthy' : 'attention',
      validatedRuns: validated,
      rejectedRuns: rejected,
      schemaWarnings,
      risks
    };
  }

  trendRows(organizationId) {
    const periodsById = this.store.reportingPeriods ?? new Map();
    const comparisons = [...(this.store.metricPeriodComparisons?.values() ?? [])]
      .filter((comparison) => comparison.organizationId === organizationId)
      .map((comparison) => ({
        reportingPeriodId: comparison.currentReportingPeriodId,
        label: periodsById.get(comparison.currentReportingPeriodId)?.label ?? 'Unknown period',
        value: comparison.currentValue,
        verifiedMetricRunId: comparison.currentMetricRunId,
        comparisonStatus: comparison.status,
        absoluteChange: comparison.absoluteChange,
        percentChange: comparison.percentChange,
        direction: comparison.direction
      }));
    if (comparisons.length > 0) return comparisons.sort((a, b) => a.label.localeCompare(b.label));
    return [...this.store.verifiedMetricRuns.values()]
      .filter((run) => run.organizationId === organizationId && run.status === 'calculated')
      .map((run) => ({
        reportingPeriodId: run.reportingPeriodId,
        label: periodsById.get(run.reportingPeriodId)?.label ?? 'Unknown period',
        value: run.value,
        verifiedMetricRunId: run.id,
        comparisonStatus: 'not_ready',
        absoluteChange: null,
        percentChange: null,
        direction: 'unknown'
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  findingRows(organizationId) {
    return [...(this.store.performanceFindings?.values() ?? [])]
      .filter((finding) => finding.organizationId === organizationId && finding.status === 'open')
      .map((finding) => ({
        id: finding.id,
        kind: finding.kind,
        severity: finding.severity,
        title: finding.title,
        explanation: finding.explanation,
        evidence: finding.evidence
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  actionRows(organizationId) {
    return [...(this.store.managementActions?.values() ?? [])]
      .filter((action) => action.organizationId === organizationId && action.status !== 'cancelled')
      .map((action) => ({
        id: action.id,
        findingId: action.findingId,
        ownerUserId: action.ownerUserId,
        title: action.title,
        status: action.status,
        dueDate: action.dueDate,
        successMetricKpiDefinitionId: action.successMetricKpiDefinitionId
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  outcomeRows(organizationId) {
    return [...(this.store.actionOutcomes?.values() ?? [])]
      .filter((outcome) => outcome.organizationId === organizationId)
      .map((outcome) => ({
        id: outcome.id,
        managementActionId: outcome.managementActionId,
        assessment: outcome.assessment,
        baselineValue: outcome.baselineValue,
        outcomeValue: outcome.outcomeValue,
        deltaValue: outcome.deltaValue,
        narrative: outcome.narrative,
        evidence: outcome.evidence
      }))
      .sort((a, b) => a.narrative.localeCompare(b.narrative));
  }

  reportRows(organizationId) {
    return [...(this.store.professionalReports?.values() ?? [])]
      .filter((report) => report.organizationId === organizationId && report.status === 'generated')
      .map((report) => ({
        id: report.id,
        title: report.title,
        summary: report.summary,
        generatedAt: report.generatedAt
      }))
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  }

  integrationRows(organizationId) {
    const runs = [...(this.store.integrationSyncRuns?.values() ?? [])].filter((run) => run.organizationId === organizationId);
    return [...(this.store.integrationConnections?.values() ?? [])]
      .filter((connection) => connection.organizationId === organizationId)
      .map((connection) => {
        const connectionRuns = runs.filter((run) => run.integrationConnectionId === connection.id);
        const latestRun = connectionRuns.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
        return {
          id: connection.id,
          providerKey: connection.providerKey,
          providerKind: connection.providerKind,
          displayName: connection.displayName,
          status: connection.status,
          lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
          latestSyncStatus: latestRun?.status ?? 'none'
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  alertRows(organizationId) {
    return [...(this.store.alertEvents?.values() ?? [])]
      .filter((event) => event.organizationId === organizationId && event.status !== 'resolved')
      .map((event) => ({
        id: event.id,
        status: event.status,
        severity: event.severity,
        title: event.title,
        message: event.message,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        triggeredAt: event.triggeredAt
      }))
      .sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt)));
  }

  forecastRows(organizationId) {
    return [...(this.store.forecastRuns?.values() ?? [])]
      .filter((run) => run.organizationId === organizationId)
      .map((run) => ({
        id: run.id,
        forecastModelId: run.forecastModelId,
        forecastScenarioId: run.forecastScenarioId,
        status: run.status,
        horizonPeriods: run.horizonPeriods,
        pointsUsed: run.pointsUsed,
        forecastValues: run.forecastValues,
        readiness: run.readiness,
        uncertainty: run.uncertainty
      }))
      .sort((a, b) => a.status.localeCompare(b.status));
  }

  enterpriseRows(organizationId) {
    const plans = [...(this.store.organizationPlans?.values() ?? [])].filter((plan) => plan.organizationId === organizationId);
    const windows = [...(this.store.organizationUsageWindows?.values() ?? [])].filter((window) => window.organizationId === organizationId);
    const blockedEvents = [...(this.store.rateLimitEvents?.values() ?? [])].filter((event) => event.organizationId === organizationId && event.decision === 'blocked');
    const jobs = [...(this.store.workerJobs?.values() ?? [])].filter((job) => job.organizationId === organizationId);
    if (plans.length === 0 && windows.length === 0 && jobs.length === 0 && blockedEvents.length === 0) return null;
    return {
      planName: plans.find((plan) => plan.status === 'active')?.name ?? null,
      usageWindows: windows.length,
      blockedEvents: blockedEvents.length,
      queuedJobs: jobs.filter((job) => job.status === 'queued').length,
      activeLeases: jobs.filter((job) => job.status === 'leased' && job.leaseExpiresAt > new Date()).length,
      failedJobs: jobs.filter((job) => job.status === 'failed').length
    };
  }

  requireOwned(map, organizationId, id, message) {
    const record = map?.get(id);
    if (!record || record.organizationId !== organizationId) throw new AuthError(message, 'NOT_FOUND');
    return record;
  }
}

export function dashboardShellState(dashboard) {
  if (!dashboard) return { state: 'loading' };
  if (dashboard.state === 'empty') return { state: 'empty', message: 'No verified metrics are available yet.' };
  if (dashboard.dataHealth.status !== 'healthy') return { state: 'attention', risks: dashboard.dataHealth.risks };
  return { state: 'ready' };
}

function businessPulse(kpis, dataHealth) {
  if (kpis.length === 0) return 'No verified KPI values are available for this reporting period.';
  const first = kpis[0];
  const healthText = dataHealth.status === 'healthy' ? 'Data health is healthy.' : 'Data health needs attention.';
  return `${first.label} is ${first.value} ${first.unit}. ${healthText}`;
}

function relevantModules({ kpis, dataHealth, findings, actions, outcomes, reports, integrations, alerts, forecasts, enterprise, store, organizationId }) {
  const modules = ['Business Pulse', 'KPI Scoreboard', 'Data Health'];
  if (kpis.length > 0) modules.push('Historical Trends');
  if ([...store.businessGoals.values()].some((goal) => goal.organizationId === organizationId)) modules.push('Targets vs Actual');
  if (dataHealth.risks.length > 0 || findings.some((finding) => finding.kind === 'risk')) modules.push('Risks');
  if (findings.some((finding) => finding.kind === 'opportunity')) modules.push('Opportunities');
  if (findings.some((finding) => finding.kind === 'recommendation')) modules.push('Focus Areas');
  if (actions.length > 0) modules.push('Actions');
  if (outcomes.length > 0) modules.push('Outcomes');
  if (reports.length > 0) modules.push('Reports');
  if (integrations.length > 0) modules.push('Integrations');
  if (alerts.length > 0) modules.push('Alerts');
  if (forecasts.length > 0) modules.push('Forecasts');
  if (enterprise) modules.push('Enterprise Scaling');
  return modules;
}
