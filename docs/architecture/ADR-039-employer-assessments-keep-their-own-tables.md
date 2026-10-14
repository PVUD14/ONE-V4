# ADR-039 — Employer Assessments Keep Their Own Tables; One Domain Engine, Two Stores

**Status:** Accepted by default under AGENTS.md ("ask once, recommend, carry on"); Divakar may override.
This departs from the plan's recommended answer to decision 10.2 #6 — see "Why not the plan's answer".
**Date:** 2026-09-29
**Goal:** EMP-12 (Appendix 2), item 1
**Relates to:** ADR-020 (readiness is a band and never reaches an employer), ADR-035 (migrations apply once)
**Design:** `docs/architecture/employer-assessment-table-design.md` (0036, unchanged) and
`docs/architecture/employer-assessment-windows-and-notices-design.md` (EMP-12 additions, 0074)

## Context

The plan was written on a baseline where the exam engine (0012) was institution-only and employers had
no assessments at all (defect D-9). It asked EMP-12 to choose between extending exam-engine ownership
with an owner column (the recommended answer to 10.2 #6: "one engine, two owners") and separate employer
tables that reuse question formats.

EMP-00 corrected D-9: employer assessments already exist on their own tables (0036), built from a
written design, with a bank, review ladder, publish, invitations, frozen per-candidate papers, grading
and results, and a web page. The shared rules — validation, duplicate hash, shuffles, option remapping,
grading, summaries — live in `@planthepath/assessments`, which both stores call unchanged.

## Decision

**Employer assessments stay on the 0036 tables.** "One engine" is kept at the level where it matters —
the pure domain package that decides what a valid question is, how a paper is frozen and how an answer
is graded — and the two owners keep separate stores. EMP-12 fills the gaps on those tables (stage rule,
windows and time limits on the database clock, audit and reason codes, locking, the candidate's brief and
acknowledgement, per-candidate results through the live grant, the invitation notice) and adds no
ownership column anywhere.

## Why not the plan's answer (rejected: an owner column on 0012)

- **It would reverse a working, designed boundary.** 0036's composite keys make an employer question
  inexpressible in another employer's assessment and in any institution exam. Putting employers into
  `exam_*` means relaxing `institution_id NOT NULL` (or letting it hold an employer), and every existing
  query that joins `exam_*.institution_id` to rosters, units and scopes would silently start matching
  employer rows. The 0036 design names this exact failure.
- **It would move live data through a migration for no product gain.** Every employer question,
  assessment, invitation and attempt would be copied into different tables with different constraints,
  and a hiring decision already made on a stored score would rest on a re-keyed row.
- **The institution tables carry things an employer test must not have.** Exam results bridge into
  readiness evidence (`recordExamResultEvidence`) and the attempt log; focus-loss screen events imply
  supervision. The employer store has none of these, by construction. Sharing the tables would make the
  separation a matter of `WHERE owner_kind = …` in every future query instead of a fact of the schema.

## Also rejected

- **A third, merged "assessment" schema both owners migrate to.** The same data move twice over, with
  the readiness bridge still to be fenced off by convention.
- **Letting employers pick questions from an institution bank (or the reverse).** The acceptance
  criterion is the opposite: employers cannot see or reuse institution question banks. The walls are
  tested both ways at the API and the database.

## Consequences

- The institution engine's features (blueprint pools, negative marks, fill-in and match types) are not
  automatically available to employers; each is added to the employer store deliberately, if asked for.
- Coding questions wait for the code sandbox on the base branch (none exists at 2026-09-29); until then
  no coding type is offered to employers. `CODE_OUTPUT_MCQ` is an objective multiple-choice question and
  needs no sandbox.
- Employer screening results never become readiness or learning evidence. The student opt-in the plan
  allows (10.2 #12) is not built: building it would be the first path by which an employer's own
  questions reach a student's record, and it needs Divakar's decision on how such evidence is labelled
  and weighed. Until then results stay inside the application, which satisfies 10.2 #12.
