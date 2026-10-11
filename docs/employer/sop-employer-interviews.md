# SOP — Interviews: scheduling, rescheduling, panels and scorecards

> What this is: employer-facing help for scheduling interviews, changing or cancelling them,
> working as a panellist and recording scorecards, with the matching operator steps. Why it
> exists: Appendix 2 EMP-18 asks for an SOP per shipped module; this covers EMP-09 and the
> interview routes that existed before it. Written 2026-10-01 against base `719eb34`.

## For employers

### Who

| Action | Owner | Admin | Recruiter |
|---|---|---|---|
| Schedule, reschedule, cancel, complete, record no-show | yes | yes | yes |
| Be a panellist (see your own interviews, record your scorecard) | yes | yes | yes |
| Create and retire scorecard templates | yes | yes | yes |

**Interviewers are recruiters.** There is no "interviews only" role; invite an interviewer as a
recruiter ([sop-employer-team.md](sop-employer-team.md)). A panellist sees **only** the
interviews they are on.

### Where

- **Interviews**: *Applicants at interview stage*, *Scheduled interviews* (where a panellist
  uses **Record outcome**) and *Scorecard templates*.
- The separate interviewer workspace (`/employer/interviewer`, *My Interviews*, *Candidate
  Brief*) serves the INTERVIEWER role, which ONE cannot give anyone today; panellists are
  recruiters and work from **Interviews**.
- Android: a read-only Interviews view from Home (state, stage, last change and reason, history,
  scorecards). Panellists can rate criterion by criterion and **Add to calendar** on the phone.
  Scheduling, rescheduling, cancelling and templates are on the web.

### Schedule

1. Move the applicant to the interview stage, then **Schedule interview**: start time, duration,
   mode, location or **Joining link** (plain `https://` only), **What to prepare** (shown to the
   candidate), and the **Interview participants** from your team.
2. Choose the interview's selection stage; its scorecard template is copied to the interview.
3. The student and each panellist are told once, with a calendar file.

### Reschedule or cancel

1. **Reschedule** (or **Cancel interview**) and pick a reason:
   - reschedule — `CANDIDATE_REQUESTED`, `INTERVIEWER_UNAVAILABLE`, `SCHEDULING_CONFLICT`,
     `LOGISTICS_CHANGED`, `TECHNICAL_ISSUE`;
   - cancel — `CANDIDATE_REQUESTED`, `CANDIDATE_WITHDREW`, `INTERVIEWER_UNAVAILABLE`,
     `POSITION_FILLED`, `PROCESS_CHANGED`, `SCHEDULED_IN_ERROR`.
2. A reschedule into the past is refused. The calendar entry updates in place.
3. The student is told it moved or was cancelled, never why.
4. **History** shows every change in order, with who, when and why. It cannot be rewritten.

### Who sees the joining link

The person who scheduled the interview, its panellists and the student. Other members of your
team see only that a link exists. Emailed invites never carry the link, location or preparation
note; downloads inside ONE do.

### Scorecards

1. **Interviews → Scorecard templates → New scorecard template**: name and up to 12 criteria with
   optional guidance. A template is never edited in place; **retire** it with a reason
   (`NO_LONGER_USED`, `REPLACED`, `CREATED_IN_ERROR`) and create another.
2. Attach a template to an interview or group-discussion stage on the job
   ([sop-employer-eligibility-and-stages.md](sop-employer-eligibility-and-stages.md)).
3. **Record outcome**: a recommendation, and a rating for **every** criterion of the template.
   One scorecard per panellist; a second submission corrects the first.
4. **Scorecards** shows every panellist's scorecard, only while the candidate's grant is live.
   There is no total and no score across panellists.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A candidate says an interview moved and nobody told them | Support case ([../ops/sop-support.md](../ops/sop-support.md)); check the employer's interview history with them on a call; delivery needs the automation worker (not on AWS yet) |
| A link in an interview is suspicious | Open a trust case about the employer |
| An ended team member is still on a future interview | Expected: they can no longer open it; the employer should reschedule with a new panel |

## Gaps

- Panellists cannot be added to or removed from an existing interview.
- No two-way calendar sync; Android adds to the calendar by intent, so a moved interview must be
  added again on the phone.
- Emailed invites wait for the production email sender.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J4.
