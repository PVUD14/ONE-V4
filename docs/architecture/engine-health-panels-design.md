# Adaptive Engine Health Panels — Design

**Status:** Adopted (OPS-13), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** none. Every panel reads tables that already exist; nothing is written, and no table,
column, constraint or trigger changes.
**Rule:** Written before the code (Appendix 1 §0.3 step 4, "each panel names its source table in its design
note").
**Builds on:** ADR-020 (readiness is a band), ADR-023 (screens become real under existing labels), ADR-032
(internal operator capabilities), ADR-034 (pure versioned engine packages; BKT is shadow; the sandbox is the
one always-on exception), `learning-decisions-table-design.md` (ENG-08), `learner-skill-state-table-design.md`
(ENG-05), `mastery-bkt-shadow-design.md` (ENG-06), `item-calibrations-table-design.md` (ENG-13),
`aggregate-suppression.ts` (the one small-cell rule), OPS-04 (System Health), OPS-12 (AI Operations).

## Why this exists

Operators must be able to see whether the learning engine is behaving without running the offline commands
(`engine:replay-decisions`, `engine:bkt-shadow-report`, `engine:calibration-import`) or opening a database.
OPS-13 asks for four panels: planner decisions per day and override rate; a mastery shadow comparison summary;
the last calibration run and its status; and sandbox availability with rejected-execution counts. Each is fed
only by a real table, shows NA in the same slot when there is no source, and carries no student-level detail.

## Precondition (checked)

The goal runs only when `learning_decisions`, `learner_skill_state` and the calibration output exist on the
base branch. They do: `0053_learning_decisions.sql`, `0052_learner_skill_state.sql` and
`0062_item_calibrations.sql` are all on `stack/batch29`.

## Where the panels live (no navigation change, HG-3)

| Panel | Screen (existing label) | Route | Capability |
| --- | --- | --- | --- |
| Planner decisions and override rate | AI Operations | `GET /api/v1/operations/ai/engine-health` | `AI_OPS_VIEW` |
| Mastery shadow comparison | AI Operations | same route | `AI_OPS_VIEW` |
| Last calibration run and status | System Health | `GET /api/v1/operations/jobs/engine-health` | `OPS_JOBS_REPLAY` |
| Code sandbox availability and rejections | System Health | same route | `OPS_JOBS_REPLAY` |

Appendix 1 §4.2 maps OPS-13 to AI Operations; the goal's Build line names both AI Operations and System
Health. The split follows what each panel is about: how the engine *decides* (planner, mastery model) sits with
the other model-behaviour figures under AI Operations; whether engine *jobs and infrastructure* run
(calibration job, sandbox VM) sits with background jobs under System Health. Each route is authorised by the
capability its screen already uses, so nobody gains a read they did not already have for that screen.

*Rejected: one route under AI Operations for all four.* An operator who works System Health (`OPS_JOBS_REPLAY`,
held by SECURITY_ADMIN too) watches the weekly job; making the calibration status depend on `AI_OPS_VIEW`
would hide a job's health from the person on call for jobs. *Rejected: a new capability.* Nothing here is a
new kind of access; §6.2's vocabulary already covers both reads.

## Panel 1 — Planner decisions per day and override rate

**Source table:** `learning_decisions` (0053). Columns read: `decided_at`, `subject_user_id` (only to count
distinct students inside SQL; never returned), `override_by_user_id` (only whether it is set), `policy_version`.

- A fixed window of whole UTC days ending today: 14 by default, or 7 or 30 (`days` query parameter; anything
  else is 400 `ENGINE_HEALTH_DAYS_INVALID`). Every day in the window is returned, a day with no decisions
  included, so there is no pagination: the list is bounded at 30 rows.
- Per day: the number of decisions, published only when that day's decisions came from **at least five
  distinct students**; otherwise the day shows `<5` (the primary rule — zero included, since "none" is also
  fewer than five).
- For the window: total decisions, overridden decisions (a row with `override_by_user_id` set, INST-16), and
  the override rate (overridden ÷ total).
  - The total is published only when the window's decisions came from at least five distinct students, **and**
    the students behind the suppressed days' decisions number zero or at least five together — otherwise the
    total minus the published days would reveal a small group's count (the complementary rule, as in
    `suppressAggregateTable`).
  - The overridden count is published only when the overridden decisions concern at least five distinct
    students; the rate only when both the total and the overridden count are published.
- Also shown, as non-personal operating facts: the policy versions that produced decisions in the window, and
  whether any decision was made in the window. *Not shown:* the time of the last decision (one timestamp can
  point at one student's session), any skill, action, reason or institution breakdown (each is a cut that can
  isolate small groups for no health decision it would support).

The suppression is a pure function in `packages/authorization/src/engine-health.ts`, unit-tested
(Appendix 1 D5).

## Panel 2 — Mastery shadow comparison summary

**Source tables:** `learner_skill_state` (0052; `evidence_band`, `attempt_day_count`, `mastery_likelihood`,
`algorithm_version`), `mastery_projections` (0004; the latest `career-readiness-mastery-v1` band per topic), and
the consent registry (`consent_definitions`, `user_consents`) through `consentPurposeHeldSql` — the one rule
`hasConsentPurpose` applies.

This is the aggregate part of ENG-06's shadow report, computed the same way:

