import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export const ACTION_STATUSES = Object.freeze(['planned', 'in_progress', 'completed', 'cancelled']);
export const OUTCOME_ASSESSMENTS = Object.freeze(['improved', 'declined', 'unchanged', 'inconclusive']);

export function createActionStoreShape(store) {
  store.managementActions ??= new Map();
  store.actionOutcomes ??= new Map();
  return store;
}

export class ActionOutcomeService {
  constructor(store, auditLog) {
    this.store = createActionStoreShape(store);
    this.auditLog = auditLog;
  }

  createAction({ organizationId, actorUserId, findingId, ownerUserId, action }) {
    this.requireWrite({ organizationId, actorUserId });
    const finding = this.requireOwned(this.store.performanceFindings, organizationId, findingId, 'Finding not found.');
    const ownerMembership = [...this.store.memberships.values()].find((membership) =>
      membership.organizationId === organizationId
      && membership.userId === ownerUserId
      && membership.status === 'active'
    );
    if (!ownerMembership) throw new AuthError('Action owner must be an active organization member.', 'ACTION_OWNER_INVALID');
    if (action.successMetricKpiDefinitionId) {
      this.requireOwned(this.store.kpiDefinitions, organizationId, action.successMetricKpiDefinitionId, 'Success metric KPI not found.');
    }
    const managementAction = {
      id: randomUUID(),
      organizationId,
      findingId: finding.id,
      ownerUserId,
      title: requiredText(action.title, 'Action title is required.'),
      description: requiredText(action.description, 'Action description is required.'),
      status: 'planned',
      dueDate: action.dueDate ?? null,
      successMetricKpiDefinitionId: action.successMetricKpiDefinitionId ?? finding.kpiDefinitionId,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.store.managementActions.set(managementAction.id, managementAction);
    if (finding.status === 'open') finding.status = 'accepted';
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'management_action.created', targetType: 'management_action', targetId: managementAction.id, metadata: { findingId } });
    return managementAction;
  }

  updateActionStatus({ organizationId, actorUserId, managementActionId, status }) {
    this.requireWrite({ organizationId, actorUserId });
    if (!ACTION_STATUSES.includes(status)) throw new AuthError('Action status is not valid.', 'ACTION_STATUS_INVALID');
    const action = this.requireOwned(this.store.managementActions, organizationId, managementActionId, 'Management action not found.');
    if (action.status === 'cancelled' && status !== 'cancelled') throw new AuthError('Cancelled actions cannot be reopened.', 'ACTION_CANCELLED');
    action.status = status;
    action.updatedByUserId = actorUserId;
    action.updatedAt = new Date();
    action.completedAt = status === 'completed' ? new Date() : action.completedAt;
    this.auditLog?.record({ organizationId, actorUserId, eventType: `management_action.${status}`, targetType: 'management_action', targetId: action.id });
    return action;
  }

  recordOutcome({ organizationId, actorUserId, managementActionId, outcome }) {
    this.requireWrite({ organizationId, actorUserId });
    const action = this.requireOwned(this.store.managementActions, organizationId, managementActionId, 'Management action not found.');
    if (!['in_progress', 'completed'].includes(action.status)) {
      throw new AuthError('Outcomes require an in-progress or completed action.', 'ACTION_OUTCOME_NOT_READY');
    }
    if (!OUTCOME_ASSESSMENTS.includes(outcome.assessment)) throw new AuthError('Outcome assessment is not valid.', 'OUTCOME_ASSESSMENT_INVALID');
    if (outcome.verifiedMetricRunId) {
      this.requireOwned(this.store.verifiedMetricRuns, organizationId, outcome.verifiedMetricRunId, 'Verified metric run not found.');
    }
    if (outcome.reportingPeriodId) {
      this.requireOwned(this.store.reportingPeriods, organizationId, outcome.reportingPeriodId, 'Reporting period not found.');
    }
    const baselineValue = numberOrNull(outcome.baselineValue);
    const outcomeValue = numberOrNull(outcome.outcomeValue);
    const actionOutcome = {
      id: randomUUID(),
      organizationId,
      managementActionId: action.id,
      reportingPeriodId: outcome.reportingPeriodId ?? null,
      verifiedMetricRunId: outcome.verifiedMetricRunId ?? null,
      assessment: outcome.assessment,
      baselineValue,
      outcomeValue,
      deltaValue: baselineValue === null || outcomeValue === null ? null : outcomeValue - baselineValue,
      narrative: requiredText(outcome.narrative, 'Outcome narrative is required.'),
      evidence: {
        managementActionId: action.id,
        findingId: action.findingId,
        verifiedMetricRunId: outcome.verifiedMetricRunId ?? null,
        reportingPeriodId: outcome.reportingPeriodId ?? null
      },
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.actionOutcomes.set(actionOutcome.id, actionOutcome);
    this.auditLog?.record({ organizationId, actorUserId, eventType: `action_outcome.${outcome.assessment}`, targetType: 'action_outcome', targetId: actionOutcome.id, metadata: { managementActionId: action.id } });
    return actionOutcome;
  }

  listActions({ organizationId, actorUserId, status = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return [...this.store.managementActions.values()]
      .filter((action) => action.organizationId === organizationId)
      .filter((action) => !status || action.status === status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  listOutcomes({ organizationId, actorUserId, managementActionId = null }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    if (managementActionId) this.requireOwned(this.store.managementActions, organizationId, managementActionId, 'Management action not found.');
    return [...this.store.actionOutcomes.values()]
      .filter((outcome) => outcome.organizationId === organizationId)
      .filter((outcome) => !managementActionId || outcome.managementActionId === managementActionId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
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

function requiredText(value, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new AuthError(message, 'VALIDATION_FAILED');
  return text;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AuthError('Outcome values must be numeric when provided.', 'OUTCOME_VALUE_INVALID');
  return parsed;
}
