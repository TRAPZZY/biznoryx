import { readFileSync } from 'node:fs';
import { complianceGate, complianceGateSummary } from '../src/compliance/controls.mjs';

const manifestPath = process.env.BIZNORYX_COMPLIANCE_MANIFEST ?? 'compliance/security-controls.manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const result = complianceGate({
  manifest,
  releaseReadiness: { state: process.env.BIZNORYX_RELEASE_READY === 'true' ? 'ready' : 'blocked' },
  deploymentReadiness: { state: process.env.BIZNORYX_DEPLOYMENT_READY === 'true' ? 'ready' : 'blocked' },
  evidenceReviewed: process.env.BIZNORYX_COMPLIANCE_EVIDENCE_REVIEWED === 'true'
});

if (result.state !== 'ready') {
  console.error(complianceGateSummary(result));
  for (const finding of result.findings) console.error(`- [${finding.severity}] ${finding.message}`);
  process.exit(1);
}

process.stdout.write(`${complianceGateSummary(result)}\n`);
