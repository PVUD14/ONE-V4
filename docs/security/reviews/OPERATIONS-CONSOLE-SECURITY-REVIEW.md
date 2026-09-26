# Operations Console Security Review — M1 slice

> The go-live security review of the Operations console that OPS-17 requires (Appendix 1, OPS-17
> item 3). It covers only what Wave 1 built for the console, threat by threat, and states for each
> control where it lives in code and which test proves it. Controls without a test, and defects
> found while reading, are listed as open findings. It exists so that the console's security
> claims can be checked against code rather than against the design notes.

- **Review target:** base commit `6864332` on `docs/wave1-sops-uat-security` (the program base).
- **Date:** 2026-09-26.
- **Method:** code reading only. Every claim cites `path:line` relative to the repository root and
  the test that exercises it (`spec file › test name`, found by grep). The design notes in
  `docs/architecture/` and `docs/ops/OPS_PROGRESS.md` were read for intent and checked against the
  code; where they disagree, the code is what is reported. No test was run for this review.
- **Scope (milestone M1 slice):** OPS-01 internal capabilities, OPS-02 dual control, OPS-03 Overview,
  OPS-04 jobs console, OPS-05 support desk and account lookup, OPS-06 privacy console, OPS-07
  staff-pool readiness, the EMP-04 employer access request queue (including the public
  `POST /api/v1/employer-access-requests`), the organisation verification and suspension route, and
  the web screens that show these surfaces.
- **Out of scope:** OPS-08 to OPS-11 (catalogue, content, external reviewers, role demand — M2),
  OPS-12 to OPS-16 (AI console, college health, access reviews, incidents and communications —
  M3/M4), audit search (`operations-audit.controller.ts`) and Trust & Safety beyond the capability
  retrofit, institution-side routes in `operations-institution-onboarding.controller.ts`, and the
  Android app (it has no operator screens; it only reads `/security/context`). The full OPS-17
  review at M3 extends this document to those goals.

## 1. Conclusion

The core controls are sound and mostly tested. Capability checks are server-side pure functions.
The database repeats the grant rules and the dual-control rules, so a second writer cannot skip
them. Approvals are bound to a payload hash, expire on the database clock and are consumed in the
action's own transaction. Support contacts are masked, and reveals are audited in the same
transaction as the read. Counts of fewer than 5 people are suppressed on the server. No numeric
readiness appears anywhere on these surfaces.

This review leaves **26 open findings: 2 High, 6 Medium and 18 Low.** The two High findings are:

- a migration replay that will stop every future `db:migrate` after the first completed privacy
  deletion (OPS-SR-01);
- the in-app assistant's synchronous call to an external model from a request handler (OPS-SR-02).

Neither of them is in the console code itself. The most important finding in the console is that
`audit_events` has no append-only guard in the database (OPS-SR-03).

## 2. Files reviewed

API:

- `apps/api/src/http/internal-capability-guard.ts`
- `apps/api/src/http/operations-staff.controller.ts`
- `apps/api/src/http/operation-approval-gate.ts`
- `apps/api/src/http/operations-approvals.controller.ts`
- `apps/api/src/http/operations-overview.controller.ts`
- `apps/api/src/http/operations-jobs.controller.ts`
- `apps/api/src/http/operations-outbox.controller.ts`
- `apps/api/src/http/operations-support.controller.ts`
- `apps/api/src/http/operations-privacy.controller.ts`
- `apps/api/src/http/privacy-deletion.ts`
- `apps/api/src/http/platform-controls.controller.ts` (flag gate and institution grants only)
- `apps/api/src/http/employer-access-requests.controller.ts`
- `apps/api/src/http/operations-institution-onboarding.controller.ts` (operations routes only)
- `apps/api/src/http/api-security.ts`
- `apps/api/src/config.ts`
- `apps/api/src/runtime-auth.ts`
- `apps/api/src/http/assistant.controller.ts` and `apps/api/src/assistant/assistant.service.ts`
  (for known item f)

Packages:

- `packages/authorization/src/internal-capabilities.ts`
- `packages/authorization/src/high-risk-actions.ts`
- `packages/authorization/src/operations-overview.ts`
- `packages/authorization/src/support-desk.ts`
- `packages/authorization/src/privacy-console.ts`
- `packages/persistence/src/platform-controls.ts`
- `packages/persistence/src/operation-approvals.ts`
- `packages/persistence/src/operations-overview.ts`
- `packages/persistence/src/jobs-health.ts`
- `packages/persistence/src/support-cases.ts`
- `packages/persistence/src/privacy-operations.ts`
- `packages/persistence/src/outbox-dispatcher.ts` (replay, supersede and the legacy failed list)
- `packages/persistence/src/migrate.ts`
- `packages/identity/src/staff-pool.ts`
- `packages/identity/src/principal.ts`
- `packages/identity/src/cognito.ts`
- `packages/privacy/src/index.ts` (deletion policy)

Migrations:

- `packages/persistence/drizzle/0001_identity_organization_persistence.sql` (`audit_events`)
- `packages/persistence/drizzle/0031_membership_capabilities.sql`
- `packages/persistence/drizzle/0038_operation_approvals.sql`
- `packages/persistence/drizzle/0039_internal_capabilities.sql`
- `packages/persistence/drizzle/0043_support_cases.sql`
- `packages/persistence/drizzle/0045_jobs_health_alerts.sql`
- `packages/persistence/drizzle/0047_learning_attempt_log.sql` (deletion category CHECK)

Deploy script:

- `deploy/scripts/preflight-production.sh`

Web:

- `apps/web/src/rolePortal/staffCapabilities.tsx`
- `apps/web/src/rolePortal/approvals.tsx`
- `apps/web/src/rolePortal/systemHealth.tsx`
- `apps/web/src/rolePortal/support.tsx`
- `apps/web/src/rolePortal/privacyConsole.tsx`
- `apps/web/src/rolePortal/operationsEmployerAccessRequests.tsx`
- `apps/web/src/rolePortal/operations.tsx`
- `apps/web/src/rolePortal/shared.tsx` (`formatApiError`)
- `apps/web/src/dashboardsV2.tsx` (`OperationsDashboardV2`)
- `apps/web/src/api/operations.ts`

Tests:

- `apps/api/src/http/operations-capabilities.integration.spec.ts`
- `apps/api/src/http/operations-approvals.integration.spec.ts`
- `apps/api/src/http/operations-overview.integration.spec.ts`
- `apps/api/src/http/operations-jobs.integration.spec.ts`
- `apps/api/src/http/operations-support.integration.spec.ts`
- `apps/api/src/http/operations-privacy.integration.spec.ts`
- `apps/api/src/http/employer-company-profile.integration.spec.ts`
- `packages/authorization/src/{internal-capabilities,high-risk-actions,operations-overview,support-desk,privacy-console}.test.ts`
- `packages/persistence/test/{internal-capabilities,jobs-health,platform-controls}.integration.test.ts`
- `packages/identity/test/{staff-pool-policy,jwt-staff-pool}.test.ts`
- `apps/api/src/staff-pool-config.test.ts`
- the web tests for each screen listed above

Design notes read for intent:

- ADR-032
- `internal-capabilities-table-design.md`
- `high-risk-approvals-table-design.md`
- `support-cases-table-design.md`
- `jobs-health-alerts-table-design.md`
- `employer-access-requests-table-design.md`
- `docs/ops/OPS_PROGRESS.md`
- `docs/ops/runbook-staff-pool.md`

## 3. Threats

### 3.1 Privilege escalation

**Verified controls**

