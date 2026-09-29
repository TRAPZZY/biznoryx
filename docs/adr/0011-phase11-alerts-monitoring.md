# ADR 0011: Phase 11 Alerts and Monitoring

## Status

Accepted

## Context

BIZNORYX needs operational monitoring that turns verified system conditions into actionable alerts without inventing signals or depending on external notification providers too early.

Phase 11 builds on data health, integration synchronization, and performance findings.

## Decision

Phase 11 introduces:

- alert rules
- alert events
- alert notifications
- deterministic rule evaluation for sync failures, data health attention, and high-severity findings
- alert acknowledgment and resolution lifecycle
- dashboard visibility for unresolved alerts

Alert evaluation reads existing tenant records. Notification records track intended delivery state but do not send external emails, SMS, or Slack messages until provider integrations are explicitly implemented.

Alert mutations require `business.write`. Reads require `business.read`. Alert tables are tenant-owned and protected by RLS with `WITH CHECK`.

## Consequences

Phase 12 can build forecasts and scenarios using the monitored business record while keeping alerts as a separate operational control surface.
