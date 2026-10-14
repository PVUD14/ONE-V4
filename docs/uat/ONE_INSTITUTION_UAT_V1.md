# ONE Institution Portal — UAT scripts V1

> What this is: executable acceptance scripts for the twelve institution journeys in Appendix 3 §9
> (J1–J12), plus supplementary scripts so that every shipped institution module has at least one.
> Why it exists: INST-19 requires "every shipped module has an SOP and a UAT script", and each
> institution milestone exits when its journeys pass on staging with seeded data. First written for
> the IM1 slice (2026-09-26, base `6864332`); completed for every milestone (IM1–IM5) on 2026-10-01
> against base `719eb34`. Result tables are empty: nothing below has been run yet.

## Rules for running these scripts

- **Synthetic data only.** `@uat.example.test` accounts, `UAT …` organisations and made-up student
  IDs. Never a real student, mark sheet, employer or college.
- **Environment.** Staging or a local stack with a **non-production** Cognito pool. Production is
  `https://oneby8.com` on AWS (ADR-041); only Divakar releases to it or touches it. Imports,
  invitations, uploads, exports and exits are never run against production.
- **Email.** The SMTP sender is built (ADR-042) but not switched on in production, and the sender
  mailbox is still to be set up. Locally, enable the loopback Mailpit sink to see emails; without a
  sender the screens say the email was not sent, which is the correct result.
- **Automation worker.** The worker that sends student invitations and runs other outbox consumers is
  not deployed on AWS yet (`docs/ops/runbook-move-to-aws.md`). Run the email steps of J1 and J5 on a
  local stack with the worker running.
- **File uploads** are off on AWS until a virus scanner exists. None of these scripts needs one
  (CSV is pasted, not uploaded).
- **AI** is held (ADR-030): no model runs and every AI flag is off. No step depends on one.
- **Seeding.** No committed seed creates students; they are created by J1. Platform and first-admin
  setup follow the operations UAT J1. Steps that need engine content (published practice sets,
  lessons, career roles) say so in their precondition.

## Personas and data

| Persona | Account | Membership |
|---|---|---|
| College owner | `college.owner@uat.example.test` | INSTITUTION_OWNER of `UAT Engineering College` |
| College admin | `college.admin@uat.example.test` | INSTITUTION_ADMIN |
| Head, Mechanical | `hod.me@uat.example.test` | DEPARTMENT_HEAD, department Mechanical (invited in J2) |
| Head, Civil (control) | `hod.ce@uat.example.test` | DEPARTMENT_HEAD, department Civil |
| Head, no department (control) | `hod.none@uat.example.test` | DEPARTMENT_HEAD, no unit scope |
| Faculty | `faculty.me@uat.example.test` | FACULTY_LECTURER (invited in J2) |
| Faculty (control) | `faculty.ce@uat.example.test` | FACULTY_LECTURER, assigned to CE-2A |
| Placement officer | `placement.admin@uat.example.test` | PLACEMENT_ADMIN, whole college |
| Placement officer, Mechanical | `placement.me@uat.example.test` | PLACEMENT_ADMIN narrowed to Mechanical |
| Other college's admin | `institution.admin@uat.example.test` | INSTITUTION_ADMIN of `UAT Arts College` |
| Other college's owner | `arts.owner@uat.example.test` | INSTITUTION_OWNER of `UAT Arts College` (J12 only) |
| Students | `uat.student.0001@uat.example.test` … `0200` | created in J1 |
| Recruiter | `emp.recruiter1@uat.example.test` | RECRUITER of `UAT Logistics Pvt` (employer UAT) |
| Operator | `operations.admin@uat.example.test` | OPERATIONS_ADMIN (operations UAT) |
| Approver | `ops.super@uat.example.test` | PLATFORM_SUPER_ADMIN (operations UAT) |

Academic Structure (created by the admin before J1): departments **Mechanical** and **Civil**;
programmes **B.E. Mechanical** and **B.E. Civil**; batches **ME-2023** and **CE-2023**; sections
**ME-3A**, **ME-3B**, **CE-2A**. Students 0001–0060 in ME-3A, 0061–0120 in ME-3B, 0121–0200 in
CE-2A.

## Summary

Status words: **Ready** — built and runnable as written. **Partly** — runnable, but a part is
blocked (the reason is given). **Blocked** — cannot pass until the named gate opens; the script is
kept so the numbering stays.

