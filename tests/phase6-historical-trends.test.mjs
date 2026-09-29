import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { HistoricalTrendService, calculateChange } from '../src/trends/historical.mjs';

function fixture() {
  const store = createEmptyStore();
  store.reportingPeriods = new Map();
  store.verifiedMetricRuns = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const trends = new HistoricalTrendService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `trend-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: `trend-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `trend-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Trend Acme', slug: `trend-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Trend Acme Ltd',
      tradingName: 'Trend Acme',
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
  return { store, trends, dashboard, owner, viewer, outsider, organization, profile, kpi };
}

function addMetricRun(store, organizationId, kpiDefinitionId, periodStart, label, value) {
  const reportingPeriodId = randomUUID();
  const metricRunId = randomUUID();
  store.reportingPeriods.set(reportingPeriodId, {
    id: reportingPeriodId,
    organizationId,
    dataStreamId: randomUUID(),
    periodStart,
    periodEnd: periodStart,
    label
  });
  store.verifiedMetricRuns.set(metricRunId, {
    id: metricRunId,
    organizationId,
    kpiDefinitionId,
    metricCalculationSpecId: randomUUID(),
    ingestionRunId: randomUUID(),
    reportingPeriodId,
    status: 'calculated',
    value,
    unit: 'sum',
    evidence: { rowCount: 2 },
    createdByUserId: randomUUID(),
    createdAt: new Date()
  });
  return { reportingPeriodId, metricRunId };
}

test('comparison records not-ready state when only one verified period exists', () => {
  const { store, trends, owner, organization, kpi } = fixture();
  addMetricRun(store, organization.id, kpi.id, '2027-01-01', 'January 2027', 100);

  const comparison = trends.compareLatestPeriod({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id });
  const summary = trends.summarizeTrend({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id });

  assert.equal(comparison.status, 'not_ready');
  assert.equal(comparison.readiness.periodComparison, 'not_enough_history');
  assert.equal(summary.status, 'not_ready');
  assert.equal(summary.points, 1);
});

test('comparison calculates deterministic absolute and percent change', () => {
  const { store, trends, owner, organization, kpi } = fixture();
  addMetricRun(store, organization.id, kpi.id, '2027-01-01', 'January 2027', 100);
  addMetricRun(store, organization.id, kpi.id, '2027-02-01', 'February 2027', 125);

  const comparison = trends.compareLatestPeriod({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id });
  const summary = trends.summarizeTrend({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id });

  assert.equal(comparison.status, 'calculated');
  assert.equal(comparison.absoluteChange, 25);
  assert.equal(comparison.percentChange, 25);
  assert.equal(comparison.direction, 'up');
  assert.equal(summary.status, 'calculated');
  assert.equal(summary.direction, 'up');
});

test('percent change is null when previous value is zero', () => {
  assert.deepEqual(calculateChange(10, 0), {
    absoluteChange: 10,
    percentChange: null,
    direction: 'up'
  });
});

test('viewer can read trend state but cannot calculate comparisons', () => {
  const { store, trends, owner, viewer, organization, kpi } = fixture();
  addMetricRun(store, organization.id, kpi.id, '2027-01-01', 'January 2027', 100);
  trends.compareLatestPeriod({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id });

  assert.equal(trends.getTrendState({ organizationId: organization.id, actorUserId: viewer.id, kpiDefinitionId: kpi.id }).state, 'not_ready');
  assert.throws(() => trends.compareLatestPeriod({ organizationId: organization.id, actorUserId: viewer.id, kpiDefinitionId: kpi.id }), /Capability required/);
});

test('outsider cannot read trend state', () => {
  const { trends, outsider, organization, kpi } = fixture();
  assert.throws(() => trends.getTrendState({ organizationId: organization.id, actorUserId: outsider.id, kpiDefinitionId: kpi.id }), /Active organization membership/);
});

test('dashboard trend rows include calculated comparison values', () => {
  const { store, trends, dashboard, owner, organization, profile, kpi } = fixture();
  const january = addMetricRun(store, organization.id, kpi.id, '2027-01-01', 'January 2027', 100);
  addMetricRun(store, organization.id, kpi.id, '2027-02-01', 'February 2027', 125);
  trends.compareLatestPeriod({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id });

  const result = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, reportingPeriodId: january.reportingPeriodId });
  assert.equal(result.trends[0].comparisonStatus, 'calculated');
  assert.equal(result.trends[0].absoluteChange, 25);
  assert.equal(result.trends[0].direction, 'up');
});
