import test from 'node:test';
import assert from 'node:assert/strict';
import { launchGate, launchGateSummary, validateLaunchManifest } from '../src/launch/handoff.mjs';

const requiredHandoffItems = [
  'operator_runbooks',
  'customer_onboarding',
  'support_ownership',
  'incident_contacts',
  'rollback_owner',
  'data_handling_notice',
  'known_limitations',
  'beta_success_criteria'
];

const validManifest = {
  schemaVersion: 1,
  launchStage: 'private_beta',
  launchOwner: 'founder',
  handoffItems: requiredHandoffItems.map((id) => ({ id, status: 'ready', owner: 'owner', evidence: ['BUILD_STATUS.md'] })),
  beta: {
    allowedCustomerTypes: ['friendly_design_partner'],
    maxOrganizations: 5,
    excludedData: ['regulated_health_data']
  },
  goNoGo: {
    requiredGates: ['release', 'deployment', 'compliance'],
    finalApproverRequired: true
  }
};

test('launch manifest accepts complete private beta handoff controls', () => {
  const result = validateLaunchManifest(validManifest);

  assert.equal(result.state, 'ready');
  assert.deepEqual(result.findings, []);
});

test('launch manifest blocks missing handoff items and unsafe beta scope', () => {
  const result = validateLaunchManifest({
    schemaVersion: 1,
    launchStage: 'private_beta',
    launchOwner: '',
    handoffItems: [{ id: 'operator_runbooks', status: 'draft', owner: '', evidence: [] }],
    beta: { allowedCustomerTypes: [], maxOrganizations: 0, excludedData: [] },
    goNoGo: { requiredGates: ['release'], finalApproverRequired: false }
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('Launch owner is required')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Missing launch handoff item')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Beta max organizations must be positive')));
});

test('launch gate requires prior gates and final approval', () => {
  const result = launchGate({
    manifest: validManifest,
    releaseReadiness: { state: 'ready' },
    deploymentReadiness: { state: 'ready' },
    complianceReadiness: { state: 'ready' },
    finalApproval: true
  });

  assert.equal(result.state, 'ready');
  assert.equal(launchGateSummary(result), 'Launch gate ready: handoff, readiness gates, and final approval are satisfied.');
});

test('launch gate blocks without release deployment compliance and approval', () => {
  const result = launchGate({
    manifest: validManifest,
    releaseReadiness: { state: 'blocked' },
    deploymentReadiness: { state: 'blocked' },
    complianceReadiness: { state: 'blocked' },
    finalApproval: false
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('Release readiness')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Deployment readiness')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Compliance readiness')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Final accountable')));
});
