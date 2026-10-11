# Learning Step Items — Table Design (and the student learning experience it serves)

**Status:** Adopted (ENG-18), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0072_learning_step_items.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `learning-decisions-table-design.md` (ENG-08 planner and audit), `review-scheduler-design.md`
(ENG-09 due reviews), `placement-tests-table-design.md` (ENG-14), `learner-goals-table-design.md` (ENG-19),
`learning-attempt-events-table-design.md` and `learning-sessions-table-design.md` (ENG-03),
`question-hint-ladders-table-design.md` (OPS-09b), `engine-consent-purposes-design.md` (ENG-01),
ADR-020 (readiness is a band), ADR-034, ADR-035 (migrations apply once)

## Why this exists

ENG-18 gives the student the engine's front door, inside the existing student navigation (HG-3: no item is
added, removed, renamed or reordered): after onboarding, the placement test; a path grouped into **skip /
review / learn** (C1); **one next step with its reason** (C4); **due reviews first** (C7); **practice with the
hint ladder**; honest **"not enough evidence"** states (C3); and all of it with every AI flag off (X2).

Almost all of it reads what earlier goals built. One fact has nowhere to live: **how far up the hint ladder a
student went on a practice question before answering.** The attempt log (0047) records `highest_hint_level`
and derives `assisted` from it (level 3 or more is assisted and never counts toward DEMONSTRATED — C5), but
it records it *when the answer is graded*. If the client simply reported the level with its answer, a student
(or a modified client) could read hint 4 and report 0, and an assisted success would count as unaided
evidence. The level used must therefore be the server's record of which hints it actually released. That is
this table: one row per practice question served for a planner decision, carrying the highest hint level the
server has shown.

## Where the screens live (no navigation change)

| Existing label | Web (route) | Android | What ENG-18 adds |
| --- | --- | --- | --- |
| Learning | `/student/learning` (authenticated branch) | Learning tab | Placement test card; "Your next step" with its reasons and the practice runner (hints, answer, feedback); the path in skip / review / learn groups; "Due for review" (due or not, no dates or numbers). The existing modules/lessons list stays below. |
| Practice | `/student/practice` | — (no Practice screen exists on Android; the runner lives in the Learning tab there, as on web) | The "Practice by Skill" slot shows the path's review and learn skills with a link to the runner on Learning, instead of a permanent NA. |

The onboarding question ("What job do you want?") stays where ENG-19 put it (My Career / Career target). The
Learning page shows the placement test and, when the student has no primary role goal yet, an empty state that
sends them to My Career — never a borrowed or invented path.

## Routes (all for the signed-in student's own data; the subject comes from the principal)

| Route | Does |
| --- | --- |
| `GET /api/v1/learning/path` | Adaptive or not; the primary target; the path groups (`learning-path-groups-v1`); the due-review list (adaptive only); the latest step (decision) with its state. Reads only. |
| `POST /api/v1/learning/next-step` `{ sessionMinutes?: 1–600 \| null }` | Calls ENG-08's `planNextLearningStep` (records the decision), opens its step and serves the first practice question when one exists. |
| `POST /api/v1/learning/steps/:decisionId/hints` `{ questionId }` | Releases the next hint level (1–4) of the question being answered, if it has a **published** ladder; records the level on the served row. |
| `POST /api/v1/learning/steps/:decisionId/answers` `{ questionId, selectedOptionId }` | Grades the served question, records a `PRACTICE` (or `REVIEW`) attempt through ENG-03's writer with the **server-recorded** hint level, links the attempt to the decision (`linkDecisionOutcomeAttempts`), returns right/not-right and assisted-or-not, then serves the next question or finishes the step. |

The placement test keeps ENG-14's routes (`/api/v1/learning/placement-test`); ENG-18 adds its screen.

No route returns an answer key, the correct option, the explanation (it lives with the key), an item
parameter, an ability estimate, a BKT likelihood, FSRS stability/difficulty, a due date, or any readiness value.
After an answer the student learns only whether *their* choice was right. Errors carry a code, a plain sentence
and the correlation id.

## The path groups: `learning-path-groups-v1` (pure, in `packages/learning-orchestrator`)

