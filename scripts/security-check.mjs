import { readFileSync } from 'node:fs';

const auth = readFileSync('src/auth/core.mjs', 'utf8');
const migration = readFileSync('db/migrations/0002_phase1_identity_org_auth.sql', 'utf8');
const bootstrap = readFileSync('db/bootstrap/001_runtime_role.sql', 'utf8');
const required = [
  ['HttpOnly cookie', /HttpOnly/],
  ['SameSite cookie', /SameSite=Lax/],
  ['CSRF token hash', /csrfTokenHash/],
  ['session revocation', /revokedAt/],
  ['timing safe password verification', /timingSafeEqual/],
  ['transaction tenant organization setting', /app\.current_organization_id/],
  ['transaction tenant user setting', /app\.current_user_id/],
  ['membership RLS', /organization_memberships_rls/],
  ['session self RLS', /user_sessions_self_rls/],
  ['RLS write checks', /with check/i],
  ['runtime role cannot bypass RLS', /nobypassrls/i]
];

const problems = required
  .filter(([, pattern]) => !pattern.test(auth) && !pattern.test(migration) && !pattern.test(bootstrap))
  .map(([name]) => `Missing security control: ${name}`);

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
