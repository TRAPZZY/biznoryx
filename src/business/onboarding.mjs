import { randomUUID } from 'node:crypto';
import { AuthError, AuthorizationService, CAPABILITIES } from '../auth/core.mjs';

const REQUIRED_PROFILE_FIELDS = [
  'legalName',
  'industry',
  'businessModel',
  'primaryCurrency',
  'fiscalYearStartMonth',
  'timezone'
];

const ENTRY_TYPES = new Set(['product_service', 'location', 'customer_segment', 'channel']);
const FACT_KINDS = new Set(['confirmed_fact', 'inferred_fact']);
const KPI_VALUE_TYPES = new Set(['money', 'number', 'percent', 'ratio']);

export function createBusinessOnboardingStoreShape(store) {
  store.businessProfiles ??= new Map();
  store.businessModelEntries ??= new Map();
  store.businessFacts ??= new Map();
  store.businessTerms ??= new Map();
  store.businessGoals ??= new Map();
  store.kpiDefinitions ??= new Map();
  return store;
}

export class BusinessOnboardingService {
  constructor(store, auditLog) {
    this.store = createBusinessOnboardingStoreShape(store);
    this.auditLog = auditLog;
  }

  createOrUpdateProfile({ organizationId, actorUserId, profile }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    validateProfile(profile);
    const existing = [...this.store.businessProfiles.values()].find((item) => item.organizationId === organizationId);
    const now = new Date();
    if (existing) {
      Object.assign(existing, {
        legalName: clean(profile.legalName),
        tradingName: optionalClean(profile.tradingName),
        industry: clean(profile.industry),
        businessModel: clean(profile.businessModel),
        primaryCurrency: clean(profile.primaryCurrency).toUpperCase(),
        fiscalYearStartMonth: profile.fiscalYearStartMonth,
        timezone: clean(profile.timezone),
        version: existing.version + 1,
        updatedByUserId: actorUserId,
        updatedAt: now
      });
      this.recordAudit(organizationId, actorUserId, 'business_profile.updated', 'business_profile', existing.id);
      return existing;
    }
    const businessProfile = {
      id: randomUUID(),
      organizationId,
      legalName: clean(profile.legalName),
      tradingName: optionalClean(profile.tradingName),
      industry: clean(profile.industry),
      businessModel: clean(profile.businessModel),
      primaryCurrency: clean(profile.primaryCurrency).toUpperCase(),
      fiscalYearStartMonth: profile.fiscalYearStartMonth,
      timezone: clean(profile.timezone),
      status: 'draft',
      version: 1,
      completedAt: null,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: now,
      updatedAt: now
    };
    this.store.businessProfiles.set(businessProfile.id, businessProfile);
    this.recordAudit(organizationId, actorUserId, 'business_profile.created', 'business_profile', businessProfile.id);
    return businessProfile;
  }

