# Review Scheduler (FSRS) — Design

**Status:** Adopted (ENG-09), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** none. `learner_skill_state` (0052, ENG-05) already carries `review_stability`,
`review_difficulty`, `review_due_at` and `review_algorithm_version`, NULL until this goal, with a CHECK that
the three values appear only together with the algorithm that produced them. This goal fills them; the
table, its constraints and its write guard are unchanged.
**Rule:** Written before the code, per D.2 of the program (design first for anything a person's record
depends on)
**Builds on:** ADR-034 (pure, deterministic, versioned engine packages; projections rebuildable from
facts), `learner-skill-state-table-design.md` (ENG-05), `evidence-stages-table-design.md` (ENG-04, the
assisted rule and the Asia/Kolkata calendar day), ADR-020 (readiness is a band)

## Why this exists

A skill a student demonstrated three weeks ago may have faded. The planner (ENG-08) needs to know which
skills are **due for review** so that C7 holds: *a skill not practised for its due interval appears first
in the next session*. D.1 names the method — FSRS, through the maintained TypeScript implementation
`ts-fsrs` — and the place its state lives — `learner_skill_state`.

## The package: `packages/review-scheduler`

Algorithm ID **`review-scheduler-fsrs-v1`**. Pure (ADR-034): no database, no clock, no randomness, no
network. Time arrives only as attempt timestamps and an explicit `asOf`; identical inputs give identical
outputs regardless of input order.

### Dependency: `ts-fsrs`

