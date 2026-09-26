# Hiring Notification Deliveries — Table Design

**Status:** Adopted (EMP-08), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0059_hiring_notifications.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

A student is not told when an employer moves their application, schedules or changes an interview,
extends or withdraws an offer, or when an offer is about to lapse (Appendix 2 defect D-6, spec §116).
The employer controllers already write `application.<state>`, `interview.scheduled`,
`offer.extended`, `offer.accepted` / `offer.declined` and EMP-05's `application.terms_change.recorded`
to the outbox, but none of those event types is registered, so the local dispatcher fails each one
with `SCHEMA_VALIDATION_FAILED` and nothing reaches anyone. `user_notifications.kind` allows only exam
kinds, `SYSTEM` and INST-06's `ANNOUNCEMENT`.

A hiring notification speaks to one person about their own application on an employer's behalf, and
it is also the only trace that ONE told them. Whether a student was told about an interview, and
whether the email actually left, carries consequences — that is why it gets a table design rather than
a bare insert into the feed.

## Decision: one delivery row per (event, recipient)

**Chosen.** `hiring_notification_deliveries` holds one row for each outbox event and each person it
notified: which in-app notification it produced, which versioned template the email used, and the
email outcome. Its primary key `(source_event_id, recipient_user_id)` is the second idempotency
guarantee after the consumer receipt (`event_consumer_receipts`): a replayed event, a second worker or
a second consumer can never produce a second notification or a second email for the same person.

**Rejected: `notification_commands` (0004).** It is the ADR-021 path — email handed to the automation
worker and the n8n workflow service. That service is not deployed, each command needs a registered
workflow in the allowlist and a destination reference, and it records nothing about the in-app copy.
Building on it now would mean every hiring email sits `PENDING` with no honest state to show. The
delivery row keeps the email behind the same `InvitationMailSink` abstraction INST-01 and INST-06 use;
when the sender is decided (HG-7), the sink is configured and nothing here changes.

**Rejected: writing `user_notifications` rows only.** There would be no idempotency key (the feed has
no event reference), no email state, and no way to answer "was this student told, and did the email
leave?" without parsing notification text.

**Rejected: reusing `institution_announcement_recipients`.** Its key is an announcement; a hiring
event has no announcement, and the two have different senders, audiences and retention.

## `hiring_notification_deliveries`

| Column | Notes |
| --- | --- |
| `source_event_id` | The outbox event that caused it. No FK: outbox rows can be pruned; the delivery record must outlive them |
| `recipient_user_id` | → `users(id)`. With `source_event_id`, the primary key |
| `recipient_kind` | `STUDENT` or `EMPLOYER_MEMBER` |
| `application_id` | → `applications(id)`: what the notice was about. Never shown to anyone |
| `kind` | The `user_notifications.kind` it produced (CHECK, the hiring kinds below) |
| `notification_id` | → `user_notifications(id)` ON DELETE SET NULL: the in-app copy |
| `email_template_key`, `email_template_version` | The versioned template the email used (`hiring-<kind>`, 1); NULL when no email was requested |
| `email_state` | `NOT_REQUESTED` (in-app only: employer notices), `SKIPPED` (student not `ACTIVE`, or email turned off in `notification_preferences`), `NOT_CONFIGURED` (no sender — HG-7), `PENDING`, `SENDING`, `SENT`, `FAILED`, `BOUNCED` |
| `email_attempted_at` | When the send was attempted |
| `created_at` | |

A CHECK ties the template to the email: `NOT_REQUESTED` has no template; every other state has one.
Indexes: `(application_id, created_at DESC)` for "what was this applicant told", and a partial index on
`email_state = 'PENDING'`.

## How a notice is sent

Each outbox event type below is consumed by one local consumer (ADR-028 transport). Under a consumer
receipt and in one transaction it reads the application, job title and employer name **at consume
time**, decides whether the notice still applies, and writes the `user_notifications` row and the
delivery row together. The email, if `PENDING`, leaves after that commit: claimed `PENDING → SENDING`
by a conditional update so two workers cannot both send it, then recorded `SENT`, `FAILED` or
`BOUNCED`. A failed email never undoes the in-app notice, and nothing about the hiring action waits on
either — the controller only wrote an outbox row (Appendix 2 §5.6).

