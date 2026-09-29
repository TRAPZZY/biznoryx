import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { BaselineDashboardService } from '../src/dashboard/baseline.mjs';
import { IntegrationSyncService, integrationHealth } from '../src/integrations/sync.mjs';

function fixture() {
  const store = createEmptyStore();
  store.dataSources = new Map();
  store.reportingPeriods = new Map();
  store.verifiedMetricRuns = new Map();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const integrations = new IntegrationSyncService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `sync-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const analyst = identity.createUser({ email: `sync-analyst-${Math.random()}@example.com`, displayName: 'Analyst', password: 'analyst password ok' });
  const viewer = identity.createUser({ email: `sync-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `sync-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Sync Acme', slug: `sync-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: analyst.id, role: 'analyst', actorUserId: owner.id });
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Sync Acme Ltd',
      tradingName: 'Sync Acme',
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
  onboarding.addKpiDefinition({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    kpi: { name: 'Revenue', description: 'Total net sales', valueType: 'money', calculationMethod: 'sum revenue', sourceHint: 'monthly sales' }
  });
  onboarding.completeOnboarding({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  const dataSource = {
    id: randomUUID(),
    organizationId: organization.id,
    name: 'Accounting Connector',
    sourceType: 'api',
    createdByUserId: owner.id
  };
  store.dataSources.set(dataSource.id, dataSource);
  return { store, integrations, dashboard, owner, analyst, viewer, outsider, organization, profile, dataSource };
}

test('analyst creates active connection using secret reference and no raw credentials', () => {
  const { store, integrations, analyst, organization, dataSource } = fixture();

  const connection = integrations.createConnection({
    organizationId: organization.id,
    actorUserId: analyst.id,
    dataSourceId: dataSource.id,
    connection: {
      providerKey: 'custom_accounting',
      providerKind: 'accounting',
      displayName: 'Accounting API',
      status: 'active',
      scopes: ['transactions:read'],
      secretRef: 'vault://org/sync/accounting',
      config: { baseUrl: 'https://api.example.invalid', mode: 'read_only' }
    }
  });

  assert.equal(connection.status, 'active');
  assert.equal(connection.secretRef, 'vault://org/sync/accounting');
  assert.ok(store.auditEvents.some((event) => event.eventType === 'integration_connection.created'));
});

test('raw secrets in connection config are rejected', () => {
  const { integrations, analyst, organization } = fixture();

  assert.throws(() => integrations.createConnection({
    organizationId: organization.id,
    actorUserId: analyst.id,
    connection: {
      providerKey: 'bad_provider',
      providerKind: 'custom_api',
      displayName: 'Bad Provider',
      status: 'draft',
      config: { apiKey: 'do-not-store-here' }
    }
  }), /raw secrets/);
});

test('sync runs are idempotent and update freshness on success', () => {
  const { store, integrations, owner, organization } = fixture();
  const connection = activeConnection(integrations, owner, organization.id);

  const first = integrations.startSyncRun({ organizationId: organization.id, actorUserId: owner.id, integrationConnectionId: connection.id, idempotencyKey: 'sync-2027-02' });
  const replay = integrations.startSyncRun({ organizationId: organization.id, actorUserId: owner.id, integrationConnectionId: connection.id, idempotencyKey: 'sync-2027-02' });
  const finished = integrations.finishSyncRun({
    organizationId: organization.id,
    actorUserId: owner.id,
    integrationSyncRunId: first.id,
    result: { status: 'succeeded', recordsSeen: 10, recordsAccepted: 9, recordsRejected: 1, evidence: { window: '2027-02' } }
  });

  assert.equal(first.id, replay.id);
  assert.equal(finished.status, 'succeeded');
  assert.equal(store.integrationConnections.get(connection.id).lastSuccessfulSyncAt, finished.finishedAt);
  assert.equal(integrationHealth([...store.integrationConnections.values()], [...store.integrationSyncRuns.values()]).state, 'ready');
});

test('failed sync marks connection attention without hiding error evidence', () => {
  const { store, integrations, owner, organization } = fixture();
  const connection = activeConnection(integrations, owner, organization.id);
  const run = integrations.startSyncRun({ organizationId: organization.id, actorUserId: owner.id, integrationConnectionId: connection.id, idempotencyKey: 'sync-fail' });

  integrations.finishSyncRun({
    organizationId: organization.id,
    actorUserId: owner.id,
    integrationSyncRunId: run.id,
    result: { status: 'failed', recordsSeen: 4, recordsAccepted: 0, recordsRejected: 4, errorCode: 'SCHEMA_MISMATCH', errorMessage: 'Provider payload did not match mapping.' }
  });

  assert.equal(store.integrationConnections.get(connection.id).status, 'error');
  assert.equal(integrationHealth([...store.integrationConnections.values()], [...store.integrationSyncRuns.values()]).state, 'attention');
});

test('webhook events are fingerprinted and duplicate deliveries are idempotent', () => {
  const { integrations, owner, organization } = fixture();
  const connection = activeConnection(integrations, owner, organization.id);

  const first = integrations.recordWebhookEvent({
    organizationId: organization.id,
    actorUserId: owner.id,
    integrationConnectionId: connection.id,
    providerEventId: 'evt_1',
    idempotencyKey: 'delivery_1',
    payload: { object: 'transaction', id: 'txn_1' }
  });
  const duplicate = integrations.recordWebhookEvent({
    organizationId: organization.id,
    actorUserId: owner.id,
    integrationConnectionId: connection.id,
    providerEventId: 'evt_1',
    idempotencyKey: 'delivery_1',
    payload: { object: 'transaction', id: 'txn_1' }
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(duplicate.status, 'duplicate');
  assert.match(first.payloadFingerprint, /^[a-f0-9]{64}$/);
});

test('viewer can read integrations but cannot mutate sync state, and outsider is denied', () => {
  const { integrations, owner, viewer, outsider, organization } = fixture();
  const connection = activeConnection(integrations, owner, organization.id);

  assert.equal(integrations.listConnections({ organizationId: organization.id, actorUserId: viewer.id }).length, 1);
  assert.throws(() => integrations.startSyncRun({ organizationId: organization.id, actorUserId: viewer.id, integrationConnectionId: connection.id, idempotencyKey: 'viewer-sync' }), /Capability required/);
  assert.throws(() => integrations.listConnections({ organizationId: organization.id, actorUserId: outsider.id }), /Active organization membership/);
});

test('dashboard surfaces integration freshness', () => {
  const { integrations, dashboard, owner, organization, profile } = fixture();
  const connection = activeConnection(integrations, owner, organization.id);
  const run = integrations.startSyncRun({ organizationId: organization.id, actorUserId: owner.id, integrationConnectionId: connection.id, idempotencyKey: 'dashboard-sync' });
  integrations.finishSyncRun({ organizationId: organization.id, actorUserId: owner.id, integrationSyncRunId: run.id, result: { status: 'succeeded', recordsSeen: 2, recordsAccepted: 2, recordsRejected: 0 } });

  const state = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(state.integrations.length, 1);
  assert.equal(state.integrations[0].latestSyncStatus, 'succeeded');
  assert.ok(state.snapshot.summary.modules.includes('Integrations'));
});

function activeConnection(integrations, actor, organizationId) {
  return integrations.createConnection({
    organizationId,
    actorUserId: actor.id,
    connection: {
      providerKey: 'custom_accounting',
      providerKind: 'accounting',
      displayName: `Accounting API ${Math.random()}`,
      status: 'active',
      scopes: ['transactions:read'],
      secretRef: 'vault://org/sync/accounting',
      config: { mode: 'read_only' }
    }
  });
}
