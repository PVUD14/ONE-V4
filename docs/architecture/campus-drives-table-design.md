# Campus Drives and Placement Policies — Table Design

**Status:** Adopted (EMP-11), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0069_campus_drives.sql`
**Decision record:** ADR-038 (a campus drive is an opportunity published to one institution through that
institution's approval)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Indian campus hiring runs through the college placement office: an employer asks for a drive, the
placement officer approves it and circulates it to the college's students, the college's placement
rules (typically "one offer per student") govern who may sit it, and results come back to the college.
ONE has no drive concept. An employer can already point a job at a college with an `INSTITUTION`
audience row (0007), but that row goes live the moment the employer writes it — the college is never
asked and never told — and nothing records that an application came through the college.

Drives carry consequences for three parties, which is why this document exists before the migration:

- **Who may apply.** A drive widens a job's audience to a college's students, and a college policy can
  refuse a student at apply time. Both must be decided by the college, recorded and explainable to the
  student.
- **What the college sees.** Drive results are information about named students. The college may see
  only what each student chose to share (0017, ADR-019) and suppressed counts otherwise.
- **What the employer sees.** Nothing new about candidates: the drive does not create, widen or extend
  any applicant-access grant. Candidate data still flows only through the live grant written at apply.

## Decision summary

Four tables, all new, nothing existing altered:

| Table | What a row is | Mutability |
|---|---|---|
| `campus_drives` | One employer's request to run one job at one college, and its state | Updated only through the state machine below, with a revision counter |
| `campus_drive_state_history` | One state change of a drive: who, which side, why | Append-only (trigger refuses UPDATE and DELETE) |
| `campus_drive_applications` | "This application came through this drive" | Append-only |
| `institution_placement_policies` | One placement rule a college has in force | Immutable except retiring |

## `campus_drives`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `employer_id` | uuid NOT NULL → organizations | Composite FK `(opportunity_id, employer_id)` → `opportunities(id, employer_id)`, so a drive can never name another employer's job |
| `opportunity_id` | uuid NOT NULL | The job the drive runs. The drive has no job text of its own |
| `institution_id` | uuid NOT NULL → organizations | The one college; `<> employer_id` |
| `requested_by_user_id` | uuid NOT NULL → users | The recruiter, admin or owner who asked |
| `state` | text | `REQUESTED`, `CHANGES_REQUESTED`, `APPROVED`, `SCHEDULED`, `REJECTED`, `COMPLETED`, `CANCELLED` |
| `proposed_start_at`, `proposed_end_at` | timestamptz NULL | What the employer proposes; end after start |
| `scheduled_start_at`, `scheduled_end_at` | timestamptz NULL | What the college confirmed; `SCHEDULED` requires a start |
| `venue_mode` | text NULL | `ON_CAMPUS`, `VIRTUAL`, `OFF_CAMPUS` |
| `employer_note` | text NULL, ≤ 1000 | The employer's message to the placement office |
| `offer_holders_eligible` | boolean NOT NULL DEFAULT false | The college's per-drive exception to its one-offer policy (the "tier exception", e.g. a dream-company drive). Only the college sets it |
| `decided_by_user_id`, `decided_at`, `decision_reason_code`, `decision_note` | NULL | The college's latest decision, shown to the employer |
| `closed_by_user_id`, `closed_at`, `close_reason_code` | NULL | Who cancelled or completed it, and why |
| `revision` | integer NOT NULL DEFAULT 1 | Incremented by every change; every write names the revision it read (409 otherwise) |
| `created_at`, `updated_at` | timestamptz | |

Constraints: reason codes match `^[A-Z0-9_:-]{3,64}$`; a decision is recorded for every state the
college produced (`APPROVED`, `SCHEDULED`, `REJECTED`, `CHANGES_REQUESTED`); `REJECTED` and
`CHANGES_REQUESTED` carry a reason code; `CANCELLED` carries a reason code and `closed_at`; `COMPLETED`
carries `closed_at`. A partial unique index allows **one live drive per job and college** (`REQUESTED`,
`CHANGES_REQUESTED`, `APPROVED`, `SCHEDULED`); after a rejection, cancellation or completion a new
request may be made. `UNIQUE (id, opportunity_id)` supports the composite FK below.

That the employer is an `EMPLOYER` organisation and the institution an `INSTITUTION` is checked by the
request route, which also requires the college to be verified and active; the kind of an organisation
never changes, so a trigger would add nothing the route does not already guarantee.

### State machine

```
            employer                college                   either side
