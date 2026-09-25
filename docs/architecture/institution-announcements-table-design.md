# Institution Announcements — Table Design

**Status:** Adopted (INST-06), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0046_institution_announcements.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

A college has no way to tell a batch or a department about a deadline, a placement drive or a
session (INST-00, gap I-10). Student notifications cover exams only: `user_notifications.kind` is
limited to `EXAM_ASSIGNED`, `EXAM_REOPENED`, `RESULT_PUBLISHED` and `SYSTEM` (0013).

An announcement reaches real people and says something on the college's behalf, so who may send
it, to whom, and whether it was actually delivered all carry consequences. That is why it gets a
table design rather than a free-form notification write.

## Who may address whom (decision 10.2 #8, adopted)

| Sender | May address |
| --- | --- |
| `INSTITUTION_OWNER`, `INSTITUTION_ADMIN` | The whole institution, or any unit in it |
| `PLACEMENT_ADMIN` (TPO) | The whole institution, or any unit in it — narrowed to the membership's department or batch if it carries one |
| `DEPARTMENT_HEAD` | Their department, or any unit below it — a head with no department on their membership addresses nobody |
| `FACULTY_LECTURER` | The sections and batches of their **active teaching assignments**, or any unit below them |

The sender's scope is computed by the single INST-02 helper
(`packages/authorization/src/institution-scope.ts`), never by the client. One deliberate difference
from reads: **a faculty member sends only through teaching assignments.** For reads, a faculty
membership in a college that has not yet recorded any assignment falls back to its department and
batch — and an unscoped one to the whole institution — so existing workspaces do not empty. For
sending, that fallback would let a lecturer message the entire college. The helper therefore gets a
second entry point, `institutionAnnouncementScope`, which feeds faculty memberships to the same
`institutionStudentScope` with `teachingUnitIds` defaulted to an empty list (and drops department-head
memberships that carry no department, which reads treat as institution-wide). A lecturer with no
active assignment can address nobody and is told so plainly.

An audience is either the institution (`audience_unit_id` NULL, which requires an institution-wide
scope) or one unit. A unit is addressable when some clause of the sender's scope covers it with every
anchor — the same rule a student row is tested against. Recipients are then resolved **server-side**
as students whose roster units fall inside both the audience and the sender's scope, with a current
relationship (`VERIFIED`/`ACTIVE`, inside its effective window — the canonical relationship policy).
The double filter means a mistake in one check still cannot widen the other.

## Decision: an announcement row plus a recipient log

**Chosen.** `institution_announcements` holds what was said, by whom, to which audience, over which
channels, and its lifecycle. `institution_announcement_recipients` holds one row per student who
received it, with the in-app notification it produced and the email outcome.

**Rejected: writing `user_notifications` rows only.** Nothing would record who sent what to whom,
a scheduled announcement would have nowhere to wait, and a cancelled one nothing to cancel. The
sender's "sent" list and the delivery summary would have to be reconstructed from a per-student feed.

**Rejected: storing the audience as a list of students at compose time.** Resolving at send time is
what makes a scheduled announcement reach the students who are actually in the section on the day,
and it keeps a large roster out of a request body. The recipient log records the resolved list once
the announcement is sent, so "who received it" is still answerable afterwards.

**Rejected: reusing `staff_actions`.** Staff actions are per-student workflow items with approval
states; an announcement is one message to a cohort with no workflow.

## `institution_announcements`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `institution_id` | → `organizations(id)` |
| `sender_user_id` | → `users(id)` |
| `sender_membership_id` | → `organization_memberships(id)`: the membership whose scope admitted the audience |
| `sender_role` | CHECK in the five sending roles above |
| `audience_kind` | `INSTITUTION`, `CAMPUS`, `DEPARTMENT`, `PROGRAM`, `BATCH`, `SECTION` — the unit's kind at compose time |
| `audience_unit_id` | NULL exactly when `audience_kind = 'INSTITUTION'`; composite FK `(audience_unit_id, institution_id)` → `institution_units(id, institution_id)`, so a unit of another college cannot be named |
| `title` | 1–160 characters (the notification title limit) |
| `body` | 1–500 characters — the notification body limit, so the in-app copy is the whole message and no second read path is needed |
| `channels` | text[]; must contain `IN_APP`; may contain `EMAIL`. No SMS (§5.5) |
| `email_template_key`, `email_template_version` | `institution-announcement`, 1 — the versioned template the email used |
| `state` | `SCHEDULED` → `SENT`, or `SCHEDULED` → `CANCELLED`. No other transition |
| `scheduled_for` | When it should go out; `now()` for "send now". Within 90 days, stamped by the database clock |
| `sent_at`, `recipient_count` | Set together when it is sent |
| `cancelled_at`, `cancelled_by_user_id`, `cancel_reason_code` | Set together when it is cancelled; reason `^[A-Z0-9_:-]{3,64}$` |
| `created_at`, `updated_at` | |

