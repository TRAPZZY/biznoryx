import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { ForecastScenarioService, linearProjection } from '../src/forecasts/scenarios.mjs';

function fixture() {
  const store = createEmptyStore();
  store.businessProfiles = new Map();
  store.businessModelEntries = new Map();
  store.businessFacts = new Map();
  store.businessTerms = new Map();
  store.businessGoals = new Map();
  store.kpiDefinitions = new Map();
  store.reportingPeriods = new Map();
  store.verifiedMetricRuns = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const forecasts = new ForecastScenarioService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `forecast-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const analyst = identity.createUser({ email: `forecast-analyst-${Math.random()}@example.com`, displayName: 'Analyst', password: 'analyst password ok' });
  const viewer = identity.createUser({ email: `forecast-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `forecast-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Forecast Acme', slug: `forecast-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: analyst.id, role: 'analyst', actorUserId: owner.id });
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: { legalName: 'Forecast Acme Ltd', tradingName: 'Forecast Acme', industry: 'Retail', businessModel: 'Retail sales', primaryCurrency: 'USD', fiscalYearStartMonth: 1, timezone: 'America/New_York' }
  });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'product_service', name: 'Retail products' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'customer_segment', name: 'Local shoppers' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'channel', name: 'Store sales' } });
  onboarding.addFact({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, fact: { factKind: 'confirmed_fact', subject: 'Business', predicate: 'operates_as', value: 'Retail', source: 'owner' } });
  onboarding.addTerm({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, term: { term: 'Revenue', definition: 'Net sales', source: 'owner' } });
  onboarding.addGoal({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, goal: { name: 'Grow revenue', targetMetric: 'Revenue', targetValue: 10, targetPeriod: 'FY2027' } });
  const kpi = onboarding.addKpiDefinition({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, kpi: { name: 'Revenue', description: 'Total net sales', valueType: 'money', calculationMethod: 'sum revenue', sourceHint: 'monthly sales' } });
  onboarding.completeOnboarding({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  return { store, forecasts, dashboard, owner, analyst, viewer, outsider, organization, profile, kpi };
}

function addMetricRun(store, organizationId, kpiDefinitionId, periodStart, label, value) {
  const reportingPeriodId = randomUUID();
  const metricRunId = randomUUID();
  store.reportingPeriods.set(reportingPeriodId, { id: reportingPeriodId, organizationId, dataStreamId: randomUUID(), periodStart, periodEnd: periodStart, label });
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
    createdAt: new Date(periodStart)
  });
  return { reportingPeriodId, metricRunId };
}

function addThreePeriods(store, organizationId, kpiDefinitionId) {
  return [
    addMetricRun(store, organizationId, kpiDefinitionId, '2027-01-01', 'January 2027', 100),
    addMetricRun(store, organizationId, kpiDefinitionId, '2027-02-01', 'February 2027', 110),
    addMetricRun(store, organizationId, kpiDefinitionId, '2027-03-01', 'March 2027', 120)
  ];
}

test('forecast run calculates deterministic scenario-adjusted values from verified history', () => {
  const { store, forecasts, analyst, organization, kpi } = fixture();
  const periods = addThreePeriods(store, organization.id, kpi.id);
  const model = forecasts.createModel({ organizationId: organization.id, actorUserId: analyst.id, kpiDefinitionId: kpi.id, model: { name: 'Revenue projection', minimumPoints: '3', horizonPeriods: '3' } });
  const scenario = forecasts.createScenario({ organizationId: organization.id, actorUserId: analyst.id, forecastModelId: model.id, scenario: { name: 'Expansion case', assumptions: { note: 'More store traffic' }, adjustmentPercent: '10' } });

  const run = forecasts.runForecast({ organizationId: organization.id, actorUserId: analyst.id, forecastModelId: model.id, forecastScenarioId: scenario.id });

  assert.equal(run.status, 'calculated');
  assert.equal(run.baselineValue, 120);
  assert.equal(run.slope, 10);
  assert.deepEqual(run.forecastValues, [
    { periodOffset: 1, value: 143 },
    { periodOffset: 2, value: 154 },
    { periodOffset: 3, value: 165 }
  ]);
  assert.equal(run.uncertainty.meanAbsoluteError, 0);
  assert.deepEqual(run.evidence.verifiedMetricRunIds, periods.map((period) => period.metricRunId));
  assert.ok(store.auditEvents.some((event) => event.eventType === 'forecast_run.calculated'));
});

