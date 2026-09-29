# ONE Institution Portal — UAT scripts V1 (IM1 slice)

> What this is: executable acceptance scripts for the institution journeys in Appendix 3 §9,
> written for what Wave 1 built (INST-01 to INST-06, and the ENG-01 consent gate as students meet
> it). Why it exists: INST-19 requires a UAT script for every shipped module, and milestone IM1
> exits when "UAT J1–J5 pass on staging with seeded data". Journeys whose features belong to later
> milestones are marked **Not in this slice**. Written 2026-09-26 against base `6864332`.

## Rules for running these scripts

- **Synthetic data only.** `@uat.example.test` accounts, `UAT …` colleges and made-up student
  IDs. Never a real student, mark sheet or college.
- **Environment.** Staging or a local stack with a **non-production** Cognito pool. Imports,
  invitations and uploads are never run against production.
- **Email.** No production sender (HG-7). Locally enable the loopback Mailpit sink to see
  invitations and announcement emails; without it the screens say "not sent", which is correct.
- **Seeding gap.** No committed seed creates students; they are created through the journeys
  below. Platform and first-admin setup follow the operations UAT J1.

## Personas and data

| Persona | Account | Membership in `UAT Engineering College` |
|---|---|---|
| College admin | `college.admin@uat.example.test` | INSTITUTION_ADMIN |
| Head, Mechanical | `hod.me@uat.example.test` | DEPARTMENT_HEAD, department Mechanical (invited in J2) |
| Head, Civil (control) | `hod.ce@uat.example.test` | DEPARTMENT_HEAD, department Civil |
| Faculty | `faculty.me@uat.example.test` | FACULTY_LECTURER (invited in J2) |
| Faculty (control) | `faculty.ce@uat.example.test` | FACULTY_LECTURER, assigned to CE-2A |
| Placement officer | `placement.admin@uat.example.test` | PLACEMENT_ADMIN |
| Other college's admin | `institution.admin@uat.example.test` | INSTITUTION_ADMIN of `UAT Arts College` |
| Students | `uat.student.0001@uat.example.test` … `0200` | created in J1 |

Academic Structure (created by the admin before J1): departments **Mechanical** and **Civil**;
programme **B.E. Mechanical** and **B.E. Civil**; batches **ME-2023** and **CE-2023**; sections
**ME-3A**, **ME-3B**, **CE-2A**. Students 0001–0060 in ME-3A, 0061–0120 in ME-3B, 0121–0200 in
CE-2A.

## Summary