  addModelEntry({ organizationId, actorUserId, businessProfileId, entry }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    const profile = this.requireProfile(organizationId, businessProfileId);
    if (!ENTRY_TYPES.has(entry.entryType)) throw new AuthError('Unsupported business model entry type.', 'VALIDATION_FAILED');
    if (!clean(entry.name)) throw new AuthError('Business model entry name is required.', 'VALIDATION_FAILED');
    const duplicate = [...this.store.businessModelEntries.values()].find((item) =>
      item.organizationId === organizationId
      && item.businessProfileId === profile.id
      && item.entryType === entry.entryType
      && item.name.toLowerCase() === clean(entry.name).toLowerCase()
    );
    if (duplicate) throw new AuthError('Business model entry already exists.', 'DUPLICATE_BUSINESS_ENTRY');
    const modelEntry = {
      id: randomUUID(),
      organizationId,
      businessProfileId: profile.id,
      entryType: entry.entryType,
      name: clean(entry.name),
      description: optionalClean(entry.description),
      status: 'active',
      provenance: entry.provenance ?? { source: 'owner_onboarding' },
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.businessModelEntries.set(modelEntry.id, modelEntry);
    this.recordAudit(organizationId, actorUserId, 'business_model_entry.created', 'business_model_entry', modelEntry.id);
    return modelEntry;
  }

  addFact({ organizationId, actorUserId, businessProfileId, fact }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    const profile = this.requireProfile(organizationId, businessProfileId);
    if (!FACT_KINDS.has(fact.factKind)) throw new AuthError('Unsupported fact kind.', 'VALIDATION_FAILED');
    for (const field of ['subject', 'predicate', 'value', 'source']) {
      if (!clean(fact[field])) throw new AuthError(`Fact ${field} is required.`, 'VALIDATION_FAILED');
    }
    if (fact.factKind === 'confirmed_fact' && fact.confidence !== undefined && fact.confidence !== 1) {
      throw new AuthError('Confirmed facts must have confidence 1 when confidence is provided.', 'VALIDATION_FAILED');
    }
    const businessFact = {
      id: randomUUID(),
      organizationId,
      businessProfileId: profile.id,
      factKind: fact.factKind,
      subject: clean(fact.subject),
      predicate: clean(fact.predicate),
      value: clean(fact.value),
      confidence: fact.factKind === 'confirmed_fact' ? 1 : fact.confidence ?? null,
      source: clean(fact.source),
      provenance: fact.provenance ?? {},
      validFrom: fact.validFrom ?? null,
      validUntil: fact.validUntil ?? null,
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.businessFacts.set(businessFact.id, businessFact);
    this.recordAudit(organizationId, actorUserId, 'business_fact.created', 'business_fact', businessFact.id, { factKind: fact.factKind });
    return businessFact;
  }

  addTerm({ organizationId, actorUserId, businessProfileId, term }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    const profile = this.requireProfile(organizationId, businessProfileId);
    if (!clean(term.term) || !clean(term.definition) || !clean(term.source)) {
      throw new AuthError('Term, definition, and source are required.', 'VALIDATION_FAILED');
    }
    const duplicate = [...this.store.businessTerms.values()].find((item) =>
      item.organizationId === organizationId
      && item.businessProfileId === profile.id
      && item.term.toLowerCase() === clean(term.term).toLowerCase()
    );
    if (duplicate) throw new AuthError('Business term already exists.', 'DUPLICATE_BUSINESS_TERM');
    const businessTerm = {
      id: randomUUID(),
      organizationId,
      businessProfileId: profile.id,
      term: clean(term.term),
      definition: clean(term.definition),
      source: clean(term.source),
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.businessTerms.set(businessTerm.id, businessTerm);
    this.recordAudit(organizationId, actorUserId, 'business_term.created', 'business_term', businessTerm.id);
    return businessTerm;
  }

  addGoal({ organizationId, actorUserId, businessProfileId, goal }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    const profile = this.requireProfile(organizationId, businessProfileId);
    if (!clean(goal.name) || !clean(goal.targetMetric) || !clean(goal.targetPeriod)) {
      throw new AuthError('Goal name, target metric, and target period are required.', 'VALIDATION_FAILED');
    }
    if (typeof goal.targetValue !== 'number' || !Number.isFinite(goal.targetValue)) {
      throw new AuthError('Goal target value must be a finite number.', 'VALIDATION_FAILED');
    }
    const businessGoal = {
      id: randomUUID(),
      organizationId,
      businessProfileId: profile.id,
      name: clean(goal.name),
      targetMetric: clean(goal.targetMetric),
      targetValue: goal.targetValue,
      targetPeriod: clean(goal.targetPeriod),
      status: 'active',
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.businessGoals.set(businessGoal.id, businessGoal);
    this.recordAudit(organizationId, actorUserId, 'business_goal.created', 'business_goal', businessGoal.id);
    return businessGoal;
  }

  addKpiDefinition({ organizationId, actorUserId, businessProfileId, kpi }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    const profile = this.requireProfile(organizationId, businessProfileId);
    if (!KPI_VALUE_TYPES.has(kpi.valueType)) throw new AuthError('Unsupported KPI value type.', 'VALIDATION_FAILED');
    for (const field of ['name', 'description', 'calculationMethod', 'sourceHint']) {
      if (!clean(kpi[field])) throw new AuthError(`KPI ${field} is required.`, 'VALIDATION_FAILED');
    }
    const existingVersions = [...this.store.kpiDefinitions.values()].filter((item) =>
      item.organizationId === organizationId
      && item.businessProfileId === profile.id
      && item.name.toLowerCase() === clean(kpi.name).toLowerCase()
    );
    const definition = {
      id: randomUUID(),
      organizationId,
      businessProfileId: profile.id,
      name: clean(kpi.name),
      description: clean(kpi.description),
      valueType: kpi.valueType,
      calculationMethod: clean(kpi.calculationMethod),
      sourceHint: clean(kpi.sourceHint),
      version: existingVersions.length + 1,
      activeFrom: kpi.activeFrom ?? new Date().toISOString().slice(0, 10),
      activeUntil: null,
      createdByUserId: actorUserId,
      createdAt: new Date()
    };
    this.store.kpiDefinitions.set(definition.id, definition);
    this.recordAudit(organizationId, actorUserId, 'kpi_definition.created', 'kpi_definition', definition.id, { version: definition.version });
    return definition;
  }

  completeOnboarding({ organizationId, actorUserId, businessProfileId }) {
    this.requireWriteBusinessData({ organizationId, actorUserId });
    const profile = this.requireProfile(organizationId, businessProfileId);
    const summary = this.getOnboardingSummary({ organizationId, actorUserId, businessProfileId });
    const missing = requiredCompletionSections(summary);
    if (missing.length > 0) {
      throw new AuthError(`Onboarding is incomplete: ${missing.join(', ')}`, 'ONBOARDING_INCOMPLETE');
    }
    profile.status = 'completed';
    profile.completedAt = new Date();
    profile.updatedByUserId = actorUserId;
    profile.updatedAt = new Date();
    this.recordAudit(organizationId, actorUserId, 'business_onboarding.completed', 'business_profile', profile.id);
    return profile;
  }

  getOnboardingSummary({ organizationId, actorUserId, businessProfileId }) {
    new AuthorizationService(this.store).requireCapability({
      userId: actorUserId,
      organizationId,
      capability: CAPABILITIES.READ_BUSINESS_DATA
    });
    const profile = this.requireProfile(organizationId, businessProfileId);
    const entries = [...this.store.businessModelEntries.values()].filter((item) => item.organizationId === organizationId && item.businessProfileId === profile.id);
    const facts = [...this.store.businessFacts.values()].filter((item) => item.organizationId === organizationId && item.businessProfileId === profile.id);
    return {
      state: profile.status === 'completed' ? 'ready' : 'incomplete',
      profile,
      counts: {
        productServices: entries.filter((item) => item.entryType === 'product_service').length,
        locations: entries.filter((item) => item.entryType === 'location').length,
        customerSegments: entries.filter((item) => item.entryType === 'customer_segment').length,
        channels: entries.filter((item) => item.entryType === 'channel').length,
        confirmedFacts: facts.filter((item) => item.factKind === 'confirmed_fact').length,
        inferredFacts: facts.filter((item) => item.factKind === 'inferred_fact').length,
        terms: countByProfile(this.store.businessTerms, organizationId, profile.id),
        goals: countByProfile(this.store.businessGoals, organizationId, profile.id),
        kpis: countByProfile(this.store.kpiDefinitions, organizationId, profile.id)
      }
    };
  }

  requireWriteBusinessData({ organizationId, actorUserId }) {
    return new AuthorizationService(this.store).requireCapability({
      userId: actorUserId,
      organizationId,
      capability: CAPABILITIES.WRITE_BUSINESS_DATA
    });
  }

  requireProfile(organizationId, businessProfileId) {
    const profile = this.store.businessProfiles.get(businessProfileId);
    if (!profile || profile.organizationId !== organizationId) {
      throw new AuthError('Business profile not found.', 'NOT_FOUND');
    }
    return profile;
  }

  recordAudit(organizationId, actorUserId, eventType, targetType, targetId, metadata = {}) {
    this.auditLog?.record({ organizationId, actorUserId, eventType, targetType, targetId, metadata });
  }
}

export function businessOnboardingShellState(summary) {
  const missing = requiredCompletionSections(summary);
  if (!summary.profile) return { state: 'empty', missing: ['profile'] };
  if (summary.profile.status === 'completed') return { state: 'ready', missing: [] };
  return {
    state: missing.length > 0 ? 'incomplete' : 'review',
    missing
  };
}

function requiredCompletionSections(summary) {
  const missing = [];
  if (!summary.profile) missing.push('profile');
  if (summary.counts.productServices < 1) missing.push('product_service');
  if (summary.counts.customerSegments < 1) missing.push('customer_segment');
  if (summary.counts.channels < 1) missing.push('channel');
  if (summary.counts.confirmedFacts < 1) missing.push('confirmed_fact');
  if (summary.counts.terms < 1) missing.push('business_term');
  if (summary.counts.goals < 1) missing.push('business_goal');
  if (summary.counts.kpis < 1) missing.push('kpi_definition');
  return missing;
}

function validateProfile(profile) {
  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (profile[field] === undefined || profile[field] === null || clean(profile[field]) === '') {
      throw new AuthError(`Business profile ${field} is required.`, 'VALIDATION_FAILED');
    }
  }
  if (!/^[A-Z]{3}$/i.test(clean(profile.primaryCurrency))) {
    throw new AuthError('Primary currency must be a three-letter ISO code.', 'VALIDATION_FAILED');
  }
  if (!Number.isInteger(profile.fiscalYearStartMonth) || profile.fiscalYearStartMonth < 1 || profile.fiscalYearStartMonth > 12) {
    throw new AuthError('Fiscal year start month must be 1 through 12.', 'VALIDATION_FAILED');
  }
}

function countByProfile(map, organizationId, businessProfileId) {
  return [...map.values()].filter((item) => item.organizationId === organizationId && item.businessProfileId === businessProfileId).length;
}

function clean(value) {
  return String(value ?? '').trim();
}

function optionalClean(value) {
  const cleaned = clean(value);
  return cleaned === '' ? null : cleaned;
}
