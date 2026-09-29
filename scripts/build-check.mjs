import { existsSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const status = readFileSync('BUILD_STATUS.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const workflowPath = '.github/workflows/phase1.yml';

if (!status.includes('Public production: **not ready**')) {
  console.error('BUILD_STATUS.md must disclose the current runtime production boundary.');
  process.exit(1);
}

if (!readme.includes('BIZNORYX')) {
  console.error('README.md missing product identity.');
  process.exit(1);
}

if (!existsSync(workflowPath)) {
  console.error('Missing Phase 1 CI workflow.');
  process.exit(1);
}

const workflow = readFileSync(workflowPath, 'utf8');
if (!workflow.includes('postgres:18') || !workflow.includes('npm run db:acceptance')) {
  console.error('Phase 1 CI workflow must run PostgreSQL acceptance.');
  process.exit(1);
}

for (const entry of ['web-app/app.js', 'src/webapp/review-app.mjs', 'src/webapp/customer-data.mjs']) {
  const result = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const required of ['web-app/index.html', 'web-app/styles.css', 'node_modules/lucide/dist/umd/lucide.min.js']) {
  if (!existsSync(required)) throw new Error(`Missing application asset: ${required}`);
}
mkdirSync('dist/scripts', { recursive: true });
cpSync('web-app', 'dist/web-app', { recursive: true });
cpSync('src', 'dist/src', { recursive: true });
cpSync('scripts/app-server.mjs', 'dist/scripts/app-server.mjs');
cpSync('package.json', 'dist/package.json');
cpSync('package-lock.json', 'dist/package-lock.json');
process.stdout.write('Application sources and assets packaged in dist. Production runtime remains gated.\n');
