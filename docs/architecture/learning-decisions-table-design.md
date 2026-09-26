# Learning Decisions and Planner v1 — Table Design

**Status:** Adopted (ENG-08), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0053_learning_decisions.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (pure, versioned engine packages; no model in the decision loop; engine behavioural
data is erased on deletion), ADR-020 (readiness is a band), ADR-035 (migrations apply once),
`learner-skill-state-table-design.md` (ENG-05), `mastery-bkt-shadow-design.md` (ENG-06),
`review-scheduler-design.md` (ENG-09), `teaching-strategies-table-design.md` and
`misconception-codes-table-design.md` (ENG-07), `engine-consent-purposes-design.md` (ENG-01)

## Why this exists

The engine has to answer "what should this student do next, and why?" — one next action, with a teaching
strategy and the reasons for it. Two things make that answer trustworthy:

1. **It is rules, not a model.** Planner v1 (`packages/learning-orchestrator`, policy
   `learning-orchestrator-v1`) is a pure, deterministic function of explicit inputs: the career gap, the
   student's skill states, their due reviews, the published teaching strategies, faculty constraints, the
   adaptive-learning consent and the session time available. No clock, no randomness, no database, no model.
2. **Every decision can be replayed.** C4: "every next step shows a reason; replaying the same inputs from
   `learning_decisions` gives the same decision". So each decision is stored with the exact inputs it was
   computed from, a hash of them, the policy version and the output. A replay command recomputes it and
   compares. A faculty override (INST-16) is recorded in the same audit, so it is replayable too.

## The planner: `learning-orchestrator-v1`

### Inputs

| Input | Source (persistence loader) | Notes |
| --- | --- | --- |
| `adaptive` | `hasConsentPurpose(…, 'adaptive-learning')` at decision time | Fails closed (ENG-01). |
| `sessionMinutes` | the caller | Integer 1–600, or null when the student did not say. |
| `careerGap` | the student's PRIMARY live target and its current `career_gap_snapshots` / `career_gap_items` | Items carry topic, requirement level, status and priority rank only; `career-gap-v1` already orders them. Null when there is no primary target or no snapshot. |
| `skillStates` | `learner_skill_state` (adaptive only) for the skills the decision can touch: gap topics, due-review skills, constraint skills | Stage, band, counts, active codes. **`mastery_likelihood`, `mastery_uncertainty` and the FSRS numbers are not inputs** (below). |
| `skillStates[].misconceptions` | per active code, the number of **uncleared signals** — attempts that signalled it and have not been cleared by a later unaided correct answer on the same item | Computed from the attempt log by `learning-model`'s `unclearedMisconceptionSignals`, the same clearing rule that decides `active_misconception_codes` (one rule, one place); only codes the projection lists as active are kept, so the table stays the authority on *which* codes are active. |
| `skillStates[].latestHintLevel` | the highest hint level on the student's latest answered attempt on the skill | 0 when unknown. |
| `dueReviews` | `listDueReviews(db, subjectUserId)` (ENG-09: database `now()`, earliest due first) | Adaptive only. |
| `strategies` | `listPublishedTeachingStrategies(db)` — **PUBLISHED only** | Drafts never reach the planner. |
| `constraints` | faculty override and assignments (INST-16) | **No source exists yet**: INST-16 builds the faculty actions. The loader passes none; the planner and the table already carry them, so INST-16 only adds a loader. |

The planner **normalises** its input (every list sorted by a total order, codes de-duplicated) before
deciding, so input order never changes the result; the stored `inputs` are the normalised form.

### Why the BKT likelihood is not an input

ENG-06 put `mastery-bkt-v1` in **shadow**: it must not change what students see, and adopting it is HG-5
(ENG-27). A next step shown to a student is exactly "what students see", so planner v1 decides from the
evidence stage and band (`learning-model-v1`, already live), misconception signals, due reviews and the
career gap. The FSRS numbers (stability, difficulty) are not inputs either; only the due list is, which is
what ENG-09 designed the planner to read. *Rejected:* ranking by BKT likelihood — it would make an
unadopted model decide what a student is told.

