# Faculty Teaching Assignments — Table Design

**Status:** Adopted (INST-03), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0040_faculty_teaching_assignments.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

ONE does not know whom a faculty member teaches (INST-00, defect I-3). Since INST-02 every
institution read that returns student-level data is filtered by one scope definition
(`packages/authorization/src/institution-scope.ts`), but for faculty that definition can only use
the department and batch written on their membership — and no screen or API could set those, so in
practice every faculty membership is unscoped and therefore **institution-wide**. A lecturer who
teaches one section of one batch can read every student in the college. "My Students" has nothing
to show because there is nothing that says who "my" students are.

Appendix 3 Section 5.1 settles the rule: a faculty member sees *the students in the sections or
batches of their teaching assignments*. Decision 10.2 #3 settles the grain: *teaching assignments at
section or batch level, per subject and term*. This table is that record. It decides who can read a
student's record, so it is a table with consequences and is designed here first.

## The table: `faculty_teaching_assignments`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `institution_id` | uuid NOT NULL → `organizations(id)`. The tenant; every other reference is checked against it. |
| `faculty_membership_id` | uuid NOT NULL → `organization_memberships(id)`. The **membership**, not the user: scope is a property of a role held in an institution, and the scope helper already works per membership. A trigger requires a `FACULTY_LECTURER` membership of the same institution. |
| `unit_id` | uuid NOT NULL, FK `(unit_id, institution_id)` → `institution_units(id, institution_id)` so a unit of another college can never be named. A trigger requires kind `SECTION` or `BATCH` (decision 10.2 #3). A batch covers its sections, because the scope helper covers every unit below an anchor. |
| `subject_id` | uuid NULL, FK `(subject_id, institution_id)` → `exam_subjects(id, institution_id)`. The college's subject, where it has recorded one. |
| `subject_code` | text NULL, 1–32 characters, not starting with `= + @ -` (formula-injection safe, as `exam_subjects.code`). For colleges that have not built their subject list in ONE. |
| `academic_term` | text NOT NULL, 1–40 characters, e.g. `2026-27 Odd semester`. Free text until INST-05 adds `institution_academic_terms`; a later migration adds a nullable `academic_term_id` beside it rather than rewriting this column. |
| `starts_on` | date NOT NULL DEFAULT `current_date`. |
| `ends_on` | date NULL; `ends_on >= starts_on`. A planned end — the assignment stops granting access after this day without anyone acting. |
| `state` | text NOT NULL DEFAULT `'ACTIVE'`, CHECK in (`ACTIVE`, `ENDED`). |
| `assigned_by_user_id` | uuid NOT NULL → `users(id)`. |
| `reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$` — why it was created (for example `NEW_TERM`, `COVER`). |
| `ended_at`, `ended_by_user_id`, `end_reason_code` | NULL together while `ACTIVE`; all set when `ENDED` (CHECK). |
| `created_at`, `updated_at` | timestamptz. |

Constraints: at least one of `subject_id`, `subject_code` (the plan says *per subject*); one
**active** row per (membership, unit, subject, subject code, term), enforced by a partial unique
index, so a double click cannot create two. Indexes on `(institution_id, faculty_membership_id)`
for the scope lookup and `(institution_id, unit_id)` for the department-head view.

The migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`, trigger dropped and re-created) because the migrator replays every file
on every run.

### What "active" means

`state = 'ACTIVE' AND starts_on <= current_date AND (ends_on IS NULL OR ends_on >= current_date)`,
evaluated by the database on every request. Nothing caches it: the authorization context is rebuilt
per request, so **ending an assignment removes access on the next request** (acceptance criterion).
Ending never deletes the row — who taught whom, and when, is the record a later dispute needs.

## How scope changes

The single scope definition is extended, not duplicated. A staff membership passed to
`institutionStudentScope` may now carry `teachingUnitIds`:

- **absent** — the institution has not started recording teaching assignments. Faculty keep the
  INST-02 behaviour (membership department/batch; unscoped means institution-wide). Every existing
  INST-02 test runs in this mode, unchanged.
- **present** — faculty scope is exactly the active assignments' units and everything below them.
  An empty list means **no students**. The membership's own department/batch no longer widens it.

`packages/persistence` fills `teachingUnitIds` for faculty memberships when **the institution has at
least one teaching assignment row, in any state**. Everything that already calls the helper —
roster list and detail, applications, the verification queue and decisions, readiness reports,
assessment results and staff actions — switches with no further change.

**Why per institution, and not per faculty member.** The alternative — switch a faculty member once
*they* have ever had an assignment — leaves every not-yet-assigned lecturer institution-wide in a
college that is otherwise using assignments, which is exactly the over-broad access I-3 describes. Per
institution fails closed as soon as a college starts assigning: an unassigned lecturer sees nobody,
and My Students says so plainly. **Rejected: switch everyone now** (faculty with no assignment see
nobody from the day this ships) — it would empty every current faculty workspace before any college
has had a screen to assign on, and it would break INST-02's accepted tests.

## Who can write

- **Institution owners and admins:** any faculty membership of the institution, any section or batch.
- **Department heads:** only units at or below *their* department (their `DEPARTMENT_HEAD`
  membership's department scope). A department head with no department scope cannot assign — "within
  their department" needs a department, so writes fail closed even though that head's *reads* stay
  institution-wide under the INST-02 default. They may assign any faculty member of the institution
  (cross-department teaching is ordinary), but only to their own department's sections and batches,
  and may end only assignments whose unit is in their department.
- **Faculty:** read their own assignments; never write.

Every create and end writes an `audit_events` row in the same transaction, carrying the reason code.

## Staff unit scope (the INST-02 follow-up in the same goal)

Scope on the membership itself stays: a placement admin narrowed to a campus or department, a
department head's department. INST-02 found nothing could set it. Two writes are added, neither needs a
schema change:

- `POST …/staff-role-assignments` accepts optional `departmentUnitId` and `batchUnitId`. They are
  validated to belong to the institution (and to be a department — or a campus, for a placement
  admin — and a batch below it) and stored on the invitation's existing
  `scope_department_unit_id`/`scope_batch_unit_id`; acceptance already copies them onto the membership.
- `POST …/staff-memberships/:membershipId/scope` (admins only) sets or clears an existing staff
  membership's department and batch, reason-coded and audited with the before and after values.

## Open points (decisions for Divakar)

1. **Should unscoped staff now fail closed?** See the INST-03 report. Recommended: yes for
   department heads (a head without a department sees nobody, with the Staff screen showing
   "No department set"), after a one-off review of existing memberships; placement admins stay
   institution-wide by default as Section 5.1 says.
2. **Academic terms** are free text until INST-05; they then become a reference.
3. **Section-level or batch-level first** (Appendix 3 open question): both are supported from day one.
