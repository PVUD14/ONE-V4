# Cohort Readiness by Career Role and Preparation Sprints — Design

**Status:** Adopted (INST-17), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-30
**Migration:** `0085_preparation_sprints.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`. A sprint decides what a group of
students is told to do next and records who told them; the cohort view publishes counts about students. Both
carry consequences, so the reasoning is written down first.
**Builds on:** `career-catalogue-table-design.md` (OPS-08: roles and their live requirement sets),
`faculty-learning-actions-table-design.md` (INST-16: assignments are planner constraints, never writes),
`faculty-cohort-view-design.md` (INST-15), ADR-020 (readiness is a band), Appendix 3 §5.1–5.4, the INST-02 scope
helper, the INST-SR-01 period rule and `aggregate-suppression.ts`, ADR-035 (migrations apply once).

## Why this exists

The master plan's placement-office journey (UAT J11): the placement officer picks a role an employer is hiring for
— "SOC Analyst L1" — sees where the cohort stands against that role's essential requirements, and runs a
two-week preparation sprint for the students who have gaps. Until now the college could see only the overall
readiness band distribution; nothing related the cohort to a role, and nothing let the placement office act.

## Part 1 — the cohort view (no table)

### What is measured, and by which code

For one career role and the reader's scoped cohort, each **ESSENTIAL** requirement of the role's **live**
requirement set (`career_role_requirements`, the only set the gap engine reads) gets one row. For every student
in the cohort the requirement's status is computed by exactly the code that computes the student's own gap:
`projectTopicMastery` over their `evidence_records`, then `computeCareerGap` against the requirement. One
definition, so the college's figure and the student's own gap page can never disagree for the same evidence.

Each student lands in exactly one of five cells per requirement — a partition, so the one suppression rule
applies:

| Cell | Meaning (as the screen says it) |
| --- | --- |
| `MET` | Met — the evidence reaches what the role asks for |
| `PARTIAL` | Partly there |
| `MISSING` | Not yet — evidence shows it is well short |
| `NOT_ENOUGH_EVIDENCE` | Too little evidence to say (one record) |
| `NO_EVIDENCE` | No evidence yet |

"Gaps" is `PARTIAL + MISSING` and "unknowns" is `NOT_ENOUGH_EVIDENCE + NO_EVIDENCE`, each published only
through `publishedSubtotal` (so neither can reveal a withheld cell). These are bands of a requirement, never a
number: the mastery ratio and the requirement's `target_mastery` never leave the server, and there is no
per-student row, no percentage, no average.

IMPORTANT and HELPFUL requirements are counted (so the screen can say "3 more requirements are not essential")
but not broken down: the goal asks for essentials, and every extra table is another table to difference.

*Rejected: reading `mastery_projections`.* The stored projection keeps only the band, and a requirement is a
depth; the student gap already recomputes from evidence for exactly this reason (`career-targets.ts`).
*Rejected: reading the adaptive engine (`learner_skill_state`).* That is the student's attempt-history profile,
gated by the `adaptive-learning` consent (fails closed until HG-6). Evidence records are the readiness pipeline
the college's readiness report already aggregates without a purpose consent. **No adaptive data is read by this
goal**, so there is nothing to gate; if a later change adds it, it must be gated the INST-15 way.

### Fixed period (no differencing)

The view covers **one whole calendar month that has ended** (INST-SR-01; default the latest, or any earlier month
by `?month=YYYY-MM`): evidence with `occurred_at` before the first day of the next month, and the population as
it stood at the end of that month — the readiness report's relationship rule (VERIFIED/ACTIVE in force at the
month end, or TRANSFERRED/GRADUATED with that period inside `effective_from … effective_to`), inside the reader's
current unit scope. An ended month never changes, so re-reading it tells nothing new, and two readers can never
pick overlapping windows.

### One table per requirement, one shared cohort total

Every requirement table partitions **the same cohort**, so the cohort total is one number shared by all of
them. `suppressAggregateTable` withholds a table's total when its withheld cells sum to 1–4; if another table
published the same total, subtraction would give the withheld cells back. So the cohort total is published only
when **every** requirement table would publish it, and is withheld from all of them otherwise. A cohort under 5
withholds everything.

### Which roles can be chosen

- **Catalogue roles**: every active `career_roles` row with at least one ESSENTIAL live requirement (roles with
  none are listed as "no requirement set published — NA", never hidden and never measured).
