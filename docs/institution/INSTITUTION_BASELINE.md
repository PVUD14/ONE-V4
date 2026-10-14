# Institution baseline

> INST-00: the institution portal as it really is on the base branch, and the defects I-1…I-11 checked against code, so INST goals fix what exists.

Date: 2026-09-25 · Base: feat/plan-phases-0-to-2 @ d6687f2 (copied from OPS-00). Line numbers refer to
d6687f2. `onb` = apps/api/src/http/operations-institution-onboarding.controller.ts.

## 2.2 Navigation (actual; labels must not change)

Empty-state fallbacks: faculty/department head → `AuthenticatedReadOnlyModule` "View-only for your role"
(rolePortalPages.tsx:325); others → `AuthenticatedNotYetAvailable` "Not built yet" (:326). All four
institution dashboards render `InstitutionDashboardV3` (:185–188), which calls the unscoped student list.

- **Institution admin** (rolePortalConfig.ts:107, 12 items): Dashboard, Students, Student Detail (same
  roster page — no per-student view), Academic Structure, Assessments, Interventions, Staff, Reports,
  Help & FAQ = working; Career Readiness, Placement = View-only; Settings = Not built yet. Plan confirmed,
  plus the Student Detail note.
- **Placement officer** (:117, 8 items): all working. **Corrected:** "no placement features" — Students
  has a consent-shared native + external applications view (rolePortal/institution.tsx:426–541). Student
  Search = same page as Students. No Settings item.
- **Department head** (:136, 14 items): 5 working, 9 empty — confirmed.
- **Faculty** (:122): **15 items, not 16**; 8 working, 7 empty (My Students, Assessment Detail, Learning
  Resources, Reports, Messages, Profile, Settings).
- Android merges all institution roles into one INSTITUTION workspace (StaffDashboards.kt:66–85).

## 2.3 API (corrections only; the rest confirmed)

- GET …/units is **staff**, not admin (onb:352–359).
- Assessments: no department/batch predicate on any route; faculty can assign to and read results for the
  whole institution (institution-assessments.controller.ts:412–470, 533–596).
- Academic verification queue/decide: guard requires organisation **and** scope organisation to equal the
  institution (academic-records.controller.ts:164–175) — cross-institution access is blocked
  (subagent claim of a missing check was checked and is **wrong**). No department/batch predicate.
- Career-readiness report is **one overall band distribution for the cohort**, not bands per topic;
  suppressed under 5 (persistence/src/career-readiness.ts:829–857).
- Applications endpoints ARE used by the placement officer's Students screen (direct fetch, not api.ts).

## 2.4 Defects

