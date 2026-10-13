# Production PDF ingestion

PDF uploads use the same authenticated ingestion API, server-selected organization, stream/schema registration and durable processing jobs as CSV uploads. No new database migration is required for this patch. The remediation branch still inherits the separate backend migrations required by the native/deletion implementation.

## Supported documents

- A text-based PDF of at most 8 MiB, 50 pages, 10,000 data rows and 32 columns.
- One ruled table per page, or explicit CSV/tab-separated text. Every page must begin with the same unique column header and contain data rows.
- At least one explicit measure column: revenue, sales, amount, cost, expense, expenses, profit, quantity, units, debit or credit.
- Numeric measure cells must be plain decimals, optionally signed, with at most four fractional digits. No currency symbols or thousands separators are interpreted.
- Date columns must use valid YYYY-MM-DD dates. Source values and signs are preserved; no date interpretation, netting or currency conversion occurs.

Scanned/image-only pages, encrypted/password-protected PDFs, forms, ambiguous/wrapped cells, missing values, schema changes, multiple tables per page, totals/balance summaries and text outside ruled tables are rejected. OCR is not provided. Export the original transaction table as CSV for unsupported documents; rejection must not be described as a successfully analyzed upload.

## Evidence and processing

The original PDF bytes are stored privately under the organization-bound, SHA-256 content address. Registration checksums use those same binary bytes, not base64 or extracted text. Existing tenant authorization, duplicate detection, recurring-series and schema-drift checks remain in force.

The ingestion process validates the table before accepting it. The worker verifies the stored original byte size/checksum before extracting it again and running the existing decimal-exact metric engine. Metric evidence records the PDF parser version, original checksum, extracted table checksum, physical page-to-data-row ranges and the explicit transformation. Repeated page headers do not become financial rows.

Extraction runs in a separate Node process with a 256 MiB JavaScript heap limit, 30-second timeout, bounded input/output and at most two concurrent parsers per application process. Parser subprocesses do not inherit provider credentials or other application environment variables. PDF JavaScript evaluation, XFA and worker resource fetching are disabled. This is resource isolation, not an operating-system security sandbox; native allocations still require infrastructure memory limits. Extraction needs no URL or filesystem path supplied by an upload.

The existing worker makes processing failures visible and retryable. Unreferenced content-addressed objects after database registration failures remain subject to the existing reconciliation policy, rather than risky request-time deletion of shared evidence.

## Verification

Run the PDF unit/service/worker tests and the production HTTP contract tests. `tests/postgres-pdf-ingestion.test.mjs` additionally needs an isolated PostgreSQL database. The local entry/trial acceptance runner creates and destroys its own database and runs this test with the existing migration/grant sequence. Do not point it at production.
