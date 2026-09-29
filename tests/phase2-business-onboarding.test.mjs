import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, IdentityService, OrganizationService, createEmptyStore } from '../src/auth/core.mjs';
import { BusinessOnboardingService, businessOnboardingShellState } from '../src/business/onboarding.mjs';

function fixture() {
  const store = createEmptyStore();
  const auditLog = new AuditLog(store);
  const identity = new IdentityService(store, auditLog);
  const orgs = new OrganizationService(store, auditLog);
  const onboarding = new BusinessOnboardingService(store, auditLog);
  const owner = identity.createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'owner password ok' });
  const viewer = identity.createUser({ email: 'viewer@example.com', displayName: 'Viewer', password: 'viewer password ok' });
  const outsider = identity.createUser({ email: 'outsider@example.com', displayName: 'Outsider', password: 'outsider password ok' });
  const organization = orgs.createOrganization({ name: 'Acme Retail', slug: 'acme-retail', actorUserId: owner.id }).organization;
  orgs.addMembership({ organizationId: organization.id, userId: viewer.id, role: 'viewer', actorUserId: owner.id });
  return { store, onboarding, owner, viewer, outsider, organization };
}

function profileInput() {
  return {
    legalName: 'Acme Retail Group Ltd',
    tradingName: 'Acme Retail',
    industry: 'Specialty retail',
    businessModel: 'Multi-location retail selling products through stores and ecommerce',
    primaryCurrency: 'usd',
    fiscalYearStartMonth: 1,
    timezone: 'America/New_York'
  };
}

function completeMinimumOnboarding(onboarding, organization, owner, profile) {
  onboarding.addModelEntry({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    entry: { entryType: 'product_service', name: 'Core retail products' }
  });
  onboarding.addModelEntry({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    entry: { entryType: 'customer_segment', name: 'Local shoppers' }
  });
  onboarding.addModelEntry({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    entry: { entryType: 'channel', name: 'Store sales' }
  });
  onboarding.addFact({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    fact: {
      factKind: 'confirmed_fact',
      subject: 'Business',
      predicate: 'operates_as',
      value: 'Specialty retail group',
      source: 'owner_onboarding'
    }
  });
  onboarding.addTerm({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    term: { term: 'Net sales', definition: 'Sales after returns and discounts', source: 'owner_onboarding' }
  });
  onboarding.addGoal({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    goal: { name: 'Grow revenue', targetMetric: 'Revenue', targetValue: 12, targetPeriod: 'FY2027' }
  });
  onboarding.addKpiDefinition({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    kpi: {
      name: 'Revenue',
      description: 'Total net sales for the reporting period',
      valueType: 'money',
      calculationMethod: 'sum net sales from verified sales data',
      sourceHint: 'monthly sales exports'
    }
  });
}

test('owner can complete the minimum business onboarding model', () => {
  const { store, onboarding, owner, organization } = fixture();
  const profile = onboarding.createOrUpdateProfile({ organizationId: organization.id, actorUserId: owner.id, profile: profileInput() });
  completeMinimumOnboarding(onboarding, organization, owner, profile);

  const summaryBeforeCompletion = onboarding.getOnboardingSummary({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  assert.equal(businessOnboardingShellState(summaryBeforeCompletion).state, 'review');

  const completed = onboarding.completeOnboarding({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });
  const summary = onboarding.getOnboardingSummary({ organizationId: organization.id, actorUserId: owner.id, businessProfileId: profile.id });

  assert.equal(completed.status, 'completed');
  assert.equal(summary.counts.kpis, 1);
  assert.equal(businessOnboardingShellState(summary).state, 'ready');
  assert.ok(store.auditEvents.some((event) => event.eventType === 'business_onboarding.completed'));
});

test('onboarding cannot complete while required business understanding sections are missing', () => {
  const { onboarding, owner, organization } = fixture();
  const profile = onboarding.createOrUpdateProfile({ organizationId: organization.id, actorUserId: owner.id, profile: profileInput() });

  assert.throws(() => onboarding.completeOnboarding({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id
  }), /Onboarding is incomplete/);
});

test('viewer can read onboarding summary but cannot mutate business profile', () => {
  const { onboarding, owner, viewer, organization } = fixture();
  const profile = onboarding.createOrUpdateProfile({ organizationId: organization.id, actorUserId: owner.id, profile: profileInput() });

  assert.equal(onboarding.getOnboardingSummary({
    organizationId: organization.id,
    actorUserId: viewer.id,
    businessProfileId: profile.id
  }).profile.id, profile.id);

  assert.throws(() => onboarding.addKpiDefinition({
    organizationId: organization.id,
    actorUserId: viewer.id,
    businessProfileId: profile.id,
    kpi: {
      name: 'Revenue',
      description: 'Total sales',
      valueType: 'money',
      calculationMethod: 'sum verified sales',
      sourceHint: 'sales exports'
    }
  }), /Capability required/);
});

test('cross-organization access to onboarding records is denied', () => {
  const { onboarding, owner, outsider, organization } = fixture();
  const profile = onboarding.createOrUpdateProfile({ organizationId: organization.id, actorUserId: owner.id, profile: profileInput() });

  assert.throws(() => onboarding.getOnboardingSummary({
    organizationId: organization.id,
    actorUserId: outsider.id,
    businessProfileId: profile.id
  }), /Active organization membership/);

  assert.throws(() => onboarding.addFact({
    organizationId: organization.id,
    actorUserId: outsider.id,
    businessProfileId: profile.id,
    fact: {
      factKind: 'confirmed_fact',
      subject: 'Business',
      predicate: 'operates_as',
      value: 'Retail',
      source: 'outsider'
    }
  }), /Active organization membership/);
});

test('confirmed facts cannot be silently downgraded into uncertain values', () => {
  const { onboarding, owner, organization } = fixture();
  const profile = onboarding.createOrUpdateProfile({ organizationId: organization.id, actorUserId: owner.id, profile: profileInput() });

  assert.throws(() => onboarding.addFact({
    organizationId: organization.id,
    actorUserId: owner.id,
    businessProfileId: profile.id,
    fact: {
      factKind: 'confirmed_fact',
      subject: 'Business',
      predicate: 'has_locations',
      value: '3',
      confidence: 0.75,
      source: 'owner_onboarding'
    }
  }), /Confirmed facts/);
});
