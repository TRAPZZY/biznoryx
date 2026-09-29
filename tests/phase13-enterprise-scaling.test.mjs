import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { EnterpriseScalingService, enterpriseHealth } from '../src/enterprise/scaling.mjs';

function fixture() {
  const store = createEmptyStore();
  store.businessProfiles = new Map();
  store.businessModelEntries = new Map();
  store.businessFacts = new Map();
  store.businessTerms = new Map();
  store.businessGoals = new Map();
  store.kpiDefinitions = new Map();
  store.verifiedMetricRuns = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const enterprise = new EnterpriseScalingService(store, auditLog, () => new Date('2027-02-15T10:00:00Z'));
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `enterprise-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const admin = identity.createUser({ email: `enterprise-admin-${Math.random()}@example.com`, displayName: 'Admin', password: 'admin password ok' });
  const analyst = identity.createUser({ email: `enterprise-analyst-${Math.random()}@example.com`, displayName: 'Analyst', password: 'analyst password ok' });
  const viewer = identity.createUser({ email: `enterprise-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `enterprise-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Enterprise Acme', slug: `enterprise-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: admin.id, role: 'admin', actorUserId: owner.id });
  orgs.addMembership({ organizationId: organization.id, userId: analyst.id, role: 'analyst', actorUserId: owner.id });
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: { legalName: 'Enterprise Acme Ltd', tradingName: 'Enterprise Acme', industry: 'Retail', businessModel: 'Retail sales', primaryCurrency: 'USD', fiscalYearStartMonth: 1, timezone: 'America/New_York' }
  });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'product_service', name: 'Retail products' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'customer_segment', name: 'Local shoppers' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'channel', name: 'Store sales' } });
  onboarding.addFact({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, fact: { factKind: 'confirmed_fact', subject: 'Business', predicate: 'operates_as', value: 'Retail', source: 'owner' } });
  onboarding.addTerm({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, term: { term: 'Revenue', definition: 'Net sales', source: 'owner' } });
  onboarding.addGoal({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, goal: { name: 'Grow revenue', targetMetric: 'Revenue', targetValue: 10, targetPeriod: 'FY2027' } });
  onboarding.addKpiDefinition({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, kpi: { name: 'Revenue', description: 'Total net sales', valueType: 'money', calculationMethod: 'sum revenue', sourceHint: 'monthly sales' } });
  onboarding.completeOnboarding({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  return { store, enterprise, dashboard, owner, admin, analyst, viewer, outsider, organization, profile };
}

test('owner sets enterprise plan limits and usage windows enforce monthly quotas', () => {
  const { store, enterprise, owner, analyst, organization } = fixture();
  const plan = enterprise.setOrganizationPlan({
    organizationId: organization.id,
    actorUserId: owner.id,
    plan: { name: 'Scale', limits: { monthlyForecastRuns: '2', maxConcurrentJobs: 2, maxWorkerLeaseMinutes: 10 } }
  });

  const first = enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'forecast_run', operationKey: 'forecast-1' });
  const replay = enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'forecast_run', operationKey: 'forecast-1' });
  enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'forecast_run', operationKey: 'forecast-2' });

  assert.equal(plan.limits.monthlyForecastRuns, 2);
  assert.equal(first.id, replay.id);
  assert.throws(() => enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'forecast_run', operationKey: 'forecast-3' }), /usage limit exceeded/i);
  assert.equal([...store.organizationUsageWindows.values()][0].usedQuantity, 2);
  assert.ok([...store.rateLimitEvents.values()].some((event) => event.decision === 'blocked'));
});