- **Every operations route checks a named capability on the server, after
  `requireTrustedAuthorization`, and does not inline a role list.**
  - Code:
    - `apps/api/src/http/internal-capability-guard.ts:73-83`
    - `apps/api/src/http/operations-staff.controller.ts:148-155`
    - `apps/api/src/http/operations-approvals.controller.ts:167-174`
    - `apps/api/src/http/operations-outbox.controller.ts:145-150`
    - `apps/api/src/http/operations-privacy.controller.ts:279-288`
    - `apps/api/src/http/operations-support.controller.ts:315-322`
    - `apps/api/src/http/operations-institution-onboarding.controller.ts:845-853`
    - `apps/api/src/http/employer-access-requests.controller.ts:247-253`
  - Tests:
    - `operations-capabilities.integration.spec.ts` › `retrofitted operations endpoints keep exactly their previous platform roles` (it.each per route)
    - `operations-jobs.integration.spec.ts` › `%s: 401 without a token, 403 without OPS_JOBS_REPLAY, admitted for the three platform roles`
    - `operations-privacy.integration.spec.ts` › `%s: 401 without a token, 403 without PRIVACY_REQUESTS, admitted for the three platform roles`
    - `operations-support.integration.spec.ts` › `returns 403 to an ACTIVE institution admin for every route`
- **Only ACTIVE memberships count, and a PENDING, SUSPENDED or ENDED membership holds nothing, its
  grants included.**
  - Code:
    - `packages/authorization/src/internal-capabilities.ts:189`
    - `apps/api/src/http/internal-capability-guard.ts:46-50`
    - `packages/identity/src/principal.ts:91-96`
  - Tests:
    - `internal-capabilities.test.ts` › `denies a %s membership its baseline and its grants`
    - `operations-capabilities.integration.spec.ts` › `admits a platform role through an explicit grant, and not once the membership is suspended`
    - `operations-support.integration.spec.ts` › `honours a SUPPORT_CASES grant and ignores an inactive membership`
- **Nobody can grant or revoke their own capabilities, including the super admin.** The API refuses
  it and the 0039 trigger refuses it again.
  - Code:
    - `packages/authorization/src/internal-capabilities.ts:252,268`
    - `packages/persistence/drizzle/0039_internal_capabilities.sql:96-98`
  - Tests:
    - `internal-capabilities.test.ts` › `refuses a self-grant, even for the super admin`
    - `operations-capabilities.integration.spec.ts` › `rejects a self-grant`
    - `internal-capabilities.integration.test.ts` › `refuses a self-grant at the database`
- **An internal capability can be granted only to a platform-organisation membership held under a
  platform role.** Enforced in the pure rule and in the trigger. A stray grant on another role is
  ignored when authority is resolved.
  - Code:
    - `internal-capabilities.ts:156-159,168,255`
    - `0039_internal_capabilities.sql:79-94`
  - Tests:
    - `operations-capabilities.integration.spec.ts` › `refuses SUPPORT_CASES for an institution membership, and the database refuses it too`
    - `internal-capabilities.test.ts` › `ignores an internal grant on a membership outside the platform roles`
- **A role change cannot carry internal grants across.** `changeMembershipRole` revokes them in the
  same transaction with the reason `ROLE_CHANGED`, and the trigger refuses a raw role change while a
  grant is live.
  - Code:
    - `packages/persistence/src/platform-controls.ts:498-539`
    - `0039_internal_capabilities.sql:116-132`
  - Tests:
    - `internal-capabilities.integration.test.ts` › `refuses a raw role change while an internal grant is live`
    - `internal-capabilities.integration.test.ts` › `changeMembershipRole revokes every live grant with ROLE_CHANGED and audits it in one transaction`
- **Grants are immutable except for revocation, and a revocation is final.**
  - Code: `0039_internal_capabilities.sql:59-73`
  - Test: `internal-capabilities.integration.test.ts` › `treats a grant as immutable except for its revocation, and never un-revokes`
- **High-risk capabilities are granted only with an approval, for every caller including the super
  admin.**
  - Code: `internal-capabilities.ts:261`
  - Tests:
    - `internal-capabilities.test.ts` › `requires an approval for a %s grant, from a delegate and a super admin alike`
    - `operations-capabilities.integration.spec.ts` › `lets a delegated CAPABILITY_ADMIN grant ordinary capabilities, and nobody grant a high-risk one without an approval`
- **Break-glass is resolved separately from the baseline**, so that a routine use is never
  mislabelled.
  - Code: `internal-capabilities.ts:116-118,166-195`
  - Tests:
    - `internal-capabilities.test.ts` › `holds every capability for the super admin except the faculty-only one, the rest as break-glass`
    - `internal-capabilities.test.ts` › `prefers a baseline over break-glass when a caller has both memberships`
  - Recording a break-glass use in audit is **not** built: see OPS-SR-17.
- **Staff-pool token confusion.** The verifier selects the pool by issuer and requires that pool's
  client id. With a staff pool configured, platform-role memberships are dropped unless the token
  came from the staff pool to the staff client. A half-configured pool, or a staff pool that is
  really the student pool, is refused when the API starts and in preflight.
  - Code:
    - `packages/identity/src/cognito.ts:42-51`
    - `packages/identity/src/staff-pool.ts:65-80`
    - `packages/identity/src/principal.ts:91-96`
    - `apps/api/src/runtime-auth.ts:30-37`
    - `apps/api/src/config.ts:121-139`
    - `deploy/scripts/preflight-production.sh:61-85`
  - Tests:
    - `staff-pool-policy.test.ts` › `a student-pool token cannot act as an internal role`
    - `staff-pool-policy.test.ts` › `a student-pool token claiming the staff client id is unauthenticated, not staff`
    - `jwt-staff-pool.test.ts` › `refuses a staff-issuer token signed with the student pool key`
    - `staff-pool-config.test.ts` › `refuses half a staff pool, naming the settings and never a value`
    - `staff-pool-config.test.ts` › `refuses the student pool or client dressed as the staff pool`

**Open findings**

- **OPS-SR-04 (Medium) — Revoking an approver re-arms the solo safeguard at once.** Revoking a grant
  needs only CAPABILITY_ADMIN and no approval, and that includes revoking another person's
  APPROVE_HIGH_RISK. The solo check reads the live approver count at the moment of the decision.
  So a CAPABILITY_ADMIN holder who is also an approver can revoke the second approver's grant, and
  15 minutes later approve their own request — including a request filed while two approvers
  existed. This defeats dual control whenever the second approver's authority is a grant rather
  than a baseline.
  - Evidence:
    - `packages/authorization/src/internal-capabilities.ts:266-272`
    - `apps/api/src/http/operations-staff.controller.ts:123-146`
    - `packages/persistence/src/operation-approvals.ts:371`
    - `packages/authorization/src/high-risk-actions.ts:127-130`
    - `packages/persistence/drizzle/0038_operation_approvals.sql:191-193`
  - Fix:
    - Record the approver count on the request. Refuse a solo approval of any request filed while
      two or more approvers existed.
    - Make revoking APPROVE_HIGH_RISK or CAPABILITY_ADMIN from another approver a high-risk action
      while two or more approvers exist, and/or require the count to have been 1 for 24 hours
      before solo applies.
  - Proving test: `operations-approvals.integration.spec.ts` › (new) `refuses a solo approval after the second approver's grant is revoked`.
- **OPS-SR-18 (Low) — The authority to grant is read before the transaction.** The actor's
  CAPABILITY_ADMIN is loaded before the grant transaction starts, and the 0039 trigger does not
  check that `granted_by_user_id` holds it. A grant racing a revocation of the granter can still
  commit.
  - Evidence:
    - `apps/api/src/http/operations-staff.controller.ts:152`
    - `packages/persistence/src/platform-controls.ts:383-392`
    - `0039_internal_capabilities.sql:96-98`
  - Fix: reload the actor's grants under lock inside `inCapabilityTransaction`.
  - Proving test: `internal-capabilities.integration.test.ts` › (new) `refuses a grant whose granter lost CAPABILITY_ADMIN before commit`.
