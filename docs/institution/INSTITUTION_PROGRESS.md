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
