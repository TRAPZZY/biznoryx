# Evidence report feature plan

Research date: 2026-10-06.

This file preserves the user's requested planning memory and implementation scope. The user subsequently authorized implementing Features 1 and 2 and pushing a feature branch. Deployment and merge are separate actions. Synced files under sources/ remain unchanged.

## Feature 1: Revenue change breakdown

Status: implemented on the evidence-report feature branch. Requires migration 0030 before the updated production runtime starts.

Explain a revenue difference through price, sales volume, and product mix, extending the existing category-contribution report rather than duplicating it.

Requirements:

- Use verified, comparable revenue, product identity, and quantity data with owner-confirmed mappings and consistent currency/unit definitions.
- Show the absolute monetary effects and a compact bridge from the previous total to the current total. Explain price, volume, and mix in everyday language.
- Use a documented deterministic decomposition; the effects must reconcile exactly to the measured revenue difference.
- Handle new/discontinued products, zero quantities, returns, discounts, rounding, and incomparable units explicitly. Keep any unsupported residual visible; never force it into an invented effect.
- Each amount must link to its source and calculation evidence. Missing fields mean insufficient evidence, not guessed contributions.
- This is an accounting decomposition, not proof of why customers changed their behavior.

## Feature 2: Guided plain-English report explainer

Status: user approved implementation; implemented as seven deterministic guided questions inside the evidence report, with evidence links and HTML/PDF/CSV exports. No external model or new API key is required.

Let a non-specialist select a finding and follow suggested questions about that exact report:

- What does this mean in everyday language?
- How much money or activity changed?
- Which part of the business contributed most?
- Is this good, bad, or not yet clear under our confirmed metric definition?
- What information is missing, and what should we check next?

Answers should be short, initially showing the verified fact, its business meaning, and one next investigation. Expand for definitions, a simple visual, calculation details, and evidence. Translate business terms using owner-approved definitions. Explain percentages using actual before/after values, not percentages alone.

Illustrative wording, not customer data: sales moved from NGN 500,000 to NGN 400,000, meaning NGN 100,000 less was recorded. Online sales contributed most of that decline. This does not establish whether demand, stock availability, or something else caused it.

Existing foundation: the report already has executive summaries, contribution charts, investigation priorities, evidence buttons, and limitations. The addition is contextual follow-up and simpler explanations, not another generic summary or standalone chatbot.

Implementation guardrails:

- Start with a small deterministic set of guided questions bound to the current verified report snapshot. Free-text questions are a later extension, not a prerequisite.
- Calculations remain server-side and deterministic. Optional AI may rephrase verified results but cannot invent numbers, definitions, business facts, forecasts, or causes.
- Every quantitative answer must identify its metric, period, filters, and supporting evidence. Preserve distinctions between facts, signals, inferences, and recommendations.
- Recheck tenant authorization on every answer and evidence request; do not expose raw rows or send sensitive company data to an external model without an approved boundary.
- Unsupported questions should explain what data is missing. Do not automatically treat incomplete periods as comparable.
- Validate understanding with representative nontechnical readers: can they identify the change, its measured contributor, and the next check without help?

## Feature 3: Confirmed business-event timeline

Status: supporting proposal, not approved for implementation.

Place owner-confirmed events such as promotions, closures, price changes, and product launches beside the historical report. Show the event date, who confirmed it, and comparable before/after measurements. Keep the phrasing neutral: a change occurred after an event, not necessarily because of it.

Reuse structured, versioned business-event records if the existing backend provides them. Do not derive confirmed events from AI guesses or chat history. Avoid adding arbitrary annotations that silently become trusted business facts.

Value: connects charts to recognizable business activity, while preserving the boundary between context and causal evidence.

## Feature 4: Next-report action review

Status: supporting proposal, not approved for implementation.

Surface existing actions/outcomes inside the next evidence report: the prior finding, agreed action and owner, baseline, target, follow-up date, and actual verified result. Show met/not met/not yet measurable rather than claiming that an action caused the result.

Reuse the existing actions/outcomes foundation. Require comparable KPI definitions and sufficient post-action data; account for concurrent events and changed source coverage. This is a report integration, not a new task-management platform.

Value: shows the reader what was done and what changed afterward, making recurring reporting useful beyond one-time explanation.

## Competitor comparison

- [Tableau Pulse Q&A](https://help.tableau.com/current/online/en-us/pulse_ask_discover_qa.htm): suggested questions for single metrics; conversational exploration of groups of metrics with supporting citations. Useful precedent for guided discovery without assuming users know what to ask.
- [Databox Genie](https://help.databox.com/get-started-with-genie-the-databox-ai-assistant): plain-language questions, dataset context, and follow-up questions. Databox explicitly advises verifying important AI-generated numbers. BIZNORYX should keep its existing deterministic metric boundary.
- [ThoughtSpot Spotter](https://docs.thoughtspot.com/cloud/26.9.0.cl/spotter-business): contextual follow-ups and business-term interpretation. Useful precedent for owner-confirmed vocabulary and disambiguation.
- [Power BI smart narratives](https://learn.microsoft.com/en-us/power-bi/visuals/power-bi-visualization-smart-narrative): audience-specific summaries and dynamic values. BIZNORYX already has narrative reporting, so summaries alone are not a substantial new feature.
- [Databox chart annotations](https://help.databox.com/annotate-your-charts): time-linked notes about campaigns, launches, and other events. Supports the event-timeline proposal, not a claim that annotations establish causation.
- [Databox goals](https://help.databox.com/create-a-goal): targets, success criteria, and ownership. Supports measurable follow-up; it does not establish action effectiveness or causal attribution.

Features 3 and 4 remain optional later report integrations and are not included in this implementation. Competitor capabilities establish precedents, not evidence that BIZNORYX will outperform them. Nontechnical-reader usability testing remains a separate validation step; automated tests and screenshots cannot prove layman comprehension.

## Implementation notes

- Approve the revenue/product/quantity mapping in Metric definition. Approval records the reporting currency, shared quantity unit and definition version. No semantic guesses are silently approved.
- The breakdown uses the same accepted, nonduplicate, nonoverlapping source aggregates and selected date field as the report. Every revenue record needs a valid nonnegative quantity and stable product identifier. Complete observed month boundaries are required; business-wide completeness is not inferred.
- Refunds/negative adjustments, revenue without units, missing mappings or quantities, incomplete dates, and legacy aggregates without product detail produce an explicit unavailable state while the ordinary report remains usable.
- First/no recorded sales are not described as new/discontinued products. Realized price includes discounts and is not necessarily a list price.
- Matched-product price effect: sum(current revenue - prior revenue * current quantity / prior quantity). Volume effect: change in total matched-product quantities * prior matched-product average realized price. Mix effect: remaining matched-product revenue movement. First/no recorded sales are separate effects.
- Exact rational arithmetic is rounded to ten decimal places, with any residual retained. Displayed currency amounts are rounded to two decimal places.
- Question answers are generated from the authenticated report snapshot and change with source, metric, date, period and comparison. No raw rows leave the existing report boundary.
- CSV preserves its original eleven columns and adds Explanation and Evidence columns, plus revenue-effect, product and guided-answer rows.
- Coverage validation now checks every observed month, including middle months, and evaluates merged disjoint extracts using their combined boundary dates.
- An opposing leading category does not inherit the total's favorable/adverse agenda label. PDF exports keep full decision rules and avoid footer-created blank pages.

See [the rollout runbook](runbooks/evidence-report-enhancements.md) for migration and rollback ordering.