| # | Journey (Appendix 3 §9) | Built by | Status | SOP |
|---|---|---|---|---|
| J1 | Admin imports 200 students; they activate | INST-01 | Ready on a local stack (email through the sink; the worker is not on AWS) | [activation](../institution/sop-student-activation.md) |
| J2 | Head for Mechanical and faculty for ME-3A each see only their scope | INST-02 | Ready | [scope and teaching](../institution/sop-staff-scope-and-teaching.md) |
| J3 | Faculty assigned to ME-3A for Thermodynamics; My Students shows exactly ME-3A | INST-03 | Ready | [scope and teaching](../institution/sop-staff-scope-and-teaching.md) |
| J4 | Faculty verifies a semester result; admin uploads a batch's results | INST-04 | Ready (evidence cannot be opened — ADR-027) | [verification](../institution/sop-academic-verification.md) |
| J5 | Department head announces a workshop to ME | INST-06 | **Partly** — only faculty have a Messages screen (HG-3); the head's variant is API-only | [announcements](../institution/sop-announcements.md) |
| J6 | Department head opens every item | INST-07 | Ready | [department workspace](../institution/sop-department-workspace.md) |
| J7 | Counselling note | INST-11 | Ready | [counselling notes](../institution/sop-counselling-notes.md) |
| J8 | TPO views the placement register after a drive | INST-09, INST-12, EMP-11 | Ready | [placement register](../institution/sop-placement-register.md), [placement status](../institution/sop-placement-status.md) |
| J9 | TPO nominates eligible students for a drive | INST-14 | Ready | [nominations](../institution/sop-nominations.md) |
| J10 | Faculty sees students stuck on a skill and assigns a practice set | INST-15, INST-16 | **Partly** — "sees students stuck" is **blocked by HG-6** (no adaptive-learning consent can be given); assigning runs | [faculty learning](../institution/sop-faculty-learning.md) |
| J11 | TPO selects a career role and runs a two-week preparation sprint | INST-17 | Ready (needs a published career role and content) | [readiness by role](../institution/sop-readiness-by-role-and-sprints.md) |
| J12 | College offboarding dry run | INST-18 | Ready (the terms text is a draft for legal review) | [college exit](../institution/sop-college-exit.md) |

Supplementary scripts — one for every shipped module that no journey covers fully:

| # | Module | Built by | Status | SOP |
|---|---|---|---|---|
| I-S | Settings, grading scales, calendar | INST-05 | Ready | [settings](../institution/sop-settings-and-calendar.md) |
| I-C | Student meets the consent gate | ENG-01 | Ready (engine purposes unpublished, HG-6) | — (student flow) |
| I-X | Analytics access and CSV exports | INST-08 | Ready | [analytics and exports](../institution/sop-analytics-and-exports.md) |
| I-P | Placement status and a student sharing an application | INST-09 | Ready | [placement status](../institution/sop-placement-status.md) |
| I-Y | Year-end actions | INST-10 | Ready | [year-end actions](../institution/sop-year-end-actions.md) |
| I-A | Accreditation outcomes export and graduates' self-report | INST-13 | Ready (run after I-Y) | [accreditation exports](../institution/sop-accreditation-exports.md) |
| I-D | Campus drive approvals, placement policy, drive categories | EMP-11, INST-12 | Ready | [campus drives](../institution/sop-campus-drives.md) |
| I-T | Assessments (pre-plan module) | pre-plan; INST-07 scoped assignment | Ready | [assessments](../institution/sop-assessments.md) |
| I-W | Interventions, tasks, notes and meetings (pre-plan module) | pre-plan; INST-02 scope | Ready | [staff actions](../institution/sop-staff-actions.md) |

The college data-processing terms (INST-18) are walked as J1's step 0 and in J12.

---

## J1 — Import 200 students; students activate