test('forecast run records not-ready state when verified history is insufficient', () => {
  const { store, forecasts, owner, organization, kpi } = fixture();
  addMetricRun(store, organization.id, kpi.id, '2027-01-01', 'January 2027', 100);
  addMetricRun(store, organization.id, kpi.id, '2027-02-01', 'February 2027', 110);
  const model = forecasts.createModel({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id, model: { name: 'Revenue projection', minimumPoints: 3, horizonPeriods: 2 } });

  const run = forecasts.runForecast({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: model.id });

  assert.equal(run.status, 'not_ready');
  assert.equal(run.baselineValue, 110);
  assert.deepEqual(run.forecastValues, []);
  assert.deepEqual(run.readiness, { requiredPoints: 3, actualPoints: 2 });
  assert.equal(run.uncertainty.reason, 'insufficient_history');
});

test('viewer can read forecast runs but cannot mutate, and outsider is denied', () => {
  const { store, forecasts, owner, viewer, outsider, organization, kpi } = fixture();
  addThreePeriods(store, organization.id, kpi.id);
  const model = forecasts.createModel({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id, model: { name: 'Revenue projection' } });
  forecasts.runForecast({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: model.id });

  assert.equal(forecasts.listForecastRuns({ organizationId: organization.id, actorUserId: viewer.id }).length, 1);
  assert.throws(() => forecasts.createModel({ organizationId: organization.id, actorUserId: viewer.id, kpiDefinitionId: kpi.id, model: { name: 'Viewer model' } }), /Capability required/);
  assert.throws(() => forecasts.listForecastRuns({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
});

test('forecast models and scenarios reject invalid state before creating misleading runs', () => {
  const { store, forecasts, owner, organization, kpi } = fixture();
  addThreePeriods(store, organization.id, kpi.id);
  assert.throws(() => forecasts.createScenario({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: randomUUID(), scenario: { name: 'Missing model' } }), /Forecast model not found/);
  assert.throws(() => forecasts.createModel({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id, model: { name: 'Bad horizon', horizonPeriods: 0 } }), /Horizon periods must be positive/);
  const model = forecasts.createModel({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id, model: { name: 'Revenue projection' } });
  const scenario = forecasts.createScenario({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: model.id, scenario: { name: 'Draft case', status: 'draft' } });

  assert.throws(() => forecasts.createScenario({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: model.id, scenario: { name: 'Bad case', adjustmentPercent: 'not numeric' } }), /Scenario adjustment must be numeric/);
  assert.throws(() => forecasts.runForecast({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: model.id, forecastScenarioId: scenario.id }), /Only active scenarios can run/);
});

test('dashboard exposes forecast module and rows only after a forecast run exists', () => {
  const { store, forecasts, dashboard, owner, organization, profile, kpi } = fixture();
  addThreePeriods(store, organization.id, kpi.id);
  const emptyState = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  const model = forecasts.createModel({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id, model: { name: 'Revenue projection' } });
  forecasts.runForecast({ organizationId: organization.id, actorUserId: owner.id, forecastModelId: model.id });

  const state = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(emptyState.forecasts.length, 0);
  assert.equal(state.forecasts.length, 1);
  assert.ok(state.snapshot.summary.modules.includes('Forecasts'));
});

test('linear projection exposes rounded uncertainty and scenario adjustment', () => {
  const result = linearProjection([{ value: 10 }, { value: 13 }, { value: 17 }], 2, -5);

  assert.equal(result.baselineValue, 17);
  assert.equal(result.slope, 3.5);
  assert.deepEqual(result.forecastValues, [
    { periodOffset: 1, value: 19.47 },
    { periodOffset: 2, value: 22.8 }
  ]);
  assert.equal(result.uncertainty.meanAbsoluteError, 0.17);
  assert.equal(result.uncertainty.adjustmentPercent, -5);
});
