# Evidence Stages, the Assisted Flag and Required Evidence Types — Table Design

**Status:** Adopted (ENG-04), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0050_evidence_stages_and_required_evidence.sql`
**Package:** `packages/learning-model` (algorithm ID `learning-model-v1`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (evidence stays immutable; the live stage is a projection, ENG-05), ADR-033 (a tutor
reply makes an attempt assisted), ADR-020 (readiness is a band), ADR-012 (versioned deterministic
readiness), `learning-attempt-events-table-design.md` (ENG-03, migration 0047)

## Why this exists

The engine plan grades what a student has shown in four stages — **estimated → retained →
demonstrated → transferred** — and fixes two rules the rest of the engine, and later the employer view
(EMP-13), rely on:

- **DEMONSTRATED requires unaided success on two different calendar days** (Asia/Kolkata).
- **A success after hint level 3 or higher is assisted and never counts toward DEMONSTRATED** (C5).

Master-plan scenario C3 adds a third: **a student with one attempt shows "not enough evidence", never
"developing"**.

None of this exists. ENG-00 found (ENGINE_BASELINE §2) that today's topic band
(`career-readiness-mastery-v1`) has no day rule, counts a lesson completion as 1/1 evidence, treats two
same-day attempts as enough, and that the readiness-check submit response carries an `outcomeBand`
computed from that single attempt, which can say `DEVELOPING`. ENG-03 built the fact these rules need —
`learning_attempt_events`, with `highest_hint_level` and `assisted` — but nothing reads it yet.

This goal adds the rules as a pure, versioned package, the two evidence columns D.1 names, and the
required-evidence-types column on career requirements.

## The rules — `packages/learning-model`, `learning-model-v1`

Pure and deterministic: no database, clock, randomness or network. Time is an argument. Identical
inputs give identical outputs, and the result does not depend on the order attempts are passed in
(they are sorted by `occurredAt`, then `id`). Unit and property tested.

### Input: a graded attempt on one skill

`{ id, itemId, context, correct, highestHintLevel, assisted?, tutorReplied?, occurredAt }` — the same
fields as a `learning_attempt_events` row. A lesson completion is **not** an attempt and is never an
input: reading a lesson shows nothing about whether the student can do the thing.

### Assisted

An attempt is assisted when its highest hint level is **3 or more**, when **any AI tutor reply** was
given on the item (ADR-033), or when it was recorded as assisted. The rule moves here from
`packages/persistence/src/learning-attempts.ts` (ENG-03 left a note that it would); persistence now
imports it, so the attempt log and the stage rules cannot disagree. The 0047 CHECK
(`highest_hint_level < 3 OR assisted`) stays as the data-layer guard.

An **unaided success** is a correct attempt that is not assisted. Only unaided successes move a stage.

### Calendar day

A day is the calendar date in **Asia/Kolkata**. India has kept UTC+05:30 without daylight saving since
1945, so the day is computed as a fixed offset — exact for every timestamp the product will hold, and
free of the host's timezone database. A unit test cross-checks it against `Intl` for the named zone.

### Stages

Attempts are folded in time order. Each attempt can move the stage **forward by at most one step**, and
nothing appended later moves it back:

| Stage | Reached when |
| --- | --- |
| `ESTIMATED` | The starting stage. Everything we hold is an estimate: no attempt, only wrong answers, only assisted successes. A placement estimate (ENG-14) will also sit here. |
| `RETAINED` | The first unaided success. The student has produced the skill without help at least once. |
| `DEMONSTRATED` | An unaided success on a **different calendar day** from an earlier unaided success. |
| `TRANSFERRED` | After DEMONSTRATED, an unaided success on an item the student has **never attempted before** on this skill, in a **context** (`PRACTICE`, `DIAGNOSTIC`, `ASSESSMENT`, `REVIEW`) in which they had **no earlier unaided success** on it. New problem, new setting. |

Consequences worth stating:

- Assisted successes and wrong answers never change the stage — adding any number of them anywhere in
  the history leaves it where it was (property-tested).
- Two unaided successes on one day reach `RETAINED`, never `DEMONSTRATED` (baseline defect (c), for the
  engine).
- A skill does not go back a stage because of a later wrong answer. The stage records what has been
  *shown*; how well it is held *now* is mastery (BKT, ENG-06) and when it needs review is scheduling
  (FSRS, ENG-09). *Rejected:* demoting on failure — it mixes two questions into one field and makes an
  employer-facing claim ("demonstrated") flicker with every practice mistake.
- The only way a stage goes backwards is a rebuild over fewer facts (privacy deletion removes attempts,
  ADR-034); the result is then exactly what the remaining facts support.
- **Today `TRANSFERRED` cannot be reached**: both writers record `ASSESSMENT` only, so there is no second
  context. That is the conservative outcome for a stage EMP-13 may one day show an employer, and it
  becomes reachable when graded practice (ENG-15) or placement (ENG-14) write attempts.

*Rejected for `RETAINED`:* "two unaided successes on one day". It makes a single later-day success jump
from `ESTIMATED` straight to `DEMONSTRATED`, so stages would skip, and a student who got it right once
would be told nothing about it.

### Evidence sufficiency and the skill band (C3)

A skill has **enough evidence** only when its graded attempts fall on **at least two calendar days**.
One attempt, or any number of attempts on the same day, is `NOT_ENOUGH_EVIDENCE`.

The engine's skill band, in the same vocabulary as `mastery_projections.band`:

| Band | When |
| --- | --- |
| `NOT_ENOUGH_EVIDENCE` | Fewer than two attempt days. **Always the answer for one attempt** (C3). |
| `DEMONSTRATED` | Enough evidence and stage `DEMONSTRATED` or `TRANSFERRED`. |
| `PROGRESSING` | Enough evidence and stage `RETAINED`. |
| `DEVELOPING` | Enough evidence and stage `ESTIMATED` (no unaided success yet). |

No numeric value is produced or displayed. The package returns counts (attempts, unaided successes,
days) for explanation, never a score, a percentage or a readiness value (ADR-020).

### Required evidence types for a career requirement

`checkRequiredEvidenceTypes(requiredTypes, evidence)` answers, for one requirement's topic: which of the
required evidence types the student holds, and which are missing. A type is satisfied only by
**unaided** evidence of that type for that topic that is not superseded — assisted evidence never
satisfies a requirement. An empty list requires nothing, which is what every existing requirement has.

The vocabulary is `evidence_records.evidence_type` (`LESSON_COMPLETION`, `ASSESSMENT_OUTCOME`,
`TOPIC_DEMONSTRATION`), so a requirement can only ask for evidence the product can record. A new kind of
evidence (a sandbox code submission, ENG-12) widens both CHECKs in one later migration.

## Columns added

### `evidence_records`

| Column | Notes |
| --- | --- |
| `assisted` | boolean NOT NULL DEFAULT false. True when any graded response behind the row was assisted. Fixed at insert. |
| `stage_at_capture` | text NOT NULL DEFAULT `'ESTIMATED'`, CHECK in the four stages. **The stage the student's skill had reached, including this evidence, at the moment it was recorded** — fixed at insert, never updated. |

**Immutability is untouched.** `evidence_records` rejects every `UPDATE` and `DELETE` (0004,
`reject_immutable_row_change`). Adding a column with a constant default is a catalogue change in
PostgreSQL 11+: it rewrites no row and fires no row trigger, so existing rows read the default and stay
valid. ADR-034 settled that the *live* stage of a skill is a projection (`learner_skill_state`, ENG-05);
these columns are facts about the moment of capture, which is what an immutable record can hold.

**Named `stage_at_capture`, not `stage`.** D.1 says evidence "gains … stage". A column called `stage` on
an immutable table invites exactly the misreading ADR-034 warns against — that it is where a skill's
stage lives and should move. The name says what it is.

**Defaults are the conservative ones.** No hints existed before ENG-15, so `assisted = false` is true
for every existing row, not merely convenient. `ESTIMATED` is the lowest stage: existing rows claim
nothing they cannot back. They are not back-filled — that would need an `UPDATE`, which the trigger
refuses and which would rewrite history.

**Who stamps them.** All three evidence writers, in the transaction that inserts the row, through one
helper (`skillStageAtCapture`) that reads the student's `learning_attempt_events` for the topic and runs
`learning-model-v1`:

| Writer | `assisted` | `stage_at_capture` |
| --- | --- | --- |
| Readiness check submit (`submitAssessmentAttempt`) | any assisted response for that topic (none today) | from the attempt log **after** this submission's attempts are written — the attempt write moves ahead of the evidence insert in the same transaction |
| Lesson completion (`completeLesson`) | false | the skill's stage from its attempts; a lesson adds nothing |
| Institution exam bridge (`recordExamResultEvidence`) | false (exams have no hints) | from attempts whose skill is the topic. Exam attempt rows carry `skill_id = NULL` (ENG-03: the subject→topic mapping is resolved by the projection, ENG-05), so today an exam contributes nothing to a stage. Conservative, and stated. |

### `career_role_requirements`

| Column | Notes |
| --- | --- |
| `required_evidence_types` | text[] NOT NULL DEFAULT `'{}'`. CHECK: no NULL element, every element in the `evidence_records.evidence_type` vocabulary. Empty = no type required. |

Existing requirements get the empty array and behave exactly as before. `computeCareerGap` does **not**
read the column yet: wiring it in would change the gap statuses students see, and no requirement sets
it until the catalogue editor (OPS-08) and the SOC Analyst target (ENG-11) exist. The check function is
ready for them. `seed-careers.ts` is unchanged — its inserts omit the column and get the default.

## Decision note — C3 and the live readiness path

**Context.** C3 fails in three places today (ENGINE_BASELINE §2): (a) the readiness-check submit
response and the `assessment.attempt.submitted` event carry `outcomeBand` computed from that one
attempt, which can be `DEVELOPING`; (b) a lesson completion plus one check attempt gives a topic two
evidence rows, so `career-readiness-mastery-v1` can band it `DEVELOPING`; (c) two same-day attempts
count as enough. The brief for this goal: do not change the readiness bands existing students see
unless the change is explicit, tested and documented; BKT and stage-based readiness replace nothing
until HG-5.

**Decision.**

1. **The engine meets C3** — `learning-model-v1`'s band is `NOT_ENOUGH_EVIDENCE` for one attempt and for
   same-day attempts, and a lesson completion is not an attempt. Unit tests name C3.
2. **`outcomeBand` is fixed in the live path**, because it is a band claimed from one attempt and
   nothing reads it: no web or Android screen, no API test, no outbox consumer (verified by search). It
   is now `NOT_ENOUGH_EVIDENCE` unless the student's submitted readiness-check attempts span at least two
   calendar days; otherwise the same ratio thresholds as before (0.8 / 0.6). The event's v1 schema widens
   its enum by `NOT_ENOUGH_EVIDENCE`; no value is removed. Exactly what changes: a student's **first**
   submitted check, and any further check on the **same day**, now report `NOT_ENOUGH_EVIDENCE` in this
   field instead of a ratio band. Nothing is stored from it and no screen shows it.
3. **`career-readiness-mastery-v1` and the readiness band are not changed.** Fixing (b) and (c) there
   would move bands students already see — every topic banded from a lesson completion plus one check,
   or from two same-day checks, would fall back to `NOT_ENOUGH_EVIDENCE` at the next recompute, and
   readiness with it. That is a new mastery algorithm (a new ID, ADR-034 §2) and a new readiness model
   version (ADR-020), and the engine's stage-based view replacing v1 is HG-5 (ENG-27). It is recorded
   below as a decision for Divakar with a recommendation, not taken silently.

**Rejected.** *Editing `career-readiness-mastery-v1` in place to add the day rule* — changes history's
meaning under an unchanged ID. *Publishing `career-readiness-mastery-v2` now* — changes what students
see without Divakar's decision. *Removing `outcomeBand`* — a contract removal from an event schema and a
response for no gain over making it honest.

**Consequences.** The live band still exhibits (b) and (c) until Divakar decides. `learner_skill_state`
(ENG-05) will hold the engine band beside it, so the difference becomes measurable (ENG-06's shadow
report) before anything is switched.

## The readiness model ID in code (ADR-034 §2)

ADR-034 gave ENG-04 the mismatch ENG-00 found: `calculateAdvisoryReadiness` returns the literal
`career-readiness-fundamentals-v1` while the database's active readiness model is **version 2** (0030;
the first-import path since PRG-FIX). Version 2 changed only the declared inputs (it admits institution
exam evidence); its algorithm is still `career-readiness-mastery-v1`. The snapshot has always been
stamped with the database's active version id, so no stored row is wrong — the literal in code is.

**Decision.** `career-readiness` exports `CAREER_READINESS_MODEL = { stableKey:
'career-readiness-fundamentals', version: 2, masteryAlgorithm: 'career-readiness-mastery-v1' }` and the
result literal becomes `career-readiness-fundamentals-v2`. A database test asserts that the active model
row after migrate-and-import has that stable key and version and names that mastery algorithm in its
policy, so the two cannot drift silently again. The pilot content package's source-record id
`career-readiness-fundamentals-v1` (`publishCareerReadinessPilot`) is a *content* identifier, not the
model, and stays.

*Rejected:* failing a readiness recompute at runtime when the versions differ — it would stop students
submitting work to report a bookkeeping mismatch. The test is the guard.

## Migration

`0050_evidence_stages_and_required_evidence.sql`: `ADD COLUMN IF NOT EXISTS`, and each CHECK dropped
`IF EXISTS` and re-added, so every replay leaves the same state (the migrator replays every file, in
order, untracked). It references only tables from 0004 and 0011, so its number is safe on a fresh
database (it runs before 0070/0071 and needs nothing from them).

## Readiness

Nothing here writes readiness. No engine code touches `readiness_snapshots` or `readiness_factors`; the
live band is computed exactly as before.

## Open points (decisions for Divakar)

1. **Adopt C3 in the live band?** Recommended: yes, as `career-readiness-mastery-v2` (lesson completions
   no longer count toward sufficiency; a topic needs graded attempts on two calendar days) under
   readiness model version 3 — but only after ENG-06's shadow report shows how many students' bands
   would move. Until then v1 stays.
2. **The definition of `TRANSFERRED`** (new item and new context after DEMONSTRATED) is this design's
   reading of the master plan. Recommended: keep it — it is strict, unreachable until a second context
   exists, and EMP-13 would show it to employers.
3. **Should assisted evidence be excluded from `career-readiness-mastery-v1`'s inputs?** None exists
   today. Recommended: the first writer of assisted evidence (ENG-15) does it under a new mastery ID.