Input: the primary target's current `career-gap-v1` items (topic, requirement level, status, priority rank), the
adaptive flag, and — adaptive only — skill states (stage, band, attempt count) and the due-review skills in due
order. Output: three ordered lists, each entry carrying the skill, its requirement level, its gap status, an
evidence band and plain reason codes.

1. **Review, due first (C7).** Adaptive only: a skill with a due review goes to *review* with `DUE_REVIEW`,
   ahead of everything else and in the scheduler's due order — even a requirement already met, because a due
   review is exactly "you knew this; check you still do".
2. **Skip.** The gap says `MET`: the evidence already meets the requirement (`ALREADY_MET`).
3. **Review.** The gap says `PARTIAL` (`GAP_PARTIAL`), or — adaptive — the student has practised the skill before
   (`PRACTISED_BEFORE`).
4. **Learn.** Everything else: `MISSING` or `UNKNOWN` and, adaptive, never practised (`NEW_SKILL`).

Within each group, gap priority rank (the planner's order). These are the same distinctions planner v1 uses
(LEARN for new, PRACTICE for partial or practised, REVIEW for due), so the path never contradicts the next step.
*Rejected:* skipping a skill because practice reached DEMONSTRATED while the requirement's evidence is not met —
the planner would still send the student there, and the two screens would disagree.

**Band shown (C3).** Adaptive: the skill state's `evidence_band` (learning-model-v1), else
`NOT_ENOUGH_EVIDENCE`. Not adaptive: the latest `mastery_projections.band` for the topic (the existing evidence
path everyone already has), else `NOT_ENOUGH_EVIDENCE`. Both vocabularies are identical, and both say "not enough
evidence" — never "developing" — for a single attempt or a single evidence record. Labels only; no number.

**Counts, not percentages.** ADR-034 left `careerTargetProgress.percentOfEvaluated` to ENG-18. No screen shows it
today (Android carries it in a DTO only). The path view shows counts of requirements met, evaluated and not yet
measured — facts with their own denominator — and no percentage. The field stays in the existing response
(removing it is a contract change with no benefit); nothing renders it.

## Steps, practice and hints

A **step** is one planner decision the student acts on. Opening it creates a `learning_sessions` row
(`mode` REVIEW for a REVIEW action, LEARN for LEARN, otherwise PRACTICE; `source_type = 'learning_step'`,
`source_id` = the decision id), so ENG-03's writer attaches every attempt of the step to it.

**Which questions** (`learning-step-items-v1`, at most **5** per step): published, current, answer-keyed
`question_versions` on the decision's skill — the same "published and current" rule the placement test uses —
excluding questions served in one of the student's own in-progress readiness checks. Fresh questions first
(never answered by this student in a learning step), then the least recently answered, then by stable key and
id. Deterministic. No calibration is needed: practice does not estimate anything. If the skill has no such
question the step says so ("No published practice for this skill yet") and records nothing — the state every
real student sees today, because nothing aptitude or SOC-specific is published.

**Hints.** Only a ladder whose `review_state = 'PUBLISHED'` is served, read from `question_hint_ladders` —
never the question body, which holds the key. Each request releases one more level (1 nudge, 2 strategy,
3 worked step, 4 near solution); the screen warns before level 3 that the answer will then count as assisted. A
question without a published ladder says "No hints for this question".

**Answers.** One answer per question per step (the attempt log's unique index already enforces it). The attempt
carries the served row's hint level, so `assisted` is the server's fact. Misconception codes are resolved from
published option tags as the placement test does. The step finishes when its questions are answered or none
remain; the session is closed then.

**Due reviews are never shown as numbers.** "Due for review" is a list of skills that are due. No date, no
interval, no count of days, no stability.

## The table: `learning_step_items`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `decision_id` | uuid NOT NULL → `learning_decisions(id)` |
| `subject_user_id` | uuid NOT NULL → `users(id)`; must equal the decision's subject (insert trigger) |
| `institution_id` | uuid → `organizations(id)`; copied from the decision (insert trigger checks it) |
| `session_id` | uuid NOT NULL → `learning_sessions(id)`; the step's session, same subject |
| `position` | smallint 1–5 |
| `item_source` | text, `CAREER_READINESS_QUESTION` only |
| `item_id` | uuid NOT NULL → `question_versions(id)` |
| `item_version` | integer > 0 |
| `skill_id` | uuid NOT NULL → `taxonomy_nodes(id)` |
| `hint_level` | smallint NOT NULL DEFAULT 0, 0–4: the highest hint level the server released for this item |
| `served_at` | timestamptz NOT NULL DEFAULT now() |

Unique: (`decision_id`, `position`), (`decision_id`, `item_source`, `item_id`).

### Guard

- **Insert** only for a decision of the same subject and institution, with a session of the same subject whose
  `source_type = 'learning_step'` and `source_id = decision_id`.
- **Update** only `hint_level`, only upward, only by one level at a time, and only while no attempt exists for the
  item in this step (`learning_attempt_events` with `source_attempt_type = 'learning_step'`,
  `source_attempt_id = decision_id`, same item). After the answer, the hint level is history.
- **Delete** only inside the privacy-deletion transaction for the same subject
  (`one.privacy_erase_subject`), as every engine table.

*Why a row per served item and not a hint-events log:* the only question ever asked of it is "what is the highest
level shown for this item in this step", and it only grows; one monotonic column answers it and replays nothing.
*Rejected: trusting the client's reported level* (above). *Rejected: a column on `learning_attempt_events`* — the
attempt row is written once, at grading, and the hint level must exist before it. *Rejected: reusing
`placement_test_items`* — a different sitting with a calibration snapshot; mixing them would break both guards.

### Widened checks (nothing dropped)

- `learning_sessions.source_type` and `learning_attempt_events.source_attempt_type` gain `learning_step`
  (keeping `assessment_attempt`, `exam_attempt`, `placement_test`).

## Consent (ENG-01)

`adaptive-learning` is read on every call. Without it — every real student until HG-6 publishes the purpose —
the planner takes its non-adaptive path (ENG-08), the path uses gap statuses and evidence bands only, and no due
reviews are read or shown. Practice itself needs no purpose: recording submitted work is not profiling (ENG-03);
only what is derived from it is gated, and ENG-05 already gates the projection.

## Readiness, models and AI (X2)

Nothing here reads or writes `readiness_snapshots`, `readiness_factors` or evidence records, and nothing produces a
number about a student. Practice attempts are not assessment evidence. No model is called anywhere; planner v1
never chooses a strategy that needs one; the screens work identically with every AI flag off, which is the
default.

## Privacy deletion

`LEARNING_ACTIVITY` (ADR-034, ERASED) deletes the subject's `learning_step_items` first — they reference
decisions, sessions and questions — then the attempts, placement rows, sessions and decisions as today. The count
is added to that category's total.

## Idempotency and replay (ADR-035)

`CREATE TABLE IF NOT EXISTS`; indexes `IF NOT EXISTS`; CHECKs dropped `IF EXISTS` and re-added with every earlier
value; `CREATE OR REPLACE FUNCTION`; `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`. References only tables
created before it (0004, 0047, 0053, 0064). It applies once under ADR-035 and survives the bootstrap replay.

## Open points (decisions for Divakar)

1. **Topic goals are not in the plan yet** (recommended). Feeding ENG-19's topic goals into the planner changes
   its inputs, which is a new policy (`learning-orchestrator-v2`) with its own golden tests and replay; ENG-18's
   acceptance does not need it. The path shows the primary role goal's requirements.
2. **Practice shares the published bank with readiness checks on the same topic** (recommended for the pilot):
   there is no practice-only pool flag, as the placement test shares the aptitude bank. Questions in the
   student's own in-progress check are excluded. A pool flag on content revisions would be the fix if exposure
   matters.
3. **Right / not right after each practice answer, never the correct option or explanation** (recommended): the
   hard rule keeps keys out of learner responses; explanations can come back when they are stored apart from
   the key.
4. **Five questions per step** (recommended): a step is a short, finishable unit; the next step is re-planned
   from the new facts.
5. **Placement is offered to every signed-in student on Learning** (recommended), after the onboarding question in
   My Career; it is available only with the adaptive-learning purpose and 25 published, calibrated aptitude
   items, and says plainly which of the two is missing.
