import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export const USAGE_KINDS = Object.freeze(['ingestion_run', 'forecast_run', 'sync_run', 'report_generation']);
export const JOB_KINDS = Object.freeze(['ingestion', 'sync', 'metric_calculation', 'forecast', 'report', 'alert_evaluation']);
export const JOB_STATUSES = Object.freeze(['queued', 'leased', 'succeeded', 'failed', 'cancelled']);

const DEFAULT_LIMITS = Object.freeze({
  monthlyIngestionRuns: 100,
  monthlyForecastRuns: 100,
  monthlySyncRuns: 100,
  monthlyReportGenerations: 25,
  maxConcurrentJobs: 2,
  maxWorkerLeaseMinutes: 15
});

const USAGE_LIMIT_FIELDS = Object.freeze({
  ingestion_run: 'monthlyIngestionRuns',
  forecast_run: 'monthlyForecastRuns',
  sync_run: 'monthlySyncRuns',
  report_generation: 'monthlyReportGenerations'
});

export function createEnterpriseStoreShape(store) {
  store.organizationPlans ??= new Map();
  store.organizationUsageWindows ??= new Map();
  store.rateLimitEvents ??= new Map();
  store.workerJobs ??= new Map();
  return store;
}

export class EnterpriseScalingService {
  constructor(store, auditLog, now = () => new Date()) {
    this.store = createEnterpriseStoreShape(store);
    this.auditLog = auditLog;
    this.now = now;
  }

