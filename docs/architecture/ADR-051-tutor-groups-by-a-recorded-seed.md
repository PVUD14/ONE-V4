# ADR-051 — Tutor and no-tutor groups are assigned by a keyed hash over a recorded seed, and recorded

Records how ENG-25 splits a college's consenting students into a tutor group and a no-tutor group, and
how a college is let into the tutor pilot.

- **Status:** Accepted — 2026-10-10. Proposed with a recommendation and carried on per the repository's
  "ask once, recommend, carry on" rule.
- **Context:** ENG-25 (plan: "tutor and no-tutor groups assigned at random within consenting students …
  group assignment is reproducible and recorded"), ENG-22 (the tutor, sandbox-only), OPS-12 (the AI
  console and its evaluation gate), OPS-02 (dual control), ENG-28 (the pilot evaluation needs a comparison
  group). Design: `docs/architecture/tutor-rollout-design.md`.
- **Supersedes:** nothing. ENG-22's sandbox audience stays as it is.

## Decision

1. **Assignment is deterministic.** Each college's tutor experiment records, once, a server-generated
   128-bit seed, a method (`sha256-bucket-v1`) and a split (50 %). A student's group is
   `uint32(sha256(seed:experiment:student)[0..4]) mod 10000 < 5000 ? TUTOR : NO_TUTOR`. The database
   recomputes it on insert and refuses a row that disagrees.
2. **Assignment is recorded**, once per experiment and student, the first time the student is eligible
   (college switched on and `ai-tutoring` held); the row is immutable and only privacy deletion removes it.
   Only consenting students are assigned; withdrawing consent stops the tutor but keeps the row.
3. **A college is switched on only by dual control and only through the evaluation gate**: a new OPS-02
   action `AI_TUTOR_COLLEGE_ENABLE`, bound to the model, prompt and PASS evaluation, repeated by a trigger.
   Switching a college off is immediate. The global feature switch and kill switch still apply on top.
4. **The pilot is a deployment audience** (`ONE_AI_TUTOR_AUDIENCE=pilot`); the sandbox keeps ENG-22's
   behaviour, with no college gate or groups.
5. **Pilot metrics are aggregate counters** per experiment, group and day, with no student identifier.

## Rejected

- **Random draw at assignment time, stored.** Recorded but not reproducible; an auditor cannot verify the
  split was not chosen.
- **Alternating or blocked assignment by arrival.** Exactly balanced, but order-dependent and predictable.
- **An unseeded hash of the student id.** Reproducible, but correlates a student's group across colleges and
  across any later experiment.
- **Bulk assignment at switch-on.** Late joiners still need the lazy path; bulk assigns students who never
  practise.
- **Reusing `AI_FEATURE_ENABLE` for colleges.** Overloads one action with two targets across the approvals
  queue, the audit and the executing endpoint.
- **College gate in the sandbox too.** Hides the tutor from half the demo's fictional accounts; measures
  nothing.
- **Per-student event rows for metrics.** Duplicates the attempt log with personal data; the outcome
  analysis joins the assignment table to the existing records instead.

## Consequences

- A group can be verified by anyone holding the experiment row; changing the method or split is a new
  method version and a new migration, never an edit.
- Nothing reaches a real student until HG-6 publishes `ai-tutoring`, ENG-21's human review records a PASS,
  the deployment declares `pilot`, the feature is switched on and the college is switched on — five
  separate, recorded acts, three of them dual-controlled or human-reviewed.
