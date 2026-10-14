# Employer assessments — windows, time limits, audit and the invitation notice (EMP-12)

What this is: the design for the gaps EMP-12 closes in employer screening assessments, written before
the code because each rule decides whether a named candidate's result stands, who may read it, and
what the candidate is told. The tables are 0036's (`employer-assessment-table-design.md`); ADR-039
records why they are kept. The one migration, `0074_employer_assessment_notices.sql`, only widens two
CHECK lists.

## 1. Who may be sent a test

An invitation needs, all at once and re-checked inside the write transaction:

- a verified, active employer (the organisation row is read `FOR SHARE`, so a suspension either
  commits first and refuses the invitation, or waits for it — EMP-SR-15);
- a `PUBLISHED` assessment of that employer (row locked `FOR SHARE`, so a concurrent close cannot
  interleave);
- an application of that employer, for the assessment's role when it names one, **in the `ASSESSMENT`
  stage** (plan: "assign them to applicants at the ASSESSMENT stage"), not closed, consent not revoked;
- a live applicant-access grant for every application (EMP-SR-01's shared predicate, share-locked).

ONE never moves the application to `ASSESSMENT` because a test was sent: a person moves candidates.
Before EMP-12 any open application could be invited; that was looser than the plan.

Rejected: inviting from `SHORTLISTED` too. The job's own stages (EMP-06) name when assessment happens;
letting the test run ahead of the stage would make the pipeline say one thing and the candidate's
screen another.

## 2. Windows and time limits, on the database clock

- **Window.** `opensAt` is optional (the database's `now()` when omitted); `closesAt` is required. The
  INSERT itself refuses a window that closes in the past, closes before it opens, opens more than 5
  minutes in the past, or closes more than 30 days from now — all compared with `now()` in SQL, never
  with the API process's clock.
- **Time limit.** An attempt's deadline is `LEAST(started_at + duration, closes_at)`. Starting late in
  the window therefore gives less than the full duration; the candidate's brief says so before they
  start, with the exact minutes available.
- **Enforcement.** Start is refused outside the window. Saving an answer after the deadline is refused
  (`ATTEMPT_TIME_OVER`) and the attempt is finalised. Submitting after the deadline grades what was
  saved in time. Answers can only be written before the deadline, so grading later gives the same
  result as grading at the deadline.
- **Nobody has to press submit.** An in-progress attempt past its deadline is finalised by whoever next
  touches it — the candidate's list, start, answer or submit, or the employer's results read — with
  `submitted_at` set to the deadline. An invitation still `INVITED` after its window closes is written
  `EXPIRED` by the same sweep. The sweep is a deterministic database update; no model is involved.
- **How it ended.** Derived, not stored: an attempt submitted before its deadline ended by the
  candidate (`endedBy: CANDIDATE`); one submitted at the deadline ended on time (`TIME_LIMIT`). No
  column is added because the two timestamps already say it.

Rejected: a timer column or a scheduled job. The deadline is a pure function of stored facts, and a
worker would be a second clock.

## 3. What the candidate sees and agrees to

Before starting, the candidate reads a brief (`GET /students/me/screening-assessments/:id`): employer,
role, test title, number of questions, total marks, the question formats and how many of each, the
duration, the window and the minutes actually available if they start now, and fixed statements:

- one sitting, no second attempt; the timer runs on ONE's server and does not pause;
- no camera, microphone or screen capture, and nothing records tab switches;
- the result goes to this employer, for this application only, while they can see the application;
- it is not part of the academic record or learning evidence and does not change readiness.

Start requires `{ "acknowledged": true }`. The acknowledgement is recorded in the audit row
`student.screening_assessment.started`. Clients that send nothing get 400
`ASSESSMENT_ACKNOWLEDGEMENT_REQUIRED` — a candidate cannot be started by accident.

The paper never carries an answer key, correctness or marks awarded. After submitting, the candidate
sees their own score (unchanged from 0036).

## 4. What the employer sees

- **Per assessment** (`GET …/assessments/:id/results`): one row per invitation whose application still
  has a live grant, ordered by invitation time (never by score — EMP-SR-17, §5.4 "no automatic
  ranking"), keyset-paginated (default 50, maximum 200). Email only from `SHORTLISTED` onward
  (10.2 #9). Each read is audited `employer.assessment_results.viewed`.
- **Per candidate** (`GET …/applications/:applicationId/assessment-results`): that application's
  invitations for this employer, with the window, state, score, how the attempt ended and a
  per-question breakdown (the employer's own question text, marks, marks awarded). Live grant required
  (403 otherwise). Audited `employer.candidate_assessment_results.viewed`.
- Never: readiness, mastery, gap status, ONE's own or the college's assessments of the student, another
  employer's tests, or anything about the student beyond this employer's test for this application.

## 5. Writes: locked, audited, reason-coded, strict input

Every employer write runs in one transaction that re-reads the organisation `FOR SHARE`, locks the row
it changes, writes an `audit_events` row carrying the organisation and (where applicable) the reason
code, and refuses unknown fields (EMP-SR-08). Reason codes are fixed lists with no OTHER:

| Action | Reason required | Codes |
|---|---|---|
| Reject a question | yes | `INACCURATE`, `AMBIGUOUS`, `NOT_RELEVANT_TO_ROLE`, `DUPLICATE`, `UNFAIR_OR_BIASED` |
| Archive a question | yes | `OUTDATED`, `REPLACED`, `FLAWED`, `NO_LONGER_USED` |
| Close an assessment | yes | `ROLE_FILLED`, `ROLE_CLOSED`, `SCREENING_COMPLETE`, `REPLACED_BY_NEW_TEST`, `CONTENT_FLAWED` |

Closing (`PUBLISHED → CLOSED`) stops new invitations; invitations already sent keep their window,
because withdrawing a test a candidate may be sitting would discard their work (0036's rule).

## 6. Fairness

Grading reads only the answer key and the candidate's saved response — structurally nothing about who
the candidate is. Results are not ordered by score and nothing moves an application. A question whose
text names a protected attribute or proxy (EMP-06's word list) is **flagged** to its author and to the
reviewer who approves it (`mentionsProtectedAttribute`), not refused: the list has words like "height",
"age" and "men" that legitimately appear in aptitude questions ("the height of a tree"), and a refusal
would block honest questions while a reviewer can judge intent.

## 7. The invitation notice (migration 0074)

Each new invitation writes the registered outbox event `employer_assessment.invited` in the invitation
transaction. The EMP-08 hiring-notification consumer delivers an in-app `ASSESSMENT_INVITED` notice
(and the email, recorded `NOT_CONFIGURED` until a mail sink exists — HG-7): employer, role, test title
and the closing time in the student's timezone. At consume time it re-reads the invitation and sends
nothing if the application's grant is no longer live. It never carries a score.

0074 widens `user_notifications_kind_ck` and `hiring_notification_deliveries_kind_ck` by the
read-and-union pattern (keep every kind the live constraint allows, add `ASSESSMENT_INVITED`), guarded
so a replay changes nothing. No table is added; no existing migration is edited.

## 8. Suspended employers (EMP-SR-14)

The candidate's list marks an invitation `available: false` when the employer is not verified and
active, the application is closed or no longer shared, or the window has closed; start, answer and
submit are refused (`ASSESSMENT_UNAVAILABLE`) while the employer is not in good standing or the
application is no longer live. The employer cannot read results then anyway (§5.1 `candidates`).

## Open points for Divakar

1. **Learning-evidence opt-in (10.2 #12)** — not built; results never leave the application. Building
   it is the first path by which an employer's questions reach a student's record (ADR-039).
2. **Privacy export and deletion** do not yet cover employer screening attempts (pre-existing gap in
   0036's routes). The attempt belongs in the student's export and should be erased with the account;
   recommended as a follow-up with the privacy worker.
