# ADR-049 — A sandbox code run is a graded attempt, not readiness evidence (yet)

Records how a code-sandbox result "becomes evidence" (master-plan scenario C8), where ADR-034 §6 left it
open ("results come back as rows that become evidence through the normal path").

- **Status:** Accepted — 2026-10-07. Proposed with a recommendation and carried on per the repository's
  "ask once, recommend, carry on" rule; Divakar can reverse it.
- **Context:** ADR-034 (§6 the sandbox, and the data rules), ADR-020 (readiness is an advisory band from
  a versioned model), `docs/architecture/evidence-stages-table-design.md` (ENG-04),
  `docs/architecture/code-sandbox-design.md` (ENG-12).

## The question

"Evidence" means two things in ONE today:

1. **The attempt log** (`learning_attempt_events`, ENG-03). Every graded response; the engine's stages
   (`learning-model-v1`: estimated → retained → demonstrated → transferred) and the skill-state projection
   (ENG-05) are computed from it.
2. **`evidence_records`** (0004). The rows the readiness band's mastery step reads — every row, of every
   type, for the student.

A code run could be written to either or both.

## Decision

1. A completed sandbox run is written **to the attempt log only**, through ENG-03's writer
   (`recordGradedAttemptSession`), in the transaction that records the result: item source `CODE_TASK`,
   source `code_submission`, context `PRACTICE`, correct when every test case passed, score = passed ÷ total,
   unaided. The skill-state projection is requested in the same transaction, so the run moves the skill's
   evidence stage exactly as a practice question does. That is C8's "its result becomes evidence".
2. It **does not write `evidence_records`**, and so does not move the readiness band.
3. Admitting code runs into readiness is a later, explicit change: a new `evidence_type` (the ENG-04
   design already reserves the widening), a readiness model version whose declared inputs include it
   (as 0030 did for institution exams), and Divakar's decision — after the shadow report (ENG-06) shows
   what it would do to bands.

## Why

- Readiness reads every `evidence_records` row. Writing code evidence there silently changes what the
  band considers under an unchanged model version — the thing ADR-020 and the exam bridge (0030, model
  version 2) were careful never to do.
- The attempt log is the engine's fact table: append-only, privacy-erasable, already feeding stages,
  skill state, the planner and (by consent) calibration. A code run is exactly a graded response.
- Nothing is lost: the attempt rows are the facts a later `evidence_records` writer (or a readiness model
  that reads stages) needs, so the decision can be reversed without re-running anything.

## Rejected

- **Write `evidence_records` (`TOPIC_DEMONSTRATION`) and recompute readiness.** Changes students' bands
  without a model version or a decision; and a single same-day pass would count as much as an exam.
- **A new `CODE_SUBMISSION` evidence type now, excluded from readiness by a filter.** Edits the readiness
  algorithm's inputs in place (a filter is an input change), and a row that nothing reads is not evidence.
- **Keep results only in the sandbox tables.** Then a passing program shows nothing about the skill — C8
  fails, and the engine's stages ignore real work.

## Consequences

- Code runs count toward a skill's stage (unaided pass → `RETAINED`; a pass on another calendar day →
  `DEMONSTRATED`) and toward the planner's view of the skill, but not toward the readiness band.
- The calibration export is restricted to the two question sources it calibrates; code tasks are not
  2PL items.
- EMP-12's employer coding items will write their own evidence into the employer assessment tables
  (ADR-039), not the attempt log — a different purpose with a different consent basis.
