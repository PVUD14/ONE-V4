# Institution portal security review — IM1 slice

> What this is: the INST-19 security review of the institution portal for the first slice (milestone
> IM1), written by reading the code on the program base branch. Why it exists: INST-19 requires every
> institution threat to map to a control and a test, or to be listed as an open problem. Program rule
> B.2 applies — residual risks are recorded only after fixes merge, so everything unresolved here is
> an **open finding**, not an accepted risk.

| | |
|---|---|
| Review target | `feat/plan-phases-0-to-2` at commit `6864332` (worktree `E:/one-wt/doc1`) |
| Date | 2026-09-26 |
| Scope | IM1 slice: INST-01 student invitations, INST-02 scope helper, INST-03 teaching assignments, INST-04 academic verification and results upload, INST-05 settings and calendar, INST-06 announcements, ENG-01 consent gate, and the pre-existing institution routes they touch (roster, staff actions, applications views, assessments, readiness report, capabilities) |
| Out of scope (mapped to later goals) | Student lifecycle and bulk roster actions (INST-10), analytics capability enforcement, exports and accreditation packs (INST-08, INST-13), department-scoped modules (INST-07), consented application status for the placement office (INST-09), counselling cases and notes (INST-11), placement register, drives and offers (INST-12), learning resources (INST-16), cohort readiness by career role (INST-17), college exit and deletion (INST-18), ADR-027 per-version document consent (needs its own table design) |
| Method | Code reading of every `/api/v1/institutions/:institutionId/…` route, its persistence functions, migrations and the web/Android clients; each control cited as `file:line` (repo-relative) and matched to a named test found by grep. No code was run or changed. Test names are quoted exactly; "no test" means none was found. |

## Conclusion

The slice's core controls hold: every institution route requires an active membership of the
institution in the URL before the controller runs, and every route that reads student-level data
calls the single INST-02 scope helper — with one read (a relationship probe) and one write
(assessment assignment) outside it. Invitation tokens are hashed, single-use, email-bound and
rotated. The ENG-01 consent check fails closed server-side and in both clients.

**Open findings: 14 — Critical 0, High 2, Medium 2, Low 10.**

The two High findings are (1) the readiness report publishes per-band counts below 5 with a
caller-chosen period, and (2) department heads (and faculty before their college records teaching
assignments) with no unit scope are treated as institution-wide — including for permanent
verification writes. Neither is fixed on this base.

## Files reviewed

- API: `apps/api/src/http/api-security.ts`, `operations-institution-onboarding.controller.ts`,
  `staff-actions.controller.ts`, `academic-records.controller.ts`, `career-readiness.controller.ts`,
  `institution-assessments.controller.ts`, `institution-teaching-assignments.controller.ts`,
  `institution-settings.controller.ts`, `institution-announcements.controller.ts`,
  `institution-student-scope.ts`, `institution-staff-scope.ts`, `phase1-security.controller.ts`,
  `platform-controls.controller.ts` (institution capability routes).
- Authorization and persistence: `packages/authorization/src/institution-scope.ts`,
  `packages/persistence/src/institution-scope.ts`, `student-invitations.ts`, `invitation-mail.ts`,
  `identity-authentication.ts`, `academic-records.ts`, `academic-results-import.ts`,
  `institution-announcements.ts`, `career-readiness.ts` (`generateInstitutionAggregateReport`),
  `consent-purposes.ts`, `packages/identity/src/invitation-token.ts`.
- Migrations: `0001` (unit and membership composite keys), `0017`, `0019`, `0028`, `0037`, `0040`,
  `0044`, `0046`, `0070`.
- Clients: `apps/web/src/consentGate.tsx`, `rolePortalPages.tsx`, `rolePortalConfig.ts`,
  `institutionReportsPage.tsx`, `staffDashboardsV3.tsx`, `rolePortal/institution*.tsx`;
  `apps/android/.../MainActivity.kt`, `StaffDashboards.kt`, `AcademicVerification.kt`.
- Tests: the institution integration specs in `apps/api/src/http/`,
  `packages/authorization/src/institution-scope.test.ts`,
  `packages/persistence/test/consent-purposes.integration.test.ts`, `apps/web/src/consentGate.test.tsx`.
