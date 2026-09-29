import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { ActionOutcomeService } from '../src/actions/outcomes.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { PerformanceFindingService } from '../src/findings/performance.mjs';
import { ProfessionalReportService, reportShellState } from '../src/reports/professional.mjs';

function fixture() {
  const store = createEmptyStore();
  store.metricPeriodComparisons = new Map();
  store.metricTrendSummaries = new Map();
  store.reportingPeriods = new Map();
  store.verifiedMetricRuns = new Map();
  store.ingestionRuns = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const findings = new PerformanceFindingService(store, auditLog);
  const actions = new ActionOutcomeService(store, auditLog);
  const reports = new ProfessionalReportService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `report-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const analyst = identity.createUser({ email: `report-analyst-${Math.random()}@example.com`, displayName: 'Analyst', password: 'analyst password ok' });
  const viewer = identity.createUser({ email: `report-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `report-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Report Acme', slug: `report-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: analyst.id, role: 'analyst', actorUserId: owner.id });
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Report Acme Ltd',
      tradingName: 'Report Acme',
      industry: 'Retail',
      businessModel: 'Retail sales',
      primaryCurrency: 'USD',
      fiscalYearStartMonth: 1,
      timezone: 'America/New_York'
    }
  });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'product_service', name: 'Retail products' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'customer_segment', name: 'Local shoppers' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'channel', name: 'Store sales' } });
  onboarding.addFact({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, fact: { factKind: 'confirmed_fact', subject: 'Business', predicate: 'operates_as', value: 'Retail', source: 'owner' } });
  onboarding.addTerm({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, term: { term: 'Revenue', definition: 'Net sales', source: 'owner' } });
  onboarding.addGoal({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, goal: { name: 'Grow revenue', targetMetric: 'Revenue', targetValue: 10, targetPeriod: 'FY2027' } });
  const kpi = onboarding.addKpiDefinition({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    kpi: { name: 'Revenue', description: 'Total net sales', valueType: 'money', calculationMethod: 'sum revenue', sourceHint: 'monthly sales' }
  });
  onboarding.completeOnboarding({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  const comparisonId = addEvidenceChain(store, organization.id, kpi.id);
  const finding = findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId })
    .find((item) => item.kind === 'recommendation');
  const action = actions.createAction({
    organizationId: organization.id,
    actorUserId: owner.id,
    findingId: finding.id,
    ownerUserId: analyst.id,
    action: { title: 'Confirm revenue drivers', description: 'Review channel mix and campaign timing.', successMetricKpiDefinitionId: kpi.id }
  });
  actions.updateActionStatus({ organizationId: organization.id, actorUserId: owner.id, managementActionId: action.id, status: 'completed' });
  const metricRun = [...store.verifiedMetricRuns.values()][0];
  actions.recordOutcome({
    organizationId: organization.id,
    actorUserId: owner.id,
    managementActionId: action.id,
    outcome: {
      assessment: 'improved',
      baselineValue: 100,
      outcomeValue: 125,
      narrative: 'Revenue improved versus the baseline measurement.',
      reportingPeriodId: metricRun.reportingPeriodId,
      verifiedMetricRunId: metricRun.id
    }
  });
  return { store, reports, dashboard, owner, analyst, viewer, outsider, organization, profile };
}

