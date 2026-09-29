# Phase 17 Launch Handoff and Beta Operations Runbook

## Purpose

This runbook defines the accountable launch handoff process for a private BIZNORYX beta.

## Required Gates

Run all gates before admitting beta customers:

```bash
npm run verify
npm run db:acceptance
npm run release:check
BIZNORYX_RELEASE_READY=true BIZNORYX_DB_ACCEPTANCE_READY=true npm run deploy:check
BIZNORYX_RELEASE_READY=true BIZNORYX_DEPLOYMENT_READY=true BIZNORYX_COMPLIANCE_EVIDENCE_REVIEWED=true npm run compliance:check
BIZNORYX_RELEASE_READY=true BIZNORYX_DEPLOYMENT_READY=true BIZNORYX_COMPLIANCE_READY=true BIZNORYX_LAUNCH_APPROVED=true npm run launch:check
```

## Beta Scope

The default beta is limited to friendly design partners and internal pilots. Do not admit regulated health data, payment card numbers, or government identifiers.

## Customer Handoff

- confirm organization owner identity
- explain data handling limits
- load only approved sample or customer-authorized data
- confirm support owner and escalation path
- document known limitations before first use
- define success criteria before importing recurring data

## Go/No-Go

Launch is blocked unless release, deployment, compliance, and accountable final approval are ready.

## Known Limitations

Provider-specific infrastructure and external compliance certification are outside this repository. They must be completed separately before a public launch claim.