### Output

| Field | Values |
| --- | --- |
| `action` | `REVIEW` (a due review), `REMEDIATE` (a short targeted item on the confused step, then back to the full problem), `PRACTICE` (the full skill), `LEARN` (a skill with no attempts yet), `FOLLOW_ASSIGNMENT` (faculty assignment), `NONE` (nothing to plan) |
| `skillId` | the skill acted on; null only for `NONE` |
| `focusMisconceptionCode` | the code being remediated; set exactly when `action = REMEDIATE` |
| `strategy` | `{ code, version, kind }` of a published strategy, or null |
| `reasonCodes` | 1–16 codes from a closed vocabulary, primary reason first — **never empty** (C4) |
| `override` | `{ byUserId, reasonCode }` when a faculty override decided the step, else null |

### The rules, in order

1. **Faculty override** (INST-16), if present: its action and skill, reason `FACULTY_OVERRIDE`. A person
   decided; the planner records it rather than second-guessing it.
2. **Candidates**, in priority order:
   1. **Due reviews first (C7)** — adaptive only; earliest due first, ties by skill id (the same order as
      `selectDueReviews`). Reason `DUE_REVIEW`.
   2. **Faculty assignments** — oldest first. Reason `FACULTY_ASSIGNMENT`.
   3. **Repeated misconceptions** — adaptive only: any not-MET gap topic with an active code signalled
      **at least twice** without being cleared, in gap order → `REMEDIATE` on that code (highest signal
      count, then code). Reason `REPEATED_MISCONCEPTION`. "Twice" is the meaning of *repeated*, not a tuned
      number; one slip does not label a student. This is scenario **X1**: after the third wrong boundary
      answer the planner is remediating; once enough of those signals are cleared by unaided correct
      answers on the same items, the count falls below two and the planner returns to `PRACTICE` on the
      full skill.
   4. **The career gap** — every not-MET item in `career-gap-v1` order → `LEARN` when the student has no
      attempts on the skill, else `PRACTICE`. Reasons: `GAP_UNKNOWN` / `GAP_MISSING` / `GAP_PARTIAL`, then
      `REQUIREMENT_ESSENTIAL` / `_IMPORTANT` / `_HELPFUL`.
3. **Session time.** Each action has a nominal length — `REVIEW` 5, `REMEDIATE` 10, `PRACTICE` 10,
   `FOLLOW_ASSIGNMENT` 10, `LEARN` 15 minutes. The first candidate that fits `sessionMinutes` is chosen;
   when an earlier candidate was passed over, `SHORTER_ACTION_FOR_SESSION` is added; when none fits, the
   first candidate is chosen with `SESSION_TIME_SHORT`. With no stated time, nothing is filtered. **These
   lengths are provisional policy parameters, not measurements** — no content in ONE carries a duration
   yet. They are part of `learning-orchestrator-v1`; changing them is a new policy version, and they are
   never shown to anyone. Because `REVIEW` is the shortest, session time never pushes a due review behind
   other work (C7 holds).
4. **Nothing to do.** No candidate → `NONE` with `NO_CAREER_TARGET` (no gap) or `ALL_REQUIREMENTS_MET`.
5. **Supporting reasons** for the chosen skill (adaptive only): `NEW_SKILL` (no attempts),
   `NOT_ENOUGH_EVIDENCE` (band, C3), `NEAR_MASTERY` (stage `RETAINED`: one more unaided day reaches
   DEMONSTRATED), `STUCK` (attempts on two or more days and no unaided success), `ACTIVE_MISCONCEPTION`.
