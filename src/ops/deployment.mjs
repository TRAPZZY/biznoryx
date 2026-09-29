const REQUIRED_SERVICES = Object.freeze(['web', 'worker', 'postgres', 'object_storage', 'secrets']);
const REQUIRED_COMMANDS = Object.freeze(['verify', 'db:acceptance', 'release:check']);

export function validateDeploymentManifest(manifest) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object') findings.push(blocker('Deployment manifest is required.'));
  const spec = manifest ?? {};
  if (spec.schemaVersion !== 1) findings.push(blocker('Deployment manifest schemaVersion must be 1.'));
  if (spec.environment !== 'production') findings.push(blocker('Deployment manifest environment must be production.'));
  if (!Array.isArray(spec.services)) findings.push(blocker('Deployment manifest services must be listed.'));
  const serviceNames = new Set((spec.services ?? []).map((service) => service.name));
  for (const service of REQUIRED_SERVICES) {
    if (!serviceNames.has(service)) findings.push(blocker(`Deployment manifest missing service: ${service}`));
  }
  for (const service of spec.services ?? []) {
    if (!service.name) findings.push(blocker('Every service must have a name.'));
    if (['web', 'worker'].includes(service.name)) {
      if (!Number.isInteger(service.replicas) || service.replicas < 2) findings.push(blocker(`${service.name} must run at least two replicas.`));
      if (!service.healthCheck?.path && service.name === 'web') findings.push(blocker('web service must define an HTTP health check path.'));
      if (!service.resources?.cpu || !service.resources?.memory) findings.push(blocker(`${service.name} must define CPU and memory resources.`));
    }
    if (service.name === 'postgres') {
      if (service.publicNetworkAccess !== false) findings.push(blocker('postgres must disable public network access.'));
      if (service.backups?.enabled !== true) findings.push(blocker('postgres backups must be enabled.'));
      if (!Number.isInteger(service.backups?.retentionDays) || service.backups.retentionDays < 14) findings.push(blocker('postgres backup retention must be at least 14 days.'));
    }
    if (service.name === 'object_storage' && service.publicAccess !== false) findings.push(blocker('object storage must disable public access.'));
    if (service.name === 'secrets' && !service.managedProvider) findings.push(blocker('secrets service must use a managed provider.'));
  }
  if (!spec.release?.strategy) findings.push(blocker('Release strategy is required.'));
  if (spec.release?.strategy && !['blue_green', 'rolling'].includes(spec.release.strategy)) findings.push(blocker('Release strategy must be blue_green or rolling.'));
  for (const command of REQUIRED_COMMANDS) {
    if (!(spec.release?.preflightCommands ?? []).includes(command)) findings.push(blocker(`Release preflight must include ${command}.`));
  }
  if (spec.release?.rollback?.enabled !== true) findings.push(blocker('Rollback must be enabled.'));
  if (!spec.release?.rollback?.runbook) findings.push(blocker('Rollback runbook is required.'));
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings
  };
}

export function deploymentHealth({ manifest, releaseReadiness, databaseAcceptance, activeIncidents = 0 }) {
  const manifestResult = validateDeploymentManifest(manifest);
  const findings = [...manifestResult.findings];
  if (releaseReadiness?.state !== 'ready') findings.push(blocker('Release readiness gate must be ready.'));
  if (databaseAcceptance?.state !== 'ready') findings.push(blocker('Database acceptance gate must be ready.'));
  if (activeIncidents > 0) findings.push(warning('Active incidents must be reviewed before deployment.'));
  return {
    state: findings.some((finding) => finding.severity === 'blocker') ? 'blocked' : findings.length > 0 ? 'attention' : 'ready',
    findings
  };
}

export function deploymentDecisionSummary(result) {
  if (result.state === 'ready') return 'Deployment gate ready: manifest, release readiness, and database acceptance are ready.';
  if (result.state === 'attention') return `Deployment gate needs operator review: ${result.findings.length} finding(s).`;
  return `Deployment gate blocked: ${result.findings.filter((finding) => finding.severity === 'blocker').length} blocker(s).`;
}

function blocker(message) {
  return { severity: 'blocker', message };
}

function warning(message) {
  return { severity: 'warning', message };
}
