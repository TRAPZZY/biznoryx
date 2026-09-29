import { createHash, randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

const ALLOWED_EXTENSIONS = new Set(['csv', 'json', 'xlsx']);
const ALLOWED_CONTENT_TYPES = new Set([
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const GRAINS = new Set(['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'ad_hoc']);

export function createIngestionStoreShape(store) {
  store.dataSources ??= new Map();
  store.dataStreams ??= new Map();
  store.streamSchemaVersions ??= new Map();
  store.reportingPeriods ??= new Map();
  store.rawDataObjects ??= new Map();
  store.ingestionRuns ??= new Map();
  store.ingestionValidationResults ??= new Map();
  return store;
}

export class DataIngestionService {
  constructor(store, auditLog) {
    this.store = createIngestionStoreShape(store);
    this.auditLog = auditLog;
  }

  createDataSource({ organizationId, actorUserId, source }) {
    this.requireWrite({ organizationId, actorUserId });
    if (!clean(source.name)) throw new AuthError('Data source name is required.', 'VALIDATION_FAILED');
    const sourceType = source.sourceType ?? 'manual_upload';
    if (!['manual_upload', 'api', 'database', 'webhook', 'object_storage'].includes(sourceType)) {
      throw new AuthError('Unsupported data source type.', 'VALIDATION_FAILED');
    }
    const duplicate = [...this.store.dataSources.values()].find((item) => item.organizationId === organizationId && item.name.toLowerCase() === clean(source.name).toLowerCase());
    if (duplicate) throw new AuthError('Data source already exists.', 'DUPLICATE_DATA_SOURCE');
    const dataSource = {
      id: randomUUID(),
      organizationId,
      name: clean(source.name),
      sourceType,
      description: optionalClean(source.description),
      status: 'active',
      createdByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.store.dataSources.set(dataSource.id, dataSource);
    this.recordAudit(organizationId, actorUserId, 'data_source.created', 'data_source', dataSource.id);
    return dataSource;
  }

  createDataStream({ organizationId, actorUserId, dataSourceId, stream }) {
    this.requireWrite({ organizationId, actorUserId });
    this.requireDataSource(organizationId, dataSourceId);
    if (!clean(stream.name) || !clean(stream.displayName)) throw new AuthError('Data stream name and display name are required.', 'VALIDATION_FAILED');
    if (!GRAINS.has(stream.grain)) throw new AuthError('Unsupported data stream grain.', 'VALIDATION_FAILED');
    const duplicate = [...this.store.dataStreams.values()].find((item) =>
      item.organizationId === organizationId
      && item.dataSourceId === dataSourceId
      && item.name.toLowerCase() === clean(stream.name).toLowerCase()
    );
    if (duplicate) throw new AuthError('Data stream already exists for this source.', 'DUPLICATE_DATA_STREAM');
    const dataStream = {
      id: randomUUID(),
      organizationId,
      dataSourceId,
      name: clean(stream.name),
      displayName: clean(stream.displayName),
      grain: stream.grain,
      expectedSchemaFingerprint: null,
      activeSchemaVersionId: null,
      createdByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.store.dataStreams.set(dataStream.id, dataStream);
    this.recordAudit(organizationId, actorUserId, 'data_stream.created', 'data_stream', dataStream.id);
    return dataStream;
  }

  registerUpload({ organizationId, actorUserId, dataSourceId, dataStreamId, upload, reportingPeriod }) {
    this.requireWrite({ organizationId, actorUserId });
    const dataSource = this.requireDataSource(organizationId, dataSourceId);
    const dataStream = this.requireDataStream(organizationId, dataStreamId);
    if (dataStream.dataSourceId !== dataSource.id) throw new AuthError('Data stream does not belong to data source.', 'VALIDATION_FAILED');

    const validation = validateUpload(upload);
    const columns = profileColumns(upload.columns);
    const schemaFingerprint = fingerprintSchema(columns);
    const drift = classifySchemaDrift(dataStream.expectedSchemaFingerprint, activeColumns(this.store, dataStream), columns);
    const rowCount = Number(upload.rowCount);
    if (!Number.isInteger(rowCount) || rowCount < 0) validation.push(errorResult('INVALID_ROW_COUNT', 'Upload row count must be a non-negative integer.'));
    if (drift.classification === 'breaking') validation.push(errorResult('SCHEMA_DRIFT_BREAKING', drift.message));
    if (drift.classification === 'potentially_compatible') validation.push(warningResult('SCHEMA_DRIFT_REVIEW', drift.message));

    const rawObject = this.createRawObject({ organizationId, actorUserId, upload, accepted: validation.every((item) => item.severity !== 'error') });
    const period = this.findOrCreateReportingPeriod({ organizationId, dataStreamId, reportingPeriod });
    const schemaVersion = validation.some((item) => item.code === 'SCHEMA_DRIFT_BREAKING')
      ? null
      : this.findOrCreateSchemaVersion({ organizationId, actorUserId, dataStream, schemaFingerprint, columns });
    const status = validation.some((item) => item.severity === 'error') ? 'rejected' : 'validated';
    const ingestionRun = {
      id: randomUUID(),
      organizationId,
      dataSourceId,
      dataStreamId,
      reportingPeriodId: period.id,
      rawDataObjectId: rawObject.id,
      schemaVersionId: schemaVersion?.id ?? null,
      status,
      schemaDrift: drift.classification,
      rowCount: Number.isInteger(rowCount) ? rowCount : 0,
      columnCount: columns.length,
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.ingestionRuns.set(ingestionRun.id, ingestionRun);
    for (const result of validation) {
      const validationResultId = randomUUID();
      this.store.ingestionValidationResults.set(validationResultId, {
        id: validationResultId,
        organizationId,
        ingestionRunId: ingestionRun.id,
        ...result,
        createdAt: new Date()
      });
    }
    if (status === 'validated' && schemaVersion) {
      dataStream.expectedSchemaFingerprint = schemaFingerprint;
      dataStream.activeSchemaVersionId = schemaVersion.id;
      dataStream.updatedAt = new Date();
    }
    this.recordAudit(organizationId, actorUserId, `ingestion_run.${status}`, 'ingestion_run', ingestionRun.id, { schemaDrift: drift.classification });
    return { ingestionRun, rawObject, reportingPeriod: period, schemaVersion, validationResults: validation };
  }

  getIngestionSummary({ organizationId, actorUserId, dataStreamId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    const dataStream = this.requireDataStream(organizationId, dataStreamId);
    const runs = [...this.store.ingestionRuns.values()].filter((run) => run.organizationId === organizationId && run.dataStreamId === dataStream.id);
    return {
      state: runs.length === 0 ? 'empty' : 'ready',
      dataStream,
      counts: {
        runs: runs.length,
        validated: runs.filter((run) => run.status === 'validated').length,
        rejected: runs.filter((run) => run.status === 'rejected').length,
        schemaVersions: [...this.store.streamSchemaVersions.values()].filter((version) => version.organizationId === organizationId && version.dataStreamId === dataStream.id).length
      }
    };
  }

  createRawObject({ organizationId, actorUserId, upload, accepted }) {
    const rawObject = {
      id: randomUUID(),
      organizationId,
      storageKey: `org/${organizationId}/raw/${randomUUID()}/${clean(upload.originalFilename)}`,
      originalFilename: clean(upload.originalFilename),
      contentType: clean(upload.contentType),
      byteSize: upload.byteSize,
      checksumSha256: checksum(upload.content),
      status: accepted ? 'accepted' : 'rejected',
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.rawDataObjects.set(rawObject.id, rawObject);
    return rawObject;
  }

  findOrCreateSchemaVersion({ organizationId, actorUserId, dataStream, schemaFingerprint, columns }) {
    const existing = [...this.store.streamSchemaVersions.values()].find((version) =>
      version.organizationId === organizationId
      && version.dataStreamId === dataStream.id
      && version.schemaFingerprint === schemaFingerprint
    );
    if (existing) return existing;
    const versions = [...this.store.streamSchemaVersions.values()].filter((version) => version.organizationId === organizationId && version.dataStreamId === dataStream.id);
    const schemaVersion = {
      id: randomUUID(),
      organizationId,
      dataStreamId: dataStream.id,
      version: versions.length + 1,
      schemaFingerprint,
      columns,
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.streamSchemaVersions.set(schemaVersion.id, schemaVersion);
    return schemaVersion;
  }

  findOrCreateReportingPeriod({ organizationId, dataStreamId, reportingPeriod }) {
    validateReportingPeriod(reportingPeriod);
    const existing = [...this.store.reportingPeriods.values()].find((period) =>
      period.organizationId === organizationId
      && period.dataStreamId === dataStreamId
      && period.periodStart === reportingPeriod.periodStart
      && period.periodEnd === reportingPeriod.periodEnd
    );
    if (existing) return existing;
    const period = {
      id: randomUUID(),
      organizationId,
      dataStreamId,
      periodStart: reportingPeriod.periodStart,
      periodEnd: reportingPeriod.periodEnd,
      label: clean(reportingPeriod.label),
      createdAt: new Date()
    };
    this.store.reportingPeriods.set(period.id, period);
    return period;
  }

  requireWrite({ organizationId, actorUserId }) {
    return new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.WRITE_BUSINESS_DATA });
  }

  requireDataSource(organizationId, dataSourceId) {
    const source = this.store.dataSources.get(dataSourceId);
    if (!source || source.organizationId !== organizationId) throw new AuthError('Data source not found.', 'NOT_FOUND');
    return source;
  }

  requireDataStream(organizationId, dataStreamId) {
    const stream = this.store.dataStreams.get(dataStreamId);
    if (!stream || stream.organizationId !== organizationId) throw new AuthError('Data stream not found.', 'NOT_FOUND');
    return stream;
  }

  recordAudit(organizationId, actorUserId, eventType, targetType, targetId, metadata = {}) {
    this.auditLog?.record({ organizationId, actorUserId, eventType, targetType, targetId, metadata });
  }
}

export function validateUpload(upload) {
  const results = [];
  const filename = clean(upload.originalFilename);
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) results.push(errorResult('FILE_EXTENSION_NOT_ALLOWED', 'Only CSV, JSON, and XLSX uploads are accepted.'));
  if (!ALLOWED_CONTENT_TYPES.has(clean(upload.contentType))) results.push(errorResult('CONTENT_TYPE_NOT_ALLOWED', 'Upload content type is not allowed.'));
  if (!Number.isInteger(upload.byteSize) || upload.byteSize <= 0) results.push(errorResult('INVALID_FILE_SIZE', 'Upload byte size must be positive.'));
  if (upload.byteSize > 25 * 1024 * 1024) results.push(errorResult('FILE_TOO_LARGE', 'Upload exceeds the 25MB Phase 3 limit.'));
  if (!Array.isArray(upload.columns) || upload.columns.length === 0) results.push(errorResult('MISSING_COLUMNS', 'Upload must include at least one column profile.'));
  if (typeof upload.content !== 'string' || upload.content.length === 0) results.push(errorResult('MISSING_CONTENT', 'Upload content is required for checksum registration.'));
  return results;
}

export function profileColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.map((column) => {
    const name = clean(column.name);
    const type = clean(column.type || 'text').toLowerCase();
    if (!name) throw new AuthError('Column name is required.', 'VALIDATION_FAILED');
    return { name, type, required: Boolean(column.required) };
  });
}

export function fingerprintSchema(columns) {
  const canonical = columns
    .map((column) => `${column.name.toLowerCase()}:${column.type}:${column.required ? 'required' : 'optional'}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export function classifySchemaDrift(existingFingerprint, existingColumns, newColumns) {
  if (!existingFingerprint || existingColumns.length === 0) return { classification: 'none', message: 'Initial schema baseline established.' };
  const newFingerprint = fingerprintSchema(newColumns);
  if (newFingerprint === existingFingerprint) return { classification: 'none', message: 'Schema matches active baseline.' };
  const existingByName = new Map(existingColumns.map((column) => [column.name.toLowerCase(), column]));
  const newByName = new Map(newColumns.map((column) => [column.name.toLowerCase(), column]));
  for (const existing of existingColumns) {
    const next = newByName.get(existing.name.toLowerCase());
    if (!next && existing.required) return { classification: 'breaking', message: `Required column removed: ${existing.name}` };
    if (next && next.type !== existing.type) return { classification: 'potentially_compatible', message: `Column type changed: ${existing.name}` };
  }
  for (const next of newColumns) {
    if (!existingByName.has(next.name.toLowerCase()) && next.required) {
      return { classification: 'potentially_compatible', message: `New required column added: ${next.name}` };
    }
  }
  return { classification: 'compatible', message: 'Only optional columns changed.' };
}

function activeColumns(store, dataStream) {
  if (!dataStream.activeSchemaVersionId) return [];
  return store.streamSchemaVersions.get(dataStream.activeSchemaVersionId)?.columns ?? [];
}

function validateReportingPeriod(reportingPeriod) {
  if (!reportingPeriod || !clean(reportingPeriod.periodStart) || !clean(reportingPeriod.periodEnd) || !clean(reportingPeriod.label)) {
    throw new AuthError('Reporting period start, end, and label are required.', 'VALIDATION_FAILED');
  }
  if (reportingPeriod.periodEnd < reportingPeriod.periodStart) {
    throw new AuthError('Reporting period end must be after start.', 'VALIDATION_FAILED');
  }
}

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

function errorResult(code, message) {
  return { severity: 'error', code, message };
}

function warningResult(code, message) {
  return { severity: 'warning', code, message };
}

function clean(value) {
  return String(value ?? '').trim();
}

function optionalClean(value) {
  const cleaned = clean(value);
  return cleaned === '' ? null : cleaned;
}