- **OPS-SR-19 (Low) — Suspension leaves internal grants live.** Grants count only while the
  membership is ACTIVE, but suspending a membership does not revoke them. A later reactivation
  restores every grant without review. No API changes the state of a platform membership today, so
  only hand-run SQL can reach this.
  - Evidence:
    - `internal-capabilities.ts:189`
    - `0039_internal_capabilities.sql:128-132` (the guard covers role only)
  - Fix: a new-migration trigger that revokes internal grants when a membership leaves ACTIVE, with
    the reason `MEMBERSHIP_SUSPENDED`.
  - Proving test: `internal-capabilities.integration.test.ts` › (new) `revokes internal grants when a membership is suspended`.
- **OPS-SR-20 (Low) — The user lookup is bound to `sub` alone, not to the issuing pool.** Cognito
  subjects are random UUIDs, so a collision between pools is theoretical. Binding the lookup to
  (issuer, sub) would rule out cross-pool confusion by construction once staff are re-bound.
  - Evidence:
    - `packages/identity/src/principal.ts:86`
    - `packages/persistence/src/identity-authentication.ts:28-40`
  - Fix: store the issuer next to `external_subject` and match on both.
  - Proving test: `staff-pool-policy.test.ts` › (new) `does not resolve a staff-pool subject to a student-pool identity`.

### 3.2 Insecure direct object references

**Verified controls**

- **Every `:id` route is validated as a UUID and answers 404 for an unknown or wrong-state
  resource.** The data is platform-wide by design; these routes do not scope by tenant.
  - Staff, `/staff/:membershipId/...`:
    - Code: `operations-staff.controller.ts:95,132`; `platform-controls.ts:384-385`
    - Test: `operations-capabilities.integration.spec.ts` › `validates input explicitly before touching the database`
  - Approvals, `/approvals/:approvalId/decision`:
    - Code: `operations-approvals.controller.ts:145`; `operation-approvals.ts:363-364`
  - Jobs, `/jobs/failed/:eventId`:
    - Code: `operations-jobs.controller.ts:96-98`
    - Test: `operations-jobs.integration.spec.ts` › `shows one failed event with a plain explanation and its reference, and 404s anything that is not failed`
  - Outbox replay, `/outbox/:eventId/replay`:
    - Code: `operations-outbox.controller.ts:73,89`
  - Support, `/support/cases/:caseId` and `/support/accounts/:userId`:
    - Code: `operations-support.controller.ts:178-180,286-288`; `support-cases.ts:163`
  - Privacy, `/privacy/requests/:requestId` and `/privacy/holds/:holdId/release`:
    - Code: `operations-privacy.controller.ts:145-147,230,246,268`
    - Test: `operations-privacy.integration.spec.ts` › `answers 400 for a malformed id and 404 for an unknown one, without auditing a read`
  - Employer access requests, `/employer-access-requests/:requestId/decision`:
    - Code: `employer-access-requests.controller.ts:214,223-226`
- **The organisation routes use `:targetOrganizationId`**, so a target organisation is never
  selected as the caller's membership. They are restricted to INSTITUTION and EMPLOYER
  organisations.
  - Code: `operations-institution-onboarding.controller.ts:132-143,208`
- **Replaying an event that is not FAILED answers 404, not 409**, so the answer reveals nothing
  about events in other states.
  - Code: `operations-outbox.controller.ts:86-89`
- **An institution admin cannot touch another organisation's memberships.**
  - Code: `platform-controls.controller.ts:125-131`

**Open findings**

- No IDOR defect was found. The 500 answers for an unknown organisation on the verification route
  are recorded under errors (OPS-SR-15).

### 3.3 Mass assignment

**Verified controls**

- **Allow-listed bodies and queries, with unknown keys answered 400:**
  - Staff (`operations-staff.controller.ts:71,96,134`):
    - `operations-capabilities.integration.spec.ts` › `pages with a keyset cursor and rejects bad bounds and unknown fields`
  - Approvals, with a per-action payload allow-list (`operations-approvals.controller.ts:92,117,122,146,252-258`):
    - `operations-approvals.integration.spec.ts` › `validates the action, the payload, the reason and the target before filing`
  - Overview, which takes no parameters (`operations-overview.controller.ts:38`):
    - `operations-overview.integration.spec.ts` › `rejects any query parameter with 400, and only after authorising the caller`
  - Jobs filters (`operations-jobs.controller.ts:67`):
    - `operations-jobs.integration.spec.ts` › `pages by keyset within the bounds, filters by type and age, and returns no payload or failure text`
  - Support, every route (`operations-support.controller.ts:125,153,191,217,238,260,298`):
    - `operations-support.integration.spec.ts` › `rejects invalid input with 400 and a code`
  - Privacy queue and hold placement (`operations-privacy.controller.ts:103,187`):
    - `operations-privacy.integration.spec.ts` › `places a hold with a listed reason, audited with that reason`
  - Public form and queue decision (`employer-access-requests.controller.ts:171,311-312,332`):
    - `employer-company-profile.integration.spec.ts` › `validates the form and refuses unknown fields`
- **Server-set fields cannot be supplied by a caller.**
  - `requested_at` and `expires_at` on approvals: `0038:160-163`
  - `opened_at`, `sla_due_at` and `version` on support cases: `0043:169-180`
  - `raised_at` and `state` on jobs alerts: `0045:64-68`
  - `occurred_at` on support case events: `0043:242-247`
  - Tests:
    - `operations-support.integration.spec.ts` › `stamps SLA targets by severity from the database clock`
    - `jobs-health.integration.test.ts` › `keeps the alert record immutable and undeletable, and at most one open alert per condition`

**Open findings**

- **OPS-SR-14 (Low) — Four write routes accept unknown body fields.** Only named fields are read,
  so nothing is assignable today. The routes are inconsistent with the rest of the console, and a
  later edit could start reading a field that is never checked. The four routes:
  - outbox replay: `operations-outbox.controller.ts:161-173`
  - backlog supersede: `operations-outbox.controller.ts:102-112`
  - hold release: `operations-privacy.controller.ts:231,290-293`
  - verification transition: `operations-institution-onboarding.controller.ts:198-203`

  Fix: an explicit allow-list on each route, as the other routes have.
  - Proving tests:
    - `operations-jobs.integration.spec.ts` › (new) `refuses unknown fields on replay and supersede`
    - `operations-privacy.integration.spec.ts` › (new) `refuses unknown fields on hold release`

### 3.4 Audit tampering

**Verified controls**

- **Each console write records its audit row (and outbox event) in the same transaction as the
  change.**
  - Capability grant and revoke:
    - Code: `platform-controls.ts:376-401,403-449`
    - Tests:
      - `internal-capabilities.integration.test.ts` › `writes the grant, an audit row with the reason code and an outbox event together`
      - `internal-capabilities.integration.test.ts` › `rolls everything back when the rule refuses, leaving no grant, audit or outbox row`
  - Approval request, decision and execution:
    - Code: `operation-approvals.ts:114-131,362-410,430-471`
    - Test: `operations-approvals.integration.spec.ts` › `files a request with a reason code, audits it and announces it on the outbox`
  - Support cases:
    - Code: `support-cases.ts:119-155`
    - Test: `operations-support.integration.spec.ts` › `logs a phone call in one request, with SLA, history, audit and outbox`
  - Hold place and release:
    - Code: `operations-privacy.controller.ts:203-214,242-264`
  - Replay and supersede:
    - Code: `outbox-dispatcher.ts:371-412,451-487`
    - Test: `operations-jobs.integration.spec.ts` › `replays a failed event with a listed reason, audits it, and takes it off the failed list`
  - Verification transition:
    - Code: `operations-institution-onboarding.controller.ts:207-223`
  - Employer access decision:
    - Code: `employer-access-requests.controller.ts:218-239`
