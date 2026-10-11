# Employer assessments — table design

What this is: the design for letting an employer send a screening test to the people who
applied to one of their roles. Written before the migration because a screening result
decides whether a named person stays in a hiring process, and because the most tempting
shortcut here — reusing the institution exam tables — would quietly break two promises the
product already makes.

Migration: `0036_employer_assessments.sql`.

## Why not reuse the institution engine

The institution assessment engine already does all of this: a governed question bank,
blueprint assembly, per-student frozen papers, answer keys that never leave the server,
submit-once scoring. Its tables are keyed on `institution_id`, which is a foreign key to
`organizations` — and an employer *is* an organization. Writing employer rows into those
tables would compile, run, and pass every existing constraint.

It would also be wrong, for two reasons.

**The column would lie.** Every reader of `exam_questions.institution_id` — today's code,
tomorrow's migration, the person debugging at 2am — reasonably assumes an institution. The
first query that joins those tables to `institution_relationships` or to a roster on that
assumption produces a cross-tenant leak that no constraint would catch, because the
constraint would have been satisfied.

**The two things are not the same thing.** An institution exam is assigned to an enrolled
student against a syllabus, and its outcome is evidence about what that person has
demonstrated. An employer screening test is sent to an *applicant* against a role, and its
outcome is an input to that employer's decision. Conflating them makes the second look like
the first.

Which leads to the rule this design exists to protect.

## An employer assessment result is never readiness evidence

Readiness is built from evidence an institution issued or ONE itself administered. If an
employer's screening test could write into `evidence_records`, then an employer would be
shaping the readiness band — indirectly, but really — and the band's central promise
(advisory, institution-and-ONE-sourced, never employer-driven) would be hollow.

So nothing in this migration references `evidence_records`, `readiness_snapshots`,
`taxonomy_nodes` or `mastery_projections`, and no route added for this feature writes to
them. The separation is structural in the sense that the tables simply do not reach each
other, and it is tested.

The mirror of that rule also holds: **a candidate's readiness band is not shown alongside
their screening result.** The employer sees what they measured, and nothing else.

## What is reused

`@planthepath/assessments` is pure and organisation-agnostic — question validation, the
duplicate hash, the deterministic shuffle, option remapping, grading and attempt
summaries. It is used unchanged. The expensive, subtle half of an assessment engine is
therefore shared, and what this migration adds is storage and an authorization boundary.

That is also why the employer engine inherits the integrity properties for free: a paper
frozen at start, an option order that differs per candidate, answer keys that exist only
server-side, and grading that cannot be influenced by what the client sends back.

## Tables

### `employer_assessment_questions`, `..._question_options`

An employer's own bank, with the same review ladder as an institution's —
`DRAFT → UNDER_REVIEW → APPROVED → REJECTED → ARCHIVED` — and the same rule that only an
`APPROVED` question can appear in a live assessment. A recruiter writing a question should
not be the only person who ever reads it.

Scoped by `employer_id`, with the same composite-key technique the institution bank uses:
`UNIQUE (id, employer_id)`, and every reference carrying `employer_id` through. One
employer's questions cannot be referenced by another employer's assessment — not
"forbidden", *inexpressible*, exactly as between two colleges.

The duplicate hash is kept, so the same question written twice is caught.

### `employer_assessments`, `employer_assessment_items`

The definition — title, duration, marks, lifecycle — and the ordered questions in it.

V1 selects questions explicitly rather than sampling from a blueprint pool. A blueprint
earns its place when a bank is large enough that sampling matters; an employer screening
for one role starts with neither. Per-candidate ordering is still randomised from the
attempt seed, so the integrity property that actually matters is not lost. The pool tables
can be added later without disturbing what is written here.

An assessment may be attached to an `opportunity_id`, which is how "send this to applicants
for that role" is expressed, and which also scopes who may be invited.

### `employer_assessment_invitations`

One row per application invited, carrying the window in which it may be taken.

**An invitation requires a live, consented application.** A candidate who withdrew, whose
consent was revoked, or who was already rejected cannot be sent a test — the employer's
access to that person ended with the application, and an invitation would be a way to
reach them after it did.

The state is `INVITED`, `STARTED`, `SUBMITTED` or `EXPIRED`. There is no `CANCELLED`:
withdrawing an invitation a candidate has already begun would discard work they have done.
An employer who changes their mind lets it expire.

### `employer_assessment_attempts`, `..._attempt_questions`, `..._answers`

The attempt, the exact question revisions frozen into it in their per-candidate order, and
the responses.

One attempt per invitation, enforced by a unique index. Submission is idempotent and a
submitted attempt cannot be rewritten — the same rule as an institution exam, and for the
same reason: a result somebody acts on must be the result that was produced.

The score, maximum and percentage are stored on the attempt at submission. They are
derived, but recomputing them later against an edited question would silently change a
number a hiring decision was already made on.

## What this design refuses to do

**No proctoring claims.** There are no screen events here. The institution engine records
them because an exam is invigilated and its result feeds a permanent record; a screening
test is a filter the employer chose. Recording tab-switches would imply a level of
supervision we would then have to defend.

**No automatic rejection.** A score does not move an application state. A human moves the
candidate, seeing the score. An engine that rejects people on a threshold is a different
product with a different set of obligations.

**No cross-employer question library.** The same wall as between institutions, for the same
reason: the bank is the employer's own work.

**Nothing is written to the candidate's record.** A screening result belongs to the
employer's process. It is not part of what the student has demonstrated, it does not appear
on their academic record, and their institution does not see it.

## Consequences

- An employer can screen at volume without leaving ONE, which is the table-stakes gap that
  a mid-size company would otherwise notice immediately.
- The candidate takes it inside the same account, with the same frozen-paper guarantees
  they get from an institution exam.
- Readiness is untouched, and provably so.
- The shared domain package now has two callers, which will keep it honest about staying
  organisation-agnostic.