6. **Strategy.** Published strategies, highest version per code, **excluding `requires_model`** (AI hold,
   ADR-030; X2: every journey works with AI off). The situation passed to `strategyApplies`
   (`teaching-strategy-applicability-v1`) is: mode (`REVIEW`→REVIEW, `LEARN`→LEARN, otherwise PRACTICE),
   the skill's stage, triggers (`NEW_SKILL`, `DUE_REVIEW`, `MISCONCEPTION_DETECTED`, `REPEATED_ERROR` at two
   uncleared signals, `STUCK`, `NEAR_MASTERY`), active codes, recent errors (the focus code's signal count
   when remediating, else the highest count) and the latest hint level. Ranking among the strategies that
   apply: one naming the focus code (or any active code) first; then the more specific (more rules
   present); then code. None applies → strategy null and `NO_APPLICABLE_STRATEGY` — the "non-strategy
   default, said plainly" that ENG-07 asked for. Thresholds such as `minRecentErrors` live in the reviewed
   strategy content, not in planner code.

### Without consent: the non-adaptive path (ENG-01)

`adaptive = false` means no personalised plan. The planner ignores skill states and due reviews
entirely (a property test proves the output does not depend on them) and the loader does not read them.
It still honours faculty constraints, and it walks the career gap in `career-gap-v1` order — the "next
actions" order the student is already shown today, which predates the engine and is not built from the
attempt-history profile. Every non-adaptive decision carries `NON_ADAPTIVE_NO_CONSENT` and no strategy
(a strategy is chosen from the student's skill state, which is exactly what consent gates).
*Rejected:* refusing to plan (an error) — ENG-01 says the fallback is the non-adaptive path, never an
error. *Rejected:* a fixed catalogue order ignoring the gap — it would tell a student to start a
requirement they have already met, a regression on today's behaviour.

## The table: `learning_decisions`

One row = one decision the planner made for one student. **Append-only.**

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `subject_user_id` | uuid NOT NULL → `users(id)`. |
| `institution_id` | uuid NULL → `organizations(id)`. The institution the student is actively rostered at when the decision is made (D.1's data rule); NULL for an independent learner. Set in SQL at insert. |
| `policy_version` | text NOT NULL, 1–64. `learning-orchestrator-v1`. |
| `adaptive` | boolean NOT NULL. Whether adaptive-learning consent was held. |
| `inputs` | jsonb NOT NULL, CHECK object. The normalised planner input, exactly. |
| `inputs_hash` | text NOT NULL, `^[0-9a-f]{64}$`. SHA-256 of the canonical JSON of `inputs` (keys sorted). Replay recomputes it and refuses a row whose inputs no longer hash to it. |
| `action` | text NOT NULL, CHECK in the six actions. |
| `skill_id` | uuid NULL → `taxonomy_nodes(id)`. CHECK: NULL exactly when `action = 'NONE'`. |
| `focus_misconception_code` | text NULL, code form. CHECK: NOT NULL exactly when `action = 'REMEDIATE'`. |
| `strategy_code`, `strategy_version` | text / integer NULL, both or neither, FK → `teaching_strategies(code, version)` (the 0049 unique key). The strategy is recorded by code and version, as ENG-07 designed. |
| `reason_codes` | text[] NOT NULL, 1–16 entries, each `^[A-Z][A-Z0-9_]{2,63}$`, no NULLs. |
| `outcome_attempt_ids` | uuid[] NOT NULL DEFAULT `'{}'`, ≤ 256, no NULLs. The attempts the student made acting on this decision — "linked outcome attempts". The **only** column that may change, and only by growing (below). |
| `override_by_user_id` | uuid NULL → `users(id)`. The faculty member whose override decided the step. |
| `override_reason_code` | text NULL, code form. CHECK: both override columns or neither; when set, `reason_codes` contains `FACULTY_OVERRIDE`. |
| `correlation_id` | text NOT NULL, 1–128. |
| `decided_at` | timestamptz NOT NULL DEFAULT `now()` — database time (the DB clock is the one every engine timestamp is ordered by). |

Indexes: `(subject_user_id, decided_at DESC)` for "the student's latest decision"; `(institution_id,
decided_at)` for INST-02-scoped reads (INST-15/16).

### Append-only, enforced

A trigger rejects `DELETE` unless the transaction-local `one.privacy_erase_subject` names the row's
subject (the privacy-deletion transaction, exactly as 0047 and 0052), and rejects any `UPDATE` except one
that leaves every column unchanged but `outcome_attempt_ids`, where the new array contains the old one
(`new @> old`). Same standing as the 0004 / 0047 / 0052 triggers: a guard against application mistakes.

*Why outcomes live on the row, not in a link table.* "Linked outcome attempts" is part of the decision's
audit record, and only ever grows; a second table would add a second append-only guard, a second privacy
deletion and a join for every replay, for one monotonic list. *Rejected:* making the whole row mutable —
the point of the table is that what the student was told cannot be rewritten. *Rejected:* a
`decision_id` on `learning_attempt_events` — that table's columns are fixed at insert by ENG-03, and an
attempt can be made without any decision.

`linkDecisionOutcomeAttempts(db, decisionId, attemptIds)` appends attempts that belong to the same subject
and happened at or after the decision. No caller exists yet: ENG-18 (the student learning experience) is
where a student acts on a decision.

## Replay (C4)

`replayLearningDecision(db, id)` loads the row, recomputes `inputs_hash` from `inputs` (a mismatch is
reported, not trusted), runs the planner of the stored `policy_version` on the stored inputs and compares
action, skill, focus code, strategy, reasons and override. CLI:
`corepack pnpm --filter @planthepath/persistence engine:replay-decisions [decision-id]` — prints counts
(checked, matched, mismatched, hash mismatches, unsupported policy) and exits non-zero on any mismatch.
A stored decision of a retired policy version reports `UNSUPPORTED_POLICY` rather than being replayed
under a different policy.

## Where it runs

`planNextLearningStep(db, { subjectUserId, sessionMinutes, correlationId })` in `packages/persistence`
loads the inputs, runs the planner, inserts the row and returns the decision, in one transaction. It is
rules over data already in the database — no model call, no network — so it may run in a request handler
when ENG-18 adds one. **No route calls it in this goal.**

## Student-facing surface: none in this goal

ENG-08's goal text builds the planner, the audit, golden tests and replay. ENG-18 ("Student learning
experience": "one next step with its reason (C4); due reviews first (C7)") owns the screens, on web and
Android, within the existing navigation (HG-3). Nothing here adds a route, a screen or a navigation item,
so neither client changes. When ENG-18 shows a decision it shows the action, the skill name and plain
text for the reason codes — never a number (no mastery likelihood, no FSRS values, no readiness).

## Consent withdrawal and privacy deletion

- **Withdrawal of adaptive-learning:** existing decisions are **kept** (recommended). A decision is a
  record of what the student was told, like the attempts ENG-03 keeps; faculty overrides in it must stay
  auditable (INST-16). New decisions are non-adaptive from the next request, because consent is read on
  every call. *Alternative (not taken):* delete adaptive decisions on withdrawal, as ENG-05 does for the
  projection — their `inputs` do hold a snapshot of the profile. Listed for Divakar below.
- **Privacy deletion:** ADR-034 — engine behavioural data is ERASED. The `LEARNING_ACTIVITY` transaction
  deletes the subject's decisions and adds the count to that record. No new deletion category.

## Readiness

Nothing here reads or writes `readiness_snapshots`, `readiness_factors` or `mastery_projections`. The
planner consumes the career gap's statuses and ranks, never its numbers, and produces no numeric value
of any kind about a student.

## Migration

`0053_learning_decisions.sql`: `CREATE TABLE IF NOT EXISTS`, each CHECK dropped `IF EXISTS` and re-added,
`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, indexes `IF NOT EXISTS` —
it applies once under the ADR-035 ledger, and still survives the replays of the integration-test pattern
and CI's bootstrap. It references only tables created before it (`users`, `organizations`,
`taxonomy_nodes`, `teaching_strategies`).

## Open points (decisions for Divakar)

1. **Decisions on withdrawal:** kept (recommended) vs deleted with the projection.
2. **Non-adaptive path:** the existing `career-gap-v1` order (recommended) vs a fixed catalogue order.
3. **Nominal action lengths** (5 / 10 / 10 / 10 / 15 minutes): provisional; revisit when content carries
   durations or pilot data exists.
4. **"Repeated" = two uncleared signals** for switching to remediation (recommended; X1 is satisfied by
   the third).
