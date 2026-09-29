# ADR 0020: Customer Evidence Reporting Surface

## Status

Accepted for local review. Public production still requires the durable HTTP, storage, worker, provider deployment, and compliance gates described in `BUILD_STATUS.md`.

## Context

The visible customer application previously centered the upload workflow around a `revenue` column. That was useful for proving no fabricated dashboard values were shown, but it did not match the BIZNORYX product vision: businesses must be able to add different recurring data series such as transactions, inventory, support tickets, sales, costs, or operating records.

The public landing page also did not explain the product deeply enough. It needed to make the promise of business memory, evidence, and recurring decision support clear, while the authenticated workspace needed to prove that promise with source-backed reports.

## Decision

Make the review application data workflow generic at the customer-facing boundary:

- uploads belong to a named `dataSeries`;
- users can supply a `dataKind`;
- users may provide a metric column, or the validator can infer a likely numeric metric column;
- recurring-period schema and metric drift checks are enforced within the same named series;
- separate datasets can be represented as separate series instead of being forced into one sales stream.

Generate an evidence report for every confirmed upload. A report includes verified facts, period-comparison facts, contribution facts, and source evidence derived from the uploaded rows, checksum, columns, selected metric, dimension breakdowns, and prior confirmed periods in the same series. Recommendation language is not presented as evidence.

Expand the public header into real routes for Product, Solutions, Pricing, Security, and Resources. Keep those pages connected to the product behavior implemented in the workspace.

Extend the local review application with production-shaped customer flows that matter before public review:

- one-time email-code verification before a newly registered user can enter the workspace;
- up to 10 CSV files per validation batch with a 25 MB per-file limit;
- truthful activity that hides seed/runtime noise and shows customer-relevant workspace changes;
- a `$20/month` subscription surface with Paystack-ready checkout and local review completion for non-production testing;
- a line-chart dashboard backed only by confirmed uploads.

## Consequences

The local review app now demonstrates BIZNORYX as a business-data memory product rather than a sales-only dashboard. Browser and API tests cover email verification, local review billing, multi-file uploads, generic transaction files, evidence report generation, public header routes, workspace report navigation, and recurring-series safety.

The implementation still uses the guarded in-memory HTTP runtime. The durable PostgreSQL schema already contains report, finding, metric, ingestion, and evidence-oriented tables, but the customer HTTP routes still need durable repositories, billing persistence, managed email delivery, Paystack production webhook verification, and private object storage before production launch.
