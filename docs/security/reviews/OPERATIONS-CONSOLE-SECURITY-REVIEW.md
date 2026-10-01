# Operations Console Security Review (OPS-17 full)

> This is the go-live security review of the Operations console that OPS-17 requires (Appendix 1,
> OPS-17 item 3). It goes threat by threat over every operations module shipped so far. For each
> control it states where the control lives in code and which test proves it. A control without a
> test, or a defect found while reading, is an open finding. Since the full review, every threat
> maps either to a proving test or to an entry in **Residual risks** (§7).
>
> The review exists so that the console's security claims can be checked against code, not against
> design notes.

- **Review target:** base commit `719eb34` (`onev4/feat/plan-phases-0-to-2`), branch `docs/doc-2`.
- **Date:** 2026-10-01.
- **History:**
  - The M1 slice was written on 2026-09-26 against `6864332`. Its §3.1–3.12 text is kept.
  - Every M1 finding was re-verified on `719eb34`; the register (§5) carries each one's status now.
  - Line numbers from 6864332 that moved are mapped in §9.
  - The modules added since M1 are reviewed in §3.13 (sections 3.13.1–3.13.12).
- **Method:** code reading only. Every claim cites `path:line` relative to the repository root and
  the test that exercises it (`spec file › test name`, found by grep). The design notes in
  `docs/architecture/` and `docs/ops/OPS_PROGRESS.md` were read for intent and checked against the
  code; where they disagree, the code is what is reported. No test was run for this review.
- **Scope, M1 (§3.1–3.12):**
  - OPS-01 internal capabilities, OPS-02 dual control and OPS-03 Overview.
  - OPS-04 jobs console, OPS-05 support desk and account lookup, and OPS-06 privacy console.
  - OPS-07 staff-pool readiness.
  - The EMP-04 employer access request queue, including the public
    `POST /api/v1/employer-access-requests`.
  - The organisation verification and suspension route.
- **Scope, added for OPS-17 full (§3.13):**
  - OPS-08 role catalogue.
  - OPS-09a–d content editors and bulk import, plus the content archive action.
  - OPS-10 faculty reviewers (CONTENT_REVIEW_EXTERNAL).
  - OPS-11 role demand, OPS-12 AI Operations and OPS-13 engine health panels.
  - OPS-14 college health and account fields, OPS-15 access reviews, and OPS-16 incidents and
    status notices.
  - Trust and Safety, and audit search.
  - The operations side of EMP-13/14 (flags), EMP-16 (employer terms, trust-case statements),
    INST-18 (college data terms, exits, purge) and GROWTH-01 (Growth team).
- **Out of scope:**
  - Institution-side and employer-side routes, except where an operator route calls them. Those
    have their own reviews in this folder.
  - The Growth portal's own pages.
  - The Android app. It has no operator screens: its only operations call is the read-only
    `GET /operations/overview`, and it labels status notices in the staff inbox.

## 1. Conclusion

### On base `719eb34` (OPS-17 full)

The capability model, dual control and suppression rules hold across every module added since M1.
Each new module checks a named capability on the server. Each writes its audit row in the same
transaction as the change, and each rejects unknown fields. Each publish or switch-on that the plan
puts under dual control is bound to a payload hash and consumed once. Faculty reviewers see only
their own assigned drafts, never an answer key and never a student, and that is tested across
colleges. No numeric readiness appears on any operator surface.

**Re-verification of the 26 M1 findings:**

| Status | Findings |
|---|---|
| Fixed (3) | OPS-SR-01 (High, by the ADR-035 migration ledger), OPS-SR-17 (break-glass is now audited on every route that can reach it) and OPS-SR-24 |
| Partly fixed (4) | OPS-SR-02 (High: the assistant is off by default and has a console off switch, but when enabled it is still a synchronous call that logs question text), OPS-SR-12, OPS-SR-19 and OPS-SR-22 |
| Open (19) | All the others |

**New findings:** this review opens **15 new findings**: 3 Medium and 12 Low.

**Open findings now:** **38 open or partly open findings.** 1 High (OPS-SR-02, partly fixed),
9 Medium and 28 Low.

**The most important open items:**

- **OPS-SR-03 (Medium):** `audit_events` is still not append-only. It now matters more than at M1,
  because the content editors decide who counts as a contributor (and so who may not review or
  publish) from audit rows.
- **OPS-SR-28 (Medium, new):** Trust and Safety enforcement actions are written with no reason, no
  audit row, no approval and no lock, and nothing acts on them. Journey J5's "enforcement with
  approval" is therefore not met.
- **OPS-SR-27 (Medium, new):** the role-demand dashboard's release-label totals let a suppressed
  role count be recovered by subtraction.
- **OPS-SR-04 and OPS-SR-30 (Medium):** both solo safeguards (OPS-02 approvals and OPS-15 access
  reviews) read the reviewer or approver count at decision time. Revoking the other person re-arms
  solo.

### M1 slice conclusion (2026-09-26, base `6864332`)

The core controls are sound and mostly tested. Capability checks are server-side pure functions.
The database repeats the grant rules and the dual-control rules, so a second writer cannot skip
them. Approvals are bound to a payload hash, expire on the database clock and are consumed in the
action's own transaction. Support contacts are masked, and reveals are audited in the same
transaction as the read. Counts of fewer than 5 people are suppressed on the server. No numeric
readiness appears anywhere on these surfaces.

The M1 slice left **26 open findings: 2 High, 6 Medium and 18 Low.** The two High findings were:

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

Added for OPS-17 full (base `719eb34`):

- API controllers:
  - `operations-career-catalogue`, `operations-skill-map`, `operations-question-bank`,
    `operations-lessons`, `operations-content-import` and `operations-external-reviews`;
  - `institution-content-reviews`, `operations-analytics`, `operations-college-health` and
    `operations-ai`;
  - `operations-jobs` (engine-health) and `operations-access-reviews` (with `access-review-csv.ts`);
  - `operations-incidents`, `operations-communications`, `trust-safety`, `employer-trust-cases`
    and `operations-audit`;
  - `operations-employer-terms`, `operations-institution-exits` and `operations-growth-team`;
  - `platform-controls` (flags);
  - all of the above are `.controller.ts` files under `apps/api/src/http/`.
- Packages:
  - `packages/authorization/src/` rules: `career-catalogue`, `skill-map`, `question-bank`,
    `lesson-editor`, `content-import`, `content-archive`, `external-review`, `role-demand`,
    `college-health`, `ai-operations`, `engine-health`, `access-reviews`, `incidents`,
    `growth-roles`, `aggregate-suppression` and `high-risk-actions`.
  - The matching persistence modules under `packages/persistence/src/`.
  - `packages/career-readiness/src/{question-bank,external-review,content-import}.ts`.
- Migrations:
  - `0051`, `0057`, `0061`, `0065`, `0066`, `0078`, `0079`, `0081`, `0084`, `0088`, `0089`,
    `0090`, `0091`, `0093` and `0098` (flags);
  - `0029` (feature flags) and `0032` (trust cases).
- Web screens:
  - `careerCatalogue`, `skillMap`, `questionBank`, `lessons`, `contentImport` and `externalReviews`;
  - `roleDemand`, `collegeHealth`, `aiOperations`, `engineHealth` and `accessReviews`;
  - `incidents`, `communications`, `trustSafety` and `growthTeam`;
  - `operations.tsx` (flags, audit, terms) and `operationsInstitutionExits`;
  - all under `apps/web/src/rolePortal/`.
- Tests: every integration spec and unit test named in §3.13 (found by grep).

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
  - Recording a break-glass use in audit: **built since M1**. Every route that break-glass can reach
    now writes `break_glass: true`; see OPS-SR-17, which is now FIXED.
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

- **OPS-SR-04 (Medium, still OPEN on `719eb34`) — Revoking an approver re-arms the solo safeguard at once.**
  - Re-verified:
    - The decision still reads the live approver count (`operation-approvals.ts:442` →
      `countHighRiskApprovers` :340-342).
    - No approver count is stored on the request (`createOperationApproval`,
      `operation-approvals.ts:110-145`).
  - **New second path:** an OPS-15 access-review REVOKE (`packages/persistence/src/access-reviews.ts:523`
    → `revokeInternalCapabilityWithin`) can remove another approver's `APPROVE_HIGH_RISK`, again with
    no approver-count protection.
  - The original finding text follows. Revoking a grant
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
- **OPS-SR-19 (Low, PARTLY FIXED on `719eb34`) — Suspension leaves internal grants live.**
  - The only API that suspends a platform membership, the OPS-15 access review, now revokes its
    grants in the same transaction (`packages/persistence/src/access-reviews.ts:534-575`).
  - Proving test: `access-reviews.integration.spec.ts` › `suspends a platform role at once,
    revoking its grants, audited with the campaign reference`.
  - Still missing: the database trigger. Hand-run SQL can still leave grants live.
  - The original text follows. Grants count only while the
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

- **OPS-SR-03 (Medium, still OPEN on `719eb34`) — `audit_events` has no append-only guard in the database.**
  - Re-verified: no migration up to 0098 adds a trigger. The guard re-created in 0091 (`:198-201`)
    still fires on INSERT OR UPDATE only.
  - Since M1 this matters more. The skill, question and lesson editors derive *contributors* from
    audit rows (`skill-map.ts:317-323`, `question-bank.ts:371-378`, `lesson-editor.ts:392-399`),
    and contributors may not review or publish. Deleting a `*_draft_saved` or submit row would
    therefore lift that separation of duties. Only the original author is guarded in the database
    (0057/0061/0065 author-publish guards).
  - The original text follows. The table has
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

- **M1 slice:** there was no operator export. The privacy console shows only an export request's
  state and expiry, never its content (`apps/web/src/rolePortal/privacyConsole.tsx:200`).
- **Since M1 there are operator exports. Each is checked in §3.13:**
  - **OPS-15 access-review CSV** (`operations-access-reviews.controller.ts:204-225`). It covers staff
    and faculty emails and no student data. Its controls:
    - gated by `SECURITY_ACCESS_REVIEW`;
    - reason-coded;
    - audited with row count and SHA-256 before it is sent;
    - every cell quoted, and formula-leading cells neutralised by `csvCell`
      (`institution-export-csv.ts:20-32`);
    - `no-store` and `nosniff`.

    Tests:
    - `access-reviews.integration.spec.ts` › `exports CSV that reproduces the campaign exactly, and
      audits the export with its hash`;
    - `employer-applicant-export.test.ts` › `builds exactly the committed fixture, neutralising
      formula-leading cells, with the hash of the exact bytes` (the shared `csvCell`).

    There is no row cap; the export is bounded by the campaign's size. It may be exported while the
    campaign is still open (OPS-SR-40).
  - **INST-18 college exit export.** It is owner-only, issued by the college rather than by an
    operator, and sits outside this review (see the institution portal review).
  - **No operator export of personal data in bulk exists.** That is why §5.4's "bulk personal-data
    export" still has no action key.

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

**§5.4 actions, on `719eb34`**