- **Operation approvals are never deleted, the request fields are immutable, and state only moves
  forward.**
  - Code: `0038:148-224`
  - Test: `operations-approvals.integration.spec.ts` › `keeps requests immutable, never deleted, and never self-approved outside the solo rule`
- **Support case history is append-only.** The one permitted update is a privacy-deletion
  redaction, and cases are never deleted.
  - Code: `0043:156-265`
  - Test: `operations-support.integration.spec.ts` › `is enforced by the database for any other writer`
- **Jobs health alerts are immutable and undeletable.** The only transition is OPEN → CLEARED,
  stamped by the database clock.
  - Code: `0045:58-91`
  - Test: `jobs-health.integration.test.ts` › `keeps the alert record immutable and undeletable, and at most one open alert per condition`
- **No code in this slice updates or deletes `audit_events`.** A grep for `UPDATE audit_events` and
  `DELETE FROM audit_events` across `apps/` and `packages/` returned nothing.

**Open findings**

- **OPS-SR-03 (Medium) — `audit_events` has no append-only guard in the database.** The table has
  no trigger refusing UPDATE or DELETE. Every console control ultimately rests on this table, and
  an application-role compromise or a stray query could rewrite it. Separately,
  `membership_capabilities` rows, which are the grant history, can be deleted: both triggers fire
  on INSERT OR UPDATE only.
  - Evidence:
    - `packages/persistence/drizzle/0001_identity_organization_persistence.sql:130-142`
    - `0031_membership_capabilities.sql:69-72`
    - `0039_internal_capabilities.sql:104-107`
  - Fix: a new migration (0072 or later — never an edit to an existing one) adding a trigger that
    refuses UPDATE and DELETE on `audit_events`, and DELETE on `membership_capabilities`.
  - Proving test: `packages/persistence/test` › (new) `audit events cannot be updated or deleted by any writer`.
- **OPS-SR-21 (Low) — Correlation IDs come from the client.** `x-correlation-id` is accepted when it
  matches the pattern and is written into audit rows. An operator can reuse another request's ID
  and muddle an investigation.
  - Evidence:
    - `apps/api/src/http/api-security.ts:130,146,385-389`
  - Fix: always generate the correlation ID on the server, and keep any client value as a separate
    `client_reference` in the audit context.
  - Proving test: `api-security.integration.spec.ts` › (new) `audit correlation ids are server-generated`.

### 3.5 Personal-data exposure in support

**Verified controls**

- **Contacts are masked by default** (`a***@domain`; the phone shows NA because none is stored).
  - Code:
    - `packages/authorization/src/support-desk.ts:105-118`
    - `support-cases.ts:485,566-568`
  - Tests:
    - `support-desk.test.ts` › `keeps the first character and the domain of an email`
    - `operations-support.integration.spec.ts` › `shows the account with masked contacts, memberships, cases and a timeline, and audits the read`
    - web `rolePortal/support.test.tsx` › `shows the account with its contact masked and NA for the missing phone`
- **A reveal needs a reason code from a fixed list, and is audited in the same transaction as the
  read.** An erased account cannot be revealed.
  - Code:
    - `support-desk.ts:72`
    - `operations-support.controller.ts:299`
    - `support-cases.ts:597-617`
  - Tests:
    - `operations-support.integration.spec.ts` › `reveals the full contact only with a reason, and audits the reveal`
    - web `support.test.tsx` › `reveals the full contact only after a reason code is chosen`
- **The account view and case detail are audited as `*.viewed`.**
  - Code: `operations-support.controller.ts:182,289`
  - Tests:
    - `operations-support.integration.spec.ts` › `audits reading a case`
    - `operations-support.integration.spec.ts` › `shows the account with masked contacts, ...`
- **Search text is not stored.** Audit keeps only the query kind and the result count.
  - Code: `operations-support.controller.ts:270-274`
  - Test: `operations-support.integration.spec.ts` › `searches by address with masked results and never copies the search into audit`
- **Notes are audited without their text.**
  - Code: `support-cases.ts:212-213`
  - Test: `operations-support.integration.spec.ts` › `adds a note linked to a reference, audited without its text, and refuses notes on a closed case`
- **The account view omits academic content, documents, assistant conversations and audit context.**
  - Code: `support-cases.ts:505-591`
- **On deletion, a person's cases are detached from them, their summary is replaced and every note
  is redacted.** The `SUPPORT_CASES` category is recorded.
  - Code:
    - `support-cases.ts:631-647`
    - `apps/api/src/http/privacy-deletion.ts:170-172`
  - Test: `operations-support.integration.spec.ts` › `removes the person from their cases and keeps only non-identifying fields`
- **The privacy queue masks subjects and never returns the typed reason.** Reading a request is
  audited.
  - Code:
    - `privacy-operations.ts:105`
    - `operations-privacy.controller.ts:141-150`
  - Tests:
    - `operations-privacy.integration.spec.ts` › `lists every request with its state, a masked subject and no typed reason`
    - `operations-privacy.integration.spec.ts` › `shows its state history and holds, and audits the read`

**Open findings**

- **OPS-SR-05 (Medium) — The support case queue returns personal data without an audit record.**
  `GET /support/cases` returns up to 200 cases, each with its typed summary, the subject's user ID
  and masked email. It can be filtered by `subjectUserId`, and none of this is audited; only the
  detail view is. §5.2 requires reads of personal data by support to be audited.
  - Evidence:
    - `apps/api/src/http/operations-support.controller.ts:121-147`
    - `packages/persistence/src/support-cases.ts:320-325,346-368`
  - Fix: take the summary out of the list rows (show the reference and category), or audit the
    listing as `operations.support_case.listed` with the filter kinds and result count and no text.
  - Proving test: `operations-support.integration.spec.ts` › (new) `does not return case summaries in the queue, or audits the listing`.
- **OPS-SR-06 (Medium) — The legacy `GET /operations/users-access` returns every user's unmasked
  email with memberships and student relationships.** It needs no search term and caps at 200
  rows. It is gated only by OPS_ORG_MANAGE, not SUPPORT_ACCOUNT_LOOKUP, is not audited, and accepts
  LIKE wildcards. Neither web nor Android calls it: the only caller is the unused
  `listOperationsUsersAccess`.
  - Evidence:
    - `apps/api/src/http/operations-institution-onboarding.controller.ts:274-312,1297-1310`
    - `apps/web/src/api/operations.ts:59-62`
  - Fix: remove the route and the unused client function.
  - Proving test: `operations-institution-onboarding.integration.spec.ts` › (new) `GET /operations/users-access no longer exists`.
- **OPS-SR-07 (Low) — The invitation inventory shows unmasked recipients.** `GET /operations/invitations`
  is in use on the Organizations screen. It returns every recipient email, student invitations
  included, together with `destination_ref` and the provider reference. It is not audited and not
  paginated beyond 200 rows.
  - Evidence:
    - `operations-institution-onboarding.controller.ts:314-342`
    - `apps/web/src/rolePortal/operations.tsx:322`
  - Fix: mask student-invitation recipients, drop the provider fields, and keyset-paginate.
  - Proving test: (new) `invitation inventory masks student recipients and returns no provider references`.
- **OPS-SR-08 (Low) — Account search can list every account.** The design note says it cannot. A
  three-character substring common to most addresses (for example `com`), paged with the cursor,
  enumerates all accounts in masked form. Every page is audited.
  - Evidence:
    - `operations-support.controller.ts:263-269`
    - `support-cases.ts:466-468`
    - `docs/ops/OPS_PROGRESS.md:365`
  - Fix: require a longer partial term, or the whole local part plus the domain, and cap the pages
    per search term.
  - Proving test: `operations-support.integration.spec.ts` › (new) `refuses a partial term that matches the whole directory`.
