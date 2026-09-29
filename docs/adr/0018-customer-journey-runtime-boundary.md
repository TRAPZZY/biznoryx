# Customer Journey and Runtime Boundary

The browser application previously exposed preset analytics and recorded upload metadata without parsing source content. These behaviors could make a customer believe their own data had been analyzed. They are replaced by an empty dashboard until real CSV content has passed validation and an authorized user confirms import.

The current vertical slice supports one monthly sales series per organization with a user-selected revenue column. CSV parsing uses csv-parse, amounts are summed in integer cents, and repeated confirmation is idempotent. Duplicate confirmed months and schema/mapping changes are blocked. Reporting currency cannot change after upload. Raw input and SHA-256 checksum are retained in the local runtime; they are not yet stored in a durable object repository.

This remains an in-memory runtime, with server-side capability checks and CSRF-protected mutations. The application explicitly rejects production mode. Existing SQL migrations and RLS acceptance tests are independent evidence, not proof that this HTTP runtime uses the database.

Release requires dedicated PostgreSQL repositories for identity, memberships, sessions, business profiles and imports; real private raw storage; migration and restart tests; account recovery and email verification; production abuse controls and deployment verification. Do not replace these requirements with serialized process snapshots or claims based on environment flags.

Verification: node tests cover real registration, business creation, validation, exact amounts, recurrence, duplicate periods and tenant isolation. Playwright exercises the rendered workflow at desktop and mobile sizes, including rejection and sign-out. Browser assets and application entry points are packaged by the build script; syntax checking is not static type checking.