| # | Actor | Action | Expected result |
|---|---|---|---|
| 0 | College owner | **Settings → Data-processing terms** → accept the current version | Accepted. Before this, step 4 is refused ("An owner of your college must accept…"). The text is labelled "Draft — pending legal review" until reviewed |
| 1 | College admin | Dashboard | *Student Activation* shows 0 invited / 0 activated (not blank, not invented) |
| 2 | College admin | **Students → Import Students**, paste the 200-row synthetic CSV → **Validate CSV** | 200 accepted, 0 rejected |
| 3 | College admin | Change one row's section to `ME-9Z`, validate | That row rejected ("unknown unit"); **Commit** disabled |
| 4 | College admin | Restore it, validate, **Commit 200 rows** | 200 students listed as *Invited* |
| 5 | Tester | Local Mailpit (worker running) | Exactly 200 invitation emails, one per student. Without a sender: each shows that the email was not sent |
| 6 | College admin | Dashboard vs Students list | Activation counts identical in both |
| 7 | Student 0001 | Open the link; sign in with `uat.student.0001@uat.example.test` (verified) | Lands in the student workspace (through the consent gate, I-C) with the college relationship |
| 8 | Student 0002 | Open **student 0001's** link while signed in as 0002 | Refused with a generic message; nothing disclosed |
| 9 | College admin | **Resend invitation** for 0003, reason `NOT_RECEIVED` | New link; the earlier link for 0003 is refused |
| 10 | College admin | Dashboard | Activated count shows 1 more for each activated student |
| 11 | College admin | **End relationship** for 0200 | 0200's pending invitation revoked; its link refused |
| 12 | Other college's admin | Open `UAT Engineering College` student list by URL | 403 |

Activate a sample (0001, and a few more); activating all 200 needs 200 Cognito users.

## J2 — Scoped staff see only their scope

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Staff → Invite institution staff**: `hod.me@…` as Department head, Department Mechanical; `faculty.me@…` as Faculty, Department Mechanical | Both invitations listed with their scope |
| 2 | Head and faculty | Accept and sign in | Each lands in their own institution workspace |
| 3 | Head, Mechanical | **Students** | Subtitle "Showing students in Mechanical"; only students 0001–0120 |
| 4 | Head, Mechanical | Open student 0150 (Civil) by URL | 403; no data |
| 5 | Head, Civil | Open student 0010 by URL | 403 |
| 6 | College admin | Students | All 200 (199 current after J1 step 11) |
| 7 | Tester | Repeat 3–4 for the verification queue, the readiness report, placement status and the department overview | Same scope |
| 8 | College admin | Change `faculty.me`'s scope to batch ME-2023 with `SCOPE_REVIEW` | Saved; audit shows before and after |
| 9 | Head, no department | Decide a verification request, upload results, assign an assessment, export | Each refused with `SCOPE_REQUIRED`; nothing written |
| 10 | Head, no department | **Students** | **Known behaviour (open finding INST-SR-02):** lists the whole college. Record what you see; it changes only when Divakar decides the read rule |