- **OPS-SR-09 (Low) — A case can be opened about an erased person.** Opening a case checks only that
  the user exists. The deletion's detach has already run, so the new summary is never redacted.
  - Evidence:
    - `support-cases.ts:120-123`
    - `operations-support.controller.ts:159`
  - Fix: refuse with `SUPPORT_ACCOUNT_DELETED` when `anonymised_at` is set.
  - Proving test: `operations-support.integration.spec.ts` › (new) `refuses a case about an erased person`.
- **OPS-SR-10 (Low) — A reveal can cite a case about someone else.** The reveal checks only that the
  case exists, not that it concerns the person revealed.
  - Evidence: `support-cases.ts:607-610`
  - Fix: require `support_cases.subject_user_id = userId`.
  - Proving test: `operations-support.integration.spec.ts` › (new) `refuses a reveal justified by a case about someone else`.
- **OPS-SR-11 (Low) — The legal-hold list returns free text and subject IDs without an audit
  record.** `GET /privacy/holds` returns the operator-written `detail` (up to 2,000 characters) and
  the subject's user ID for up to 200 holds to any PRIVACY_REQUESTS holder, without a `*.viewed`
  audit.
  - Evidence:
    - `packages/persistence/src/privacy-operations.ts:290-329`
    - `operations-privacy.controller.ts:156-167`
  - Fix: leave `detail` out of the list and show it only in an audited per-hold read.
  - Proving test: `operations-privacy.integration.spec.ts` › (new) `lists holds without their detail text`.

### 3.6 Export abuse

**Verified controls**

- **This slice has no operator export.** No route in these controllers produces a file, CSV or bulk
  download. The privacy console shows only an export request's state and expiry, never its content.
  - Code: `apps/web/src/rolePortal/privacyConsole.tsx:200`

**Open findings / gate for future exports**

- There is no defect in this slice. §5.4's "any bulk export containing personal data" has no action
  key: the list is `high-risk-actions.ts:13-19`, and the CHECK in `0038:55-57` would need a new
  migration to widen it. Any future export must pass all of the following:
  - a named capability;
  - a dual-control action key bound to its filter and row limit;
  - an audit row that records counts, never content;
  - the <5 suppression for aggregates;
  - formula-escaping of cells (`=`, `+`, `-`, `@`, tab, CR);
  - generation as an outbox job, not a long request;
  - an expiring, single-use download.

### 3.7 Dual-control bypass

**Verified controls**

- **Every §5.4 action that has an endpoint refuses to run without an approval** — for the super
  admin too.
  - The actions and where they are gated:
    - suspension: `operations-institution-onboarding.controller.ts:203-214`
    - high-risk flag change: `platform-controls.controller.ts:84-97`
    - backlog supersede: `operations-outbox.controller.ts:117-127`
    - hold release: `operations-privacy.controller.ts:239-251`
    - high-risk grant: `operations-staff.controller.ts:102-115`
  - Tests:
    - `operations-approvals.integration.spec.ts` › `returns 403 APPROVAL_REQUIRED and changes nothing, for the super admin too`
    - `operations-approvals.integration.spec.ts` › `enables a high-risk feature flag with an approval`
    - `operations-approvals.integration.spec.ts` › `turns a safety kill switch off only with an approval`
    - `operations-approvals.integration.spec.ts` › `supersedes the backlog with an approval bound to the cutoff and limit`
    - `operations-approvals.integration.spec.ts` › `releases a legal hold with an approval, and never shows the hold subject in the queue`
    - `operations-approvals.integration.spec.ts` › `grants a high-risk capability with an approval, and refuses an approver deciding their own elevation`
- **Payload hash binding.** The approval stores a SHA-256 of the canonical action and payload. The
  executing endpoint rebuilds the payload with the same builder, and any change is refused.
  - Code:
    - `operation-approvals.ts:45-62,445-451`
    - `operation-approval-gate.ts:19-30`
  - Test: `operations-approvals.integration.spec.ts` › `suspends an organisation only after a second person approves, once, for exactly the approved payload`
- **Expiry runs on the database clock.** The trigger stamps `requested_at` and `expires_at`, and
  every decision and execution compares with `now()`.
  - Code: `0038:160-163,177-180,204-207`; `operation-approvals.ts:441`
  - Test: `operations-approvals.integration.spec.ts` › `refuses decisions and execution after 24 hours`
- **The requester is not the approver** (API and trigger). An approver cannot approve their own
  elevation.
  - Code: `high-risk-actions.ts:126-128`; `0038:184-200`
  - Tests:
    - `operations-approvals.integration.spec.ts` › `refuses the requester deciding their own request while another approver exists`
    - `high-risk-actions.test.ts` › `refuses an approver deciding a capability grant to themselves`
- **The solo safeguard applies only with exactly one approver**, after 15 minutes on the database
  clock, marked SOLO, with the notice outcome recorded honestly.
  - Code: `high-risk-actions.ts:128-130`; `0038:96-103,188-193`
  - Tests:
    - `operations-approvals.integration.spec.ts` › `applies only with exactly one approver, after 15 minutes, marked SOLO, with the notice recorded honestly`
    - `high-risk-actions.test.ts` › `allows the solo path only with exactly one approver and after the cooling-off`
- **An approval cannot be reused, and the executor must be the requester.** The row is locked FOR
  UPDATE, moves to EXECUTED in the action's transaction, and the CHECK ties the executor to the
  requester.
  - Code: `operation-approvals.ts:437-457`; `0038:106-108,204-217`
  - Tests:
    - `operations-approvals.integration.spec.ts` › `suspends an organisation only after a second person approves, once, ...` (asserts `APPROVAL_NOT_REQUESTER` and single use)
    - `operations-approvals.integration.spec.ts` › `never executes a rejected request`
- **No time-of-check to time-of-use gap on the decision.** Decisions re-read the row under lock and
  count approvers inside the transaction. The trigger re-checks the approver with
  `operation_approval_is_approver`.
  - Code: `operation-approvals.ts:362-393`; `0038:181-183`

**§5.4 actions with no endpoint or action key yet**

- Publishing a career-role requirement set, or any change that alters readiness or gap results
  (OPS-08/09).
- Any bulk export containing personal data (see 3.6).
- The AI global kill switch: no such flag exists yet (OPS-12).

**Open findings**

- **OPS-SR-04 (Medium)** — the solo safeguard can be re-armed by a revocation (see 3.1).
- **OPS-SR-22 (Low) — No feature flag is marked high-risk, so the flag gate never applies.** No
  migration sets `high_risk_direction`. `employer-access.allow-free-mail`, which relaxes an
  abuse control, can be switched without approval. The design note records "none exist yet".
  - Evidence:
    - `0038:20-23`
    - `0041_employer_company_profile_and_access_requests.sql:141`
    - `docs/architecture/high-risk-approvals-table-design.md:195-196`
  - Fix: set the direction in the migration that creates each AI or safety flag; decide on
    `allow-free-mail` explicitly.
  - Proving test: (new) `every AI and safety flag carries a high-risk direction`.
- **OPS-SR-16 (Low) — Non-suspend reason codes are not taken from a fixed list.** Verification
  transitions other than suspension accept any code matching the pattern and default to
  `OPERATIONS_REVIEW`. `PATCH /operations/organizations/:id` carries no reason code at all, and its
  audit row has no context. Supersede and hold release check only the pattern at execution; the
  approval binding keeps those two to the approved list in practice.
  - Evidence:
    - `operations-institution-onboarding.controller.ts:154-189,199-200`
    - `operations-outbox.controller.ts:166`
    - `operations-privacy.controller.ts:232`
  - Fix: a fixed reason list per transition in `packages/authorization`; require a reason on PATCH.
  - Proving test: (new) `refuses an unlisted verification reason`.