test('worker job leasing respects concurrency and tracks completion', () => {
  const { store, enterprise, owner, analyst, organization } = fixture();
  enterprise.setOrganizationPlan({ organizationId: organization.id, actorUserId: owner.id, plan: { name: 'Scale', limits: { maxConcurrentJobs: 1, maxWorkerLeaseMinutes: 5 } } });
  const firstJob = enterprise.enqueueJob({ organizationId: organization.id, actorUserId: analyst.id, jobKind: 'forecast', idempotencyKey: 'forecast-job-1', payload: { forecastModelId: 'model-1' } });
  const replay = enterprise.enqueueJob({ organizationId: organization.id, actorUserId: analyst.id, jobKind: 'forecast', idempotencyKey: 'forecast-job-1' });
  enterprise.enqueueJob({ organizationId: organization.id, actorUserId: analyst.id, jobKind: 'report', idempotencyKey: 'report-job-1' });

  const leased = enterprise.leaseNextJob({ organizationId: organization.id, actorUserId: analyst.id, workerId: 'worker-a' });
  const limited = enterprise.leaseNextJob({ organizationId: organization.id, actorUserId: analyst.id, workerId: 'worker-b' });
  const completed = enterprise.completeJob({ organizationId: organization.id, actorUserId: analyst.id, workerJobId: firstJob.id, status: 'succeeded' });

  assert.equal(firstJob.id, replay.id);
  assert.equal(leased.state, 'leased');
  assert.equal(leased.job.id, firstJob.id);
  assert.equal(limited.state, 'limited');
  assert.equal(completed.status, 'succeeded');
  assert.ok(store.auditEvents.some((event) => event.eventType === 'enterprise_job.succeeded'));
});

test('authorization separates plan management, scaling writes, health reads, and outsiders', () => {
  const { enterprise, owner, admin, analyst, viewer, outsider, organization } = fixture();
  enterprise.setOrganizationPlan({ organizationId: organization.id, actorUserId: owner.id, plan: { name: 'Scale', limits: { monthlySyncRuns: 1 } } });

  assert.throws(() => enterprise.setOrganizationPlan({ organizationId: organization.id, actorUserId: admin.id, plan: { name: 'Admin plan' } }), /Capability required/);
  assert.throws(() => enterprise.recordUsage({ organizationId: organization.id, actorUserId: viewer.id, usageKind: 'sync_run', operationKey: 'viewer-sync' }), /Capability required/);
  assert.equal(enterprise.operationalHealth({ organizationId: organization.id, actorUserId: viewer.id }).state, 'ready');
  assert.equal(enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'sync_run', operationKey: 'analyst-sync' }).decision, 'allowed');
  assert.throws(() => enterprise.operationalHealth({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
});

test('operational health and dashboard expose enterprise scaling state', () => {
  const { store, enterprise, dashboard, owner, analyst, organization, profile } = fixture();
  enterprise.setOrganizationPlan({ organizationId: organization.id, actorUserId: owner.id, plan: { name: 'Scale', limits: { maxConcurrentJobs: 2 } } });
  enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'ingestion_run', operationKey: 'ingestion-1' });
  enterprise.enqueueJob({ organizationId: organization.id, actorUserId: analyst.id, jobKind: 'ingestion', idempotencyKey: 'ingestion-job-1' });

  const health = enterpriseHealth(store, organization.id, () => new Date('2027-02-15T10:00:00Z'));
  const state = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(health.state, 'ready');
  assert.equal(health.queuedJobs, 1);
  assert.equal(state.enterprise.planName, 'Scale');
  assert.ok(state.snapshot.summary.modules.includes('Enterprise Scaling'));
});

test('validation rejects invalid usage and job controls before corrupting scaling state', () => {
  const { enterprise, owner, analyst, organization } = fixture();
  enterprise.setOrganizationPlan({ organizationId: organization.id, actorUserId: owner.id, plan: { name: 'Scale' } });

  assert.throws(() => enterprise.recordUsage({ organizationId: organization.id, actorUserId: analyst.id, usageKind: 'bad_kind', operationKey: 'bad' }), /Usage kind is not valid/);
  assert.throws(() => enterprise.enqueueJob({ organizationId: organization.id, actorUserId: analyst.id, jobKind: 'bad_job', idempotencyKey: 'bad' }), /Job kind is not valid/);
  assert.throws(() => enterprise.setOrganizationPlan({ organizationId: organization.id, actorUserId: owner.id, plan: { name: 'Bad', limits: { maxConcurrentJobs: 0 } } }), /maxConcurrentJobs must be positive/);
});
