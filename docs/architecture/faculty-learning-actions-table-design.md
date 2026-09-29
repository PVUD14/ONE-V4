# Faculty Learning Actions (practice sets, group sessions, plan overrides) — Table Design

**Status:** Adopted (INST-16), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0082_faculty_learning_actions.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`. These tables decide what a
student is told to do next and record who told them, so the reasoning is written down first.
**Builds on:** `learning-decisions-table-design.md` (ENG-08: the planner already carries faculty constraints —
"INST-16 only needs to add a loader"), `learning-step-items-table-design.md` (ENG-18: steps, practice, the
Learning page), `faculty-cohort-view-design.md` (INST-15: the actions it links to), `faculty-teaching-assignments-table-design.md`
(INST-03), `engine-consent-purposes-design.md` (ENG-01), Appendix 3 §5.1–5.4 and decision 10.2 #11, ADR-020,
ADR-034, ADR-035 (migrations apply once)

## Why this exists

A lecturer who sees that six of their students are stuck on subnetting (INST-15) needs to do something about it
inside ONE: give the class a practice set, run a group session on it, or change one student's next step. Until now
the cohort view could only point at the free-form Assigned Tasks and Interventions lists, which the engine cannot
read. The planner (ENG-08) was built with a slot for exactly these constraints — `constraints.assignments` and
`constraints.override` — and a loader that passes none. This goal gives those constraints a source.

The one rule that shapes everything: **a faculty action is a constraint the planner honours, never a write to
mastery, evidence or readiness.** A lecturer can say "do this next"; only the student's own work changes what the
engine knows about them.

## What a lecturer can assign: approved ONE content only

"Learning Resources" (the faculty item that already exists, OPS-10 put the content review queue there) lists the
content a lecturer may assign. Two kinds exist in ONE today, and both are tied to a skill, which is what the
planner acts on:

| Kind | What it is | Published means | Skill |
| --- | --- | --- | --- |
| `PRACTICE` | The practice set on a skill: the published, current, answer-keyed questions ENG-18's step runner serves | at least one `question_versions` row on the skill with an answer key, `superseded_at IS NULL`, in a `PUBLISHED` release | the question's `topic_id` |
| `LESSON` | A lesson a student completes | a `lesson_versions` row with `superseded_at IS NULL` whose module is in a `PUBLISHED` release | the lesson's `topic_id` |

*Rejected:* `learner_content_items` of type `PRACTICE` (0024). Those are generic guides ("Problem-solving practice
guide") with no skill; the planner cannot act on them and a student cannot practise them in the step runner.
*Rejected:* letting faculty assign their own questions. Faculty-authored content goes through the existing review
(ADR-037, OPS-10); only what that review has published is assignable.

Publication is checked twice: when the action is recorded (a database guard refuses unpublished content, so no
code path can skip it), and every time the planner loads the constraint (content withdrawn later simply stops
being a constraint; the step runner never serves unpublished questions anyway).

## The three actions

### 1. Assign a practice set or lesson — `learning_assignments` + `learning_assignment_students`

A lecturer assigns one resource to **a class** (a section or batch of their active teaching assignments) or to
**selected students** of those classes. The header records the action; one row per student records who it reached,
expanded at the moment of assigning (a student who joins the section later is not silently assigned).

The planner receives each student's **open** assignments as `constraints.assignments` (`assignmentId`, `skillId`,
`assignedAt`), oldest first, capped at 20. Planner v1 already ranks them: after due reviews, before the career gap
(`FOLLOW_ASSIGNMENT`, reason `FACULTY_ASSIGNMENT`). An assignment is **open** while all of these hold:

- it is not withdrawn;
- the student still has a current relationship (ACTIVE/VERIFIED, in force) with the assigning college;
- its content is still published;
- it is not **done**:
  - `PRACTICE`: after it was assigned, the student finished a learning step on that skill (the step's session is
    closed — ENG-18 closes it when the step's questions are answered — and at least one answer was recorded);
  - `LESSON`: the student has completed that lesson (any version of it, `learner_progress` COMPLETED — the existing
    lesson completion, which is the student's own act).

"Done" is **derived, never stored**. *Why:* the facts it depends on (a closed step session, a completed lesson) are
already append-only records of the student's own work; a stored flag would be a second truth that some code path
would forget to set. It also means the planner's inputs are fully reproducible from the decision audit: the inputs
stored on each `learning_decisions` row are exactly the open assignments at that moment.

*Rejected:* a due date that ends the constraint. Nothing in ONE should silently drop work a lecturer set; the
lecturer withdraws it. *Rejected:* a row per section instead of per student — the planner reads per student, a
student moving section must not change what they were assigned, and privacy deletion must remove a person's rows.

### 2. Group session — a `MEETING` staff action with attendees and linked content

A group session **is** a staff action of type `MEETING` (0020): title, start, end, author, the existing state
machine, and it appears on the lecturer's existing Calendar and the head's Meetings list with no change to those
screens. Two small tables add what a meeting lacked:

- `staff_action_attendees` — the students invited (the class or selected students, expanded when created, like
  assignments);
- `staff_action_content_links` — 1 to 5 published resources the session covers.

The session is created as `STAFF_ONLY` like every staff-created meeting, so the staff note never reaches a student.
An attendee sees only the session's title, time, the college's name and the linked content, on their Learning
page, while the meeting is not `CANCELLED`, `REJECTED` or `ARCHIVED` and has not ended more than a day ago.
A session is not a planner constraint (it happens in a room, not in the step runner) and writes nothing about
attendance: ONE is not a college ERP (Appendix 3 §0.5).

*Rejected:* a new session table beside `staff_actions`. The goal says a group session is a MEETING staff action,
and a second table would split the lecturer's calendar in two.

### 3. Plan override for one student — `learning_plan_overrides`

A lecturer sets one student's **next step**: an action (`LEARN`, `PRACTICE` or `REVIEW`) on a published resource,
with a **reason code from a closed list** (decision 10.2 #11) and an optional note. The student is notified in the
app.

Lifecycle: `PENDING` → `APPLIED` (the next time the student plans a step) or `WITHDRAWN`.

- While `PENDING`, the loader passes it as `constraints.override` (`overrideId`, `byUserId`, `reasonCode`,
  `action`, `skillId`, `focusMisconceptionCode: null`). Planner v1's first rule applies it: the decision is the
  override's action and skill, with reason `FACULTY_OVERRIDE`, and `override_by_user_id` /
  `override_reason_code` set on the `learning_decisions` row.
- In the same transaction that records that decision, the override becomes `APPLIED` with `applied_decision_id`.
  A database guard checks that the decision belongs to the same student and that its stored inputs carry this
  override's id — so the link between the faculty act and the engine's decision audit cannot be forged.
- **Replay (acceptance):** the decision row stores the override in its normalised inputs, and
  `replayLearningDecision` recomputes the same decision from them (tested). Every override that affected a student
  is therefore replayable from `learning_decisions`; one that never took effect decided nothing.
- One pending override per student (partial unique index). A second is refused with `OVERRIDE_PENDING`; any
  lecturer whose write scope covers the student may withdraw the pending one, with a reason code.

*Why "next step, once" rather than "until withdrawn":* the planner re-plans after every step from new facts; an
override that pinned a student to one skill indefinitely would stop the plan responding to their work, and would
need a second person to remember to lift it. *Rejected:* planning the step at the moment the lecturer overrides.
The student may be half-way through a step; planning a new one would supersede it under them (ENG-18 refuses
answers to a superseded step). The override waits until the student asks for their next step, and their Learning
page tells them it is waiting.

*Why no `REMEDIATE`:* remediation names a misconception the student holds. Lecturers see misconceptions only as
suppressed class counts (INST-15), never per student, so they cannot choose one; the planner remediates on its own.

**Reason codes** (closed vocabulary, stored, shown to the student in plain words):
`CLASS_TOPIC_ALIGNMENT` (matches what the class is working on), `PREREQUISITE_FIRST`, `REVISIT_FUNDAMENTALS`,
`UPCOMING_ASSESSMENT`, `STUDENT_REQUEST`, `FACULTY_JUDGEMENT`. Withdrawal codes: `NO_LONGER_NEEDED`,
`SET_IN_ERROR`, `REPLACED`.

## Who may act, on whom

- **Faculty only** (`FACULTY_LECTURER`). Heads and admins get 403: the goal is the lecturer's journey (master plan
  J10); a head-level version can reuse the endpoints with the head's write scope later.
- **Only students in the lecturer's active teaching assignments**: the INST-02 helper's **write** scope
  (`resolveInstitutionStudentWriteScope` — assignments only, no department/batch or whole-college fallback). No
  write scope at all is `SCOPE_REQUIRED`. A class target must be one of the lecturer's active teaching units; a
  selected student outside the scope is refused (the whole request, not silently skipped, so the lecturer knows).
- **Current students only** (ACTIVE/VERIFIED relationship in force), with an ACTIVE profile and user.
- At most 500 students per action.

## What the lecturer sees

- Learning Resources: the published catalogue (searchable, keyset-paginated), forms to assign, plan a session and
  override a next step, and their own recent actions.
- Per assignment: students reached, and per student `Done` / `Not yet` — the status of work the lecturer set,
  like an assigned task. No score, no right/wrong, no attempt count. In the list, the number done is a count of
  people and is shown as `<5` below five (`suppressSmallCount`).
- Before overriding: the student's **current next step** (action, skill, reasons in plain words) — **only if the
  student holds the adaptive-learning consent** (checked on the request; fails closed, so until HG-6 publishes the
  definition nobody's plan is shown and the panel says why). The read is audited
  (`institution.learning_plan.read`). A decision is a product of the student's learning data; showing it to staff
  without the consent would be exactly the disclosure the consent governs.
- No model number anywhere: no mastery likelihood, FSRS value, due date or readiness.

## What the student sees (web Learning page, Android Learning tab — no navigation change, HG-3)

A "From your lecturer" card: open and done assignments (resource, skill, the college, when), upcoming group
sessions (title, time, linked content) and a pending override ("Your lecturer set your next step: Practise
Subnetting — Matches what your class is working on now. It starts when you plan your next step."). The lecturer is
named by role and college ("Your lecturer at <college>"): ONE stores no staff display names (INST-14's rule).
Assigned practice is done in the existing step runner; the planner brings it up as the next step.

## Audit and notification

Every write puts an `audit_events` row in the same transaction: `learning_assignment.created` /
`.withdrawn`, `group_session.created`, `learning_plan_override.created` / `.withdrawn` (with reason codes and the
student ids), and applying an override is recorded by the decision row itself. Students are notified in the app
(`SYSTEM`, best-effort after commit, never undoing the action): overrides always (decision 10.2 #11), assignments
and sessions too. No outbox event and no new notification kind.

## The tables

### `learning_assignments` (the lecturer's act)

| Column | Notes |
| --- | --- |
| `id` | uuid PK — the planner's `assignmentId` |
| `institution_id` | uuid NOT NULL → `organizations` |
| `assigned_by_user_id`, `assigned_by_membership_id` | NOT NULL → `users`, `organization_memberships` |
| `content_kind` | `PRACTICE` or `LESSON` |
| `skill_id` | uuid NOT NULL → `taxonomy_nodes` |
| `lesson_version_id` | uuid → `lesson_versions`; set exactly for `LESSON`, and its `topic_id` must be `skill_id` |
| `target_kind`, `target_unit_id` | `UNIT` (with the unit, FK to the college's `institution_units`) or `STUDENTS` |
| `note` | ≤ 500 characters, optional, shown to the students |
| `assigned_at` | DEFAULT now() (database clock: ordered against decisions and sessions) |
| `withdrawn_at`, `withdrawn_by_user_id`, `withdraw_reason_code` | all or none |

Guard: insert only published content (below); update only to withdraw, once; no delete (the header names no
student).

### `learning_assignment_students`

`(assignment_id, student_user_id)` PK, `institution_id` (must equal the header's), `created_at`. Insert only while
the header is not withdrawn; never updated; deleted only inside privacy deletion for that student.

### `learning_plan_overrides`

| Column | Notes |
| --- | --- |
| `id` | uuid PK — the planner's `overrideId` |
| `institution_id`, `student_user_id`, `created_by_user_id`, `created_by_membership_id` | NOT NULL |
| `action` | `LEARN`, `PRACTICE`, `REVIEW` |
| `content_kind`, `skill_id`, `lesson_version_id` | as assignments |
| `reason_code` | `^[A-Z0-9_:-]{3,64}$` (the vocabulary is enforced by the API) |
| `note` | ≤ 500, optional |
| `created_at` | DEFAULT now() |
| `state` | `PENDING`, `APPLIED`, `WITHDRAWN` |
| `applied_decision_id`, `applied_at` | → `learning_decisions`; set exactly when APPLIED |
| `withdrawn_at`, `withdrawn_by_user_id`, `withdraw_reason_code` | set exactly when WITHDRAWN |

Unique: one `PENDING` per student. Guard: rows start `PENDING`; only `PENDING → APPLIED` (decision of the same
student whose inputs name this override) or `PENDING → WITHDRAWN`, with every other column unchanged; delete only
inside privacy deletion.

### `staff_action_attendees`, `staff_action_content_links`

Attendees: `(staff_action_id, student_user_id)` PK, `institution_id` (must equal the action's, which must be a
`MEETING`), `added_at`; delete only inside privacy deletion. Content links: `(staff_action_id, position 1–5)` PK,
`content_kind`, `skill_id`, `lesson_version_id`, published at insert, immutable.

A SQL function `learning_content_published(kind, skill, lesson)` is the one definition of "published and current"
used by every insert guard.

## Consent (ENG-01)

- The faculty actions themselves need no purpose from the student: assigning work is not profiling, and the
  planner honours faculty constraints on its non-adaptive path too (ENG-08).
- Any view of a student's plan for staff requires the student's adaptive-learning consent, checked in the same
  request, failing closed (above). The per-student "Done / Not yet" of assigned work is the status of work the
  lecturer set, not a learning profile, and is shown regardless — **listed for Divakar**.

## Readiness, evidence, models

No faculty action writes `learner_skill_state`, `learning_attempt_events`, `evidence_records`,
`mastery_projections`, `readiness_snapshots` or `readiness_factors` (tested: the tables are unchanged after every
action). No number about a student leaves the server. No model is called.

## Privacy deletion

`LEARNING_ACTIVITY` (ADR-034, ERASED) deletes the subject's `learning_plan_overrides` (before the decisions they
point at), `learning_assignment_students` and `staff_action_attendees`, inside the transaction-local erase
setting. The headers, sessions and links name no student and stay; the audit rows stay (AUDIT is retained).

## Idempotency (ADR-035)

`CREATE TABLE IF NOT EXISTS`; indexes `IF NOT EXISTS`; CHECKs dropped `IF EXISTS` and re-added;
`CREATE OR REPLACE FUNCTION`; `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`. References only tables created
before it (0004, 0020, 0053, 0061, 0065 and the organisation, membership and unit tables).

## Open points (decisions for Divakar)

1. **An override decides the next step once**, then the planner resumes (recommended), rather than holding until
   withdrawn.
2. **Assignment completion is derived** from the student's own records (a finished step on the skill; a completed
   lesson) and never expires; lecturers withdraw (recommended).
3. **"Done / Not yet" is shown to the lecturer without the adaptive-learning consent**, as assigned-work status
   (recommended); the student's plan itself is shown only with it.
4. **Faculty only**; heads and admins get 403 for now.
5. **No `REMEDIATE` override**: lecturers cannot see per-student misconceptions.
6. **Writes are web-only**; the phone shows the lecturer's recent actions read-only, and students see everything on
   the Learning tab.