### 3.8 Cross-tenant reviewer access (CONTENT_REVIEW_EXTERNAL)

**Verified controls**

- **Grantable only on an institution FACULTY_LECTURER or DEPARTMENT_HEAD membership.** Enforced at
  the database and in the authority resolver.
  - Code: `0039:87-90`; `internal-capabilities.ts:157`
  - Tests:
    - `internal-capabilities.integration.test.ts` › `allows faculty review only on institution faculty and department heads`
    - `internal-capabilities.test.ts` › `honours the faculty review grant only on faculty and department heads`
- **No API can grant it today.** The staff screen refuses it, and the institution endpoint accepts
  only INSTITUTION_ANALYTICS. OPS-10, which would grant it, is not built.
  - Code:
    - `internal-capabilities.ts:254`
    - `operations-staff.controller.ts:81`
    - `platform-controls.controller.ts:124`
  - Test: `internal-capabilities.test.ts` › `never grants faculty review from the staff screen`
- **It opens no operations surface.** It is excluded from the Overview entry list, is not a
  capability of any high-risk action, and no controller checks it.
  - Code: `packages/authorization/src/operations-overview.ts:57-59`; `high-risk-actions.ts:30-36`
  - Test: `operations-overview.test.ts` › `is denied to institution roles, even with stray grants, and to a faculty content reviewer`

**Open findings**

- None in this slice. OPS-10 must add an assignment-scoped check (one draft, one reviewer). It must
  also decide staff-pool gating for faculty, which the progress log flags at
  `docs/ops/OPS_PROGRESS.md:768`.

### 3.9 The public employer access request endpoint

**Verified controls**

- **It creates a PENDING request and nothing else** — no user, organisation, membership or
  invitation. Every well-formed submission gets the same 202.
  - Code: `employer-access-requests.controller.ts:106-159`
  - Tests:
    - `employer-company-profile.integration.spec.ts` › `records a pending request and creates nothing else — no user, organisation, membership or invitation`
    - `employer-company-profile.integration.spec.ts` › `answers identically for a repeat and for a company already on ONE, so it cannot be used to enumerate`
- **Rate limits per address (5 an hour), per domain (10 a day) and overall (200 an hour)** are
  counted under an advisory lock. Only a SHA-256 digest of the address is stored, and attempts are
  pruned after two days.
  - Code: `:62,114-134`
  - Test: `employer-company-profile.integration.spec.ts` › `rate-limits by network address and by email domain, without saying anything about records`
- **Webmail is refused unless the flag allows it; the website must be `https://`;** the queue shows
  the URL as text, not as a link.
  - Code: `:112-113,325`; `apps/web/src/rolePortal/operationsEmployerAccessRequests.tsx:127`
  - Test: `employer-company-profile.integration.spec.ts` › `refuses a public webmail address unless Operations allows it, then flags it`
- **The queue needs OPS_ORG_MANAGE; a decision uses a fixed reason list, is audited in its
  transaction, and never verifies anything.**
  - Code: `:78-82,209-245`
  - Test: `employer-company-profile.integration.spec.ts` › `shows requests as pending to Operations only, with possible matches, and records a decision without verifying anything`

**Open findings**

- **OPS-SR-23 (Low) — The rate limiter's client address and its blocking.** Three related gaps:
  - `clientAddress` trusts the right-most `X-Forwarded-For` entry whenever the socket peer is a
    private address. Behind two proxy hops, every client would share one bucket. No test covers a
    spoofed header from a public peer, or a header with several entries: the existing test always
    sends one address from a loopback peer.
  - The per-domain limit lets a stranger lock a company out for a day, or everyone out for an hour
    through the overall limit.
  - A 429 on the domain tells the caller that the domain has had 10 submissions today.
  - Evidence:
    - `employer-access-requests.controller.ts:62,128-131,266-281`
    - `employer-company-profile.integration.spec.ts:281`
  - Fix: configure trusted proxies explicitly, by hop count or CIDR; unit-test `clientAddress`;
    answer the domain limit with the ordinary 202 and drop the submission silently.
  - Proving test: (new) `clientAddress ignores X-Forwarded-For from a public peer and takes the entry the trusted proxy appended`.
- The queue shows the requester's name and work email unmasked to OPS_ORG_MANAGE. That is what the
  review task needs, so it is recorded here and not as a finding.

### 3.10 Error handling (safeError, no upstream text)

**Verified controls**

- **Every console route answers `{ error: { code, correlationId } }` with fixed codes.** Database
  and driver errors are mapped to fixed codes, never forwarded.
  - Code:
    - `operations-staff.controller.ts:199-210`
    - `operations-approvals.controller.ts:316-322`
    - `operations-support.controller.ts:372-381`
    - `operations-overview.controller.ts:43-46`
    - `employer-access-requests.controller.ts:154-157,240-243`
- **Jobs views never return an event payload, stored failure text or lease owner.** A failure is
  explained from a fixed table.
  - Code: `jobs-health.ts:341-347,417`
  - Tests:
    - `operations-jobs.integration.spec.ts` › `pages by keyset within the bounds, filters by type and age, and returns no payload or failure text`
    - `jobs-health.integration.test.ts` › `pages failed events by keyset without repeats, filters, and never returns payload or stored failure text`
- **The web shows a fixed message and the reference, never a server message.**
  - Code: `apps/web/src/rolePortal/shared.tsx:56-60`
  - Tests:
    - web `staffCapabilities.test.tsx` › `shows an error with the correlation id and no internal detail`
    - web `operationsOverview.test.tsx` › `shows a plain error with its reference, and no numbers`

**Open findings**

- **OPS-SR-15 (Low) — Some errors fall through to Nest's generic 500.** The following throw a plain
  `Error` or rethrow an unmapped one, and `apps/api/src` has no global exception filter:
  - the verification route, for an unknown organisation or an invalid transition;
  - PATCH organisation, for an organisation that does not exist;
  - supersede and hold release, on any unexpected error.

  Nothing leaks, because Nest answers `Internal server error`. But the answer has no correlation ID,
  so the screen cannot show a reference, and a 404 or 409 case reads as a 500.
  - Evidence:
    - `operations-institution-onboarding.controller.ts:167,210,223-225`
    - `operations-outbox.controller.ts:134`
    - `operations-privacy.controller.ts:266`
  - Fix: map these to domain 404 and 409 errors, and add a global filter that answers
    `{ error: { code: 'INTERNAL', correlationId } }`.
  - Proving test: (new) `verification of an unknown organisation answers 404 with a reference`.
- **OPS-SR-25 (Low) — The legacy `GET /operations/outbox/failed` is unbounded by the console's
  rules.** It allows up to 500 rows (the rule is 200), has no keyset cursor, and returns
  `aggregate_id` and `organization_id`. It returns no payload and no emails. It is unused by the web.
  - Evidence:
    - `operations-outbox.controller.ts:54-63`
    - `packages/persistence/src/outbox-dispatcher.ts:494-510`
    - `docs/ops/OPS_PROGRESS.md:480`
  - Fix: remove it in favour of `/operations/jobs/failed`.
  - Proving test: (new) `GET /operations/outbox/failed no longer exists`.

### 3.11 Small-count suppression, readiness, and CSV

**Verified controls**

- **Overview counts of people below 5 leave the server as `{ suppressed: true, value: null }`.**
  Zero counts as below 5.
  - Code:
    - `packages/authorization/src/operations-overview.ts:84-88`
    - `packages/persistence/src/operations-overview.ts:206-217`
  - Tests:
    - `operations-overview.integration.spec.ts` › `suppresses counts of people below 5 and returns the value from 5 up`
    - web `operationsOverview.test.tsx` › `shows the server counts, capped counts with a plus, and people below 5 as <5`
