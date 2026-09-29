import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { DataIngestionService } from '../src/ingestion/foundation.mjs';
import { SemanticMetricService } from '../src/metrics/engine.mjs';
import { BaselineDashboardService, dashboardShellState } from '../src/dashboard/baseline.mjs';

function fixture({ rejectedRun = false } = {}) {
  const store = createEmptyStore();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const ingestion = new DataIngestionService(store, auditLog);
  const metrics = new SemanticMetricService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: `dashboard-owner-${Math.random()}@example.com`, displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: `dashboard-viewer-${Math.random()}@example.com`, displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: `dashboard-outsider-${Math.random()}@example.com`, displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Dashboard Acme', slug: `dashboard-acme-${Math.random()}`, actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Dashboard Acme Ltd',
      tradingName: 'Dashboard Acme',
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
  const source = ingestion.createDataSource({ organizationId: organization.id, actorUserId: owner.id, source: { name: 'Sales Uploads' } });
  const stream = ingestion.createDataStream({ organizationId: organization.id, actorUserId: owner.id, dataSourceId: source.id, stream: { name: 'monthly_sales', displayName: 'Monthly sales', grain: 'monthly' } });
  const upload = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: {
      originalFilename: 'sales.csv',
      contentType: 'text/csv',
      byteSize: 200,
      content: 'date,revenue\n2027-01-01,100',
      rowCount: 2,
      columns: [{ name: 'date', type: 'date', required: true }, { name: 'revenue', type: 'money', required: true }]
    },
    reportingPeriod: { periodStart: '2027-01-01', periodEnd: '2027-01-31', label: 'January 2027' }
  });
  if (rejectedRun) {
    ingestion.registerUpload({
      organizationId: organization.id,
      actorUserId: owner.id,
      dataSourceId: source.id,
      dataStreamId: stream.id,
      upload: {
        originalFilename: 'bad.csv',
        contentType: 'text/csv',
        byteSize: 100,
        content: 'date\n2027-02-01',
        rowCount: 1,
        columns: [{ name: 'date', type: 'date', required: true }]
      },
      reportingPeriod: { periodStart: '2027-02-01', periodEnd: '2027-02-28', label: 'February 2027' }
    });
  }
  const mapping = metrics.createSemanticMapping({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataStreamId: stream.id,
    schemaVersionId: upload.schemaVersion.id,
    fields: [{ sourceColumn: 'date', canonicalField: 'transaction_date', fieldType: 'date' }, { sourceColumn: 'revenue', canonicalField: 'revenue', fieldType: 'measure' }]
  });
  metrics.activateSemanticMapping({ organizationId: organization.id, actorUserId: owner.id, semanticMappingId: mapping.id });
  const spec = metrics.createMetricSpec({ organizationId: organization.id, actorUserId: owner.id, kpiDefinitionId: kpi.id, semanticMappingId: mapping.id, spec: { operation: 'sum', measureField: 'revenue' } });
  metrics.calculateMetric({ organizationId: organization.id, actorUserId: owner.id, metricCalculationSpecId: spec.id, ingestionRunId: upload.ingestionRun.id, rows: [{ date: '2027-01-01', revenue: '100' }, { date: '2027-01-02', revenue: '50' }] });
  return { store, dashboard, owner, viewer, outsider, organization, profile, upload };
}

test('baseline dashboard uses verified metrics and evidence links', () => {
  const { store, dashboard, owner, organization, profile, upload } = fixture();
  const result = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, reportingPeriodId: upload.reportingPeriod.id });

  assert.equal(result.state, 'ready');
  assert.equal(result.kpis[0].label, 'Revenue');
  assert.equal(result.kpis[0].value, 150);
  assert.equal(result.kpis[0].status, 'verified');
  assert.equal(result.dataHealth.status, 'healthy');
  assert.ok(result.snapshot.summary.modules.includes('KPI Scoreboard'));
  assert.ok(result.snapshot.evidence[0].verifiedMetricRunId);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'dashboard_snapshot.generated'));
  assert.equal(dashboardShellState(result).state, 'ready');
});

test('dashboard surfaces data health attention instead of hiding ingestion issues', () => {
  const { dashboard, owner, organization, profile, upload } = fixture({ rejectedRun: true });
  const result = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, reportingPeriodId: upload.reportingPeriod.id });

  assert.equal(result.dataHealth.status, 'attention');
  assert.equal(dashboardShellState(result).state, 'attention');
  assert.ok(result.risks.some((risk) => risk.includes('rejected')));
});

test('dashboard is empty when no verified metrics exist', () => {
  const { dashboard, owner, organization, profile } = fixture();
  const result = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id, reportingPeriodId: 'missing-period' });

  assert.equal(result.state, 'empty');
  assert.equal(dashboardShellState(result).state, 'empty');
  assert.equal(result.snapshot.summary.pulse, 'No verified KPI values are available for this reporting period.');
});

test('viewer can read dashboard but outsider is denied', () => {
  const { dashboard, viewer, outsider, organization, profile, upload } = fixture();
  const result = dashboard.buildDashboard({ organizationId: organization.id, actorUserId: viewer.id, businessProfileId: profile.id, reportingPeriodId: upload.reportingPeriod.id });
  assert.equal(result.state, 'ready');

  assert.throws(() => dashboard.buildDashboard({
    organizationId: organization.id,
    actorUserId: outsider.id,
    businessProfileId: profile.id,
    reportingPeriodId: upload.reportingPeriod.id
  }), /Active organization membership/);
});

test('dashboard cannot generate before onboarding is complete', () => {
  const store = createEmptyStore();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const dashboard = new BaselineDashboardService(store, auditLog);
  const owner = identity.createUser({ email: 'incomplete-dashboard@example.com', displayName: 'Owner', password: 'owner password ok' });
  const organization = orgs.createOrganization({ name: 'Incomplete Dashboard', slug: 'incomplete-dashboard', actorUserId: owner.id }).organization;
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: { legalName: 'Incomplete Ltd', industry: 'Retail', businessModel: 'Retail', primaryCurrency: 'USD', fiscalYearStartMonth: 1, timezone: 'America/New_York' }
  });

  assert.throws(() => dashboard.buildDashboard({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id }), /Business onboarding/);
});
