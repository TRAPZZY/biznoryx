import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReleaseReadiness, releaseReadinessSummary, validateProductionEnvironment } from '../src/release/readiness.mjs';

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://biznoryx_app:strong_password@prod-db.internal:5432/biznoryx',
  BIZNORYX_APP_DB_PASSWORD: 'production-runtime-password-32chars',
  BIZNORYX_PUBLIC_URL: 'https://app.biznoryx.example',
  BIZNORYX_OBJECT_STORAGE_BUCKET: 'biznoryx-prod-private',
  BIZNORYX_OBJECT_STORAGE_REGION: 'auto',
  BIZNORYX_OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID: 'production-storage-access-key',
  BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'production-storage-secret-key',
  RESEND_API_KEY: 'production-email-api-key',
  BIZNORYX_EMAIL_FROM: 'BIZNORYX <verify@biznoryx.example>',
  PAYSTACK_SECRET_KEY: 'production-paystack-secret-key',
  PAYSTACK_PLAN_CODE: 'PLN_production_monthly',
  BIZNORYX_SECRET_PROVIDER: 'vault'
};

test('production environment validation blocks unsafe deploy settings', () => {
  const result = validateProductionEnvironment({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://biznoryx_admin:biznoryx_local_password@localhost:5432/biznoryx',
    BIZNORYX_APP_DB_PASSWORD: 'local_runtime_password_change_me',
    BIZNORYX_PUBLIC_URL: 'http://localhost:3000',
    BIZNORYX_OBJECT_STORAGE_BUCKET: 'bucket',
    BIZNORYX_OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID: 'local-access-key',
    BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
    BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE: 'sometimes',
    RESEND_API_KEY: 'email-api-key',
    BIZNORYX_EMAIL_FROM: 'BIZNORYX <verify@example.com>',
    PAYSTACK_SECRET_KEY: 'paystack-secret-key',
    PAYSTACK_PLAN_CODE: 'PLN_test',
    BIZNORYX_SECRET_PROVIDER: 'env_file'
  });

  assert.equal(result.state, 'blocked');
  assert.ok(result.findings.some((finding) => finding.message.includes('NODE_ENV must be production')));
  assert.ok(result.findings.some((finding) => finding.message.includes('must not point at local development credentials')));
  assert.ok(result.findings.some((finding) => finding.message.includes('must use HTTPS')));
  assert.ok(result.findings.some((finding) => finding.message.includes('BIZNORYX_OBJECT_STORAGE_ENDPOINT must use HTTPS')));
  assert.ok(result.findings.some((finding) => finding.message.includes('BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE must be true or false')));
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
