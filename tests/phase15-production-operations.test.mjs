import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentDecisionSummary, deploymentHealth, validateDeploymentManifest } from '../src/ops/deployment.mjs';

const validManifest = {
  schemaVersion: 1,
  environment: 'production',
  services: [
    { name: 'web', replicas: 2, healthCheck: { path: '/healthz' }, resources: { cpu: '500m', memory: '1024Mi' } },
    { name: 'worker', replicas: 2, resources: { cpu: '500m', memory: '1024Mi' } },
    { name: 'postgres', publicNetworkAccess: false, backups: { enabled: true, retentionDays: 30 } },
    { name: 'object_storage', publicAccess: false },
    { name: 'secrets', managedProvider: 'vault' }
  ],
  release: {
    strategy: 'blue_green',
    preflightCommands: ['verify', 'db:acceptance', 'release:check', 'deploy:check'],
    rollback: { enabled: true, runbook: 'docs/runbooks/phase15-production-operations.md' }
  }
};

test('deployment manifest accepts production-safe operational controls', () => {
  const result = validateDeploymentManifest(validManifest);

  assert.equal(result.state, 'ready');
  assert.deepEqual(result.findings, []);
});

test('deployment manifest blocks unsafe single-instance and public database settings', () => {
  const result = validateDeploymentManifest({
    schemaVersion: 1,
    environment: 'production',
    services: [
      { name: 'web', replicas: 1, resources: { cpu: '500m', memory: '1024Mi' } },
      { name: 'worker', replicas: 1, resources: { cpu: '500m', memory: '1024Mi' } },
      { name: 'postgres', publicNetworkAccess: true, backups: { enabled: true, retentionDays: 7 } },
      { name: 'object_storage', publicAccess: true },
      { name: 'secrets' }
    ],
    release: { strategy: 'manual', preflightCommands: ['verify'], rollback: { enabled: false } }
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('web must run at least two replicas')));
  assert.ok(result.findings.some((finding) => finding.message.includes('postgres must disable public network access')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Rollback must be enabled')));
});

test('deployment health requires manifest, release readiness, and database acceptance', () => {
  const result = deploymentHealth({
    manifest: validManifest,
    releaseReadiness: { state: 'ready' },
    databaseAcceptance: { state: 'ready' }
  });

  assert.equal(result.state, 'ready');
  assert.equal(deploymentDecisionSummary(result), 'Deployment gate ready: manifest, release readiness, and database acceptance are ready.');
});

test('deployment health distinguishes blockers from operator-review warnings', () => {
  const blocked = deploymentHealth({
    manifest: validManifest,
    releaseReadiness: { state: 'blocked' },
    databaseAcceptance: { state: 'ready' },
    activeIncidents: 1
  });
  const attention = deploymentHealth({
    manifest: validManifest,
    releaseReadiness: { state: 'ready' },
    databaseAcceptance: { state: 'ready' },
    activeIncidents: 1
  });

  assert.equal(blocked.state, 'blocked');
  assert.equal(attention.state, 'attention');
  assert.match(deploymentDecisionSummary(attention), /operator review/);
});
