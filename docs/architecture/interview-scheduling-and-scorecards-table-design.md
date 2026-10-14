# Interview Schedule Revisions and Scorecard Templates — Table Design

**Status:** Adopted (EMP-09), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0063_interview_scheduling_and_scorecards.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Recruiters can schedule an interview, and move it with `POST …/interviews/:id/state`, but:

- **A reschedule overwrites the old time.** `interviews` holds one `scheduled_start`; nothing records
  when it was, who moved it or why. A student who says "you moved me twice" cannot be answered, and a
  calendar invite cannot carry a sequence number without knowing how many times the event changed.
- **There is no reason for a reschedule or a cancellation**, only an optional free-text
  `cancellation_reason` that nothing reads. Appendix 2 §5.7 wants a reason code on every consequential
  write.
- **Scorecards are free text.** `interview_outcomes` has a recommendation, an optional overall rating
  and three text boxes. Two interviewers on the same stage can judge completely different things, so
  their scorecards cannot be read side by side. EMP-09 asks for scorecard templates per stage
  (criteria and guidance) and outcomes recorded against the template.

A reschedule history and a scorecard are records a candidate's hiring decision rests on, so both get a
design before the migration.

## Decision 1: an append-only revision per schedule change

**Chosen.** `interview_schedule_revisions` holds one row for every change to an interview's schedule
or state, written in the same transaction as the change: the interview as it stood *after* the change
(mode, start, end, location, link), the change kind, the reason code, an internal note, the actor and
the database time. Revision numbers count from 1 per interview. A trigger refuses UPDATE and DELETE.

- A calendar invite's `SEQUENCE` is `revision_number - 1`, so every reschedule supersedes the previous
  invite in the recipient's calendar, and the `.ics` for one event is always built from the revision
  that event names — replaying the event rebuilds the identical file.
- The outbox events `interview.scheduled` and `interview.state_changed` gain an optional `revisionId`,
  so the consumer knows exactly which revision it is telling people about.
- Interviews that exist before 0063 get one `BASELINE` revision: "this is how it stood when history
  began". It is not called `SCHEDULED` because an interview created earlier may already have been moved,
  and the history must not claim otherwise.

**Rejected: columns on `interviews` (`previous_start`, `reschedule_count`).** They keep one step of
history and lose the rest; the second reschedule erases the first.

**Rejected: reading history out of `audit_events`.** Audit rows record that something happened, not the
schedule it produced, and they are not a product surface — the web and phone would be parsing audit
JSON to show a student's interview history.

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `interview_id`, `employer_id` | Composite FK → `interviews(id, employer_id)`: a revision can never belong to another employer's interview |
| `revision_number` | ≥ 1, unique per interview |
| `change_kind` | `BASELINE`, `SCHEDULED`, `RESCHEDULED`, `CANCELLED`, `COMPLETED`, `NO_SHOW` |
| `mode`, `scheduled_start`, `scheduled_end`, `location_detail`, `joining_link` | The interview after the change; same CHECKs as `interviews` (https-only link, 512 / 500 characters) |
| `reason_code` | `^[A-Z0-9_:-]{3,64}$`; required (CHECK) for `RESCHEDULED` and `CANCELLED` |
| `note` | Internal, ≤ 1000 characters, never shown to the candidate, no spreadsheet-formula prefix |
| `actor_user_id` | → `users(id)` |
| `recorded_at` | `now()` — the database clock, never Node's |

Reason codes are fixed lists in `packages/hiring` (not a CHECK, so a new code needs no migration):

- Reschedule: `CANDIDATE_REQUESTED`, `INTERVIEWER_UNAVAILABLE`, `SCHEDULING_CONFLICT`,
  `LOGISTICS_CHANGED`, `TECHNICAL_ISSUE`.
- Cancel: `CANDIDATE_REQUESTED`, `CANDIDATE_WITHDREW`, `INTERVIEWER_UNAVAILABLE`, `POSITION_FILLED`,
  `PROCESS_CHANGED`, `SCHEDULED_IN_ERROR`.

The candidate is told *that* the interview moved or was cancelled, never the reason code or the note
(the EMP-08 rule for every hiring notice).

## Decision 2: scorecard templates owned by the employer, bound to a job's stage

**Chosen.**

- `interview_scorecard_templates` — an employer's named template with optional guidance. Immutable
  once written except for retiring it (a trigger allows only `retired_at` / `retired_by_user_id` to go
  from NULL to set). Changing a template means creating a new one, so a scorecard always points at the
  exact criteria its interviewer saw.
