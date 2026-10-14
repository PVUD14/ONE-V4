# SOP — Messages with candidates

> What this is: employer-facing help for the one conversation ONE keeps per application, with
> the matching operator steps for reported messages. Why it exists: Appendix 2 EMP-18 asks for an
> SOP per shipped module; this covers EMP-10. Written 2026-10-01 against base `719eb34`.

## For employers

### Who

Owners, admins and recruiters of a verified, active employer. Everyone on your team sees every
conversation; there is no per-job team.

### Where

- **Employer Portal → Messages**: your *Conversations*, newest first.
- **Candidate Detail**: the conversation for that application.
- Android: the conversation sits on the applicant's page (read, start once shortlisted, reply).
  There is no employer inbox on the phone.

### Steps

1. You can **start** a conversation once the candidate is **Shortlisted** or later, while the
   application is open.
2. Type up to 2,000 characters of plain text and **Send**. No attachments.
3. A message containing a link is **flagged** for both sides, and links are never clickable. The
   student sees a "never pay a fee" warning.
4. Limits: after **three** messages in a row without a reply, wait for the candidate; at most 10
   messages per side per conversation per hour, 200 per employer per hour, 50 new conversations
   per employer per day. Over a limit you see `MESSAGE_RATE_LIMITED` or `MESSAGE_AWAITING_REPLY`.
5. When the candidate's grant ends (withdrawal, rejection, hire, deletion request) you can no
   longer read or write. The student keeps a read-only copy.

### What the student can do

Reply, **mute** the conversation, and **report** a message (scam or payment request, harassment,
inappropriate content, off-platform pressure, discrimination, other). You are never told about a
mute or a report.

### Retention

Message text is erased **180 days after the grant ends**, unless the conversation is evidence on
an open trust case or the student is under a retention hold. A deletion request erases both
sides' text.

### Never do

- Never ask for money, bank details or a "processing fee".
- Never push a candidate to move the conversation off ONE.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A student reports a message | A case opens automatically (one per conversation per student; a payment request is HIGH). Open it under **Operations → Trust and Safety**; **Reported conversation** shows the thread (every read is audited). Decide; if the employer is at fault, ask it to respond (see [sop-employer-terms-and-trust.md](sop-employer-terms-and-trust.md)) or suspend it ([../ops/sop-organizations.md](../ops/sop-organizations.md) §B) |
| Keep a conversation past 180 days for an investigation | Place a retention hold ([../ops/sop-privacy.md](../ops/sop-privacy.md) §C) |
| A student says the employer keeps messaging | Check whether they muted it; the three-in-a-row rule already stops repeated unanswered messages |

## Gaps

- ONE does not scan employer messages for payment demands (a design choice recorded in
  `docs/architecture/application-messages-table-design.md`); students report them.
- Only students can report. Per-employer limits are counted without a global lock.
- Student email notices are recorded as not configured until production email is switched on.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — E-M, J8.