- Design: `docs/architecture/ADR-019…`, `ADR-024…`, `ADR-027…`, the INST-01/03/04/05/06 table designs,
  `docs/institution/INSTITUTION_PROGRESS.md`.

---

## 1. Cross-scope and cross-institution access

### Verified controls

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

### Open findings

- **INST-SR-02 (High)** — unscoped department heads and faculty fail open, including for writes. See register.
- **INST-SR-03 (Medium)** — assessment assignment is not scoped and not audited. See register.
- **INST-SR-11 (Low)** — unscoped relationship probe. See register.

## 2. Invitation token abuse

### Verified controls

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

### Open findings

- **INST-SR-07 (Low)** — resend has no cooldown or rate limit. See register.

## 3. Consent bypass

### Verified controls

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

### Open findings

- **INST-SR-04 (Medium)** — a term can cite another person's document version. See register.

## 4. Compensation leakage (ADR-024)

### Verified controls

| Control | Where | Proving test |
|---|---|---|
| The consented-applications view returns offer existence and response state only, never terms | `staff-actions.controller.ts:512-527` | `staff-actions.integration.spec.ts` › "returns only the granted student application and allowed fields, without selecting forbidden columns" (asserts the offer keys are exactly `exists`, `responseState`) |
| No institution controller selects a `compensation_*` column (grep of `apps/api/src/http/*institution*`, `staff-actions`, `academic-*`, `career-readiness`) | — | `academic-verification.integration.spec.ts` › "never returns a numeric readiness value or compensation"; `institution-settings.integration.spec.ts` › "carries no compensation and no numeric readiness in any settings response"; `institution-teaching-assignments.integration.spec.ts` › "lists assigned students with activation, recent assessments and open tasks, and no compensation or readiness number" |

Not in this slice: the placement register and offers (INST-12), where the ADR-024 contract test
matters most.

### Open findings

- **INST-SR-14 (Low)** — the §6.3 contract test does not cover every institution response. See register.

## 5. Small-cell re-identification

### Verified controls

| Aggregate | Assessment |
|---|---|
| Readiness report | Whole-cohort suppression under 5 only (`packages/persistence/src/career-readiness.ts:932-933`, `:961-963`); test `career-readiness.integration.test.ts` › "suppresses institution aggregates below the privacy threshold". Band cells are **not** suppressed — INST-SR-01. |
| Activation summary | Counted server-side over the same scoped rows the caller already sees by name (`operations-institution-onboarding.controller.ts:448-453`); no re-identification beyond the list. Test: "reports a Dashboard summary that matches the Students list". Acceptable. |
| Verification summary | Same shape as the queue the caller can read (`academic-records.ts:388-411`). Acceptable. |
| Announcement delivery counts | INST-06 decided not to suppress: the sender can list the audience by name. Accepted for delivery failures, but the "skipped" count mixes a personal preference (email turned off) into it — INST-SR-12. |

There is **no shared suppression helper for institution aggregates**. Two exist on the operations
side and are unused here: `packages/authorization/src/operations-overview.ts:84` and
`packages/authorization/src/privacy-console.ts:42`.

### Open findings

- **INST-SR-01 (High)** — readiness band cells under 5 are published. See register.
- **INST-SR-12 (Low)** — announcement "skipped" count. See register.

## 6. Export abuse

### Verified controls

- **No institution export exists on this base.** The dashboard "Export Report" button only navigates
  to Assessments (`apps/web/src/staffDashboardsV3.tsx:106`). Nothing is written back out as CSV.
- Roster import CSV: at most 512 000 characters, 500 rows and 16 columns; cells starting `= + - @` are
  prefixed with `'` (`operations-institution-onboarding.controller.ts:1070-1080`, `:1116-1119`).
  Test: `api-security.integration.spec.ts` › "validates and commits roster CSV without raw preview mutation".
