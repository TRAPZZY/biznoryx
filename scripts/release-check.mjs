import { readFileSync, readdirSync } from 'node:fs';
import { evaluateReleaseReadiness, releaseReadinessSummary } from '../src/release/readiness.mjs';

const result = evaluateReleaseReadiness({
  buildStatus: readFileSync('BUILD_STATUS.md', 'utf8'),
  readme: readFileSync('README.md', 'utf8'),
  packageJson: JSON.parse(readFileSync('package.json', 'utf8')),
  migrationFiles: readdirSync('db/migrations'),
  acceptanceFiles: readdirSync('db/acceptance'),
  env: process.env
});

if (result.state !== 'ready') {
  console.error(releaseReadinessSummary(result));
  for (const finding of result.findings) console.error(`- ${finding.message}`);
  process.exit(1);
}

process.stdout.write(`${releaseReadinessSummary(result)}\n`);
