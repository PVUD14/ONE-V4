# Application-bound Messages — Table Design

**Status:** Adopted (EMP-10), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0067_application_messages.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Recruiters and candidates coordinate interviews, documents and offers, and today the only way to do
that is to leave ONE and swap personal numbers early — exactly what Appendix 2 §0.5 forbids ("employers
messaging or contacting students outside an application"). The recruiter portal already carries a
**Messages** navigation item that says "Not built yet".

A message between an employer and a student carries consequences. It is personal data about the
student, it is a channel a fake employer can use to ask for money (§10.1 risk "fake employers target
students"), and it outlives the moment it was sent. So the design has to say, before any row is
written: who may read it, when the employer stops being able to, how long it is kept, what deletion
does to it, how a student reports abuse, and what an employer can never see.

## Decision 1: one thread per application, not a general inbox

**Chosen.** `application_message_threads` has exactly one row per application (`UNIQUE
(application_id)`), bound by composite foreign keys to that application's employer and student, so a
thread can never point at another employer's or another student's application. Every message belongs
to one thread. The application — and through it the student's applicant-access grant — is the only
key that opens it.

**Rejected: a general user-to-user messages table.** Nothing in ONE lets an employer contact a student
except an application (and later an accepted EMP-14 invitation). A free-standing table would need its
own authorisation model and would invite exactly the off-application contact §0.5 forbids.

**Rejected: one thread per recruiter.** The employer acts as one party (Appendix 2 §5.1: owner, admin
and recruiter all "pass" for messages). A candidate should see one conversation with the company, not
one per staff member, and a recruiter leaving must not strand the conversation.

**Rejected: reusing `user_notifications` or `institution_announcements`.** Those are one-way notices
with different senders, audiences and retention.

## Who can read and write

| | Student (the applicant) | Employer member (owner, admin, recruiter of that employer) | Anyone else |
| --- | --- | --- | --- |
| Start the thread | No | Yes, from `SHORTLISTED` onward, application open, live grant (decision 10.2 #8) | No |
| Send | Yes, once the thread exists, application open, live grant | Yes, application open, live grant | No |
| Read | Always, their own thread (read-only once the grant ends) | Only while the grant is live — checked on every request | No |
| Mute notices | Yes | — | — |
| Report a message | Yes (employer messages) | — | — |

"The employer's team on that job" is the employer's active owners, admins and recruiters: ONE has no
per-job team today, every member already sees every applicant of their employer, and interviewers are
recruiters (decision 10.2 #2). If a per-job team is added later, the thread follows it without a
schema change.

The employer side passes `requireActiveEmployer(…, 'candidates')` (active membership, active and
**verified** organisation — a suspended, rejected or unverified employer can neither read nor send),
then the one live-grant predicate (`employer-authentication.ts`, EMP-SR-01): a withdrawal, a close, a
revoked sharing choice, an expired grant, or a deletion request (open or executed) stops the employer
on the next request. Sends take a share lock on the grant inside the write transaction, so a
withdrawal racing a send either happens first (the send is refused) or waits for it.

## `application_message_threads`

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `application_id` | → `applications(id)`, unique. Composite FKs `(application_id, employer_id)` and `(application_id, student_user_id)` onto the existing unique indexes of `applications` |
| `employer_id`, `student_user_id`, `opportunity_id` | Copied from the application and pinned by the FKs: the grant is looked up by exactly these three |
| `started_by_user_id` | The employer member who wrote the first message (→ `users`) |
| `started_at` | `now()` |
| `last_message_at` | Maintained on send; the inbox's keyset order |
| `student_muted_at` | Set when the student mutes; NULL otherwise. Muting stops notices, not messages |

## `application_messages`

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `thread_id` | → threads |
| `sender_side` | `EMPLOYER` or `STUDENT` |
| `sender_user_id` | → `users`. Never returned to the other side: a student sees "the company", not which recruiter |
| `body` | Text only, 1–2,000 characters; NULL only once erased |
| `contains_link` | True when the text contains something that looks like a link. Links are allowed but flagged |
| `sent_at` | `now()` in SQL (never a Node clock) |
| `read_at` | When the other side first opened the thread after it arrived. Employer side: any member |
| `reported_at`, `report_reason_code`, `trust_case_id` | Set together, once, when the student reports it |
| `erased_at`, `erasure_reason` | `PRIVACY_DELETION` or `RETENTION_EXPIRED`; with the body NULL |

A trigger makes messages append-only: the thread, sender, side and time never change; the body changes
only to NULL together with an erasure; `read_at` and the report columns are set once; rows are never
deleted. CHECKs pin the body length, the erasure shape and the report shape.

## Text, links and attachments

- **Text only, at most 2,000 characters** (trimmed, not empty). Control characters other than line
  breaks and tabs are refused. Unknown request fields are refused (400).
- **No attachments.** Documents move through the consented snapshot and the single-use résumé link
  (EMP-07), which are audited and grant-bound; a message attachment would be a second, weaker channel.
- **Links allowed, flagged.** A message containing `http(s)://`, `www.` or a bare domain is stored with
  `contains_link = true`. Clients render every body as plain text — never a clickable link — and show
  the student a warning next to it: ONE does not check links, and no genuine employer asks for money.
- **Contact details.** The employer's messages are the employer's own words; ONE does not scan them.
  What the employer can learn about the student is still only what EMP-07 allows (email from
  `SHORTLISTED`, phone only if the student added it). A student may choose to write their own number
  in a reply; that is their choice, and it is covered by the same grant and deletion as every message.

## Rate and size limits

Counted in SQL on the database clock, inside the send transaction after the thread row is locked:

| Limit | Value | Refusal |
| --- | --- | --- |
| Per thread, per side | 10 messages in any rolling hour | 429 `MESSAGE_RATE_LIMITED` |
| Employer, unanswered | At most 3 employer messages in a row without a student reply | 429 `MESSAGE_AWAITING_REPLY` |
| Per employer | 200 messages in any rolling hour, across all its threads | 429 `MESSAGE_RATE_LIMITED` |
| Per employer, new threads | 50 threads started in any rolling 24 hours | 429 `MESSAGE_RATE_LIMITED` |
| Per student | 60 messages in any rolling hour, across all their threads | 429 `MESSAGE_RATE_LIMITED` |

The per-thread limits are exact (the thread row is locked); the per-employer and per-student limits are
counted without a global lock and can be exceeded by a handful under concurrent sends — they are abuse
brakes, not quotas.

## Notifications (EMP-08 outbox path only)

A send writes one `application.message.sent` outbox event (payload: `applicationId`, `messageId` — never
the text) in the send transaction. The EMP-08 hiring-notification consumer delivers it off the request
path, under a consumer receipt, into `user_notifications` and `hiring_notification_deliveries`:

| Sender | Recipient | Kind | Email |
| --- | --- | --- | --- |
| Employer | The student, unless they muted the thread | `EMPLOYER_MESSAGE` (reserved by 0059) | Yes — `NOT_CONFIGURED` until a sink is configured (sender `info@ai8ht.pro` via `mailSender()`) |
| Student | The members who have written in the thread and are still active; otherwise the member who started it; otherwise the active owners and admins | `CANDIDATE_MESSAGE` (new) | No — in-app only |

At consume time the consumer re-checks that the grant is live and the message is not erased, and only
notifies for the **first unread** message from that side — five messages in a row produce one notice,
not five. A notice never carries the message text (an email can be forwarded; the text may hold contact
details) and an employer notice never names the candidate (it outlives the grant; EMP-08 rule).

## Reporting and moderation

A student reports one employer message with a reason code (`SCAM_OR_PAYMENT_REQUEST`, `HARASSMENT`,
`INAPPROPRIATE_CONTENT`, `OFF_PLATFORM_PRESSURE`, `DISCRIMINATION`, `OTHER`) and an optional statement
(≤ 1,000 characters). In one transaction:

1. If the student already has an open case (not `CLOSED`/`DISMISSED`) for this thread, the report is
   added to it; otherwise a trust case is opened: `EMPLOYER_ACCOUNTABILITY`, subject the employer
   `ORGANIZATION`, `organization_id` the employer, `reported_by_user_id` the student, severity `HIGH`
   for `SCAM_OR_PAYMENT_REQUEST` and `MEDIUM` otherwise, state `REPORTED`.
2. Evidence rows: `APPLICATION_MESSAGE_THREAD` (the thread — the whole conversation is the evidence),
   `APPLICATION_MESSAGE` (the reported message) and, if given, `REPORTER_STATEMENT`. 0067 widens
   `trust_case_evidence_kind_ck` by these two kinds; evidence stays a reference, never a copy.
3. The message is marked reported; an audit row is written.

**A report is not a penalty** (0032, spec 38): nothing is suspended, the thread stays open, and the
student can mute it. **The employer never learns** that a message was reported — no employer response
carries the report columns — so a report cannot invite retaliation. Operators with
`TRUST_SAFETY_INVESTIGATE` read the reported conversation through the case
(`GET /operations/trust-safety/cases/:caseId/message-threads`), limited to threads that are evidence on
that case and audited; they see the text regardless of the grant, because judging the report needs it.

## What employers can and cannot see

- **Can:** the thread's messages, both sides, while the grant is live; whether the student has read
  their messages; the application's state.
- **Cannot:** anything once the grant ends (403 on the thread, and the inbox drops it); whether the
  student muted the thread; whether a message was reported, or any trust-case link; which of their own
  members' messages the student read first; any readiness band, score, gap status or mastery value
  (none exists in these tables or responses).
- **Students cannot see** which recruiter sent a message — only the company.

## Retention (tied to the access grant)

- While the grant is live, both sides see the thread.
- When the grant ends (withdrawal, close, sharing revoked, expiry, deletion), the employer loses the
  thread on the next request. The student keeps a read-only copy — it is their correspondence.
- **180 days after the grant ended** (decision 10.2 #7's period), the daily privacy worker erases the
  message bodies (`RETENTION_EXPIRED`), leaving the rows (side, time) so counts stay honest. A thread
  that is evidence on an open trust case is skipped until the case closes, so a report cannot be
  defeated by waiting.

## Privacy: export and deletion

- **Export.** The student's data export includes each of their threads (job, employer, started) with
  every message's side, text, time, read time and — for their own reports — when they reported it.
  Recruiter identities and trust-case internals are left out (listed under `notIncluded`).
- **Deletion.** A new deletion category `APPLICATION_MESSAGES`, disposition `ERASED`: every message body
  in the student's threads — both sides, because the whole conversation is about them — is erased
  (`PRIVACY_DELETION`), the rows kept without text so an employer's pipeline and a trust case's
  references stay valid. The employer's access had already ended (the grant is revoked first). If
  operations need a reported conversation kept, they place a retention hold
  (`SAFETY_INVESTIGATION` / `EMPLOYER_ACCOUNTABILITY_CASE`, 0009), which already holds the whole
  deletion — the existing mechanism, not a new exception. 0067 widens `privacy_deletion_category_ck`
  with every value 0060 allowed plus this one.

## Navigation

No navigation item is added, removed, renamed or reordered (hard gate HG-3). The employer's existing
**Messages** item stops saying "Not built yet" and shows the inbox; the conversation also appears on
Candidate Detail. Students read and reply inside **My applications**, per application. A separate
student Messages item would be a navigation change and is not made.

## Open points (decisions for Divakar)

1. **Retention period after the grant ends: 180 days** (the adopted 10.2 #7 period). Shorter is one
   constant.
2. **Rate limits** as in the table above. Recommended as abuse brakes that a genuine recruiter never
   meets; revisit if an employer hits one.
3. **Employers cannot report a student's message.** The plan gives reporting to students only; an
   employer can stop replying, and operations can still be asked through support.
4. **Deletion erases both sides' text**, not only the student's. Recommended because the employer's
   messages are addressed to and about the student; the employer keeps the pipeline record.
