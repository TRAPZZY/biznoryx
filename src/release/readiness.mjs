const REQUIRED_PHASE_MARKERS = Object.freeze([
  'Phase 14 - Release Readiness and Production Hardening',
  'Status: **accepted**',
  'All planned Phase 1-13 product foundation slices are accepted'
]);

const REQUIRED_PRODUCTION_ENV = Object.freeze([
  'NODE_ENV',
  'DATABASE_URL',
  'BIZNORYX_APP_DB_PASSWORD',
  'BIZNORYX_PUBLIC_URL',
  'BIZNORYX_OBJECT_STORAGE_BUCKET',
  'BIZNORYX_OBJECT_STORAGE_REGION',
  'BIZNORYX_OBJECT_STORAGE_ENDPOINT',
  'BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID',
  'BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'RESEND_API_KEY',
  'BIZNORYX_EMAIL_FROM',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_PLAN_CODE',
  'BIZNORYX_SECRET_PROVIDER'
]);

export function validateProductionEnvironment(env = process.env) {
  const findings = [];
  for (const name of REQUIRED_PRODUCTION_ENV) {
    if (!String(env[name] ?? '').trim()) findings.push(blocker(`Missing required environment variable: ${name}`));
  }
  if (env.NODE_ENV && env.NODE_ENV !== 'production') findings.push(blocker('NODE_ENV must be production.'));
  if (env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) findings.push(blocker('DATABASE_URL must be a PostgreSQL connection string.'));
  if (env.DATABASE_URL && /localhost|127\.0\.0\.1|biznoryx_local_password/i.test(env.DATABASE_URL)) findings.push(blocker('DATABASE_URL must not point at local development credentials.'));
  if (env.BIZNORYX_APP_DB_PASSWORD && env.BIZNORYX_APP_DB_PASSWORD.length < 24) findings.push(blocker('BIZNORYX_APP_DB_PASSWORD must be at least 24 characters.'));
  if (env.BIZNORYX_APP_DB_PASSWORD && /local_runtime_password_change_me/i.test(env.BIZNORYX_APP_DB_PASSWORD)) findings.push(blocker('BIZNORYX_APP_DB_PASSWORD must not use the local development value.'));
  if (env.BIZNORYX_PUBLIC_URL && !/^https:\/\//.test(env.BIZNORYX_PUBLIC_URL)) findings.push(blocker('BIZNORYX_PUBLIC_URL must use HTTPS.'));
  if (env.BIZNORYX_OBJECT_STORAGE_ENDPOINT) {
    try {
      if (new URL(env.BIZNORYX_OBJECT_STORAGE_ENDPOINT).protocol !== 'https:') {
        findings.push(blocker('BIZNORYX_OBJECT_STORAGE_ENDPOINT must use HTTPS.'));
      }
    } catch {
      findings.push(blocker('BIZNORYX_OBJECT_STORAGE_ENDPOINT must be a valid HTTPS URL.'));
    }
  }
  if (
    env.BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE &&
    !['true', 'false'].includes(
      env.BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE.toLowerCase(),
    )
  ) {
    findings.push(
      blocker('BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE must be true or false.'),
    );
  }
  if (env.BIZNORYX_SECRET_PROVIDER && !['vault', 'aws_secrets_manager', 'gcp_secret_manager', 'azure_key_vault'].includes(env.BIZNORYX_SECRET_PROVIDER)) {
    findings.push(blocker('BIZNORYX_SECRET_PROVIDER must identify a supported managed secret provider.'));
  }
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings
  };
}

export function evaluateReleaseReadiness({ buildStatus, readme, packageJson, migrationFiles, acceptanceFiles, env = process.env }) {
  const findings = [];
  for (const marker of REQUIRED_PHASE_MARKERS) {
    if (!buildStatus.includes(marker)) findings.push(blocker(`BUILD_STATUS.md missing marker: ${marker}`));
  }
  if (!readme.includes('Phase 13 enterprise scaling')) findings.push(blocker('README.md must describe the accepted Phase 13 enterprise scaling layer.'));
  if (!packageJson.scripts?.verify) findings.push(blocker('package.json must expose npm run verify.'));
  if (!packageJson.scripts?.['release:check']) findings.push(blocker('package.json must expose npm run release:check.'));
  if (!migrationFiles.some((name) => name === '0014_phase13_enterprise_scaling.sql')) findings.push(blocker('Phase 13 migration is missing.'));
  if (!migrationFiles.some((name) => name === '0014_phase13_enterprise_scaling.down.sql')) findings.push(blocker('Phase 13 rollback migration is missing.'));
  if (!acceptanceFiles.some((name) => name === 'phase13_enterprise_scaling_acceptance.sql')) findings.push(blocker('Phase 13 PostgreSQL acceptance script is missing.'));
  findings.push(...validateProductionEnvironment(env).findings);
  return {
    state: findings.length === 0 ? 'ready' : 'blocked',
    findings,
    checkedAt: new Date().toISOString()
  };
}

export function releaseReadinessSummary(result) {
  if (result.state === 'ready') return 'Release gate ready: production configuration and Phase 1-13 evidence are present.';
  return `Release gate blocked: ${result.findings.length} blocker(s) require resolution.`;
}

function blocker(message) {
  return { severity: 'blocker', message };
}
