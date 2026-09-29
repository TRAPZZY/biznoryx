import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

const FIELD_TYPES = new Set(['date', 'dimension', 'measure', 'currency', 'identifier']);
const OPERATIONS = new Set(['sum', 'count', 'average']);

export function createMetricStoreShape(store) {
  store.semanticMappings ??= new Map();
  store.semanticMappingFields ??= new Map();
  store.metricCalculationSpecs ??= new Map();
  store.verifiedMetricRuns ??= new Map();
  store.metricRunValidationResults ??= new Map();
  return store;
}

export class SemanticMetricService {
  constructor(store, auditLog) {
    this.store = createMetricStoreShape(store);
    this.auditLog = auditLog;
  }

  createSemanticMapping({ organizationId, actorUserId, dataStreamId, schemaVersionId, fields }) {
    this.requireWrite({ organizationId, actorUserId });
    const dataStream = this.requireOwned(this.store.dataStreams, organizationId, dataStreamId, 'Data stream not found.');
    const schemaVersion = this.requireOwned(this.store.streamSchemaVersions, organizationId, schemaVersionId, 'Schema version not found.');
    if (schemaVersion.dataStreamId !== dataStream.id) throw new AuthError('Schema version does not belong to data stream.', 'VALIDATION_FAILED');
    const sourceColumns = new Set(schemaVersion.columns.map((column) => column.name.toLowerCase()));
    const normalizedFields = validateMappingFields(fields, sourceColumns);
    const versions = [...this.store.semanticMappings.values()].filter((mapping) => mapping.organizationId === organizationId && mapping.dataStreamId === dataStreamId);
    const mapping = {
      id: randomUUID(),
      organizationId,
      dataStreamId,
      schemaVersionId,
      version: versions.length + 1,
      status: 'draft',
      createdByUserId: actorUserId,
      activatedAt: null,
      createdAt: new Date()
    };
    this.store.semanticMappings.set(mapping.id, mapping);
    for (const field of normalizedFields) {
      const id = randomUUID();
      this.store.semanticMappingFields.set(id, { id, organizationId, semanticMappingId: mapping.id, ...field, createdAt: new Date() });
    }
    this.recordAudit(organizationId, actorUserId, 'semantic_mapping.created', 'semantic_mapping', mapping.id);
    return mapping;
  }

  activateSemanticMapping({ organizationId, actorUserId, semanticMappingId }) {
    this.requireWrite({ organizationId, actorUserId });
    const mapping = this.requireOwned(this.store.semanticMappings, organizationId, semanticMappingId, 'Semantic mapping not found.');
    for (const other of this.store.semanticMappings.values()) {
      if (other.organizationId === organizationId && other.dataStreamId === mapping.dataStreamId && other.status === 'active') other.status = 'retired';
    }
    mapping.status = 'active';
    mapping.activatedAt = new Date();
    this.recordAudit(organizationId, actorUserId, 'semantic_mapping.activated', 'semantic_mapping', mapping.id);
    return mapping;
  }

  createMetricSpec({ organizationId, actorUserId, kpiDefinitionId, semanticMappingId, spec }) {
    this.requireWrite({ organizationId, actorUserId });
    const kpi = this.requireOwned(this.store.kpiDefinitions, organizationId, kpiDefinitionId, 'KPI definition not found.');
    const mapping = this.requireOwned(this.store.semanticMappings, organizationId, semanticMappingId, 'Semantic mapping not found.');
    if (mapping.status !== 'active') throw new AuthError('Metric specs require an active semantic mapping.', 'MAPPING_NOT_ACTIVE');
    if (!OPERATIONS.has(spec.operation)) throw new AuthError('Unsupported metric operation.', 'VALIDATION_FAILED');
    if (spec.operation !== 'count' && !clean(spec.measureField)) throw new AuthError('Measure field is required for this operation.', 'VALIDATION_FAILED');
    const fields = mappingFields(this.store, organizationId, mapping.id);
    if (spec.measureField && !fields.some((field) => field.canonicalField === spec.measureField && field.fieldType === 'measure')) {
      throw new AuthError('Measure field is not mapped as a measure.', 'VALIDATION_FAILED');
    }
    const metricSpec = {
      id: randomUUID(),
      organizationId,
      kpiDefinitionId: kpi.id,
      semanticMappingId: mapping.id,
      operation: spec.operation,
      measureField: spec.measureField ?? null,
      filters: spec.filters ?? [],
      groupBy: spec.groupBy ?? [],
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.metricCalculationSpecs.set(metricSpec.id, metricSpec);
    this.recordAudit(organizationId, actorUserId, 'metric_spec.created', 'metric_calculation_spec', metricSpec.id);
    return metricSpec;
  }

  calculateMetric({ organizationId, actorUserId, metricCalculationSpecId, ingestionRunId, rows }) {
    this.requireWrite({ organizationId, actorUserId });
    const spec = this.requireOwned(this.store.metricCalculationSpecs, organizationId, metricCalculationSpecId, 'Metric spec not found.');
    const ingestionRun = this.requireOwned(this.store.ingestionRuns, organizationId, ingestionRunId, 'Ingestion run not found.');
    if (ingestionRun.status !== 'validated') throw new AuthError('Metrics can only be calculated from validated ingestion runs.', 'INGESTION_NOT_VALIDATED');
    const mapping = this.requireOwned(this.store.semanticMappings, organizationId, spec.semanticMappingId, 'Semantic mapping not found.');
    const fields = mappingFields(this.store, organizationId, mapping.id);
    const mappedRows = mapRows(rows, fields);
    const validation = validateRowsForSpec(mappedRows, spec);
    const status = validation.some((item) => item.severity === 'error') ? 'rejected' : 'calculated';
    const value = status === 'calculated' ? calculateValue(mappedRows, spec) : null;
    const runId = randomUUID();
    const metricRun = {
      id: runId,
      organizationId,
      kpiDefinitionId: spec.kpiDefinitionId,
      metricCalculationSpecId: spec.id,
      ingestionRunId: ingestionRun.id,
      reportingPeriodId: ingestionRun.reportingPeriodId,
      status,
      value,
      unit: spec.operation,
      evidence: { rowCount: mappedRows.length, operation: spec.operation, measureField: spec.measureField },
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.verifiedMetricRuns.set(runId, metricRun);
    for (const result of validation) {
      const id = randomUUID();
      this.store.metricRunValidationResults.set(id, { id, organizationId, verifiedMetricRunId: runId, ...result, createdAt: new Date() });
    }
    this.recordAudit(organizationId, actorUserId, `metric_run.${status}`, 'verified_metric_run', metricRun.id);
    return { metricRun, validationResults: validation };
  }

  requireWrite({ organizationId, actorUserId }) {
    return new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.WRITE_BUSINESS_DATA });
  }

