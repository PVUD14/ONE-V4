# Learning Attempt Events — Table Design

**Status:** Adopted (ENG-03), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0047_learning_attempt_log.sql` (with `learning_sessions`, designed in
`learning-sessions-table-design.md`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (data rules; engine behavioural data is ERASED on deletion), ADR-033,
`engine-consent-purposes-design.md` (ENG-01), `exam-topic-bridge-table-design.md` (0030)

## Why this exists

Every later engine goal — evidence stages (ENG-04), the skill-state projection (ENG-05), BKT (ENG-06),
the planner (ENG-08), FSRS (ENG-09), calibration (ENG-13) — reads the same fact: *this student answered
this version of this item, in this context, right or wrong, with this much help, at this time*. Today
that fact is scattered and lossy:

- The readiness check keeps per-item answers in `assessment_responses`, but only as a selected option
  and a boolean, joined to the item through `assessment_attempt_items`.
- Institution exams keep the student's raw response in `exam_answers`, which is **mutable** (upserted on
  every save) and is never graded per item in the database — only the totals reach `exam_results`.
- `learner_activity_events` (0015) records that something happened, not what, and is written
  best-effort **outside** the transaction of the action it describes, so it can say an attempt happened
  that rolled back, or miss one that committed (ENGINE_BASELINE §4).

`learning_attempt_events` is the one append-only log of graded responses, in one shape for every
source, written **in the same transaction** as the grading it records.

## The table

### `learning_attempt_events`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `subject_user_id` | uuid NOT NULL → `users(id)`. The student. |
| `institution_id` | uuid NULL → `organizations(id)`. The institution the student belonged to when they answered (D.1 data rule). For an institution exam, the exam's institution; for any other source, the student's current `ACTIVE`/`VERIFIED` relationship at write time (the same rule `currentContext` uses); NULL for an independent learner. Fixed at insert — a later transfer does not rewrite history. |
| `session_id` | uuid NOT NULL → `learning_sessions(id)`. Every attempt belongs to a session; for today's two sources the session is the assessment attempt. |
| `item_source` | text NOT NULL, CHECK in (`CAREER_READINESS_QUESTION`, `INSTITUTION_EXAM_QUESTION`). Which item bank `item_id` refers to. New banks (placement items, practice items) add a value in a later migration. |
| `item_id` | uuid NOT NULL. `question_versions.id` or `exam_questions.id`. Deliberately no foreign key: two banks, and a polymorphic FK would need a column per bank; the writers resolve the id from the paper they are grading, never from client input. |
| `item_version` | integer NOT NULL, > 0. `question_versions.version` / `exam_questions.version`, so a later edit of an exam question does not make an old attempt look like an answer to the new text. |
| `skill_id` | uuid NULL → `taxonomy_nodes(id)`. The readiness topic the item is authored against, when it has one. See "Skill of an exam item". |
| `context` | text NOT NULL, CHECK in (`PRACTICE`, `DIAGNOSTIC`, `ASSESSMENT`, `REVIEW`). |
| `answered` | boolean NOT NULL. False for an item left blank on a submitted exam paper. |
| `correct` | boolean NOT NULL. CHECK `answered OR NOT correct`. |
| `score` | numeric(5,4) NOT NULL, CHECK 0 ≤ score ≤ 1. The fraction of the item's credit earned. Both engines grade all-or-nothing today, so 0 or 1; the range leaves room for partial credit without a migration. |
| `response_time_ms` | integer NULL, CHECK ≥ 0. **NULL today**: neither engine measures per-item time (the readiness check submits all answers at once; exam answers carry only a last-saved time). NULL means "not measured", never zero. |
| `highest_hint_level` | smallint NOT NULL DEFAULT 0, CHECK 0–4. No hints exist until ENG-15, so every row today is 0. |
| `assisted` | boolean NOT NULL DEFAULT false. CHECK `highest_hint_level < 3 OR assisted` — C5's rule at the data layer: a success after hint 3 or higher can never be stored as unaided. `assisted` may also be true below hint 3 (ADR-033's recommended tutor rule: any AI tutor reply on the item makes it assisted), so it is a column, not a computed value. |
| `content_version` | text NOT NULL, 1–64 chars. The same content-version string the source writes on its evidence (`assessment-v1`, `institution-exam-v1`), so attempt and evidence rows can be read together. |
| `source_attempt_type` | text NOT NULL, CHECK in (`assessment_attempt`, `exam_attempt`). |
| `source_attempt_id` | uuid NOT NULL. The graded attempt the response belongs to. |
| `occurred_at` | timestamptz NOT NULL. When the response was graded, stamped with the database clock (`now()`), never Node's. |
| `recorded_at` | timestamptz NOT NULL DEFAULT now(). |

Constraints and indexes:

- `UNIQUE (source_attempt_type, source_attempt_id, item_source, item_id)` — **exactly one row per
  graded response**. A replayed write (`ON CONFLICT DO NOTHING`) cannot create a second.
- `(subject_user_id, occurred_at)` for per-student reads and for erasure; `(institution_id, occurred_at)`
  for INST-02-scoped reads; `(skill_id, occurred_at)` for projections and calibration exports.

### Append-only, and erasable only by privacy deletion

A trigger rejects every `UPDATE`, and rejects every `DELETE` unless the transaction has set the
transaction-local setting `one.privacy_erase_subject` to the **same subject's** user id. Only the
privacy-deletion executor (`apps/api/src/http/privacy-deletion.ts`) sets it, with `set_config(…, true)`
inside its own transaction, so the setting ends with the transaction and scopes to one person.

This is a guard against application mistakes, not a security boundary against someone with database
access — the same standing as the `0004` immutability trigger. `TRUNCATE` does not fire row triggers;
test suites that truncate `users … CASCADE` are unaffected, and nothing in the application truncates.

*Rejected:* reusing `reject_immutable_row_change()` (0004). It rejects deletion unconditionally, which
contradicts ADR-034's decision that engine behavioural data is erased on deletion.
*Rejected:* `ON DELETE CASCADE` from `users`. Users are never deleted — they are anonymised — so a
cascade would never run, and it would hide the erase step instead of making it explicit and counted.

## Which responses are recorded

| Source | Where | Rows | Context |
| --- | --- | --- | --- |
| Readiness check submit | `submitAssessmentAttempt` (`packages/persistence/src/career-readiness.ts`), same transaction as responses, evidence and the readiness recompute | one per item on the paper; every item must be answered to submit | `ASSESSMENT` |
| Institution exam submit / auto-submit / stale finalise / focus-loss final | `finalizeAttempt` (`apps/api/src/http/student-assessment-attempts.controller.ts`), same transaction as the result row and the evidence bridge | one per question on the paper, answered or not | `ASSESSMENT` |
| Practice | — | none: **no graded practice path exists today**. `learner-content` "practice" is guide text with nothing to grade. The table accepts `PRACTICE` so the first graded practice path writes here without a migration. | `PRACTICE` |

**Readiness check is `ASSESSMENT`, not `DIAGNOSTIC`.** It produces `ASSESSMENT_OUTCOME` evidence and
moves the band; `DIAGNOSTIC` is kept for the placement test (ENG-14), which estimates without being
assessment evidence. **All institution exam kinds (`MID_EXAM`, `UNIT_TEST`, `MOCK_TEST`) are
`ASSESSMENT`**, because all of them feed the 0030 bridge; calling a mock test "practice" while its
result becomes evidence would make the context column lie.

**Unpublished exam results are still recorded.** Publication gates *evidence* — an unpublished result is
not yet the institution's word (0030). The attempt log records what the student did, which happened
whether or not the result is released; nothing shows attempt rows to students or employers, and no
projection reads them yet.

**Negative marking is not carried.** As in the 0030 bridge, a penalty is assessment policy, not a
statement about what was demonstrated; a wrong answer scores 0.

## Skill of an exam item

Exam questions are authored against an institution-local subject (`exam_subjects`) and, optionally,
an institution-local syllabus node — neither is a readiness topic. The 0030 bridge maps a whole
*subject* onto one or more topics with weights; that is a statement about the paper, not about any
single question. So an exam attempt row carries `skill_id = NULL` and the projection (ENG-05) resolves
skills through the subject mapping in force, which it can do because the row keeps `item_id` and
`source_attempt_id`. *Rejected:* stamping the mapped topic when the subject maps to exactly one — the
answer would depend on how many links existed at the time, and a subject gaining a second link would
leave two kinds of rows. Readiness-check items have a topic and carry it.

## Consent

**Attempts are recorded without the `adaptive-learning` purpose, and keep being recorded after it is
withdrawn.** An attempt row is the product's record of work the student chose to submit for grading —
the same fact already held in `assessment_responses` and `exam_answers`, in one shape and in the same
transaction. Recording it builds no profile and changes nothing the student sees. What
`adaptive-learning` gates, per ENG-01, is the *use* of that history: projections, a personalised plan,
mastery tracking. So:

- without the purpose, or after withdrawal: attempts are recorded; **no projection is written**
  (ENG-05 checks `hasConsentPurpose` before writing `learner_skill_state`), and the student stays on
  the non-adaptive path — exactly ENG-01's withdrawal behaviour;
- `model-improvement` withdrawn: the student's attempts leave the next de-identified export
  (`studentsConsentingToModelImprovement`, ENG-01); nothing is deleted;
- deleting the account erases them (below).

*Rejected:* recording attempts only with consent. The graded record exists regardless (the exam and the
readiness check need it), so gating the attempt log would not reduce what ONE holds — it would only
make the engine's history silently incomplete for anyone who grants consent later.

## Privacy deletion

A new `DELETION_POLICY` category, `LEARNING_ACTIVITY`, disposition **`ERASED`** (ADR-034): the
executor deletes the subject's `learning_attempt_events`, then `learning_sessions`, then
`learner_activity_events` (0015 behavioural telemetry that deletion previously left behind), in one
transaction that sets `one.privacy_erase_subject`. The count is recorded in `privacy_deletion_records`,
whose category CHECK (0009) is widened by 0047 to admit the new category — no existing value is
removed. `evidence_records` stays `ANONYMISED` exactly as before. With no facts left, the subject's
engine projections (none exist yet; ENG-05 adds them) rebuild to the empty set.

## Readiness

Nothing here writes readiness. The exam path's *existing* evidence write now goes through the existing
readiness path — `recomputeReadiness`, in the same transaction — which closes C9's defect (ADR-034
deferred it to this goal). Evidence rows written are unchanged.