function addEvidenceChain(store, organizationId, kpiDefinitionId) {
  const currentReportingPeriodId = randomUUID();
  const previousReportingPeriodId = randomUUID();
  const currentRunId = randomUUID();
  const previousRunId = randomUUID();
  const comparisonId = randomUUID();
  const trendId = randomUUID();
  const ingestionRunId = randomUUID();
  store.reportingPeriods.set(currentReportingPeriodId, { id: currentReportingPeriodId, organizationId, label: 'February 2027' });
  store.reportingPeriods.set(previousReportingPeriodId, { id: previousReportingPeriodId, organizationId, label: 'January 2027' });
  store.ingestionRuns.set(ingestionRunId, { id: ingestionRunId, organizationId, status: 'validated', schemaDrift: 'none' });
  store.verifiedMetricRuns.set(currentRunId, {
    id: currentRunId,
    organizationId,
    kpiDefinitionId,
    reportingPeriodId: currentReportingPeriodId,
    ingestionRunId,
    status: 'calculated',
    value: 125,
    unit: 'sum',
    createdAt: new Date()
  });
  store.verifiedMetricRuns.set(previousRunId, {
    id: previousRunId,
    organizationId,
    kpiDefinitionId,
    reportingPeriodId: previousReportingPeriodId,
    ingestionRunId,
    status: 'calculated',
    value: 100,
    unit: 'sum',
    createdAt: new Date()
  });
  store.metricPeriodComparisons.set(comparisonId, {
    id: comparisonId,
    organizationId,
    kpiDefinitionId,
    currentMetricRunId: currentRunId,
    previousMetricRunId: previousRunId,
    currentReportingPeriodId,
    previousReportingPeriodId,
    status: 'calculated',
    currentValue: 125,
    previousValue: 100,
    absoluteChange: 25,
    percentChange: 25,
    direction: 'up',
    readiness: { periodComparison: 'ready' },
    evidence: { currentMetricRunId: currentRunId, previousMetricRunId: previousRunId }
  });
  store.metricTrendSummaries.set(trendId, {
    id: trendId,
    organizationId,
    kpiDefinitionId,
    status: 'calculated',
    points: 2,
    direction: 'up',
    summary: 'Revenue is up across 2 verified periods.',
    evidence: { comparisonId }
  });
  return comparisonId;
}

test('analyst generates a professional report with ordered evidence-linked sections', () => {
  const { store, reports, analyst, organization, profile } = fixture();

  const result = reports.generateReport({ organizationId: organization.id, actorUserId: analyst.id, businessProfileId: profile.id, title: 'February Performance Review' });
  const kinds = result.sections.map((section) => section.kind);

  assert.equal(result.report.title, 'February Performance Review');
  assert.deepEqual(kinds, ['executive_summary', 'kpi_scorecard', 'historical_trends', 'findings', 'actions', 'outcomes', 'data_health', 'evidence_appendix']);
  assert.equal(result.sections[0].sectionOrder, 1);
  assert.ok(result.sections.find((section) => section.kind === 'kpi_scorecard').evidence.kpis[0].metricRunId);
  assert.ok(result.sections.find((section) => section.kind === 'evidence_appendix').evidence.actionOutcomeIds.length > 0);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'professional_report.generated'));
  assert.equal(reportShellState(result).state, 'ready');
});

test('viewer can read reports but cannot generate them', () => {
  const { reports, owner, viewer, organization, profile } = fixture();
  const generated = reports.generateReport({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(reports.getReport({ organizationId: organization.id, actorUserId: viewer.id, professionalReportId: generated.report.id }).sections.length, 8);
  assert.equal(reports.listReports({ organizationId: organization.id, actorUserId: viewer.id }).length, 1);
  assert.throws(() => reports.generateReport({ organizationId: organization.id, actorUserId: viewer.id, businessProfileId: profile.id }), /Capability required/);
});

test('outsider cannot read professional reports', () => {
  const { reports, owner, outsider, organization, profile } = fixture();
  const generated = reports.generateReport({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.throws(() => reports.getReport({ organizationId: organization.id, actorUserId: outsider.id, professionalReportId: generated.report.id }), /Active organization membership/);
});

test('report generation requires completed onboarding and tenant-owned periods', () => {
  const { reports, owner, organization, profile } = fixture();

  assert.throws(() => reports.generateReport({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, reportingPeriodId: randomUUID() }), /Reporting period not found/);
});

test('dashboard surfaces generated professional reports', () => {
  const { reports, dashboard, owner, organization, profile } = fixture();
  reports.generateReport({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  const state = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(state.reports.length, 1);
  assert.ok(state.snapshot.summary.modules.includes('Reports'));
});
