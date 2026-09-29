import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export function createReportStoreShape(store) {
  store.professionalReports ??= new Map();
  store.professionalReportSections ??= new Map();
  return store;
}

export class ProfessionalReportService {
  constructor(store, auditLog) {
    this.store = createReportStoreShape(store);
    this.auditLog = auditLog;
  }

  generateReport({ organizationId, actorUserId, businessProfileId, reportingPeriodId = null, title = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.WRITE_BUSINESS_DATA });
    const profile = this.requireOwned(this.store.businessProfiles, organizationId, businessProfileId, 'Business profile not found.');
    if (profile.status !== 'completed') throw new AuthError('Business onboarding must be completed before report generation.', 'REPORT_NOT_READY');
    if (reportingPeriodId) this.requireOwned(this.store.reportingPeriods, organizationId, reportingPeriodId, 'Reporting period not found.');

    const context = this.reportContext(organizationId, reportingPeriodId);
    const report = {
      id: randomUUID(),
      organizationId,
      businessProfileId,
      reportingPeriodId,
      title: requiredText(title ?? `${profile.tradingName ?? profile.legalName} Performance Report`, 'Report title is required.'),
      status: 'generated',
      summary: reportSummary(profile, context),
      generatedByUserId: actorUserId,
      generatedAt: new Date(),
      createdAt: new Date()
    };
    this.store.professionalReports.set(report.id, report);
    const sections = buildSections({ organizationId, reportId: report.id, profile, context });
    for (const section of sections) this.store.professionalReportSections.set(section.id, section);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'professional_report.generated', targetType: 'professional_report', targetId: report.id, metadata: { sectionCount: sections.length } });
    return { report, sections };
  }

  getReport({ organizationId, actorUserId, professionalReportId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    const report = this.requireOwned(this.store.professionalReports, organizationId, professionalReportId, 'Professional report not found.');
    const sections = [...this.store.professionalReportSections.values()]
      .filter((section) => section.organizationId === organizationId && section.professionalReportId === report.id)
      .sort((a, b) => a.sectionOrder - b.sectionOrder);
    return { report, sections };
  }

  listReports({ organizationId, actorUserId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return [...this.store.professionalReports.values()]
      .filter((report) => report.organizationId === organizationId)
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  }

  reportContext(organizationId, reportingPeriodId) {
    const metricRuns = [...(this.store.verifiedMetricRuns?.values() ?? [])]
      .filter((run) => run.organizationId === organizationId && run.status === 'calculated')
      .filter((run) => !reportingPeriodId || run.reportingPeriodId === reportingPeriodId);
    return {
      metricRuns,
      kpis: this.kpiRows(organizationId, metricRuns),
      trends: [...(this.store.metricTrendSummaries?.values() ?? [])].filter((trend) => trend.organizationId === organizationId),
      findings: [...(this.store.performanceFindings?.values() ?? [])].filter((finding) => finding.organizationId === organizationId),
      actions: [...(this.store.managementActions?.values() ?? [])].filter((action) => action.organizationId === organizationId),
      outcomes: [...(this.store.actionOutcomes?.values() ?? [])].filter((outcome) => outcome.organizationId === organizationId),
      ingestionRuns: [...(this.store.ingestionRuns?.values() ?? [])].filter((run) => run.organizationId === organizationId)
    };
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
        evidence: { metricRunId: run.id, ingestionRunId: run.ingestionRunId, reportingPeriodId: run.reportingPeriodId }
      };
    });
  }

  requireOwned(map, organizationId, id, message) {
    const record = map?.get(id);
    if (!record || record.organizationId !== organizationId) throw new AuthError(message, 'NOT_FOUND');
    return record;
  }
}

export function reportShellState(result) {
  if (!result) return { state: 'loading' };
  if (result.sections.length === 0) return { state: 'empty', message: 'No report sections are available yet.' };
  if (result.sections.some((section) => section.kind === 'data_health' && section.evidence.rejectedRuns > 0)) return { state: 'attention' };
  return { state: 'ready' };
}

