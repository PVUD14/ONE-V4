# Campus Drive Nominations — Table Design

**Status:** Adopted (INST-14), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0080_campus_drive_nominations.sql` (number assigned by the coordinator; references only files ≤ 0077)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Many Indian campus drives run on a list: the placement office (TPO) picks the eligible students and
sends the list to the employer. In ONE that list must not bypass the student. Decision 10.2 #7 of the
institution plan: *placement-office nominations require each student's opt-in per drive.*

EMP-11 built drives (`campus_drives`, 0069): an employer's job reaches one college's students only
while that college has approved it, and applications made through a live drive are linked to it
(`campus_drive_applications`). EMP-06 built the eligibility evaluator, EMP-07 the consented
application snapshot written at apply, and EMP-SR-01 the applicant-access grant that every employer
read of a candidate checks. What is missing is a record of *the college putting a student forward*,
and the student's answer to it.

## The rule this table serves

1. A college may put a student forward to an employer only with that student's explicit, informed,
   revocable consent for that nomination.
2. **Nothing about the student reaches the employer before consent.** A nomination is a message from
   the college to its own student. It never creates an application, a snapshot or a grant; it is
   never read by any employer route. The employer learns of the student only when the student opts
   in, and then only through the ordinary apply path — the same snapshot, the same grant, the same
   eligibility and placement-policy checks as any applicant.
3. **Declining, or not answering, is never shown to the employer.** There is no employer-side read
   of this table at all, other than the `source` label on an application that already exists because
   the student opted in.
4. **The student sees who nominated them, to whom, and what would be shared** — the college, the
   nominator's role, the employer, the job, the drive, the college's note, and the exact snapshot
   preview (EMP-07) before they opt in.
5. **Revocable.** Before opting in the student can decline and later change their mind while the
   drive is live. After opting in, withdrawing the application (from the nomination or from
   Applications) withdraws the consent: the application closes and the employer's grant is revoked,
   exactly as a withdrawal already does (EMP-SR-01).

## Decision: one table, `campus_drive_nominations`; the application is the consent artefact

**Chosen.** One row per (drive, student) nomination. Opting in runs the existing apply transaction
with the nomination attached; the row then points at the application it produced. The application,
its snapshot and its grant remain the only things employers can read.

**Rejected: a nomination creates a DRAFT application the student later submits.** Drafts are
excluded from employer reads today, but a DRAFT row carries the employer's id and the student's id
in a table every employer query joins; one query that forgets `state <> 'DRAFT'` would leak the
list. It also makes "declined" a state of an application — an employer-side object.

**Rejected: nomination as a flag on `campus_drive_applications`.** That table is append-only and
means "this application came through this drive"; a nomination exists before, and often without,
any application.

**Rejected: an employer-visible "nominated list".** That is precisely the bypass the plan forbids.

**Rejected: a separate history table.** Every transition writes an `audit_events` row in the same
transaction (actor, from/to state, reason code); the row itself keeps `created_at`, `responded_at`
and the cancel fields. A history table would add a second append-only store to erase on deletion
without adding evidence the audit trail does not already hold.

**Rejected: an outbox event per transition.** No consumer needs it, and an event carrying a decline
would be a new path by which a decline could travel. The student's in-app notice is written after
commit, best-effort (as EMP-11 does), and carries no student data beyond their own.

## `campus_drive_nominations`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `campus_drive_id`, `opportunity_id` | FK `(campus_drive_id, opportunity_id)` → `campus_drives(id, opportunity_id)` (0069's unique index). |
| `institution_id` | FK `(campus_drive_id, institution_id)` → `campus_drives(id, institution_id)` (0073's unique index): the nominating college is the drive's college. |
| `student_user_id` | → `users(id)`. |
| `nominated_by_user_id` | → `users(id)`, the staff member who nominated. |
| `nominated_by_role` | text, CHECK in (`INSTITUTION_OWNER`, `INSTITUTION_ADMIN`, `PLACEMENT_ADMIN`): shown to the student as "who nominated you". Users carry no name in ONE, so the role and the college are the identity shown. |
| `reason_code` | CHECK `^[A-Z0-9_:-]{3,64}$`; the API accepts `MEETS_ELIGIBILITY`, `PLACEMENT_OFFICE_SHORTLIST`, `STUDENT_EXPRESSED_INTEREST`. |
| `note` | optional, 1–500 chars, the college's message to the student (never sent to the employer). |
| `state` | `INVITED` → `ACCEPTED` \| `DECLINED` \| `CANCELLED`; `DECLINED` → `ACCEPTED` \| `CANCELLED`; `ACCEPTED` → `WITHDRAWN`. |
| `application_id` | FK `(application_id, opportunity_id)` → `applications(id, opportunity_id)`; set exactly when `ACCEPTED` or `WITHDRAWN`. |
| `responded_at` | set by the student's first answer and every later one. |
| `cancelled_by_user_id`, `cancelled_at`, `cancel_reason_code` | set exactly when `CANCELLED` (the college withdraws a nomination the student has not accepted). |
| `revision` | ≥ 1, bumped on every **college** change; college writes name the revision they read (409 otherwise). A student's answer does not bump it, so the college cannot read an answer — or a decline — from the revision. |
| `created_at`, `updated_at` | |

Constraints and triggers:

- One live nomination per drive and student: partial unique index on `(campus_drive_id, student_user_id)`
  where `state <> 'CANCELLED'`. A cancelled nomination can be re-issued.
- `(state IN ('ACCEPTED','WITHDRAWN')) = (application_id IS NOT NULL)`.
- `state IN ('ACCEPTED','DECLINED','WITHDRAWN')` ⇒ `responded_at IS NOT NULL`.
- `(state = 'CANCELLED') = (cancelled_at, cancelled_by_user_id and cancel_reason_code all set)`.
- A guard trigger refuses any change to the identity columns (drive, job, college, student,
  nominator, role, reason, note, created_at), refuses any state change outside the edges above,
  refuses an `application_id` that belongs to another student, and refuses DELETE — except inside
  the transaction-local `one.privacy_erase_subject` setting for that student (the pattern 0060 and
  0068 use), which is how account deletion removes unaccepted nominations.
- Index `(institution_id, campus_drive_id, created_at, id)` for the college's list and
  `(student_user_id, created_at DESC)` for the student's.

"Closed" is not a stored state: an `INVITED` or `DECLINED` nomination whose drive is no longer live
(`APPROVED`/`SCHEDULED`) reads as `CLOSED` to both sides and cannot be accepted. Writing it would
need a job for every drive cancellation; deriving it is exact and cannot drift.

## Who may do what

| Actor | May |
| --- | --- |
| Owner, admin, placement admin **with an institution-wide write scope** (EMP-11's deciders) | Read candidates, nominate, cancel an unaccepted nomination. A write scope of NONE is `SCOPE_REQUIRED`; a narrowed scope is `INSTITUTION_WIDE_SCOPE_REQUIRED`, because a drive reaches the whole college. |
| Drive readers (the above plus department heads), within their INST-02 read scope | Read a drive's nominations and the suppressed summary. Faculty: 403. |
| The student | Read their own nominations, preview what would be shared, opt in, decline, withdraw. |
| The employer | Nothing in this table. An application created by opting in carries `source: PLACEMENT_OFFICE_NOMINATION` in the employer's applicant list. |

Writes lock the drive `FOR SHARE` (a drive cancellation takes it `FOR UPDATE`, so a nomination
either lands before the cancellation or sees it) and the nomination `FOR UPDATE`; they refuse unknown
fields; they write an `audit_events` row with the college as `organization_id` and the reason code in
the same transaction.

## Nominating: the eligible list

The candidate list is every current student of the college (active profile, active account, a live
relationship) inside the caller's scope, keyset-paginated by name (default 50, at most 200), each with:

- the EMP-06 evaluator's outcome for the job's **current version** — `ELIGIBLE`, `NOT_MET` or
  `UNKNOWN` (a blocking rule could not be decided). **Outcome only: no figures, no basis, no rule
  values.** The college learns only what the job's own published rules already imply;
- the college's own nomination state for that student on this drive, if any.

The list never says whether a student has already applied to the job, holds an offer, or would be
stopped by the one-offer policy: those facts come from applications the student may not have shared
with the college (INST-09). The one-offer check runs when the student opts in, and the student's
nomination card says beforehand if the policy would stop them (EMP-11's `blocksYou`).

Only `ELIGIBLE` students can be nominated. A nominate request names 1–200 students; each is created
or skipped with a code (`ALREADY_NOMINATED`, `NOT_ELIGIBLE`, `NOT_IN_SCOPE`). A student id that is
not a current student in scope is `NOT_IN_SCOPE`, whatever it is, so the response reveals nothing
about ids outside the college.

## What the college sees after nominating

Per student: `OPTED_IN`, `NOT_OPTED_IN`, `CANCELLED` or `CLOSED`. **`DECLINED` and "not answered yet"
are shown as the same `NOT_OPTED_IN`**, and a withdrawal after opting in also reads `NOT_OPTED_IN`.
Declining is recorded (row and audit) and the student sees it, but the college cannot single out a
decliner from someone who has not looked yet — the plan's "decline without penalty" made structural.
After opting in, the college follows the application only if the student shares it (INST-09); opting
in does not share it.

The summary (nominated, opted in, not opted in) goes through `suppressAggregateTable`: any cell under
five reads `<5`, with the complementary total suppressed too.

## What the student sees

`GET /students/me/nominations`: the college, the nominator's role, the reason, the note, the
employer, the job, the drive's dates and venue, the state (with `CLOSED` derived), whether the
college's one-offer policy would stop them, and whether they already have an open application for
the job. Before opting in they review the EMP-07 preview for that job (the same builder apply uses)
and must send its hash back: an opt-in without a reviewed snapshot is refused
(`NOMINATION_REVIEW_REQUIRED`). The opt-in screen says plainly that the college will see that they
opted in, and that sharing the application's progress with the college is a separate, optional choice.

## Privacy deletion and export

- Deletion: unaccepted nominations (`INVITED`, `DECLINED`, `CANCELLED`) are about the person only and
  are erased; accepted and withdrawn ones stay with the application they produced, which is
  anonymised under `APPLICATIONS`. They are counted under `APPLICATIONS` (no new deletion category,
  so `privacy_deletion_category_ck` is untouched).
- The student's own reads (`/students/me/nominations`) are the access route; nothing here is
  exported to an employer or in any college export.

## Open points (decisions for Divakar)

1. **Decline indistinguishable from no answer, for the college.** Recommended and built. The
   alternative (show "Declined") helps the TPO stop chasing but lets a decline be singled out.
2. **Nominator shown as role and college, not name.** ONE stores no staff names; if a name is wanted,
   it needs a staff display-name field first.
3. **No reminders or expiry dates** on nominations: a nomination closes with its drive.
4. **Re-opting in after a withdrawal** is not offered through the nomination (the student can still
   apply directly while the drive is live); the withdrawn nomination stays as the record.
5. **Direct applications while nominated** leave the nomination open; opting in then says "already
   applied" and the college's view stays `NOT_OPTED_IN`, because a direct application is not shared.