| Event | Recipient | Kind | Email |
| --- | --- | --- | --- |
| `application.screening` … `application.rejected` (employer transition) | Student | `APPLICATION_STAGE_CHANGED` | Yes |
| `application.terms_change.recorded` with `acknowledgement = REQUIRED` | Student | `APPLICATION_TERMS_CHANGED` | Yes |
| `interview.scheduled` | Student | `INTERVIEW_SCHEDULED` | Yes |
| `interview.state_changed` to `RESCHEDULED` or `CANCELLED` | Student | `INTERVIEW_CHANGED` | Yes |
| `offer.extended` | Student | `OFFER_EXTENDED` | Yes |
| `offer.withdrawn` | Student | `OFFER_WITHDRAWN` | Yes |
| `offer.expiry_reminder.requested` (offer still `EXTENDED`, not yet expired) | Student | `OFFER_EXPIRING` | Yes |
| `offer.accepted` / `offer.declined` | The employer member who extended it (or, if they have left, the employer's active owners and admins) | `OFFER_RESPONDED` | No — in-app only |

`interview.state_changed` and `offer.withdrawn` are new events: the interview-state and offer-withdraw
routes wrote an audit row only. `COMPLETED` and `NO_SHOW` are recorded but notify nobody. A deadline-only
terms change (`NOT_REQUIRED`, EMP-05 decision 2) asks nothing of the applicant and notifies nobody.

**Offer-expiry reminder.** When `offer.extended` is consumed, the consumer queues
`offer.expiry_reminder.requested` in the same transaction, available (and occurring) 24 hours before
the offer expires — the outbox is the scheduler (ADR-028, EMP-05's deadline job). An offer that expires
within 24 hours of being extended gets no reminder: the offer notice itself states the deadline. A
reminder for an offer that was answered, withdrawn or has expired does nothing.

## What a notice may say

Only what the recipient may already see: the job title (as applied to), the employer's name, the stage,
the interview's round, mode and time (in the student's `notification_preferences.timezone`, default
Asia/Kolkata), and the offer's response deadline. **Never** a readiness band or score, a reason code or
an employer's private note, another candidate, or an internal identifier; the `data` payload carries
only display strings (`employerName`, `opportunityTitle`, `screen`). The email leaves out the joining
link and the location — both are shown in ONE, which keeps a forwarded or intercepted email from being
a way into the interview. Employer notices name the job and its reference code but not the candidate: a
notice outlives the applicant-access grant (EMP-SR-01), so it must not carry a name the employer may
later lose the right to see.

## `user_notifications.kind`

0059 adds `APPLICATION_STAGE_CHANGED`, `APPLICATION_TERMS_CHANGED`, `INTERVIEW_SCHEDULED`,
`INTERVIEW_CHANGED`, `OFFER_EXTENDED`, `OFFER_WITHDRAWN`, `OFFER_EXPIRING`, `OFFER_RESPONDED` and
`EMPLOYER_MESSAGE` (reserved for EMP-10, so the constraint is widened once). It follows 0046's pattern
(program rule B.3): read the kinds the current constraint allows, keep them and 0013's, add these, and
recreate only if one is missing — so `ANNOUNCEMENT` and anything an engine goal adds are never dropped.
The plan's list is extended by two: `APPLICATION_TERMS_CHANGED` (EMP-05's event had nowhere else to
land without mislabelling it a stage change) and `OFFER_RESPONDED` (the employer's in-app notice).

## `interviews.preparation_note`

The student interview view shows "what to prepare", and nothing stored it. 0059 adds a nullable
`preparation_note` (≤ 1000 characters) that the employer may set when scheduling; it is shown to the
candidate as written. `cancellation_reason` stays the employer's own and is not shown to the student.

## Open points (decisions for Divakar)

1. **Sender and domain** (HG-7, Appendix 2 §10.3). Until decided, hiring notices are delivered in-app
   and every email is recorded `NOT_CONFIGURED`; nothing claims an email was sent.
2. **Quiet hours and the daily cap** in `notification_preferences` are not applied: these are
   time-critical transactional notices about the student's own application (an interview tomorrow), and
   delaying one past its moment would harm the student. The email switch is honoured.
3. **One reminder, 24 hours before expiry**, rather than a reminder every day an offer is open.
   Recommended because offers are usually open for days, not weeks; revisit if employers set long
   windows.
