# Institution portal security review — all milestones (IM1–IM5)

> What this is: the INST-19 security review of the institution portal, written by reading the code on
> the program base branch. The first slice (milestone IM1) was reviewed on 2026-09-26; this edition
> covers every institution module shipped since (INST-07 to INST-18, the college side of EMP-11
> campus drives, and the OPS-10 external content reviews) and re-checks every earlier finding. Why it
> exists: INST-19 requires every threat in the plan — cross-scope and cross-institution access,
> invitation token abuse, consent bypass, compensation leakage, small-cell re-identification, export
> abuse, counselling-note exposure, bulk-action misuse — to map to a test or to a documented residual
> risk.

| | |
|---|---|
| Review target | `feat/plan-phases-0-to-2` at commit `719eb34` (worktree `E:/one-wt/doc2`); first slice at `6864332` |
| Date | 2026-10-01 (first slice 2026-09-26) |
| Scope | Every `/api/v1/institutions/:institutionId/…` route; the student routes the institution modules depend on (sharing applications, nominations, outcome self-reports, counselling notes shared with the student, learning actions); the operations routes for college exits and data terms; the web and Android clients of each |
| Out of scope | Employer-side campus drive and applicant routes (employer review), operations console routes other than college exits and terms (operations review), the assistant (switched off by default, f8809e1) |
| Method | Code reading of every route, its persistence functions, migrations and clients; each control cited as `file:line` (repo-relative, on `719eb34` unless marked); each test quoted exactly as `spec file › test name`, found by grep. No code was run or changed. "No test" means none was found by grep |

## Conclusion

**In plain words.** The institution portal's core protections hold across all twelve journeys: a
college never sees another college's data; staff see only the students in their scope; a college sees
a student's application only when the student shares it, and never the pay; every count about fewer
than five people is hidden; exports need a separate grant and are recorded; counselling notes are
readable only by the right people. Both High findings from the first review are dealt with: one is
fixed, and the other is fixed for everything permanent. What remains open is a decision for Divakar on
department heads with no department (they still *read* the whole college), two medium leaks of counts
that should have been limited, and a set of low-severity tidy-ups.

**For the engineer.** The two High findings of the IM1 slice: INST-SR-01 is **fixed** (one shared
suppression helper, one ended calendar month per report), INST-SR-02 is **partly fixed** (permanent
writes fail closed with `SCOPE_REQUIRED`; reads by an unscoped `DEPARTMENT_HEAD` and staff-action
writes are still institution-wide, pinned by tests, awaiting a decision). INST-SR-03 is fixed. Every
module shipped since IM1 has scope, consent, contract (no compensation, no numeric readiness),
suppression and audit tests. Twelve new findings were opened, two of them Medium: campus drive result
counts ignore the reader's scope and are suppressed one cell at a time (INST-SR-15), and a lecturer's
assignment summary counts students who have left (INST-SR-16).

| Findings | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Fixed since the first slice | 0 | 1 (SR-01) | 1 (SR-03) | 0 | 2 |
| Partly fixed, still open | 0 | 1 (SR-02) | 0 | 5 (SR-05, 06, 08, 13, 14) | 6 |
| Open from the first slice | 0 | 0 | 1 (SR-04) | 5 (SR-07, 09, 10, 11, 12) | 6 |
| New in this edition | 0 | 0 | 2 (SR-15, 16) | 10 (SR-17 … 26) | 12 |
| **Open now** | **0** | **1** | **3** | **20** | **24** |

Every threat in the plan maps to a test, an open finding or a documented residual risk — see the
threat map below. Residual risks are recorded with owner Divakar and the decision still pending
where none has been taken.

## Threat map

One row per threat and module. *Test* names the proving test (details in Part A or Part B). *Open*
names a finding in the register. *Residual* names an entry in the residual-risk list.

