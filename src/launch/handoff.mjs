const REQUIRED_HANDOFF_ITEMS = Object.freeze([
  'operator_runbooks',
  'customer_onboarding',
  'support_ownership',
  'incident_contacts',
  'rollback_owner',
  'data_handling_notice',
  'known_limitations',
  'beta_success_criteria'
]);

export function validateLaunchManifest(manifest) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object') findings.push(blocker('Launch manifest is required.'));
  const spec = manifest ?? {};
  if (spec.schemaVersion !== 1) findings.push(blocker('Launch manifest schemaVersion must be 1.'));
  if (!['private_beta', 'public_launch'].includes(spec.launchStage)) findings.push(blocker('Launch stage must be private_beta or public_launch.'));
  if (!spec.launchOwner) findings.push(blocker('Launch owner is required.'));
  if (!Array.isArray(spec.handoffItems)) findings.push(blocker('Launch handoff items must be listed.'));
  const handoffItems = new Map((spec.handoffItems ?? []).map((item) => [item.id, item]));
  for (const id of REQUIRED_HANDOFF_ITEMS) {
    if (!handoffItems.has(id)) findings.push(blocker(`Missing launch handoff item: ${id}`));
  }
  for (const item of spec.handoffItems ?? []) {
    if (item.status !== 'ready') findings.push(blocker(`Launch handoff item ${item.id} must be ready.`));
    if (!item.owner) findings.push(blocker(`Launch handoff item ${item.id} must have an owner.`));
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) findings.push(blocker(`Launch handoff item ${item.id} must include evidence.`));
  }
  if (!Array.isArray(spec.beta?.allowedCustomerTypes) || spec.beta.allowedCustomerTypes.length === 0) findings.push(blocker('Beta allowed customer types must be defined.'));
  if (!Number.isInteger(spec.beta?.maxOrganizations) || spec.beta.maxOrganizations <= 0) findings.push(blocker('Beta max organizations must be positive.'));
  if (!Array.isArray(spec.beta?.excludedData) || spec.beta.excludedData.length === 0) findings.push(blocker('Beta excluded data categories must be listed.'));
  if (!Array.isArray(spec.goNoGo?.requiredGates) || spec.goNoGo.requiredGates.length === 0) findings.push(blocker('Go/no-go gates must be listed.'));
  for (const gate of ['release', 'deployment', 'compliance']) {
    if (!(spec.goNoGo?.requiredGates ?? []).includes(gate)) findings.push(blocker(`Go/no-go gates must include ${gate}.`));
  }
  if (spec.goNoGo?.finalApproverRequired !== true) findings.push(blocker('Final launch approver is required.'));
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings
  };
}

export function launchGate({ manifest, releaseReadiness, deploymentReadiness, complianceReadiness, finalApproval = false }) {
  const manifestResult = validateLaunchManifest(manifest);
  const findings = [...manifestResult.findings];
  if (releaseReadiness?.state !== 'ready') findings.push(blocker('Release readiness must be ready before launch.'));
  if (deploymentReadiness?.state !== 'ready') findings.push(blocker('Deployment readiness must be ready before launch.'));
  if (complianceReadiness?.state !== 'ready') findings.push(blocker('Compliance readiness must be ready before launch.'));
  if (!finalApproval) findings.push(blocker('Final accountable launch approval is required.'));
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings
  };
}

export function launchGateSummary(result) {
  if (result.state === 'ready') return 'Launch gate ready: handoff, readiness gates, and final approval are satisfied.';
  return `Launch gate blocked: ${result.findings.length} blocker(s).`;
}

function blocker(message) {
  return { severity: 'blocker', message };
}
