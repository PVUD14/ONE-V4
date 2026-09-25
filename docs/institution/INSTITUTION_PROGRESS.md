# Institution portal progress

> Goal reports for the institution plan (docs/institution/INSTITUTION_PORTAL_PLAN.md), newest last, in the plan's Section 0.6 format.

Base branch: **feat/plan-phases-0-to-2** — the most advanced non-main branch; it contains all of
integration plus the plan-phase work. Chosen 2026-09-25 (OPS-00); head c802d3b after PRG-FIX.
Repository: PVUD14/ONE-V4 (private). Goal branches are cut from the base and merged back into it;
main and production are released by Divakar only.

## INST-00 — Institution baseline and defect reproduction — 2026-09-25
**Result:** Complete — every I-1…I-11 row marked with evidence; I-1 and I-2 reproduced.
**Branch / PR:** docs/program-baselines (baseline documents only; no application code changed).
**Files created:** docs/institution/INSTITUTION_BASELINE.md, docs/institution/INSTITUTION_PROGRESS.md; reproduction specs held until their fixes: i1-roster-activation, i2-student-scope.
**Migrations added:** none.
**Validation:** the base-branch results above. Reproduction specs run temporarily from
`apps/api/src/http/` in the clean worktree against a fresh local database, then deleted:
I-1 — 2 fail as expected (no invitation issued for created or imported students), 1 guard passes;
I-2 — 4 fail as expected (department-/batch-scoped FACULTY_LECTURER and DEPARTMENT_HEAD see all 3
students; out-of-scope single read returns 200, not 403), control (staff actions scoped) and guard
(unscoped admin sees all) pass.
**Acceptance criteria:** I-1…I-11 each marked ✔ (Confirmed: I-1, I-2, I-3, I-6, I-8, I-9, I-10, I-11;
Corrected: I-4, I-5, I-7). Base branch recorded ✔.
**Decisions for Divakar:** none new.
**Limitations / corrections to the plan:** faculty nav has 15 items, not 16. `services.ts` is an in-memory
model, not the request path. No committed seed creates a student. The academic-verification page exists
but cannot be reached. The placement officer already has a consented-applications view. Staff invitations
never carry department/batch scope, so INST-02 must also add scoped invitations/assignment. A subagent
claim that the academic-verification guard lacked an institution check was checked and is wrong — the guard
requires both organisation and scope to match.
**Manual reproduction (needs a non-production Cognito dev pool):**
I-1 — migrate a fresh DB; insert an INSTITUTION org, an ACTIVE admin user whose external_subject is the
admin's Cognito sub, and an INSTITUTION_ADMIN membership; sign in, add a student whose email has its own
Cognito user; observe users.state INVITED / external_subject NULL, 0 invitations, profile INVITED;
sign in as the student → `/api/v1/security/context` 403. Same via student-imports preview + commit.
I-2 — create DEPARTMENT units A and B, two ACTIVE students (one per department), a FACULTY_LECTURER
membership scoped to B; `GET …/students` returns both; `GET …/students/<A profile>` returns 200 with
email; `GET …/staff-actions` lists only the B student.
**Risks / follow-ups:** reproduction specs become the first commit of INST-01 / INST-02 together with
their fixes, never earlier.
**Next goal:** INST-02 (blocked this run by the A.4 stop).