- **Scope:** students who have `learner_skill_state` rows *and* hold `adaptive-learning` now (fail closed —
  rows left behind for someone who withdrew are not read). With no live definition of the purpose nobody is in
  scope.
- **Pairs** per (student, topic) with both a live band and an engine row, compared twice: C3 adoption (the
  engine's `learning-model-v1` band against the live band) and BKT (the band BKT *would* give, from
  `shadowBand` in `packages/mastery-bkt`, against the live band). The same pure `buildShadowReport` produces
  the counts, so the panel and the offline report cannot disagree.
- **Shown:** students in scope; pairs compared; unchanged; moved up; moved down; became / left
  "not enough evidence"; students with any change; engine rows on an older projector (rebuild needed); live
  pairs without an engine row; engine rows without a live band.
- **Not shown:** the from→to matrix, the next-attempt prediction (Brier score, accuracy, calibration bins),
  any likelihood, any band of any student, any topic or institution. Those stay in the offline report, which
  is where HG-5 is decided from.
- **Disclosure:** the whole panel is withheld while fewer than five consenting students are in scope (the
  report's own rule). Every count then passes the operations rule on top: a count under five — zero included —
  shows `<5`. This is stricter than the offline report (which prints an exact 0); an operations screen uses one
  rule everywhere.
- **Cost:** one set-based read (two queries), not the report's per-student loop, and no attempt-log read
  (predictions are not shown). No model is called — BKT is arithmetic in a pure package (ADR-033/034).

*Decision for Divakar — putting shadow counts on a route.* `mastery-bkt-shadow-design.md` placed the shadow
report in an offline command and rejected "an Operations read under an existing label", reasoning that "no
route … carries a BKT value or a BKT band". OPS-13, written later, asks for exactly this panel. Recommended and
taken: publish **aggregate counts only** under AI Operations. No BKT value or per-student band leaves the
server, so the ENG-06 rule's purpose (BKT never changes what anyone sees about a student and never reaches
readiness) is kept; readiness is not read, not written and not shown. The offline report remains the full
instrument. *Rejected: NA with "run the offline report"* — the goal would then not be met while the data
exists; *rejected: the full report on the route* — the matrix and prediction figures are analysis inputs for
HG-5, not operational health, and each extra cut is more to suppress.

## Panel 3 — Last calibration run and status

**Source tables:** `item_calibration_runs` and `item_calibrations` (0062).

- **Last run:** the most recently recorded run (`recorded_at`): algorithm, library, response threshold,
  when the export was taken, when the job fitted it, when it was imported; items read; items `CALIBRATED`
  and `PROVISIONAL` in that run, and the provisional reasons (`TOO_FEW_RESPONSES`, `NO_VARIANCE`,
  `TOO_FEW_ITEMS`, `ESTIMATE_OUT_OF_RANGE`). Items are not people, so item counts are exact.
- **Learners read** passes the people rule (`<5` under five). **Responses read** is published only when the
  learner count is, because it is those few people's activity.
- **Runs recorded** (all time).
- **Status**, derived in SQL against the database clock:
  - `NO_RUN` — no run was ever imported (NA in every run slot);
  - `CURRENT` — the last import is at most 8 days old;
  - `OVERDUE` — older than 8 days.

  The job is scheduled weekly (`deploy/systemd/planthepath-calibration.timer`, ENG-13); 8 days is one period
  plus a day's grace. *(2026-10-08, ENG-26: imports now happen only when a monthly recalibration is accepted;
  the expected interval is 31 days and `OVERDUE` starts after 38 — a month plus a week of review. See
  `recalibration-runs-table-design.md`.)* A failed job imports nothing, so a failure shows as the absence of a new run and becomes
  `OVERDUE` — the calibration job records no failure rows, and none are invented here.

## Panel 4 — Code sandbox availability and rejected executions

**Source table:** none exists. ENG-12 (the Piston sandbox on an isolated VM, ADR-034 §6) is not on the base
branch — there is no `deploy/sandbox`, no execution table and no health endpoint. The route returns
`{ state: 'NOT_BUILT', available: null, rejectedExecutions: null }` and the panel shows **NA** in both slots
with the reason. When ENG-12 lands with an execution log, this panel reads it; nothing here guesses.

## Rules kept

- No numeric readiness anywhere; readiness tables are not read (except `mastery_projections` bands, compared
  in aggregate, as the ENG-06 report does).
- No student-level data in any response: no user, topic, institution or item identifier, no name, no e-mail,
  no per-student timestamp. The integration test asserts no UUID and no e-mail appears in either response.
- Reads only: no audit row is written for a read (the same as every other operations summary read).
- No model call, no AI integration (ADR-030 hold).
- Android: the app's operations workspace is the view-only Overview (Appendix 1 §4.3: operators work on web);
  it has no AI Operations or System Health screen, so there is nothing to carry across.

## Open points (decisions for Divakar)

1. **Shadow counts on a route** — taken as above (aggregate counts only). Reverse by removing the section; the
   offline report is unaffected.
2. **Overdue after 8 days** — recommended for a weekly job; change the constant if the schedule changes.
3. **Override rate** — defined as overridden decisions ÷ all decisions in the window. Faculty overrides are
   recorded on the decision row (INST-16), so this is exact; there is no separate "planner step rejected by
   the student" signal to include.
