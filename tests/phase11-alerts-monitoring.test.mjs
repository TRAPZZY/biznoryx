import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { AlertMonitoringService, alertSummary } from '../src/alerts/monitoring.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';

function fixture() {
  const store = createEmptyStore();
  store.businessProfiles = new Map();
  store.businessModelEntries = new Map();
  store.businessFacts = new Map();
  store.businessTerms = new Map();
  store.businessGoals = new Map();
  store.kpiDefinitions = new Map();
  store.verifiedMetricRuns = new Map();
  store.ingestionRuns = new Map();
  store.integrationSyncRuns = new Map();
  store.performanceFindings = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const alerts = new AlertMonitoringService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `alert-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: `alert-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `alert-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Alert Acme', slug: `alert-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: { legalName: 'Alert Acme Ltd', tradingName: 'Alert Acme', industry: 'Retail', businessModel: 'Retail sales', primaryCurrency: 'USD', fiscalYearStartMonth: 1, timezone: 'America/New_York' }
  });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'product_service', name: 'Retail products' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'customer_segment', name: 'Local shoppers' } });
  onboarding.addModelEntry({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, entry: { entryType: 'channel', name: 'Store sales' } });
  onboarding.addFact({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, fact: { factKind: 'confirmed_fact', subject: 'Business', predicate: 'operates_as', value: 'Retail', source: 'owner' } });
  onboarding.addTerm({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, term: { term: 'Revenue', definition: 'Net sales', source: 'owner' } });
  onboarding.addGoal({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, goal: { name: 'Grow revenue', targetMetric: 'Revenue', targetValue: 10, targetPeriod: 'FY2027' } });
  onboarding.addKpiDefinition({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, kpi: { name: 'Revenue', description: 'Total net sales', valueType: 'money', calculationMethod: 'sum revenue', sourceHint: 'monthly sales' } });
  onboarding.completeOnboarding({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  return { store, alerts, dashboard, owner, viewer, outsider, organization, profile };
}

test('sync failure rule opens one deduplicated alert with evidence', () => {
  const { store, alerts, owner, organization } = fixture();
  const runId = randomUUID();
  store.integrationSyncRuns.set(runId, { id: runId, organizationId: organization.id, status: 'failed', errorCode: 'SCHEMA_MISMATCH', errorMessage: 'Provider payload changed.', recordsRejected: 4 });
  alerts.createRule({ organizationId: organization.id, actorUserId: owner.id, rule: { name: 'Sync failures', conditionKind: 'sync_failure', severity: 'high' } });

  const first = alerts.evaluateRules({ organizationId: organization.id, actorUserId: owner.id });
  const second = alerts.evaluateRules({ organizationId: organization.id, actorUserId: owner.id });

  assert.equal(first.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(first[0].sourceType, 'integration_sync_run');
  assert.equal(first[0].evidence.errorCode, 'SCHEMA_MISMATCH');
  assert.ok(store.auditEvents.some((event) => event.eventType === 'alert_event.opened'));
});

test('data health and high severity finding rules open alerts from existing records', () => {
  const { store, alerts, owner, organization } = fixture();
  const rejectedId = randomUUID();
  const findingId = randomUUID();
  store.ingestionRuns.set(rejectedId, { id: rejectedId, organizationId: organization.id, status: 'rejected' });
  store.performanceFindings.set(findingId, { id: findingId, organizationId: organization.id, severity: 'high', status: 'open', kind: 'risk', title: 'Revenue decline requires review' });
  alerts.createRule({ organizationId: organization.id, actorUserId: owner.id, rule: { name: 'Rejected data', conditionKind: 'data_health_attention', severity: 'medium', config: { rejectedRunThreshold: 1 } } });
  alerts.createRule({ organizationId: organization.id, actorUserId: owner.id, rule: { name: 'High findings', conditionKind: 'high_severity_finding', severity: 'high' } });

  const events = alerts.evaluateRules({ organizationId: organization.id, actorUserId: owner.id });

  assert.equal(events.length, 2);
  assert.ok(events.some((event) => event.sourceType === 'data_health'));
  assert.ok(events.some((event) => event.sourceType === 'performance_finding'));
});

test('viewer can read alerts but cannot mutate, and outsider is denied', () => {
  const { store, alerts, owner, viewer, outsider, organization } = fixture();
  const runId = randomUUID();
  store.integrationSyncRuns.set(runId, { id: runId, organizationId: organization.id, status: 'failed', errorCode: 'FAILED', errorMessage: 'Sync failed.', recordsRejected: 1 });
  alerts.createRule({ organizationId: organization.id, actorUserId: owner.id, rule: { name: 'Sync failures', conditionKind: 'sync_failure', severity: 'high' } });
  alerts.evaluateRules({ organizationId: organization.id, actorUserId: owner.id });

  assert.equal(alerts.listEvents({ organizationId: organization.id, actorUserId: viewer.id }).length, 1);
  assert.throws(() => alerts.evaluateRules({ organizationId: organization.id, actorUserId: viewer.id }), /Capability required/);
  assert.throws(() => alerts.listEvents({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
});

test('alert acknowledgment, resolution, and notification state are audited', () => {
  const { store, alerts, owner, organization } = fixture();
  const runId = randomUUID();
  store.integrationSyncRuns.set(runId, { id: runId, organizationId: organization.id, status: 'failed', errorCode: 'FAILED', errorMessage: 'Sync failed.', recordsRejected: 1 });
  alerts.createRule({ organizationId: organization.id, actorUserId: owner.id, rule: { name: 'Sync failures', conditionKind: 'sync_failure', severity: 'critical' } });
  const [event] = alerts.evaluateRules({ organizationId: organization.id, actorUserId: owner.id });
  const notification = alerts.createNotification({ organizationId: organization.id, actorUserId: owner.id, alertEventId: event.id, channel: 'email', recipient: 'ops@example.com' });

  alerts.markNotification({ organizationId: organization.id, actorUserId: owner.id, alertNotificationId: notification.id, status: 'sent' });
  alerts.acknowledgeEvent({ organizationId: organization.id, actorUserId: owner.id, alertEventId: event.id });
  const resolved = alerts.resolveEvent({ organizationId: organization.id, actorUserId: owner.id, alertEventId: event.id });

  assert.equal(resolved.status, 'resolved');
  assert.equal(alertSummary([...store.alertEvents.values()]).state, 'ready');
  assert.ok(store.auditEvents.some((item) => item.eventType === 'alert_notification.sent'));
});

test('dashboard surfaces unresolved alerts', () => {
  const { store, alerts, dashboard, owner, organization, profile } = fixture();
  const runId = randomUUID();
  store.integrationSyncRuns.set(runId, { id: runId, organizationId: organization.id, status: 'failed', errorCode: 'FAILED', errorMessage: 'Sync failed.', recordsRejected: 1 });
  alerts.createRule({ organizationId: organization.id, actorUserId: owner.id, rule: { name: 'Sync failures', conditionKind: 'sync_failure', severity: 'high' } });
  alerts.evaluateRules({ organizationId: organization.id, actorUserId: owner.id });

  const state = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(state.alerts.length, 1);
  assert.ok(state.snapshot.summary.modules.includes('Alerts'));
});