REQUESTED ──────────────► (CANCELLED)
REQUESTED ─────────────────────────► APPROVED | SCHEDULED | REJECTED | CHANGES_REQUESTED
CHANGES_REQUESTED ─ resubmit ──────► REQUESTED          (employer may also cancel)
APPROVED ─ schedule (college) ─────► SCHEDULED
SCHEDULED ─ reschedule (college) ──► SCHEDULED
APPROVED | SCHEDULED ──────────────────────────────────► COMPLETED | CANCELLED
```

`REJECTED`, `COMPLETED` and `CANCELLED` are terminal. The college approves with or without a
schedule; approving with one goes straight to `SCHEDULED`. Only the college moves a drive into
`APPROVED` or `SCHEDULED` — **there is no path by which the employer makes a drive live.** The pure
rules (transitions per side, reason-code lists) live in `packages/hiring/src/campus-drives.ts`.

### Why the plan's state list gained `CHANGES_REQUESTED`

The goal lists REQUESTED / APPROVED / REJECTED / SCHEDULED / COMPLETED / CANCELLED and also asks for
"approve, reject or request changes". A change request kept in `REQUESTED` would be invisible in the
state — the employer's list could not tell "waiting on the college" from "waiting on you". A distinct
state costs one CHECK value.

## How a drive reaches students

A job is shown to a student when it is `PUBLISHED`, before its deadline, from an employer in good
standing, and either an audience row matches the student (unchanged) **or** a drive for that job is
`APPROVED` or `SCHEDULED` at a college the student has a current relationship with. Approval is
therefore what makes the college audience live, and cancelling or completing the drive takes it away
on the next request; nothing is written to `opportunity_audiences`.

**Rejected: approval inserts an `INSTITUTION` audience row.** The row would have to be deleted again on
cancellation, and `opportunity_audiences` does not say who wrote a row, so a cancellation could delete an
audience the employer had set directly, or leave a drive's audience behind. Deriving visibility from the
drive's state has no second copy to drift.

**Rejected: a drive as a separate job object** (its own title, terms and applications). It would fork
versioning, eligibility, snapshots, grants and notifications — everything EMP-05 to EMP-09 built on the
opportunity. A drive is a way a job reaches a college, not a second job (ADR-038).

**Rejected: drives without approval** (the employer picks colleges and the job goes live). That is
what the `INSTITUTION` audience already does, and it is exactly what placement offices object to.

Publishing and reopening a job require an audience; a job whose only route to students is a drive in a
live or pending state (`REQUESTED`, `CHANGES_REQUESTED`, `APPROVED`, `SCHEDULED`) now counts as having
one. A published drive-only job whose drive is still awaiting approval reaches nobody until the college
approves, and the employer's screen says so.

## `campus_drive_applications`

| Column | Type | Notes |
|---|---|---|
| `campus_drive_id` | uuid | Composite FK `(campus_drive_id, opportunity_id)` → `campus_drives(id, opportunity_id)` |
| `application_id` | uuid | Composite FK `(application_id, opportunity_id)` → `applications(id, opportunity_id)` |
| `opportunity_id` | uuid NOT NULL | Carried only so both composite FKs can prove the drive and the application are for the same job |
| `placement_policy_id` | uuid NULL → institution_placement_policies | The policy that was checked and passed at apply, if any |
| `created_at` | timestamptz | |

PK `(campus_drive_id, application_id)`. Written in the apply transaction whenever the student applies to
a job that has a live drive at a college they currently belong to — whether they found the job through
the drive or through a public audience. **The college's process governs its drive whichever door the
student used**; otherwise a one-offer policy could be sidestepped by applying through the public
listing. Append-only (trigger).

**Rejected: a `campus_drive_id` column on `applications`.** `applications` carries the hiring state
machine and its CHECKs; a student who belongs to two colleges with live drives for the same job (rare,
but possible across a transfer window) would need two values. A link table keeps `applications`
untouched and handles both.

## `institution_placement_policies`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `institution_id` | uuid NOT NULL → organizations | |
| `policy_type` | text | `ONE_OFFER_PER_STUDENT` (the only type today; the CHECK widens by migration when a college needs another) |
| `allow_drive_exceptions` | boolean NOT NULL DEFAULT false | Whether a drive the college marks `offer_holders_eligible` is exempt |
| `effective_from` | timestamptz NOT NULL | Defaults to now() at creation |
| `effective_to` | timestamptz NULL | After `effective_from` |
| `state` | text | `ACTIVE`, `RETIRED` |
| `note` | text NULL, ≤ 500 | The college's wording, shown to students beside the rule |
| `set_by_user_id` | uuid NOT NULL → users | |
| `retired_by_user_id`, `retired_at`, `retire_reason_code` | NULL | All set together when retired |
| `created_at` | timestamptz | |

One `ACTIVE` policy per college and type (partial unique index). A change is a retire and a new row,
so what was in force on any date stays answerable. A trigger refuses UPDATE other than ACTIVE→RETIRED
and refuses DELETE.

### The one-offer rule, exactly

At apply, for each live drive the application is linked to, if the college has an `ACTIVE`
`ONE_OFFER_PER_STUDENT` policy in effect now, and the drive is not exempt (`allow_drive_exceptions`
and `offer_holders_eligible` both true), the student is refused with `PLACEMENT_POLICY_ONE_OFFER` when
they hold an accepted offer: an offer in state `ACCEPTED` on an application that was not withdrawn or
rejected afterwards, or an application in state `HIRED`, **from any employer in ONE**. Nothing is
written. The refusal names the college and the rule, and the job's detail already told them before
they tried.

Decisions taken on Divakar's behalf (recorded in the goal report):

1. **Any accepted offer in ONE counts**, not only one from a drive. That is what "one offer per
   student" means in practice at colleges, and the check runs inside ONE on the student's own records —
   the college learns nothing from it.
2. **Policies apply only to drive applications** (plan decision 10.2 #11): the same student may still
   apply to a public job; the college's rule governs the college's process only.
3. **The check is evaluated at apply only.** An offer accepted after applying does not withdraw
   existing drive applications — that would be an automated rejection (§0.5).

## What the college sees

- **Drive list and decisions:** every drive requested at the college, with employer name, job title,
  state, schedule and history. No student data. Readable by owners, admins, placement admins and
  department heads.
- **Results:** once a drive is `COMPLETED`, counts of applications, offers and selections through the
  drive, each through the one suppression rule (`suppressSmallCount`: under 5 shows `<5`). Counts are
  withheld while the drive is live, because a count that changes day by day can be differenced to
  follow one student (the INST-SR-01 reasoning).
- **Named results**, at any point after approval: only applications linked to the drive whose student
  granted institution visibility and has not revoked it, of a student inside the reader's INST-02 scope
  with a current relationship — the INST-09 rule. Stage and offer existence only; never compensation
  (ADR-024), never readiness (ADR-020). Every read is audited.

## Who may write

| Write | Who | Rule |
|---|---|---|
| Request, resubmit, cancel, complete (employer side) | Owner, admin, recruiter | `requireActiveEmployer(..., 'jobs.publish')` — a drive reaches students, so an unverified, suspended or rejected employer may not ask for one; the organisation row is re-checked FOR SHARE inside the transaction (EMP-SR-15) |
| Approve, reject, request changes, schedule, cancel, complete (college side); set and retire policies | Institution owner, admin, placement admin | An ACTIVE membership in the college **and an institution-wide write scope** (INST-02/INST-SR-02): a drive reaches every student of the college, so a placement admin narrowed to one campus or department may read but not decide |

Every write locks the drive FOR UPDATE, checks the revision the caller read, writes the history row, an
`audit_events` row (actor, organisation, reason code, correlation ID) and a
`campus_drive.state_changed` outbox event in the same transaction, and refuses unknown fields. The
in-app notice to the other side (the requester on a decision; the college's placement staff on a
request) is best-effort after commit, like `notify.ts` everywhere else.

## Open points (decisions for Divakar)

1. The direct `INSTITUTION` audience still lets an employer reach a college without asking it. Keeping
   it avoids breaking existing jobs; **recommended next:** retire direct `INSTITUTION` audiences for new
   jobs once pilot colleges run drives in ONE, so every college-targeted job goes through approval.
2. Drive categories (Dream, Core, Mass) and ranked tier exceptions are INST-12's. Until then the
   exception is one flag per drive, set by the college.
3. Unit-targeted drives (one department only) are not modelled; eligibility rules on the job
   (department, programme) already narrow who may apply.
4. Approving a drive does not message every student; the college uses INST-06 announcements to
   circulate it.