## J3 — Teaching assignment drives My Students

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Staff → Teaching assignments → Assign**: `faculty.me`, section ME-3A, subject code `THERMO`, term `2026 Odd`, starts today, reason `NEW_TERM` | Assignment listed |
| 2 | Faculty | **My Students** | Exactly students 0001–0060 |
| 3 | Faculty | Open student 0070 (ME-3B) by URL | 403 |
| 4 | Faculty (control) `faculty.ce` with no assignment recorded yet | **My Students** | *You have no active teaching assignment yet* (the college now uses assignments) |
| 5 | Head, Mechanical | **Faculty and Staff → Assign** `faculty.ce` to CE-2A | Refused (outside the head's department) |
| 6 | College admin | **End assignment** for ME-3A, `TERM_ENDED` | Faculty's next My Students request shows no students |

Re-assign `faculty.me` to ME-3A before J4.

## J4 — Verification one by one and in bulk

**Precondition:** student 0001 has reported semester 3 as CGPA 8.1 and asked the college to verify
it; student 0002 has reported semester 3 as 7.0.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty (assigned to ME-3A) | **Academic Verification** | 0001's and 0002's requests listed; none from CE students |
| 2 | Faculty | Evidence on 0001's request | Title, type and version only; no file or link (ADR-027) |
| 3 | Faculty | **Confirm** 0001 | Verified; audit `academic_term.verification_decided` with `MATCHES_INSTITUTION_RECORD` |
| 4 | Faculty | **Reject** 0002 with `DOES_NOT_MATCH_RECORD` → **Confirm rejection** | Rejected; audited with reason |
| 5 | College admin | **Students → Upload results**: ME-3A semester 3 CSV (60 rows; 0002 at 7.4), reason `RESULTS_DECLARED` → **Validate results** | Preview: CONFIRM for 0001, CONFLICT for 0002, CREATE for the rest |
| 6 | College admin | Add a row with scale `CGPA_11`, validate | INVALID row; commit refused; nothing written |
| 7 | College admin | Remove it; validate; commit | Terms verified as *Verified by the institution*; 0002's own reported value kept and flagged |
| 8 | College admin | Commit the same preview again after changing one record | Refused (records changed since the preview) |
| 9 | Tester | **Audit Logs** (operator) for `institution.academic_results` | `previewed` and `imported` rows plus one `verified_by_import` per term |
| 10 | Head, Civil | Upload a file containing ME students | Rows outside Civil refused |
| 11 | Faculty (control) without an assignment | Decide any request | Refused `SCOPE_REQUIRED` |

## J5 — Announcement to a scope

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty (assigned to ME-3A) | **Messages → New announcement**: title "Thermodynamics workshop", message, Send to ME-3A, **Also send by email** | Sent; delivery counts shown |
| 2 | Student 0001 | Notifications (web and Android) | Announcement with sender; email in the local sink |
| 3 | Student 0150 (Civil) | Notifications | Nothing received |
| 4 | Faculty | **Send to** list | Offers only ME-3A; the department and the college are not offered |
| 5 | Faculty | Schedule another for tomorrow, then **Cancel** with `PLANS_CHANGED` | Cancelled; when due, nothing is delivered |
| 6 | Head, Mechanical (API only, HG-3) | POST an announcement to the Mechanical department | Accepted; only ME students receive it. **Record J5 as partly passed until a screen exists** |
| 7 | Faculty | Send a 21st announcement within 24 h | Refused (rate limit) |

## J6 — Department head opens every item

**Precondition:** J1–J4 done; some ME students have shared applications (I-P); an assessment is in
progress (I-T).

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Head, Mechanical | Open each item in order: Dashboard, Department Overview, Students, Readiness, Assessments, Interventions, Faculty and Staff, Placement Pipeline, Opportunities and Offers, Batches, Meetings, Reports and Analytics, Settings, Help & FAQ | Every item shows a real screen; none says "View-only for your role" or "not built yet". Where a source has no data the slot reads NA, 0 or `<5` — never an invented figure |
| 2 | Head, Mechanical | **Department Overview** | Roster and activated counts, assessments in progress, last month's readiness bands, open interventions, batches, pipeline |
| 3 | Tester (API, as the college admin) | `GET …/department-overview?unitId=<Mechanical>` and `…/placement-pipeline?unitId=<Mechanical>` | Every count equals the head's |
| 4 | Head, Mechanical | **Readiness** | Bands only; no score, percentage or decimal; groups under 5 read `<5` |
| 5 | Head, Mechanical | **Opportunities and Offers** | Only shared applications of ME students; offer existence and response, never pay |
| 6 | Head, Mechanical | **Batches** | ME-2023 with roster, enrolled and activated counts; no edit control |
| 7 | Head, Mechanical | **Reports and Analytics → Exports** without analytics access | Refused with "You do not have analytics and exports access…" |
| 8 | Faculty | **Reports** and **Assessment Detail** | Class report for ME-3A; class average shown only with 5+ results; *Not attempted yet* list |
| 9 | Head, Mechanical | Android: institution home | Department overview, cohort readiness and pipeline cards, read-only |

## J7 — Counselling note

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Head, Mechanical | **Interventions → Counselling notes → Write a counselling note** for student 0005: title, note, not shared | "Note saved. Only its readers can see it." |
| 2 | Faculty (assigned to ME-3A) | Open 0005's counselling notes | "No notes you can read for this student." — no text, no participant list |
| 3 | Head, Civil | Open 0005's notes by URL | 403; the refusal is audited as DENIED |
| 4 | Placement officer | Read 0005's notes (API — no screen) | No note returned |
| 5 | College admin | Open 0005's case | Reads the note; **Case participants** empty |
| 6 | College admin | **Add a case participant**: `faculty.me`, reason `CASE_SUPPORT` | Added; the lecturer can now read 0005's notes |
| 7 | College admin | Remove the participant, `CASE_CLOSED` | The lecturer's next request returns no notes |
| 8 | Head, Mechanical (author) | **Share with the student** | Student 0005 sees it under *Counselling notes shared with you* (web and Android), writer shown as a role |
| 9 | Tester (operator) | Audit for `counselling_note.*` | A row per read (SUCCESS and DENIED) and per write; no title or text in any audit row |
| 10 | College admin (with analytics access) | **Exports → Staff-action summary** for last month | No counselling note counted, no title or text |
| 11 | College admin | **Erase note**, `RECORDED_IN_ERROR` | Erased; gone for every reader |

## J8 — Placement register after a drive

**Precondition:** I-D done (a drive by `UAT Logistics Pvt` approved, held and marked complete); at
least 30 ME students applied through it; some shared their application (I-P), at least one accepted an
offer, at least one shared nothing. Run after the first day of the following month (figures are a
month-end stock).

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Placement officer | **Dashboard → Placement statistics** | By department and batch: eligible, not shared, applied, shortlisted, with an offer, placed, placed of students sharing, offers per placed student |
| 2 | Tester | Reconcile each count against the shared applications in the fixture | Every count matches; the student who shared nothing is *Not shared*, never counted unplaced, and not in the percentage's denominator |
| 3 | Tester | Any group of 1–4 | Reads `<5`; the row or column total that would reveal it is withheld |
| 4 | Placement officer | **Students** → placement status column; **View applications** for a student who shared nothing | "Nothing shared" / "Not shared" |
| 5 | Placement officer | **Dashboard → Placement register** | The employer under *Employers engaged*; the drive on the *Drive calendar* with students sharing, with an offer, placed |
| 6 | Tester | Search every screen and the Android Placement statistics card for pay | No salary, CTC, stipend or currency anywhere |
| 7 | Student who accepted | **Stop institution sharing**; reload the statistics next month | Drops out of the counts |
| 8 | Head, Mechanical | **Placement Pipeline** | Only Mechanical's statistics; Civil never named |
| 9 | Faculty | Open the statistics by URL | 403 |

## J9 — Nominate eligible students for a drive

**Precondition:** an approved, open drive (I-D) for a job whose eligibility rules use academic records
(for example a minimum CGPA); 40 ME students eligible, some not, some unknown.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Placement officer | Drive details → **Nominations → Nominate students → Eligible list** | Each student *Eligible*, *Does not meet a rule* or *Cannot confirm yet*; nothing about applications or offers |
| 2 | Placement officer | **Choose every eligible student shown** (40), reason `MEETS_ELIGIBILITY` | 40 nominated; others skipped and listed |
| 3 | Recruiter | Applicants for the job; the drive | Empty; 0 applications; no student named |
| 4 | Student 0001 (web) | **Applications → Nominations from your college → Review and decide → Opt in and share my profile** | Application created, tagged "Nominated by <college>" |
| 5 | Recruiter | Applicants | Student 0001 only, source "Nominated by placement office" |
| 6 | Student 0002 (Android) | **Decline** | Recorded; the recruiter never sees 0002 |
| 7 | Placement officer | **Nominated students** | 0001 *Opted in*; 0002 and silent students both *Not opted in* (indistinguishable); summary groups under 5 read `<5` |
| 8 | Placement officer, Mechanical | Try to nominate | Refused — nominating needs a whole-college placement role |
| 9 | Placement officer | **Withdraw nomination** for an unanswered student, `NOMINATED_IN_ERROR` | Withdrawn; the student sees "Your college withdrew this nomination" |
| 10 | Student 0001 | Withdraw the application | The nomination is withdrawn; the employer loses access on its next request |

## J10 — Faculty sees students stuck and assigns a practice set

**Precondition:** `faculty.me` assigned to ME-3A; at least one practice set published through the
operations content flow on this environment.

**Blocked part (HG-6):** "sees students stuck" needs students who hold the adaptive-learning consent.
No engine consent definition is published (its wording awaits legal review), so on every environment
the cohort view reads NA. Steps 1–2 record that honest state; steps 3–8 run now. To exercise the stuck
view before HG-6, an engineer can seed a synthetic definition on a **local** database as
`institution-learning-cohort.integration.spec.ts` does — never on a shared staging database, never on
production.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty | **My Students → Learning across your students** | NA explanation (no consent offered yet); no figures, no names |
| 2 | Head, Mechanical | Same read by URL | 403 (lecturers only) |
| 3 | Faculty | **Learning Resources** → search the practice set → **Assign** to *A class you teach* ME-3A | Assigned; students told in the app |
| 4 | Student 0001 | **Learning → From your lecturer** (web and Android); plan the next step | The assigned work comes up as the next step |
| 5 | Faculty | **Set as a student's next step** for 0002: Practise, reason "A prerequisite needs attention first" | *Waiting for the student*; a second one for 0002 is refused (withdraw first) |
| 6 | Faculty | **Plan a group session** for ME-3A tomorrow | A meeting on the lecturer's Calendar; attendees see title, time and content, not the staff note |
| 7 | Tester | Compare skill-state, evidence and readiness rows before and after steps 3–6 | Unchanged — no faculty action changes a mastery value |
| 8 | Faculty (control) without an assignment | **Assign** | Refused: "You need an active teaching assignment…" |

## J11 — Preparation sprint by role

**Precondition:** a published career role (for example "SOC Analyst L1") with essential requirements;
seeded students with evidence dated last month; a published practice set or lesson on one essential
requirement; optionally a live campus drive whose job maps to the role.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Placement officer | **Readiness → Cohort readiness by career role**: choose the role (or the drive naming it) | Each essential requirement shows Met / Partly there / Not yet / Too little evidence / No evidence yet, with gaps and unknowns; any group under five reads `<5`; no score, percentage or student name; "as at the end of <last month>" |
| 2 | Placement officer | Choose the current month | Refused: "Choose a whole calendar month that has ended" with a reference |
| 3 | Placement officer | On a requirement with published content, **Run a sprint**: the practice set, 14 days, reason "Preparing for a campus drive" | "Sprint started for N students until <date>" (N `<5` when under five); students with gaps told in the app |
| 4 | Student with a gap | **Learning** | "From your college" shows the work with its end date; planning a step brings it up |
| 5 | Placement officer | Next day, **Preparation sprints** | Reached, *Now meet it* / *New evidence, not yet met* / *Nothing new yet*, work done — counted to the start of the day |
| 6 | Faculty | Open the same URL | Forbidden; lecturers stay on My Students and Learning Resources |
| 7 | Head, no department | **Run a sprint** | Refused `SCOPE_REQUIRED` |
| 8 | Placement officer | **End early…** with a reason | "Sprint ended"; the work leaves the students' Learning page |
| 9 | Placement officer | Android: institution home | "Readiness by career role" and "Preparation sprints" show the same counts, read-only |

## J12 — College offboarding dry run

**Precondition:** `UAT Arts College` used only for this script, with students, staff, an assessment, a
counselling note and a verification decision. Never use a college someone else is testing with.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Organizations → College exits → Dry run** | Per-table counts to delete and keep; legal-hold status; nothing deleted |
| 2 | Operator | **Record exit notice**, `CONTRACT_ENDED` | Notice open; the college can no longer add students (plain refusal) |
| 3 | Other college's owner | **Settings → Leaving ONE → Exit export**: each section with a reason | CSV files; no counselling note in *staff actions*; no student-owned data (applications, readiness, pay, documents); each download audited and counted in the 30-a-day limit |
| 4 | Other college's admin | Same screen | Reads the notice; cannot export (owner only) |
| 5 | Other college's owner | Counselling notes: tick "I am asking for the college's restricted counselling notes", choose a listed reason | Released under its own audit action |
| 6 | Operator | **End…**, `NOTICE_PERIOD_COMPLETE` | Relationships and staff memberships end; pending invitations withdrawn; activated students get the in-app notice |
| 7 | Arts staff | Next request | No longer in the college |
| 8 | Arts student | Sign in | Account, verified records and own data intact; "Left <college> on <date>" |
| 9 | Operator | **Cancel exit…**, `ENTERED_IN_ERROR` | Every link and membership restored exactly; withdrawn invitations not revived |
| 10 | Operator | End again; **Request deletion…** before 90 days | Refused (retention period) |
| 11 | Engineer (local database only) | Move the clock past 90 days as the integration spec does; request deletion; approve as `ops.super`; execute | Deleted as the dry run listed; units, relationship history, academic records, drives and nominations kept; counts stored on the exit |

---

## I-S — Settings, grading scales, calendar (INST-05)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Settings → Grading scales**: B.E. Mechanical = CGPA out of 10, pass mark 5 → **Save scale** | Saved; audit |
| 2 | College admin | View B.E. Civil | Scale **NA** — never a guessed default |
| 3 | College admin | **Academic calendar**: add "2026 Odd semester" with dates | Listed; faculty Calendar shows it |
| 4 | College admin | Try to change the legal name (API) | Refused `INSTITUTION_PROFILE_FIELD_OPERATIONS_CONTROLLED` |
| 5 | Head, Mechanical | **Settings** | Read-only college settings; own notification preferences editable |
| 6 | Placement officer | Look for Settings | No Settings item (unchanged navigation) |

## I-C — Consent gate (ENG-01, as a student meets it)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Student 0001 | First sign-in | A "checking" state, then the consent screen or the workspace — never the workspace before the check completes |
| 2 | Tester | Make the consent check fail (stop the API briefly) on web and on Android | Web stays on the checking/error state; Android shows "We could not confirm your privacy consent" with retry — neither opens the workspace |
| 3 | Operator | **Security → Consent coverage** | `adaptive-learning`, `ai-tutoring`, `model-improvement` show **Not published** (HG-6); other counts under 5 show **<5** |

## I-X — Analytics access and CSV exports (INST-08)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Reports → Exports**, roster, without access | Refused: "You do not have analytics and exports access…"; audited `institution.export.denied` |
| 2 | College admin | **Staff → Analytics and exports access**: grant to self | Refused (nobody can grant themselves) |
| 3 | College owner | Grant to `college.admin` ("Responsible for college reporting") and to `hod.me` ("Reports for their department") | Granted; audited |
| 4 | College owner | Try to grant to the placement officer or a lecturer | Not offered / refused |
| 5 | College admin | Export the roster; open it in a spreadsheet | One row per current student; a test student whose name begins with `=` shows as text, not a formula |
| 6 | College admin | Readiness band distribution for the current month | Refused: "Choose a month that has ended…" |
| 7 | College admin | Readiness band distribution for last month | Bands only; any band under 5 shows `<5`; a total that would reveal one is withheld |
| 8 | Head, Mechanical | Export the roster; then with **Unit** = CE-2A | Mechanical only; CE-2A refused "That unit is outside the students you can export." |
| 9 | Head, no department (granted) | Any export | Refused: "Exports need a department…" |
| 10 | College admin | Staff-action summary for last month | Counts only; no titles, notes or counselling notes |
| 11 | College admin | 31st export within 24 h | Refused (limit of 30) |
| 12 | College owner | Remove `hod.me`'s access, "Periodic access review" | The head's next export refused |

## I-P — Placement status and sharing (INST-09)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Student 0001 | Apply to a job, tick *Also share this application … with my institution* | Applied and shared |
| 2 | Student 0002 | Apply without ticking; later **Share with institution** on the application | Shared from then on |
| 3 | College admin | **Placement → Placement status by student** | 0001 and 0002 *Applied*; 0003 *Nothing shared*, with the note that it does not mean "not applied" |
| 4 | College admin | **View shared applications** for 0001 | Employer, role, stage, dates, offer existence and response; no pay |
| 5 | Recruiter | Prepare an offer for 0001 without sending it | 0001 is still *Applied* (a draft is not an offer) |
| 6 | Student 0001 | **Stop institution sharing** | 0001 *Nothing shared* on the next load |
| 7 | Faculty | Open placement status by URL | 403 |
| 8 | Placement officer, Mechanical | **Students** | Only Mechanical students' statuses |
| 9 | Tester | Audit | `institution.placement_status.listed` per list load; `institution.student_applications.read` per per-student read |

## I-Y — Year-end actions (INST-10)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Students → Year-end actions**: Graduate, *Everyone in a batch or unit* ME-2023, today → **Preview** | Each row *Will change*; already-ended students *Already left — no change* |
| 2 | College admin | Graduate a list including an unknown roll number → **Preview** | That row *Cannot change — Not on your roster*; **Commit** disabled |
| 3 | College admin | Effective date tomorrow | Refused: the date cannot be in the future |
| 4 | College admin | Preview ME-3B, change one of its students' relationship separately, then **Commit** | Refused: the preview is stale; nothing changed |
| 5 | College admin | Preview again, reason "Completed the programme", **Commit N changes** | Exactly N graduated; audited per student with the reason |
| 6 | Graduate | Sign in (web and Android) | Keeps the account and records; sees they graduated; can still request verification of a past term |
| 7 | College admin | Students | Graduates on the roster with the new state and date |
| 8 | Head, Mechanical | Year-end actions | Not available (owners and administrators only) |

## I-A — Accreditation outcomes (INST-13)

**Precondition:** I-Y graduated a batch last month; I-X granted access; some graduates shared an
accepted offer; run after the month end.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Graduate A | **Profile → After college**: higher studies, share | Shared; marked self-reported |
| 2 | Graduate B | Same with entrepreneurship, then **Withdraw** | Withdrawn |
| 3 | College admin | **Reports → Exports → Accreditation outcomes**, reason "Accreditation preparation" | First rows say ONE does not claim any template; one row per department × programme × year; placed, higher studies, entrepreneurship (self-reported), no outcome shared; `<5` under five; salary column `NA` in every row |
| 4 | Tester | Compare Placed with the placement statistics for the same graduates | Equal |
| 5 | Tester | Search the file | No name, roll number, email, internal id, readiness or pay |
| 6 | Head, Mechanical (with access) | Same export | Mechanical rows only |
| 7 | Placement officer; owner | Same export | Refused (neither can hold analytics access) |

## I-D — Campus drive approvals, placement policy, categories (EMP-11, INST-12)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Settings → Drive categories**: add "Core", order 1 | Listed; employers and students never see it |
| 2 | Placement officer | **Dashboard → Placement policies → One offer per student**, allow exceptions → **Put this policy in force** | In force |
| 3 | Recruiter | Request a campus drive at `UAT Engineering College` (employer UAT) | The request appears under **Campus drive approvals** |
| 4 | Placement officer | **Ask for changes**, "Schedule change needed" | Employer asked to revise; students see nothing |
| 5 | Placement officer | After resubmission: **Approve**; set the category Core; **Set date** | Students see the job through the drive |
| 6 | Student holding an accepted offer | Apply through the drive | Refused by the one-offer policy |
| 7 | Placement officer, Mechanical | Try to decide | Refused — needs a whole-college placement role |
| 8 | Head, Mechanical | Try to define a category (API) | Refused |
| 9 | Placement officer | **Mark complete** | Results counted; only shared applications named; `<5` under five; no pay |
| 10 | College admin | Retire "Core", `NO_LONGER_USED` | Retired; cannot be edited or deleted |

## I-T — Assessments (pre-plan module)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty | Create subject "Thermodynamics"; draft three questions; **Submit for review** | *Awaiting senior review*; no Approve for the lecturer |
| 2 | Head, Mechanical | **Approve** the questions | Approved |
| 3 | Faculty | **Create assessment** (Unit Test, window, 30 min, 1 attempt, 3 questions) | Draft |
| 4 | Head, Mechanical | **Publish** | Published |
| 5 | Faculty (assigned to ME-3A) | **Assign students**, including a CE-2A student | Only ME-3A students assigned; audited `institution.assessment.assigned` |
| 6 | Faculty (control) without an assignment | Assign | Refused `SCOPE_REQUIRED` |
| 7 | Student 0001 | Take it (web, or the Android Exams tab) | Result recorded |
| 8 | Faculty | **Results**; **Assessment Detail** | Only in-scope students; class average withheld under five results |
| 9 | Head, Mechanical | **Reopen / Extend** by 60 minutes | Window extended |

## I-W — Interventions, tasks, notes, meetings (pre-plan module)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty | **Interventions → Assign Intervention** for 0001 | Only students in scope offered; draft saved |
| 2 | Faculty | **Submit for review** | Under review; the lecturer cannot approve |
| 3 | Head, Mechanical | **Approve**; the lecturer then **Start**s and **Complete**s with an outcome note | Completed; each step versioned |
| 4 | Faculty | **Assigned Tasks**: a task for 0001; **Student Detail**: a faculty note | Listed; staff only |
| 5 | Student 0001 | Their workspace | Never sees the staff-only note or task |
| 6 | Head, Civil | Open 0001's records by URL | 403 |
| 7 | Head, Mechanical | **Meetings**: a staff meeting with no student | Saved; on the Calendar |
| 8 | Tester (API) | POST a `COUNSELLING_NOTE` through `/staff-actions` | 400 — counselling notes have their own restricted route |

## Results

| Script | Date | Environment | Result | Notes / references |
|---|---|---|---|---|
| J1 | | | | |
| J2 | | | | |
| J3 | | | | |
| J4 | | | | |
| J5 | | | | |
| J6 | | | | |
| J7 | | | | |
| J8 | | | | |
| J9 | | | | |
| J10 | | | | |
| J11 | | | | |
| J12 | | | | |
| I-S | | | | |
| I-C | | | | |
| I-X | | | | |
| I-P | | | | |
| I-Y | | | | |
| I-A | | | | |
| I-D | | | | |
| I-T | | | | |
| I-W | | | | |
