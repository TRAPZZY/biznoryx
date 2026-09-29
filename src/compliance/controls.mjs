const REQUIRED_CONTROLS = Object.freeze([
  'tenant_isolation',
  'authentication_sessions',
  'authorization_capabilities',
  'audit_logging',
  'rls_database_enforcement',
  'secret_management',
  'data_retention',
  'incident_response',
  'backup_recovery',
  'release_change_management'
]);

const REQUIRED_DATA_CLASSES = Object.freeze(['business_data', 'account_data', 'audit_data', 'raw_uploads']);

export function validateComplianceManifest(manifest) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object') findings.push(blocker('Compliance manifest is required.'));
  const spec = manifest ?? {};
  if (spec.schemaVersion !== 1) findings.push(blocker('Compliance manifest schemaVersion must be 1.'));
  if (!Array.isArray(spec.frameworks) || spec.frameworks.length === 0) findings.push(blocker('At least one compliance framework must be declared.'));
  if (!Array.isArray(spec.controls)) findings.push(blocker('Compliance controls must be listed.'));
  const controlsById = new Map((spec.controls ?? []).map((control) => [control.id, control]));
  for (const id of REQUIRED_CONTROLS) {
    if (!controlsById.has(id)) findings.push(blocker(`Missing required compliance control: ${id}`));
  }
  for (const control of spec.controls ?? []) {
    if (!control.id) findings.push(blocker('Every compliance control must have an id.'));
    if (control.status !== 'implemented') findings.push(blocker(`Control ${control.id} must be implemented.`));
    if (!Array.isArray(control.evidence) || control.evidence.length === 0) findings.push(blocker(`Control ${control.id} must include evidence.`));
    if (!control.owner) findings.push(blocker(`Control ${control.id} must have an owner.`));
  }
  if (!Array.isArray(spec.dataProtection?.classes)) findings.push(blocker('Data protection classes must be listed.'));
  const dataClasses = new Set((spec.dataProtection?.classes ?? []).map((item) => item.name));
  for (const dataClass of REQUIRED_DATA_CLASSES) {
    if (!dataClasses.has(dataClass)) findings.push(blocker(`Missing data protection class: ${dataClass}`));
  }
  for (const item of spec.dataProtection?.classes ?? []) {
    if (!item.retention) findings.push(blocker(`Data class ${item.name} must define retention.`));
    if (item.encryptionAtRest !== true) findings.push(blocker(`Data class ${item.name} must require encryption at rest.`));
    if (item.encryptionInTransit !== true) findings.push(blocker(`Data class ${item.name} must require encryption in transit.`));
  }
  if (spec.incidentResponse?.runbook !== 'docs/runbooks/phase16-security-compliance.md') findings.push(blocker('Security incident response runbook must be linked.'));
  if (spec.auditReadiness?.evidenceReviewRequired !== true) findings.push(blocker('Audit evidence review must be required.'));
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings
  };
}

export function complianceGate({ manifest, releaseReadiness, deploymentReadiness, evidenceReviewed = false }) {
  const manifestResult = validateComplianceManifest(manifest);
  const findings = [...manifestResult.findings];
  if (releaseReadiness?.state !== 'ready') findings.push(blocker('Release readiness must be ready before compliance approval.'));
  if (deploymentReadiness?.state !== 'ready') findings.push(blocker('Deployment readiness must be ready before compliance approval.'));
  if (!evidenceReviewed) findings.push(blocker('Compliance evidence must be reviewed by an accountable owner.'));
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings
  };
}

export function complianceGateSummary(result) {
  if (result.state === 'ready') return 'Compliance gate ready: controls, evidence, release, and deployment readiness are satisfied.';
  return `Compliance gate blocked: ${result.findings.length} blocker(s).`;
}

function blocker(message) {
  return { severity: 'blocker', message };
}
