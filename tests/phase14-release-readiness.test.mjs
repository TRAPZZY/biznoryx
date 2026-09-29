import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReleaseReadiness, releaseReadinessSummary, validateProductionEnvironment } from '../src/release/readiness.mjs';

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://biznoryx_app:strong_password@prod-db.internal:5432/biznoryx',
  BIZNORYX_APP_DB_PASSWORD: 'production-runtime-password-32chars',
  BIZNORYX_SESSION_SECRET: 'session-secret-with-at-least-32-characters',
  BIZNORYX_CSRF_SECRET: 'csrf-secret-with-at-least-32-characters',
  BIZNORYX_PUBLIC_URL: 'https://app.biznoryx.example',
  BIZNORYX_STORAGE_BUCKET: 'biznoryx-prod-private',
  BIZNORYX_STORAGE_REGION: 'us-east-1',
  BIZNORYX_SECRET_PROVIDER: 'vault'
};

test('production environment validation blocks unsafe deploy settings', () => {
  const result = validateProductionEnvironment({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://biznoryx_admin:biznoryx_local_password@localhost:5432/biznoryx',
    BIZNORYX_APP_DB_PASSWORD: 'local_runtime_password_change_me',
    BIZNORYX_SESSION_SECRET: 'short',
    BIZNORYX_CSRF_SECRET: 'short',
    BIZNORYX_PUBLIC_URL: 'http://localhost:3000',
    BIZNORYX_STORAGE_BUCKET: 'bucket',
    BIZNORYX_STORAGE_REGION: 'us-east-1',
    BIZNORYX_SECRET_PROVIDER: 'env_file'
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('NODE_ENV must be production')));
  assert.ok(result.findings.some((finding) => finding.message.includes('must not point at local development credentials')));
  assert.ok(result.findings.some((finding) => finding.message.includes('must use HTTPS')));
});

test('production environment validation accepts managed production settings', () => {
  const result = validateProductionEnvironment(productionEnv);

  assert.equal(result.state, 'ready');
  assert.deepEqual(result.findings, []);
});

test('release readiness requires accepted foundation evidence and release script', () => {
  const result = evaluateReleaseReadiness({
    buildStatus: 'Current phase: **Phase 14 - Release Readiness and Production Hardening**\nStatus: **accepted**\nAll planned Phase 1-13 product foundation slices are accepted.',
    readme: 'BIZNORYX\nPhase 13 enterprise scaling',
    packageJson: { scripts: { verify: 'npm run build', 'release:check': 'node scripts/release-check.mjs' } },
    migrationFiles: ['0014_phase13_enterprise_scaling.sql', '0014_phase13_enterprise_scaling.down.sql'],
    acceptanceFiles: ['phase13_enterprise_scaling_acceptance.sql'],
    env: productionEnv
  });

  assert.equal(result.state, 'ready');
  assert.equal(releaseReadinessSummary(result), 'Release gate ready: production configuration and Phase 1-13 evidence are present.');
});

test('release readiness fails loudly when evidence is incomplete', () => {
  const result = evaluateReleaseReadiness({
    buildStatus: 'Status: **accepted**',
    readme: 'BIZNORYX',
    packageJson: { scripts: { verify: 'npm run build' } },
    migrationFiles: [],
    acceptanceFiles: [],
    env: {}
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.length >= 8);
  assert.match(releaseReadinessSummary(result), /blocked/);
});