| Threat | Module | Control | Proven by | Open / residual |
|---|---|---|---|---|
| Cross-scope / cross-institution | IM1 routes (roster, staff actions, verification, results, readiness, assessments, teaching, announcements, settings) | Membership guard + INST-02 scope helper | Part A1 tests | SR-02 (unscoped head reads), SR-11 (relationship probe); residual R-3 |
| | Department workspace (INST-07) | Read scope, `?unitId` narrows only | `institution-department-workspace.integration.spec.ts` › "never widens a head beyond their department when a unit is asked for" | — |
| | Exports (INST-08, INST-13) | Write scope of the grant-holding membership | `institution-exports.integration.spec.ts` › "narrows to one unit inside the scope, and refuses a unit outside it" | — |
| | Placement status and register (INST-09, INST-12) | Read scope | `institution-placement-visibility.integration.spec.ts` › "keeps each reader to their scope: a department-scoped officer and a head see only their department; admins see all" | SR-21 (faculty per-student application reads) |
| | Year-end actions (INST-10) | Owner/admin + write scope | `institution-batch-lifecycle.integration.spec.ts` › "requires a token, an owner or admin of this institution, and a valid request" | — |
| | Counselling notes (INST-11) | Reader basis: author in scope, owner/admin, participant | `counselling-notes.integration.spec.ts` › "denies faculty of the same department, and audits the refusal of an out-of-scope head as DENIED" | — |
| | Campus drives (EMP-11, college side) | Institution-wide write scope to decide | `campus-drives.integration.spec.ts` › "lets only institution-wide placement staff decide, and validates every write" | **SR-15** (result counts unscoped) |
| | Nominations (INST-14) | Deciders need an institution-wide write scope | `campus-drive-nominations.integration.spec.ts` › "guards every route: token, role, college, write scope, validation and paging bounds" | — |
| | Faculty cohort view (INST-15) | Assignment-only write scope | `institution-learning-cohort.integration.spec.ts` › "removes access on the next request when the assignment ends" | — |
| | Learning actions (INST-16) | Write scope, taught units only | `institution-learning-actions.integration.spec.ts` › "acts only on the lecturer's taught students (write scope)" | **SR-16** (summary counts departed students) |
| | Cohort readiness and sprints (INST-17) | Read scope for the view, write scope for sprints | `institution-cohort-readiness.integration.spec.ts` › "includes students with no or too little evidence only when asked, and stays inside the write scope" | SR-18 (sprint list unscoped) |
| | Contract and exit (INST-18) | Owner-only exit export; `OPS_ORG_MANAGE` | `institution-contract-lifecycle.integration.spec.ts` › "shows the owner every section with counts, and what never leaves" | — |
| | External content reviews (OPS-10) | Capability + own assignments | `external-reviews.integration.spec.ts` › "sees only their own assignments, and a question without its answer key, hints or any student" | — |
| Invitation token abuse | Student and staff invitations (INST-01) | Hashed, single-use, email-bound, rotated | Part A2 tests | SR-07 (no resend cooldown), SR-26 (test gaps) |
| | Year-end actions, exit end (INST-10, INST-18) | Pending invitations revoked | `institution-batch-lifecycle.integration.spec.ts` › "revokes a pending invitation so a graduated student cannot activate into the relationship"; `institution-contract-lifecycle.integration.spec.ts` › "ends relationships, memberships and invitations, tells activated students, and records every change" | SR-26 (cancel-not-revive not asserted) |
| | Terms gate and exit (INST-18) | No rostering before terms or during an exit | `institution-contract-lifecycle.integration.spec.ts` › "refuses rostering until an owner accepts, without touching anyone already rostered" | — |
| Consent bypass | Applications (ADR-019; INST-09, INST-12, EMP-11 results) | Per-application grant, unrevoked, activity inside the relationship | `institution-placement-visibility.integration.spec.ts` › "drops a record on the next request after consent is revoked, and a student after the relationship ends" | — |
| | Documents (ADR-027) | No institution read path; title/type/version only | `academic-verification.integration.spec.ts` › "shows evidence as title, type and version only — never the filename, the file or a link" | SR-04 (term cites another person's document) |
| | Nominations (INST-14) | Only an opt-in (a reviewed snapshot) creates an application | `campus-drive-nominations.integration.spec.ts` › "nominates eligible students, shows each who nominated them and what would be shared, and gives the employer only those who opt in" | SR-19 (re-nominating a decliner); residual R-7 |
| | Adaptive-learning consent (INST-15, INST-16) | Consent in the same SQL; fails closed | `institution-learning-cohort.integration.spec.ts` › "fails closed to empty while the definition is not published (the state until HG-6)" | Residual R-5 (Done / Not yet without consent) |
| | Outcome self-reports (INST-13) | The declaration is the consent; withdrawal drops it | `institution-accreditation-exports.integration.spec.ts` › "drops a revoked share and a withdrawn self-report on the next export" | Residual R-8 |
| | ENG-01 consent gate | Fails closed server-side and in both clients | Part A3 tests | Residual R-6 (no Android test) |
| Compensation leakage | Every institution response and export since IM1 | No query selects offer terms; CSV writer refuses compensation headers | `institution-export-csv.test.ts` › "refuses any compensation header, in any spelling" and the per-module contract tests in Part B4 | SR-14 (IM1-era responses uncovered), SR-23 (narrow header guard) |
| Small-cell re-identification | Readiness report, exports, department workspace, placement statistics and register, nominations summary, learning cohort, learning actions, cohort readiness, accreditation | Shared helper: cells under 5 → `<5`, complementary totals withheld, one ended month | `aggregate-suppression.test.ts` › "never leaves a hidden cell recoverable, over every small table"; `placement-statistics.test.ts` › "never lets an observer recover a withheld group of 1–4 by subtracting published figures (exhaustive small tables)" | **SR-15**, **SR-16**, SR-17 (sprint figures), SR-12 (announcement skipped); residuals R-1, R-2 |
| Export abuse | INST-08, INST-13 exports | Capability gate, write scope, ended month, 10 000 rows, 30/day, audit before send, output encoding | `institution-exports.integration.spec.ts` › "returns 403 on every export for every role without the capability, and audits the refusal" | SR-25 (stored report outside the export transaction) |
| | Exit export (INST-18) | Owner only, during a notice; counselling notes only on request with a listed reason | `institution-contract-lifecycle.integration.spec.ts` › "releases counselling notes only on an explicit request with a listed reason, under their own audit action" | SR-22 (shared daily allowance untested); residual R-4 |
| Counselling-note exposure | Counselling notes (INST-11) | Restricted type; audit without text; excluded from every other read | `counselling-notes-exclusion.test.ts` › "every FROM staff_actions query names the action types it reads" | SR-23 (exclusion test blind spot), SR-08 (faculty-note text in audit) |
| Bulk-action misuse | Results upload, invitation resend, roster import (IM1) | Reason codes, bounds, digest-checked preview | Part A8 tests | SR-07, SR-10 |
| | Assessment assignment | Write scope, audited | `institution-department-workspace.integration.spec.ts` › "assigns only students inside the caller's write scope, and records who assigned whom" | — |
| | Year-end actions (INST-10) | ≤ 1 000, digest-checked preview, one transaction, reason code | `institution-batch-lifecycle.integration.spec.ts` › "refuses a commit whose roster changed after the preview, writing nothing" | Residual R-9 (backdating) |
| | Nominations (1–200), learning assignments and sprints (≤ 500) | Size bounds, write scope, audit | `campus-drive-nominations.integration.spec.ts` › "guards every route: token, role, college, write scope, validation and paging bounds" | SR-24 (no reason code on assignments); 500-cap not tested (SR-26) |
| | College exit end / cancel / purge (INST-18) | Ledger, 90 days, OPS-02 dual control, legal hold | `institution-contract-lifecycle.integration.spec.ts` › "refuses a purge before the retention period, without an approval, or with the wrong person" | Residual R-12 |
| | Capability grants | Owner/admin, reason code, no self-grant | `institution-exports.integration.spec.ts` › "refuses a self-grant, an ineligible role, another institution and a non-admin granter, writing nothing" | — |

## Files reviewed

First slice (unchanged list): `apps/api/src/http/api-security.ts`, `operations-institution-onboarding.controller.ts`,
`staff-actions.controller.ts`, `academic-records.controller.ts`, `career-readiness.controller.ts`,
`institution-assessments.controller.ts`, `institution-teaching-assignments.controller.ts`,
`institution-settings.controller.ts`, `institution-announcements.controller.ts`,
`institution-student-scope.ts`, `institution-staff-scope.ts`, `phase1-security.controller.ts`,
`platform-controls.controller.ts`; `packages/authorization/src/institution-scope.ts`,
`packages/persistence/src/institution-scope.ts`, `student-invitations.ts`, `invitation-mail.ts`,
`identity-authentication.ts`, `academic-records.ts`, `academic-results-import.ts`,
`institution-announcements.ts`, `career-readiness.ts`, `consent-purposes.ts`,
`packages/identity/src/invitation-token.ts`.

Added in this edition — API (`apps/api/src/http/`): `institution-department-workspace.controller.ts`,
`institution-exports.controller.ts`, `institution-export-csv.ts`,
`institution-placement-register.controller.ts`, `placement-facts.ts`, `accreditation-outcomes.ts`,
`institution-relationship-batches.controller.ts`, `counselling-notes.controller.ts`,
`campus-drives.controller.ts` (college routes), `campus-drive-nominations.controller.ts`,
`institution-learning-cohort.controller.ts`, `institution-learning-actions.controller.ts`,
`institution-cohort-readiness.controller.ts`, `institution-contract.controller.ts`,
`operations-institution-exits.controller.ts`, `institution-content-reviews.controller.ts`,
`student-outcome-declarations.controller.ts`, and the INST-09/INST-14 changes to
`student-hiring.controller.ts` and `employer-hiring.controller.ts`. Authorization:
`aggregate-suppression.ts`, `placement-statistics.ts`, `placement-status.ts`,
`institution-exports.ts`, `accreditation-outcomes.ts`, `relationship-lifecycle.ts`,
`institution-contract.ts`. Persistence: `institution-exports.ts`,
`institution-relationship-batches.ts`, `learning-cohort.ts`, `faculty-learning-actions.ts`,
`cohort-readiness.ts`, `institution-contract.ts`. Migrations `0060`, `0073`, `0080`, `0082`, `0083`,
`0085`, `0088`. Every `*.integration.spec.ts` and unit test named below. Design documents:
ADR-036, ADR-038 and the table designs for counselling notes, the placement register, nominations,
accreditation outcomes and self-reports, faculty learning actions, preparation sprints and the
contract lifecycle.

---

## Part A — The first slice (IM1), re-checked

The tables in Part A are the first slice's, kept so the history of each control is visible. **Their
`file:line` references are those of `6864332`**, except in rows and bullets that report a fix (those
cite `719eb34`): line numbers have moved since. Every test named in
Part A was re-found by grep on `719eb34` (all still exist), and each control was re-read where a
finding depends on it; the statuses below are those of `719eb34`.

### A1. Cross-scope and cross-institution access

#### Verified controls (IM1)

| Control | Where | Proving test |
|---|---|---|
| The authentication guard selects an **ACTIVE** membership whose organisation and scope match `:institutionId`, else 403 before any controller | `apps/api/src/http/api-security.ts:152-153`, `:354-365` | `staff-actions.integration.spec.ts` › "requires authentication and denies tenant substitution"; `institution-settings.integration.spec.ts` › "refuses without a token, from another institution, and from a non-institution role" |
| Each controller re-checks role, organisation and `scope.institutionId` from the trusted context | onboarding `:863-874`; staff actions `:129-150`; assessments `:608-616`; teaching `:361-374`; settings `:484-500`; academic records `:301-312` (organisation and scope organisation only — the scope helper then returns NONE, so it fails closed) | `academic-verification.integration.spec.ts` › "requires a token, an institution staff role and the right institution"; `institution-teaching-assignments.integration.spec.ts` › "requires authentication and an admin or department head of this institution" |
| One scope definition: pure form, SQL form, controller adapter | `packages/authorization/src/institution-scope.ts:84-102`; `packages/persistence/src/institution-scope.ts:87-126`; `apps/api/src/http/institution-student-scope.ts:22-48` | `institution-scope.test.ts` › "limits a department head to their department, including its programmes, batches and sections", "narrows a faculty member to a batch within a department", "unions two scoped memberships", "sees nobody without a qualifying staff membership" |
| Faculty scope follows active teaching assignments once the college records any; ended/expired assignments stop on the next request | `packages/persistence/src/institution-scope.ts:48-84` | `institution-teaching-assignments.integration.spec.ts` › "shows a faculty member exactly the students of their assigned section", "removes access on the next request when an assignment ends", "grants nothing before an assignment starts or after its planned end", "leaves an unassigned faculty member with nobody once the institution uses assignments" |
| Units, memberships and scopes cannot cross institutions at the database | `packages/persistence/drizzle/0001_identity_organization_persistence.sql:47-48`, `:70-73` | — (constraint) |
| Staff unit scope validated on invitation and edit (own units, right kinds, batch within department) | `apps/api/src/http/institution-staff-scope.ts:41-65` | `institution-teaching-assignments.integration.spec.ts` › "refuses a scope change from anyone but an admin of this institution, or on the wrong membership" |
| Department heads assign and end teaching assignments only within their department | `institution-teaching-assignments.controller.ts:135`, `:174` | "lets a department head assign within their department only"; "lets a department head end only assignments in their department" |

Every student-level read calls the helper (see the route inventory below): roster list and detail,
staff actions (list and every write through `subject()`), consented applications and external
applications, verification queue, summary and decide, results preview and commit, readiness report,
assessment results, My Students, and announcement compose and send. Proving tests:
`institution-student-scope.integration.spec.ts` › "refuses a single-student read outside the caller
scope and allows one inside it", "shows department B faculty their own student only, and the
administrator both", "applies the same scope to external applications", "lists only in-scope terms and
refuses a decision on an out-of-scope one", "counts only the department head department, and the whole
college for the administrator", "shows results, pending students and the assigned count for in-scope
students only", "lists the same in-scope students through the shared definition".

Verification-queue items from people with no roster profile carry no unit, so they are visible only to
institution-wide staff (`packages/persistence/src/academic-records.ts:314-386`, predicate on the
LEFT-joined profile at `:377`). This is by design (alumni requests) and fails closed for scoped staff.

#### Findings — status on `719eb34`

- **INST-SR-02 (High) — partly fixed.** Permanent writes now fail closed with `SCOPE_REQUIRED` (SEC-INST, e2da7ea).
  Reads by an unscoped department head, and staff-action writes, are still institution-wide.
- **INST-SR-03 (Medium) — fixed** by INST-07 (c8458bd): assignment uses the write scope and is audited.
- **INST-SR-11 (Low) — open.**

### A2. Invitation token abuse

#### Verified controls (IM1)

| Control | Where | Proving test |
|---|---|---|
| 32 random bytes, only a SHA-256 hash stored | `packages/identity/src/invitation-token.ts:4-14`; DB length check `0001…sql:105` | — |
| Student invitation created with a hash of a token nobody holds; the real token is minted at send time and exists only in the email | `packages/persistence/src/student-invitations.ts:54-69`, `:109-160` | "records an unconfigured sender instead of dropping the invitation, and resends once one exists" |
| Single use: accept requires PENDING, unexpired, unrevoked and consumes with a conditional UPDATE | `packages/persistence/src/identity-authentication.ts:117-128`, `:172-183` | `institution-roster-activation.integration.spec.ts` › "refuses a reused token"; "refuses an expired token and says nothing about why" |
| Email match against the verified-email claim only | `invitation-token.ts:30-33`; `api-security.ts:293-298` | "refuses a token presented by an identity with a different verified email, without revealing the roster" |
| A student invitation binds only the rostered user row, never another account with the same address | `identity-authentication.ts:157-158` | "never binds an identity to a roster row on a matching email alone" |
| Resend rotates the token; the earlier link stops working | `student-invitations.ts:136-143`, `:166-220` | "mints a new token on resend, so the earlier link stops working"; "marks a permanent rejection as bounced, and a resend after correcting it invalidates the old link" |
| Revoked when the relationship ends | onboarding `:600`; `student-invitations.ts:222-231` | "revokes the pending invitation when the student relationship ends" |
| Resend is admin-only and reason-coded; activated and non-current students skipped | onboarding `:615`, `:619`; `student-invitations.ts:178-186` | "requires a reason code and an admin to resend, and skips students already activated" |
| Delivery exactly once per event | `student-invitations.ts:117-122` (consumer receipt) | "queues 200 emails for a 200-student import exactly once, even when every event is replayed" |
| No token in outbox, audit or responses: outbox payload is `{ invitationId }`; audit context holds only a reason code; staff invitation response says `tokenPreviewAvailable: false`; accept failures are a generic FORBIDDEN | `student-invitations.ts:71-80`, `:62-66`; onboarding `:697`; `api-security.ts:322-324` | Generic failure: "refuses an expired token and says nothing about why". **No test asserts the token is absent from `audit_events` or `outbox_events`.** |

Guessing is not a practical attack (256-bit tokens), so the absence of a rate limit on
`POST /invitations/accept` is not raised.

#### Findings — status on `719eb34`

- **INST-SR-07 (Low) — open.**

### A3. Consent bypass

#### Verified controls (IM1)

| Control | Where | Proving test |
|---|---|---|
| ADR-019: an application is shown only with the student's institution-visibility grant, unrevoked, inside the reader's scope and current relationship, and only for activity inside the relationship window | `staff-actions.controller.ts:473-533`, `:535-579` (scope and relationship through `subject()` `:152-167`) | `staff-actions.integration.spec.ts` › "does not substitute employer consent for absent institution consent", "removes a row immediately after institution consent is revoked", "withholds application and offer revisions outside the relationship window", "isolates institutions and requested students", "retains department and batch scope and denies inactive or unauthenticated staff" |
| ADR-027: the verification queue shows evidence as title, type and version only — no filename, file or link; no institution read path to a document exists | `packages/persistence/src/academic-records.ts:347-355` | `academic-verification.integration.spec.ts` › "shows evidence as title, type and version only — never the filename, the file or a link" |
| ENG-01: `hasConsentPurpose` fails closed (no live definition, withdrawal, or an older version's grant all mean no) and reads the database on every call | `packages/persistence/src/consent-purposes.ts:24-37`; one live definition per key `drizzle/0028_consent_registry.sql:43-44`; used at `learner-skill-state.ts:100` | `consent-purposes.integration.test.ts` › "is absent when no definition is live, even with a recorded grant", "takes a withdrawal into effect on the next check", "does not carry a grant of an older version onto a new one", "keeps students without model-improvement consent out of exports" |
| Web gate fails closed: no workspace while checking or when the check fails | `apps/web/src/consentGate.tsx:30-77` | `consentGate.test.tsx` › "shows a checking state, not the workspace, until the answer arrives", "blocks with a retry when the check fails, and opens only after a successful retry" |
| Android gate fails closed the same way | `apps/android/.../MainActivity.kt:171-224`, `:1253-1265` | No test (the Android app has no unit-test source set). |

Note: the privacy-notice gate in both clients is a presentation control; the API does not itself
refuse institution reads when the caller's privacy-notice consent is missing. This is outside the
institution slice and is recorded here for the platform review rather than as a finding.

Not in this slice: ADR-027 per-version document consent (evidence cannot be opened at all, which is
the safe state).

#### Findings — status on `719eb34`

- **INST-SR-04 (Medium) — open.**

### A4. Compensation leakage (ADR-024)

#### Verified controls (IM1)

| Control | Where | Proving test |
|---|---|---|
| The consented-applications view returns offer existence and response state only, never terms | `staff-actions.controller.ts:512-527` | `staff-actions.integration.spec.ts` › "returns only the granted student application and allowed fields, without selecting forbidden columns" (asserts the offer keys are exactly `exists`, `responseState`) |
| No institution controller selects a `compensation_*` column (grep of `apps/api/src/http/*institution*`, `staff-actions`, `academic-*`, `career-readiness`) | — | `academic-verification.integration.spec.ts` › "never returns a numeric readiness value or compensation"; `institution-settings.integration.spec.ts` › "carries no compensation and no numeric readiness in any settings response"; `institution-teaching-assignments.integration.spec.ts` › "lists assigned students with activation, recent assessments and open tasks, and no compensation or readiness number" |

The placement register, offers, exports and every later module are covered in Part B4.

#### Findings — status on `719eb34`

- **INST-SR-14 (Low) — partly fixed:** every module since IM1 carries a contract test (Part B4); the
  IM1-era responses listed in the register still do not.

### A5. Small-cell re-identification

#### Verified controls (IM1)

| Aggregate | Assessment |
|---|---|
| Readiness report | **Fixed since IM1 (INST-SR-01):** every band cell under 5, zero included, reads `<5` and a total that would recover one is withheld, through the shared helper (`packages/authorization/src/aggregate-suppression.ts:69`, used at `packages/persistence/src/career-readiness.ts:1012`); the period is one ended calendar month (`apps/api/src/http/career-readiness.controller.ts:186`). Tests in Part B5. |
| Activation summary | Counted server-side over the same scoped rows the caller already sees by name (`operations-institution-onboarding.controller.ts:448-453`); no re-identification beyond the list. Test: "reports a Dashboard summary that matches the Students list". Acceptable. |
| Verification summary | Same shape as the queue the caller can read (`academic-records.ts:388-411`). Acceptable. |
| Announcement delivery counts | INST-06 decided not to suppress: the sender can list the audience by name. Accepted for delivery failures, but the "skipped" count mixes a personal preference (email turned off) into it — INST-SR-12. |

At IM1 there was no shared suppression helper. Since SEC-INST there is one
(`packages/authorization/src/aggregate-suppression.ts`), used by every institution aggregate and by the
operations console (Part B5).

#### Findings — status on `719eb34`

- **INST-SR-01 (High) — fixed** (SEC-INST, e2da7ea; tests 7ad90b3).
- **INST-SR-12 (Low) — open.**

### A6. Export abuse

#### Verified controls (IM1)

- At IM1 no institution export existed. Exports arrived with INST-08, INST-13 and INST-18 and are
  reviewed in Part B6.
- Roster import CSV: at most 512 000 characters, 500 rows and 16 columns; cells starting `= + - @` are
  prefixed with `'` (`operations-institution-onboarding.controller.ts:1070-1080`, `:1116-1119`).
  Test: `api-security.integration.spec.ts` › "validates and commits roster CSV without raw preview mutation".
- Results upload CSV: at most 512 000 characters and 1 000 rows; formula-prefixed identifiers, labels
  and programmes are rejected as invalid rows (`packages/persistence/src/academic-results-import.ts:26-28`,
  `:89-92`, `:214-225`). Test: `academic-verification.integration.spec.ts` › "previews row by row, writes
  nothing, and a commit with any invalid row writes nothing either".
- `INSTITUTION_ANALYTICS` is now enforced on every export (INST-08; Part B6).

#### Findings — status on `719eb34`

- **INST-SR-13 (Low) — partly fixed:** exports encode on output (INST-08); the roster import still
  alters stored values.

### A7. Counselling-note exposure

Counselling notes are reviewed in Part B7 (INST-11). The `FACULTY_NOTE` staff-action type is unchanged: `STAFF_ONLY`, readable by every staff role inside the reader's scope
(`staff-actions.controller.ts:170-188`), never shown to the student (test: "denies STAFF_ONLY items and
rechecks visibility revocation after the student reads").

#### Findings — status on `719eb34`

- **INST-SR-08 (Low) — partly fixed:** counselling now has its own restricted type (INST-11); faculty-note
  text is still copied into the audit log and readable by every in-scope role.

### A8. Bulk-action misuse

#### Verified controls (IM1)

| Bulk action | Roles | Scope | Bounds | Audit and reason | Stale preview |
|---|---|---|---|---|---|
| Resend invitations (`onboarding:612-640`) | Owner, admin | Institution-wide (admin) | ≤ 500 ids, or `all` ≤ 2 000 | Reason code required (`:619`); audit per invitation | n/a |
| Roster import (`onboarding:766-837`) | Owner, admin | Institution-wide | ≤ 500 rows | `institution.roster_import.validated` / `.committed` (`:794`, `:833`); no reason code | Rows persisted at preview; a clash at commit surfaces only as a database error (INST-SR-10) |
| Results upload (`academic-records.controller.ts:198-244`) | Owner, admin, department head (`:69`) | Roster filtered by scope (`academic-results-import.ts:181-188`) | ≤ 1 000 rows | Reason code required (`:283`); preview, per-term and per-upload audit in the transaction (`academic-results-import.ts:309`, `:348-353`, `:393-399`) | Digest re-evaluated under an advisory lock; mismatch → **409** (`:338-342`; controller `:237`) |
| Assessment assignment (`institution-assessments.controller.ts:414`) | Any staff role with a write scope | **Write scope** since INST-07 (`:438-446`) | ≤ 500 profiles | `institution.assessment.assigned` in the transaction (`:463-467`); no reason code | n/a |

Tests: `academic-verification.integration.spec.ts` › "requires a token and an uploader role in this
institution", "refuses a commit whose records changed since the preview", "limits a department head to
their own department", "commits institution-verified records attributed to the uploader, each audited";
`institution-roster-activation.integration.spec.ts` › "requires a reason code and an admin to resend,
and skips students already activated".

#### Findings — status on `719eb34`

- **INST-SR-02** (partly fixed), **INST-SR-03** (fixed), **INST-SR-07** (open) — above. Bulk actions shipped
  since IM1 are in Part B8.

### A9. Other controls checked

| Area | Verified | Proving test |
|---|---|---|
| Announcements — scope at compose | Sender resolved from trusted memberships and active assignments (`institution-announcements.controller.ts:115-116`); faculty send only through assignments, heads need a department (`packages/authorization/src/institution-scope.ts:144-155`) | "refuses a faculty member any audience outside their assignments, and writes nothing"; "limits a department head to their department" |
| Announcements — scope at send | Sender membership and scope re-read at send; lost access cancels with `SENDER_ACCESS_ENDED` (`packages/persistence/src/institution-announcements.ts:131-152`); recipients filtered by sender scope and audience (`:161-176`) | "does not send when the sender lost the assignment before the scheduled time" |
| Announcements — rate limit 20/24 h | Advisory lock per sender, then count (`controller:47`, `:111`, `:120-127`) | "limits each sender to 20 announcements a day" |
| Announcements — caps and channels | Title ≤ 160, body ≤ 500, unknown fields rejected, IN_APP required, no SMS (`controller:265-293`) | "rejects unknown fields, missing text, oversize text, and any channel set without in-app or with SMS" |
| Announcements — email injection | Plain-text body; CR/LF stripped from the subject header (`packages/persistence/src/invitation-mail.ts:45-47`, `:119-121`) | No test of header injection. |
| Announcements — cancel | Sender or owner/admin, row lock, reason code, 409 once sent (`controller:149-189`) | "lets only the sender or an owner/admin cancel, and never after sending"; "never sends a cancelled announcement" |
| Settings — operations-verified fields refused | By name, before anything else (`institution-settings.controller.ts:507-512`) | "never lets the college change what operations verified" |
| Audit in the same transaction | Verification decision (`academic-records.ts:274-283`), results import, teaching assignments, scope changes, settings, terms, announcements, staff actions | "requires a reason code and writes the decision and its audit row together"; "rolls back the action when its audit insert fails" |
| Reason codes | `^[A-Z0-9_:-]{3,64}$` in onboarding `:619`, academic records `:70`, teaching `:35`, settings `:39`, announcements `:40`; DB check on `invitations.reason_code` (`0037…sql:34`). Relationship end has none — INST-SR-06 | "audits a creation with its reason code"; "removes a scale with a reason code, back to NA" |
| Keyset pagination 1–200 | Queue, teaching assignments, My Students, terms, announcements | "pages the queue with a keyset cursor and bounds the page size"; "bounds its page size"; "pages earliest first and filters by date window" |
| No numeric readiness | Readiness report returns band counts only; `readiness_snapshots` CHECK constraints untouched | Contract tests listed in §4 |

---

---

## Part B — Modules shipped since the first slice

Abbreviations for spec files (all in `apps/api/src/http/` unless a package path is given):
**dw** `institution-department-workspace.integration.spec.ts`, **vis**
`institution-placement-visibility.integration.spec.ts`, **ex** `institution-exports.integration.spec.ts`,
**csv** `institution-export-csv.test.ts`, **reg** `institution-placement-register.integration.spec.ts`,
**acc** `institution-accreditation-exports.integration.spec.ts`, **bl**
`institution-batch-lifecycle.integration.spec.ts`, **cn** `counselling-notes.integration.spec.ts`, **nm**
`campus-drive-nominations.integration.spec.ts`, **cd** `campus-drives.integration.spec.ts`, **lc**
`institution-learning-cohort.integration.spec.ts`, **la** `institution-learning-actions.integration.spec.ts`,
**cr** `institution-cohort-readiness.integration.spec.ts`, **ic**
`institution-contract-lifecycle.integration.spec.ts`, **sa** `staff-actions.integration.spec.ts`, **xr**
`external-reviews.integration.spec.ts`. Unit tests are named with their package path.

### B1. Cross-scope and cross-institution access

Every new route resolves the caller's memberships through the same guard as IM1 (an ACTIVE
membership of the institution in the URL), then the INST-02 helper: the **read scope** for lists and
counts, the **write scope** (`packages/authorization/src/institution-scope.ts:169`,
`institutionStudentWriteScope`) for writes, exports and the lecturer-only views. The write scope gives
an unscoped department head and an unassigned lecturer nobody.

| Module | Control | Proving tests |
|---|---|---|
| Department workspace (INST-07) | Owner, admin, placement admin, head (`institution-department-workspace.controller.ts:89`, `:172`, `:218`, `:286`, `:340`); faculty only on class reports (`:388`); `?unitId` narrows and never widens (`:499-506`) | dw › "refuses callers without a token, other institutions and roles without a department workspace"; dw › "counts only the head's department, and reconciles with the administrator filtered to it"; dw › "never widens a head beyond their department when a unit is asked for"; dw › "gives a faculty member with no assignment nothing once the college assigns, and refuses heads"; `packages/authorization/src/institution-scope.test.ts` › "never widens a scoped reader: a head narrowed to another department sees nobody" |
| Placement status (INST-09) | Read scope; faculty refused on the list | vis › "keeps each reader to their scope: a department-scoped officer and a head see only their department; admins see all"; vis › "refuses without a token, for faculty, and across institutions"; vis › "audits each read, and a read outside scope as denied" |
| Placement statistics and register (INST-12) | Read scope; categories need an institution-wide write scope | reg › "limits each reader to their scope and withholds small groups and the margins that would reveal them"; reg › "refuses faculty, other colleges and anonymous callers"; reg › "lets the placement office define categories, label drives and retire them, audited; never for employers" |
| Exports (INST-08, INST-13) | Write scope of the grant-holding membership (`institution-exports.controller.ts:254-255`); a `unitId` must sit inside it (`:260-267`) | ex › "refuses a grant held in another institution, and a caller from another institution"; ex › "narrows to one unit inside the scope, and refuses a unit outside it"; ex › "refuses a department head with no department even holding the grant (export uses the write scope)"; acc › "limits a department head to their department"; `packages/authorization/src/institution-exports.test.ts` › "takes scope only from the memberships given, so another membership cannot widen it" |
| Year-end actions (INST-10) | Owner and admin only (`institution-relationship-batches.controller.ts:32`, `:84`), write scope (`:86`) | bl › "requires a token, an owner or admin of this institution, and a valid request". No test holds a narrowed admin to a unit (admins are institution-wide in practice) |
| Counselling notes (INST-11) | Reader basis (`counselling-notes.controller.ts:145-150`): author while the student is in their read scope, owner/admin, case participant; writes need the write scope | cn › "denies a department head of the student's own department who is not a case participant (acceptance)"; cn › "denies faculty of the same department, and audits the refusal of an out-of-scope head as DENIED"; cn › "stops an author reading their own note once the student leaves their scope"; cn › "refuses a suspended membership, another institution, and no token"; cn › "uses the write scope: SCOPE_REQUIRED without one, FORBIDDEN outside it" |
| Campus drives, college side (EMP-11) | Deciding needs an institution-wide write scope (`INSTITUTION_WIDE_SCOPE_REQUIRED`); named results use the read scope | cd › "lets only institution-wide placement staff decide, and validates every write"; cd › "refuses callers without a token, from another organisation, and employers not in good standing". **Result counts ignore the reader's scope — INST-SR-15** |
| Nominations (INST-14) | Deciders as for drives (`campus-drive-nominations.controller.ts:457-467`); readers within the read scope | nm › "guards every route: token, role, college, write scope, validation and paging bounds" |
| Faculty cohort view (INST-15) | Lecturers only; assignment-only scope | lc › "shows nobody to a lecturer with no active assignment, or before the college records any"; lc › "removes access on the next request when the assignment ends"; lc › "403 for every non-faculty role and for a lecturer of another college, with no internal detail" |
| Learning actions (INST-16) | Lecturers only; write scope; class must be one the lecturer teaches | la › "acts only on the lecturer's taught students (write scope)"; la › "is for lecturers only: 401 without a token, 403 for other roles and colleges"; la › "a pending override can be withdrawn by a lecturer who teaches the student, not by one who does not". **Assignment summary counts students outside the scope — INST-SR-16** |
| Cohort readiness and sprints (INST-17) | View: read scope; sprints: write scope, `unitId` narrows | cr › "refuses faculty, another college, no token, a month that has not ended and an unknown role"; cr › "includes students with no or too little evidence only when asked, and stays inside the write scope". **Sprint list is not scoped — INST-SR-18** |
| Contract and exit (INST-18) | Exit export owner only (`institution-contract.controller.ts:116`); operations routes need `OPS_ORG_MANAGE` (`operations-institution-exits.controller.ts:195`) | ic › "shows the owner every section with counts, and what never leaves"; ic › "gives the owner each section as a formula-safe CSV, audited before it is sent"; ic › "lists every exit for operations, and nothing for anyone else" |
| External content reviews (OPS-10, ADR-037) | `CONTENT_REVIEW_EXTERNAL` grant, own assignments only | xr › "403 on the faculty side without the grant, for another role, and in another college"; xr › "sees only their own assignments, and a question without its answer key, hints or any student" |

### B2. Invitation token abuse

No new token type was added. New paths that touch invitations:

| Path | Control | Proving test |
|---|---|---|
| Year-end actions revoke pending invitations | `packages/persistence/src/institution-relationship-batches.ts:219` | bl › "revokes a pending invitation so a graduated student cannot activate into the relationship" |
| A college exit withdraws every pending invitation (reason `INSTITUTION_OFFBOARDED`) | `packages/persistence/src/institution-contract.ts:428-429` | ic › "ends relationships, memberships and invitations, tells activated students, and records every change" |
| No rostering (so no new invitation) before the terms are accepted or while an exit is open | gate at the top of add-student and roster commit (`operations-institution-onboarding.controller.ts`) | ic › "refuses rostering until an owner accepts, without touching anyone already rostered"; ic › "opens with a notice recorded by operations, which refuses a second and stops rostering" |
| Cancelling an exit does not revive withdrawn invitations | By design (the college resends) | **Not asserted** — INST-SR-26 |

### B3. Consent bypass

| Consent | Control | Proving tests |
|---|---|---|
| Application sharing (ADR-019; INST-09, INST-12, EMP-11 results) | Grant present and unrevoked, activity inside the relationship, DRAFT offers are not offers (`institution-department-workspace.controller.ts:518-548`; `staff-actions.controller.ts:496-512`; `placement-facts.ts:55-59`) | vis › "derives each status only from shared applications, and reads nothing shared as NOT_SHARED"; vis › "drops a record on the next request after consent is revoked, and a student after the relationship ends"; vis › "withholds an application whose activity falls outside the relationship window"; vis › "never treats an unsent DRAFT offer as an offer, or a DRAFT application as shared"; dw › "stops counting an application on the next request once the student withdraws consent or leaves"; reg › "drops a revoked share on the next request, and counts a newly shared one"; cd › "counts the 5 shared applications of 7 and leaves the 2 unshared ones out of every count"; `packages/authorization/src/placement-status.test.ts` › "is NOT_SHARED when nothing is shared, never a \"not applied\"" |
| Nomination opt-in (INST-14) | Only the student's opt-in — the apply transaction with a reviewed snapshot hash — creates an application; the employer reads only applications (`campus-drive-nominations.controller.ts:100-154`; `student-hiring.controller.ts:415-429`, `:516-519`) | nm › "nominates eligible students, shows each who nominated them and what would be shared, and gives the employer only those who opt in"; nm › "records a decline, never shows it to the employer, and shows the college a decline exactly as it shows no answer"; nm › "withdrawing the application withdraws the consent and ends the employer's access"; nm › "the table refuses to be rewritten, to skip the consent edges, or to be deleted outside a privacy erase" |
| Adaptive-learning consent (INST-15, INST-16) | Checked in the same SQL statement (`packages/persistence/src/learning-cohort.ts:70`; `institution-learning-actions.controller.ts:268-276`); no definition → empty | lc › "fails closed to empty while the definition is not published (the state until HG-6)"; lc › "drops a student on the next request after they withdraw"; lc › "treats a grant of a superseded version as no consent"; la › "shows the latest step for a consenting student, nothing for one who has not consented, and audits the read"; la › "fails closed while the adaptive-learning definition is not published (HG-6)" |
| Outcome self-reports (INST-13) | Only colleges with a current or graduated relationship; withdrawal leaves the next export (`student-outcome-declarations.controller.ts:177-207`) | acc › "drops a revoked share and a withdrawn self-report on the next export"; acc › "refuses a college the person did not study at or left, another person's report, and bad input"; acc › "keeps each row fixed except its withdrawal, and deletes only inside the privacy erase" |
| Cohort readiness (INST-17) | Reads the readiness evidence pipeline, not the adaptive engine, so no purpose consent applies (design decision 7) | cr › "never publishes a number about a student, a target or a ratio, and never names a student" |

### B4. Compensation leakage (ADR-024) and numeric readiness

No new route selects an offer-terms column. Exports go through one writer that refuses a
compensation header before writing (`institution-export-csv.ts:35-43`; forbidden list
`packages/authorization/src/index.ts:76-80`).

| Module | Contract test |
|---|---|
| CSV writer | csv › "refuses any compensation header, in any spelling" |
| Exports | ex › "no export carries a compensation field or an internal identifier"; acc › "never carries pay, readiness or an identifier, and writes NA where ONE holds nothing" |
| Department workspace | dw › "lists the department's shared applications with offer existence and response, never pay, and audits the read"; dw › "counts only the head's department, and reconciles with the administrator filtered to it" |
| Placement status | vis › "counts statuses with small groups suppressed, reconciling with the per-student list"; vis › "does not disclose that an unsent DRAFT offer exists, and hides DRAFT applications" |
| Placement register | reg › "reconciles every count with the consented records, and never counts a student who shared nothing as unplaced"; reg › "lists engaged employers and the drive calendar, with outcomes over shared applications only" |
| Campus drive results | cd › "shows suppressed counts after completion and named results only for shared applications in scope, audited" |
| Nominations | nm › "nominates eligible students, shows each who nominated them and what would be shared, and gives the employer only those who opt in" (college-view walk) |
| Counselling notes | cn › "carries no compensation field and no numeric readiness" |
| Learning cohort and actions | lc › "groups the lecturer's students stuck on the same skill, by the engine's rule"; la › "lists published practice sets and current lessons, never drafts or superseded lessons" |
| Cohort readiness | cr › "never publishes a number about a student, a target or a ratio, and never names a student" |
| Year-end actions | bl › "previews a batch without writing anything but an audit row" |
| Exit export | ic › "gives the owner each section as a formula-safe CSV, audited before it is sent" |

IM1-era responses with no contract assertion remain INST-SR-14. The writer's guard catches only
`compensation*` names (INST-SR-23).

### B5. Small-cell re-identification

One helper serves every institution aggregate: `packages/authorization/src/aggregate-suppression.ts`
(`suppressSmallCount` `:34`, `suppressAggregateTable` `:69`, `publishedSubtotal` `:99`,
`suppressGroupedPartition` `:136`), with the placement and accreditation partitions in
`placement-statistics.ts` and `accreditation-outcomes.ts`. Monthly figures are a stock at the end of
one ended calendar month.

| Aggregate | Proving tests |
|---|---|
| The helper | `packages/authorization/src/aggregate-suppression.test.ts` › "never leaves a hidden cell recoverable, over every small table"; › "withholds every band cell under 5, zero included, and drops the value"; › "withholds the total when one hidden cell could be recovered as total minus the others"; › "withholds the whole table when fewer than 5 people are in it"; › "accepts exactly one whole calendar month that has ended" |
| Readiness report (INST-SR-01) | `packages/persistence/test/career-readiness.integration.test.ts` › "suppresses every band under 5 and any total that would recover one, in the response and the stored report"; `institution-student-scope.integration.spec.ts` › "refuses any period but one whole calendar month that has ended, and stores nothing"; `apps/web/src/institutionReportsPage.test.tsx` › "never shows a band count under 5, even one a server failed to mark" |
| Department workspace | dw › "shows last month's readiness bands through the suppression helper: small bands and a recoverable total withheld"; dw › "summarises each assigned section, with an average only once five students have results" |
| Placement status and statistics | vis › "counts statuses with small groups suppressed, reconciling with the per-student list"; reg › "limits each reader to their scope and withholds small groups and the margins that would reveal them"; `packages/authorization/src/placement-statistics.test.ts` › "never lets an observer recover a withheld group of 1–4 by subtracting published figures (exhaustive small tables)" |
| Accreditation outcomes | `packages/authorization/src/accreditation-outcomes.test.ts` › "never lets subtraction recover a withheld group of 1–4 across small tables" |
| Exports | ex › "is the institution report as a file: bands only, cells under 5 as <5, the total withheld when it would reveal one"; ex › "withholds everything for a cohort under 5"; ex › "counts students and actions opened in the month, each cell under 5 as <5, with no text and no totals" |
| Nominations summary | nm › "suppresses the summary: any cell under five reads <5, with the total that would give it back" |
| Learning cohort | lc › "shows a published code held by 5 or more students, withholds one held by 4, never counts a draft code"; lc › "suppresses the count of students sharing learning data under 5" |
| Cohort readiness | cr › "shows bands, gaps and unknowns per essential requirement for last month, withholding cells under 5 and the shared total"; cr › "a withheld total in one table is withheld from every table of the view"; cr › "counts lesson work done before the cut-off, suppressed under 5" |

Gaps: campus drive result counts are suppressed one by one with no complementary rule
(INST-SR-15); a lecturer's assignment summary is not bounded to current students (INST-SR-16);
sprint figures and sprint creation can be differenced (INST-SR-17). Month-to-month movement and
linked tables are residual risks R-1 and R-2.

### B6. Export abuse

| Control | Where | Proving tests |
|---|---|---|
| `INSTITUTION_ANALYTICS` required; only admins and department heads can hold it (ADR-018); refusals audited `institution.export.denied` | `institution-exports.controller.ts:234-257`; `packages/authorization/src/index.ts:52`, `:64-71` | ex › "returns 403 on every export for every role without the capability, and audits the refusal"; ex › "stops admitting on the next request once the grant is revoked, or the role changes under it"; acc › "is 403 without the capability for every role, 401 without a token, and refuses bad input"; `packages/authorization/src/institution-exports.test.ts` › "never admits a role outside ADR-018, even holding a grant" |
| Grants: owner or admin, reason code, no self-grant, operations' grants not revocable by the college | `platform-controls.controller.ts:119`, `:153`; `packages/persistence/src/institution-exports.ts:101` | ex › "refuses a self-grant, an ineligible role, another institution and a non-admin granter, writing nothing"; ex › "does not let the college revoke a capability operations granted"; ex › "lets an owner or admin grant and revoke it with a reason code, each audited" |
| Reason code, unknown fields refused, one ended month | `institution-exports.controller.ts:55`, `:276` | ex › "validates the request: reason code, unknown fields, month and unit, and audits nothing refused" |
| 10 000 rows; 30 exports per person per institution per 24 h under an advisory lock | `institution-exports.controller.ts:345`; `packages/persistence/src/institution-exports.ts:395-402` | ex › "refuses an export over the row cap and records no export"; ex › "limits exports per person per day" |
| Audit row committed before the file is sent | `packages/persistence/src/institution-exports.ts:389-410` | acc › "writes the audit row, with the reason, before sending the file" |
| Output encoding: every cell quoted; `= + - @`, tab and CR neutralised | `institution-export-csv.ts:20-31` | csv › "neutralises a formula-leading cell: %j"; csv › "quotes every text cell and doubles embedded quotes, so commas and line breaks stay inside the cell"; ex › "exports current, in-scope students with activation state, unit names, and no internal identifier" |
| Exit export: owner only, only while a notice is open (re-checked in the transaction), files of at most 10 000 rows | `institution-contract.controller.ts:116`, `:134-146` | ic › "is not available without an open notice"; ic › "gives the owner each section as a formula-safe CSV, audited before it is sent"; `packages/authorization/src/institution-contract.test.ts` › "splits a section into files of at most ten thousand rows, always at least one" |
| Counselling notes leave in an exit export only on an explicit flag with a listed reason, under their own audit action | `institution-contract.controller.ts:122-126` | ic › "releases counselling notes only on an explicit request with a listed reason, under their own audit action" |

### B7. Counselling-note exposure (INST-11, ADR-036)

| Control | Where | Proving tests |
|---|---|---|
| Readers: author (while the student is in scope), owner/admin, case participant; others get an empty list (in scope) or 403 (out of scope) | `counselling-notes.controller.ts:145-150`, `:251`, `:270-277` | cn › "lets the author, the owner and an admin read it, and nobody else by default"; cn › "lets a case participant read the notes, even outside their unit scope, until removed" |
| Every read and write audited, never with the title or text | `counselling-notes.controller.ts:237-241`, `:331-334`, `:493-499` | cn › "audits every write without the note text"; cn › "lets an owner or admin erase one note with a reason code, audited without text" |
| Staff-only by default; only the author or an owner/admin shares | `:340` | cn › "is STAFF_ONLY by default; the author can share and withdraw; a participant cannot" |
| Ended relationships hide notes; graduates' notes before `effective_to` only | `:153-158` | cn › "hides every note once a relationship has ended, and keeps a graduate's notes written before effective_to" |
| Excluded from the generic staff-action routes, exports, calendars and every employer surface | `staff-actions.controller.ts` type allow-list; `packages/persistence/src/institution-exports.ts` | cn › "is refused by the generic staff-action endpoints"; cn › "never appears in the export summary or the calendars, even when shared"; `counselling-notes-exclusion.test.ts` › "every FROM staff_actions query names the action types it reads"; › "no employer surface reads staff actions or counselling notes" |
| Privacy export and erasure | `privacy-deletion.ts:359-363` | cn › "summarises notes in the subject export: shared text, staff-only count"; cn › "erases the subject's notes and case on deletion, and records it" |

Open: faculty-note text in the audit log (INST-SR-08); the static exclusion test does not inspect
`JOIN staff_actions` (INST-SR-23); counselling notes released in an exit export are not limited to the
relationship window (residual R-4).

### B8. Bulk-action misuse

| Bulk action | Roles and scope | Bounds | Audit and reason | Stale / concurrent | Proving tests |
|---|---|---|---|---|---|
| Year-end actions (INST-10) | Owner, admin; write scope | ≤ 1 000 students (`packages/authorization/src/relationship-lifecycle.ts:26`) | Reason code (`institution-relationship-batches.controller.ts:66-67`); per-student and per-batch audit; outbox | SHA-256 preview digest; stale → 409; one transaction | bl › "previews a batch without writing anything but an audit row"; bl › "graduates the whole batch in one transaction, audited per student, and leaves every other student alone"; bl › "refuses a commit whose roster changed after the preview, writing nothing"; bl › "writes nothing when any row is invalid, and lists the rows"; bl › "rolls the whole batch back when one write is refused by the database"; bl › "refuses unknown fields, REVOKED, missing or double targets, bad ids and dates, and a future date" |
| Assessment assignment | Write scope | ≤ 500 | Audited; no reason code | — | dw › "assigns only students inside the caller's write scope, and records who assigned whom"; dw › "refuses a head with no department and faculty with no assignment, with SCOPE_REQUIRED, and writes nothing" |
| Nominations (INST-14) | Institution-wide deciders | 1–200 ids (`campus-drive-nominations.controller.ts:581-589`) | Closed reason list; audit per student | One live nomination per drive and student; revision on cancel | nm › "guards every route: token, role, college, write scope, validation and paging bounds" |
| Learning assignments and group sessions (INST-16) | Lecturer write scope | ≤ 500 students; 1–5 resources | Audited; **no reason code** (INST-SR-24) | — | la › "assigns to a taught class — its current students only — audited and notified"; la › "validates the request". No test sends 501 students |
| Preparation sprints (INST-17) | Write scope | ≤ 500; 7–42 days | Closed reason list; audited with the reached ids | Early end once, by creator or owner/admin | cr › "ends early: the creator or an admin, with a reason; the assignment is withdrawn with it"; cr › "the 0085 guard: a sprint cannot be re-dated, deleted, or attached to another college’s assignment". No test sends 501 students |
| College exit end, cancel, purge (INST-18) | `OPS_ORG_MANAGE`; purge also an executed OPS-02 approval | Whole college | Closed reason lists; audited per person | Ledger restores exactly; 90 days; legal hold; database guard | ic › "ends relationships, memberships and invitations, tells activated students, and records every change"; ic › "restores exactly what it changed when cancelled inside the retention period"; ic › "cannot be reversed once the retention period has passed"; ic › "refuses a purge before the retention period, without an approval, or with the wrong person"; ic › "is refused while a student of the college is under a legal hold, consuming nothing"; ic › "refuses a purge in the database without an executed approval for that exit"; ic › "classifies every table that carries an institution_id" |


## Route inventory

### First-slice routes (line numbers as at `6864332`)

Guard = the roles the controller admits after the global membership check. Scope = does a
student-level result go through the INST-02 helper.

| Route | Guard | Scope helper | File:line |
|---|---|---|---|
| GET `/institutions/:id/units` | Staff | n/a (no student data) | `operations-institution-onboarding.controller.ts:363` |
| GET `…/staff-role-assignments` | Owner, admin | n/a | `…onboarding.controller.ts:372` |
| POST `…/units`, PATCH `…/units/:unitId` | Owner, admin | n/a | `…onboarding.controller.ts:408`, `:491` |
| GET `…/students` | Staff | **Yes** | `…onboarding.controller.ts:425` (`:430`, `:443`) |
| POST `…/students` | Owner, admin | n/a (institution-wide role) | `…onboarding.controller.ts:459` |
| GET `…/students/:studentProfileId` | Staff | **Yes** | `…onboarding.controller.ts:507` (`:513`, `:524`) |
| PATCH `…/students/:studentProfileId` | Owner, admin | n/a | `…onboarding.controller.ts:531` |
| POST `…/students/:studentProfileId/relationship` | Owner, admin | n/a | `…onboarding.controller.ts:571` |
| POST `…/student-invitations/resend` | Owner, admin | n/a | `…onboarding.controller.ts:612` |
| POST `…/staff-role-assignments` | Owner, admin | n/a | `…onboarding.controller.ts:642` |
| POST `…/student-imports`, `…/:importId/commit` | Owner, admin | n/a | `…onboarding.controller.ts:766`, `:799` |
| GET/POST `…/staff-actions`, `…/:actionId/transition`, `…/update` | Staff | **Yes** | `staff-actions.controller.ts:214`, `:262`, `:295`, `:331` (scope `:129-150`) |
| GET `…/students/:studentUserId/applications` | Staff | **Yes** + ADR-019 | `staff-actions.controller.ts:473` |
| GET `…/students/:studentUserId/external-applications` | Staff | **Yes** + consent | `staff-actions.controller.ts:535` |
| GET `…/academic-verification-queue`, `…-summary` | Staff | **Yes** | `academic-records.controller.ts:142`, `:158` |
| POST `…/academic-verification/:termId/decide` | Staff | **Yes** (term must be in the scoped queue) | `academic-records.controller.ts:167` (`:181`, `:251-261`) |
| POST `…/academic-results-imports/preview`, `…/commit` | Owner, admin, head | **Yes** | `academic-records.controller.ts:198`, `:220` |
| POST `…/career-readiness/reports` | Owner, admin, placement, head (selected membership) | **Yes** | `career-readiness.controller.ts:146` (`:158`) |
| GET `…/announcements` | Staff | n/a (own; owners/admins all) | `institution-announcements.controller.ts:72` |
| POST `…/announcements` | Staff | **Yes** (sending scope) | `institution-announcements.controller.ts:103` |
| POST `…/announcements/:announcementId/cancel` | Sender or owner/admin | n/a | `institution-announcements.controller.ts:149` |
| Assessment subjects, questions, definitions, publish, reopen | Staff / approval roles | n/a (no student data) | `institution-assessments.controller.ts:57`, `:77`, `:98`, `:131`, `:201`, `:244`, `:271`, `:351`, `:473` |
| POST `…/assessments/:definitionId/assignments` | Staff | **Write scope** since INST-07 (INST-SR-03 fixed) | `institution-assessments.controller.ts:414` |
| GET `…/assessments/:definitionId/results` | Staff | **Yes** | `institution-assessments.controller.ts:535` (`:545`) |
| Settings, grading scales, academic terms, staff profile | Staff read; owner/admin write; own preferences | n/a | `institution-settings.controller.ts:76-319` |
| GET/POST `…/teaching-assignments`, `…/:assignmentId/end` | Admin, head (department), faculty (own) | Unit-based by role | `institution-teaching-assignments.controller.ts:70`, `:107`, `:155` |
| GET `…/my-students` | Faculty | **Yes** | `institution-teaching-assignments.controller.ts:195` (`:210`) |
| POST `…/staff-memberships/:membershipId/scope` | Owner, admin | n/a | `institution-teaching-assignments.controller.ts:281` |
| GET `…/student-activity-access/:studentUserId` | Staff | **No** — INST-SR-11 | `phase1-security.controller.ts:25`; `api-security.ts:261` |
| GET/POST `…/capabilities`, `…/:capabilityId/revoke` | Owner, admin | n/a | `platform-controls.controller.ts:105`, `:113`, `:145` |


### Routes added since the first slice (`719eb34`)

Roles: O owner, A admin, P placement admin, H department head, F faculty. Scope: R read scope, W
write scope, IW institution-wide write scope required.

| Route | Guard | Scope | Audit | File:line |
|---|---|---|---|---|
| GET `…/department-overview`, `…/placement-pipeline` | O, A, P, H | R; `unitId` narrows | none (counts) | `institution-department-workspace.controller.ts:89`, `:172` |
| GET `…/placement-status`, `…/placement-applications` | O, A, P, H | R | `institution.placement_status.listed`, `institution.placement_applications.listed` | `…department-workspace.controller.ts:218`, `:286` |
| GET `…/department-staff` | O, A, H | R | none | `…department-workspace.controller.ts:340` |
| GET `…/class-reports` | F | R by taught unit | none | `…department-workspace.controller.ts:388` |
| POST `…/exports/{roster,readiness-bands,assessment-results,staff-action-summary,accreditation-outcomes}` | A or H holding `INSTITUTION_ANALYTICS` | W of the grant holder | `institution.<kind>.exported` before send; `institution.export.denied` | `institution-exports.controller.ts:99`, `:122`, `:151`, `:180`, `:204` |
| GET `…/placement-statistics`, `…/placement-register` | O, A, P, H | R (register employers and drives college-wide) | none | `institution-placement-register.controller.ts:113`, `:171` |
| GET/POST `…/drive-categories`, `…/:cid/retire`; POST `…/campus-drives/:did/category` | read O, A, P, H; write O, A, P + IW | IW | `institution.drive_category.created/retired`, `campus_drive.category_set` | `…placement-register.controller.ts:282`, `:301`, `:329`, `:353` |
| POST `…/relationship-batches/preview`, `…/commit` | O, A | W | `institution.relationship_batch.previewed/committed`, per-student `institution.relationship.ended` | `institution-relationship-batches.controller.ts:46`, `:60` |
| GET `…/counselling-cases`; GET/POST `…/students/:sid/counselling-notes` | Staff, by reader basis; write W | R / W | `counselling_note.cases_listed/read/created` | `counselling-notes.controller.ts:161`, `:225`, `:304` |
| POST `…/counselling-notes/:nid/visibility`, `…/erase`; `…/counselling-case/participants`, `…/:mid/remove` | author or O/A; erase and participants O/A | — | `counselling_note.visibility_changed/erased`, `counselling_case.participant_added/removed` | `counselling-notes.controller.ts:340`, `:373`, `:390`, `:428` |
| GET `…/campus-drives`, `…/:did/history` | O, A, P, H | college-wide | none | `campus-drives.controller.ts:533`, `:562` |
| GET `…/campus-drives/:did/results` | O, A, P, H | named rows R; **counts none** (INST-SR-15) | `institution.campus_drive_results.read` | `campus-drives.controller.ts:578` |
| POST `…/campus-drives/:did/{approve,reject,request-changes,schedule,cancel,complete}` | O, A, P + IW | IW | `campus_drive.<action>` | `campus-drives.controller.ts:634-659` |
| GET/POST `…/placement-policies`, `…/:pid/retire` | read O, A, P, H; write O, A, P + IW | IW | `institution.placement_policy.set/retired` | `campus-drives.controller.ts:664`, `:684`, `:709` |
| GET `…/campus-drives/:did/nomination-candidates` | O, A, P + IW | R | **none** (INST-SR-20) | `campus-drive-nominations.controller.ts:174` |
| GET/POST `…/nominations`, POST `…/nominations/:nid/cancel` | read O, A, P, H; write O, A, P + IW | R / W | create and cancel audited; list **none** (INST-SR-20) | `campus-drive-nominations.controller.ts:221`, `:289`, `:349` |
| GET `…/learning-cohort`, `…/learning-cohort/due-reviews` | F | W (assignments only) + consent | `institution.learning_cohort.read`, `….due_reviews_listed` | `institution-learning-cohort.controller.ts:62`, `:96` |
| GET `…/learning-resources`, `…/learning-actions` | F | own | none | `institution-learning-actions.controller.ts:91`, `:107` |
| POST `…/learning-assignments`, `…/:aid/withdraw`; GET `…/:aid/students` | F | W | `learning_assignment.created/withdrawn`, `institution.learning_assignment.students_read` | `institution-learning-actions.controller.ts:139`, `:190`, `:173` |
| POST `…/group-sessions`; GET `…/students/:pid/learning-plan`; POST `…/plan-overrides`, `…/:oid/withdraw` | F | W (+ consent for the plan) | `group_session.created`, `institution.learning_plan.read`, `learning_plan_override.created/withdrawn` | `institution-learning-actions.controller.ts:210`, `:262`, `:290`, `:333` |
| GET `…/cohort-readiness/roles`, `…/cohort-readiness` | O, A, P, H | R | `institution.cohort_readiness.read` (view) | `institution-cohort-readiness.controller.ts:102`, `:117` |
| GET/POST `…/preparation-sprints`, POST `…/:sid/cancel` | O, A, P, H | list **college-wide headers** (INST-SR-18), progress R; create W | `institution.preparation_sprints.read`, `preparation_sprint.created/cancelled` | `institution-cohort-readiness.controller.ts:163`, `:176`, `:265` |
| GET `…/data-terms`, POST `…/data-terms/accept`, GET `…/exit`, POST `…/exit-export/:section` | read O, A; accept and export O | whole college | `institution.data_terms.accepted`, `institution.exit_export.<section>.exported` | `institution-contract.controller.ts:68`, `:75`, `:93`, `:113` |
| `/operations/institution-data-terms`, `/operations/institution-offboardings` (+ `end`, `cancel`, `purge-preview`, `purge`) | `OPS_ORG_MANAGE`; purge + OPS-02 approval | — | `institution.data_terms.published`, `institution.offboarding.*` | `operations-institution-exits.controller.ts:58-180` |
| GET `…/content-reviews`, `…/:aid`; POST `…/:aid/decision` | F or H with `CONTENT_REVIEW_EXTERNAL` | own assignments | decision audited | `institution-content-reviews.controller.ts:47`, `:59`, `:68` |
| Student: `/students/me/applications/:id/institution-visibility/grant`, `/students/me/nominations` (+ accept, decline), `/students/me/outcome-declarations` (+ withdraw), `/students/me/counselling-notes`, `/students/me/learning-actions` | the student | self | each write audited | `student-hiring.controller.ts`, `campus-drive-nominations.controller.ts:492`, `:544`, `student-outcome-declarations.controller.ts:84-130`, `counselling-notes.controller.ts:450`, `institution-learning-actions.controller.ts:360` |

## Cross-cutting checklist (`719eb34`)

| Requirement | State | Evidence |
|---|---|---|
| Authorisation (401/403, other institution) | Met | Part A1, Part B1 |
| Scope on every student-level read | Met, with the unscoped-head read rule pending and two count leaks | INST-SR-02, INST-SR-11, INST-SR-15, INST-SR-16, INST-SR-18 |
| Scope on student-level writes | Met for permanent writes and every module since IM1 | Part B1; staff actions still use the read scope (INST-SR-02) |
| Consent (ADR-019, ADR-027, ENG-01, nominations, adaptive learning, self-reports) | Met for what is built | Part A3, Part B3; INST-SR-04 |
| Audit in the same transaction | Mostly met | Missing: readiness report generation (INST-SR-05), nomination reads (INST-SR-20) |
| Reason codes | Mostly met | Single-student relationship end (INST-SR-06); learning assignments, note sharing, policies, categories (INST-SR-24) |
| Data minimisation | Mostly met | Faculty-note text in audit (INST-SR-08); document version id in the queue (INST-SR-04) |
| Suppression under 5 | Met by one helper, with gaps | Part B5; INST-SR-12, INST-SR-15, INST-SR-16, INST-SR-17 |
| No compensation, no numeric readiness | Met; coverage partial for IM1-era responses | Part B4; INST-SR-14, INST-SR-23 |
| Exports gated, scoped, capped, audited, encoded | Met | Part B6; INST-SR-22, INST-SR-25 |
| Counselling notes restricted | Met | Part B7; INST-SR-23 |
| Error handling (`safeError`, correlation id) | Partly met | INST-SR-10 |
| Pagination bounds | Met for every list since IM1 except fixed caps | INST-SR-09 |
| CSV / formula safety | Met on output; the roster import still alters stored values | INST-SR-13 |

## Findings register

Status on `719eb34`. Severity is the finding's current severity. "Fixed" cites the commit and the
proving test.

| ID | Severity | Status | Title | Location (`719eb34`) | Why it matters | Fix / remaining work | Proving test |
|---|---|---|---|---|---|---|---|
| INST-SR-01 | High | **Fixed** (e2da7ea; tests 7ad90b3) | Readiness report published band cells under 5; caller chose the period | `packages/authorization/src/aggregate-suppression.ts:69`; `packages/persistence/src/career-readiness.ts:1012`; `apps/api/src/http/career-readiness.controller.ts:186` | — | — | `aggregate-suppression.test.ts` › "never leaves a hidden cell recoverable, over every small table"; `career-readiness.integration.test.ts` › "suppresses every band under 5 and any total that would recover one, in the response and the stored report"; `institution-student-scope.integration.spec.ts` › "refuses any period but one whole calendar month that has ended, and stores nothing" |
| INST-SR-02 | High | **Partly fixed** (e2da7ea) | Department heads with no unit scope are institution-wide | Writes fixed: `packages/authorization/src/institution-scope.ts:169`, used at `academic-records.controller.ts:182`, `:205`, `:227` and every module since. Still open: reads `institution-scope.ts:99`; staff-action writes `staff-actions.controller.ts:129-150`, `:262`, `:295`, `:331` | An unscoped head still reads every student of the college and can open interventions, tasks and notes on any of them | Decide the read rule (recommended: an unscoped head sees nobody), then move staff-action writes to the write scope | Writes: `academic-verification.integration.spec.ts` › "refuses a decision from a department head with no department, with SCOPE_REQUIRED, while the queue stays readable", › "refuses a results upload from a department head with no department, at preview and at commit, with SCOPE_REQUIRED". The open read behaviour is pinned by `institution-student-scope.integration.spec.ts` › "keeps a department head without a unit scope institution-wide until one is assigned" and `institution-department-workspace.integration.spec.ts` › "keeps an unscoped department head institution-wide for reads, as every other read does" — residual R-3 |
| INST-SR-03 | Medium | **Fixed** (c8458bd; tests 18978fa) | Assessment assignment ignored scope and wrote no audit | `institution-assessments.controller.ts:438-446`, `:463-467` | — | — | `institution-department-workspace.integration.spec.ts` › "assigns only students inside the caller's write scope, and records who assigned whom"; › "refuses a head with no department and faculty with no assignment, with SCOPE_REQUIRED, and writes nothing" |
| INST-SR-04 | Medium | Open | A student's term can cite a document version they do not own; the queue returns the version id to staff | `packages/persistence/src/academic-records.ts:193-218` (no ownership join), `:333` | The queue shows another person's document title and type and marks the claim document-backed; the future ADR-027 read path would key on it | Check ownership in `declareTerm` and by trigger; stop returning `evidenceDocumentVersionId` to staff | None |
| INST-SR-05 | Low | **Partly fixed** (9f9f759) | Reads of application records and report generation not audited | Fixed: `staff-actions.controller.ts:488`, `:538`, `:555`, `:590`. Open: `career-readiness.controller.ts:172-194`, `packages/persistence/src/career-readiness.ts:1049-1066` | §5.4 asks for audited reads | Audit report generation with the actor | Fixed part: `institution-placement-visibility.integration.spec.ts` › "audits each read, and a read outside scope as denied". Open part: none |
| INST-SR-06 | Low | **Partly fixed** (7c78982) | Ending a relationship takes no reason code | Fixed for year-end batches: `institution-relationship-batches.controller.ts:66-67`. Open: single-student route `operations-institution-onboarding.controller.ts:574-607` (audit context `{ state }` at `:604`) | §5.4 lists relationship changes as reason-coded | Require `reasonCode` on the single-student route | Batch: `institution-batch-lifecycle.integration.spec.ts` › "refuses unknown fields, REVOKED, missing or double targets, bad ids and dates, and a future date". Single: none |
| INST-SR-07 | Low | Open | Invitation resend has no cooldown or cap | `operations-institution-onboarding.controller.ts:615-642`; `packages/persistence/src/student-invitations.ts:168-215` | Repeated resends mail a student again and again | Per-student cooldown and a per-admin daily cap | None |
| INST-SR-08 | Low | **Partly fixed** (123c841) | Faculty-note text copied into the audit log; readable by every in-scope role | Counselling split off (INST-11). Open: `staff-actions.controller.ts:287-288` and the update audit (~`:356-358`); reads `:170-211` | Note text spreads to audit readers and to placement officers | Audit field names and lengths only | Counselling part: `counselling-notes.integration.spec.ts` › "audits every write without the note text". Faculty notes: none |
| INST-SR-09 | Low | Open (extended) | Unpaginated or fixed-cap lists | Roster `operations-institution-onboarding.controller.ts:425-447` (LIMIT 500); staff actions `staff-actions.controller.ts:170-211` (no limit); assessment results `institution-assessments.controller.ts:574`, `:598` (500). New fixed caps: department staff `institution-department-workspace.controller.ts:361` (500), department-overview batches `:136-141` (none), counselling cases `counselling-notes.controller.ts:191`, `:213` (200), drive results `campus-drives.controller.ts:613` (500), sprints (50), register (200 drives) | Large colleges lose rows silently | Keyset pagination, default 50, maximum 200 | None for these lists |
| INST-SR-10 | Low | Open | Errors outside the `safeError` convention | `operations-institution-onboarding.controller.ts:168`, `:211`, `:503`, `:567`, `:588`, `:600` (bare `Error`); `:1085-1093` (validation as 403); `:1188-1190`; roster commit `:823` (500 on a newly taken email); `academic-records.controller.ts:239`, `:242`, `:445-460` (no correlation id) | Screens cannot show a reference; wrong status codes | Map to `safeError` with the right status | None |
| INST-SR-11 | Low | Open | `student-activity-access` ignores the reader's scope | `phase1-security.controller.ts:25`; `api-security.ts:288-306` | A scoped reader can probe a student's relationship outside their scope (needs the user id) | Apply the scope helper or restrict to owners/admins | None |
| INST-SR-12 | Low | Open | Announcement "skipped" count can reveal one student turned email off | `institution-announcements.controller.ts:259`; `packages/persistence/src/institution-announcements.ts:183` | Small sections | Report "not emailed" without separating preference, or suppress | None |
| INST-SR-13 | Low | **Partly fixed** (a82116e; tests 7f539fc) | Formula guards input-side and inconsistent | Fixed on output: `institution-export-csv.ts:20-31`. Open: roster import alters stored values `operations-institution-onboarding.controller.ts:1094`, `:1130-1133` | A stored name differs from what the college typed | Stop altering stored roster values (output encoding already protects) | `institution-export-csv.test.ts` › "neutralises a formula-leading cell: %j" |
| INST-SR-14 | Low | **Partly fixed** | The no-compensation / no-numeric-readiness contract test does not cover every response | Covered: every module since IM1 (Part B4) plus the queue, settings, My Students. Not covered: roster list and detail, announcements, readiness report, assessment results and list, staff actions, per-student applications | A later join could leak a field unnoticed | One contract sweep over every institution GET and the report POST | Partial — Part B4 |
| **INST-SR-15** | **Medium** | New | Campus drive result counts ignore the reader's scope and relationship, and are suppressed one cell at a time | `apps/api/src/http/campus-drives.controller.ts:586-594`, returned at `:624` | A department head reads college-wide counts, including students who have left; `applied − offered` or `offered − selected` can give back a group of 1–4 (the register uses `publishedSubtotal` for the same figures) | Apply the read scope and the current-relationship rule to the counts, and `publishedSubtotal` for complementary suppression | None (both result tests use a whole-college reader) |
| **INST-SR-16** | **Medium** | New | A lecturer's assignment summary counts every assignee, including students who left or moved out of scope | `packages/persistence/src/faculty-learning-actions.ts:290-311` (summary) vs `:315-324` (per-student, current scope only) | Subtracting the per-student list from the summary tells the lecturer whether students who have left completed the work — activity after `effective_to` that the college should not see; the `<5` on `done` (`institution-learning-actions.controller.ts:123`) is cosmetic next to the per-student list | Bound the summary to the same current, in-scope students as the per-student list | None |
| INST-SR-17 | Low | New | Preparation sprint figures can be differenced, and sprint creation is a small-cell oracle | `institution-cohort-readiness.controller.ts:216-227` (a narrowed unit plus `NO_STUDENTS_WITH_GAPS`); `:320-323` (`workDone` suppressed alone) | Narrowing a sprint to a tiny section reveals whether anyone there has a gap; `workDone` beside `reached` can recover a small group | Refuse a sprint whose unit holds fewer than five current students; suppress `workDone` with `publishedSubtotal` | None |
| INST-SR-18 | Low | New | The sprint list shows every department's sprints to every reader | `packages/persistence/src/cohort-readiness.ts:317-324` (`listSprints`, no scope); free-text `note` and `unitName` | A department head sees other departments' sprints and notes (progress figures are scoped) | List only sprints whose unit or creator falls in the reader's scope | None |
| INST-SR-19 | Low | New | A college can cancel a declined nomination and nominate the student again, notifying them each time | `campus-drive-nominations.controller.ts:276` (cancel allowed on DECLINED), `:335` (uniqueness ignores CANCELLED), notices `:422-443` | Undercuts "decline without penalty"; repeated notices | Refuse re-nominating a student who declined for the same drive | None |
| INST-SR-20 | Low | New | Nomination candidate and nomination lists are not audited | `campus-drive-nominations.controller.ts:174`, `:221` | Named eligibility outcomes and responses are read with no record, unlike every other per-student read since INST-09 | Audit both lists | None |
| INST-SR-21 | Low | New | Faculty can read a student's shared applications through the per-student routes, though the placement-status list refuses them | `staff-actions.controller.ts:40` (`staffRoles` includes `FACULTY_LECTURER`), routes `:478`, `:545` | No recorded decision lets lecturers read application records; the INST-09 report lists only admin, placement office and head | Decide; if not intended, use `reviewRoles` on both routes | Pinned as allowed by `institution-student-scope.integration.spec.ts` › "shows department B faculty their own student only, and the administrator both" |
| INST-SR-22 | Low | New | The exit export shares INST-08's 30-a-day allowance; neither the limit nor its effect on a large exit is tested | `institution-contract.controller.ts:113-160`; `packages/authorization/src/institution-contract.ts:72-76` | A college with many sections and parts may need several days, or meet a refusal mid-export | Give the exit export its own allowance, or test and document the shared one | None (only the audit-action pattern is unit-tested) |
| INST-SR-23 | Low | New | Two regression guards are narrower than they look | `counselling-notes-exclusion.test.ts:38-52` matches only `FROM staff_actions` (a `JOIN staff_actions` is not checked, e.g. `privacy-export-sections.ts:367`); the CSV header guard blocks only `compensation*` and three exact names (`institution-export-csv.ts:35-38`) | A future join could read counselling notes; a future `salary`/`ctc`/`package` data column would pass the writer | Extend both guards | — |
| INST-SR-24 | Low | New | Some writes take no reason code, and several accept any well-formed code rather than a closed list | No code: note sharing `counselling-notes.controller.ts:340`, placement-policy set `campus-drives.controller.ts:684`, category create and set `institution-placement-register.controller.ts:301`, `:353`, learning assignment and group session `institution-learning-actions.controller.ts:139`, `:210`. Pattern only: exports `institution-exports.controller.ts:55`, counselling erase and participants `counselling-notes.controller.ts:30`, batches `relationship-lifecycle.ts:28`, capability grants `platform-controls.controller.ts:52` | §5.4 asks for reason codes on bulk actions; free codes weaken the audit | Closed lists server-side, matching the screens | None |
| INST-SR-25 | Low | New | The readiness-bands export stores its report outside the export transaction | `institution-exports.controller.ts:130` (`generateInstitutionAggregateReport(this.pool, …)`) | A refused or rolled-back export still leaves a stored report row | Generate inside the transaction | None |
| INST-SR-26 | Low | New | Test gaps on controls that exist | No test that a raw invitation token is absent from `audit_events` / `outbox_events`; no CR/LF test through the email subject (`packages/persistence/src/invitation-mail.ts:92`, `:617-618`; the recipient is tested in `smtp-mail-sender.test.ts` › "refuses a recipient address that could inject headers, without connecting"); exit cancel not reviving invitations is not asserted; no test sends 501 students to learning assignments or sprints | Controls could regress unnoticed | Add the four tests | — |

## Residual risks

Accepted-but-unfixed risks, each with an owner. Where Divakar has not decided, the entry says so.
None of them exposes pay, a numeric readiness value or another college's data.

| ID | Risk | Source | Owner | Decision |
|---|---|---|---|---|
| R-1 | Consecutive monthly figures give each month's movement; a relationship or consent change after a month ends changes that month's figures | INST-08, INST-12, INST-13, INST-17 design documents | Divakar | Documented residual risk, decision pending |
| R-2 | Linked tables — a head's department table and the admin's college table, the department-by-batch statistics — are protected margin by margin, not by a full linear audit | `placement-register-design.md`, `preparation-sprints-table-design.md` | Divakar | Documented residual risk, decision pending |
| R-3 | A department head with no department reads the whole college (INST-SR-02, read part); placement officers with no scope too | INST-02, SEC-INST decision (4) | Divakar | Decision pending (recommended: fail closed for reads) |
| R-4 | The exit export's staff-action and counselling-note sections are not limited to each student's relationship window (notes the screens hide after a student leaves can leave in the owner's export, with the flag and a listed reason) | `packages/persistence/src/institution-contract.ts:814-822`, `:843-850` | Divakar | Documented residual risk, decision pending (the college's own records) |
| R-5 | A lecturer sees *Done / Not yet* of work they assigned without the student's adaptive-learning consent | INST-16 decision 3 | Divakar | Taken as recommended in INST-16; disclosure sentence awaits HG-6 legal review |
| R-6 | The Android consent gate has no automated test (the app has no test source set) | `apps/android/app/src/` (main only) | Divakar | Documented residual risk, decision pending |
| R-7 | A student who withdraws after opting in is distinguishable from one who declined | INST-14 limitation | Divakar | Documented residual risk, decision pending |
| R-8 | Graduates' self-reports made after graduation count, past the relationship's historical cut-off for this one fact | INST-13 decision 2 | Divakar | Taken as recommended in INST-13 |
| R-9 | A year-end action can be backdated to any date after the student joined, narrowing what the college sees retroactively (reason-coded and audited) | `institution-relationship-batches.ts` | Divakar | Documented residual risk, decision pending |
| R-10 | The purge's exception to the 0082 delete guards protects against application mistakes, not a writer with SQL access | INST-18 risks | Divakar | Documented residual risk, decision pending |
| R-11 | The privacy-notice gate is a client control; the API does not refuse institution reads when a caller's privacy-notice consent is missing (platform-wide) | Part A3 note | Divakar | Documented residual risk, decision pending (platform review) |
| R-12 | Legal text: the data-processing terms, the counselling DPDP statements, ADR-019's notice text, the nomination and self-report wording, the engine consent notice — all drafts for legal review | HG-6; INST-11, INST-13, INST-14, INST-18 | Divakar | Pending legal review |

## Known open items (not findings; tracked elsewhere)

- **HG-3** — only faculty have a `Messages` item, so the announcements composer is reachable only by
  faculty; the API serves owners, admins, placement officers and heads. The placement officer has no
  Drives item and no Interventions item (a placement officer who is a counselling-case participant has
  the API but no screen).
- **HG-6** — engine consent definitions are unpublished, so the adaptive path, the faculty cohort view
  and the student's plan are empty for everyone.
- **Email** — the SMTP sender is built (ADR-042) but not switched on in production; the sender mailbox
  is still to be set up; the automation worker is not deployed on AWS. Invitations and announcement
  emails are recorded as not sent.
- Student-pool access tokens must carry `email` and `email_verified` for student acceptance to work
  (Cognito configuration).
- ADR-027 per-version document consent is not built, so no staff role can open evidence.
- `institution-content-reviews.controller.ts:112` filters memberships by organisation only, not also by
  `scope.institutionId` as other institution guards do (informational; the grant check follows).
- The INST-18 goal report in `docs/institution/INSTITUTION_PROGRESS.md` still reads "Validation: pending";
  no result was recorded after it.
