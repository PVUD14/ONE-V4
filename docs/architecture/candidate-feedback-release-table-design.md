# Candidate feedback release — table design

What this is: the design for letting an employer tell a rejected candidate *why*, and for
turning that answer into something the student can act on. Written before the migration
because a rejection reason attached to a named person is a record that person's prospects
depend on, and because the mistake this design most needs to avoid — leaking the
employer's private assessment — is cheap to prevent here and expensive to undo later.

Migration: `0035_candidate_feedback.sql`.

## The problem

A student applies, is rejected, and hears nothing. They repeat the same mistake across
forty applications because nobody ever told them what it was. This is true of ONE today
and of every competitor.

ONE is unusually well placed to fix it. `applications.rejection_reason_code` already
exists and is already written on every employer rejection, and every stage change is kept
in `application_state_history`. The employer is already doing the work of recording a
reason. The gap is that the reason is free text, it was never meant for the candidate's
eyes, and no route shows it to them.

The naive fix — show the student `rejection_reason_code` — is wrong and would be harmful.
That column holds whatever the recruiter typed for their own team. It may be blunt, it may
be about another candidate being stronger, it may contain wording no employer would choose
to say to someone's face. Exposing it retroactively would breach an expectation under
which it was written, and employers would respond by writing nothing useful in it ever
again.

## The decision

**One assessment, two visibilities, and the employer chooses the second one.**

What the employer records for their own decision stays exactly where it is —
`application_state_history.note` and `applications.rejection_reason_code` remain private
and are not touched by this design. Releasing feedback is a **separate, deliberate act**
that writes a new record. Nothing a recruiter wrote before this feature existed becomes
visible because of it.

The released feedback is drawn from a **controlled vocabulary**, not free text. Employers
pick from a catalogue of reasons phrased for a candidate to read, and may add an optional
note of their own. The vocabulary matters for three reasons: it makes the feedback
comparable across employers, so the student can see a pattern rather than an anecdote; it
lets each reason map to topics the student can actually study; and it removes the drafting
burden that would otherwise mean nobody releases anything.

## Tables

### `candidate_feedback_reasons`

The catalogue. Platform-owned, not per-employer — a shared vocabulary is the entire point,
and letting each employer invent codes would destroy the comparability the roadmap link
depends on.

- `code` — stable identifier, the primary key, `^[A-Z][A-Z0-9_]{2,63}$`.
- `student_label` — the wording the candidate reads. Written to be said to a person.
- `category` — grouping for display: `SKILL_GAP`, `EXPERIENCE`, `ROLE_FIT`,
  `PROCESS`, `COMPETITION`.
- `active` — retiring a reason must not rewrite feedback already released under it, so
  codes are deactivated rather than deleted.

`COMPETITION` exists deliberately. The most common honest answer is "someone else was
stronger", and a vocabulary that cannot express it forces employers to pick a reason that
implies a fault the candidate does not have.

### `candidate_feedback_reason_topics`

Maps a reason code to zero or more `taxonomy_nodes`. This is what turns feedback into a
next step: a released `SKILL_GAP` reason can point at the topics that close it.

Zero rows for a code is a legitimate state — `COMPETITION` maps to nothing, because
nothing the student does about themselves addresses it. Where no mapping exists the
student is shown the feedback and no suggestion, never an invented one.

### `application_feedback_releases`

One live release per application, superseding rather than overwriting.

- `application_id`, `employer_id` — with a composite foreign key against
  `applications(id, employer_id)`, so a release can never be attached to another
  employer's application.
- `released_by_user_id`, `released_at` — who chose to say this, and when.
- `note` — optional employer wording, ≤ 1000 characters, student-visible by definition.
- `superseded_at` — set when a later release replaces this one.

A partial unique index on `application_id WHERE superseded_at IS NULL` enforces exactly one
live release. History is kept: an employer who corrects a release leaves both rows behind,
which follows the same append-and-supersede rule the roadmap and evidence records use.

**Why supersede rather than allow withdrawal.** A release can be *corrected* but not
*retracted*. Once someone has been told why they were rejected, un-telling them is not a
state the product should be able to represent — it would let an employer erase a record the
candidate has already acted on. Correcting is honest; disappearing is not.

### `application_feedback_release_reasons`

The reason codes on a release, one row each, referencing the catalogue. A release carries
at least one — enforced in the write path, since a release with no reason and no note says
nothing.

## What the design refuses to do

**Feedback is only releasable on a rejected application.** The state must be `REJECTED`.
Feedback on a live application would become a back channel for negotiating, and feedback
after `HIRED` is a performance conversation, not this.

**No readiness band, ever.** Nothing here reads or writes `readiness_snapshots`. The
employer never sees the band, and the band is not altered by what an employer said. The
constraints in `readiness_snapshots` already make the first half impossible; this design
simply does not reach for it.

**The institution is not a party to this.** A released reason belongs to the student. It is
not added to any institution-facing view by this design. If a college should ever see
aggregate feedback patterns, that is a separate decision with its own consent question, and
it must not arrive as a side effect of this table.

**Releasing is optional and stays optional.** No employer is compelled, no default releases
anything, and no metric shames anyone into it. A mandatory feedback field produces
meaningless feedback.

## Consequences

- Employers gain a deliberate, low-effort way to close the loop, with full control over
  what is said and none of their internal notes exposed.
- Students stop applying into silence, and a released `SKILL_GAP` reason can be joined to
  the roadmap they already have.
- Because the vocabulary is shared, the platform can eventually show a student that three
  employers said the same thing — which is worth more than any single rejection.
- The private columns keep their original meaning, so nothing recorded under the old
  expectation is re-purposed.