- **Now gated:**
  - `CAREER_REQUIREMENT_SET_PUBLISH`, `CONTENT_SKILL_PUBLISH`, `CONTENT_QUESTION_PUBLISH` and
    `CONTENT_LESSON_PUBLISH` (OPS-08/09);
  - `AI_FEATURE_ENABLE` and `AI_FEATURE_LIMITS_RAISE`, plus the kill-switch release as a high-risk
    flag change (OPS-12);
  - `COMMS_TEMPLATE_PUBLISH` (OPS-16) and `INSTITUTION_DATA_PURGE` (INST-18).
  - All are listed at `high-risk-actions.ts:19-45`, and §3.13 covers each one.
- **Still with no endpoint or key:** any bulk export containing personal data (see 3.6).
- **Has an endpoint but is not gated:** Trust and Safety enforcement actions (OPS-SR-28).

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

- M1: none. OPS-10 was not built then.
- **Since M1, OPS-10 is built.** CONTENT_REVIEW_EXTERNAL can now be granted and used, and the full
  check is in §3.13.4. In short:
  - assignment-scoped reads;
  - cross-college refusal;
  - no student data and no answer key;
  - no publishing.

  All of these are tested. Faculty are deliberately not gated by the staff pool (a recorded
  decision; residual risk R-14). Open item: **OPS-SR-37**.

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

- **OPS-SR-24 (Low) — FIXED in e2da7ea.** There is now one rule, in
  `packages/authorization/src/aggregate-suppression.ts:24,34-38`. Test: `aggregate-suppression.test.ts`
  › `is the helper the privacy console and the Overview use, with one threshold of 5`. The original
  text follows. Two helpers implemented the same suppression rule. `suppressSmallCount` and
  `suppressPeopleCount` each carry their own threshold constant, so the rule can drift between
  screens.
  - Evidence:
    - `packages/authorization/src/privacy-console.ts:32,42`
    - `packages/authorization/src/operations-overview.ts:72,84`
  - Fix: keep one helper and one threshold, exported once.
  - Proving test: `operations-overview.test.ts` › (new) `uses the one shared threshold`.

### 3.12 Other findings (outside the console threat list, but on this base)

- **OPS-SR-01 (High) — FIXED in b0d133e (ADR-035 migration ledger).** `migrate.ts:17-20` now calls
  `runMigrations`, and `migration-runner.ts` records applied files in `schema_migrations`. Tests:
  `migration-runner.integration.test.ts` › `keeps a later widening once a row uses it — the case
  replaying every file broke` and › `applies the repository migrations to an empty schema, then none
  on a second run`. The original text follows. Replaying 0043 broke `db:migrate` after the first
  completed deletion.
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
- **OPS-SR-02 (High) — PARTLY FIXED (94ce3d9; 77afac3).**
  - **Fixed:** the assistant is off unless `ASSISTANT_ENABLED=true`
    (`assistant.service.ts:97,100-102,117`). It also needs the flag `ai.assistant` (default off,
    high-risk to enable) and the kill switch released (`assistant.controller.ts:88-103`;
    `persistence/src/ai-operations.ts:678-684`, failing closed). Tests:
    - `assistant.service.spec.ts` › `is off by default when ASSISTANT_ENABLED is not set, even with a key`;
    - `assistant.service.spec.ts` › `stays switched off with an API key unless it is explicitly
      enabled, and never calls the model`;
    - `operations-ai.integration.spec.ts` › `stays off by default even with ASSISTANT_ENABLED and a
      key set, and the console switches it off without a restart`.
  - **Still open:** when enabled, it is a synchronous `fetch` to the provider from the handler
    (`assistant.service.ts:123`), and it bypasses ONE AI Orchestration. The handler still logs the
    first 300 characters of the question and of the feedback question (`assistant.controller.ts:128,151`).
  - The original text follows. The in-app assistant called an external model synchronously from a
    request handler. `POST /api/v1/assistant/chat` calls `api.anthropic.com` synchronously. The call is
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
- **OPS-SR-17 (Low) — FIXED (per route; first in 9d2ca6e, then 30174af, 89a74bc, 9b93941, d10acd5,
  62bce8f and 77afac3).**
  - Every route that the break-glass set (`internal-capabilities.ts:126-128`) can reach now computes
    `resolveInternalCapability(...) === 'BREAK_GLASS'` and writes `break_glass: true`. These are the
    catalogue, skill map, question bank, lessons, content import, external reviews and AI routes.
  - Tests:
    - `operations-career-catalogue.integration.spec.ts` › `audits the super admin as break-glass`;
    - `external-reviews.integration.spec.ts` › `marks a super admin assignment as break-glass`;
    - `operations-ai.integration.spec.ts` › `audits the super admin configuring AI as break-glass,
      and an ordinary grant holder as not`.
  - The skill map, question bank, lessons and import have no break-glass integration assertion
    (residual risk R-15).
  - The original text follows. Break-glass use was not audited (§5.1). `resolveInternalCapability` returns
  `BREAK_GLASS`, but nothing outside the package calls it and no audit row carries
  `break_glass: true`. No live endpoint is reached through break-glass today (the design note,
  lines 104-106), so this is latent until OPS-08, OPS-09 or OPS-12.
  - Evidence: `packages/authorization/src/internal-capabilities.ts:166-195`
  - Fix: a guard that returns the source and writes `break_glass: true` in the action's audit
    context; ship it with the first break-glass route.
  - Proving test: (new) `a super admin's break-glass use is audited as such`.

The known items (b) HG-7 and (c) staff sign-in are recorded as OPS-SR-12 and OPS-SR-13 in the
register (section 5) and explained in section 6.

### 3.13 Modules added since M1 (base `719eb34`)

Each module below is reviewed against the plan's eight threats:
1. privilege escalation;
2. IDOR;
3. mass assignment;
4. audit tampering;
5. personal-data exposure;
6. export abuse;
7. dual-control bypass;
8. cross-tenant reviewer access.

"n/a" gives the reason a threat does not apply. Every control cites code, and every test is
`spec › title`.

Some facts hold for every module and are not repeated:
- Capabilities are resolved by `hasInternalCapability` over ACTIVE memberships only
  (`packages/authorization/src/internal-capabilities.ts:200-214`).
- `audit_events` itself is not append-only (OPS-SR-03).
- No module computes, shows or exports a numeric readiness value.

**Capability baselines that matter here** (`internal-capabilities.ts:15-112`):
- No role holds `CATALOGUE_MANAGE`, `CONTENT_EDIT`, `CONTENT_REVIEW`, `CONTENT_PUBLISH` or
  `AI_OPS_CONFIGURE` by baseline. The super admin holds them only as break-glass (`:126-128`).
- `CONTENT_PUBLISH`, `AI_OPS_CONFIGURE` and `GROWTH_FINANCE` are high-risk to grant (`:50-59`).
- `INCIDENT_MANAGE` is held by SECURITY_ADMIN and the super admin.
- `COMMS_TEMPLATES`, `ACCOUNT_MANAGE` and `ANALYTICS_VIEW` are held by OPERATIONS_ADMIN and the
  super admin.

#### 3.13.1 Job-role catalogue (OPS-08)

Routes: `apps/api/src/http/operations-career-catalogue.controller.ts:90-263`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Per-write capability (`:297-309`; `packages/authorization/src/career-catalogue.ts:57-61,81-85,102-118`); reviewer ≠ author in the API and as a CHECK (`0051_career_catalogue.sql:255-256`) | `operations-career-catalogue.integration.spec.ts` › `each write needs its own capability`; › `403 without a catalogue capability, for platform roles and an institution admin alike`; › `refuses a self-review over HTTP, and a publish request for a set nobody reviewed`; `career-catalogue.test.ts` › `lets the super admin in only as break-glass (no baseline role holds catalogue capabilities)` |
| IDOR | UUID check and 404 (`:380`, mapping `:349-367`) | › `shows a role with its planning data, live requirements and a suppressed target count, never a student` |
| Mass assignment | Body allow-lists (`:165,202,217,233,268,320`); formula-leading synonyms refused (`:167`) | › `needs a listed reason, refuses formula text and duplicates, and audits add and remove` |
| Audit tampering | Audit row in the same transaction as each write (`persistence/src/career-catalogue.ts:567-600,641-694,836-886`); sets never deleted and items frozen after submit (`0051:307-362`) | › `needs a listed reason, refuses formula text and duplicates, and audits add and remove`; `audit_events` itself → OPS-SR-03 |
| Personal data | The live-target count is suppressed below 5 (`persistence/src/career-catalogue.ts:477-479,898-902`, f187e03; the OPS-11 log note that it is unsuppressed is out of date). No student is returned | › `shows a role with its planning data, live requirements and a suppressed target count, never a student` |
| Export abuse | n/a: no export | — |
| Dual-control bypass | Every publish needs `CAREER_REQUIREMENT_SET_PUBLISH`, bound to {setId, releaseLabel, reasonCode} (`operation-approval-gate.ts:32-33`); the database refuses PUBLISHED without an executed approval for that set (`0051:345-354`) | › `cannot go live without review by someone else and an approval, and goes live exactly as approved`; › `refuses an expired approval, and verifies a role only through an approved publish` |
| Cross-tenant | n/a (platform data); an institution admin gets 403 | › `403 without a catalogue capability, …` |