- `interview_scorecard_criteria` — 1 to 12 ordered criteria (label, guidance) per template. Immutable;
  a trigger refuses UPDATE and DELETE, and refuses an INSERT once the template is used by a stage, an
  interview or an outcome.
- `opportunity_selection_stages.scorecard_template_id` — which template an `INTERVIEW` or
  `GROUP_DISCUSSION` stage uses. Stages already belong to a job version (EMP-06), so choosing or
  changing a stage's template goes through the existing versioning path like every other job edit, is
  carried forward to the next version, and appears in the version's `stages_signature`. A trigger
  refuses a template from another employer or on any other stage kind.
- `interviews.scorecard_template_id` — the template copied from the stage when the interview is
  scheduled against that stage (`selectionStageId`, which the table has had since 0007 and nothing set).
  A composite FK `(scorecard_template_id, employer_id)` makes a cross-employer template structurally
  impossible, and a trigger refuses changing it after insert: an interview's scorecard cannot be swapped
  under the people filling it in.
- `interview_outcomes.scorecard_template_id` and `interview_outcome_criterion_ratings` — the outcome
  records the template it followed; each criterion gets a 1–5 rating and an optional note. Composite
  FKs tie each rating to a criterion of the outcome's own template, and the outcome's template to the
  interview's, so a rating against another template's criterion cannot be stored.

The API requires every criterion of the interview's template to be rated exactly once when the
interview has one, and refuses criteria when it has none. Correcting a scorecard (the existing upsert)
replaces its ratings in the same transaction.

**No aggregate.** Nothing sums, averages or ranks criterion ratings. Appendix 2 §5.3 forbids any single
aggregate "fit" number for employers, and §0.5 forbids automated ranking; the ratings are shown per
criterion, per interviewer, next to the recommendation a person made.

**Rejected: criteria as a JSON array on the template.** The rating could not reference a criterion by
key with a foreign key, and a later edit to the JSON would silently re-label old ratings.

**Rejected: templates keyed by stage kind across the employer ("every INTERVIEW stage uses X").** Two
jobs' technical rounds rarely want the same criteria, and the stage already has an owner and a version.

**Rejected: templates owned by the job version itself.** Every new version would have to copy the
template and its criteria, and scorecards from version 1 and version 2 of the same job would point at
different templates with identical text.

## Calendar invites (.ics)

Built by a pure function in `packages/hiring` (RFC 5545: CRLF line ends, folding at 75 octets, text
escaping, UTC times, a stable `UID` derived by hashing the interview id so the id itself never leaves
ONE, `SEQUENCE` from the revision). `METHOD:PUBLISH`, with `STATUS:CANCELLED` for a cancellation:
`METHOD:REQUEST`/`CANCEL` require an `ORGANIZER` mailbox that receives replies, and ONE has no sending
domain until hard gate HG-7 is decided. Google Calendar, Outlook and Apple Calendar all import a
`PUBLISH` event and update it when a higher `SEQUENCE` with the same `UID` arrives.

- **Attached to interview emails** (student and panel) by the outbox consumer, never from a request
  handler. The emailed file carries the time, mode, job and employer, but **not** the joining link or
  the location: EMP-08 kept those out of email on purpose, and an attachment is still email.
- **Downloadable inside ONE** by the student (their own interview, while it is ahead, or cancelled) and
  by an assigned panellist; this file carries the joining link and location, because the person is
  authenticated and allowed to see them. A panellist's file omits them once the candidate's grant ends,
  exactly as the brief does.
- With no mail sender configured (HG-7) the emails stay `NOT_CONFIGURED`; the download is how an
  invite reaches a calendar today. No calendar provider is integrated and none needs credentials.

## Who sees the joining link

The student (their own interview, while it is ahead), the interview's active participants (while the
candidate's grant is live — unchanged from EMP-SR-01), and the member who scheduled it. Other employer
members see that a link exists but not the link. It must be `https://`, with a host and without
embedded credentials.

## Open points (decisions for Divakar)

1. **The scheduler sees the link.** Recommended and taken: the member who scheduled an interview keeps
   seeing its link (they wrote it and may need to correct it); other non-participant members do not.
2. **Emailed invites carry no link or location.** Recommended and taken, following EMP-08. If Divakar
   wants a one-tap join from the email, it is one flag in the consumer.
3. **Reason codes are fixed lists**, listed above. An `OTHER` code was not added: a reason that fits
   none of these goes in the internal note with the closest code.
4. **Rescheduling into the past is refused** (`SCHEDULE_IN_PAST`, judged on the database clock).
   Scheduling a new interview in the past is still allowed, as before, so a recruiter can record an
   interview that already happened.