function buildSections({ organizationId, reportId, profile, context }) {
  const definitions = [
    executiveSummarySection(profile, context),
    kpiSection(context),
    trendSection(context),
    findingsSection(context),
    actionsSection(context),
    outcomesSection(context),
    dataHealthSection(context),
    evidenceAppendixSection(context)
  ];
  return definitions.map((definition, index) => ({
    id: randomUUID(),
    organizationId,
    professionalReportId: reportId,
    sectionOrder: index + 1,
    kind: definition.kind,
    heading: definition.heading,
    body: definition.body,
    evidence: definition.evidence,
    createdAt: new Date()
  }));
}

function executiveSummarySection(profile, context) {
  return {
    kind: 'executive_summary',
    heading: 'Executive Summary',
    body: `${profile.tradingName ?? profile.legalName} has ${context.kpis.length} verified KPI value(s), ${context.findings.length} finding(s), ${context.actions.length} action(s), and ${context.outcomes.length} recorded outcome(s) in this report package.`,
    evidence: countsEvidence(context)
  };
}

function kpiSection(context) {
  return {
    kind: 'kpi_scorecard',
    heading: 'KPI Scorecard',
    body: context.kpis.length === 0
      ? 'No verified KPI values are available for this report period.'
      : context.kpis.map((kpi) => `${kpi.label}: ${kpi.value} ${kpi.unit}`).join('\n'),
    evidence: { kpis: context.kpis.map((kpi) => kpi.evidence) }
  };
}

function trendSection(context) {
  return {
    kind: 'historical_trends',
    heading: 'Historical Trends',
    body: context.trends.length === 0
      ? 'No trend summaries are available yet.'
      : context.trends.map((trend) => trend.summary).join('\n'),
    evidence: { trendSummaryIds: context.trends.map((trend) => trend.id) }
  };
}

function findingsSection(context) {
  return {
    kind: 'findings',
    heading: 'Findings',
    body: context.findings.length === 0
      ? 'No findings are available yet.'
      : context.findings.map((finding) => `${finding.kind}: ${finding.title}`).join('\n'),
    evidence: { findingIds: context.findings.map((finding) => finding.id) }
  };
}

function actionsSection(context) {
  return {
    kind: 'actions',
    heading: 'Management Actions',
    body: context.actions.length === 0
      ? 'No management actions are recorded yet.'
      : context.actions.map((action) => `${action.status}: ${action.title}`).join('\n'),
    evidence: { managementActionIds: context.actions.map((action) => action.id) }
  };
}

function outcomesSection(context) {
  return {
    kind: 'outcomes',
    heading: 'Measured Outcomes',
    body: context.outcomes.length === 0
      ? 'No measured outcomes are recorded yet.'
      : context.outcomes.map((outcome) => `${outcome.assessment}: ${outcome.narrative}`).join('\n'),
    evidence: { actionOutcomeIds: context.outcomes.map((outcome) => outcome.id) }
  };
}

function dataHealthSection(context) {
  const rejectedRuns = context.ingestionRuns.filter((run) => run.status === 'rejected').length;
  const validatedRuns = context.ingestionRuns.filter((run) => run.status === 'validated').length;
  return {
    kind: 'data_health',
    heading: 'Data Health',
    body: `Validated ingestion runs: ${validatedRuns}. Rejected ingestion runs: ${rejectedRuns}.`,
    evidence: { validatedRuns, rejectedRuns }
  };
}

function evidenceAppendixSection(context) {
  return {
    kind: 'evidence_appendix',
    heading: 'Evidence Appendix',
    body: 'This report is generated from stored BIZNORYX records. KPI values come from verified metric runs; findings, actions, and outcomes preserve their own evidence links.',
    evidence: countsEvidence(context)
  };
}

function countsEvidence(context) {
  return {
    verifiedMetricRunIds: context.metricRuns.map((run) => run.id),
    trendSummaryIds: context.trends.map((trend) => trend.id),
    findingIds: context.findings.map((finding) => finding.id),
    managementActionIds: context.actions.map((action) => action.id),
    actionOutcomeIds: context.outcomes.map((outcome) => outcome.id)
  };
}

function reportSummary(profile, context) {
  return `${profile.tradingName ?? profile.legalName} report generated from ${context.metricRuns.length} verified metric run(s), ${context.findings.length} finding(s), ${context.actions.length} action(s), and ${context.outcomes.length} outcome(s).`;
}

function requiredText(value, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new AuthError(message, 'VALIDATION_FAILED');
  return text;
}
