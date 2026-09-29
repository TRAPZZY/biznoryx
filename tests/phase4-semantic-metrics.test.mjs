import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService } from '../src/business/onboarding.mjs';
import { DataIngestionService } from '../src/ingestion/foundation.mjs';
import { SemanticMetricService, mapRows } from '../src/metrics/engine.mjs';

function fixture() {
  const store = createEmptyStore();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const ingestion = new DataIngestionService(store, auditLog);
  const metrics = new SemanticMetricService(store, auditLog);
  const owner = identity.createUser({ email: 'metric-owner@example.com', displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: 'metric-viewer@example.com', displayName: 'Viewer', password: 'viewer password ok' });
  const organization = orgs.createOrganization({ name: 'Metric Acme', slug: 'metric-acme', actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const profile = onboarding.createOrUpdateProfile({
    organizationId: organization.id,
    actorUserId: owner.id,
    profile: {
      legalName: 'Metric Acme Ltd',
      industry: 'Retail',
      businessModel: 'Retail sales',
      primaryCurrency: 'USD',
      fiscalYearStartMonth: 1,
      timezone: 'America/New_York'
    }
  });
  const kpi = onboarding.addKpiDefinition({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    kpi: {
      name: 'Revenue',
      description: 'Total net sales',
      valueType: 'money',
      calculationMethod: 'sum mapped revenue field',
      sourceHint: 'monthly sales stream'
    }
  });
  const source = ingestion.createDataSource({ organizationId: organization.id, actorUserId: owner.id, source: { name: 'Sales Uploads' } });
  const stream = ingestion.createDataStream({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    stream: { name: 'monthly_sales', displayName: 'Monthly sales', grain: 'monthly' }
  });
  const uploadResult = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: {
      originalFilename: 'sales.csv',
      contentType: 'text/csv',
      byteSize: 200,
      content: 'date,revenue,region\n2027-01-01,100,North',
      rowCount: 2,
      columns: [
        { name: 'date', type: 'date', required: true },
        { name: 'revenue', type: 'money', required: true },
        { name: 'region', type: 'text', required: false }
      ]
    },
    reportingPeriod: { periodStart: '2027-01-01', periodEnd: '2027-01-31', label: 'January 2027' }
  });
  return { store, metrics, owner, viewer, organization, kpi, stream, uploadResult };
}

function activeMapping(metrics, organization, owner, stream, schemaVersionId) {
  const mapping = metrics.createSemanticMapping({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataStreamId: stream.id,
    schemaVersionId,
    fields: [
      { sourceColumn: 'date', canonicalField: 'transaction_date', fieldType: 'date' },
      { sourceColumn: 'revenue', canonicalField: 'revenue', fieldType: 'measure' },
      { sourceColumn: 'region', canonicalField: 'region', fieldType: 'dimension', required: false }
    ]
  });
  return metrics.activateSemanticMapping({ organizationId: organization.id, actorUserId: owner.id, semanticMappingId: mapping.id });
}

test('semantic mapping activates and deterministic revenue metric is calculated from mapped rows', () => {
  const { store, metrics, owner, organization, kpi, stream, uploadResult } = fixture();
  const mapping = activeMapping(metrics, organization, owner, stream, uploadResult.schemaVersion.id);
  const spec = metrics.createMetricSpec({
    organizationId: organization.id,
    actorUserId: owner.id,
    kpiDefinitionId: kpi.id,
    semanticMappingId: mapping.id,
    spec: { operation: 'sum', measureField: 'revenue' }
  });
  const result = metrics.calculateMetric({
    organizationId: organization.id,
    actorUserId: owner.id,
    metricCalculationSpecId: spec.id,
    ingestionRunId: uploadResult.ingestionRun.id,
    rows: [
      { date: '2027-01-01', revenue: '100.25', region: 'North' },
      { date: '2027-01-02', revenue: '50.75', region: 'South' }
    ]
  });

  assert.equal(result.metricRun.status, 'calculated');
  assert.equal(result.metricRun.value, 151);
  assert.equal(result.metricRun.evidence.rowCount, 2);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'metric_run.calculated'));
});

test('semantic mapping cannot reference missing source columns', () => {
  const { metrics, owner, organization, stream, uploadResult } = fixture();
  assert.throws(() => metrics.createSemanticMapping({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataStreamId: stream.id,
    schemaVersionId: uploadResult.schemaVersion.id,
    fields: [{ sourceColumn: 'missing', canonicalField: 'revenue', fieldType: 'measure' }]
  }), /Source column not found/);
});

test('metric spec requires active mapping and mapped measure field', () => {
  const { metrics, owner, organization, kpi, stream, uploadResult } = fixture();
  const draft = metrics.createSemanticMapping({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataStreamId: stream.id,
    schemaVersionId: uploadResult.schemaVersion.id,
    fields: [{ sourceColumn: 'date', canonicalField: 'transaction_date', fieldType: 'date' }]
  });

  assert.throws(() => metrics.createMetricSpec({
    organizationId: organization.id,
    actorUserId: owner.id,
    kpiDefinitionId: kpi.id,
    semanticMappingId: draft.id,
    spec: { operation: 'sum', measureField: 'revenue' }
  }), /active semantic mapping/);
});

test('invalid metric rows are rejected instead of inventing values', () => {
  const { metrics, owner, organization, kpi, stream, uploadResult } = fixture();
  const mapping = activeMapping(metrics, organization, owner, stream, uploadResult.schemaVersion.id);
  const spec = metrics.createMetricSpec({
    organizationId: organization.id,
    actorUserId: owner.id,
    kpiDefinitionId: kpi.id,
    semanticMappingId: mapping.id,
    spec: { operation: 'sum', measureField: 'revenue' }
  });
  const result = metrics.calculateMetric({
    organizationId: organization.id,
    actorUserId: owner.id,
    metricCalculationSpecId: spec.id,
    ingestionRunId: uploadResult.ingestionRun.id,
    rows: [{ date: '2027-01-01', revenue: 'not-a-number', region: 'North' }]
  });

  assert.equal(result.metricRun.status, 'rejected');
  assert.equal(result.metricRun.value, null);
  assert.ok(result.validationResults.some((item) => item.code === 'NON_NUMERIC_MEASURE'));
});

test('viewer cannot create mappings or calculate metrics', () => {
  const { metrics, viewer, organization, stream, uploadResult } = fixture();
  assert.throws(() => metrics.createSemanticMapping({
    organizationId: organization.id,
    actorUserId: viewer.id,
    dataStreamId: stream.id,
    schemaVersionId: uploadResult.schemaVersion.id,
    fields: [{ sourceColumn: 'revenue', canonicalField: 'revenue', fieldType: 'measure' }]
  }), /Capability required/);
});

test('row mapping uses canonical fields only', () => {
  const mapped = mapRows([{ Revenue: '10', Region: 'North' }], [
    { sourceColumn: 'Revenue', canonicalField: 'revenue' },
    { sourceColumn: 'Region', canonicalField: 'region' }
  ]);
  assert.deepEqual(mapped, [{ revenue: '10', region: 'North' }]);
});