- **An employer's role**: every live campus drive at this college (APPROVED or SCHEDULED) whose job's current
  version maps to a catalogue role (`opportunity_versions.career_role_id`, EMP-13). The drive is a shortcut to
  its role and can be recorded on a sprint; nothing about the college's cohort reaches the employer.

## Part 2 — preparation sprints (`preparation_sprints`, 0085)

### A sprint is an INST-16 assignment with a time box

A sprint is **one INST-16 assignment** (`learning_assignments` + `learning_assignment_students`) of a published
practice set or lesson on the requirement's skill, to the students who have a gap, plus one header row that
records the role, the requirement, the time box and why. The planner already honours assignments
(`FOLLOW_ASSIGNMENT`, after due reviews and before the career gap), the student already sees them, "done" is
already derived from their own records, privacy deletion already removes the per-student rows. Nothing about
mastery, evidence or readiness is written.

*Rejected: a parallel sprint-assignment table.* The goal names the INST-16 mechanism, and two assignment
systems would need two planner loaders and two "done" rules that drift.
*Rejected: a column on `learning_assignments`.* The sprint needs the role, the requirement, the drive, its own
reason vocabulary and its own end; the assignment row stays exactly INST-16's act. (Adding columns to a table
another goal owns is possible in 0085, but it would also have to widen 0082's guard function.)

### The time box