## INST-02 — One scope helper, enforced on every institution read — 2026-09-25
**Result:** Complete — every student-level institution read now filters by the reader's unit scope through one definition; administrators' results are unchanged.
**Branch / PR:** fix/inst-scope-enforcement → feat/plan-phases-0-to-2 (no PR: `gh` is not installed; merged under the program's merge policy after full validation).
**Files created:** packages/authorization/src/institution-scope.ts (+ .test.ts); packages/persistence/src/institution-scope.ts; apps/api/src/http/institution-student-scope.ts; apps/api/src/http/institution-student-scope.integration.spec.ts.
**Files modified:** operations-institution-onboarding.controller.ts (student list, detail; list returns `scope`); staff-actions.controller.ts (local predicate replaced — covers applications and external applications through `subject()`); academic-records.controller.ts and persistence/academic-records.ts (queue scoped; a decision on an out-of-scope term is refused); career-readiness.controller.ts and persistence/career-readiness.ts (report scoped; aggregate records `scope`); institution-assessments.controller.ts (results, not-attempted list, assigned count); web api/institution.ts and rolePortal/institution.tsx (roster subtitle); persistence/package.json and pnpm-lock.yaml (authorization dependency).
**Migrations added:** none.
**Design docs / ADRs:** none required (no new table); the rule and its reasoning are in the header of packages/authorization/src/institution-scope.ts.
**Validation:** fresh local database, only DATABASE_URL exported — typecheck pass · test pass, 1 139 passed / 0 failed (api 367 incl. 14 new, web 367 incl. 1 new, authorization 60 incl. 11 new, persistence 163, others) · build pass.
**Acceptance criteria:**
- Every endpoint listed has cross-scope denial tests (department A vs B; faculty outside scope) ✔ — roster list and detail, applications, external applications, verification queue and decide, readiness report, assessment results, staff actions.
- Admin results unchanged ✔ — tested on list, detail, applications, queue, report and results.
- Staff-action tests pass unchanged after the predicate move ✔ (existing staff-actions spec untouched and green).
- Screens show the scope in the subtitle ✔ — "Showing students in <units>." on both roster pages.
**Decisions for Divakar:** (1) Section 5.1 / decision 10.2 #2 adopted. (2) A placement admin, department head or faculty membership with **no** unit scope stays institution-wide (the staff-action rule the plan cites for faculty); failing closed would empty every current department-head workspace because invitations cannot set a scope yet. Recommended next: let admins set department/batch when inviting or assigning staff (INST-03), then consider failing closed. (3) With several staff memberships in one institution, the scope is their union. (4) An owner/admin membership that somehow carries a unit scope is institution-wide (Section 5.1); previously staff actions would have narrowed it — no product flow creates one.
**Limitations / not done:** scoped staff invitations (no UI or API sets a membership's unit scope yet); assessment *assignment* (a write) is not yet scoped; verification-queue items from students without a roster profile are visible only to institution-wide staff.
**Risks / follow-ups:** Android has no roster screen; its assessment-results read is scoped server-side (no client change needed).
**Next goal:** INST-01 (student invitation and activation).

## INST-01 — Student invitation and activation — 2026-09-25
**Result:** Complete — rostered students (added singly or by import) are invited off the request path and can activate into their rostered record; colleges see and manage activation.
**Branch / PR:** feat/inst-student-activation → feat/plan-phases-0-to-2 (no PR: `gh` not installed; merged under the program's merge policy after full validation).
**Files created:** docs/architecture/student-invitations-table-design.md; packages/persistence/drizzle/0037_student_invitations.sql; packages/persistence/src/student-invitations.ts; packages/persistence/src/invitation-mail.ts (moved from the onboarding controller so the worker can send); apps/api/src/http/institution-roster-activation.integration.spec.ts; apps/web/src/rolePortal/studentActivation.test.tsx.
**Files modified:** operations-institution-onboarding.controller.ts (invite on create and import commit; roster returns activation and a summary; resend endpoint; revoke on relationship end; mail code imported); persistence identity-authentication.ts (student branch in the accept transaction), automation-workers.ts and run-automation-worker.ts (delivery consumer in the ADR-028 local dispatcher), schema.ts; events index.ts (event schema); web api/institution.ts, rolePortal/institution.tsx (activation column, per-row and bulk resend with reason), staffDashboardsV3.tsx (Student Activation card); Android Api.kt and StaffDashboards.kt (activation card on the institution home); persistence/package.json and pnpm-lock.yaml (identity dependency).
**Migrations added:** 0037_student_invitations.sql (claimed in the program's migration register).
**Design docs / ADRs:** student-invitations-table-design.md — extends `invitations` with a STUDENT kind (rejected: a separate table with a second accept path; rejected: linking at first sign-in by email). 0037 redefines `enforce_invitation_scope()` with a stricter student branch in front; staff logic unchanged.
**Validation:** fresh local database, only DATABASE_URL exported — typecheck pass · test pass, 1 157 passed / 0 failed (api 380 incl. 13 new, web 372 incl. 5 new, persistence 163, authorization 60, others) · build pass · Android `:app:compileDebugKotlin` pass (Android Studio JBR; the app has no unit-test source set).
**Acceptance criteria:**
- A rostered student receives an invitation, activates, and lands in the student workspace with the institution relationship intact ✔ (single create and import; `/students/me` 200; profile ACTIVE; relationship ACTIVE; visible to staff actions).
- Reused, expired or mismatched-email tokens fail with a safe message ✔ (generic FORBIDDEN, no email or reason disclosed).
- Bulk import of 200 students queues 200 emails exactly once ✔ (and replaying every published event sends nothing more).
- Activation counts on the Dashboard match the Students list ✔ (one server-computed summary over the same rows; tested).
**Decisions for Divakar:** (1) 10.2 #1 adopted (emailed invitation; link only when the verified email matches). (2) Token minted at send time; resend rotates the link. (3) No production sender (HG-7): invitations are created and shown as "Email not sent: no sender is set up yet" and can be resent once a sender exists — which domain/sender should deliver them is the open question.
**Limitations / not done:** acceptance needs the student pool's access tokens to carry `email` and `email_verified` (as staff acceptance already does) — Cognito configuration, not changed (HG-1); a provider bounce webhook awaits a production sender; a student whose email already has a ONE account is still refused at roster creation (needs its own consent step).
**Risks / follow-ups:** the Android institution home shows the counts; resending stays on the web Students page.
**Next goal:** INST-03 (teaching assignments; recommended to include scoped staff invitations).

## INST-03 — Faculty teaching assignments and "My Students" — 2026-09-25
**Result:** Complete — faculty scope now comes from teaching assignments through the INST-02 scope helper, "My Students" is a real screen, and admins can set a staff member's department/batch scope on invitation and afterwards.
**Branch / PR:** feat/inst-teaching-assignments → feat/plan-phases-0-to-2 (pushed for the coordinator to review and merge; `gh` not installed, so no PR opened).
**Files created:** docs/architecture/faculty-teaching-assignments-table-design.md; packages/persistence/drizzle/0040_faculty_teaching_assignments.sql; apps/api/src/http/institution-teaching-assignments.controller.ts; apps/api/src/http/institution-staff-scope.ts; apps/api/src/http/institution-teaching-assignments.integration.spec.ts; apps/web/src/rolePortal/institutionTeaching.tsx; apps/web/src/rolePortal/institutionTeaching.test.tsx.
**Files modified:** packages/authorization/src/institution-scope.ts (+ .test.ts) — the helper gains `teachingUnitIds`, `institutionScopeAnchors`, `isUnitWithin`; packages/persistence/src/institution-scope.ts — `withTeachingAssignments` and the single "active assignment" predicate, applied inside `resolveInstitutionStudentScope`; apps/api institution-student-scope.ts, staff-actions.controller.ts, career-readiness.controller.ts (pass the membership id so the helper can load assignments); operations-institution-onboarding.controller.ts (optional scope on staff invitations; scope in the staff list — small, localized edits); api-security.module.ts (controller registered); web api/institution.ts, rolePortal/institution.tsx (Staff screen: scope on invite, scope column and editor, teaching assignments panel), rolePortalPages.tsx (only the faculty "My Students" and department-head "Faculty and Staff" branches); Android Api.kt and StaffDashboards.kt.
**Migrations added:** 0040_faculty_teaching_assignments.sql (the number assigned to this goal); replayed twice on a fresh database.
**Design docs / ADRs:** faculty-teaching-assignments-table-design.md (assignment hangs off the membership; switch per institution — rejected: per lecturer, which leaves unassigned lecturers institution-wide; rejected: switch everyone now, which empties every faculty workspace and breaks INST-02's tests). No ADR needed.
**API:** `GET/POST /institutions/:id/teaching-assignments`, `POST …/teaching-assignments/:assignmentId/end` (reason-coded, audited, keyset-paginated, limit 1–200), `GET …/my-students` (faculty only; current relationships only; activation, submitted assessments in the last 30 days, open assigned tasks; keyset-paginated), `POST …/staff-memberships/:membershipId/scope` (admins; reason-coded; audit carries before/after), and optional `departmentUnitId`/`batchUnitId` on `POST …/staff-role-assignments`.
**Validation:** fresh local database `one_inst03`, only DATABASE_URL exported — `corepack pnpm db:migrate` ×2 pass · `corepack pnpm typecheck` pass · `corepack pnpm -r --no-bail --workspace-concurrency=1 test` pass, 1 353 passed / 0 failed (api 469 incl. 35 new, web 414 incl. 10 new, authorization 101 incl. 8 new, persistence 187, others) · `corepack pnpm build` pass · Android `:app:compileDebugKotlin` pass (Android Studio JBR).
**Acceptance criteria:**
- A faculty member sees exactly the students in their active assignments ✔ — section, batch (covers its sections), union of several; roster list/detail, staff actions, verification queue and My Students all agree; admin view unchanged.
- Ending an assignment removes access on the next request ✔ — list, detail (403) and My Students; assignments not yet started or past their end date grant nothing.
- Department heads can assign only within their department ✔ — outside their department 403; a head with no department scope cannot assign; ending follows the same rule.
- Scoped staff invitations and membership scope edits ✔ — units of other institutions, a batch in the department slot and a batch outside the department are refused (400) and write nothing.
- Every INST-02 test passes unchanged ✔.
**Decisions for Divakar:** (1) 10.2 #3 adopted: assignments at section or batch level, per subject (ONE subject or a free code) and term (free text until INST-05). (2) Faculty switch to assignment scope **per institution**, once it records its first assignment; before that the INST-02 fallback stays. (3) Department heads may assign any lecturer of the college, only to their own department's sections/batches. (4) **Should unscoped staff now fail closed?** Recommended: yes for department heads — a head without a department should see nobody (the Staff screen shows "Whole institution" today, so an admin can see who needs a department) — after a one-off review of existing memberships; placement admins stay institution-wide by default as Section 5.1 says; faculty already fail closed once their college assigns. Not changed here.
**Limitations / not done:** faculty "Student Detail" still shows the faculty-notes list (now scoped by assignments) rather than a profile view; a pending invitation re-sent with a different scope keeps its original scope; no outbox events for assignment changes (none consume them yet); assignments cannot be edited, only ended and re-created.
**Risks / follow-ups:** the switch is per institution, so the first assignment a college records narrows every lecturer at once — worth a line in the admin onboarding guide. Android: faculty see "My students" on the institution home (asked of the server, since the Android institution workspace merges roles; a 403 hides it); assigning stays on the web Staff / Faculty and Staff screens.
**Next goal:** INST-04 (academic verification screen and bulk marks upload).
