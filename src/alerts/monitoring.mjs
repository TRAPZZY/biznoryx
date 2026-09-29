import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export const ALERT_CONDITIONS = Object.freeze(['sync_failure', 'data_health_attention', 'high_severity_finding']);
export const ALERT_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

export function createAlertStoreShape(store) {
  store.alertRules ??= new Map();
  store.alertEvents ??= new Map();
  store.alertNotifications ??= new Map();
  return store;
}

export class AlertMonitoringService {
  constructor(store, auditLog) {
    this.store = createAlertStoreShape(store);
    this.auditLog = auditLog;
  }

  createRule({ organizationId, actorUserId, rule }) {
    this.requireWrite({ organizationId, actorUserId });
    validateCondition(rule.conditionKind);
    validateSeverity(rule.severity ?? 'medium');
    const alertRule = {
      id: randomUUID(),
      organizationId,
      name: requiredText(rule.name, 'Alert rule name is required.'),
      conditionKind: rule.conditionKind,
      severity: rule.severity ?? 'medium',
      status: rule.status ?? 'active',
      config: rule.config ?? {},
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    if (!['active', 'paused'].includes(alertRule.status)) throw new AuthError('Alert rule status is not valid.', 'ALERT_RULE_STATUS_INVALID');
    this.store.alertRules.set(alertRule.id, alertRule);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'alert_rule.created', targetType: 'alert_rule', targetId: alertRule.id, metadata: { conditionKind: alertRule.conditionKind } });
    return alertRule;
  }

  evaluateRules({ organizationId, actorUserId }) {
    this.requireWrite({ organizationId, actorUserId });
    const activeRules = [...this.store.alertRules.values()].filter((rule) => rule.organizationId === organizationId && rule.status === 'active');
    const events = [];
    for (const rule of activeRules) {
      for (const candidate of candidatesForRule(this.store, organizationId, rule)) {
        events.push(this.openEvent({ organizationId, actorUserId, rule, candidate }));
      }
    }
    return events;
  }

  acknowledgeEvent({ organizationId, actorUserId, alertEventId }) {
    this.requireWrite({ organizationId, actorUserId });
    const event = this.requireOwned(this.store.alertEvents, organizationId, alertEventId, 'Alert event not found.');
    if (event.status !== 'open') throw new AuthError('Only open alerts can be acknowledged.', 'ALERT_NOT_OPEN');
    event.status = 'acknowledged';
    event.acknowledgedByUserId = actorUserId;
    event.acknowledgedAt = new Date();
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'alert_event.acknowledged', targetType: 'alert_event', targetId: event.id });
    return event;
  }

  resolveEvent({ organizationId, actorUserId, alertEventId }) {
    this.requireWrite({ organizationId, actorUserId });
    const event = this.requireOwned(this.store.alertEvents, organizationId, alertEventId, 'Alert event not found.');
    if (event.status === 'resolved') return event;
    event.status = 'resolved';
    event.resolvedByUserId = actorUserId;
    event.resolvedAt = new Date();
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'alert_event.resolved', targetType: 'alert_event', targetId: event.id });
    return event;
  }

  createNotification({ organizationId, actorUserId, alertEventId, channel, recipient }) {
    this.requireWrite({ organizationId, actorUserId });
    const event = this.requireOwned(this.store.alertEvents, organizationId, alertEventId, 'Alert event not found.');
    const notification = {
      id: randomUUID(),
      organizationId,
      alertEventId: event.id,
      channel: requiredText(channel, 'Notification channel is required.'),
      recipient: requiredText(recipient, 'Notification recipient is required.'),
      status: event.status === 'resolved' ? 'suppressed' : 'pending',
      errorMessage: null,
      sentAt: null,
      createdAt: new Date()
    };
    this.store.alertNotifications.set(notification.id, notification);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'alert_notification.created', targetType: 'alert_notification', targetId: notification.id });
    return notification;
  }

  markNotification({ organizationId, actorUserId, alertNotificationId, status, errorMessage = null }) {
    this.requireWrite({ organizationId, actorUserId });
    if (!['sent', 'failed', 'suppressed'].includes(status)) throw new AuthError('Notification status is not valid.', 'ALERT_NOTIFICATION_STATUS_INVALID');
    const notification = this.requireOwned(this.store.alertNotifications, organizationId, alertNotificationId, 'Alert notification not found.');
    notification.status = status;
    notification.errorMessage = errorMessage;
    notification.sentAt = status === 'sent' ? new Date() : notification.sentAt;
    this.auditLog?.record({ organizationId, actorUserId, eventType: `alert_notification.${status}`, targetType: 'alert_notification', targetId: notification.id });
    return notification;
  }

  listEvents({ organizationId, actorUserId, status = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return [...this.store.alertEvents.values()]
      .filter((event) => event.organizationId === organizationId)
      .filter((event) => !status || event.status === status)
      .sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt)));
  }

  openEvent({ organizationId, actorUserId, rule, candidate }) {
    const existing = [...this.store.alertEvents.values()].find((event) =>
      event.organizationId === organizationId
      && event.alertRuleId === rule.id
      && event.fingerprint === candidate.fingerprint
      && ['open', 'acknowledged'].includes(event.status)
    );
    if (existing) return existing;
    const event = {
      id: randomUUID(),
      organizationId,
      alertRuleId: rule.id,
      status: 'open',
      severity: candidate.severity ?? rule.severity,
      title: candidate.title,
      message: candidate.message,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId ?? null,
      fingerprint: candidate.fingerprint,
      evidence: candidate.evidence,
      triggeredAt: new Date(),
      acknowledgedByUserId: null,
      acknowledgedAt: null,
      resolvedByUserId: null,
      resolvedAt: null
    };
    this.store.alertEvents.set(event.id, event);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'alert_event.opened', targetType: 'alert_event', targetId: event.id, metadata: { conditionKind: rule.conditionKind } });
    return event;
  }

  requireWrite({ organizationId, actorUserId }) {
    return new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.WRITE_BUSINESS_DATA });
  }

  requireOwned(map, organizationId, id, message) {
    const record = map?.get(id);
    if (!record || record.organizationId !== organizationId) throw new AuthError(message, 'NOT_FOUND');
    return record;
  }
}