  requireOwned(map, organizationId, id, message) {
    const record = map?.get(id);
    if (!record || record.organizationId !== organizationId) throw new AuthError(message, 'NOT_FOUND');
    return record;
  }

  recordAudit(organizationId, actorUserId, eventType, targetType, targetId, metadata = {}) {
    this.auditLog?.record({ organizationId, actorUserId, eventType, targetType, targetId, metadata });
  }
}

export function mapRows(rows, fields) {
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field.canonicalField, row[field.sourceColumn]])));
}

function validateMappingFields(fields, sourceColumns) {
  if (!Array.isArray(fields) || fields.length === 0) throw new AuthError('At least one semantic mapping field is required.', 'VALIDATION_FAILED');
  const canonicalFields = new Set();
  const sourceSeen = new Set();
  return fields.map((field) => {
    const sourceColumn = clean(field.sourceColumn);
    const canonicalField = clean(field.canonicalField);
    if (!sourceColumns.has(sourceColumn.toLowerCase())) throw new AuthError(`Source column not found in schema: ${sourceColumn}`, 'VALIDATION_FAILED');
    if (!FIELD_TYPES.has(field.fieldType)) throw new AuthError('Unsupported semantic field type.', 'VALIDATION_FAILED');
    if (canonicalFields.has(canonicalField.toLowerCase())) throw new AuthError('Duplicate canonical field mapping.', 'VALIDATION_FAILED');
    if (sourceSeen.has(sourceColumn.toLowerCase())) throw new AuthError('Duplicate source column mapping.', 'VALIDATION_FAILED');
    canonicalFields.add(canonicalField.toLowerCase());
    sourceSeen.add(sourceColumn.toLowerCase());
    return { sourceColumn, canonicalField, fieldType: field.fieldType, required: field.required !== false, transform: field.transform ?? {} };
  });
}

function mappingFields(store, organizationId, semanticMappingId) {
  return [...store.semanticMappingFields.values()].filter((field) => field.organizationId === organizationId && field.semanticMappingId === semanticMappingId);
}

function validateRowsForSpec(rows, spec) {
  const results = [];
  if (!Array.isArray(rows) || rows.length === 0) results.push({ severity: 'error', code: 'NO_ROWS', message: 'No rows are available for metric calculation.' });
  if (spec.measureField) {
    for (const [index, row] of rows.entries()) {
      const value = row[spec.measureField];
      if (value === undefined || value === null || value === '') results.push({ severity: 'error', code: 'MISSING_MEASURE', message: `Missing measure field at row ${index + 1}.` });
      if (value !== undefined && value !== null && value !== '' && !Number.isFinite(Number(value))) {
        results.push({ severity: 'error', code: 'NON_NUMERIC_MEASURE', message: `Non-numeric measure at row ${index + 1}.` });
      }
    }
  }
  return results;
}

function calculateValue(rows, spec) {
  if (spec.operation === 'count') return rows.length;
  const values = rows.map((row) => Number(row[spec.measureField]));
  const sum = values.reduce((total, value) => total + value, 0);
  if (spec.operation === 'sum') return sum;
  if (spec.operation === 'average') return values.length === 0 ? null : sum / values.length;
  throw new AuthError('Unsupported metric operation.', 'VALIDATION_FAILED');
}

function clean(value) {
  return String(value ?? '').trim();
}
