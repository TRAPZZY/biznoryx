import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { ActionOutcomeService } from '../src/actions/outcomes.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { PerformanceFindingService } from '../src/findings/performance.mjs';

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
  const actions = new ActionOutcomeService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `action-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const analyst = identity.createUser({ email: `action-analyst-${Math.random()}@example.com`, displayName: 'Analyst', password: 'analyst password ok' });
  const viewer = identity.createUser({ email: `action-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `action-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Action Acme', slug: `action-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: analyst.id, role: 'analyst', actorUserId: owner.id });
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Action Acme Ltd',
      tradingName: 'Action Acme',
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
  const comparisonId = addComparison(store, organization.id, kpi.id);
  const finding = findings.generateFindingsForComparison({ organizationId: organization.id, actorUserId: owner.id, metricPeriodComparisonId: comparisonId })
    .find((item) => item.kind === 'recommendation');
  return { store, actions, dashboard, owner, analyst, viewer, outsider, organization, profile, kpi, finding };
}

function addComparison(store, organizationId, kpiDefinitionId) {
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
    value: 125,
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
  return comparisonId;
}

test('analyst creates an action from a finding and accepts the finding', () => {
  const { store, actions, analyst, organization, kpi, finding } = fixture();

  const action = actions.createAction({
    organizationId: organization.id,
    actorUserId: analyst.id,
    findingId: finding.id,
    ownerUserId: analyst.id,
    action: {
      title: 'Review February revenue drivers',
      description: 'Compare channel mix and campaign calendar before scaling the change.',
      dueDate: '2027-03-15',
      successMetricKpiDefinitionId: kpi.id
    }
  });

  assert.equal(action.status, 'planned');
  assert.equal(action.successMetricKpiDefinitionId, kpi.id);
  assert.equal(store.performanceFindings.get(finding.id).status, 'accepted');
  assert.ok(store.auditEvents.some((event) => event.eventType === 'management_action.created'));
});

test('viewer can read actions but cannot create or update them', () => {
  const { actions, owner, analyst, viewer, organization, finding } = fixture();
  const action = actions.createAction({
    organizationId: organization.id,
    actorUserId: owner.id,
    findingId: finding.id,
    ownerUserId: analyst.id,
    action: { title: 'Inspect uplift', description: 'Review the verified comparison.' }
  });

  assert.equal(actions.listActions({ organizationId: organization.id, actorUserId: viewer.id }).length, 1);
  assert.throws(() => actions.createAction({
    organizationId: organization.id,
    actorUserId: viewer.id,
    findingId: finding.id,
    ownerUserId: viewer.id,
    action: { title: 'Viewer action', description: 'Should be denied.' }
  }), /Capability required/);
  assert.throws(() => actions.updateActionStatus({ organizationId: organization.id, actorUserId: viewer.id, managementActionId: action.id, status: 'in_progress' }), /Capability required/);
});

test('outcomes require progressed actions and tenant-owned evidence', () => {
  const { store, actions, owner, analyst, organization, finding } = fixture();
  const action = actions.createAction({
    organizationId: organization.id,
    actorUserId: owner.id,
    findingId: finding.id,
    ownerUserId: analyst.id,
    action: { title: 'Scale working channel', description: 'Test the channel before rollout.' }
  });
  const metricRun = [...store.verifiedMetricRuns.values()][0];

  assert.throws(() => actions.recordOutcome({
    organizationId: organization.id,
    actorUserId: owner.id,
    managementActionId: action.id,
    outcome: { assessment: 'improved', baselineValue: 100, outcomeValue: 125, narrative: 'Too early.' }
  }), /Outcomes require/);

  actions.updateActionStatus({ organizationId: organization.id, actorUserId: owner.id, managementActionId: action.id, status: 'in_progress' });
  const outcome = actions.recordOutcome({
    organizationId: organization.id,
    actorUserId: owner.id,
    managementActionId: action.id,
    outcome: {
      assessment: 'improved',
      baselineValue: 100,
      outcomeValue: 125,
      narrative: 'Revenue improved after the action window; attribution remains evidence-bound.',
      reportingPeriodId: metricRun.reportingPeriodId,
      verifiedMetricRunId: metricRun.id
    }
  });

  assert.equal(outcome.deltaValue, 25);
  assert.equal(outcome.evidence.verifiedMetricRunId, metricRun.id);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'action_outcome.improved'));
});

test('outsider cannot read actions or outcomes', () => {
  const { actions, owner, outsider, organization, finding } = fixture();
  actions.createAction({
    organizationId: organization.id,
    actorUserId: owner.id,
    findingId: finding.id,
    ownerUserId: owner.id,
    action: { title: 'Investigate', description: 'Owned by the org only.' }
  });

  assert.throws(() => actions.listActions({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
  assert.throws(() => actions.listOutcomes({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
});

test('dashboard surfaces actions and outcomes', () => {
  const { store, actions, dashboard, owner, analyst, organization, profile, finding } = fixture();
  const action = actions.createAction({
    organizationId: organization.id,
    actorUserId: owner.id,
    findingId: finding.id,
    ownerUserId: analyst.id,
    action: { title: 'Document revenue drivers', description: 'Confirm the drivers behind the uplift.' }
  });
  const metricRun = [...store.verifiedMetricRuns.values()][0];
  actions.updateActionStatus({ organizationId: organization.id, actorUserId: owner.id, managementActionId: action.id, status: 'completed' });
  actions.recordOutcome({
    organizationId: organization.id,
    actorUserId: owner.id,
    managementActionId: action.id,
    outcome: {
      assessment: 'improved',
      baselineValue: 100,
      outcomeValue: 125,
      narrative: 'Follow-up measurement improved versus baseline.',
      reportingPeriodId: metricRun.reportingPeriodId,
      verifiedMetricRunId: metricRun.id
    }
  });

  const state = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(state.actions.length, 1);
  assert.equal(state.outcomes.length, 1);
  assert.ok(state.snapshot.summary.modules.includes('Actions'));
  assert.ok(state.snapshot.summary.modules.includes('Outcomes'));
});