- **Consent coverage cells are suppressed and partition the people, with no total**, so a hidden
  cell cannot be recovered by subtraction.
  - Code:
    - `packages/authorization/src/privacy-console.ts:42-46`
    - `privacy-operations.ts:370-379,438-442`
  - Test: `operations-privacy.integration.spec.ts` › `counts people against the live version, suppressing any count under 5`
- **The Overview returns no personal data.**
  - Code: `packages/persistence/src/operations-overview.ts:144-203`
  - Test: `operations-overview.integration.spec.ts` › `returns no personal data: no emails, names or subject identifiers`
- **No numeric readiness.** A grep for "readiness" across the console controllers and persistence
  modules returns nothing. The Overview says so on screen (`apps/web/src/dashboardsV2.tsx:862`).
- **CSV:** none of these surfaces produces or consumes CSV. The roster CSV import in the same
  controller file is an institution-admin route, outside this scope.

**Open findings**

- **OPS-SR-24 (Low) — Two helpers implement the same suppression rule.** `suppressSmallCount` and
  `suppressPeopleCount` each carry their own threshold constant, so the rule can drift between
  screens.
  - Evidence:
    - `packages/authorization/src/privacy-console.ts:32,42`
    - `packages/authorization/src/operations-overview.ts:72,84`
  - Fix: keep one helper and one threshold, exported once.
  - Proving test: `operations-overview.test.ts` › (new) `uses the one shared threshold`.

### 3.12 Other findings (outside the console threat list, but on this base)

- **OPS-SR-01 (High) — Replaying 0043 breaks `db:migrate` after the first completed deletion.**
  - The migrator replays every `.sql` file on every run. It runs each file as one multi-statement
    query, which Postgres executes as a single implicit transaction.
  - 0043 drops and re-adds `privacy_deletion_category_ck` without `LEARNING_ACTIVITY`. 0047 widens
    it again afterwards.
  - The deletion worker writes a row for every category in `DELETION_POLICY`, `LEARNING_ACTIVITY`
    included, even with a count of 0.
  - So after the first completed deletion, re-adding the narrow CHECK in 0043 fails validation.
    0043 rolls back and the run stops. 0044 and every later migration, including any security fix,
    are never applied again. The 0039 and 0038 progress notes validated `db:migrate ×2` only on
    empty tables.
  - Evidence:
    - `packages/persistence/src/migrate.ts:19-24`
    - `packages/persistence/drizzle/0043_support_cases.sql:273-276`
    - `packages/persistence/drizzle/0047_learning_attempt_log.sql:140-144`
    - `apps/api/src/http/privacy-deletion.ts:75-80`
    - `packages/privacy/src/index.ts:211`
  - Fix: land the ADR-035 migration runner, which records applied files in a tracking table and
    baselines the existing ones. It is not on this base. Existing migrations must not be edited.
  - Proving test: `packages/persistence/test` › (new) `migrating twice succeeds after a deletion recorded LEARNING_ACTIVITY, and the category CHECK still admits every category`.
- **OPS-SR-02 (High) — The in-app assistant calls an external model synchronously from a request
  handler.** `POST /api/v1/assistant/chat` calls `api.anthropic.com` synchronously. The call is
  enabled whenever `ANTHROPIC_API_KEY` is set, not by a default-off flag, and does not go through
  ONE AI Orchestration. The handler also logs the first 300 characters of the user's question.
  This breaks the house rules: no synchronous model call in a handler, AI held (ADR-030),
  everything through orchestration, every AI feature behind its own flag. The console does not
  depend on it.
  - Evidence:
    - `apps/api/src/http/assistant.controller.ts:79-110`
    - `apps/api/src/assistant/assistant.service.ts:86-87,107-124`
  - Fix: disable the route until AWS managed inference and orchestration exist, behind a flag that
    is off by default; stop logging question text.
  - Proving test: `assistant` spec › (new) `the chat route refuses while its flag is off, whatever the environment`.
- **OPS-SR-26 (Low) — The Organizations "Edit" prompt nulls address fields.** The edit sends a
  profile without the state, postcode or address lines, and the API upsert writes NULL into each
  missing field.
  - Evidence:
    - `apps/web/src/rolePortal/operations.tsx:87-91`
    - `apps/api/src/http/operations-institution-onboarding.controller.ts:952-969`
  - Fix: send only changed fields, and make the API upsert leave absent fields untouched.
  - Proving test: (new) `editing the city keeps the address lines`.
- **OPS-SR-17 (Low) — Break-glass use is not audited (§5.1).** `resolveInternalCapability` returns
  `BREAK_GLASS`, but nothing outside the package calls it and no audit row carries
  `break_glass: true`. No live endpoint is reached through break-glass today (the design note,
  lines 104-106), so this is latent until OPS-08, OPS-09 or OPS-12.
  - Evidence: `packages/authorization/src/internal-capabilities.ts:166-195`
  - Fix: a guard that returns the source and writes `break_glass: true` in the action's audit
    context; ship it with the first break-glass route.
  - Proving test: (new) `a super admin's break-glass use is audited as such`.

The known items (b) HG-7 and (c) staff sign-in are recorded as OPS-SR-12 and OPS-SR-13 in the
register (section 5) and explained in section 6.

## 4. Cross-cutting checklist

| Area | Status | Reference |
|---|---|---|
| Authorisation (server-side capability, ACTIVE only) | Verified; one dual-control gap | 3.1; OPS-SR-04, OPS-SR-18 |
| Scope (platform-wide by design, `:targetOrganizationId`) | Verified | 3.2 |
| Consent (coverage read-only, suppressed, no per-person view) | Verified | 3.11 |
| Audit (same transaction for writes) | Verified for writes; no append-only guard; some reads unaudited | 3.4, 3.5; OPS-SR-03, OPS-SR-05, OPS-SR-11, OPS-SR-21 |
| Reason codes (fixed lists, `^[A-Z0-9_:-]{3,64}$`) | Mostly verified; verification and PATCH organisation gaps | OPS-SR-16 |
| Data minimisation (masking, no academic content) | Verified in new routes; legacy routes expose emails | OPS-SR-06, OPS-SR-07, OPS-SR-08 |
| Suppression below 5 | Verified; duplicated helper | 3.11; OPS-SR-24 |
| No numeric readiness | Verified | 3.11 |
| Error handling (`safeError`, no upstream text) | Verified; generic 500s without reference | 3.10; OPS-SR-15 |
| CSV / formula safety | Not applicable (no CSV on these surfaces) | 3.6, 3.11 |
| Pagination bounds (default 50, max 200, keyset) | Verified on new routes; legacy routes exceed or lack keyset | OPS-SR-07, OPS-SR-25 |

## 5. Open findings register