New finding: **OPS-SR-35** (the set's author is not refused at the publish step).

#### 3.13.2 Skill map, question bank, lessons and variants, archive (OPS-09a–c, OPS-GAPS)

Routes:
- `operations-skill-map.controller.ts:95-246`;
- `operations-question-bank.controller.ts:104-257`;
- `operations-lessons.controller.ts:104-283`.

Spec abbreviations: SM, QB and LE are the three `*.integration.spec.ts` files.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Per-move capability (`authorization/src/skill-map.ts:52,63-65`; `question-bank.ts:48-59`; `lesson-editor.ts:61-65`). Contributors never review or publish (skill: author and savers, `persistence/src/skill-map.ts:317-323`; question and lesson: also submitters, `question-bank.ts:371-378`, `lesson-editor.ts:392-399`). A lesson's approver never publishes (`lesson-editor.ts:111-120`). The author-publish guard is a trigger (0057/0061/0065) | SM › `rejects self-review by the author, and by anyone who edited the draft`; SM › `the author never publishes their own skill, even holding CONTENT_PUBLISH`; QB › `refuses a publisher who wrote, edited or submitted the revision, at the request and at publish`; LE › `refuses a publisher who wrote, edited or submitted the revision, and the approver, at the request and at publish`; SM › `403 without a content or catalogue capability, and for an institution member` |
| IDOR | UUID check, 404 | SM › `400 on invalid input: key, unknown fields, levels, limits, cursor and filter`; QB › `400 on invalid input: key, topic, unknown fields, options, hints, limits, cursor and filter; 404 for unknown`; LE › `400 on invalid input; 404 for unknown` |
| Mass assignment | `readObject` / `rejectUnknown` on every body and query | the same three tests |
| Audit tampering | Audit row in the same transaction (`skill-map.ts:846-853` and equivalents). Published content cannot change (0061:115-124; 0065:24-36). Archive allows only PUBLISHED → ARCHIVED with the ARCHIVE action recorded (`0090:130-166`) | SM › `a live topic moves only to a published revision of itself, and goes live only on published content`; SM › `a published revision takes one change only, to ARCHIVED with its ARCHIVE action recorded, and an archived one none`. The contributor rule depends on audit rows → OPS-SR-03 |
| Personal data / **answer keys** | The key is returned only with `CONTENT_EDIT` or `CONTENT_REVIEW` (`question-bank.controller.ts:153,247,273`; `career-readiness/src/question-bank.ts:211-218`); `toLearnerQuestionDto` strips it (`career-readiness/src/index.ts:149-152`) | QB › `are withheld from a publisher-only reader and shown to editors and reviewers`; QB › `never reach a learner: a republished pilot question supersedes its old version and the check strips the key`; `career-readiness/test/question-bank.test.ts` › `never lets the answer key, explanation, tags, hints or difficulty reach a learner DTO` |
| Export abuse | n/a: no content export | — |
| Dual-control bypass | `CONTENT_SKILL_PUBLISH` (when readiness inputs change), `CONTENT_QUESTION_PUBLISH` (always), `CONTENT_LESSON_PUBLISH` (base lesson first publish, topic or prerequisites). Each is bound to {revisionId, contentHash, reasonCode} (`operation-approval-gate.ts:32-42`) | SM › `a first publish needs CONTENT_PUBLISH, a non-author publisher and an approval for the exact payload`; QB › `publishes only with an approval bound to the revision, hash and reason; writes the version, the key, the tags and the ladder`; LE › `a first publish needs an approval bound to the revision, hash and reason, and writes the lesson version students complete` |
| Cross-tenant | n/a (platform content); see 3.13.4 for faculty | — |

**Archive.** Archiving needs `CONTENT_PUBLISH` and a listed reason, with no second person
(`authorization/src/content-archive.ts:15-27`). It is refused while live content depends on the
item.
- Tests: SM › `needs CONTENT_PUBLISH and a coded reason, then retires the skill and keeps its
  publication record`; QB › `stops serving an archived question at once, keeps it for attempts that
  hold it, and records why`.
- The single-person removal is accepted as residual risk R-1.

**Native-speaker gate.** A non-English lesson cannot be approved without
`NATIVE_SPEAKER_REVIEWED` or `NATIVE_SPEAKER_CONSULTED`.
- Test: `lesson-languages.integration.spec.ts` › `cannot be approved without a native-speaker
  review, which is recorded with the rights review`.

New finding: **OPS-SR-34** (a skill's submitter is not a contributor).

#### 3.13.3 Content bulk import (OPS-09d)

Routes: `operations-content-import.controller.ts:66-97`. Capability: `CONTENT_EDIT` only
(`authorization/src/content-import.ts:23-25`).

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Only `CONTENT_EDIT`. The importer is the author of every row, so the contributor rule then blocks them from reviewing or publishing | `operations-content-import.integration.spec.ts` › `403 for anyone without CONTENT_EDIT, on every endpoint`; › `the importer can never review or publish what they imported` |
| IDOR | n/a: no ids in the path | — |
| Mass assignment | Request allow-list; unknown columns and JSON fields are refused as row or file problems | › `400 for malformed requests, before anything is evaluated`; › `refuses unknown columns as a file problem and writes nothing`; › `refuses unknown JSON fields on their row and writes nothing` |
| Audit tampering | `operations.content.import_committed` is written in the commit transaction (`persistence/src/content-import.ts:268-274`). The commit is bound to the preview digest | › `imports skills in prerequisite order, all DRAFT, authored and audited`; › `refuses a commit whose file differs from the preview (stale digest) and writes nothing` |
| Personal data / answer keys | The validation report never carries row text | › `imports questions with answer keys, hints and misconception tags — and no answer leaves the content tables`; `career-readiness content-import.test.ts` › `never carries row text, so never an answer key` |
| Export abuse | n/a: upload only. Imported text is not formula-escaped, which is harmless while no content CSV export exists (residual risk R-10) | — |
| Dual-control bypass | Nothing is published: every row lands as DRAFT | › `reports every bad row, then refuses the commit with nothing written` |
| Cross-tenant | n/a | — |

Operational note (not a security finding): the 100 KB request-body default answers 413 for a
non-ASCII file below the 90,000-character cap. This is recorded in the SOP.

#### 3.13.4 Faculty reviewers — cross-tenant reviewer access (OPS-10)

Routes:
- operator: `operations-external-reviews.controller.ts:81-209`;
- faculty: `institution-content-reviews.controller.ts:47-68`.

Spec abbreviations: ER = `external-reviews.integration.spec.ts`; ERU =
`packages/authorization/src/external-review.test.ts`.

| Threat | Control | Test |
|---|---|---|
| **Cross-tenant reviewer access** | Faculty reads are scoped to reviewer = caller, college = path college, and membership among the caller's eligible memberships (`persistence/src/external-reviews.ts:597-601`). The scope applies to the list (`:633`), the detail (`:644`) and the decision lock (`:677`). Another college's path gets an opaque 403 (`institution-content-reviews.controller.ts:107-118`) | ER › `sees only their own assignments, and a question without its answer key, hints or any student`; ER › `403 on the faculty side without the grant, for another role, and in another college` |
| No student data, no key | Content is a whitelist: a question shows prompt, options, difficulty and skill, and no key or hints (`career-readiness/src/external-review.ts:55-89`). Content is shown only while the assignment is OPEN (`persistence :647`) | ER › same test as above; `career-readiness/test/external-review.test.ts` › `shows the prompt, option texts, difficulty and skill, and never the key, tags, hints, rights or provenance`; ER › `expires an assignment: no draft, no decision (API and trigger)`; ER › `loses access when an assignment is withdrawn or the grant is revoked`; ER › `loses access when the college ends the membership` |
| Privilege escalation | Granting needs `CAPABILITY_ADMIN`. Self-grant is refused in the API and the database (`external-review.ts:97-100`; `0091:186-192`). Only FACULTY_LECTURER or DEPARTMENT_HEAD can hold the grant (`0039:87-90`). The grant cannot come from Settings. Faculty cannot publish: the decision is advice only (`persistence :689-693`). Assigning needs `CONTENT_REVIEW`; contributors are refused at assign and at decision; the author is refused by trigger; assigner ≠ reviewer is a CHECK (`0066:37,120-122`) | ER › `refuses non-administrators, ineligible memberships, a second grant, a self-grant and unlisted reasons`; ER › `keeps the Settings staff screen from granting it, as OPS-01 left it`; ER › `records an advisory decision, audited; the revision stays in review and publishing stays internal`; ER › `refuses contributors: an editor cannot assign, and an author cannot be the reviewer (API and trigger)`; ER › `403 on the operator side for plain operations, institution staff and faculty reviewers` |
| IDOR | UUID check and 404 | ER › `refuses non-administrators, …` (random membership 404); ER › `assigns an item set to a granted reviewer, audited, and refuses what the rules refuse` |
| Mass assignment | Allow-lists (operator `:127,146,189,214`; faculty `:80`). Times are stamped by trigger and identity columns are immutable (`0066:107,127-148`) | ER › `paginates the operator list with bounds`; the `extra` field is refused in the grant, assign and decision tests |
| Audit tampering | Audit and outbox in the same transaction for each write (`persistence :240-248,302-322,516-524,552-559,695-703`). Assignments are never deleted and move only forward (`0066:95-97,133-164`) | ER › `refuses contributors…` (DELETE refused); ER › `expires an assignment…` |
| Personal data | The decision audit records only the comment's length. Faculty never see the author or other reviewers | ER › `records an advisory decision, audited; …` |
| Export, dual control | n/a: no export. Not high-risk under §5.4 (ADR-037) | — |

Faculty sign in through the ordinary pool (residual risk R-14). New finding: **OPS-SR-37**
(deactivated colleges, and unaudited operator lookups).

The progress log says faculty never see an answer key. That is true of questions. A lesson's
`practice` field is shown to faculty (`career-readiness/src/external-review.ts:80`), and whether
practice text can contain answers was not verified (R-17).

#### 3.13.5 Role demand (OPS-11)

Routes: `operations-analytics.controller.ts:34-69` (`ANALYTICS_VIEW`).

Spec abbreviations: OA = `operations-analytics.integration.spec.ts`; RDU =
`packages/authorization/src/role-demand.test.ts`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Server-side capability | OA › `403 for SECURITY_ADMIN without the capability, an institution admin and a suspended operator`; OA › `200 for OPERATIONS_ADMIN and the super admin by baseline, and for SECURITY_ADMIN once granted ANALYTICS_VIEW` |
| IDOR, mass assignment | No query parameters; UUID check and 404 | OA › `rejects any query parameter on the summary, a malformed role id and an unknown role` |
| Personal data / suppression | `suppressSmallCount`; complementary suppression for breakdowns (`role-demand.ts:132-196`); no breakdown behind a suppressed parent | OA › `never returns a raw count below 5 anywhere in the summary`; OA › `breaks a role down by college and department, withholding what subtraction would reveal`; OA › `returns no breakdown at all for a role whose total is suppressed`; RDU › `withholds the smallest shown cell when the suppressed cells alone could be recovered by subtraction` |
| Audit | Deliberately not audited: aggregate reads only (residual risk R-6) | OA › `writes no audit row for these aggregate reads` |
| Export, dual control, cross-tenant | n/a | — |

New finding: **OPS-SR-27** (Medium). The release-label totals are not suppressed against the role
rows. OA's own expected values show it: SELECTABLE = 411, the shown roles total 408, so the
suppressed role is 3.

#### 3.13.6 College health and account fields (OPS-14)

Routes: `operations-college-health.controller.ts:85-220`.
- Health needs `ANALYTICS_VIEW`.
- Accounts need `ACCOUNT_MANAGE`.

Spec abbreviation: CH = `operations-college-health.integration.spec.ts`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Separate capabilities per module (`authorization/src/college-health.ts:16-23`). The owner must be an ACTIVE platform operator, checked in the API and the trigger | CH › `403 for SECURITY_ADMIN without a grant, an institution admin and a suspended operator`; CH › `each capability opens only its own module when granted`; CH › `refuses an owner who is not an active AI8HT operator, in the API and in the database` |
| IDOR | Contacts scoped by id and college (`institution-accounts.ts:265,282`). INSTITUTION organisations only | CH › `keeps contacts masked, reveals them only with an audited reason, and erases them on removal`; CH › `400 for any query parameter and a malformed id; 404 for an employer or unknown id` |
| Mass assignment | Allow-lists; optimistic version | CH › `rejects unknown fields, missing or unlisted reason codes, bad values and empty changes, writing nothing` |
| Audit tampering | Audit in the same transaction. A reveal is audited before the value is returned. Accounts and contacts are never deleted or edited in place (`0078:52-54,149-176`) | CH › `keeps contacts masked, …`; CH › `saves renewal date, contract reference and owner with a reason code and an audit row, then refuses a stale version` |
| Personal data | Email and phone are masked (names are not). Removal erases contact data. Health figures are suppressed and complementary-safe; bands only | CH › `counts every figure from its source and suppresses every count of people under 5`; CH › `a college view adds the four-week trend, assessments, staff actions and readiness bands — bands only` |
| Export, dual control, cross-tenant | n/a. No dual control by design (§5.4 lists none; residual risk R-5) | — |

New finding: **OPS-SR-41** (the picker needs `OPS_ORG_MANAGE`; usability and access-model mismatch).

#### 3.13.7 AI Operations and engine health (OPS-12, OPS-13)

Routes:
- `operations-ai.controller.ts:108-310`;
- engine health: `operations-ai.controller.ts:162-171` (`AI_OPS_VIEW`) and
  `operations-jobs.controller.ts:68-74` (`OPS_JOBS_REPLAY`).

Spec abbreviations: AI = `operations-ai.integration.spec.ts`; EH =
`operations-engine-health.integration.spec.ts`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | View, stop and configure are split (`authorization/src/ai-operations.ts:45-61`). Configure needs `AI_OPS_CONFIGURE` (no baseline; break-glass audited) | AI › `lets AI_OPS_VIEW read, keeps configuring to AI_OPS_CONFIGURE, and denies a suspended membership`; AI › `returns 403 to an ACTIVE institution admin on every route, and changes nothing`; AI › `audits the super admin configuring AI as break-glass, and an ordinary grant holder as not`; EH › `403 for an institution admin and for a suspended operations membership` |
| IDOR | Feature-key pattern and 404 (platform resource) | AI › `switches a feature off at once with no approval, audited, and says when it is already off` |
| Mass assignment | Allow-lists. The approval payload is built from database facts, not from the request (`operations-approvals.controller.ts:320-350`) | AI › `records a PASS only when every metric meets its threshold, validates input, and never edits a record`; EH › `400 on a window other than 7, 14 or 30 days, and on unknown query parameters` |
| Audit tampering | Audit, flag event and outbox in one transaction. `ai_evaluations` is append-only (`0089:62-95`) | AI › `records a PASS only…`; `ai-operations.integration.test.ts` › `are append-only, stamped by the database, and a PASS must meet every threshold` |
| Personal data | Usage by organisation is withheld under 5 people. Only true/false for the server variables. Engine panels: counts only, days under 5 withheld, complementary rule, shadow withheld under 5 consenting students | AI › `reports usage by organisation and withholds every figure for a group under 5 people`; EH › `publishes a day only over five students, and withholds the total while a small day could be recovered`; EH › `withholds the whole panel while fewer than five consenting students are in scope`; EH › `shows the same counts as the offline shadow report, with no identifier, once five or more are in scope` |
| Export abuse | n/a | — |
| Dual-control bypass | `AI_FEATURE_ENABLE` is bound to model, prompt and evaluation; `AI_FEATURE_LIMITS_RAISE`; the kill-switch release and assistant-on are high-risk flags (`0089:120-133`). The database refuses enabling without a passing evaluation or while engaged (`0089:144-174`) | AI › `needs an approval bound to the model, prompt and evaluation, from someone other than the requester, used once`; AI › `rejects an approval whose binding changed: a later FAIL, a model change, or expiry`; AI › `stops every AI feature and the assistant in one action with no approval, and releasing it needs one`; AI › `lets the sole approver raise a limit on their own request only after the cooling-off, marked SOLO`; AI › `switches an enabled feature off when its model changes without a passing evaluation (0089 trigger)` |
| Cross-tenant | n/a | — |

Engaging the kill switch needs no approval. This is a deliberate deviation from the plan's "one
approved action": stopping is never delayed (residual risk R-2). New findings: **OPS-SR-31**
(engaging the kill switch through Feature Flags skips the cascade) and **OPS-SR-32** (no
complementary suppression on usage by organisation).

#### 3.13.8 Feature flags, including EMP-13/14

Route: `platform-controls.controller.ts:62-107` (`OPS_FLAGS_MANAGE`).

Flags marked high-risk on `719eb34`:
- `ai.global-kill-switch` (DISABLE) and `ai.assistant` (ENABLE): `0089:120-133`;
- `employer.skill-evidence` (ENABLE): `0093:82-88`;
- `employer.talent-pool` (ENABLE): `0098:273-279`.

Tests:
- `ai-operations.integration.test.ts` › `exists, is not engaged by default, and is high-risk to release`;
- `operations-approvals.integration.spec.ts` › `enables a high-risk feature flag with an approval`.

The open items are OPS-SR-16 (free-text reasons on ordinary changes), OPS-SR-22 (allow-free-mail is
not marked; partly fixed) and **OPS-SR-33** (an ordinary change writes no `audit_events` row).

There is no organisation-override API, so journey J6 is not built and has no security surface.

For the talent pool, publishing the HG-6 consent wording before switching on is a procedural rule,
not a code rule (residual risk R-19).

#### 3.13.9 Access reviews (OPS-15)

Routes: `operations-access-reviews.controller.ts:85-205` (`SECURITY_ACCESS_REVIEW`; mirrored in
`access_review_is_reviewer()`, `0079:118-131`).

Spec abbreviation: AR = `access-reviews.integration.spec.ts`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Reviewer capability, re-checked by triggers (`0079:153,178,243`). Never your own item; solo KEEP only, after 15 minutes. The last super admin is protected | AR › `403 for an operations admin without the grant and for a college admin`; AR › `matches isAccessReviewer for every platform role, with and without a grant, and for inactive memberships`; AR › `never lets a reviewer attest their own access`; AR › `may keep their own access only after 15 minutes, marked SOLO, and never revoke it`; AR › `keeps the last active super admin` |
| IDOR | Item selected by id **and** campaign (`persistence/src/access-reviews.ts:447`) | AR › `validates input before anything is written` |
| Mass assignment | Allow-lists; period, due and timestamps stamped by trigger (`0079:157-160`) | AR › `validates input before anything is written` |
| Audit tampering | Audit and outbox in the same transaction. Revocations carry the campaign reference. Campaigns and items are never deleted; the snapshot is immutable; a decision is made once; a closed campaign is final (`0079:146-265`) | AR › `the database refuses what the API refuses, for any other writer`; AR › `revokes a faculty review grant through the external review path, with the campaign reference` |
| Personal data | Staff and faculty emails only; no student data | AR › `exports CSV that reproduces the campaign exactly, and audits the export with its hash` |
| Export abuse | Reason-coded and audited with the SHA-256 before it is sent; cells are formula-safe (`csvCell`) | AR › same test; residual R-3 (no dual control); **OPS-SR-40** |
| Dual-control bypass | Not OPS-02 (removal is the safe direction, residual R-4) | **OPS-SR-30**: the solo exception can be manufactured inside a campaign |
| Cross-tenant | n/a (platform). College-granted analytics is excluded by design | — |

#### 3.13.10 Incident register and status notices (OPS-16, 0090)

Routes:
- `operations-incidents.controller.ts:97-314` (`INCIDENT_MANAGE`);
- `operations-communications.controller.ts:81-241` (`COMMS_TEMPLATES`).

Spec abbreviation: IN = `operations-incidents.integration.spec.ts`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Capabilities are split between the register and communications | IN › `keeps the register to INCIDENT_MANAGE and notices to COMMS_TEMPLATES`; IN › `denies a suspended platform membership`; IN › `returns 403 to an ACTIVE institution admin for every route` |
| IDOR | UUID check and 404 | IN › `refuses invalid input with 400` |
| Mass assignment | Allow-lists; lifecycle times stamped by trigger (`0081:93-95,150-159`); a notice has no text field | IN › `refuses invalid input with 400`; IN › `cannot be drafted from an unapproved template version, or with free text` |
| Audit tampering | Timeline, audit and outbox in one transaction. `incident_events` is append-only and nothing is deletable (`0081:85-88,208-219`) | IN › `keeps the timeline append-only and incidents undeletable`; IN › `audits the declaration with its reason code, writes the outbox event and the timeline` |
| Personal data | Contact details refused in incident text (`:415-421`). Notices go to owners and admins only, never students; recipient lists are never returned | IN › `is a draft until a person approves it, then reaches the affected college admins only, rate-limited`; `incidents.test.ts` › `refuses an email address or a phone number` |
| Export abuse | n/a: no export | — |
| Dual-control bypass | Template publish via `COMMS_TEMPLATE_PUBLISH`, bound to {templateId, contentHash, reasonCode}; author-only request. Notice approval: drafter ≠ approver, solo after 15 minutes, in the API and the 0090 trigger. The rate limit is applied under a lock | IN › `drafts a version and refuses to publish it without a second person`; IN › `publishes with an executed approval, carrying the approver into notification_templates`; IN › `refuses the drafter's own approval while someone else can approve, and records the second person`; IN › `refuses a second writer that self-approves, or marks a second person's approval as solo (0090 trigger)`; IN › `lets the sole approver approve their own notice after the cooling-off, marked SOLO` |
| Cross-tenant | Only colleges and employers can be affected organisations (`0081:249`) | IN › `names affected colleges, never a platform organisation, and counts them` |

Incident changes are single-operator (residual risk R-9). New finding: **OPS-SR-39**.

#### 3.13.11 Trust and Safety, and audit search

**Trust and Safety** (`trust-safety.controller.ts:58-207`):
- `TRUST_SAFETY_INVESTIGATE`, plus `TRUST_SAFETY_ENFORCE` for actions.
- EMP-16 added request-response and employer statements (`:161,185`). Employer side:
  `employer-trust-cases.controller.ts`.

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Capability checks (`:238-248`). The reporter cannot move a case to DECIDED, ACTIONED, DISMISSED or CLOSED (`0032:158-174`), but that does not cover actions | `operations-capabilities.integration.spec.ts` › `retrofitted operations endpoints keep exactly their previous platform roles` (trust rows); `employer-terms-trust.integration.spec.ts` › `puts the employer response and appeal on the operator case timeline, and never names the reporter`. The self-review trigger has no test (R-18) |
| IDOR | UUID check and 404. The employer side is scoped to its own subject and to disclosed cases (`persistence/src/trust-safety.ts:410-419,506-508`) | `employer-terms-trust.integration.spec.ts` › `shows an employer only the cases about itself, with its own job evidence` |
| Mass assignment | Only request-response and statements reject unknown fields. Open, transition and actions do not, and open trusts a client `reportedByUserId` | **OPS-SR-29** |
| Audit tampering | Open, request-response and statements are audited in the transaction. Transitions and actions are not; `trust_case_events` and `trust_case_actions` have no append-only trigger. Employer statements are append-only (`0084:102-103`) | **OPS-SR-28**, **OPS-SR-29** |
| Personal data | The employer never sees the reporter, the statement or student data. Viewing a reported thread is audited (`trust.case.message_evidence_viewed`) | `employer-terms-trust.integration.spec.ts` › `puts the employer response …`; `application-messages.integration.spec.ts` › `opens one case per conversation, keeps adding to it, and tells the employer nothing` |
| Export abuse | n/a | — |
| Dual-control bypass | **No approval on any enforcement action**, and actions have no effect. Suspension goes separately through `ORGANIZATION_SUSPEND` | **OPS-SR-28** |
| Cross-tenant | Employer isolation is tested (above) | — |

**Audit search** (`operations-audit.controller.ts:40`, `SECURITY_AUDIT_SEARCH`, all three roles):

| Threat | Control | Test |
|---|---|---|
| Privilege escalation | Capability; ACTIVE only | `operations-audit.integration.spec.ts` › `denies a suspended platform membership`; › `rejects an unauthenticated request` |
| Bounds | Limit 1–200 and keyset paging | › `refuses an out-of-range limit and a malformed cursor rather than guessing`; › `pages with a stable keyset cursor and does not repeat or drop a row` |
| Personal data | Returns full context JSON; searches are not audited | **OPS-SR-36**; global-by-design is residual risk R-12 |
| Tampering, IDOR, mass assignment, export | Read-only GET; no export. The table itself → OPS-SR-03 | — |

#### 3.13.12 Organizations additions (EMP-16, INST-18) and the Growth team (GROWTH-01)

**Employer terms** (`operations-employer-terms.controller.ts:36-85`, `OPS_ORG_MANAGE`):
- Versions are immutable (`0084:96-97`), unknown fields are refused, and the audit row is in the
  same transaction.
- Test: `employer-terms-trust.integration.spec.ts` › `lets operations publish an immutable,
  clearly-draft version, and nobody else`.
- Single-operator publish, a self-asserted `LEGAL_APPROVED` and a free-form reason → **OPS-SR-38**,
  residual risk R-8.

**College data terms and exits** (`operations-institution-exits.controller.ts:58-197`, `OPS_ORG_MANAGE`):
- The purge needs `INSTITUTION_DATA_PURGE`, bound to {offboardingId, reasonCode} (`:184`), and is
  refused under a legal hold.
- Tests (`institution-contract-lifecycle.integration.spec.ts`):
  - › `refuses a purge before the retention period, without an approval, or with the wrong person`;
  - › `is refused while a student of the college is under a legal hold, consuming nothing`;
  - › `refuses a purge in the database without an executed approval for that exit`;
  - › `lists every exit for operations, and nothing for anyone else`.
- Notice, end and cancel are single-operator and reversible (a recorded decision; see the
  institution portal review).

**Growth team** (`operations-growth-team.controller.ts:97-336`, `GROWTH_ADMIN`):

| Threat | Control | Test |
|---|---|---|
| Privilege escalation / operator isolation | Growth roles hold no capability and are refused every grant. Growth capabilities can be granted to OPERATIONS_ADMIN only; self-grant is refused (`0091:184-192`) | `growth-foundation.integration.spec.ts` › `answers 403 to a %s on every /api/v1/operations/* route` (routes enumerated from Nest metadata); › `is for GROWTH_ADMIN holders only`; › `refuses every internal capability grant on a growth membership`; › `grants the growth capabilities to an operations admin and to no other role`; › `ends a growth membership, its team rows with it, and refuses acting on oneself or on an operator` |
| IDOR | UUID check; targets limited to growth roles in the platform organisation | › `sets a team and manager, changes the manager by ending the old row, and ends a team` (404 `GROWTH_TEAM_NOT_HELD`). There is no explicit unknown-membership test (R-18) |
| Mass assignment | `readObject` allow-lists (`:528-533`) | **No test** (R-18) |
| Audit tampering | Audit and outbox in the same transaction. Team and staff-type rows are append-only and DELETE is refused (`0091:237-367`) | › `keeps team rows append-only, refuses non-growth and self-made rows, and names only a manager as manager`; › `changes a staff type by ending the old row and writing a new one, both audited` |
| Personal data | Growth staff emails, shown to `GROWTH_ADMIN` only; no student data. No tax column anywhere | › `keeps staff types append-only with one live row, and has no tax column anywhere in growth` |
| Notifications | Growth memberships never receive approval or job-health notices | `jobs-health.integration.test.ts` › `never queues an ops-failure email to a growth membership of the platform organisation` |
| Export, dual control, cross-tenant | n/a. A `GROWTH_FINANCE` grant goes through OPS-02 | — |

#### 3.13.13 New findings (details)

- **OPS-SR-27 (Medium) — Release-label totals reveal a suppressed role's count.**
  - What happens: `byReleaseLabel` counts distinct students across all roles carrying a label
    (`packages/persistence/src/role-demand.ts:173-181`). Complementary suppression is applied only
    among the label cells, and each role row shows its own count in the same response. So the label
    total minus the label's shown roles equals the suppressed roles' total. That is exact when a
    student has one live target.
  - Evidence: OA › `counts demand per role, ranks shown roles by demand and suppressed roles by code,
    and evaluates the promotion rule` expects SELECTABLE = 411 alongside roles of 200, 200 and 8. The
    difference is 3, which is the suppressed role's true count. `studentsWithTarget` can leak the
    same way.
  - Fix: treat each label as a parent of its roles. Run `suppressDemandBreakdown` per label and
    withhold the label total when the hidden mass is 1–4, or drop student counts from
    `byReleaseLabel`.
  - Proving test (new): `withholds a release-label total that would reveal a suppressed role`.
- **OPS-SR-28 (Medium) — Trust and Safety enforcement actions are unaudited, unguarded and have no
  effect.**
  - What happens: `POST /operations/trust-safety/cases/:id/actions` writes `trust_case_actions` with
    - no reason code;
    - no `audit_events` row;
    - no outbox event;
    - no approval.
  - The DECIDED check is a separate read, outside any lock (`packages/persistence/src/trust-safety.ts:205-228`),
    and the reporter is not refused.
  - Nothing reads `trust_case_actions`, so a posting restriction or suspension is never applied.
    The `reversed_*` columns (`0032:134-143`) are never written.
  - Fix:
    - one transaction with `SELECT … FOR UPDATE`;
    - a listed reason per action, with audit and outbox in the same transaction;
    - refuse the reporter;
    - an OPS-02 action for TEMPORARY_SUSPENSION and PERMANENT_REMOVAL;
    - wire the actions to their effect, and add reversal on appeal.
  - Proving test (new): `records an enforcement action only on a DECIDED case, with a listed reason,
    audited in the same transaction`.
- **OPS-SR-29 (Low) — Trust-case transitions are unaudited and take free-form reasons.**
  - What happens:
    - transitions write `trust_case_events` but no `audit_events` row (`trust-safety.ts:154-197`);
    - reasons only match the pattern (`trust-safety.controller.ts:47,140,172`);
    - open, transition and actions accept unknown fields (`:250-253`);
    - open trusts a client-supplied `reportedByUserId` and `organizationId` (`:116-117`).
  - Fix: an audit row, a reason list per target state, `rejectUnknown`, and the reporter taken from
    the session.
  - Proving test (new): `audits each case transition with a listed reason and refuses unknown fields`.
- **OPS-SR-30 (Medium) — The access-review solo exception can be manufactured inside a campaign.**
  - What happens: solo eligibility reads the live reviewer count at decision time
    (`packages/authorization/src/access-reviews.ts:95`; `persistence/src/access-reviews.ts:452`;
    `0079:250`). Reviewer A revokes reviewer B (DUAL). A is then the only reviewer, and can KEEP
    their own items 15 minutes after opening, marked SOLO. Both acts are audited, but the
    second-person attestation is lost.
  - Fix: store the reviewer count when the campaign opens. Allow solo only if it was 1 then and is
    1 now, or refuse solo once a reviewer item in the campaign was revoked.
  - Proving test (new): `refuses a solo self-attestation after the reviewer revoked the only other
    reviewer in the same campaign`.
- **OPS-SR-31 (Low) — Engaging the kill switch through Feature Flags skips the cascade.**
  - What happens: `ai.global-kill-switch` is high-risk only for DISABLE, so any `OPS_FLAGS_MANAGE`
    holder can set it on as an ordinary change (`platform-controls.controller.ts:89-94`). That path
    does not switch features or the assistant off, so an approved release later revives them. This
    contradicts the screen's "releasing switches nothing back on" (`aiOperations.tsx:132,234`).
  - Fix: refuse ordinary changes to `ai.*` keys in the flags controller, or run the engage cascade.
  - Proving test (new): `engaging through the flags route switches every feature off, and release
    revives nothing`.
- **OPS-SR-32 (Low) — AI usage by organisation lacks complementary suppression.**
  - What happens: each organisation row is suppressed on its own (`persistence/src/ai-operations.ts:374-379`),
    while `/summary` publishes unsuppressed totals for the same window. With one suppressed row, its
    figures can be recovered.
  - Fix: mirror `summarisePlannerHealth`'s complementary rule.
  - Proving test (new): three organisations of 8, 6 and 3 people, where the totals minus the shown
    rows must not reproduce the 3-person row.
- **OPS-SR-33 (Low) — Ordinary feature-flag changes write no `audit_events` row.**
  - What happens: `setFeatureFlagEnabled` writes only `feature_flag_events` (`platform-controls.ts:114-121`),
    which no screen or API reads. Disabling the talent pool, enabling allow-free-mail or engaging
    the kill switch through Feature Flags therefore does not appear in Audit Logs.
  - Fix: write `operations.feature_flag.changed` in the same transaction.
  - Proving test (new): `an ordinary flag change writes one audit row with its reason`.
- **OPS-SR-34 (Low) — A skill's submitter is not counted as a contributor.**
  - What happens: skill contributors are the author and savers (`skill-map.ts:317-323`). Questions
    and lessons also count submitters. A person holding EDIT and REVIEW can submit another person's
    skill draft and then approve it, although two people are still involved.
  - Fix: add the IN_REVIEW transition audit to `contributorsOf`.
  - Proving test (new): `a submitter of a skill revision cannot approve it`.
- **OPS-SR-35 (Low) — The career set's author may request and execute its publish.**
  - What happens: neither `refuseCareerSetTransition` nor the approval request
    (`operations-approvals.controller.ts:262-271`) refuses the author. The editors refuse
    contributors. Reviewer ≠ author still keeps two people involved.
  - Fix: refuse the author at publish, or record the choice in `career-catalogue-table-design.md`.
  - Proving test (new): `the set's author cannot publish it`.
- **OPS-SR-36 (Low) — Audit search returns full context, unaudited, with loose filters.**
  - What happens:
    - rows carry the whole context JSON (`operations-audit.controller.ts:178-190`);
    - searches are not audited;
    - a date-only "To" is midnight UTC, so the chosen day is excluded (`:61,150-154`);
    - `%` and `_` in the action prefix are not escaped (`:59`).
  - Fix: audit searches by filter kind and count; treat a date-only `to` as the end of the day;
    escape LIKE.
  - Proving test (new): `includes events on the To date when filtering by day`.
- **OPS-SR-37 (Low) — Faculty review ignores the college's state, and operator lookups are unaudited.**
  - What happens: eligibility does not check `organizations.active` or verification state
    (`0066:74-86`). `/reviewers`, `/assignments` and the exact-email `/reviewers/lookup` show faculty
    emails to content staff without an audit row (`persistence/src/external-reviews.ts:159-188`).
  - Fix: require an ACTIVE, verified college, and audit lookups.
  - Proving test (new): `a deactivated college's faculty lose review access`.
- **OPS-SR-38 (Low) — Terms publishing is single-operator, with a self-asserted legal approval.**
  - What happens: employer and college terms versions are published by one `OPS_ORG_MANAGE` holder.
    A material version blocks every employer's next publish. `LEGAL_APPROVED` needs only a reference
    string, and the reason is free-form (the web always sends `TERMS_PUBLISHED`).
  - Fix: a listed reason, and OPS-02 dual control for a material or `LEGAL_APPROVED` version.
  - Proving test (new): `a material terms version needs an approval`.
- **OPS-SR-39 (Low) — Notice controls are weaker than the incident register.**
  - What happens: the 0090 trigger does not re-check that the approver holds `COMMS_TEMPLATES` (the
    API does; `0090:88-99`). A `COMMS_TEMPLATES` holder without `INCIDENT_MANAGE` sees open incident
    titles and references in the notice form (`persistence/src/status-notices.ts:584-590`).
  - Fix: re-check in the trigger, and list incidents by reference only for non-holders.
  - Proving test (new): `the database refuses a notice approval by someone without COMMS_TEMPLATES`.
- **OPS-SR-40 (Low) — An access-review CSV can be exported while the campaign is open, with no row cap.**
  - What happens: export is allowed in any state (`operations-access-reviews.controller.ts:204-225`),
    so evidence can be incomplete.
  - Fix: export CLOSED campaigns only (or mark an open export as "interim" in the file), and bound
    the row count.
  - Proving test (new): `refuses evidence export of an open campaign`.
- **OPS-SR-41 (Low) — The college account panel depends on `OPS_ORG_MANAGE`.**
  - What happens: the picker calls `GET /operations/organizations` and swallows a 403
    (`apps/web/src/rolePortal/collegeHealth.tsx:266-268`). An `ACCOUNT_MANAGE`-only holder sees an
    empty picker.
  - Fix: an `ACCOUNT_MANAGE` college list route, or an explicit error.
  - Proving test (new, web): `shows an explanatory state when the organisation list is forbidden`.

## 4. Cross-cutting checklist

Checked on `719eb34` across M1 and the modules added since:

| Area | Status | Reference |
|---|---|---|
| Authorisation (server-side capability, ACTIVE only) | Verified on every module; two solo-safeguard gaps | 3.1, 3.13; OPS-SR-04, OPS-SR-18, OPS-SR-30 |
| Scope (platform-wide by design, `:targetOrganizationId`) | Verified | 3.2 |
| Consent (coverage read-only, suppressed, no per-person view) | Verified | 3.11 |
| Audit (same transaction for writes) | Verified for writes, except trust-case transitions and actions and ordinary flag changes; no append-only guard; some reads unaudited | 3.4, 3.5, 3.13; OPS-SR-03, -05, -11, -21, -28, -29, -33, -36 |
| Reason codes (fixed lists, `^[A-Z0-9_:-]{3,64}$`) | Fixed lists on every new module except Trust and Safety and terms publishing; verification and PATCH organisation gaps remain | OPS-SR-16, OPS-SR-29, OPS-SR-38 |
| Data minimisation (masking, no academic content) | Verified in new routes; legacy routes expose emails | OPS-SR-06, OPS-SR-07, OPS-SR-08 |
| Suppression below 5 | Verified, with one shared helper (OPS-SR-24 fixed); two complementary-suppression gaps | 3.11, 3.13; OPS-SR-27, OPS-SR-32 |
| No numeric readiness | Verified | 3.11 |
| Error handling (`safeError`, no upstream text) | Verified; generic 500s without reference | 3.10; OPS-SR-15 |
| CSV / formula safety | Access-review CSV escapes and hashes; content import does not escape imported text (no content export exists) | 3.6, 3.13.3, 3.13.9 |
| Pagination bounds (default 50, max 200, keyset) | Verified on new routes; legacy routes exceed or lack keyset | OPS-SR-07, OPS-SR-25 |

## 5. Findings register (re-verified on `719eb34`)

**Status meanings:**
- **FIXED:** a commit closed the finding and a test proves it.
- **PARTLY:** part of the finding is closed; the rest is still open.
- **OPEN:** unchanged.

Evidence is quoted at `719eb34` lines. The M1 lines are mapped in §9.

**Totals:**
- M1's 26 findings: 3 FIXED, 4 PARTLY and 19 OPEN.
- New on `719eb34`: 15 findings (OPS-SR-27 to 41), of which 3 are Medium and 12 Low.
- Still open or partly open: **38** (1 High, 9 Medium and 28 Low).

| ID | Severity | Status | Title | Evidence (`719eb34`) | Fixing commit / recommended fix | Proving test |
|---|---|---|---|---|---|---|
| OPS-SR-01 | High | **FIXED** | Replaying 0043 stopped every later migration | `packages/persistence/src/migrate.ts:17-20`; `migration-runner.ts:23,43-83` | b0d133e (ADR-035 ledger) | `migration-runner.integration.test.ts` › `keeps a later widening once a row uses it — the case replaying every file broke` |
| OPS-SR-02 | High | **PARTLY** | The assistant makes a synchronous external model call from a handler and logs the question text | off by default: `assistant.service.ts:97,100-102`; `assistant.controller.ts:88-103`. Still synchronous: `assistant.service.ts:123`. Logs: `assistant.controller.ts:128,151` | 94ce3d9, 77afac3 (off switch). Remaining: route only through ONE AI Orchestration as a job; stop logging question text | `assistant.service.spec.ts` › `is off by default when ASSISTANT_ENABLED is not set, even with a key`; `operations-ai.integration.spec.ts` › `stays off by default even with ASSISTANT_ENABLED and a key set, and the console switches it off without a restart`. Remaining part: none |
| OPS-SR-03 | Medium | OPEN | `audit_events` (and DELETE on grant rows) have no append-only guard. The content separation of duties depends on audit rows | `0001:130-142`; `0091:198-201` (INSERT OR UPDATE only) | New migration refusing UPDATE and DELETE on `audit_events` and DELETE on `membership_capabilities` | (new) `audit events cannot be updated or deleted by any writer` |
| OPS-SR-04 | Medium | OPEN | Revoking the second approver re-arms the solo safeguard. There is now a second path through access reviews | `operation-approvals.ts:340-342,442`; `access-reviews.ts:523`; `0038:191-193` | Record the approver count on the request; dual-control the revocation of an approver | (new) `refuses a solo approval after the second approver's grant is revoked` |
| OPS-SR-05 | Medium | OPEN | The support case queue returns summaries and subject ids without audit | `operations-support.controller.ts:121-147`; `support-cases.ts:320-325` | Drop summaries from the list, or audit the listing | (new) queue returns no summaries / listing audited |
| OPS-SR-06 | Medium | OPEN | Legacy `GET /operations/users-access` returns unmasked emails, is unaudited and is unused | `operations-institution-onboarding.controller.ts:275-313`; `apps/web/src/api/operations.ts:59-62` | Remove the route and the client function | (new) route no longer exists |
| OPS-SR-07 | Low | OPEN | The invitation inventory shows unmasked student recipients and provider references | `operations-institution-onboarding.controller.ts:315-343` | Mask; drop provider fields; keyset paging | (new) inventory masks student recipients |
| OPS-SR-08 | Low | OPEN | Account search can enumerate every account with a 3-character term | `operations-support.controller.ts:263-269`; `support-cases.ts:466-468` | Longer term, or cap pages per term | (new) broad partial term refused |
| OPS-SR-09 | Low | OPEN | A case can be opened about an erased person | `support-cases.ts:120-123` | Refuse `SUPPORT_ACCOUNT_DELETED` | (new) case about erased person refused |
| OPS-SR-10 | Low | OPEN | A reveal's `caseId` need not concern that person | `support-cases.ts:607-610` | Require case subject = user | (new) reveal with another person's case refused |
| OPS-SR-11 | Low | OPEN | The hold list returns free-text detail and subject ids, unaudited | `privacy-operations.ts:290-329` | Drop detail from the list | (new) holds listed without detail |
| OPS-SR-12 | Medium | **PARTLY** | No production email: solo notices and job alerts are NOT_DELIVERED | sender built: `invitation-mail.ts` (`TlsSmtpMailSink`), migration 0094. Still NOT_DELIVERED: `operation-approvals.ts:375-381`; `jobs-health.ts:534-536` | 70bb67b, 4d539e3 (sender). Remaining: switch the sender on in production, set up the mailbox, activate the `security-notification`/`ops-failure` workflows, deploy the worker | `smtp-mail-sender.test.ts` › `sends the whole dialogue over TLS, authenticates, and delivers the shared message format` (sender only). End-to-end: none |
| OPS-SR-13 | Medium | OPEN | Staff sign-in (ADR-025 step 3) not built; internal roles sign in without MFA | `apps/api/src/runtime-auth.ts:30-40`; `docs/ops/runbook-staff-pool.md` | Build the staff sign-in entry, then re-bind and enforce | (new) end-to-end staff sign-in |
| OPS-SR-14 | Low | OPEN | Four write routes accept unknown body fields | `operations-outbox.controller.ts:102-112,161-173`; `operations-privacy.controller.ts:231`; `operations-institution-onboarding.controller.ts:196-204` | Allow-list the bodies | (new) unknown fields refused |
| OPS-SR-15 | Low | OPEN | Unmapped errors give a generic 500 with no correlation id; no global filter | `operations-institution-onboarding.controller.ts:168,211,224-226`; `operations-outbox.controller.ts:134`; `operations-privacy.controller.ts:266` | Map to 404/409; add a global safe filter | (new) unknown organisation gives 404 with reference |
| OPS-SR-16 | Low | OPEN | Verification and ordinary-flag reasons are not from a fixed list; PATCH organisation has no reason | `operations-institution-onboarding.controller.ts:155-191,200-201`; `platform-controls.controller.ts:52` | Fixed lists; require a reason | (new) unlisted verification reason refused |
| OPS-SR-17 | Low | **FIXED** | Break-glass use was not audited | resolvers in the catalogue, skill map, question bank, lessons, import, external reviews and AI controllers; writers e.g. `persistence/src/career-catalogue.ts:108` | 9d2ca6e and later (per route) | `operations-career-catalogue.integration.spec.ts` › `audits the super admin as break-glass`; `operations-ai.integration.spec.ts` › `audits the super admin configuring AI as break-glass, and an ordinary grant holder as not` |
| OPS-SR-18 | Low | OPEN | The granter's authority is read outside the grant transaction | `operations-staff.controller.ts:153-160`; `platform-controls.ts:376-401`; `0091:186-192` | Re-check under lock | (new) grant refused after granter loses CAPABILITY_ADMIN |
| OPS-SR-19 | Low | **PARTLY** | Suspension keeps internal grants | API path fixed: `access-reviews.ts:534-575`. No trigger: `0039:128-132` | 13eda6c (API path). Remaining: a trigger on leaving ACTIVE | `access-reviews.integration.spec.ts` › `suspends a platform role at once, revoking its grants, audited with the campaign reference` |
| OPS-SR-20 | Low | OPEN | Identity lookup by `sub` only, not bound to issuer | `principal.ts:86`; `identity-authentication.ts:29-45` | Match (issuer, sub) | (new) staff-pool sub never resolves a student identity |
| OPS-SR-21 | Low | OPEN | Client-supplied correlation ids are written into audit | `api-security.ts:55,412-416` | Server-generated ids | (new) correlation ids are server-generated |
| OPS-SR-22 | Low | **PARTLY** | Safety flags not marked high-risk | marked: `0089:120-133`, `0093:82-88`, `0098:273-279`. Not marked: `employer-access.allow-free-mail` (`0041:141-142`) | 77afac3, 374aa99, 0487872. Remaining: decide allow-free-mail | `ai-operations.integration.test.ts` › `exists, is not engaged by default, and is high-risk to release`. allow-free-mail: none |
| OPS-SR-23 | Low | OPEN | Access-request limiter: XFF trust untested; domain limit can block a company and leaks volume | `employer-access-requests.controller.ts:62,114,128-131,266-281` | Configured trusted proxies; silent domain limit | (new) `clientAddress` ignores XFF from a public peer |
| OPS-SR-24 | Low | **FIXED** | Two suppression helpers | `aggregate-suppression.ts:24,34-38` | e2da7ea | `aggregate-suppression.test.ts` › `is the helper the privacy console and the Overview use, with one threshold of 5` |
| OPS-SR-25 | Low | OPEN | Legacy `GET /operations/outbox/failed`: limit 500, no keyset | `operations-outbox.controller.ts:54-63` | Remove | (new) route no longer exists |
| OPS-SR-26 | Low | OPEN | Organizations Edit prompt nulls address fields | `apps/web/src/rolePortal/operations.tsx:88-94`; `operations-institution-onboarding.controller.ts:966-983` | Send and write only changed fields | (new) editing the city keeps the address |
| OPS-SR-27 | Medium | OPEN (new) | Release-label totals reveal a suppressed role count | `packages/persistence/src/role-demand.ts:173-181` | Per-label complementary suppression | (new) withholds a release-label total that would reveal a suppressed role |
| OPS-SR-28 | Medium | OPEN (new) | Trust enforcement actions: no reason, audit, approval or lock, and no effect | `persistence/src/trust-safety.ts:205-228`; `trust-safety.controller.ts:207` | Transaction and lock, reason list, audit, OPS-02 for suspension or removal, wire the effect, reversal | (new) action only on DECIDED, reasoned, audited |
| OPS-SR-29 | Low | OPEN (new) | Trust transitions unaudited, free-form reasons, unknown fields, client `reportedByUserId` | `trust-safety.ts:154-197`; `trust-safety.controller.ts:47,116-117,250-253` | Audit; reason lists; rejectUnknown | (new) transitions audited with listed reasons |
| OPS-SR-30 | Medium | OPEN (new) | The access-review solo exception can be manufactured | `authorization/src/access-reviews.ts:95`; `persistence/src/access-reviews.ts:452`; `0079:250` | Record the reviewer count at open | (new) solo refused after revoking the other reviewer |
| OPS-SR-31 | Low | OPEN (new) | Kill switch engaged through Feature Flags skips the cascade | `platform-controls.controller.ts:89-94`; `0089:120-124` | Refuse ordinary `ai.*` changes, or cascade | (new) engage via flags switches features off |
| OPS-SR-32 | Low | OPEN (new) | AI usage by organisation has no complementary suppression | `persistence/src/ai-operations.ts:374-379` | Complementary rule | (new) totals cannot reproduce a suppressed row |
| OPS-SR-33 | Low | OPEN (new) | Ordinary flag changes write no audit row | `platform-controls.ts:114-121` | Audit in the same transaction | (new) ordinary flag change is audited |
| OPS-SR-34 | Low | OPEN (new) | A skill submitter is not a contributor | `persistence/src/skill-map.ts:317-323` | Count submitters | (new) submitter cannot approve a skill |
| OPS-SR-35 | Low | OPEN (new) | The career set author can publish it | `operations-approvals.controller.ts:262-271`; `authorization/src/career-catalogue.ts` | Refuse the author, or record the choice | (new) set author cannot publish |
| OPS-SR-36 | Low | OPEN (new) | Audit search: full context, searches unaudited, To-date excludes the day, LIKE unescaped | `operations-audit.controller.ts:59,61,150-154,178-190` | Audit searches; end-of-day `to`; escape | (new) To date included |
| OPS-SR-37 | Low | OPEN (new) | Faculty review ignores college state; lookups unaudited | `0066:74-86`; `persistence/src/external-reviews.ts:159-188` | Require ACTIVE verified college; audit lookups | (new) deactivated college loses review access |
| OPS-SR-38 | Low | OPEN (new) | Terms publishing single-operator; self-asserted LEGAL_APPROVED; free-form reason | `operations-employer-terms.controller.ts:42-62`; `operations-institution-exits.controller.ts:64` | Reason list; OPS-02 for material or approved versions | (new) material version needs an approval |
| OPS-SR-39 | Low | OPEN (new) | Notice trigger does not re-check the approver capability; incident titles visible to COMMS holders | `0090:88-99`; `status-notices.ts:584-590` | Re-check in the trigger; reference-only listing | (new) DB refuses an approver without COMMS_TEMPLATES |
| OPS-SR-40 | Low | OPEN (new) | Access-review CSV exportable while open; no row cap | `operations-access-reviews.controller.ts:204-225` | CLOSED-only evidence export; bound rows | (new) open campaign export refused or marked interim |
| OPS-SR-41 | Low | OPEN (new) | College account picker needs OPS_ORG_MANAGE and hides the 403 | `apps/web/src/rolePortal/collegeHealth.tsx:266-268` | ACCOUNT_MANAGE college list | (new, web) explanatory state on 403 |

## 6. Known open items from the progress logs

These are not defects of the M1 console code, but they block go-live. Each has an ID above. The
status column is as re-checked on `719eb34`.

| Item | Finding | Pointer |
|---|---|---|
| (a) ADR-035 migration runner not on this base; 0043 re-declares `privacy_deletion_category_ck` and 0047 widens it — **closed: the runner is on `719eb34`** | OPS-SR-01 | `packages/persistence/src/migrate.ts:19-24`; `0043_support_cases.sql:273-276`; `0047_learning_attempt_log.sql:136-144` |
| (b) No production email: the SMTP sender is now built (ADR-042, 0094) but not switched on in production, the sender mailbox is still to be set up, and the `security-notification`/`ops-failure` workflows are not active, so solo notices and job alerts are still NOT_DELIVERED | OPS-SR-12 | `docs/ops/OPS_PROGRESS.md:233-234,461`; `operation-approvals.ts:304-310`; `jobs-health.ts:521-523` |
| (c) OPS-07: staff sign-in entry (ADR-025 step 3) not built; enforcement cannot go live; re-binding is hand-run SQL | OPS-SR-13 | `docs/ops/OPS_PROGRESS.md:764-768`; `docs/ops/runbook-staff-pool.md:220-265` (Part D prerequisite, Part E SQL at 251); `deploy/scripts/preflight-production.sh:66-72` |
| (d) Legacy `GET /operations/users-access` and `GET /operations/outbox/failed` left in place, unused | OPS-SR-06, OPS-SR-25 | `docs/ops/OPS_PROGRESS.md:358,480` |
| (e) Organizations Edit prompt can null address fields | OPS-SR-26 | `apps/web/src/rolePortal/operations.tsx:87-91` |
| (f) In-app assistant synchronous Anthropic call — off by default and switchable off in the console; the synchronous path remains | OPS-SR-02 | `apps/api/src/assistant/assistant.service.ts:113` |
| (g) `suppressSmallCount` and `suppressPeopleCount` — **closed (e2da7ea)** | OPS-SR-24 | `docs/ops/OPS_PROGRESS.md:677` |

## 7. Residual risks

At M1 this section was empty, under program rule B.2 ("a residual risk is recorded only after the
fix for its finding has merged").

For OPS-17 full, every threat must map to a test or to a *documented* residual risk. So two kinds of
entry are recorded here. **Neither replaces fixing the open findings.**

**A. Every open or partly open finding in §5 is a documented residual risk until it is fixed.**
- **Owner:** Divakar.
- **Decision:** pending.
- **Scope:** OPS-SR-02 (partly), 03, 04, 05, 06, 07, 08, 09, 10, 11, 12 (partly), 13, 14, 15, 16,
  18, 19 (partly), 20, 21, 22 (partly), 23, 25 and 26–41.

To get them fixed, start with the Medium ones:
- OPS-SR-03 (no append-only audit);
- OPS-SR-28 (trust enforcement);
- OPS-SR-27 (role-demand subtraction);
- OPS-SR-04 and OPS-SR-30 (solo safeguard re-armed);
- OPS-SR-05 and OPS-SR-06 (support and legacy data exposure);
- OPS-SR-12 and OPS-SR-13 (email and staff MFA before go-live).

**B. Accepted design choices and test gaps.** These are not defects, but they are risks someone
should knowingly accept. Most are recommendations that the goal adopted on Divakar's behalf and
recorded in the progress logs. They are listed so that he can confirm or reverse them.

| ID | Risk | Where decided | Owner | Status |
|---|---|---|---|---|
| R-1 | One `CONTENT_PUBLISH` holder (or the super admin as break-glass) can archive live content with no second person | OPS-GAPS decision; `content-archive-design.md` | Divakar | Recommendation adopted; confirmation pending |
| R-2 | Engaging the AI kill switch needs no approval, which differs from the plan's "one approved action". Releasing it does need one | OPS-12 decision (`OPS_PROGRESS.md`, OPS-12 §) | Divakar | Recommendation adopted; confirmation pending |
| R-3 | The access-review CSV (staff and faculty emails) is not treated as a §5.4 bulk personal-data export, so it has no dual control | OPS-15 decision | Divakar | Recommendation adopted; confirmation pending |
| R-4 | An access-review REVOKE suspends a platform role, including another super admin's, without a second person. Only the last super admin is protected | OPS-15 decision | Divakar | Recommendation adopted; confirmation pending |
| R-5 | College account changes and contact reveals have no dual control and no reveal rate limit | OPS-14 (§5.4 lists none) | Divakar | Decision pending |
| R-6 | Analytics, engine-health and Overview reads are not audited (suppressed aggregates only) | OPS-03, OPS-11, OPS-13, OPS-14 | Divakar | Recommendation adopted; confirmation pending |
| R-7 | Granting faculty review access, assigning drafts and faculty decisions have no dual control (not high-risk under ADR-037) | ADR-037 | Divakar | Accepted in ADR-037 |
| R-8 | Employer and college terms are published by one operator, with no OPS-02 approval | EMP-16 decision 7; INST-18 | Divakar | Recommendation adopted ("add it if material versions become frequent"); see also OPS-SR-38 |
| R-9 | Incident changes (declare, transition, record Board and users notified) are single-operator | OPS-16 | Divakar | Recommendation adopted; confirmation pending |
| R-10 | Imported content text is not formula-escaped. This is harmless while no content CSV export exists; any future export must escape | OPS-09d | Engineering | Accepted until a content export is built |
| R-11 | The engine shadow panel loads every consenting student's rows in one query (memory at scale) | OPS-13 | Engineering | Accepted at pilot scale |
| R-12 | Audit search is global by design and returns full context to any `SECURITY_AUDIT_SEARCH` holder (all three roles) | OPS-01 baseline | Divakar | Decision pending; see OPS-SR-36 |
| R-13 | Growth team actions (invite, team, staff type, end) have no dual control | GROWTH-01 | Divakar | Recommendation adopted; confirmation pending |
| R-14 | Faculty reviewers sign in through the ordinary user pool, not the staff pool with MFA | OPS-10 / ADR-037; `runtime-auth.ts:38` | Divakar | Recorded decision |
| R-15 | **Test gap.** Break-glass auditing is asserted by integration tests only for the catalogue, external reviews and AI routes, not for the skill map, question bank, lessons or import | — | Engineering | Add the assertions |
| R-16 | Any `OPS_FLAGS_MANAGE` holder (every platform role) can stop AI, so the brake is in many hands | OPS-12 decision | Divakar | Recommendation adopted; confirmation pending |
| R-17 | A lesson's `practice` field is shown to faculty reviewers. Whether practice text can contain answers was not verified | `career-readiness/src/external-review.ts:80` | Engineering | To verify |
| R-18 | **Test gaps:** <br>• no test for the trust-case reporter self-review trigger (`0032:158-174`); <br>• no unknown-field or unknown-membership test on the Growth team routes; <br>• no test that `ACCOUNT_MANAGE` appears in an access-review snapshot | — | Engineering | Add the tests |
| R-19 | Switching on `employer.talent-pool` before the HG-6 consent wording is published is prevented only by procedure (the SOP), not by code | EMP-14 / ADR-044 | Divakar | Procedural control |
| R-20 | No in-app Help links from Operations modules to their SOPs (OPS-17 item 4). Operators must find the SOPs in the repository | OPS-17 | Divakar | Not built; see §10 |

## 8. Threat-to-evidence matrix (OPS-17 acceptance)

Every plan threat, for every shipped operations module, maps to a proving test (**T**, see the
section named) or to a finding or residual risk. "n/a" means the threat has no surface in that
module.

| Module | Privilege escalation | IDOR | Mass assignment | Audit tampering | Personal-data exposure | Export abuse | Dual-control bypass | Cross-tenant reviewer |
|---|---|---|---|---|---|---|---|---|
| Capabilities and Settings (OPS-01) | T 3.1; SR-18 | T 3.2 | T 3.3 | T 3.4; SR-03 | n/a | n/a | T 3.7; SR-04 | T 3.8 |
| Approvals (OPS-02) | T 3.7 | T 3.2 | T 3.3 | T 3.4 | T 3.7 (queue hides hold subject) | n/a | T 3.7; SR-04 | n/a |
| Overview (OPS-03) | T 3.1 | n/a | T 3.3 | n/a (read) | T 3.11 | n/a | n/a | T 3.8 |
| System Health and jobs (OPS-04) | T 3.1 | T 3.2 | T 3.3; SR-14 | T 3.4 | T 3.10 | n/a | T 3.7 | n/a |
| Support (OPS-05) | T 3.1 | T 3.2 | T 3.3 | T 3.4 | T 3.5; SR-05, -08, -09, -10 | n/a | n/a | n/a |
| Privacy (OPS-06) | T 3.1 | T 3.2 | T 3.3; SR-14 | T 3.4 | T 3.5; SR-11 | n/a (state only) | T 3.7 | n/a |
| Staff access (OPS-07) | T 3.1; SR-13, SR-20 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Organizations and access requests | T 3.1 | T 3.2 | T 3.3; SR-14 | T 3.4 | T 3.9; SR-06, SR-07 | n/a | T 3.7; SR-16 | n/a |
| Role catalogue (OPS-08) | T 3.13.1 | T 3.13.1 | T 3.13.1 | T 3.13.1; SR-03 | T 3.13.1 | n/a | T 3.13.1; SR-35 | n/a |
| Content editors and archive (OPS-09a–c) | T 3.13.2; SR-34 | T 3.13.2 | T 3.13.2 | T 3.13.2; SR-03 | T 3.13.2 (answer keys) | n/a | T 3.13.2; R-1 | n/a |
| Bulk import (OPS-09d) | T 3.13.3 | n/a | T 3.13.3 | T 3.13.3 | T 3.13.3 | n/a; R-10 | T 3.13.3 (drafts only) | n/a |
| Faculty reviewers (OPS-10) | T 3.13.4 | T 3.13.4 | T 3.13.4 | T 3.13.4 | T 3.13.4; SR-37, R-17 | n/a | n/a; R-7 | **T 3.13.4**; R-14 |
| Role demand (OPS-11) | T 3.13.5 | T 3.13.5 | T 3.13.5 | n/a; R-6 | T 3.13.5; **SR-27** | n/a | n/a | n/a |
| AI Operations and engine health (OPS-12/13) | T 3.13.7; R-16 | T 3.13.7 | T 3.13.7 | T 3.13.7 | T 3.13.7; SR-32 | n/a | T 3.13.7; SR-31, R-2 | n/a |
| College health and accounts (OPS-14) | T 3.13.6 | T 3.13.6 | T 3.13.6 | T 3.13.6 | T 3.13.6; SR-41, R-5 | n/a | n/a; R-5 | n/a |
| Access reviews (OPS-15) | T 3.13.9 | T 3.13.9 | T 3.13.9 | T 3.13.9 | T 3.13.9 | T 3.13.9; SR-40, R-3 | **SR-30**; R-4 | n/a |
| Incidents and notices (OPS-16) | T 3.13.10 | T 3.13.10 | T 3.13.10 | T 3.13.10 | T 3.13.10; SR-39 | n/a | T 3.13.10; R-9 | T 3.13.10 (colleges and employers only) |
| Feature flags (incl. EMP-13/14) | T 3.7 | n/a | T 3.3 | **SR-33** | n/a | n/a | T 3.13.8; SR-22, R-19 | n/a |
| Trust and Safety | T 3.13.11; R-18 | T 3.13.11 | **SR-29** | **SR-28**, SR-29 | T 3.13.11 | n/a | **SR-28** | T 3.13.11 (employer isolation) |
| Audit search | T 3.13.11 | n/a | n/a | SR-03 | **SR-36**; R-12 | n/a | n/a | n/a |
| Employer terms; college terms and exits | T 3.13.12 | T 3.13.12 | T 3.13.12 | T 3.13.12 | n/a | institution review | T 3.13.12 (purge); SR-38, R-8 | n/a |
| Growth team (GROWTH-01) | T 3.13.12 | T 3.13.12; R-18 | R-18 | T 3.13.12 | T 3.13.12 | n/a | n/a; R-13 | n/a |

## 9. Citation map (`6864332` → `719eb34`)

These files are unchanged since `6864332`, so their M1 citations in §3.1–3.12 stand:

- `operations-support.controller.ts`, `support-cases.ts` and `support-desk.ts`;
- `operations-privacy.controller.ts` and `privacy-operations.ts`;
- `operations-outbox.controller.ts` and `outbox-dispatcher.ts`;
- `employer-access-requests.controller.ts`, `operations-overview.controller.ts` and
  `internal-capability-guard.ts`;
- persistence `operations-overview.ts`;
- `cognito.ts`, `staff-pool.ts`, `principal.ts` and `config.ts`;
- `preflight-production.sh`;
- web `shared.tsx:56-60`, `dashboardsV2.tsx:862` and `privacyConsole.tsx:200`;
- migrations 0001, 0031, 0038, 0039, 0041, 0043, 0045 and 0047.

The citations that moved:

| File | M1 line(s) → `719eb34` |
|---|---|
| `packages/authorization/src/internal-capabilities.ts` | 189→203; 252→266; 268→285; 156-159→166-173; 168→182; 255→269; 261→278; 116-118→126-128; 166-195→180-209; 266-272→283-289; 254→268; 157→167 |
| `apps/api/src/http/operations-staff.controller.ts` | 148-155→153-160 (152→157); 95→100; 96→101; 71→73; 134→139; 132→137; 81→83; 102-115→107-120; 123-146→128-151 |
| `apps/api/src/http/operations-approvals.controller.ts` | 167-174→182-189; 145→160; 92→107; 117→132; 122→137; 146→161; 252-258→369-385; 316-322→464-470 |
| `packages/persistence/src/operation-approvals.ts` | 45-62→47-63; 114-131→110-145; 362-410→421-487; 363-364→434-435; 371→442; 430-471→501-543; 437-457→508-530; 441→513; 445-451→517-522; 304-310→375-381 |
| `packages/authorization/src/high-risk-actions.ts` | 13-19→19-45 (13 keys); 126-128→180-182; 128-130→182-185; 30-36→65 onward |
| `packages/persistence/src/platform-controls.ts` | 403-449→418-512; 498-539→519-560 (376-401 and 383-392 unchanged) |
| `apps/api/src/http/platform-controls.controller.ts` | 84-97→84-102; 124→130; 125-131→133-138 |
| `apps/api/src/http/operations-institution-onboarding.controller.ts` | 845-853→848-856; 132-143→133-144; 208→209; 207-223→208-224; 203-214→204-215; 154-189→155-190; 198-203→196-204; 167→168; 210→211; 223-225→224-226; 274-312→275-313; 314-342→315-343; 952-969→966-983; 1297-1310→1311-1324 |
| `apps/api/src/http/operations-jobs.controller.ts` | 67→81; 96-98→110-112 |
| `packages/persistence/src/jobs-health.ts` | 341-347→346-352; 417→422; 521-523→534-536 |
| `apps/api/src/http/privacy-deletion.ts` | 75-80→80-85; 170-172→391 |
| `packages/privacy/src/index.ts` | 211→214 |
| `packages/authorization/src/operations-overview.ts` | 57-59→59; 84-88→81-84; 72→`aggregate-suppression.ts:24` |
| `packages/authorization/src/privacy-console.ts` | 42-46 and 32 → `aggregate-suppression.ts:34-38` and `:24` (re-exported at `privacy-console.ts:31-33`) |
| `apps/api/src/http/api-security.ts` | 385-389→412-416 (130 and 146 unchanged) |
| `packages/persistence/src/identity-authentication.ts` | 28-40→29-45 |
| `apps/api/src/runtime-auth.ts` | 30-37→30-40 |
| `apps/web/src/rolePortal/operations.tsx` | 87-91→88-94; 322→136 |
| 0039 trigger function | superseded by `0091_growth_roles_and_team.sql:140-201` (self-grant :190-192; immutability :146-160; CONTENT_REVIEW_EXTERNAL :174-177) |

## 10. Outside this review, but part of OPS-17

**OPS-17 item 4 ("in-app Help links from each module to its SOP") is not built.**
- The Help & FAQ panel (`apps/web/src/helpFaqPanel.tsx:8`) and the help corpus
  (`apps/api/src/assistant/help-articles.ts:7`) have no operations persona and no operations
  article.
- The Operations navigation (`apps/web/src/rolePortalConfig.ts:174`) has no Help item. Adding one
  needs HG-3.
- No operations screen links to its SOP. The only pointer is plain text naming the breach runbook
  (`apps/web/src/rolePortal/privacyConsole.tsx:252`).

This is a code change and is recorded as residual risk R-20.
