# Placement Tests — Table Design

**Status:** Adopted (ENG-14), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0064_placement_tests.sql` (`placement_tests`, `placement_test_items`; widens three 0047 CHECKs)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (TypeScript online, Python offline — Proposed, followed here), ADR-035 (migrations apply
once), ADR-020 (readiness is a band), `item-calibrations-table-design.md` (ENG-13),
`learning-attempt-events-table-design.md` and `learning-sessions-table-design.md` (ENG-03),
`learner-skill-state-table-design.md` (ENG-05), `engine-consent-purposes-design.md` (ENG-01),
`aptitude-item-bank-design.md` (ENG-10)

## Why this exists

A new student should not start the shared aptitude block (quantitative, logical, verbal) at the first lesson
if they already know half of it, and should not be dropped into the hardest material if they do not. ENG-14
asks for an adaptive placement test: estimate the student's ability from as few questions as possible, choose
each next question by what it tells us, stop when the estimate is confident or after 25 questions, and record
the answers as `DIAGNOSTIC` attempts so the existing skill-state projector (ENG-05) learns from them.
Acceptance C2: *the test ends in ≤ 25 items and ≤ 25 minutes, and repeat-test bands agree within one band for
80% of simulated students.*

The decision logic is a pure package, `packages/placement` (algorithm `placement-2pl-eap-v1`). This document
designs the two tables that hold a sitting while it is in progress and its result once it ends, and the rules
of the online path around the package.

## The algorithm (`placement-2pl-eap-v1`, packages/placement)

Pure and deterministic (ADR-034): no database, clock, randomness or network; the elapsed time is an argument.

| Step | Rule |
| --- | --- |
| Model | 2PL, `P(correct | θ) = 1 / (1 + exp(−a(θ − b)))`, using each item's `difficulty` b and `discrimination` a as stored in `item_calibrations`. |
| Ability estimate | Expected a posteriori (EAP) over a fixed grid θ ∈ [−4, 4] in steps of 0.05 with a standard-normal prior; the standard error is the posterior standard deviation. Chosen over maximum likelihood because ML has no finite estimate after all-correct or all-wrong answers — exactly the first few answers of every test. |
| Next question | Content balance first: the area (quantitative, logical, verbal) with the fewest questions asked so far, ties in fixed area order; then, within it, the unasked item with the greatest Fisher information `a²·P·(1−P)` at the current estimate; ties by item key. No randomness, so a replay chooses the same item. |
| Stop | In order: 25 minutes elapsed (`TIME_LIMIT`); 25 questions answered (`MAX_ITEMS`); at least 8 answered and standard error ≤ 0.30 (`CONFIDENT`); no unasked item left (`POOL_EXHAUSTED`). |
| Result | A **placement level**, never a number: θ < −1 → `AWARE`, −1 ≤ θ < 0 → `GUIDED`, 0 ≤ θ < 1 → `INDEPENDENT`, θ ≥ 1 → `TROUBLESHOOT`; or `NOT_ENOUGH_EVIDENCE` when the standard error is still above 0.5 (for example the time ran out after three questions). |

**Why the skill map's levels as the result vocabulary.** The skill map (OPS-09a, ENG-10) already describes
every skill at four levels — `AWARE`, `GUIDED`, `INDEPENDENT`, `TROUBLESHOOT` — as what a learner can do. A
placement answers "at which of those levels should this student start", so it reuses those labels rather than
inventing new ones (HG-3 spirit: no new vocabulary on a student surface). *Rejected:* the mastery band vocabulary
(`DEVELOPING`, `PROGRESSING`, `DEMONSTRATED`) — a placement is one sitting on one day, and C3 forbids claiming a
mastery band from single-day evidence; using those words would say the opposite of what the placement knows.
*Rejected:* readiness bands — placement is not readiness and never writes it (below).

The ability estimate, its standard error and the item parameters are **model state**. They are held in memory
while a request runs, and the item parameters are snapshotted on the served-item rows (so the result can be
replayed), but the estimate itself is not stored, never returned by an API, never shown to a student as a
number, never shown to anyone else, and never an input to readiness.

## Which items a placement may serve

Only items that are **published, current and calibrated**, all four together:

- a `question_versions` row whose release manifest is `PUBLISHED` and which is not superseded
  (`superseded_at IS NULL`), with an answer key — the readiness check's own "published" rule;
- on an **active** topic of the aptitude block (`taxonomy_nodes.stable_key` matching `^apt-[qlv]-`, ENG-10's
  keys; the letter gives the area);
- with a row in `item_calibrations`, read through `latestItemCalibrations` (ENG-13): latest `CALIBRATED`, else
  latest `PROVISIONAL`. An item with no calibration row at all is not served — the program says "over
  calibrated (or provisional) items", and a made-up default would be a number nobody fitted.

If fewer than **25** such items exist the placement is **not available** (`NOT_ENOUGH_ITEMS`) and nothing is
written. Today ENG-10's bank is entirely `DRAFT`, so on every environment the online path answers "not
available" — it fails closed. The package and the simulation harness below run on synthetic calibrated items,
which is how C2 is shown before any item is published.

**A retest avoids repeats.** Items the student answered in an earlier placement are left out of a new one,
provided at least 25 unseen eligible items remain; otherwise the whole pool is used. A retest on the same
questions would measure memory as much as ability.

## Consent

Placement is adaptive testing whose purpose is a personalised starting point, so it needs the
`adaptive-learning` purpose (ENG-01), checked server-side with `hasConsentPurpose` on **every** request (start,
answer, read). It fails closed: no live definition — the state until HG-6 publishes the purposes — a withdrawal,
or a grant of an older version all mean "not available" (`CONSENT_REQUIRED`), and the student stays on the
non-adaptive path (start at the beginning of the block). A withdrawal mid-test stops the next answer from being
taken; the unfinished test simply runs out its clock.

## The tables

### `placement_tests`

One row per sitting.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key. Also the `source_attempt_id` of its attempts and the `source_id` of its session. |
| `subject_user_id` | uuid NOT NULL → `users(id)`. |
| `institution_id` | uuid NULL → `organizations(id)`. The student's current institution at start (the attempt log's rule), fixed at insert. |
| `session_id` | uuid NOT NULL UNIQUE → `learning_sessions(id)`. Mode `DIAGNOSTIC`, source `placement_test`. |
| `scope` | text NOT NULL, CHECK `= 'APTITUDE_V1'`. Which item pool; a new scope widens the CHECK. |
| `algorithm_id` | text NOT NULL, CHECK `= 'placement-2pl-eap-v1'`. A change of rule is a new ID. |
| `state` | text NOT NULL, CHECK in (`IN_PROGRESS`, `COMPLETED`). |
| `started_at` | timestamptz NOT NULL DEFAULT `now()` — the database clock. |
| `deadline_at` | timestamptz NOT NULL, CHECK `started_at < deadline_at ≤ started_at + 25 minutes`. |
| `completed_at` | timestamptz NULL, CHECK `completed_at ≤ deadline_at`. A test that ran out of time is completed *at* its deadline. |
| `stop_reason` | text NULL, CHECK in (`CONFIDENT`, `MAX_ITEMS`, `TIME_LIMIT`, `POOL_EXHAUSTED`). |
| `placement_level` | text NULL, CHECK in (`AWARE`, `GUIDED`, `INDEPENDENT`, `TROUBLESHOOT`, `NOT_ENOUGH_EVIDENCE`). |
| `items_answered` | smallint NULL, CHECK 0–25. |

- CHECK: `state = 'COMPLETED'` exactly when `completed_at`, `stop_reason`, `placement_level` and
  `items_answered` are all present.
- Partial unique index: at most **one `IN_PROGRESS` test per student**. Starting again resumes it.
- Index `(subject_user_id, started_at DESC)`, `(institution_id, started_at)`.
- Trigger: `UPDATE` only to complete an `IN_PROGRESS` row once, every other column unchanged; `DELETE` only in
  the privacy-deletion transaction for the same subject (`one.privacy_erase_subject`, as 0047).

*Rejected:* **storing the ability estimate and standard error on the row.** They are replayable from the
item snapshots and the attempts, and a stored number is one query away from a screen. *Rejected:* **no table,
the attempt log only.** The attempt log records answers, not which question was put to the student and
not yet answered; without that the server cannot check that an answer is to the question it served, and a
client could answer questions of its own choosing.

### `placement_test_items`

One row per question served, written when it is served.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key. |
| `placement_test_id` | uuid NOT NULL → `placement_tests(id)`. |
| `subject_user_id` | uuid NOT NULL → `users(id)`; `institution_id` uuid NULL → `organizations(id)`. Same as the test (D.1 data rule; also what the erase guard checks). |
| `position` | smallint NOT NULL, 1–25; `UNIQUE (placement_test_id, position)`. |
| `item_source` | text NOT NULL, CHECK `= 'CAREER_READINESS_QUESTION'`; `item_id` uuid NOT NULL → `question_versions(id)`; `item_version` integer NOT NULL > 0. `UNIQUE (placement_test_id, item_source, item_id)`. |
| `skill_id` | uuid NOT NULL → `taxonomy_nodes(id)`. |
| `item_group` | text NOT NULL, CHECK in (`QUANTITATIVE`, `LOGICAL`, `VERBAL`). |
| `difficulty`, `discrimination` | numeric(6,4) NOT NULL, the 0062 bounds (−4…4, 0.2…4). **Snapshot** of the calibration used, so a later calibration run cannot change what this sitting meant. |
| `calibration_status` | text NOT NULL, CHECK in (`PROVISIONAL`, `CALIBRATED`); `calibration_run_id` uuid NOT NULL → `item_calibration_runs(id)`. |
| `served_at` | timestamptz NOT NULL DEFAULT `now()`. |

Append-only; `DELETE` only by privacy deletion for the same subject.

The **answer** is not stored here. It is a `learning_attempt_events` row — `context = 'DIAGNOSTIC'`,
`source_attempt_type = 'placement_test'`, `source_attempt_id` = the test — written through the existing
`recordGradedAttemptSession`, whose unique index already guarantees one answer per question per test. The
served-but-unanswered question of an `IN_PROGRESS` test is the item row with no attempt.

### Widened 0047 CHECKs

`learning_sessions.mode` gains `DIAGNOSTIC`; `learning_sessions.source_type` and
`learning_attempt_events.source_attempt_type` gain `placement_test`. No existing value is removed. The
0047 constraints are declared inside `CREATE TABLE IF NOT EXISTS`, so a replay of 0047 never re-adds the narrower
list, and 0064 drops and re-adds the widened one idempotently. *Rejected:* recording placement answers as
`assessment_attempt` rows or in `ASSESSMENT` sessions — the context column would lie, and the readiness path
would read them as assessment evidence.

## The online path

`packages/persistence/src/placement-tests.ts`, behind three routes under `/api/v1/learning/placement-test`
(authenticated student; the route acts only on the caller's own tests):

- **Read** (`GET`) — the in-progress test with its current question, or the latest completed result, or
  "not available" with a reason.
- **Start** (`POST`) — resumes the in-progress test; otherwise, if available, creates the session, the test,
  and serves the first question, in one transaction under a per-student advisory lock.
- **Answer** (`POST …/:placementTestId/answers`, `{questionId, selectedOptionId}`) — locks the test row; refuses
  an answer to anything but the served question (409); grades against the answer key; writes the attempt
  (with any published misconception the option signals, as the readiness check does); recomputes the estimate
  from the snapshots and the attempts; then either serves the next question or completes the test and closes
  its session — all in one transaction. A repeated answer to an already-answered question is a replay and
  returns the current state.

Every read first completes an in-progress test whose deadline has passed (`TIME_LIMIT`, level from the answers
it has). An answer that arrives after the deadline is not graded. Times come from `now()` in SQL, never Node.

**What a student receives.** The question's id, prompt, options (`id`, `text` only), its position, how many
questions have been answered, the maximum (25) and the deadline; at the end, the placement level and the stop
reason. Never the answer key, never whether an answer was right, never a difficulty, discrimination, ability
estimate or standard error. Errors carry codes and plain sentences, no internals.

**What changes downstream.** Each answer requests the skill-state projection in the same transaction
(`recordGradedAttemptSession` does this), so the student's skill state learns from the `DIAGNOSTIC`
attempts through the existing projector — which itself checks `adaptive-learning` again before writing.

## Simulation harness (C2)

`packages/placement/src/simulation.ts`, pure and seeded. It builds a synthetic calibrated pool (300 items, the
size of ENG-10's bank, in three areas), draws synthetic learners θ ~ N(0, 1), answers each question from the
true 2PL, draws each response time from a seeded log-normal (median 40 s), and runs every learner **twice**,
the second time without the first test's items. It reports the largest number of items, the longest duration,
the stop reasons, exact level agreement and agreement within one level. Scenarios: the test using the true
parameters; the test using noisy estimates of them (what a real calibration gives); and a provisional-only pool
(every discrimination 1.0). `corepack pnpm --filter @planthepath/placement simulate` prints the report; a test
asserts C2 on each scenario. Every learner and item is synthetic; nothing reaches a screen.

## Privacy deletion

Placement data is engine behavioural data, `LEARNING_ACTIVITY` / `ERASED` (ADR-034): the executor deletes
`placement_test_items`, then `placement_tests`, before the sessions they reference, in the transaction that sets
`one.privacy_erase_subject`. Counts join the existing `LEARNING_ACTIVITY` total. The attempts go with the attempt
log, as today.

## Readiness and employers

Nothing here writes or reads readiness, evidence records or `readiness_snapshots`. `DIAGNOSTIC` attempts are not
assessment evidence (ENG-03). No route exposes a placement to an employer or institution. No model is called.

## Open points (decisions for Divakar)

1. **Numbers in the rule.** Stop at SE ≤ 0.30 after at least 8 questions; 25 questions; 25 minutes; level cuts
   at θ = −1, 0, 1; `NOT_ENOUGH_EVIDENCE` above SE 0.5; at least 25 eligible items to offer a test. Adopted;
   each is a constant under the algorithm ID, so a change is a new ID.
2. **One ability for the whole block.** v1 places the student on one scale across the three areas (balanced
   by area). Per-area placement needs roughly three times the questions for the same confidence; recommended
   only once calibrations show the areas behave differently.
3. **Item exposure.** Selection is deterministic, so students who answer alike see the same questions. Fine
   for a pilot; a seeded "choose among the top few" rule is the usual fix and would be a new algorithm ID.
4. **Student screen.** Not built here: ENG-18 (student learning experience) owns the onboarding screens and
   must carry them to Android. Until then no client calls these routes.