  setOrganizationPlan({ organizationId, actorUserId, plan }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.MANAGE_ORGANIZATION });
    const existing = [...this.store.organizationPlans.values()].find((item) => item.organizationId === organizationId);
    const limits = normalizeLimits(plan.limits ?? {});
    if (existing) {
      existing.name = requiredText(plan.name, 'Plan name is required.');
      existing.status = plan.status ?? existing.status;
      existing.limits = limits;
      existing.updatedByUserId = actorUserId;
      existing.updatedAt = this.now();
      validatePlanStatus(existing.status);
      this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_plan.updated', targetType: 'organization_plan', targetId: existing.id });
      return existing;
    }
    const record = {
      id: randomUUID(),
      organizationId,
      name: requiredText(plan.name, 'Plan name is required.'),
      status: plan.status ?? 'active',
      limits,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: this.now(),
      updatedAt: this.now()
    };
    validatePlanStatus(record.status);
    this.store.organizationPlans.set(record.id, record);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_plan.created', targetType: 'organization_plan', targetId: record.id });
    return record;
  }

  recordUsage({ organizationId, actorUserId, usageKind, quantity = 1, operationKey }) {
    this.requireWrite({ organizationId, actorUserId });
    validateUsageKind(usageKind);
    const amount = positiveInteger(quantity, 'Usage quantity must be positive.');
    const idempotencyKey = requiredText(operationKey, 'Operation key is required.');
    const existingEvent = [...this.store.rateLimitEvents.values()].find((event) =>
      event.organizationId === organizationId
      && event.usageKind === usageKind
      && event.operationKey === idempotencyKey
      && event.decision === 'allowed'
    );
    if (existingEvent) return existingEvent;
    const limits = this.activeLimits(organizationId);
    const limit = limits[USAGE_LIMIT_FIELDS[usageKind]];
    const window = this.usageWindow(organizationId, usageKind);
    const projected = window.usedQuantity + amount;
    if (projected > limit) {
      const event = this.rateEvent({ organizationId, actorUserId, usageKind, operationKey: idempotencyKey, quantity: amount, limit, usedQuantity: window.usedQuantity, decision: 'blocked' });
      this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_quota.blocked', targetType: 'rate_limit_event', targetId: event.id, metadata: { usageKind } });
      throw new AuthError('Organization usage limit exceeded.', 'USAGE_LIMIT_EXCEEDED');
    }
    window.usedQuantity = projected;
    window.updatedAt = this.now();
    const event = this.rateEvent({ organizationId, actorUserId, usageKind, operationKey: idempotencyKey, quantity: amount, limit, usedQuantity: projected, decision: 'allowed' });
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_usage.recorded', targetType: 'organization_usage_window', targetId: window.id, metadata: { usageKind, quantity: amount } });
    return event;
  }

  enqueueJob({ organizationId, actorUserId, jobKind, payload = {}, idempotencyKey }) {
    this.requireWrite({ organizationId, actorUserId });
    validateJobKind(jobKind);
    const key = requiredText(idempotencyKey, 'Job idempotency key is required.');
    const existing = [...this.store.workerJobs.values()].find((job) =>
      job.organizationId === organizationId
      && job.jobKind === jobKind
      && job.idempotencyKey === key
    );
    if (existing) return existing;
    const job = {
      id: randomUUID(),
      organizationId,
      jobKind,
      idempotencyKey: key,
      status: 'queued',
      payload,
      leaseOwner: null,
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      createdByUserId: actorUserId,
      createdAt: this.now(),
      updatedAt: this.now()
    };
    this.store.workerJobs.set(job.id, job);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_job.queued', targetType: 'worker_job', targetId: job.id, metadata: { jobKind } });
    return job;
  }

  leaseNextJob({ organizationId, actorUserId, workerId }) {
    this.requireWrite({ organizationId, actorUserId });
    const limits = this.activeLimits(organizationId);
    const leased = [...this.store.workerJobs.values()].filter((job) =>
      job.organizationId === organizationId
      && job.status === 'leased'
      && job.leaseExpiresAt > this.now()
    );
    if (leased.length >= limits.maxConcurrentJobs) {
      const event = this.rateEvent({ organizationId, actorUserId, usageKind: 'sync_run', operationKey: `worker:${workerId}:${this.now().toISOString()}`, quantity: 1, limit: limits.maxConcurrentJobs, usedQuantity: leased.length, decision: 'blocked' });
      this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_job.lease_blocked', targetType: 'rate_limit_event', targetId: event.id });
      return { state: 'limited', job: null, activeLeases: leased.length };
    }
    const job = [...this.store.workerJobs.values()]
      .filter((item) => item.organizationId === organizationId && item.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] ?? null;
    if (!job) return { state: 'empty', job: null, activeLeases: leased.length };
    job.status = 'leased';
    job.leaseOwner = requiredText(workerId, 'Worker id is required.');
    job.leaseExpiresAt = new Date(this.now().getTime() + limits.maxWorkerLeaseMinutes * 60 * 1000);
    job.attempts += 1;
    job.updatedAt = this.now();
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'enterprise_job.leased', targetType: 'worker_job', targetId: job.id, metadata: { workerId: job.leaseOwner } });
    return { state: 'leased', job, activeLeases: leased.length + 1 };
  }

  completeJob({ organizationId, actorUserId, workerJobId, status, errorMessage = null }) {
    this.requireWrite({ organizationId, actorUserId });
    if (!['succeeded', 'failed', 'cancelled'].includes(status)) throw new AuthError('Job completion status is not valid.', 'JOB_STATUS_INVALID');
    const job = this.requireOwned(this.store.workerJobs, organizationId, workerJobId, 'Worker job not found.');
    if (job.status !== 'leased') throw new AuthError('Only leased jobs can be completed.', 'JOB_NOT_LEASED');
    job.status = status;
    job.lastError = errorMessage;
    job.leaseExpiresAt = null;
    job.updatedAt = this.now();
    this.auditLog?.record({ organizationId, actorUserId, eventType: `enterprise_job.${status}`, targetType: 'worker_job', targetId: job.id });
    return job;
  }

  operationalHealth({ organizationId, actorUserId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return enterpriseHealth(this.store, organizationId, this.now());
  }

  activeLimits(organizationId) {
    const plan = [...this.store.organizationPlans.values()].find((item) => item.organizationId === organizationId && item.status === 'active');
    return plan?.limits ?? DEFAULT_LIMITS;
  }

  usageWindow(organizationId, usageKind) {
    const startsAt = monthStart(this.now());
    const existing = [...this.store.organizationUsageWindows.values()].find((window) =>
      window.organizationId === organizationId
      && window.usageKind === usageKind
      && window.windowStart === startsAt
    );
    if (existing) return existing;
    const window = {
      id: randomUUID(),
      organizationId,
      usageKind,
      windowStart: startsAt,
      windowEnd: monthEnd(startsAt),
      usedQuantity: 0,
      createdAt: this.now(),
      updatedAt: this.now()
    };
    this.store.organizationUsageWindows.set(window.id, window);
    return window;
  }

  rateEvent(event) {
    const record = {
      id: randomUUID(),
      organizationId: event.organizationId,
      actorUserId: event.actorUserId,
      usageKind: event.usageKind,
      operationKey: event.operationKey,
      quantity: event.quantity,
      limit: event.limit,
      usedQuantity: event.usedQuantity,
      decision: event.decision,
      createdAt: this.now()
    };
    this.store.rateLimitEvents.set(record.id, record);
    return record;
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

export function enterpriseHealth(store, organizationId, now = () => new Date()) {
  const plans = [...(store.organizationPlans?.values() ?? [])].filter((plan) => plan.organizationId === organizationId);
  const activePlan = plans.find((plan) => plan.status === 'active') ?? null;
  const windows = [...(store.organizationUsageWindows?.values() ?? [])].filter((window) => window.organizationId === organizationId);
  const blockedEvents = [...(store.rateLimitEvents?.values() ?? [])].filter((event) => event.organizationId === organizationId && event.decision === 'blocked');
  const jobs = [...(store.workerJobs?.values() ?? [])].filter((job) => job.organizationId === organizationId);
  const leasedJobs = jobs.filter((job) => job.status === 'leased' && job.leaseExpiresAt > now());
  const failedJobs = jobs.filter((job) => job.status === 'failed');
  const state = blockedEvents.length > 0 || failedJobs.length > 0 ? 'attention' : activePlan ? 'ready' : 'empty';
  return {
    state,
    planName: activePlan?.name ?? null,
    windows: windows.map((window) => ({ usageKind: window.usageKind, usedQuantity: window.usedQuantity, windowStart: window.windowStart, windowEnd: window.windowEnd })),
    blockedEvents: blockedEvents.length,
    queuedJobs: jobs.filter((job) => job.status === 'queued').length,
    activeLeases: leasedJobs.length,
    failedJobs: failedJobs.length
  };
}

function normalizeLimits(limits) {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, defaultValue]) => [key, positiveInteger(limits[key] ?? defaultValue, `${key} must be positive.`)]));
}

function validatePlanStatus(status) {
  if (!['active', 'paused', 'cancelled'].includes(status)) throw new AuthError('Plan status is not valid.', 'PLAN_STATUS_INVALID');
}

function validateUsageKind(kind) {
  if (!USAGE_KINDS.includes(kind)) throw new AuthError('Usage kind is not valid.', 'USAGE_KIND_INVALID');
}

function validateJobKind(kind) {
  if (!JOB_KINDS.includes(kind)) throw new AuthError('Job kind is not valid.', 'JOB_KIND_INVALID');
}

function requiredText(value, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new AuthError(message, 'VALIDATION_FAILED');
  return text;
}

function positiveInteger(value, message) {
  const integer = Number(value);
  if (!Number.isInteger(integer) || integer <= 0) throw new AuthError(message, 'VALIDATION_FAILED');
  return integer;
}

function monthStart(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function monthEnd(windowStart) {
  const [year, month] = windowStart.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