| # | Journey (Appendix 3 §9) | Status in this slice | SOP |
|---|---|---|---|
| J1 | Admin imports 200 students; they activate | In slice (email via local sink; activation of a sample) | [activation](../institution/sop-student-activation.md) |
| J2 | Head for Mechanical and faculty for ME-3A each see only their scope | In slice | [scope and teaching](../institution/sop-staff-scope-and-teaching.md) |
| J3 | Faculty assigned to ME-3A for Thermodynamics; My Students shows exactly ME-3A | In slice | [scope and teaching](../institution/sop-staff-scope-and-teaching.md) |
| J4 | Faculty verifies a semester result; admin uploads a batch's results | In slice (evidence cannot be opened — ADR-027) | [verification](../institution/sop-academic-verification.md) |
| J5 | Department head announces a workshop to ME | **Partly** — the API serves department heads but only faculty have a screen (HG-3); run the faculty variant | [announcements](../institution/sop-announcements.md) |
| J6 | Department head opens every item | **Not in this slice** — most items are empty until INST-07 (see the [screen inventory](../institution/INSTITUTION_SCREEN_INVENTORY.md)) | — |
| J7 | Counselling note | **Not in this slice** — INST-11 | — |
| J8 | Placement register | **Not in this slice** — INST-12 | — |
| J9 | Nominations | **Not in this slice** — INST-14 | — |
| J10 | Faculty assigns a practice set | Built in INST-16 (Learning Resources → Assign; the student's next step on Learning) — to be walked in the next UAT round | — |
| J11 | Preparation sprint by role | **Not in this slice** — INST-17 | — |
| J12 | College offboarding | **Not in this slice** — INST-18 | — |
| I-S | Settings, grading scales and calendar (supplementary) | In slice | [settings](../institution/sop-settings-and-calendar.md) |
| I-C | Student meets the consent gate (supplementary, ENG-01) | In slice (engine purposes unpublished, HG-6) | — |

---

## J1 — Import 200 students; students activate

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | Dashboard | *Student Activation* shows 0 invited / 0 activated (not blank, not invented) |
| 2 | College admin | **Students → Import Students**, paste the 200-row synthetic CSV → **Validate CSV** | 200 accepted, 0 rejected |
| 3 | College admin | Change one row's section to `ME-9Z`, validate | That row rejected ("unknown unit"); **Commit** disabled |
| 4 | College admin | Restore it, validate, **Commit 200 rows** | 200 students listed as *Invited* |
| 5 | Operator / tester | Local Mailpit | Exactly 200 invitation emails, one per student. Without a sink: each shows "Email not sent: no sender is set up yet" |
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
| 6 | College admin | Students | All 200 (199 after J1 step 11) |
| 7 | Tester | Repeat 3–4 for the verification queue and the readiness report | Same scope |
| 8 | College admin | Change `faculty.me`'s scope to batch ME-2023 with `SCOPE_REVIEW` | Saved; audit shows before and after |

## J3 — Teaching assignment drives My Students

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | College admin | **Staff → Teaching assignments → Assign**: `faculty.me`, section ME-3A, subject code `THERMO`, term `2026 Odd`, starts today, reason `NEW_TERM` | Assignment listed |
| 2 | Faculty | **My Students** | Exactly students 0001–0060 |
| 3 | Faculty | Open student 0070 (ME-3B) by URL | 403 |
| 4 | Faculty (control) `faculty.ce` with no assignment recorded yet | **My Students** | *You have no active teaching assignment yet* (the college now uses assignments) |
| 5 | Head, Mechanical | **Faculty and Staff → Assign** `faculty.ce` to CE-2A | Refused (outside the head's department) |
| 6 | College admin | **End assignment** for ME-3A, `TERM_ENDED` | Faculty's next My Students request shows no students |

## J4 — Verification one by one and in bulk

**Precondition:** student 0001 has reported semester 3 as CGPA 8.1 and asked the college to verify
it; student 0002 has reported semester 3 as 7.0.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty (reassigned to ME-3A) | **Academic Verification** | 0001's and 0002's requests listed; none from CE students |
| 2 | Faculty | Evidence on 0001's request | Title, type and version only; no file or link (ADR-027) |
| 3 | Faculty | **Confirm** 0001 | Verified; audit `academic_term.verification_decided` with `MATCHES_INSTITUTION_RECORD` |
| 4 | Faculty | **Reject** 0002 with `DOES_NOT_MATCH_RECORD` → **Confirm rejection** | Rejected; audited with reason |
| 5 | College admin | **Students → Upload results**: ME-3A semester 3 CSV (60 rows; 0002 at 7.4), reason `RESULTS_DECLARED` → **Validate results** | Preview: CONFIRM for 0001, CONFLICT for 0002, CREATE for the rest |
| 6 | College admin | Add a row with scale `CGPA_11`, validate | INVALID row; commit refused; nothing written |
| 7 | College admin | Remove it; validate; commit | Terms verified as *Verified by the institution*; 0002's own reported value kept and flagged |
| 8 | College admin | Commit the same preview again after changing one record | Refused (records changed since the preview) |
| 9 | Tester | **Audit Logs** (operator) for `institution.academic_results` | `previewed` and `imported` rows plus one `verified_by_import` per term |
| 10 | Head, Civil | Upload a file containing ME students | Rows outside Civil refused |

## J5 — Announcement to a scope (faculty variant)

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Faculty (assigned to ME-3A) | **Messages → New announcement**: title "Thermodynamics workshop", message, Send to ME-3A, **Also send by email** | Sent; delivery counts shown |
| 2 | Student 0001 | Notifications (web and Android) | Announcement with sender; email in the local sink |
| 3 | Student 0150 (Civil) | Notifications | Nothing received |
| 4 | Faculty | **Send to** list | Offers only ME-3A; the department and the college are not offered |
| 5 | Faculty | Schedule another for tomorrow, then **Cancel** with `PLANS_CHANGED` | Cancelled; when due, nothing is delivered |
| 6 | Head, Mechanical (API only, HG-3) | POST an announcement to the Mechanical department | Accepted; only ME students receive it. **Record J5 as partly passed until a screen exists** |
| 7 | Faculty | Send a 21st announcement within 24 h | Refused (rate limit) |

## I-S — Settings, grading scales, calendar

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

## Results

| Script | Date | Environment | Result | Notes / references |
|---|---|---|---|---|
| J1 | | | | |
| J2 | | | | |
| J3 | | | | |
| J4 | | | | |
| J5 | | | | |
| I-S | | | | |
| I-C | | | | |
