import { readFileSync } from 'node:fs';
import { launchGate, launchGateSummary } from '../src/launch/handoff.mjs';

const manifestPath = process.env.BIZNORYX_LAUNCH_MANIFEST ?? 'launch/beta-handoff.manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const result = launchGate({
  manifest,
  releaseReadiness: { state: process.env.BIZNORYX_RELEASE_READY === 'true' ? 'ready' : 'blocked' },
  deploymentReadiness: { state: process.env.BIZNORYX_DEPLOYMENT_READY === 'true' ? 'ready' : 'blocked' },
  complianceReadiness: { state: process.env.BIZNORYX_COMPLIANCE_READY === 'true' ? 'ready' : 'blocked' },
  finalApproval: process.env.BIZNORYX_LAUNCH_APPROVED === 'true'
});

if (result.state !== 'ready') {
  console.error(launchGateSummary(result));
  for (const finding of result.findings) console.error(`- [${finding.severity}] ${finding.message}`);
  process.exit(1);
}

process.stdout.write(`${launchGateSummary(result)}\n`);
