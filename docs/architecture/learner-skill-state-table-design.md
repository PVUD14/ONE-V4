# Learner Skill State — Table Design (and the attempt log's misconception link)

**Status:** Adopted (ENG-05), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0052_learner_skill_state.sql` — the `learner_skill_state` projection, and two columns on
`learning_attempt_events` (`selected_option_id`, `misconception_code_ids`) designed by ENG-07
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (facts append-only, projections rebuildable; engine behavioural data is ERASED on
deletion; the live stage lives here), ADR-033 (no model in the loop), ADR-028 (the outbox is the
transport), `learning-attempt-events-table-design.md` (ENG-03), `evidence-stages-table-design.md`
(ENG-04), `misconception-codes-table-design.md` (ENG-07), `engine-consent-purposes-design.md` (ENG-01),
`exam-topic-bridge-table-design.md` (0030)

## Why this exists

The planner (ENG-08), BKT in shadow (ENG-06), the review scheduler (ENG-09) and the faculty "stuck on the
same skill" view (INST-15) all ask the same question: *where does this student stand on this skill right
now?* Answering it by folding the whole attempt log on every request is slow and would put the same
fold in five places. `learner_skill_state` is that answer, kept as one row per student per skill.

It is a **projection**: every value in it is computed from facts — the attempt log (ENG-03), the published
misconception catalogue (ENG-07) and the exam subject mapping (0030) — by one versioned function. It is
never edited by hand, and throwing it away and rebuilding it from the facts gives the same table.

## The table: `learner_skill_state`

One row = one student × one skill.

| Column | Notes |
| --- | --- |
| `subject_user_id` | uuid NOT NULL → `users(id)`. Part of the primary key. |
| `skill_id` | uuid NOT NULL → `taxonomy_nodes(id)`. Part of the primary key. A `TOPIC` today (every readiness question and every exam mapping targets a topic); a `SKILL` once ENG-10's skill map exists, or when a misconception code is authored against one. |
| `institution_id` | uuid NULL → `organizations(id)`. D.1's data rule. **The institution recorded on the latest attempt that contributes to the row** (by `occurred_at`, then attempt id). A fact-derived value, so a rebuild reproduces it; NULL for an independent learner. See "Institution". |
| `attempt_count` | integer NOT NULL ≥ 0. Answered attempts on the skill. |
| `attempt_day_count` | integer NOT NULL ≥ 0, ≤ `attempt_count`. Distinct Asia/Kolkata calendar days those attempts fall on — the C3 sufficiency input. |
| `unaided_success_count` | integer NOT NULL ≥ 0, ≤ `attempt_count`. |
| `unaided_success_day_count` | integer NOT NULL ≥ 0, ≤ `unaided_success_count`. **Unaided successes on distinct days** — the goal's column; the DEMONSTRATED rule's input. |
| `assisted_success_count` | integer NOT NULL ≥ 0. Correct but assisted (hint ≥ 3 or a tutor reply). Counted so the gap is visible; never counts toward a stage (C5). |
| `last_attempt_at` | timestamptz NULL. NULL exactly when `attempt_count = 0`. |
| `evidence_stage` | text NOT NULL, CHECK in `ESTIMATED`, `RETAINED`, `DEMONSTRATED`, `TRANSFERRED`. The live stage (ADR-034: it lives here, not on the immutable evidence rows). |
| `evidence_band` | text NOT NULL, CHECK in `NOT_ENOUGH_EVIDENCE`, `DEVELOPING`, `PROGRESSING`, `DEMONSTRATED`. `learning-model-v1`'s skill band, held beside the live `mastery_projections` band so ENG-06's shadow report can measure the difference. A per-skill evidence band, **not readiness**. |
| `active_misconception_codes` | text[] NOT NULL DEFAULT `'{}'`. The `misconception_codes.code` strings active for this skill, sorted, no duplicates, no NULLs. See "Active misconception codes". |
| `mastery_likelihood` | numeric(5,4) NULL, 0–1. **NULL until ENG-06** (BKT in shadow) computes it inside this projector. |
| `mastery_uncertainty` | numeric(5,4) NULL, 0–1. NULL until ENG-06. |
| `mastery_algorithm_version` | text NULL. CHECK: NULL exactly when both mastery columns are NULL — a number never appears without the algorithm that produced it. |
| `review_stability` | numeric(10,4) NULL, > 0. FSRS stability. NULL until ENG-09. |
| `review_difficulty` | numeric(6,4) NULL. FSRS difficulty. NULL until ENG-09. |
| `review_due_at` | timestamptz NULL. NULL until ENG-09. |
| `review_algorithm_version` | text NULL. CHECK: NULL exactly when the three review columns are NULL. |
| `algorithm_version` | text NOT NULL, 1–64. The projector's ID, `learner-skill-state-v1` (stage fold `learning-model-v1` + misconception activity rule below). Changing any rule is a new ID, never an edit (ADR-034 §2). |

Primary key `(subject_user_id, skill_id)`. Indexes: `(institution_id, skill_id)` for INST-02-scoped
reads (INST-15/17); `(skill_id)`.

**Deliberately absent: a `projected_at` / `updated_at` column.** It would be the only value a rebuild
cannot reproduce, and the acceptance is that a rebuild reproduces the table *exactly*. Freshness is
`last_attempt_at`; when the projector last ran is in `event_consumer_receipts`.

**Numbers here are model state, never readiness.** ADR-034's data rule: mastery likelihood and FSRS
values are internals; no screen presents them as a score or as readiness, none reaches an employer, and
this table is never read by the readiness path. Nothing in this goal reads the table on any route.

### "Never edited by hand", enforced

A trigger rejects every `INSERT`, `UPDATE` and `DELETE` unless the transaction has set the
transaction-local setting `one.learner_skill_state_writer` to `learner-skill-state-projector` (only the
projector module sets it, with `set_config(…, true)`, inside its own transaction), or — for `DELETE`
only — `one.privacy_erase_subject` names the same subject (the privacy-deletion transaction, exactly as
ENG-03's attempt log). Same standing as the 0004 and 0047 triggers: a guard against application
mistakes, not a security boundary. `TRUNCATE` fires no row trigger; test suites that truncate `users …
CASCADE` are unaffected.

*Rejected:* no guard, relying on convention — the whole point of a projection is that nobody "fixes" a
row by hand; the next rebuild would silently undo it and nobody would know why.

## How it is computed

`packages/learning-model` gains `projectLearnerSkillStates(attempts)` (algorithm
`learner-skill-state-v1`): pure, deterministic, order-independent. Input is one student's attempts, each
already resolved to the skills it bears on; output is the full set of rows for that student, sorted by
skill. The persistence side only loads facts and writes rows.

### Which attempts bear on which skill

| Attempt | Skill(s) |
| --- | --- |
| Readiness-check item (`CAREER_READINESS_QUESTION`) | its `skill_id` (the question's topic) |
| Institution exam item (`INSTITUTION_EXAM_QUESTION`, `skill_id` NULL by ENG-03's design) | every topic the paper's subject (`exam_definitions.subject_id`) was mapped to **at the moment of the attempt**: links with `created_at ≤ occurred_at` and not retired by then. **Only when the result is published.** |
| Any unanswered item | none — a blank is not an attempt at the skill |

- **The mapping in force at the time**, not today's. Links are retired, never deleted (0030), so the
  historical mapping is itself a fact and a rebuild reproduces it. Today's mapping would make the row
  depend on when the rebuild ran — the exact failure ENG-03 rejected for stamping a topic on the row.
  It also matches the evidence bridge, which writes evidence under the mapping live at submission.
- **An unmapped subject contributes nothing** and a later mapping does not reach back — C9's rule, and the
  bridge's.
- **Unpublished exam results do not count yet.** Publication is when the result becomes the
  institution's word (0030); the stage must not run ahead of what the institution has released. Today
  publication is fixed at submission (`publish_results_immediately`); a later "publish results" action
  must request a projection for each student it publishes (recorded as a follow-up).
- **Weights are not carried.** A weight apportions a paper's *credit* between topics for evidence; a stage
  asks whether an item was answered correctly without help, which a weight does not divide. An exam item
  on a subject mapped to two topics is an attempt on both.

*Rejected:* resolving exam items only when the subject maps to exactly one topic — the answer would
depend on how many links existed, which ENG-03 already rejected.

### Stage, counts and band

Exactly `summariseSkillEvidence` from `learning-model-v1` (ENG-04) over the skill's answered attempts:
stage (C5: assisted successes never move it), attempt and success counts, distinct days, and the band
(C3: one attempt, or any number on one day, is `NOT_ENOUGH_EVIDENCE`).

### Active misconception codes (`misconception-activity`, part of `learner-skill-state-v1`)

ENG-07's link: the attempt row carries the published `misconception_codes.id` values its chosen option
signalled, fixed at insert. The projector maps them to `code` strings and files each under **the code's
own `skill_id`** (ENG-07's design), which is the question's topic in every tag authored so far.

A code is **active** for a student while at least one attempt that signalled it is *uncleared*. A signal
is **cleared** by a later (`occurred_at`, then id) **unaided correct** attempt on **the same item**
(`item_id`): the student met the same question again and avoided the trap without help.

- *Why the same item, not the same skill.* Scenario X1 is a student who gets subnet host counts right and
  boundaries wrong; clearing the boundary misconception on any correct subnetting answer would erase
  exactly the signal the planner needs. The same item is the one place the attempt log alone can show
  the trap was avoided.
- *Why assisted success does not clear.* The same reason it never counts toward DEMONSTRATED (C5).
- A code's row exists even when the student has no attempts on the code's skill (`attempt_count = 0`,
  stage `ESTIMATED`, band `NOT_ENOUGH_EVIDENCE`): the signal is a fact and must not be dropped because a
  tag named a different node than the question.

*Rejected:* "active if signalled in the last N attempts" — N is an invented tuning number with no
basis yet; ENG-08 can add recency to its own policy with a reason code. *Rejected:* never clearing — the
list would only grow and stop meaning anything.

### Institution

The latest contributing attempt's `institution_id`. *Rejected:* the student's current relationship at
projection time — it would make the row depend on when the projector ran, so a rebuild could differ from
the incremental result. A student who moves institution and has not attempted anything since keeps the
old institution on the row until their next attempt, which is also what the attempt log itself says.

## When it runs: the projector on the outbox pipeline

- **Request.** `recordGradedAttemptSession` (both engines, in the grading transaction) inserts one outbox
  event `learning.skill_state.projection_requested` v1 (payload `subjectUserId`, `reason`
  `ATTEMPTS_RECORDED`) whenever it wrote at least one attempt row. Granting `adaptive-learning` inserts the
  same event with reason `CONSENT_GRANTED`, so a student who consents later gets their history projected.
  Registered in `packages/events`.
- **Consume.** The local dispatcher (ADR-028) routes it to `consumeSkillStateProjectionRequested`, which
  runs under `handleEventIdempotently` (consumer `learner-skill-state-projector`) and **recomputes the
  whole student** from facts, under a per-student advisory lock so two workers cannot interleave. Rows no
  longer derived are deleted; the rest are upserted.
- **Idempotent by construction.** The effect is "make this student's rows equal to f(facts)", so a
  replayed, duplicated or out-of-order event converges to the same rows; the receipt only saves work.
- **Never in a request handler.** Grading writes the request row; the fold runs in the worker. No model
  call anywhere (ADR-033).

*Rejected:* projecting inside the grading transaction — it would lengthen every submit and put the
consent check and the fold on the request path; D.1 says "a projector job on the outbox pipeline".
*Rejected:* incremental folding from a stored fold state (item-id lists, day lists) — more columns, more
ways for incremental and rebuild to drift. Per-student recomputation makes "rebuild = incremental" true by
construction, and a student's attempt history is small.

### Full rebuild

`rebuildLearnerSkillState(db)` (CLI: `corepack pnpm --filter @planthepath/persistence engine:rebuild-skill-state`)
recomputes every student who has attempts **or** existing rows, one transaction per student. Idempotent;
safe to run beside the worker (same lock). This is the recovery path after a rule change (new
`algorithm_version`) or a suspected defect, and the test oracle: *rebuild after incremental projection
changes nothing*.

## Consent (ENG-01)

`adaptive-learning` gates the projection, checked with `hasConsentPurpose` every time the projector runs
for a student (fails closed; until HG-6 publishes the definitions nobody has it, so nothing is projected
in any real environment).

- **Without it:** no rows are written for the student. Attempts are still recorded (ENG-03's decision).
- **On withdrawal: the student's existing rows are deleted**, in the same transaction that records the
  withdrawal, and the projector keeps them deleted (it removes rows for any non-consenting student it
  runs for). *Why delete rather than freeze:* the projection is the profile the consent was for; keeping
  a frozen copy is still holding a behavioural profile without a basis, and it would silently go stale
  while looking current. Nothing is lost — the facts stay, so a later grant rebuilds exactly the same
  rows (`CONSENT_GRANTED`). Evidence rows are untouched (immutable, 0004), as ENG-01 said.
- *Rejected:* keeping existing rows and only stopping new writes — ENG-01 left "what happens to an
  existing projection" open; ADR-034 treats engine behavioural data as the person's, to be erased when
  its basis goes.

## Privacy deletion

ADR-034: engine behavioural data is **ERASED**. In the deletion executor's `LEARNING_ACTIVITY`
transaction (which sets `one.privacy_erase_subject`), after the attempts and sessions are deleted, the
projector is run for the subject — **deletion triggers a rebuild**, as the goal says, and with no facts
left the rebuild is the empty set, so every row (including code-only rows) is deleted. The count is
added to the `LEARNING_ACTIVITY` record; no new deletion category and no CHECK widening is needed (the
category already covers `learner_skill_state` by ADR-034's definition). The subject's pending projection
requests stay in the outbox; if the worker later runs them, the subject has no facts and no consent, and
the result is still empty.

## The attempt log's misconception link (ENG-07's deferred columns)

0052 adds to `learning_attempt_events`, exactly as `misconception-codes-table-design.md` designed:

| Column | Notes |
| --- | --- |
| `selected_option_id` | text NULL, 1–64 chars. The option the student chose on a choice item from the readiness bank. NULL for exam items (outside the tagged bank — ENG-07 tags `question_versions` only), non-choice items and blanks. |
| `misconception_code_ids` | uuid[] NOT NULL DEFAULT `'{}'`. The `misconception_codes.id` values `resolveResponseMisconceptions` returned — **published** tags on **published** codes only — fixed at insert in the grading transaction. CHECKs: no NULL element; at most 16; empty when the answer is correct (a correct answer signals nothing). No FK on an array; ids come from the server-side resolver, never from client input. |

Added with constant defaults: a catalogue change that rewrites no row and fires no row trigger, so the
append-only trigger (0047) is untouched and every existing row reads `NULL` / `'{}'`. A later re-tag never
rewrites an attempt: the ids are what was published when the student answered.

The readiness-check submit resolves every response before writing the attempt rows; the exam path
records neither column.

## Migration

`0052_learner_skill_state.sql`: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, every CHECK
dropped `IF EXISTS` and re-added, `CREATE OR REPLACE FUNCTION` and `DROP TRIGGER IF EXISTS` before
`CREATE TRIGGER` — every replay leaves the same state. It references tables from 0001–0049 only
(`users`, `organizations`, `taxonomy_nodes`, `learning_attempt_events`), so it runs correctly before
0070/0071 on a fresh database.

## Readiness

Nothing here writes `readiness_snapshots`, `readiness_factors` or `mastery_projections`, and nothing reads
this table to decide readiness. No numeric readiness value is computed or shown.

## Open points (decisions for Divakar)

1. **Misconception clearing rule.** Recommended as above (a later unaided correct answer on the same
   item). Revisit when ENG-08's golden tests and real tagged items exist.
2. **Exam results published after submission.** No such path exists today. Recommended: whichever goal
   adds one requests a projection for each affected student in the same transaction.
3. **Access requests.** Neither the attempt log (ENG-03) nor this projection is in the DPDP data export
   yet. Recommended: add both when the export is next revised (OPS-06 follow-up), as engine data about the
   person.

## Update (ENG-06)

The mastery columns are now filled by `mastery-bkt-v1` inside the projector, in shadow only, and the
projector's ID is `learner-skill-state-v2`. Design, parameters and the shadow report:
`mastery-bkt-shadow-design.md`.
