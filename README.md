# BIZNORYX

> **Business performance, with a memory.**

BIZNORYX is a production-oriented business intelligence and performance platform designed to turn recurring business data into verified metrics, historical context, evidence-backed reports, and clearer operating decisions.

Instead of treating every spreadsheet, sales report, transaction export, or operational dataset as an isolated analysis, BIZNORYX builds a persistent performance history around the business.

Businesses can upload recurring datasets, validate their source data, preserve evidence, calculate verified metrics, compare periods, identify meaningful movements, and maintain an auditable record of how the business is performing over time.

---

## Table of Contents

- [Overview](#overview)
- [Product Philosophy](#product-philosophy)
- [Core Capabilities](#core-capabilities)
- [Current Product Experience](#current-product-experience)
- [System Architecture](#system-architecture)
- [Data Processing Architecture](#data-processing-architecture)
- [Durable Worker Architecture](#durable-worker-architecture)
- [Evidence Model](#evidence-model)
- [Dashboard](#dashboard)
- [Evidence Reports](#evidence-reports)
- [Authentication and Accounts](#authentication-and-accounts)
- [Organizations and Multi-Tenancy](#organizations-and-multi-tenancy)
- [Business Onboarding](#business-onboarding)
- [Data Ingestion](#data-ingestion)
- [Object Storage](#object-storage)
- [Billing](#billing)
- [Activity and Audit Trail](#activity-and-audit-trail)
- [Security Model](#security-model)
- [Frontend Experience](#frontend-experience)
- [Technology Stack](#technology-stack)
- [Repository Structure](#repository-structure)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment Configuration](#environment-configuration)
- [Database Setup](#database-setup)
- [Running the Application](#running-the-application)
- [Running the Worker](#running-the-worker)
- [Testing](#testing)
- [Production Build](#production-build)
- [Production Deployment](#production-deployment)
- [Northflank Architecture](#northflank-architecture)
- [Deployment Workflow](#deployment-workflow)
- [Data Lifecycle](#data-lifecycle)
- [Supported Data Workflows](#supported-data-workflows)
- [Current Reliability Model](#current-reliability-model)
- [AI and Analytics Philosophy](#ai-and-analytics-philosophy)
- [Known Production Gates](#known-production-gates)
- [Development Workflow](#development-workflow)
- [Git Workflow](#git-workflow)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Security Disclosure](#security-disclosure)
- [License](#license)

---

# Overview

Most businesses already have useful data.

The problem is that the data is usually fragmented across:

- CSV exports
- spreadsheets
- sales systems
- payment platforms
- accounting reports
- inventory systems
- CRM exports
- operational tools
- service reports
- manually prepared monthly reports

The business may know what happened this month, but often lacks a structured system that remembers:

- what happened previously;
- which source produced a number;
- whether the source was verified;
- how the metric was calculated;
- what changed from one period to another;
- whether a trend is improving or declining;
- which evidence supports a conclusion;
- and how the business has evolved over time.

BIZNORYX is designed to solve that problem.

It acts as a **business performance memory layer**.

The platform combines:

1. business context;
2. recurring source data;
3. source validation;
4. durable raw-data storage;
5. verified metric calculation;
6. historical comparisons;
7. evidence-backed findings;
8. management-facing dashboards;
9. evidence reports;
10. and an auditable activity history.

The result is not simply another dashboard.

The goal is to create a system that progressively understands the historical operating picture of a business while keeping measurable facts tied to their source evidence.

---

# Product Philosophy

BIZNORYX follows several core principles.

## 1. Evidence before interpretation

Metrics should originate from real business data.

The platform is designed so that business conclusions can be traced back to the source dataset and the calculation used to derive them.

---

## 2. Business memory instead of one-time analysis

A single report answers:

> What happened?

A business memory system should also answer:

> What happened before?

> What changed?

> Is this movement unusual?

> Is performance improving?

> Which periods support that conclusion?

> Where did the underlying numbers come from?

BIZNORYX therefore treats recurring uploads as part of an evolving business history.

---

## 3. Verified metrics before recommendations

Recommendations should not be generated from arbitrary values or fabricated dashboard data.

The production analytics pipeline is designed around verified metric records derived from uploaded business data.

---

## 4. Historical context matters

A metric alone provides limited insight.

For example:

```text
Revenue = $50,000
```

becomes much more useful when the system knows:

```text
July    $39,200
August  $44,800
September $50,000
```

The historical series gives the metric context.

---

## 5. Source lineage should survive the analysis

BIZNORYX preserves the relationship between:

```text
Source File
   ↓
Raw Data Object
   ↓
Ingestion Run
   ↓
Reporting Period
   ↓
Verified Metric
   ↓
Comparison
   ↓
Finding
   ↓
Evidence Report
```

This is important for trustworthy business reporting.

---

# Core Capabilities

BIZNORYX currently includes the foundations for:

### Business workspaces

Each organization operates inside a tenant-scoped workspace.

---

### Secure user authentication

Users can:

- register;
- verify their email;
- sign in;
- maintain authenticated sessions;
- and securely sign out.

---

### Email verification

New accounts can require verification before workspace access.

Verification delivery is designed to use Resend in production.

---

### Organization onboarding

Businesses can configure:

- business name;
- industry;
- business model;
- reporting currency;
- fiscal-year start;
- timezone;
- and other operating context.

---

### Business data upload

Businesses can upload recurring datasets and associate them with:

- a reporting period;
- a data series;
- and business context.

---

### Durable object storage

Uploaded raw data can be stored in S3-compatible object storage.

The current production deployment is designed to work with Cloudflare R2.

---

### Durable processing jobs

Ingestion work can be queued into PostgreSQL-backed processing jobs.

This separates customer-facing HTTP requests from background data processing.

---

### Production worker

A dedicated worker processes durable jobs independently from the web application.

---

### Storage verification

The worker can retrieve the uploaded source object and verify the stored bytes/checksum before generating metrics.

---

### Verified metrics

Numeric business metrics are derived from uploaded data and persisted for later dashboard and reporting use.

---

### Period-over-period comparisons

Historical periods can be compared automatically after verified metrics become available.

---

### Evidence-backed findings

The analytics pipeline can generate structured findings using verified business metrics and historical comparisons.

---

### Overview dashboard

The Overview provides a concise visual picture of:

- primary business metrics;
- period change;
- evidence report availability;
- source data volume;
- verified trend history;
- business findings;
- business context;
- and data health.

---

### Evidence reports

Evidence reports are designed to expose the source-backed facts behind a business conclusion.

---

### Report export

The evidence-report interface includes export workflows for formats such as:

- PDF;
- HTML/shareable reports;
- CSV comparison data.

---

### Billing foundation

The application includes subscription and checkout boundaries designed for Paystack.

---

### Workspace activity

Important business and workspace actions can be represented in an activity/audit trail.

---

### Responsive workspace

The dashboard is designed for desktop and mobile use.

Desktop users can collapse the navigation sidebar to increase analytics workspace width.

---

# Current Product Experience

The authenticated BIZNORYX workspace contains the following primary sections:

```text
Overview
Data & uploads
Evidence reports
Business profile
Billing
Activity
```

## Overview

The Overview is the high-level business performance surface.

Its purpose is to answer:

```text
What is happening in the business right now?
```

without forcing the user to inspect every uploaded dataset individually.

The current redesigned Overview includes:

- business name and business-level summary;
- primary verified metric;
- period-over-period movement;
- evidence-report count;
- source-row information;
- metric switching;
- verified trend visualization;
- business reading;
- evidence-backed findings;
- business profile context;
- upload health;
- schema-warning visibility.

---

## Data & uploads

This area manages recurring business datasets.

The user can:

```text
Upload source data
        ↓
Choose reporting period
        ↓
Assign data series
        ↓
Validate source
        ↓
Store source object
        ↓
Queue processing
```

The upload history also exposes status information for existing data.

---

## Evidence reports

This area provides deeper source-backed analysis.

Reports are designed around verified metrics rather than arbitrary dashboard values.

---

## Business profile

The business profile establishes the context used to interpret uploaded data.

---

## Billing

The billing workspace displays subscription state and payment-provider integration status.

---

## Activity

The Activity workspace provides a history of significant workspace changes and customer actions.

---

# System Architecture

At a high level, BIZNORYX is divided into three runtime layers:

```text
┌──────────────────────────────────────────────┐
│                 WEB CLIENT                   │
│                                              │
│  Landing Site                               │
│  Authentication                            │
│  Workspace                                 │
│  Overview Dashboard                        │
│  Data Uploads                              │
│  Evidence Reports                          │
│  Billing                                   │
│  Activity                                  │
└──────────────────────┬───────────────────────┘
                       │
                       │ HTTPS / JSON API
                       ▼
┌──────────────────────────────────────────────┐
│             APPLICATION SERVER               │
│                                              │
│  Authentication                            │
│  Session Handling                          │
│  CSRF Protection                           │
│  Organization Authorization                │
│  Onboarding                                │
│  Ingestion API                             │
│  Dashboard API                             │
│  Evidence Report API                       │
│  Billing API                               │
│  Audit Events                              │
└───────────────┬─────────────────┬────────────┘
                │                 │
                │                 │
                ▼                 ▼
┌──────────────────────┐   ┌───────────────────┐
│      PostgreSQL      │   │   Object Storage  │
│                      │   │                   │
│ Organizations        │   │ Raw uploads       │
│ Users                │   │ Original files    │
│ Sessions             │   │ Durable evidence  │
│ Reporting periods    │   │                   │
│ Ingestion runs       │   │ S3 compatible     │
│ Processing jobs      │   │ Cloudflare R2     │
│ Verified metrics     │   └───────────────────┘
│ Comparisons          │
│ Findings             │
│ Audit records        │
└──────────┬───────────┘
           │
           │ Durable job queue
           ▼
┌──────────────────────────────────────────────┐
│              BACKGROUND WORKER               │
│                                              │
│  Lease Processing Job                       │
│  Fetch Raw Object                           │
│  Verify Source Integrity                    │
│  Parse Dataset                              │
│  Derive Metrics                             │
│  Persist Verified Metrics                   │
│  Refresh Comparisons                        │
│  Generate Findings                          │
│  Complete Job                               │
└──────────────────────────────────────────────┘
```

---

# Data Processing Architecture

BIZNORYX intentionally separates data ingestion from data analysis.

A successful upload should not require the web request to perform the entire analytics workflow synchronously.

Instead:

```text
HTTP Upload
    ↓
Validate request
    ↓
Store raw data object
    ↓
Create ingestion run
    ↓
Queue durable processing job
    ↓
Return control to application
```

The worker can then continue processing independently.

This architecture improves:

- reliability;
- recoverability;
- scalability;
- observability;
- and separation of concerns.

---

# Durable Worker Architecture

The production worker is responsible for asynchronous ingestion processing.

The worker entry point is:

```text
scripts/production-worker.mjs
```

The worker is designed to:

1. connect to PostgreSQL;
2. inspect the durable processing queue;
3. lease available work;
4. process one job safely;
5. retrieve the corresponding source object;
6. verify source integrity;
7. derive metrics;
8. persist verified metrics;
9. refresh comparisons;
10. refresh findings;
11. complete the job;
12. continue waiting for additional work.

A healthy worker may remain idle when there is no durable work available.

That is expected behavior.

---

# Evidence Model

The evidence architecture is one of the most important parts of BIZNORYX.

The platform attempts to distinguish between:

### Raw evidence

The original business data uploaded by the customer.

---

### Verified facts

Values calculated directly from the source data.

Examples:

```text
Revenue
Net revenue
Gross profit
Cost
Quantity
Refund amount
```

---

### Historical comparisons

Calculated changes between comparable reporting periods.

Example:

```text
August Revenue: $25,892
September Revenue: $34,042

Change:
+31.5%
```

---

### Findings

Structured observations derived from verified facts and comparisons.

---

### Interpretations

Management-facing explanations based on verified evidence.

The important rule is:

> Interpretation should not replace evidence.

---

# Dashboard

The BIZNORYX Overview dashboard is designed to be concise.

The dashboard should tell a business owner:

```text
Current performance
        +
Historical movement
        +
Important business signals
        +
Evidence health
```

without requiring the user to read a long analytics report.

The current Overview includes:

## Primary metric

The platform selects a useful verified metric and displays its latest value.

Preferred business metrics may include:

```text
net_revenue
revenue
sales
gross_sales
gross_profit
profit
total_amount
amount
quantity
```

depending on what exists in the verified dataset.

---

## Period change

When at least two comparable periods exist, the dashboard calculates the change between them.

---

## Metric trend chart

Verified historical values are plotted visually across reporting periods.

---

## Metric switching

When multiple verified metrics exist, users can switch the active performance metric.

---

## Business reading

The dashboard can surface important findings such as:

```text
Focus
Opportunity
Signal
Risk
```

when such evidence-backed findings exist.

---

## Data health

The Overview summarizes:

```text
Total uploads
Validated uploads
Rejected uploads
Schema warnings
```

---

## Business context

The dashboard retains important profile information such as:

```text
Industry
Business model
Reporting currency
Verified periods
```

---

# Evidence Reports

The evidence-report system provides deeper analysis than the Overview.

The report interface supports:

- source selection;
- metric selection;
- reporting-period selection;
- comparison-period selection;
- optional dimensions;
- metric-definition controls;
- evidence inspection;
- report refresh;
- CSV export;
- PDF export;
- HTML/shareable export.

The report architecture is designed to maintain a clear relationship between:

```text
Displayed statement
        ↓
Verified metric
        ↓
Source dataset
        ↓
Reporting period
```

---

# Authentication and Accounts

BIZNORYX includes an authenticated account system.

The current flow supports:

```text
Register
   ↓
Email verification
   ↓
Authenticated session
   ↓
Organization workspace
```

Authentication boundaries include:

- protected workspace routes;
- authenticated sessions;
- CSRF-protected mutations;
- sign-out;
- email verification;
- organization authorization.

---

# Organizations and Multi-Tenancy

BIZNORYX is designed as a multi-tenant application.

Business data must remain scoped to the organization that owns it.

The application therefore treats organization authorization as a server-side security boundary.

A client-provided organization ID alone must never grant access.

Authorization is enforced before tenant-scoped operations.

The automated test suite includes coverage for organization-switching IDOR attempts.

---

# Business Onboarding

The business profile allows BIZNORYX to interpret performance inside the correct context.

Current onboarding data includes:

```text
Business name
Industry
Business model
Primary reporting currency
Fiscal year start
Timezone
```

This information is persisted separately from individual uploads so future datasets continue to belong to the same business context.

---

# Data Ingestion

The ingestion workflow is designed around recurring business datasets.

A dataset can belong to a named series such as:

```text
Monthly Sales
Transaction History
Primary Performance
Inventory Movement
Service Operations
```

A recurring data series should use reasonably consistent schema and metric definitions across reporting periods.

---

## Reporting periods

Each ingestion is associated with a reporting period.

Examples:

```text
2026-07
2026-08
2026-09
```

Correct reporting periods are essential because historical comparisons depend on them.

---

## Source metadata

The system can maintain metadata such as:

```text
Original filename
Content type
File size
Checksum
Row count
Column count
Reporting period
Data stream
Storage reference
Ingestion status
```

---

# Object Storage

Production ingestion uses S3-compatible object storage.

Cloudflare R2 is the current intended storage provider.

The object-storage layer allows the application to preserve the raw source independently from the PostgreSQL database.

This provides an important separation:

```text
PostgreSQL
    → structured application state

Object Storage
    → original business files
```

The worker can retrieve the original source object before generating verified metrics.

---

# Billing

BIZNORYX includes a subscription billing foundation designed around Paystack.

The current workspace includes:

- subscription state;
- plan information;
- checkout initialization;
- provider configuration state;
- renewal state;
- payment-provider boundary.

The billing UI currently describes the main BIZNORYX monthly plan as:

```text
$20/month
```

This value can evolve as the commercial model changes.

---

# Activity and Audit Trail

Important application actions can create tenant-scoped activity records.

The Activity workspace is intended to provide visibility into events such as:

```text
Business profile changes
Uploads
Evidence imports
Billing events
Member actions
Organization changes
```

Auditability is important because business intelligence should not operate as an opaque system.

---

# Security Model

Security is treated as part of the product architecture rather than a later addition.

Current security principles include:

## Authentication

Workspace access requires an authenticated user.

---

## Email verification

Account ownership can be verified before workspace access.

---

## Session protection

Authenticated sessions are handled server-side.

---

## CSRF protection

Tenant-changing operations require valid CSRF protection.

---

## Tenant isolation

Organization access is validated on the server.

---

## IDOR protection

Organization identifiers supplied by the browser are not treated as authorization by themselves.

---

## Row-level security

The PostgreSQL architecture includes row-level-security foundations for tenant data.

---

## Durable source verification

Stored source objects can be checksum-verified before analytics processing.

---

## Auditability

Important business actions can be preserved as activity records.

---

## Secret isolation

Production secrets must never be committed to Git.

Secrets belong in:

```text
.env.local
development secret manager
production secret groups
deployment-platform secrets
```

Never place real credentials in:

```text
README.md
source code
Git commits
issues
screenshots
frontend JavaScript
```

---

# Frontend Experience

The BIZNORYX frontend uses a lightweight application shell rather than a heavy client framework.

The interface includes:

- public marketing pages;
- registration;
- login;
- email verification;
- onboarding;
- authenticated workspace;
- analytics dashboard;
- uploads;
- reports;
- billing;
- activity.

---

## Collapsible workspace sidebar

Desktop users can collapse the workspace sidebar.

Expanded width:

```text
236px
```

Collapsed width:

```text
76px
```

The collapsed preference is persisted through:

```text
biznoryx.sidebar.collapsed
```

in browser local storage.

When collapsed:

- navigation remains available;
- icons remain visible;
- labels are hidden;
- organization identity remains visible;
- sign-out remains available;
- main content receives additional horizontal space.

The desktop collapse behavior is disabled for the compact mobile navigation layout.

---

## Responsive design

The application contains responsive layouts for:

```text
Large desktop
Standard desktop
Tablet
Mobile
```

The application workspace automatically reorganizes its data visualizations and navigation at smaller viewport widths.

---

# Technology Stack

## Runtime

```text
Node.js
ECMAScript Modules
```

The project targets modern Node.js environments.

The production repository has been developed for Node.js 24+ compatible environments.

---

## Backend

```text
Node.js
HTTP application runtime
PostgreSQL
pg
```

---

## Database

```text
PostgreSQL
SQL migrations
Row-Level Security
Durable processing jobs
```

---

## Frontend

```text
HTML
CSS
Vanilla JavaScript
Lucide icons
```

---

## Object storage

```text
S3-compatible storage
Cloudflare R2
```

---

## Email

```text
Resend
```

---

## Payments

```text
Paystack
```

---

## Deployment

```text
GitHub
Northflank
Managed PostgreSQL
Cloudflare R2
```

---

# Repository Structure

The repository is organized approximately as follows:

```text
biznoryx/
│
├── db/
│   └── migrations/
│       ├── ...
│       └── 0018_durable_processing_worker.sql
│
├── scripts/
│   ├── production-server.mjs
│   ├── production-worker.mjs
│   ├── build-check.mjs
│   └── ...
│
├── src/
│   ├── database/
│   ├── ingestion/
│   ├── reports/
│   ├── webapp/
│   ├── worker/
│   └── ...
│
├── tests/
│   └── ...
│
├── web-app/
│   ├── app.js
│   ├── evidence-report.js
│   ├── styles.css
│   ├── index.html
│   └── ...
│
├── dist/
│   └── generated production build
│
├── package.json
├── package-lock.json
└── README.md
```

---

# Requirements

Before running BIZNORYX locally, install:

```text
Node.js 24+
npm
PostgreSQL
```

For a full production-equivalent environment you will additionally need:

```text
S3-compatible object storage
Email provider credentials
Payment provider credentials
```

---

# Installation

Clone the repository:

```bash
git clone https://github.com/TRAPZZY/biznoryx.git
```

Enter the project:

```bash
cd biznoryx
```

Install dependencies:

```bash
npm ci
```

If you are intentionally changing dependencies during development:

```bash
npm install
```

---

# Environment Configuration

Do not commit production credentials.

Use environment variables or a local environment file excluded by `.gitignore`.

Example:

```bash
DATABASE_URL=
HOST=0.0.0.0
PORT=

BIZNORYX_PUBLIC_URL=

RESEND_API_KEY=
BIZNORYX_EMAIL_FROM=

BIZNORYX_OBJECT_STORAGE_BUCKET=
BIZNORYX_OBJECT_STORAGE_REGION=
BIZNORYX_OBJECT_STORAGE_ENDPOINT=
BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID=
BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY=
BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE=

PAYSTACK_SECRET_KEY=
PAYSTACK_PLAN_CODE=
PAYSTACK_CURRENCY=
```

Some deployment or billing configurations may additionally use a public application URL variable configured by the runtime.

Always confirm the exact required environment variables against the current runtime source before provisioning a new environment.

---

## DATABASE_URL

Required by the durable production application runtime.

Example format:

```text
postgresql://USER:PASSWORD@HOST:PORT/DATABASE
```

Never commit the real value.

---

## HOST

Controls the network interface used by the production server.

Typical container configuration:

```text
0.0.0.0
```

---

## PORT

HTTP port supplied by the deployment platform.

Do not hard-code production ports when the hosting environment supplies them dynamically.

---

## BIZNORYX_PUBLIC_URL

Public application URL used when generating application links and email flows.

---

## RESEND_API_KEY

API credential for transactional email delivery.

---

## BIZNORYX_EMAIL_FROM

Verified sender used for BIZNORYX transactional messages.

Example format:

```text
BIZNORYX <verify@example.com>
```

The sender domain must be verified with the email provider before production use.

---

# Object Storage Environment

## BIZNORYX_OBJECT_STORAGE_BUCKET

Storage bucket containing production source objects.

---

## BIZNORYX_OBJECT_STORAGE_REGION

S3-compatible region.

For Cloudflare R2 this is typically configured according to the R2 S3 endpoint requirements.

---

## BIZNORYX_OBJECT_STORAGE_ENDPOINT

S3-compatible API endpoint.

---

## BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID

Object-storage API access key ID.

---

## BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY

Object-storage secret access key.

Never expose this value.

---

## BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE

Controls S3 path-style addressing behavior.

Use the value required by the configured object-storage provider.

---

# Paystack Environment

## PAYSTACK_SECRET_KEY

Server-side Paystack secret.

Never expose this in frontend JavaScript.

---

## PAYSTACK_PLAN_CODE

Paystack subscription-plan identifier.

---

## PAYSTACK_CURRENCY

Currency used for the configured checkout workflow.

---

# Database Setup

BIZNORYX uses SQL migrations stored under:

```text
db/migrations/
```

Migrations should be applied in numeric order.

Do not run only the latest migration against an empty database unless the migration architecture explicitly supports it.

Production deployments should ensure:

```text
Database created
      ↓
Required extensions available
      ↓
Migrations applied
      ↓
RLS policies applied
      ↓
Runtime service started
      ↓
Worker started
```

---

# Durable Processing Migration

The durable worker architecture includes database structures for concepts such as:

```text
processing_jobs
worker_heartbeats
```

The processing queue allows ingestion work to survive:

- application restarts;
- HTTP request completion;
- worker restarts;
- temporary processing failures.

This is intentionally different from an in-memory task queue.

---

# Running the Application

With production-equivalent environment variables configured:

```bash
npm run app:production
```

The production entry point is:

```text
scripts/production-server.mjs
```

The server requires access to PostgreSQL.

A missing `DATABASE_URL` should cause startup to fail rather than silently running without durable persistence.

---

# Running the Worker

The worker runs separately from the HTTP application.

Start it with:

```bash
node scripts/production-worker.mjs
```

A production deployment should normally run at least:

```text
1 × Application service
1 × Worker service
1 × PostgreSQL database
1 × Object-storage bucket
```

The worker does not require a public HTTP route.

It exists to process durable jobs.

---

# Testing

Run the repository verification suite:

```bash
npm run verify
```

The current verification pipeline includes:

```text
161 tests
153 passing
0 failing
8 skipped
```

These counts will naturally change as the product evolves.

The important release requirement is:

```text
fail 0
```

---

## Security-related automated coverage

The current suite includes coverage around important boundaries such as:

```text
Authenticated dashboard access
Tenant-scoped dashboard state
CSRF requirements
Organization-switching IDOR protection
Organization authorization during slow uploads
Durable worker idle behavior
```

---

# Production Build

Build the production package with:

```bash
npm run build
```

The build script currently uses:

```text
scripts/build-check.mjs
```

Successful output includes:

```text
Application sources and assets packaged in dist.
```

The generated production package is written to:

```text
dist/
```

---

# Release Verification

Before committing or deploying production-facing changes, run:

```bash
node --check web-app/app.js
npm run verify
git status
```

For JavaScript changes, `node --check` should return without a syntax error.

The verification suite must complete with:

```text
fail 0
```

---

# Production Deployment

BIZNORYX is designed to run as multiple cooperating production services.

A typical deployment contains:

```text
GitHub Repository
        │
        ▼
Northflank Project
        │
        ├── BIZNORYX Web Service
        │
        ├── BIZNORYX Worker Service
        │
        └── PostgreSQL Addon
                │
                ▼
        Cloudflare R2
```

---

# Northflank Architecture

The current deployment model uses separate web and worker services.

## Web service

Responsibilities:

```text
HTTP
Authentication
Workspace APIs
Uploads
Dashboard
Reports
Billing
Activity
```

Runtime command:

```bash
npm run app:production
```

---

## Worker service

Responsibilities:

```text
Durable job leasing
Raw source verification
Metric derivation
Historical comparison refresh
Finding generation
```

Runtime command:

```bash
node scripts/production-worker.mjs
```

---

## PostgreSQL addon

Stores durable application state.

The application receives the database connection through:

```text
DATABASE_URL
```

---

## Production secret group

Production credentials should be injected through the hosting platform's secrets system.

Do not place credentials directly in deployment commands.

---

# Deployment Workflow

The intended deployment workflow is:

```text
VS Code
   ↓
Local verification
   ↓
Git commit
   ↓
GitHub main
   ↓
Northflank CI/CD
   ↓
Build
   ↓
Deploy web service
   ↓
Deploy worker
   ↓
Production verification
```

A standard development push may look like:

```bash
git status

git add web-app/app.js web-app/styles.css

git commit -m "Describe the production change"

git push origin main
```

Only stage the files you intend to deploy.

---

# Data Lifecycle

A full BIZNORYX data lifecycle can be represented as:

```text
1. Business account created
        ↓
2. Email verified
        ↓
3. Organization created
        ↓
4. Business profile configured
        ↓
5. Dataset uploaded
        ↓
6. Reporting period assigned
        ↓
7. Raw object stored
        ↓
8. Ingestion record created
        ↓
9. Processing job queued
        ↓
10. Worker leases job
        ↓
11. Source object retrieved
        ↓
12. Source integrity verified
        ↓
13. Dataset parsed
        ↓
14. Numeric business metrics derived
        ↓
15. Verified metrics persisted
        ↓
16. Historical comparisons refreshed
        ↓
17. Findings generated
        ↓
18. Overview updated
        ↓
19. Evidence report becomes available
```

---

# Supported Data Workflows

The product interface is designed around common business dataset categories such as:

```text
Sales performance
Transaction history
Bank statements
Inventory movement
Service operations
General business datasets
```

The frontend intake experience may accept several file types.

However, the verified production metric-processing pipeline should only advertise formats that are fully supported by the active parser.

CSV is currently the primary structured format for deterministic verified metric derivation.

Where spreadsheet parsing is not yet fully connected, XLS/XLSX data should be exported to CSV before relying on verified analytics.

---

# CSV Example

A business sales dataset may include columns such as:

```csv
business_name,date,order_id,customer_id,channel,region,product_category,quantity,unit_price,cost,revenue,refund_amount,net_revenue,gross_profit
```

BIZNORYX can then derive additive metrics such as:

```text
revenue
net_revenue
gross_profit
cost
refund_amount
quantity
```

while excluding inappropriate identifier columns from additive aggregation.

---

# Current Reliability Model

BIZNORYX is being built around production reliability rather than demo-only behavior.

The architecture therefore favors:

```text
Durable PostgreSQL state
Durable processing jobs
Explicit validation
Raw-data preservation
Checksums
Tenant authorization
Independent workers
Release verification
Evidence-backed metrics
Graceful shutdown
```

over:

```text
In-memory fake data
Decorative dashboards
Hard-coded metrics
Client-side-only authorization
Fake analytics
Non-durable job queues
```

---

# AI and Analytics Philosophy

BIZNORYX may eventually include advanced AI-assisted interpretation.

However, the core analytics architecture intentionally does not require a language model to determine factual metric values.

The preferred architecture is:

```text
Business Data
      ↓
Deterministic Processing
      ↓
Verified Metrics
      ↓
Historical Comparisons
      ↓
Evidence-backed Findings
      ↓
Optional AI Interpretation
```

An AI layer should receive verified business facts.

It should not invent those facts.

This distinction is fundamental to BIZNORYX.

---

# Current AI Status

The current core repository is primarily built around deterministic analytics and evidence processing.

Generative AI is not the source of truth for:

```text
Revenue
Profit
Quantity
Cost
Historical change
Source evidence
Reporting periods
```

Future AI capabilities should operate above the verified evidence layer.

---

# Known Production Gates

The project includes release-readiness checks.

A successful source build does not automatically mean every external production dependency is configured.

Production readiness may depend on:

```text
PostgreSQL connectivity
Database migrations
Object storage
Worker availability
Email provider configuration
Domain configuration
Billing provider configuration
Runtime secrets
Health/readiness checks
```

The build system may report that production runtime readiness remains gated until required dependencies are connected.

This is deliberate.

A build success and a production readiness success are different checks.

---

# Operational Health

When reviewing a deployment, verify both the application and worker.

## Web service

Check for:

```text
Process running
PostgreSQL connected
Public HTTP route healthy
No restart loop
```

---

## Worker

Check for:

```text
Worker started
Database connected
Object storage available
No repeated job failures
Idle state when queue is empty
```

An idle worker is not an error when there are no jobs.

---

# Development Workflow

The project should be developed as production vertical slices.

A feature is not considered complete simply because the interface exists.

A production slice should include, where applicable:

```text
UI
API
Authorization
Database
Storage
Worker
Error handling
Testing
Observability
Deployment verification
```

---

# Definition of Done

A change should generally satisfy:

```text
Code implemented
        ↓
Syntax valid
        ↓
Automated tests pass
        ↓
Build succeeds
        ↓
Only intended files changed
        ↓
Commit created
        ↓
GitHub push succeeds
        ↓
Deployment succeeds
        ↓
Live behavior verified
```

---

# Git Workflow

Before staging:

```bash
git status
```

Stage only intended files:

```bash
git add <files>
```

Commit:

```bash
git commit -m "Meaningful production change"
```

Push:

```bash
git push origin main
```

After pushing, confirm that the deployment platform builds the expected commit.

---

# Troubleshooting

## `DATABASE_URL is required`

The production runtime cannot connect to PostgreSQL.

Confirm:

```text
DATABASE_URL exists
Secret group is linked
Database addon is running
Connection URI is available to the service
```

Do not paste the actual database URI into issues or public logs.

---

## Application starts but readiness is gated

Check:

```text
Database
Object storage
Worker
Required production dependencies
```

A running HTTP server does not necessarily mean the full analytics pipeline is ready.

---

## Upload succeeds but no metrics appear

Check:

```text
Was a durable processing job created?
Is the worker running?
Can the worker access PostgreSQL?
Can the worker access object storage?
Can the worker retrieve the raw source?
Did checksum verification pass?
Did metric derivation complete?
```

---

## Worker is idle

This may be correct.

If there are no queued durable jobs, the worker should remain idle rather than manufacture work.

---

## Evidence report contains no meaningful data

Confirm that verified metrics exist for the organization and reporting period.

Evidence reports depend on processed data, not merely the existence of an uploaded file.

---

## Dashboard shows no trend

At least one verified metric period is required for a baseline.

At least two comparable periods are required for a meaningful period-over-period movement.

---

## Wrong historical comparison

Check reporting-period assignments.

An incorrectly assigned month can make technically correct metric calculations appear historically incorrect.

---

## Email verification does not arrive

Check:

```text
RESEND_API_KEY
Verified sender domain
SPF
DKIM
BIZNORYX_EMAIL_FROM
BIZNORYX_PUBLIC_URL
```

---

## Object-storage upload fails

Check:

```text
Bucket
Endpoint
Access key ID
Secret key
Region
Path-style configuration
Storage permissions
```

---

# Production Domains

Production domains should be configured through the deployment platform and DNS provider.

DNS configuration must preserve unrelated records such as:

```text
MX
SPF
DKIM
DMARC
Domain-verification TXT records
```

Do not delete mail or ownership records when changing application routing.

---

# Observability

Production operations should monitor:

```text
Application logs
Worker logs
Deployment status
Restart count
Processing failures
Database connectivity
Storage connectivity
Email delivery
Payment callbacks
Readiness state
```

The system should fail visibly when required durable dependencies are missing.

Silent fallback to fake data is not acceptable.

---

# Privacy

Business datasets can contain commercially sensitive information.

Production deployments should therefore follow strict practices around:

```text
Tenant isolation
Least-privilege credentials
Secret management
Encrypted transport
Restricted database access
Restricted object storage
Audit trails
Retention policy
Deletion policy
Access logging
```

Production customer data should never be used as sample data in public issues or documentation.

---

# Roadmap

BIZNORYX is being developed toward a broader business performance intelligence platform.

Potential future capabilities include:

### Data integrations

Direct integrations with:

```text
Accounting platforms
Payment processors
E-commerce platforms
CRM systems
POS systems
Inventory systems
Business databases
Cloud storage
```

---

### Automated recurring ingestion

Instead of requiring manual upload for every reporting period:

```text
Connected system
      ↓
Scheduled collection
      ↓
Validation
      ↓
Processing
      ↓
Automatic business memory update
```

---

### Advanced business intelligence

Potential future capabilities include:

```text
Anomaly detection
Forecasting
Margin analysis
Customer segmentation
Channel analysis
Product contribution analysis
Cohort analysis
Cash-flow intelligence
Operational efficiency analysis
```

---

### AI-assisted interpretation

Future AI functionality may provide:

```text
Executive summaries
Business questions
Context-aware explanations
Action recommendations
Scenario exploration
Natural-language analytics
```

while remaining grounded in verified BIZNORYX evidence.

---

### Business memory

Long-term, BIZNORYX should increasingly understand:

```text
What this business sells
How it makes money
Which metrics matter
What normal performance looks like
How performance changes
Which channels are important
Which products drive results
Which issues repeatedly occur
Which actions improved performance
```

This persistent understanding is one of the platform's defining goals.

---

# Production Principles

The project should continue following these rules:

```text
No fake analytics.
No decorative metrics presented as facts.
No invented business data.
No client-side authorization assumptions.
No secrets in source control.
No production dependency hidden behind silent fallback.
No prototype-only workflows in production paths.
```

Instead:

```text
Verify.
Persist.
Trace.
Compare.
Explain.
Audit.
```

---

# Security Disclosure

If you discover a security issue in BIZNORYX, do not publish sensitive exploit details, customer information, credentials, or production secrets in a public GitHub issue.

Security reports should be communicated privately to the project maintainers.

Never include:

```text
Database passwords
API keys
Session secrets
Object-storage secrets
Customer files
Authentication tokens
Payment secrets
```

in bug reports.

---

# Contributing

BIZNORYX is currently developed as a controlled production project.

Before contributing:

1. create a dedicated branch;
2. make focused changes;
3. verify authorization boundaries;
4. run the full test suite;
5. run the production build;
6. inspect `git status`;
7. ensure no secrets are included;
8. document significant architecture changes;
9. submit the change for review.

Recommended verification:

```bash
npm run verify
npm run build
```

For frontend JavaScript:

```bash
node --check web-app/app.js
```

---

# Maintainer Notes

Changes affecting any of the following areas should receive additional review:

```text
Authentication
Sessions
CSRF
Organization authorization
RLS
Database migrations
Processing jobs
Object storage
Evidence calculations
Billing
Email verification
Production deployment
```

These components affect security, data integrity, or customer-facing business evidence.

---

# License

BIZNORYX is currently proprietary software unless a separate `LICENSE` file explicitly states otherwise.

All rights reserved.

Unauthorized copying, redistribution, modification, resale, or deployment of the source code may be restricted by the repository owner.

---

# BIZNORYX

**Business performance, with a memory.**

```text
Business Data
      ↓
Verified Evidence
      ↓
Historical Context
      ↓
Clearer Decisions
```