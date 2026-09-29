import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { DataIngestionService, classifySchemaDrift, fingerprintSchema, profileColumns } from '../src/ingestion/foundation.mjs';

function fixture() {
  const store = createEmptyStore();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const ingestion = new DataIngestionService(store, auditLog);
  const owner = identity.createUser({ email: 'owner-ingest@example.com', displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: 'viewer-ingest@example.com', displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: 'outsider-ingest@example.com', displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Ingest Acme', slug: 'ingest-acme', actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  const source = ingestion.createDataSource({ organizationId: organization.id, actorUserId: owner.id, source: { name: 'Monthly Sales Uploads' } });
  const stream = ingestion.createDataStream({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    stream: { name: 'monthly_sales', displayName: 'Monthly sales', grain: 'monthly' }
  });
  return { store, ingestion, owner, viewer, outsider, organization, source, stream };
}

function upload(overrides = {}) {
  return {
    originalFilename: 'january-sales.csv',
    contentType: 'text/csv',
    byteSize: 128,
    content: 'date,revenue\n2027-01-01,1200',
    rowCount: 1,
    columns: [
      { name: 'date', type: 'date', required: true },
      { name: 'revenue', type: 'money', required: true }
    ],
    ...overrides
  };
}

function period(label = 'January 2027') {
  return { periodStart: '2027-01-01', periodEnd: '2027-01-31', label };
}

test('first valid recurring upload establishes immutable raw object, period, and schema baseline', () => {
  const { store, ingestion, owner, organization, source, stream } = fixture();
  const result = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload(),
    reportingPeriod: period()
  });

  assert.equal(result.ingestionRun.status, 'validated');
  assert.equal(result.ingestionRun.schemaDrift, 'none');
  assert.equal(result.rawObject.status, 'accepted');
  assert.equal(result.schemaVersion.version, 1);
  assert.equal(ingestion.getIngestionSummary({ organizationId: organization.id, actorUserId: owner.id, dataStreamId: stream.id }).counts.validated, 1);
  assert.ok(store.auditEvents.some((event) => event.eventType === 'ingestion_run.validated'));
});

test('later upload for the same stream extends recurring history instead of creating unrelated analysis', () => {
  const { ingestion, owner, organization, source, stream } = fixture();
  ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload(),
    reportingPeriod: period()
  });
  const second = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload({ originalFilename: 'february-sales.csv', content: 'date,revenue\n2027-02-01,1400' }),
    reportingPeriod: { periodStart: '2027-02-01', periodEnd: '2027-02-28', label: 'February 2027' }
  });

  const summary = ingestion.getIngestionSummary({ organizationId: organization.id, actorUserId: owner.id, dataStreamId: stream.id });
  assert.equal(second.schemaVersion.version, 1);
  assert.equal(summary.counts.runs, 2);
  assert.equal(summary.counts.schemaVersions, 1);
});

test('breaking schema drift rejects upload and preserves active baseline', () => {
  const { ingestion, owner, organization, source, stream } = fixture();
  const first = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload(),
    reportingPeriod: period()
  });
  const rejected = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload({
      originalFilename: 'march-sales.csv',
      content: 'date\n2027-03-01',
      columns: [{ name: 'date', type: 'date', required: true }]
    }),
    reportingPeriod: { periodStart: '2027-03-01', periodEnd: '2027-03-31', label: 'March 2027' }
  });

  assert.equal(rejected.ingestionRun.status, 'rejected');
  assert.equal(rejected.ingestionRun.schemaDrift, 'breaking');
  assert.equal(rejected.schemaVersion, null);
  assert.equal(stream.activeSchemaVersionId, first.schemaVersion.id);
});

test('unsafe upload extension and content type are rejected before acceptance', () => {
  const { ingestion, owner, organization, source, stream } = fixture();
  const result = ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: owner.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload({ originalFilename: 'payload.exe', contentType: 'application/x-msdownload' }),
    reportingPeriod: period()
  });

  assert.equal(result.ingestionRun.status, 'rejected');
  assert.equal(result.rawObject.status, 'rejected');
  assert.ok(result.validationResults.some((item) => item.code === 'FILE_EXTENSION_NOT_ALLOWED'));
  assert.ok(result.validationResults.some((item) => item.code === 'CONTENT_TYPE_NOT_ALLOWED'));
});

test('viewer and outsider cannot mutate ingestion records', () => {
  const { ingestion, viewer, outsider, organization, source, stream } = fixture();
  assert.throws(() => ingestion.registerUpload({
    organizationId: organization.id,
    actorUserId: viewer.id,
    dataSourceId: source.id,
    dataStreamId: stream.id,
    upload: upload(),
    reportingPeriod: period()
  }), /Capability required/);

  assert.throws(() => ingestion.createDataSource({
    organizationId: organization.id,
    actorUserId: outsider.id,
    source: { name: 'Outsider source' }
  }), /Active organization membership/);
});

test('schema fingerprinting is deterministic and drift classification is explicit', () => {
  const baseline = profileColumns([
    { name: 'Revenue', type: 'money', required: true },
    { name: 'Date', type: 'date', required: true }
  ]);
  const reordered = profileColumns([
    { name: 'Date', type: 'date', required: true },
    { name: 'Revenue', type: 'money', required: true }
  ]);
  assert.equal(fingerprintSchema(baseline), fingerprintSchema(reordered));
  assert.equal(classifySchemaDrift(fingerprintSchema(baseline), baseline, reordered).classification, 'none');
  assert.equal(classifySchemaDrift(fingerprintSchema(baseline), baseline, [...baseline, { name: 'sales_rep', type: 'text', required: false }]).classification, 'compatible');
});
