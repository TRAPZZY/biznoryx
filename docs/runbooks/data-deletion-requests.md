# Support-Assisted Data Deletion Requests

## Published Behavior

`/delete-data`, `/delete-data/` and `/delete-data.html` serve the same public HTML
resource. Overview, website footers, Privacy Policy, account deletion and Help
link to it. It directs users to the existing public 3CX support channel to request
removal of selected business information without closing their account.

Opening the page is read-only. It does not submit a request, purge a dataset,
cancel billing, or change the signed-in account. No automated data-only purge API
is introduced. No database migration, provider or environment variable is added.

## Operator Requirements

On 12 October 2026, the service owner confirmed that support is operational for
verifying and fulfilling data-only deletion requests. This is an owner-supplied
operational confirmation, not an automated end-to-end deletion test. The owner
will provide completion and backup/log retention timelines; those remain
unconfirmed and must not be replaced with assumed values in the public notice.

Publishing the resource does not establish that deletion operations are staffed,
that a message has reached an agent, or that a request has been completed. Before
representing the support-assisted process as operational, the service owner must
confirm all of the following:

1. Support can receive requests from signed-out users, including when live agents
   are unavailable. Record receipt and provide a follow-up reference.
2. Verify identity through an existing trusted account-verification channel and
   confirm authority over the specific organization and records. Never accept a
   workspace name, an email address, or a chat message alone as authorization.
3. Confirm selected-data scope separately from account closure. Members may ask
   about their personal data; workspace-wide removal requires the appropriate
   business authority and review of other members' interests.
4. Inventory original uploads, raw object versions, manual entries, drafts,
   processing jobs, normalized records, metrics, comparisons, findings, evidence,
   reports and downstream copies within the requested scope. Do not assume that
   removing a file removes its reports, or that a storage delete marker purges
   prior object versions. Never issue broad tenant deletes or disable foreign
   keys to force a selective request through.
5. Establish and validate a scoped deletion procedure in a non-production
   environment. Stop affected ingestion/processing before removal and assess
   which remaining series need recalculation. The current production runtime
   has no verified automated selected-dataset cleanup procedure; escalate to the
   responsible engineer rather than improvising SQL against customer data.
6. Identify any specific billing, legal or security exception. Record its reason
   and duration without storing redundant copies of the requested dataset.
7. Confirm active-storage completion targets, backup/object-version expiry,
   infrastructure log retention, 3CX and Resend retention, and any required
   provider-side removal. Obtain these facts from real deployment settings and
   agreements, not assumed defaults. Update the public retention disclosures
   once verified. Do not invent a fixed deadline while these facts are unknown.
8. Confirm completion to the requester, identifying removed information, retained
   information and reasons, outstanding backup/provider steps and expiry dates.
   Acknowledgement and completion are distinct. Verify the account, membership,
   unrelated business data and subscription state remain unchanged for a
   data-only request. Observe required removal when restoring backups.

Until these operational requirements are verified, a public page and successful
browser tests are not evidence of deletion fulfillment or review readiness.

## Verification Scope

`node --test tests/public-privacy.test.mjs` checks the production HTTP resource,
its local links, HEAD behavior, unsupported write methods and accurate wording.
Browser tests check signed-out desktop/phone access and signed-in owner/viewer
navigation, continued sessions, local-only resource loading and no write requests.
These checks deliberately do not send live support messages or delete real data.

Reference: [Google's deletion resource requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
