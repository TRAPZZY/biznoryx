import { readFileSync } from 'node:fs';
import { deploymentDecisionSummary, deploymentHealth } from '../src/ops/deployment.mjs';

const manifestPath = process.env.BIZNORYX_DEPLOY_MANIFEST ?? 'deploy/production.manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const result = deploymentHealth({
  manifest,
  releaseReadiness: { state: process.env.BIZNORYX_RELEASE_READY === 'true' ? 'ready' : 'blocked' },
  databaseAcceptance: { state: process.env.BIZNORYX_DB_ACCEPTANCE_READY === 'true' ? 'ready' : 'blocked' },
  activeIncidents: Number(process.env.BIZNORYX_ACTIVE_INCIDENTS ?? 0)
});

if (result.state !== 'ready') {
  console.error(deploymentDecisionSummary(result));
  for (const finding of result.findings) console.error(`- [${finding.severity}] ${finding.message}`);
  process.exit(1);
}

process.stdout.write(`${deploymentDecisionSummary(result)}\n`);