State constraints make an impossible row unrepresentable: `SCHEDULED` has neither `sent_at` nor
`cancelled_at`; `SENT` has `sent_at` and `recipient_count` and no `cancelled_at`; `CANCELLED` has
`cancelled_at` and no `sent_at`. Indexes: `(institution_id, created_at DESC, id DESC)` for the
admin list, `(sender_user_id, created_at DESC)` for the sender's list and the rate limit.

## `institution_announcement_recipients`

| Column | Notes |
| --- | --- |
| `announcement_id`, `student_user_id` | Composite primary key — a student can receive one announcement once, whatever replays |
| `notification_id` | → `user_notifications(id)` ON DELETE SET NULL: the in-app copy |
| `email_state` | `NOT_REQUESTED` (no email channel), `SKIPPED` (student not activated, or email turned off in their preferences), `NOT_CONFIGURED` (no sender exists — HG-7), `PENDING`, `SENDING`, `SENT`, `FAILED`, `BOUNCED` |
| `email_attempted_at` | When the send was attempted |
| `created_at` | |

## Sending: once, and never after a cancel

Creating an announcement writes the row (`SCHEDULED`), an audit event, and one outbox event
`institution.announcement.dispatch.requested` (payload `announcementId`) whose `available_at` is
`scheduled_for`, all in one transaction. The outbox already holds an event until it is available,
so the ADR-028 local dispatcher delivers it on time without a new scheduler.

The consumer runs under `event_consumer_receipts` (a replayed event does nothing) and, inside one
transaction, locks the announcement row; if it is not `SCHEDULED` — already sent, or cancelled — it
does nothing. Otherwise it resolves recipients and writes every `user_notifications` row and every
recipient row set-based, sets `SENT`, `sent_at` and `recipient_count`, and audits
`institution.announcement.sent`. Cancel takes the same row lock and succeeds only from `SCHEDULED`,
so a cancel and a send cannot both win. The recipient primary key is a second guarantee: even a
second consumer under a different receipt cannot deliver twice.

Email leaves after that transaction commits, one recipient at a time, each claimed `PENDING` →
`SENDING` by a conditional update so two workers cannot both send it, and recorded `SENT`, `FAILED`
or `BOUNCED`. A failed email never undoes the in-app delivery or the announcement (§5.5).

**No production sender exists** (hard gate HG-7). With no mail sink configured, every email recipient
is recorded `NOT_CONFIGURED` at send time and the sender's screen says "Email not sent: no sender is
set up yet". Nothing claims an email was sent. The email body is a versioned template
(`notification_templates`, stable key `institution-announcement`, version 1), exactly as INST-01
does for student invitations. The n8n automation leg (`notification.delivery.requested`) is not used:
it needs a registered workflow in the automation allowlist, which is part of the same sender set-up.

## `user_notifications.kind`

0046 adds `ANNOUNCEMENT`. The constraint is shared with EMP-08 and the engine goals (program rule
B.3), so the migration does not restate a fixed list: it reads the current constraint's kinds, adds
the four from 0013 and `ANNOUNCEMENT`, and recreates it only if `ANNOUNCEMENT` is missing. Whichever
goal lands first or second, and in whatever order the files replay, no kind that exists is dropped,
and a second run is a no-op.

## Rate limit

A sender may create at most 20 announcements in any rolling 24 hours per institution (`429
ANNOUNCEMENT_RATE_LIMITED`). Cancelled ones count: the limit is on what a person composes, so
creating and cancelling cannot be used to probe it.

## Audit

`institution.announcement.created` (audience, channels, scheduled time), `.cancelled` (reason code),
`.sent` (recipient count) — each in the transaction that makes the change.

## Counts shown to the sender

The sender sees how many students received an announcement and the email outcome counts. These are
counts over the sender's own audience, whose students the sender can already list by name in their
scope, so small-group suppression (§0.5) protects nothing here and would hide delivery failures the
sender needs to see. They are not aggregates of student attributes, and no student is named.

## Open points (decisions for Divakar)

1. **Sender and domain** (HG-7, Appendix 3 §10.3): which domain sends announcement email. Until
   decided, announcements are delivered in-app and email is recorded as not sent.
2. **Where admins, placement officers and department heads compose** (HG-3). Only the faculty
   navigation has a `Messages` item. The API serves all five roles; the web composer is mounted on
   faculty `Messages` only. Recommended: add `Messages` to the other three roles' navigation.
3. **Longer messages.** The 500-character body keeps one read path. If colleges need longer notices,
   add a student announcement read and show an excerpt in the feed.
