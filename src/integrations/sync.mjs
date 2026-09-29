import { createHash, randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export const PROVIDER_KINDS = Object.freeze(['accounting', 'commerce', 'crm', 'payments', 'database', 'file_storage', 'custom_api']);
export const CONNECTION_STATUSES = Object.freeze(['draft', 'active', 'paused', 'error', 'revoked']);
export const SYNC_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export function createIntegrationStoreShape(store) {
  store.integrationConnections ??= new Map();
  store.integrationSyncRuns ??= new Map();
  store.integrationWebhookEvents ??= new Map();
  return store;
}

export class IntegrationSyncService {
  constructor(store, auditLog) {
    this.store = createIntegrationStoreShape(store);
    this.auditLog = auditLog;
  }

  createConnection({ organizationId, actorUserId, dataSourceId = null, connection }) {
    this.requireWrite({ organizationId, actorUserId });
    if (dataSourceId) this.requireOwned(this.store.dataSources, organizationId, dataSourceId, 'Data source not found.');
    validateProviderKind(connection.providerKind);
    if (!connection.secretRef && connection.status === 'active') {
      throw new AuthError('Active integrations require a secret reference.', 'INTEGRATION_SECRET_REQUIRED');
    }
    rejectRawSecrets(connection.config);
    const integration = {
      id: randomUUID(),
      organizationId,
      dataSourceId,
      providerKey: requiredSlug(connection.providerKey, 'Provider key is required.'),
      providerKind: connection.providerKind,
      displayName: requiredText(connection.displayName, 'Display name is required.'),
      status: connection.status ?? 'draft',
      scopes: [...(connection.scopes ?? [])],
      secretRef: connection.secretRef ?? null,
      config: connection.config ?? {},
      lastSyncRunId: null,
      lastSuccessfulSyncAt: null,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    validateConnectionStatus(integration.status);
    this.store.integrationConnections.set(integration.id, integration);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'integration_connection.created', targetType: 'integration_connection', targetId: integration.id, metadata: { providerKey: integration.providerKey } });
    return integration;
  }

  updateConnectionStatus({ organizationId, actorUserId, integrationConnectionId, status }) {
    this.requireWrite({ organizationId, actorUserId });
    validateConnectionStatus(status);
    const connection = this.requireOwned(this.store.integrationConnections, organizationId, integrationConnectionId, 'Integration connection not found.');
    if (status === 'active' && !connection.secretRef) throw new AuthError('Active integrations require a secret reference.', 'INTEGRATION_SECRET_REQUIRED');
    connection.status = status;
    connection.updatedByUserId = actorUserId;
    connection.updatedAt = new Date();
    this.auditLog?.record({ organizationId, actorUserId, eventType: `integration_connection.${status}`, targetType: 'integration_connection', targetId: connection.id });
    return connection;
  }

  startSyncRun({ organizationId, actorUserId, integrationConnectionId, idempotencyKey }) {
    this.requireWrite({ organizationId, actorUserId });
    const connection = this.requireOwned(this.store.integrationConnections, organizationId, integrationConnectionId, 'Integration connection not found.');
    if (connection.status !== 'active') throw new AuthError('Only active integrations can sync.', 'INTEGRATION_NOT_ACTIVE');
    const existing = this.findSyncRun(organizationId, integrationConnectionId, idempotencyKey);
    if (existing) return existing;
    const run = {
      id: randomUUID(),
      organizationId,
      integrationConnectionId,
      idempotencyKey: requiredText(idempotencyKey, 'Idempotency key is required.'),
      status: 'running',
      startedAt: new Date(),
      finishedAt: null,
      recordsSeen: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      errorCode: null,
      errorMessage: null,
      evidence: { providerKey: connection.providerKey },
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.integrationSyncRuns.set(run.id, run);
    connection.lastSyncRunId = run.id;
    connection.updatedAt = new Date();
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'integration_sync.started', targetType: 'integration_sync_run', targetId: run.id, metadata: { integrationConnectionId } });
    return run;
  }

  finishSyncRun({ organizationId, actorUserId, integrationSyncRunId, result }) {
    this.requireWrite({ organizationId, actorUserId });
    const run = this.requireOwned(this.store.integrationSyncRuns, organizationId, integrationSyncRunId, 'Integration sync run not found.');
    if (run.status !== 'running') throw new AuthError('Only running syncs can be finished.', 'SYNC_NOT_RUNNING');
    if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) throw new AuthError('Sync result status is not valid.', 'SYNC_STATUS_INVALID');
    run.status = result.status;
    run.finishedAt = new Date();
    run.recordsSeen = nonNegativeInteger(result.recordsSeen ?? run.recordsSeen, 'Records seen must be a non-negative integer.');
    run.recordsAccepted = nonNegativeInteger(result.recordsAccepted ?? run.recordsAccepted, 'Records accepted must be a non-negative integer.');
    run.recordsRejected = nonNegativeInteger(result.recordsRejected ?? run.recordsRejected, 'Records rejected must be a non-negative integer.');
    run.errorCode = result.errorCode ?? null;
    run.errorMessage = result.errorMessage ?? null;
    run.evidence = { ...run.evidence, ...(result.evidence ?? {}) };
    const connection = this.requireOwned(this.store.integrationConnections, organizationId, run.integrationConnectionId, 'Integration connection not found.');
    connection.lastSyncRunId = run.id;
    connection.status = result.status === 'failed' ? 'error' : connection.status;
    connection.lastSuccessfulSyncAt = result.status === 'succeeded' ? run.finishedAt : connection.lastSuccessfulSyncAt;
    connection.updatedAt = new Date();
    this.auditLog?.record({ organizationId, actorUserId, eventType: `integration_sync.${result.status}`, targetType: 'integration_sync_run', targetId: run.id, metadata: { recordsAccepted: run.recordsAccepted, recordsRejected: run.recordsRejected } });
    return run;
  }

  recordWebhookEvent({ organizationId, actorUserId = null, integrationConnectionId, providerEventId, idempotencyKey, payload }) {
    const connection = this.requireOwned(this.store.integrationConnections, organizationId, integrationConnectionId, 'Integration connection not found.');
    if (connection.status === 'revoked') throw new AuthError('Revoked integrations cannot receive webhooks.', 'INTEGRATION_REVOKED');
    const existing = this.findWebhookEvent(organizationId, integrationConnectionId, providerEventId, idempotencyKey);
    if (existing) {
      existing.status = 'duplicate';
      return existing;
    }
    const event = {
      id: randomUUID(),
      organizationId,
      integrationConnectionId,
      providerEventId: requiredText(providerEventId, 'Provider event id is required.'),
      idempotencyKey: requiredText(idempotencyKey, 'Webhook idempotency key is required.'),
      status: 'received',
      receivedAt: new Date(),
      processedAt: null,
      payloadFingerprint: fingerprintPayload(payload),
      evidence: { providerKey: connection.providerKey, payloadKeys: Object.keys(payload ?? {}).sort() },
      createdByUserId: actorUserId
    };
    this.store.integrationWebhookEvents.set(event.id, event);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'integration_webhook.received', targetType: 'integration_webhook_event', targetId: event.id });
    return event;
  }

  markWebhookProcessed({ organizationId, actorUserId, integrationWebhookEventId, status = 'processed' }) {
    this.requireWrite({ organizationId, actorUserId });
    if (!['processed', 'failed'].includes(status)) throw new AuthError('Webhook status is not valid.', 'WEBHOOK_STATUS_INVALID');
    const event = this.requireOwned(this.store.integrationWebhookEvents, organizationId, integrationWebhookEventId, 'Webhook event not found.');
    event.status = status;
    event.processedAt = new Date();
    this.auditLog?.record({ organizationId, actorUserId, eventType: `integration_webhook.${status}`, targetType: 'integration_webhook_event', targetId: event.id });
    return event;
  }

  listConnections({ organizationId, actorUserId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return [...this.store.integrationConnections.values()]
      .filter((connection) => connection.organizationId === organizationId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  listSyncRuns({ organizationId, actorUserId, integrationConnectionId = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    if (integrationConnectionId) this.requireOwned(this.store.integrationConnections, organizationId, integrationConnectionId, 'Integration connection not found.');
    return [...this.store.integrationSyncRuns.values()]
      .filter((run) => run.organizationId === organizationId)
      .filter((run) => !integrationConnectionId || run.integrationConnectionId === integrationConnectionId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  requireWrite({ organizationId, actorUserId }) {
    return new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.WRITE_BUSINESS_DATA });
  }

  requireOwned(map, organizationId, id, message) {
    const record = map?.get(id);
    if (!record || record.organizationId !== organizationId) throw new AuthError(message, 'NOT_FOUND');
    return record;
  }

  findSyncRun(organizationId, integrationConnectionId, idempotencyKey) {
    return [...this.store.integrationSyncRuns.values()].find((run) =>
      run.organizationId === organizationId
      && run.integrationConnectionId === integrationConnectionId
      && run.idempotencyKey === idempotencyKey
    );
  }

  findWebhookEvent(organizationId, integrationConnectionId, providerEventId, idempotencyKey) {
    return [...this.store.integrationWebhookEvents.values()].find((event) =>
      event.organizationId === organizationId
      && event.integrationConnectionId === integrationConnectionId
      && (event.providerEventId === providerEventId || event.idempotencyKey === idempotencyKey)
    );
  }
}

export function integrationHealth(connections, syncRuns) {
  const active = connections.filter((connection) => connection.status === 'active').length;
  const error = connections.filter((connection) => connection.status === 'error').length;
  const latestFailures = syncRuns.filter((run) => run.status === 'failed').length;
  return {
    state: error > 0 || latestFailures > 0 ? 'attention' : active > 0 ? 'ready' : 'empty',
    activeConnections: active,
    errorConnections: error,
    failedSyncRuns: latestFailures
  };
}

function validateProviderKind(kind) {
  if (!PROVIDER_KINDS.includes(kind)) throw new AuthError('Provider kind is not valid.', 'PROVIDER_KIND_INVALID');
}

function validateConnectionStatus(status) {
  if (!CONNECTION_STATUSES.includes(status)) throw new AuthError('Connection status is not valid.', 'CONNECTION_STATUS_INVALID');
}

function requiredText(value, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new AuthError(message, 'VALIDATION_FAILED');
  return text;
}

function requiredSlug(value, message) {
  const text = requiredText(value, message);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(text)) throw new AuthError('Provider key must be a lowercase slug.', 'PROVIDER_KEY_INVALID');
  return text;
}

function rejectRawSecrets(config = {}) {
  const serialized = JSON.stringify(config).toLowerCase();
  if (/(secret|token|password|api[_-]?key)/.test(serialized)) {
    throw new AuthError('Integration config must not contain raw secrets; store only secret references.', 'RAW_SECRET_REJECTED');
  }
}

function nonNegativeInteger(value, message) {
  if (!Number.isInteger(value) || value < 0) throw new AuthError(message, 'VALIDATION_FAILED');
  return value;
}

function fingerprintPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload ?? {}), 'utf8').digest('hex');
}
