import test from 'node:test';
import assert from 'node:assert/strict';
import { complianceGate, complianceGateSummary, validateComplianceManifest } from '../src/compliance/controls.mjs';

const validManifest = {
  schemaVersion: 1,
  frameworks: ['SOC2-readiness'],
  controls: [
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
  ].map((id) => ({ id, status: 'implemented', owner: 'security', evidence: ['BUILD_STATUS.md'] })),
  dataProtection: {
    classes: [
      { name: 'business_data', retention: 'customer_contract', encryptionAtRest: true, encryptionInTransit: true },
      { name: 'account_data', retention: 'account_lifetime_plus_90_days', encryptionAtRest: true, encryptionInTransit: true },
      { name: 'audit_data', retention: 'seven_years', encryptionAtRest: true, encryptionInTransit: true },
      { name: 'raw_uploads', retention: 'customer_contract', encryptionAtRest: true, encryptionInTransit: true }
    ]
  },
  incidentResponse: { runbook: 'docs/runbooks/phase16-security-compliance.md' },
  auditReadiness: { evidenceReviewRequired: true }
};

test('compliance manifest accepts implemented controls and data protection evidence', () => {
  const result = validateComplianceManifest(validManifest);

  assert.equal(result.state, 'ready');
  assert.deepEqual(result.findings, []);
});

test('compliance manifest blocks missing controls and weak data protection', () => {
  const result = validateComplianceManifest({
    schemaVersion: 1,
    frameworks: ['SOC2-readiness'],
    controls: [{ id: 'tenant_isolation', status: 'planned', owner: 'security', evidence: [] }],
    dataProtection: { classes: [{ name: 'business_data', retention: '', encryptionAtRest: false, encryptionInTransit: true }] },
    incidentResponse: { runbook: 'missing.md' },
    auditReadiness: { evidenceReviewRequired: false }
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('Missing required compliance control')));
  assert.ok(result.findings.some((finding) => finding.message.includes('must require encryption at rest')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Security incident response runbook')));
});

test('compliance gate requires release, deployment, and evidence review', () => {
  const result = complianceGate({
    manifest: validManifest,
    releaseReadiness: { state: 'ready' },
    deploymentReadiness: { state: 'ready' },
    evidenceReviewed: true
  });

  assert.equal(result.state, 'ready');
  assert.equal(complianceGateSummary(result), 'Compliance gate ready: controls, evidence, release, and deployment readiness are satisfied.');
});

test('compliance gate blocks unreviewed evidence and missing readiness gates', () => {
  const result = complianceGate({
    manifest: validManifest,
    releaseReadiness: { state: 'blocked' },
    deploymentReadiness: { state: 'blocked' },
    evidenceReviewed: false
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('Release readiness')));
  assert.ok(result.findings.some((finding) => finding.message.includes('Deployment readiness')));
  assert.ok(result.findings.some((finding) => finding.message.includes('evidence must be reviewed')));
});
