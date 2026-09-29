import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

export function createForecastStoreShape(store) {
  store.forecastModels ??= new Map();
  store.forecastScenarios ??= new Map();
  store.forecastRuns ??= new Map();
  return store;
}

export class ForecastScenarioService {
  constructor(store, auditLog) {
    this.store = createForecastStoreShape(store);
    this.auditLog = auditLog;
  }

  createModel({ organizationId, actorUserId, kpiDefinitionId, model }) {
    this.requireWrite({ organizationId, actorUserId });
    this.requireOwned(this.store.kpiDefinitions, organizationId, kpiDefinitionId, 'KPI definition not found.');
    const forecastModel = {
      id: randomUUID(),
      organizationId,
      kpiDefinitionId,
      name: requiredText(model.name, 'Forecast model name is required.'),
      modelKind: 'linear_projection',
      minimumPoints: positiveInteger(model.minimumPoints ?? 3, 'Minimum points must be positive.'),
      horizonPeriods: positiveInteger(model.horizonPeriods ?? 3, 'Horizon periods must be positive.'),
      status: model.status ?? 'active',
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    if (!['active', 'draft', 'archived'].includes(forecastModel.status)) throw new AuthError('Forecast model status is not valid.', 'FORECAST_MODEL_STATUS_INVALID');
    this.store.forecastModels.set(forecastModel.id, forecastModel);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'forecast_model.created', targetType: 'forecast_model', targetId: forecastModel.id });
    return forecastModel;
  }

  createScenario({ organizationId, actorUserId, forecastModelId, scenario }) {
    this.requireWrite({ organizationId, actorUserId });
    this.requireOwned(this.store.forecastModels, organizationId, forecastModelId, 'Forecast model not found.');
    const adjustmentPercent = Number(scenario.adjustmentPercent ?? 0);
    if (!Number.isFinite(adjustmentPercent)) throw new AuthError('Scenario adjustment must be numeric.', 'SCENARIO_ADJUSTMENT_INVALID');
    const forecastScenario = {
      id: randomUUID(),
      organizationId,
      forecastModelId,
      name: requiredText(scenario.name, 'Scenario name is required.'),
      status: scenario.status ?? 'active',
      assumptions: scenario.assumptions ?? {},
      adjustmentPercent,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    if (!['active', 'draft', 'archived'].includes(forecastScenario.status)) throw new AuthError('Scenario status is not valid.', 'SCENARIO_STATUS_INVALID');
    this.store.forecastScenarios.set(forecastScenario.id, forecastScenario);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'forecast_scenario.created', targetType: 'forecast_scenario', targetId: forecastScenario.id });
    return forecastScenario;
  }

  runForecast({ organizationId, actorUserId, forecastModelId, forecastScenarioId = null }) {
    this.requireWrite({ organizationId, actorUserId });
    const model = this.requireOwned(this.store.forecastModels, organizationId, forecastModelId, 'Forecast model not found.');
    if (model.status !== 'active') throw new AuthError('Only active forecast models can run.', 'FORECAST_MODEL_NOT_ACTIVE');
    const scenario = forecastScenarioId ? this.requireOwned(this.store.forecastScenarios, organizationId, forecastScenarioId, 'Forecast scenario not found.') : null;
    if (scenario && scenario.status !== 'active') throw new AuthError('Only active scenarios can run.', 'SCENARIO_NOT_ACTIVE');
    const points = this.metricPoints(organizationId, model.kpiDefinitionId);
    const common = {
      id: randomUUID(),
      organizationId,
      forecastModelId: model.id,
      forecastScenarioId: scenario?.id ?? null,
      horizonPeriods: model.horizonPeriods,
      pointsUsed: points.length,
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    if (points.length < model.minimumPoints) {
      const run = {
        ...common,
        status: 'not_ready',
        baselineValue: points.at(-1)?.value ?? null,
        slope: null,
        forecastValues: [],
        uncertainty: { reason: 'insufficient_history' },
        readiness: { requiredPoints: model.minimumPoints, actualPoints: points.length },
        evidence: { verifiedMetricRunIds: points.map((point) => point.verifiedMetricRunId) }
      };
      this.store.forecastRuns.set(run.id, run);
      this.auditLog?.record({ organizationId, actorUserId, eventType: 'forecast_run.not_ready', targetType: 'forecast_run', targetId: run.id });
      return run;
    }
    const projection = linearProjection(points, model.horizonPeriods, scenario?.adjustmentPercent ?? 0);
    const run = {
      ...common,
      status: 'calculated',
      baselineValue: projection.baselineValue,
      slope: projection.slope,
      forecastValues: projection.forecastValues,
      uncertainty: projection.uncertainty,
      readiness: { requiredPoints: model.minimumPoints, actualPoints: points.length },
      evidence: { verifiedMetricRunIds: points.map((point) => point.verifiedMetricRunId), method: 'linear_projection' }
    };
    this.store.forecastRuns.set(run.id, run);
    this.auditLog?.record({ organizationId, actorUserId, eventType: 'forecast_run.calculated', targetType: 'forecast_run', targetId: run.id });
    return run;
  }

  listForecastRuns({ organizationId, actorUserId }) {
    new AuthorizationService(this.store).requireCapability({ userId: actorUserId, organizationId, capability: CAPABILITIES.READ_BUSINESS_DATA });
    return [...this.store.forecastRuns.values()]
      .filter((run) => run.organizationId === organizationId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  metricPoints(organizationId, kpiDefinitionId) {
    const periods = this.store.reportingPeriods ?? new Map();
    return [...(this.store.verifiedMetricRuns?.values() ?? [])]
      .filter((run) => run.organizationId === organizationId && run.kpiDefinitionId === kpiDefinitionId && run.status === 'calculated' && Number.isFinite(Number(run.value)))
      .map((run) => ({ verifiedMetricRunId: run.id, reportingPeriodId: run.reportingPeriodId, periodStart: periods.get(run.reportingPeriodId)?.periodStart ?? run.createdAt, value: Number(run.value) }))
      .sort((a, b) => String(a.periodStart).localeCompare(String(b.periodStart)));
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

export function linearProjection(points, horizonPeriods, adjustmentPercent = 0) {
  const first = points[0].value;
  const last = points.at(-1).value;
  const slope = (last - first) / (points.length - 1);
  const residuals = points.map((point, index) => point.value - (first + slope * index));
  const meanAbsoluteError = residuals.reduce((sum, value) => sum + Math.abs(value), 0) / residuals.length;
  const multiplier = 1 + adjustmentPercent / 100;
  const forecastValues = Array.from({ length: horizonPeriods }, (_, index) => {
    const step = index + 1;
    const value = (last + slope * step) * multiplier;
    return { periodOffset: step, value: round(value) };
  });
  return {
    baselineValue: last,
    slope: round(slope),
    forecastValues,
    uncertainty: { meanAbsoluteError: round(meanAbsoluteError), adjustmentPercent }
  };
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

function round(value) {
  return Math.round(value * 100) / 100;
}
