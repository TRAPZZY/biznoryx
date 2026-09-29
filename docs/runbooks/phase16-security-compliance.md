# Phase 16 Security and Compliance Runbook

## Purpose

This runbook defines the final security and compliance readiness gate for BIZNORYX production launch.

## Required Gates

Run all gates before public launch:

```bash
npm run verify
npm run db:acceptance
npm run release:check
BIZNORYX_RELEASE_READY=true BIZNORYX_DB_ACCEPTANCE_READY=true npm run deploy:check
BIZNORYX_RELEASE_READY=true BIZNORYX_DEPLOYMENT_READY=true BIZNORYX_COMPLIANCE_EVIDENCE_REVIEWED=true npm run compliance:check
```

## Evidence Review

An accountable owner must review:

- tenant isolation and RLS acceptance evidence
- authentication and session security evidence
- capability-based authorization tests
- audit logging coverage
- managed secret and storage requirements
- backup and rollback controls
- incident response ownership
- data retention and encryption classes

## Incident Response

For suspected security incidents:

1. Preserve audit logs and deployment records.
2. Revoke affected sessions and secrets.
3. Pause affected integrations and workers.
4. Confirm tenant isolation with database acceptance checks.
5. Notify accountable owners.
6. Document impact, root cause, corrective actions, and evidence.

## Compliance Boundary

This phase provides SOC 2 and ISO 27001 readiness evidence. It does not claim certification. Certification requires an external audit and formal organizational controls outside this repository.