- Results upload CSV: at most 512 000 characters and 1 000 rows; formula-prefixed identifiers, labels
  and programmes are rejected as invalid rows (`packages/persistence/src/academic-results-import.ts:26-28`,
  `:89-92`, `:214-225`). Test: `academic-verification.integration.spec.ts` › "previews row by row, writes
  nothing, and a commit with any invalid row writes nothing either".
- `INSTITUTION_ANALYTICS` can be granted and revoked by admins with a reason code
  (`platform-controls.controller.ts:105-160`), but **nothing enforces it yet** — it must gate the first
  export (INST-08). Not in this slice.

### Open findings

- **INST-SR-13 (Low)** — formula guards are input-side and inconsistent. See register.

## 7. Counselling-note exposure

Not in this slice: counselling cases and notes (INST-11). What exists today is the `FACULTY_NOTE`
staff-action type: `STAFF_ONLY`, readable by every staff role inside the reader's scope
(`staff-actions.controller.ts:170-188`), never shown to the student (test: "denies STAFF_ONLY items and
rechecks visibility revocation after the student reads").

### Open findings

- **INST-SR-08 (Low)** — note text is copied into the audit log and readable by every in-scope role. See register.

## 8. Bulk-action misuse

### Verified controls

| Bulk action | Roles | Scope | Bounds | Audit and reason | Stale preview |
|---|---|---|---|---|---|
| Resend invitations (`onboarding:612-640`) | Owner, admin | Institution-wide (admin) | ≤ 500 ids, or `all` ≤ 2 000 | Reason code required (`:619`); audit per invitation | n/a |
| Roster import (`onboarding:766-837`) | Owner, admin | Institution-wide | ≤ 500 rows | `institution.roster_import.validated` / `.committed` (`:794`, `:833`); no reason code | Rows persisted at preview; a clash at commit surfaces only as a database error (INST-SR-10) |
| Results upload (`academic-records.controller.ts:198-244`) | Owner, admin, department head (`:69`) | Roster filtered by scope (`academic-results-import.ts:181-188`) | ≤ 1 000 rows | Reason code required (`:283`); preview, per-term and per-upload audit in the transaction (`academic-results-import.ts:309`, `:348-353`, `:393-399`) | Digest re-evaluated under an advisory lock; mismatch → **409** (`:338-342`; controller `:237`) |
| Assessment assignment (`institution-assessments.controller.ts:414-471`) | Any staff role | **None** | ≤ 500 profiles | **No audit** | n/a |

Tests: `academic-verification.integration.spec.ts` › "requires a token and an uploader role in this
institution", "refuses a commit whose records changed since the preview", "limits a department head to
their own department", "commits institution-verified records attributed to the uploader, each audited";
`institution-roster-activation.integration.spec.ts` › "requires a reason code and an admin to resend,
and skips students already activated".

### Open findings

- **INST-SR-02**, **INST-SR-03**, **INST-SR-07** (above).

## 9. Other controls checked

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

## Route inventory

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
| POST `…/assessments/:definitionId/assignments` | Staff | **No** — INST-SR-03 | `institution-assessments.controller.ts:414` |
| GET `…/assessments/:definitionId/results` | Staff | **Yes** | `institution-assessments.controller.ts:535` (`:545`) |
| Settings, grading scales, academic terms, staff profile | Staff read; owner/admin write; own preferences | n/a | `institution-settings.controller.ts:76-319` |
| GET/POST `…/teaching-assignments`, `…/:assignmentId/end` | Admin, head (department), faculty (own) | Unit-based by role | `institution-teaching-assignments.controller.ts:70`, `:107`, `:155` |
| GET `…/my-students` | Faculty | **Yes** | `institution-teaching-assignments.controller.ts:195` (`:210`) |
| POST `…/staff-memberships/:membershipId/scope` | Owner, admin | n/a | `institution-teaching-assignments.controller.ts:281` |
| GET `…/student-activity-access/:studentUserId` | Staff | **No** — INST-SR-11 | `phase1-security.controller.ts:25`; `api-security.ts:261` |
| GET/POST `…/capabilities`, `…/:capabilityId/revoke` | Owner, admin | n/a | `platform-controls.controller.ts:105`, `:113`, `:145` |

## Cross-cutting checklist

| Requirement | State | Evidence |
|---|---|---|
| Authorisation (401/403, other institution) | Met | §1 verified controls |
| Scope on every student-level read | Met for reads except one probe | Route inventory; INST-SR-11 |
| Scope on student-level writes | Not met | INST-SR-03; unscoped heads INST-SR-02 |
| Consent (ADR-019, ADR-027, ENG-01) | Met for what is built | §3; INST-SR-04 |
| Audit in the same transaction | Mostly met | Missing on assessment assignment (INST-SR-03), application reads and report generation (INST-SR-05) |
| Reason codes | Mostly met | Relationship end has none (INST-SR-06) |
| Data minimisation | Mostly met | Note text in audit (INST-SR-08); document version id in queue (INST-SR-04) |
| Suppression under 5 | Not met | INST-SR-01; no shared helper |
| No compensation, no numeric readiness | Met; coverage partial | §4; INST-SR-14 |
| Error handling (`safeError`, correlation id) | Partly met | INST-SR-10 |
| Pagination bounds (default 50, max 200) | Partly met | INST-SR-09 |
| CSV / formula safety | Met for imports; no export yet | §6; INST-SR-13 |

## Open findings register

| ID | Severity | Title | Location | Why it matters | Fix | Proving test |
|---|---|---|---|---|---|---|
| INST-SR-01 | High | Readiness report publishes band cells under 5; no complementary suppression; caller picks the period | `packages/persistence/src/career-readiness.ts:955-963`; `apps/api/src/http/career-readiness.controller.ts:146-166`; web `apps/web/src/institutionReportsPage.tsx:108-112` | A department head can read "1 student in band X" for a small department, and difference two overlapping periods to isolate one student's band — contrary to §5.2/§5.3 | Add one institution suppression helper (cell < 5 → `<5`; suppress totals that would recover it); apply to every band cell; restrict periods to fixed windows | None (only whole-cohort suppression is tested) |
| INST-SR-02 | High | Department heads (and faculty before assignments) with no unit scope are institution-wide, for reads **and** permanent writes | `packages/authorization/src/institution-scope.ts:97-98`; used by `academic-records.controller.ts:181`, `:204`, `:226` | Every head invited before INST-03 or without a department sees every student and can verify or bulk-import results for the whole college; verification is permanent (0070 trigger). The announcement path already fails closed (`institution-scope.ts:150`) | Review existing memberships, then fail closed for `DEPARTMENT_HEAD` without a department (INST-03 recommendation); at minimum refuse decide/results import/teaching writes from an unscoped head | The fail-open behaviour is pinned by `institution-student-scope.integration.spec.ts` › "keeps a department head without a unit scope institution-wide until one is assigned" — needs replacing |
| INST-SR-03 | Medium | Assessment assignment ignores scope and writes no audit row | `apps/api/src/http/institution-assessments.controller.ts:414-471` (eligibility `:436-440`, notification `:452-458`) | Faculty or a head can assign any active student of the college and push an in-app notification to them; untraceable | Filter eligible students with `institutionStudentScopeSql`; audit `institution.assessment.assigned` in a transaction | None |
| INST-SR-04 | Medium | A student's term can cite a document version they do not own | `packages/persistence/src/academic-records.ts:193-214`; `academic-records.controller.ts:381`; queue `academic-records.ts:333`, `:349-355` | The queue then shows another person's document title and type to the college, marks the claim DOCUMENT_BACKED, and returns the internal version id; the future ADR-027 read path would key on it | Check the version belongs to the student (join `student_document_metadata`) in `declareTerm` and by trigger; stop returning `evidenceDocumentVersionId` to staff | None |
| INST-SR-05 | Low | Reads of application records and readiness-report generation are not audited | `staff-actions.controller.ts:473-579`; `career-readiness.ts:965-972` | §5.4 requires reads of application records to be audited | Write `institution.student_applications.viewed` / report-generated audit rows | None |
| INST-SR-06 | Low | Ending a student relationship takes no reason code | `operations-institution-onboarding.controller.ts:571-605` (audit context `:601`) | §5.4 lists relationship changes as reason-coded | Require `reasonCode`; record it in the audit row and outbox payload | None |
| INST-SR-07 | Low | Invitation resend has no cooldown or rate limit | `operations-institution-onboarding.controller.ts:612-640`; `student-invitations.ts:166-220` | Each resend mails the student again with a fresh link; repeated resends can flood an inbox | Per-student cooldown (e.g. one per 24 h) and a per-admin daily cap | None |
| INST-SR-08 | Low | Faculty-note text is copied into `audit_events.context` and readable by every in-scope staff role | `staff-actions.controller.ts:287-290`, `:170-188` | Notes about a student spread to the audit log's readers and to placement officers; INST-11 will need tighter rules | Audit field names and lengths, not text; restrict `FACULTY_NOTE` reads when INST-11 lands | None |
| INST-SR-09 | Low | Several lists are unpaginated or over the 200 maximum | Roster `…onboarding.controller.ts:446` (LIMIT 500, no cursor); staff actions `staff-actions.controller.ts:170-211` (no limit); results `institution-assessments.controller.ts:556`, `:580` (500) | §5.6; unbounded reads grow with the college | Keyset pagination, default 50, maximum 200 | None |
| INST-SR-10 | Low | Error responses outside the `safeError(code, correlationId)` convention | `…onboarding.controller.ts:500`, `:585`, `:597` (bare `Error` → 500), validation failures returned as 403 (`:1070-1080`), `requireObject` message; `academic-records.controller.ts:437-443` and `:236-240` (no correlation id) | Screens cannot show a correlation id; wrong status codes hide validation errors; a roster commit that meets a newly-taken email fails as a 500 | Map to `safeError` with the right status and correlation id | None |
| INST-SR-11 | Low | `student-activity-access` answers for any student of the institution, ignoring the reader's scope | `apps/api/src/http/phase1-security.controller.ts:25`; `api-security.ts:261-279` | A scoped head or lecturer can probe relationship status of students outside their scope (needs the user id) | Apply the scope helper, or restrict to owners/admins | None |
| INST-SR-12 | Low | Announcement "skipped" count can reveal that a named student turned email off | `institution-announcements.controller.ts:226-258`; `packages/persistence/src/institution-announcements.ts:181-186` | In a small section the sender can infer an individual's preference | Report "not emailed" without separating preference from activation, or suppress under 5 once the helper exists | None |
| INST-SR-13 | Low | Formula-injection guards are input-side and inconsistent | Roster prefixes and stores `'` (`…onboarding.controller.ts:1116-1119`); results reject (`academic-results-import.ts:28`); announcements and staff-action notes have none (`institution-announcements.controller.ts:288-289`) | Safe today because nothing is exported; the first export (INST-08) would otherwise emit raw formulas, and the roster stores altered values | Encode on output in the export writer; stop altering stored roster values | `api-security.integration.spec.ts` › "validates and commits roster CSV without raw preview mutation" covers input only |
| INST-SR-14 | Low | The §6.3 contract test (no `compensation_*`, no numeric readiness) does not cover every institution response | Covered: queue, settings, My Students, applications keys. Not covered: roster list/detail, announcements, readiness report, assessment results, teaching assignments | A later join could leak a field unnoticed | One contract sweep over every institution GET and the report POST | Partial — see §4 |

## Known open items (not findings; tracked elsewhere)

- **HG-3** — only faculty have a `Messages` item, so the announcements composer is reachable only by
  faculty; the API already serves owners, admins, placement officers and heads.
- **HG-6** — consent definitions and the 18+ wording are unpublished, so the consent gate is dormant.
- **HG-7** — no production sender: invitation and announcement emails are recorded `NOT_CONFIGURED`.
- Student-pool access tokens must carry `email` and `email_verified` for student acceptance to work
  (Cognito configuration, not code).
- ADR-027 per-version consent is not built, so evidence cannot be opened by any staff role.
- The INST-03 recommendation to fail closed for unscoped department heads has not been applied (see INST-SR-02).
- `INSTITUTION_ANALYTICS` is grantable but not yet enforced; it must gate the first export (INST-08).

**Residual risks: none recorded in this slice (program rule B.2).**