| ID | Verdict | Statement / correction | Evidence |
|---|---|---|---|
| I-1 | **Confirmed (sharper)** | Roster create and import commit insert `users(state='INVITED', external_subject NULL)` + profile `status='INVITED'` + ACTIVE relationship; no invitation, notification command or email. Sign-in resolves users **only** by `external_subject` and requires ACTIVE → rostered students get 403. The invitation-acceptance path already matches by external_subject **or lower(email)** and would bind them, but is never used for students. Knock-on: profile status never becomes ACTIVE, so rostered students are excluded from staff actions, assessment assignment and hiring joins | onb:453–457, 744–747, 568; identity-authentication.ts:28–44, 142–161; principal.ts:80–83; staff-actions.controller.ts:154, 231; institution-assessments:435–439; employer-hiring.controller.ts:207, 436, 461, 626 |
| I-2 | **Confirmed (wider)** | Student list and single-student reads filter by institution only. Same gap in assessment assignment/results and the verification queue. Also: staff invitations never carry a department/batch scope (onb:655; invite form sends email+role), so in practice every department head and faculty member is institution-wide even under the staff-actions predicate. INST-02 needs scoped invitations/assignment as well as read predicates | onb:418–433, 488–500; staff-actions predicate :99–101 (applied :157, :179–181, :196–197, :232) |
| I-3 | Confirmed | No teaching-assignment table/column/route; My Students is View-only | drizzle grep; rolePortalPages.tsx:325 |
| I-4 | **Corrected** | `AcademicVerificationPage` exists (fd53ac1) and calls the queue/decide endpoints, but is mounted only in faculty/department-head portals under a condition requiring an OWNER/ADMIN workspace role — **unreachable**. Admin nav has no Academic Verification item. Faculty item shows ACADEMIC_VERIFICATION staff actions only | rolePortalPages.tsx:317–319; shared.tsx:18–22; App.tsx:288, 559–571; institution.tsx:251–257 |
| I-5 | **Corrected** | Placement officer has a "View applications" panel using both consent-gated endpoints; no screen for admin, department head or faculty; no typed client in api.ts | institution.tsx:426–541 |
| I-6 | Confirmed (+) | `organization_profiles` (0005) is written only by Operations; no institution-side settings/profile API | onb:176, 868 |
| I-7 | **Corrected** | Department head 9/14 empty (confirmed); faculty **7/15** (not 7/16) | rolePortalConfig.ts:122, 136 |
| I-8 | Confirmed | No drive/company/offer-register/placement-stats tables or routes | grep |
| I-9 | Confirmed (stronger) | Capability grantable by API only, and **nothing reads it**; trigger limits grants to INSTITUTION_ADMIN / DEPARTMENT_HEAD; no CSV exports | platform-controls.controller.ts:84–147; 0031:30, 61–63 |
| I-10 | Confirmed | Kinds EXAM_ASSIGNED, EXAM_REOPENED, RESULT_PUBLISHED, SYSTEM (0013:16); never widened; SYSTEM has no writer | notify.ts:6, 20–45 |
| I-11 | Confirmed | Relationship change per profile only (TRANSFERRED/GRADUATED/ENDED/REVOKED); no bulk; no reactivation | onb:544–573; institution.tsx:74 |

## How students sign in today

The API's only verifier is Cognito access-token verification (runtime-auth.ts:4–16; identity/cognito.ts);
no local bypass. Web signs in via Cognito Hosted UI or SRP (web/src/auth.ts:100–160); `demo.*` and
`VITE_PILOT_ACCOUNTS` identities get the fictional PilotApp. Lookup: token `sub` →
`users.external_subject` (email not used) → must be ACTIVE → ACTIVE memberships; student shell then needs
a profile and a current ACTIVE/VERIFIED relationship (`/students/me`, api-security.ts:195–237).

**No committed seed creates a student** — seed-local-users.ts creates only three content-governance
accounts. A student can sign in only if someone writes a users row with their Cognito `sub` outside the
repo (e.g. the UAT accounts). **A rostered student cannot sign in.**

`apps/api/src/application/identity-organization/services.ts` is an in-memory domain model used only by a
test; the plan's reference to it as the request path is wrong.

## Reproduction (I-1, I-2)

Draft vitest specs (mirroring staff-actions.integration.spec.ts: throwaway schema, stub verifier):
`i1-roster-activation.repro.test.ts` and `i2-student-scope.repro.test.ts` (kept outside the tree until their fixes land).
Each becomes the first commit of INST-01 / INST-02, together with its fix. Run results and the manual procedures (which need a non-production Cognito dev pool) are in INSTITUTION_PROGRESS.md.

## Other corrections

1. Roster import preview counts WARNING rows, but evaluation never yields WARNING (onb:1088) and commit
   takes only VALID (onb:738).
2. CAREER_COUNSELOR has nav config but no web workspace mapping (App.tsx:559–571) and is absent from the
   API staff role list (onb:73), though `institutionStaffWorkspaceRoles` includes it (shared.tsx:26).
3. Stale comment rolePortalPages.tsx:268–272 (Departments/Batches now render read-only).
4. help-articles.ts:128 (HEAD) advertises "placement drives" and "roster by department and batch" —
   neither exists. That file has uncommitted edits in the main checkout; recheck before editing.
