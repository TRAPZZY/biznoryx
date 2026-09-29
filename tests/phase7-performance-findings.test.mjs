import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { PerformanceFindingService, severityForChange } from '../src/findings/performance.mjs';

function fixture() {
  const store = createEmptyStore();
  store.metricPeriodComparisons = new Map();
  store.reportingPeriods = new Map();
  store.verifiedMetricRuns = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const findings = new PerformanceFindingService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `finding-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: `finding-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `finding-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Finding Acme', slug: `finding-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Finding Acme Ltd',
      tradingName: 'Finding Acme',
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
  return { store, findings, dashboard, owner, viewer, outsider, organization, profile, kpi };
}

function addComparison(store, organizationId, kpiDefinitionId, { direction, currentValue, previousValue, status = 'calculated' }) {
  const comparisonId = randomUUID();
  const currentRunId = randomUUID();
  const previousRunId = randomUUID();
  const currentReportingPeriodId = randomUUID();
  const previousReportingPeriodId = randomUUID();
  store.reportingPeriods.set(currentReportingPeriodId, { id: currentReportingPeriodId, organizationId, label: 'February 2027' });
  store.reportingPeriods.set(previousReportingPeriodId, { id: previousReportingPeriodId, organizationId, label: 'January 2027' });
  store.verifiedMetricRuns.set(currentRunId, {
    id: currentRunId,
    organizationId,
    kpiDefinitionId,
    reportingPeriodId: currentReportingPeriodId,
    ingestionRunId: randomUUID(),
    status: 'calculated',
    value: currentValue,
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
    status,
    currentValue,
    previousValue,
    absoluteChange: currentValue - previousValue,
    percentChange: previousValue === 0 ? null : ((currentValue - previousValue) / previousValue) * 100,
    direction,
    readiness: status === 'calculated' ? { periodComparison: 'ready' } : { periodComparison: 'not_enough_history' },
    evidence: { currentMetricRunId: currentRunId, previousMetricRunId: previousRunId }
  });
  return comparisonId;
}

test('upward comparison generates signal, opportunity, recommendation, and evidence links', () => {
  const { store, findings, owner, organization, kpi } = fixture();
  const comparisonId = addComparison(store, organization.id, kpi.id, { direction: 'up', currentValue: 125, previousValue: 100 });

  const generated = findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId });
  const kinds = generated.map((finding) => finding.kind).sort();

  assert.deepEqual(kinds, ['opportunity', 'recommendation', 'statistical_signal']);
  assert.equal(generated[0].severity, 'high');
  assert.match(generated[0].explanation, /not a causation claim/);
  assert.match(generated.find((finding) => finding.kind === 'recommendation').explanation, /hypothesis/);
  assert.equal(store.findingEvidence.size, 3);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'performance_finding.opportunity.created'));
});

test('downward comparison generates a risk instead of an opportunity', () => {
  const { store, findings, owner, organization, kpi } = fixture();
  const comparisonId = addComparison(store, organization.id, kpi.id, { direction: 'down', currentValue: 80, previousValue: 100 });

  const generated = findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId });

  assert.ok(generated.some((finding) => finding.kind === 'risk'));
  assert.ok(!generated.some((finding) => finding.kind === 'opportunity'));
});

test('not-ready comparison cannot create performance findings', () => {
  const { store, findings, owner, organization, kpi } = fixture();
  const comparisonId = addComparison(store, organization.id, kpi.id, { direction: 'unknown', currentValue: 100, previousValue: 0, status: 'not_ready' });

  assert.throws(() => findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId }), /Findings require a calculated comparison/);
});

test('viewer may read findings but cannot generate them, and outsider is denied', () => {
  const { store, findings, owner, viewer, outsider, organization, kpi } = fixture();
  const comparisonId = addComparison(store, organization.id, kpi.id, { direction: 'up', currentValue: 110, previousValue: 100 });
  findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId });

  assert.equal(findings.listFindings({ organizationId: organization.id, actorUserId: viewer.id }).length, 3);
  assert.throws(() => findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: viewer.id, metricPeriodComparisonId: comparisonId }), /Capability required/);
  assert.throws(() => findings.listFindings({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
});

test('dashboard surfaces risk, opportunity, and focus area modules from findings', () => {
  const { store, findings, dashboard, owner, organization, profile, kpi } = fixture();
  const comparisonId = addComparison(store, organization.id, kpi.id, { direction: 'up', currentValue: 125, previousValue: 100 });
  const generated = findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId });

  const dashboardState = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(dashboardState.findings.length, generated.length);
  assert.equal(dashboardState.opportunities.length, 1);
  assert.ok(dashboardState.snapshot.summary.modules.includes('Opportunities'));
  assert.ok(dashboardState.snapshot.summary.modules.includes('Focus Areas'));
});

test('finding severity thresholds are deterministic', () => {
  assert.equal(severityForChange(25), 'high');
  assert.equal(severityForChange(-10), 'medium');
  assert.equal(severityForChange(2), 'low');
  assert.equal(severityForChange(null), 'medium');
});