export function alertSummary(events) {
  const open = events.filter((event) => event.status === 'open').length;
  const critical = events.filter((event) => event.status === 'open' && event.severity === 'critical').length;
  return { state: critical > 0 ? 'critical' : open > 0 ? 'attention' : 'ready', openAlerts: open, criticalAlerts: critical };
}

function candidatesForRule(store, organizationId, rule) {
  if (rule.conditionKind === 'sync_failure') return syncFailureCandidates(store, organizationId);
  if (rule.conditionKind === 'data_health_attention') return dataHealthCandidates(store, organizationId, rule);
  if (rule.conditionKind === 'high_severity_finding') return highSeverityFindingCandidates(store, organizationId);
  return [];
}

function syncFailureCandidates(store, organizationId) {
  return [...(store.integrationSyncRuns?.values() ?? [])]
    .filter((run) => run.organizationId === organizationId && run.status === 'failed')
    .map((run) => ({
      severity: 'high',
      title: 'Integration sync failed',
      message: run.errorMessage ?? 'An integration sync failed.',
      sourceType: 'integration_sync_run',
      sourceId: run.id,
      fingerprint: `sync_failure:${run.id}`,
      evidence: { integrationSyncRunId: run.id, errorCode: run.errorCode, recordsRejected: run.recordsRejected }
    }));
}

function dataHealthCandidates(store, organizationId, rule) {
  const rejectedRuns = [...(store.ingestionRuns?.values() ?? [])].filter((run) => run.organizationId === organizationId && run.status === 'rejected');
  const threshold = Number(rule.config.rejectedRunThreshold ?? 1);
  if (rejectedRuns.length < threshold) return [];
  return [{
    severity: rule.severity,
    title: 'Data health needs attention',
    message: `${rejectedRuns.length} ingestion run(s) are rejected.`,
    sourceType: 'data_health',
    sourceId: null,
    fingerprint: `data_health:rejected:${rejectedRuns.length}`,
    evidence: { rejectedRunIds: rejectedRuns.map((run) => run.id), rejectedRuns: rejectedRuns.length }
  }];
}

function highSeverityFindingCandidates(store, organizationId) {
  return [...(store.performanceFindings?.values() ?? [])]
    .filter((finding) => finding.organizationId === organizationId && finding.severity === 'high' && finding.status === 'open')
    .map((finding) => ({
      severity: 'high',
      title: 'High severity finding is open',
      message: finding.title,
      sourceType: 'performance_finding',
      sourceId: finding.id,
      fingerprint: `finding:${finding.id}`,
      evidence: { findingId: finding.id, kind: finding.kind }
    }));
}

function validateCondition(condition) {
  if (!ALERT_CONDITIONS.includes(condition)) throw new AuthError('Alert condition is not valid.', 'ALERT_CONDITION_INVALID');
}

function validateSeverity(severity) {
  if (!ALERT_SEVERITIES.includes(severity)) throw new AuthError('Alert severity is not valid.', 'ALERT_SEVERITY_INVALID');
}

function requiredText(value, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new AuthError(message, 'VALIDATION_FAILED');
  return text;
}