`ends_at` is 7–42 days after `starts_at` (one to six weeks; J11's sprint is two weeks). At `ends_at` the
assignment stops being a planner constraint and leaves the student's open work — **derived** in the loader
(`loadFacultyConstraints`) and the student's read, like "done", never by a job that could fail to run. A sprint
can be **ended early** (`cancelled_*`), which also withdraws its assignment in the same transaction with the
same reason code.

*Rejected: a scheduled job that withdraws assignments at the end.* A missed run would leave students working to
an expired sprint; a derived rule cannot be missed.

### Who is reached

At the moment of creating (current evidence, not the month end — a sprint is about now):

- current students (ACTIVE/VERIFIED relationship in force, ACTIVE profile and user) inside the creator's
  INST-02 **write** scope, optionally narrowed to one unit (a department, programme, batch or section) of the
  college;
- whose status on the chosen essential requirement is `PARTIAL` or `MISSING`, and — when the creator ticks
  "include students with no or too little evidence" — `NOT_ENOUGH_EVIDENCE` or `NO_EVIDENCE` too;
- at most 500 (INST-16's cap); a larger group is refused with `SPRINT_TOO_LARGE` so the creator narrows it by
  unit. None at all is `NO_STUDENTS_WITH_GAPS`.

**Staff never see who was reached.** The response and every later read give only counts of people (suppressed
under 5). The students are recorded in `learning_assignment_students` (needed by the planner) and in the audit
row, never shown. *Why:* a list of "students with gaps in SOC skills" is exactly the individual readiness
judgement ADR-020 keeps away from ranking, and the placement office does not need names to run a sprint.
**Listed for Divakar.**

### Progress over the sprint (reconciles with engine evidence)

For the students a sprint reached who are still current students inside the **reader's** read scope, at a fixed
cut-off — the start of the current UTC day while the sprint runs, `ends_at` once it has ended:

| Cell | Rule |
| --- | --- |
| `MET` | the requirement's status is `MET` on evidence before the cut-off |
| `NEW_EVIDENCE` | not met, but at least one evidence record on the requirement's skill in `[starts_at, cut-off)` |
| `NO_NEW_EVIDENCE` | neither |

— one partition through `suppressAggregateTable`. Separately, **work done**: how many finished the assigned
practice or lesson before the cut-off (INST-16's done rule, bounded by the cut-off), through
`suppressSmallCount`. Every figure is recomputed from `evidence_records` and the students' own records by the same
functions as Part 1; nothing is stored, so the progress always reconciles with the engine's evidence (tested
against a direct recomputation). A fixed daily cut-off means repeated reads within a day are identical.

A requirement removed from the role's live set since the sprint started makes the requirement status NA (the
cells withheld with a plain note); work done is still shown.

## Who may do what

| Action | Roles |
| --- | --- |
| Read roles, the cohort view, sprints and their progress | INSTITUTION_OWNER, INSTITUTION_ADMIN, PLACEMENT_ADMIN, DEPARTMENT_HEAD — within their INST-02 read scope |
| Create a sprint | the same roles, within their INST-02 **write** scope (an unscoped head: `SCOPE_REQUIRED`) |
| End a sprint early | its creator, or an owner or admin |
| Anything | FACULTY_LECTURER: 403 (INST-15/16 serve lecturers); employers and students: no route |

Every write writes an `audit_events` row in the same transaction (`preparation_sprint.created` with the student
ids, `preparation_sprint.cancelled`); the cohort read and the sprint list are audited
(`institution.cohort_readiness.read`, `institution.preparation_sprints.read`). Students are notified in the app
(`SYSTEM`, best-effort after commit, never undoing the sprint). No outbox event, no new notification kind.

## What the student sees (no navigation change, HG-3)

The sprint's assignment appears in the existing card on Learning (web) and the Learning tab (Android) as
"Preparation sprint from <college> · until <date>", and the card is headed "From your college" when a sprint is
among its items. The student is never told they were chosen for a gap in a named role — only what to practise and
by when.

## The table

`preparation_sprints`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `institution_id` | uuid NOT NULL → `organizations` |
| `assignment_id` | uuid NOT NULL UNIQUE → `learning_assignments`; same college, target `STUDENTS`, open at insert, `skill_id = topic_id`, `assigned_at = starts_at` |
| `career_role_id` | uuid NOT NULL → `career_roles` |
| `topic_id` | uuid NOT NULL → `taxonomy_nodes` — the essential requirement's skill |
| `campus_drive_id` | uuid NULL; FK `(campus_drive_id, institution_id)` → `campus_drives (id, institution_id)` (0073's unique index), so a drive of another college cannot be named |
| `scope_unit_id` | uuid NULL — the unit the creator narrowed to; FK `(scope_unit_id, institution_id)` → `institution_units` |
| `include_unknown` | boolean NOT NULL |
| `created_by_user_id`, `created_by_membership_id` | NOT NULL |
| `reason_code` | `CAMPUS_DRIVE_PREPARATION`, `ESSENTIAL_GAP`, `PLACEMENT_SEASON` |
| `note` | ≤ 500, optional, shown to students |
| `starts_at` | timestamptz NOT NULL DEFAULT now() (database clock; ordered against evidence) |
| `ends_at` | timestamptz NOT NULL, `starts_at + 7 days ≤ ends_at ≤ starts_at + 42 days` |
| `cancelled_at`, `cancelled_by_user_id`, `cancel_reason_code` | all or none; `cancelled_at ≥ starts_at` |

Guard (trigger): the insert checks listed above; an update may only end the sprint early, once, before
`ends_at`, with every other column unchanged; no delete (the row names no student). Index on
`(institution_id, starts_at DESC, id)`.

## Privacy deletion

Nothing new: the reached students live in `learning_assignment_students`, which `LEARNING_ACTIVITY` erasure
already deletes; the sprint header names no student; audit rows are retained (AUDIT).

## Idempotency (ADR-035)

`CREATE TABLE IF NOT EXISTS`; CHECKs and FKs dropped `IF EXISTS` and re-added; `CREATE OR REPLACE FUNCTION`;
`DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`; indexes `IF NOT EXISTS`. References only tables created in files
≤ 0084 (0004, 0011, 0069, 0073, 0082 and the organisation, membership and unit tables).

## Residual risks

- **Margins.** A head's department view and the admin's college view of the same month are linked tables (as
  INST-08 and INST-12 recorded); protection is per table, not a full linear audit. Month-to-month movement is
  visible by design.
- **Sprint reach is "now".** The count reached (suppressed under 5) can be set beside the month-end view. It is a
  count of a group of 5 or more, created by an audited write that notifies every student reached, so probing it
  is neither cheap nor silent.
- **Progress changes daily** while a sprint runs; with no names and cells under 5 withheld, a change says only
  that someone in a group of five or more progressed.

## Open points (decisions for Divakar)

1. **Staff never see who a sprint reached** — counts only (recommended). The alternative, a named list, would
   make "students with gaps for role X" a staff-visible per-student judgement.
2. **Essential requirements only** in the breakdown (recommended; the goal's wording).
3. **Unknowns are opt-in for a sprint** (recommended): a student with no evidence has not shown a gap, and a
   sprint is a visible ask of them.
4. **Placement officers, admins and department heads may run sprints**; lecturers keep INST-16.
5. **One requirement per sprint** (recommended): progress is then one clean partition; a role-wide sprint is
   several sprints.
6. **No reminders and no extension**: a sprint ends at its end; the office starts another.