| ID | Severity | Title | Evidence | Recommended fix | Proving test (to add) |
|---|---|---|---|---|---|
| OPS-SR-01 | High | Replaying 0043 narrows the deletion category CHECK and stops every later migration after the first deletion | `packages/persistence/src/migrate.ts:19-24`; `0043_support_cases.sql:273-276`; `privacy-deletion.ts:75-80` | ADR-035 tracked migration runner | migrate twice after a `LEARNING_ACTIVITY` record exists |
| OPS-SR-02 | High | Assistant makes a synchronous external model call in a request handler, with no flag | `apps/api/src/http/assistant.controller.ts:102`; `apps/api/src/assistant/assistant.service.ts:107-124` | Disable behind a default-off flag until orchestration and AWS; stop logging question text | chat refuses while flag off |
| OPS-SR-03 | Medium | `audit_events` (and grant rows) have no append-only guard | `0001_identity_organization_persistence.sql:130-142`; `0039_internal_capabilities.sql:104-107` | New migration: refuse UPDATE/DELETE on `audit_events`, DELETE on `membership_capabilities` | audit events cannot be updated or deleted |
| OPS-SR-04 | Medium | Revoking the second approver re-arms the solo safeguard | `internal-capabilities.ts:266-272`; `operation-approvals.ts:371`; `0038:191-193` | Record approver count at request time; dual-control approver revocation | solo refused after revocation |
| OPS-SR-05 | Medium | Support case queue returns summaries and subject IDs without audit | `operations-support.controller.ts:121-147`; `support-cases.ts:320-325` | Drop summaries from the list or audit the listing | queue returns no summaries / listing audited |
| OPS-SR-06 | Medium | Legacy `GET /operations/users-access` exposes unmasked emails, unaudited, unused | `operations-institution-onboarding.controller.ts:274-312` | Remove the route and `apps/web/src/api/operations.ts:59-62` | route no longer exists |
| OPS-SR-07 | Low | Invitation inventory shows unmasked student recipients and provider references | `operations-institution-onboarding.controller.ts:314-342` | Mask, drop provider fields, keyset | inventory masks student recipients |
| OPS-SR-08 | Low | Account search can enumerate every account through a 3-character term | `operations-support.controller.ts:263-269`; `support-cases.ts:466-468` | Longer term or cap pages per term | broad partial term refused |
| OPS-SR-09 | Low | A case can be opened about an erased person | `support-cases.ts:120-123` | Refuse `SUPPORT_ACCOUNT_DELETED` | case about erased person refused |
| OPS-SR-10 | Low | A reveal's `caseId` need not concern that person | `support-cases.ts:607-610` | Require case subject = user | reveal with another person's case refused |
| OPS-SR-11 | Low | Hold list returns free-text detail and subject IDs, unaudited | `privacy-operations.ts:290-329` | Drop detail from the list | holds listed without detail |
| OPS-SR-12 | Medium | No production sender: solo notices and job alerts are NOT_DELIVERED (HG-7) | `operation-approvals.ts:304-310`; `jobs-health.ts:521-523` | Configure the sender (HG-7) before relying on solo approval | solo notice QUEUED once the workflow is active (exists: `jobs-health.integration.test.ts` › `queues one ops-failure email per platform staff member only when the workflow and an approved template exist`) |
| OPS-SR-13 | Medium | Staff sign-in (ADR-025 step 3) not built; internal roles still sign in without MFA | `apps/api/src/runtime-auth.ts:30-37`; `docs/ops/runbook-staff-pool.md:220-265` | Build the staff sign-in entry, then re-bind and enforce | end-to-end staff sign-in keeps internal roles only via staff pool |
| OPS-SR-14 | Low | Four write routes accept unknown body fields | `operations-outbox.controller.ts:102-112,161-173`; `operations-privacy.controller.ts:231`; `operations-institution-onboarding.controller.ts:198-203` | Allow-list bodies | unknown fields refused |
| OPS-SR-15 | Low | Unmapped errors give a generic 500 without a correlation ID | `operations-institution-onboarding.controller.ts:167,210,223-225`; `operations-outbox.controller.ts:134`; `operations-privacy.controller.ts:266` | Map to 404/409; global safe filter | unknown organisation gives 404 with reference |
| OPS-SR-16 | Low | Verification reasons not from a fixed list; PATCH organisation has no reason | `operations-institution-onboarding.controller.ts:154-189,199-200` | Fixed lists; require reason | unlisted verification reason refused |
| OPS-SR-17 | Low | Break-glass use is resolved but never audited | `internal-capabilities.ts:166-195` | Audit `break_glass: true` with the first break-glass route | break-glass use audited |
| OPS-SR-18 | Low | Granter authority read outside the grant transaction | `operations-staff.controller.ts:152`; `platform-controls.ts:383-392` | Re-check under lock | grant refused after granter loses CAPABILITY_ADMIN |
| OPS-SR-19 | Low | Suspension keeps internal grants; reactivation restores them | `internal-capabilities.ts:189`; `0039:128-132` | Revoke on leaving ACTIVE (new migration) | grants revoked on suspension |
| OPS-SR-20 | Low | Identity lookup by `sub` only, not bound to issuer | `principal.ts:86`; `identity-authentication.ts:28-40` | Match (issuer, sub) | staff-pool sub never resolves a student identity |
| OPS-SR-21 | Low | Client-supplied correlation IDs are written into audit | `api-security.ts:385-389` | Server-generated IDs; client value kept separately | audit correlation ids are server-generated |
| OPS-SR-22 | Low | No flag marked high-risk; `allow-free-mail` switches without approval | `0038:20-23`; `0041:141` | Mark AI/safety flags in their migrations | AI and safety flags carry a direction |
| OPS-SR-23 | Low | Access-request limiter: X-Forwarded-For trust untested; domain limit can block a company and leaks volume | `employer-access-requests.controller.ts:62,128-131,266-281` | Configured trusted proxies; silent domain limit; unit tests | `clientAddress` ignores XFF from a public peer |
| OPS-SR-24 | Low | Two suppression helpers with separate thresholds | `privacy-console.ts:32,42`; `operations-overview.ts:72,84` | One helper | uses one shared threshold |
| OPS-SR-25 | Low | Legacy `GET /operations/outbox/failed`: limit 500, no keyset, returns aggregate IDs | `operations-outbox.controller.ts:54-63` | Remove | route no longer exists |
| OPS-SR-26 | Low | Organizations Edit prompt nulls address fields | `apps/web/src/rolePortal/operations.tsx:87-91`; `operations-institution-onboarding.controller.ts:952-969` | Send and write only changed fields | editing the city keeps the address |

## 6. Known open items from the progress logs

These are not defects of the M1 console code, but they block go-live. Each has an ID above.

| Item | Finding | Pointer |
|---|---|---|
| (a) ADR-035 migration runner not on this base; 0043 re-declares `privacy_deletion_category_ck` and 0047 widens it | OPS-SR-01 | `packages/persistence/src/migrate.ts:19-24`; `0043_support_cases.sql:273-276`; `0047_learning_attempt_log.sql:136-144` |
| (b) HG-7: no production email sender; the solo approval notice and job alerts are recorded NOT_DELIVERED | OPS-SR-12 | `docs/ops/OPS_PROGRESS.md:233-234,461`; `operation-approvals.ts:304-310`; `jobs-health.ts:521-523` |
| (c) OPS-07: staff sign-in entry (ADR-025 step 3) not built; enforcement cannot go live; re-binding is hand-run SQL | OPS-SR-13 | `docs/ops/OPS_PROGRESS.md:764-768`; `docs/ops/runbook-staff-pool.md:220-265` (Part D prerequisite, Part E SQL at 251); `deploy/scripts/preflight-production.sh:66-72` |
| (d) Legacy `GET /operations/users-access` and `GET /operations/outbox/failed` left in place, unused | OPS-SR-06, OPS-SR-25 | `docs/ops/OPS_PROGRESS.md:358,480` |
| (e) Organizations Edit prompt can null address fields | OPS-SR-26 | `apps/web/src/rolePortal/operations.tsx:87-91` |
| (f) In-app assistant synchronous Anthropic call | OPS-SR-02 | `apps/api/src/assistant/assistant.service.ts:113` |
| (g) `suppressSmallCount` and `suppressPeopleCount` | OPS-SR-24 | `docs/ops/OPS_PROGRESS.md:677` |

## 7. Residual risks

None are recorded in this slice. Under program rule B.2, a residual risk is recorded only after the
fix for its finding has merged. Every item above remains an open finding until then.
