# SOP — What students and employers are told about hiring events

> What this is: help for employers on which of their actions notify a candidate, and what the
> notice says, with the matching operator steps. Why it exists: Appendix 2 EMP-18 asks for an SOP
> per shipped module; this covers EMP-08 (student hiring notifications) and the notices later
> goals added through it (EMP-09, EMP-10, EMP-12). Written 2026-10-01 against base `719eb34`.

## For employers

### What you do, and what the student is told

| Your action | The student gets |
|---|---|
| Move them to a new stage | "Application update" naming the job and stage |
| Reject them | A plain notice; never your internal reason code or note |
| Change material job terms | "The terms changed" with a link to review them (not for a deadline-only change) |
| Schedule, reschedule or cancel an interview | A notice in their own time zone; a calendar file they can download |
| Send an offer | "Offer from <your company>" with its deadline, and one reminder a day before it lapses |
| Withdraw an offer | "Offer withdrawn" |
| Send a screening test | "Screening test" with the test's title and when its window closes |
| Send a message | "Message from <your company>", once per unread run, never the text |

You are told, in-app only and without the candidate's name, when a candidate answers your offer
(the owners are told instead if the recruiter who made it has left) and when a candidate replies
to a conversation you wrote in.

### What a notice never carries

Your internal notes or reason codes, the joining link or location of an interview (emailed
invites leave them out; downloads inside ONE carry them), another candidate, a score, or any
internal identifier. Your company name in a notice is the legal name ONE verified.

### Email

Every notice is written in the app. Email is best-effort: the email sender is built but **not
switched on in production**, and the sender mailbox is still to be set up, so emails are recorded
as **not configured** and nothing claims an email was sent. Students can turn hiring emails off.
Notices are sent by the background worker after your action commits, never during it, so a failed
email never blocks or undoes what you did.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| "The student says they were never told" | Log a support case ([../ops/sop-support.md](../ops/sop-support.md)). On AWS the automation worker that delivers notices is not running yet, so notices queue until it is deployed. Locally, run the worker |
| A notice contains something abusive (from a job or test title the employer wrote) | Open a trust case about the employer; suspend if needed ([../ops/sop-organizations.md](../ops/sop-organizations.md) §B) |
| Switching email on | Only Divakar, as part of the production mail set-up (ADR-042) |

## Gaps

- The automation worker is not deployed on AWS (`docs/ops/runbook-move-to-aws.md`), so no
  hiring notice is delivered in production yet.
- Production email is off until the sender is switched on.
- Quiet hours and the daily cap are not applied to these time-critical notices.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J4, E-N.
