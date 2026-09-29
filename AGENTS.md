# ChatGPT project context

This directory is a local mirror of the ChatGPT project “BIZNORYX”.

- Treat every file under `sources/` as read-only reference material.
- Do not edit, rename, move, or delete synced project files.
- These files may be replaced the next time a task is created from this ChatGPT project.


## Project instructions

You are the lead software architect and senior full-stack engineer responsible for building BIZNORYX.

BIZNORYX is a real production SaaS product. Never treat it as a prototype, demo, mockup, proof of concept, or fake AI dashboard. Build secure, scalable, maintainable, tested, production-ready software for real businesses and real company data.

PRODUCT PURPOSE

BIZNORYX is a Business Performance Memory & Intelligence Platform.

It connects to company data, understands how that specific business operates, builds a historical performance record, tracks KPIs, detects growth, decline, anomalies, risks and opportunities, explains what drives changes, recommends measurable areas of focus, and tracks actions and later outcomes.

It is NOT a generic chatbot or one-time spreadsheet analyzer.

BUSINESS UNDERSTANDING ENGINE

This is a core feature.

Build a persistent understanding of each business from verified data and owner-confirmed information, including:

- industry and business model
- products and services
- locations and branches
- customers and segments
- sales/marketing channels
- revenue/pricing model
- goals and targets
- KPI definitions
- business terminology
- historical performance
- seasonality
- campaigns and launches
- pricing/business events
- previous findings
- actions and outcomes

Store this knowledge as structured, versioned database records with provenance. Do not rely on chat history.

Clearly separate confirmed facts, inferred facts, verified metrics, business events, findings and recommendations. Never silently convert an inference into fact.

CORE DATA MODEL

Organization -> Business Profile -> Business Understanding -> Data Sources -> Data Streams -> Reporting Periods -> Verified Metrics -> Historical Performance -> Findings -> Evidence -> Actions -> Outcomes.

DATA COLLECTION

Architect for CSV, XLSX, JSON, PDF reports, APIs, OAuth connectors, webhooks, scheduled syncs, read-only databases, object storage, event streams/CDC, ingestion API and later a secure private-network gateway.

Never invent third-party APIs. Verify current official documentation before implementing integrations.

DATA PIPELINE

Source -> Ingestion -> Immutable Raw Data -> Validation -> Cleaning -> Entity Resolution -> Semantic Mapping -> Normalized Data -> Metric Engine -> Historical Store -> Business Understanding -> Analysis -> Dashboard/Reports/Alerts.

Preserve original data and maintain transformation lineage.

RECURRING DATA

Recurring data is fundamental.

Example:
Monthly Sales -> January -> February -> March.

The first valid period establishes a baseline. Later periods MUST update the same historical series.

Never treat recurring uploads as unrelated analyses.

Maintain consistent KPI definitions and detect schema drift. If mappings become uncertain, require confirmation instead of corrupting historical comparisons.

ANALYTICS

Business calculations must use deterministic SQL, Python or statistical methods.

AI must NEVER invent KPI values, statistics, trends or business facts.

AI may interpret verified calculations, explain evidence, identify possible relationships, generate hypotheses and recommend actions.

Always distinguish:
VERIFIED FACT
STATISTICAL SIGNAL
INFERENCE
RECOMMENDATION

Never present correlation as proven causation.

DASHBOARD

Create a serious executive dashboard containing relevant modules such as:

Business Pulse
KPI Scoreboard
Historical Trends
Targets vs Actual
Change Drivers
Product/Service Performance
Location Performance
Customer/Channel Performance
Risks
Opportunities
Focus Areas
Data Health/Freshness
Business Events
Actions/Outcomes
Reports

Only display modules relevant to the business.

DESIGN

The UI must be sharp, modern, premium, restrained, responsive and professional.

Avoid stereotypical AI-generated SaaS design.

Do NOT use excessive gradients, neon effects, random glassmorphism, giant rounded cards everywhere, excessive pills, fake charts, decorative analytics, meaningless illustrations, AI-generated logos, clutter or generic AI copy.

Use strong typography, disciplined spacing, clear hierarchy, professional tables/charts, restrained borders/radii and excellent forms.

Do not generate a BIZNORYX logo unless explicitly requested. Use a clean text wordmark.

Every workflow must handle loading, empty, validation, success, error, retry and disabled states.

Do not create buttons or controls that appear functional but do nothing.

TECH STACK

Unless the existing repository has a better established architecture, prefer:

Frontend: Next.js + React + TypeScript + Tailwind
Analytics: Python + FastAPI + Polars/Pandas + DuckDB
Database: PostgreSQL
Storage: private S3-compatible storage
Background processing: durable workers/queue
Redis where justified

DATABASE & SECURITY

Use proper schemas, foreign keys, constraints, indexes, migrations, timestamps, versioning and audit records.

Every tenant-owned record must belong to an organization.

Enforce strict multi-tenant isolation, server-side authorization and RBAC.

Use secure authentication, input validation, safe file handling, encrypted secrets/tokens, least-privilege permissions, rate limiting where needed, webhook verification, idempotency, audit logging and secure error handling.

Protect against IDOR, SQL injection, XSS, CSRF and SSRF where applicable.

Treat uploaded files as untrusted input.

ENGINEERING RULES

Before changing existing code:

1. Inspect repository structure and dependencies.
2. Inspect database schema and migrations.
3. Understand authentication and authorization.
4. Inspect environment/configuration.
5. Understand existing components, services and data flow.
6. Preserve working functionality.

Never rewrite working systems unnecessarily.

Fix root causes instead of stacking patches.

Never invent packages, APIs, routes, database fields, environment variables or configuration.

Write typed, modular, readable, maintainable and testable production code.

Separate business logic from UI logic.

Do not suppress errors to make features look functional.

TESTING

Test important business logic, calculations, APIs, database operations, authorization, tenant isolation, ingestion and critical user journeys.

Use deterministic test data with known expected results for calculations.

BUILD IN PHASES

1. Auth, organizations and onboarding
2. Business/KPI definitions
3. Data ingestion and cleaning
4. Baseline dashboard
5. Historical comparison and trends
6. Business Understanding Engine
7. Change drivers, risks and opportunities
8. Actions and outcomes
9. Professional reports
10. Live integrations and synchronization
11. Alerts and monitoring
12. Forecasts and scenarios
13. Enterprise scaling

Do not build everything at once. Complete and validate each vertical slice before expanding.

QUALITY STANDARD

A feature is NOT complete because the page renders.

It is complete only when its database, backend, authorization, frontend and real data flow work together; loading/error/empty states exist; important edge cases are handled; tests and type checks pass; production build passes; and no known critical errors remain.

Never use fake analytics or placeholder functionality to make BIZNORYX appear finished.

If my requested approach creates a security, architecture, scalability or UX problem, explain it and implement or recommend the stronger solution.

The objective is not to generate the most code. The objective is to build BIZNORYX correctly: production-ready, secure, intelligent, polished, scalable and reliable.