| | |
| --- | --- |
| Package | `ts-fsrs`, open-spaced-repetition |
| Version | **5.4.2, pinned exactly** (no caret) — the latest stable release at adoption; 6.x is beta |
| Licence | **MIT** (read from the package's `LICENSE` and `package.json`) — permissive, compatible |
| Runtime dependencies | none |
| Algorithm | FSRS-6 (`FSRSVersion` = `v5.4.2 using FSRS-6.0`) |

It is used for the memory model only (stability, difficulty, interval). Every parameter is passed
explicitly rather than taken from the library's defaults, so a library upgrade cannot silently change a
schedule: a unit test compares our frozen parameters with the library's, and an upgrade that changes them
fails that test and forces a new algorithm ID.

### Parameters (part of `review-scheduler-fsrs-v1`)

| Parameter | Value | Why |
| --- | --- | --- |
| `w` | the FSRS-6 default weights shipped with ts-fsrs 5.4.2, copied and frozen | No ONE review history exists to fit weights from; the published defaults are fitted on a large public corpus. A later fit (ENG-13's offline job pattern) is a new algorithm ID. |
| `request_retention` | 0.9 | FSRS's default target: schedule the next review when recall probability falls to 90%. |
| `maximum_interval` | 36500 days | Library default; not an invented tuning number. It bounds stability's storage (`numeric(10,4)` fits). |
| `enable_fuzz` | **false** | Fuzz spreads due dates randomly; a projection must rebuild exactly (ENG-05). ts-fsrs's fuzz is seeded from card state, but disabling it removes the question entirely. |
| `enable_short_term` | **false** | Short-term learning steps schedule in minutes (1m, 10m). A skill review is a day-scale event; minute steps would make "due" flicker within a session. |

### What counts as one review: one skill, one calendar day

A student meets a skill many times in one sitting (a readiness check asks several questions on one topic).
FSRS models memory between days, not between questions a minute apart. So:

- **A review is one skill on one Asia/Kolkata calendar day** — the same day notion ENG-04 uses for C3 and
  DEMONSTRATED (`calendarDayInKolkata`).
- Every **answered** attempt that bears on the skill counts, resolved exactly as the skill-state projector
  resolves it (readiness items by their topic; published institution exam items by the topics their
  subject was mapped to when sat). Blanks bear on nothing, as in ENG-05.
- The day is passed to ts-fsrs as that day's midnight, shifted so that ts-fsrs's UTC day arithmetic counts
  Kolkata days; due dates come back as the **start of a Kolkata day** (`YYYY-MM-DDT00:00:00+05:30`).
  Scheduling by day, not by time of day, is what makes the monotonic property hold: two reviews minutes
  apart across midnight are still a day apart.

*Rejected:* one review per attempt — five questions in one check would be five "reviews" a second apart,
driving stability as if the student had revisited the skill five times. *Rejected:* one review per
session — sessions (`learning_sessions`) do not cover every attempt source (exam items), and two sessions
on one day would still be minutes apart. *Rejected:* rating from the first attempt of the day only — it
discards the rest of the day's evidence.

### The rating for a day, and the assisted rule

| The day's answered attempts on the skill | FSRS rating |
| --- | --- |
| every one an **unaided** success | `Good` |
| at least one unaided success, and at least one wrong or assisted | `Hard` |
| no unaided success (all wrong, or correct only with help) | `Again` |

- **An assisted success is not a successful review.** Consistent with ENG-04 (C5): a success at hint
  level 3 or higher, or with any tutor reply, or recorded `assisted`, uses `isAssistedAttempt` from
  `learning-model-v1` and is treated as a failure to recall. On a day with nothing else it rates `Again`
  (a lapse): the student could not retrieve the skill unaided, which is exactly what FSRS's `Again` means.
  *Rejected:* ignoring assisted attempts (no review that day) — the student did meet the skill and did not
  recall it; skipping the day would leave an overdue skill looking as if nobody had checked.
  *Rejected:* `Hard` — FSRS treats `Hard` as a pass and grows stability.
- **`Easy` is never used.** It needs a signal we do not have (response time, self-report). Inventing one
  would lengthen intervals without evidence.

### Stored values

For every `learner_skill_state` row with at least one answered attempt:

| Column | Value |
| --- | --- |
| `review_stability` | FSRS stability after the last review day, rounded to 4 decimals (fits `numeric(10,4)`; > 0 because ts-fsrs clamps at 0.001) |
| `review_difficulty` | FSRS difficulty (1–10), rounded to 4 decimals |
| `review_due_at` | start of the Kolkata due day |
| `review_algorithm_version` | `review-scheduler-fsrs-v1` |

A row with no answered attempts (a misconception-only row, ENG-05) has all four NULL — there is nothing
to review. The 0052 CHECK (all four NULL or none) holds by construction.

The fold is always recomputed from the first review day, never advanced from rounded stored values, so a
rebuild equals the incremental result exactly — ENG-05's acceptance extends to the review columns.

**`algorithm_version` stays `learner-skill-state-v1`.** The review rule has its own version column, which
is why 0052 has one: the stage and misconception rules are unchanged, so their ID is unchanged. A change
to the review rule is a new `review_algorithm_version`, and a rebuild restamps every row.

### Where it runs

The ENG-05 projector (outbox consumer, and the full rebuild command) calls
`projectLearnerSkillStatesWithReviews(attempts)` from this package instead of `projectLearnerSkillStates`:
the learning-model rows, with the review columns filled from the same attempts. One pure function per
student still produces the whole row set. Consent (`adaptive-learning`), the write guard, the per-student
lock and privacy deletion are untouched — no consent, no rows; erased facts, empty rebuild.

Nothing runs in a request handler, and no model is called (ADR-033).

## Due reviews feed the planner (C7)

`selectDueReviews(rows, asOf)` — pure — returns the skills whose `review_due_at ≤ asOf`, **earliest due
first** (the skill left longest past its interval first), ties by skill id. `asOf` is an explicit
argument.

`listDueReviews(db, subjectUserId)` in `packages/persistence` reads the student's review rows together
with the database's `now()` in one statement and applies `selectDueReviews` — the ordering rule lives in
one place, and no Node clock is compared against database time. It is the planner's input (ENG-08:
"inputs are … due reviews"); ENG-08 decides where reviews sit in a session. Until ENG-08 exists, C7 is
satisfied at the level this goal owns: a skill past its due interval is due, and it sorts ahead of every
skill due later.

*Rejected:* ordering by lowest current retrievability — it needs FSRS arithmetic at read time and gives
the same order as due date for skills with similar stability; ENG-08 can refine with a reason code.

## Student-facing surface: none

The goal text is "due reviews feed the planner". No screen shows stability, difficulty, a due date or a
due count, on web or Android. FSRS values are model state (ADR-034): never a score, never readiness,
never shown to an employer. ENG-18 (student learning experience) owns any "due for review" presentation;
if it adds one it must be a plain due / not-due list, never a number.

## Readiness

Nothing here reads or writes `readiness_snapshots`, `readiness_factors` or `mastery_projections`, and the
readiness path does not read the review columns.

## Tests

- Unit: day grouping and ratings (all-unaided `Good`, mixed `Hard`, assisted-only `Again`, blanks
  ignored, Kolkata midnight boundary), stored values within the 0052 CHECKs, frozen parameters equal the
  pinned library's, `selectDueReviews` ordering and the `asOf` boundary.
- Property (seeded generator, as ENG-04): **due dates are monotonic for successful reviews** (goal
  acceptance); determinism and input-order independence; an assisted success never yields a later due
  date than a wrong answer would; stability and difficulty within bounds.
- Database: the projector fills the review columns; rebuild reproduces them exactly; a skill left past
  its due day comes back first from `listDueReviews` (C7); a student without consent has no due reviews.

## Open points (decisions for Divakar)

1. **Rating rule** (all unaided `Good` / mixed `Hard` / none unaided `Again`, never `Easy`). Recommended
   as above; revisit when ENG-13 has real review data to fit weights.
2. **Assisted success = `Again`.** Recommended, consistent with C5.
