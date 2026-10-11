# SOP — Data-processing terms, the exit export and a college's exit (runbook)

> What this is: the procedure AI8HT operations and a college's owner follow for the college's
> data-processing terms and for the college leaving ONE — notice, exit export, end, reversal, and the
> deletion of the college's records after the retention period. Why it exists: Appendix 3 INST-18
> ("offboarding runbook and job") and UAT J12. Built by INST-18. Written 2026-09-30; checked
> 2026-10-01 against base `719eb34` (the purge also reaches preparation sprints, 1d26286).
> Design: `docs/architecture/institution-contract-lifecycle-design.md`.

**Legal text.** The only data-processing terms in the repository are
`docs/legal/institution-data-processing-terms-DRAFT-for-legal-review.md` — a draft, with every legal
position left as a placeholder. Publish a version to colleges only after legal review
(`LEGAL_APPROVED`, with the reviewer's reference). A version published as a draft is shown everywhere
as "Draft — pending legal review".

## Who and where

| Who | Where | Does |
|---|---|---|
| Operations (`OPS_ORG_MANAGE`) | **Organizations → Institution data-processing terms** | Publishes a terms version |
| College owner | **Settings → Data-processing terms** | Reads and accepts the current version |
| College admin | **Settings → Data-processing terms**, **Leaving ONE** | Reads only |
| Operations (`OPS_ORG_MANAGE`) | **Organizations → College exits** | Records the notice, ends, cancels, dry-runs, requests the deletion |
| A second operator (`APPROVE_HIGH_RISK`) | **Settings → Approvals** | Approves or rejects the deletion |
| College owner | **Settings → Leaving ONE** | Takes the exit export while the notice is open |

No navigation item was added for any of this; every screen is a section of an existing page.

## A. Data-processing terms

1. Operations publish a version (**Publish version**): version identifier, title, the reviewed text,
   the legal-review state, and whether colleges must accept it. A published version never changes; a
   correction is a new version. The first version always requires acceptance.
2. The college owner reads it under **Settings** and presses **Accept version … for my college**.
   Admins see the status and the text but cannot accept.
3. Until the college has accepted the current material version, **adding a student and committing a
   roster import are refused** ("An owner of your college must accept…"). Nothing already in place is
   paused: students already rostered, their invitations, assessments and staff work continue.
4. A version published without "colleges must accept" (a typo fix) asks nobody again.

## B. The exit runbook

### B1. Before the notice

- Confirm the agreement is ending (the contract reference is on the college's account, OPS-14).
- **Dry run** (below) to see the scale of what the college holds.

### B2. Record the notice

**College exits → Record exit notice**: choose the college and a reason (`CONTRACT_ENDED`,
`COLLEGE_REQUESTED_EXIT`, `NON_RENEWAL`). From now on:

- the college's **Settings → Leaving ONE** says the agreement is ending and, for the owner, opens the
  **exit export**;
- the college can no longer add students.

Tell the owner (outside ONE — outgoing email is not switched on in production) to take the exit
export.

### B3. The owner takes the exit export

**Settings → Leaving ONE → Exit export**, choose a reason, download each section: academic structure,
student roster, staff, teaching assignments, assessments, assessment results, staff actions,
verification decisions. A section over 10,000 rows comes in several files. Every download is recorded
with the reason and counts toward the 30-exports-a-day limit.

**Counselling notes** are not in any of those files. Only if the college must keep them, the owner
ticks "I am asking for the college's restricted counselling notes", chooses one of the listed reasons
(continuity of a student's care, a legal obligation, a regulator's request, the college's records
policy) and downloads them; that release is recorded separately.

The export never contains students' own learning, readiness, applications, offers, pay, messages,
documents, consents or self-reported outcomes.

The **College exits** table shows when the exit export was last taken. Wait for it, or for the notice
period the agreement sets, before ending. Nothing forces the wait: a college that does not answer must
still be able to leave.

### B4. End the college's use of ONE

**End…**, reason `NOTICE_PERIOD_COMPLETE` or `COLLEGE_CONFIRMED_EXIT`, **End now**. In one step:

- every current student link (pending, verified or active) ends today; graduates and transfers keep
  their history exactly as it was;
- every staff membership ends — staff lose the college on their next request;
- every pending invitation (staff and student) is withdrawn;
- the college leaves the institution directory and campus-drive pickers;
- each activated student gets an in-app notice: "<College> has stopped using ONE … Your ONE account,
  your records and your choices stay yours, and results it verified stay verified."

The table shows how many links and memberships ended, and the date the retention period ends
(90 days, decision 10.2 #10).

### B5. Reverse (within 90 days)

**Cancel exit…**, reason `COLLEGE_RENEWED`, `COLLEGE_WITHDREW_NOTICE` or `ENTERED_IN_ERROR`. Every link
and membership the exit ended is restored exactly as it was (only if nobody has changed it since), the
college returns to the directory, and each student whose link came back is told. Withdrawn invitations
are **not** revived — the college resends them from Students. After the 90 days, cancel is refused; a
returning college is a new onboarding.

### B6. Dry run (any time)

**Dry run** lists, per table, how many of the college's rows the deletion would remove and how many
it keeps, and whether a legal hold covers any of its students. It deletes nothing.

### B7. Delete the college's records (after 90 days, two people)

1. When the retention period has passed, **Request deletion…** files an `INSTITUTION_DATA_PURGE`
   approval request (reason `RETENTION_PERIOD_ENDED`).
2. A second operator approves it under **Settings → Approvals** (the solo safeguard applies as for
   every OPS-02 action while only one approver exists).
3. The requester presses **Execute** on the approved request within 24 hours.

The deletion is refused while any student of the college is under a legal hold — release or wait for
the hold first. It removes, in one transaction, the college's roster and roster imports, staff actions
(counselling notes included) and counselling case participants, assessments and everything under them,
teaching assignments, lecturers' learning assignments and plan overrides, announcements and their
recipient lists, settings, grading scales, calendar and stored readiness reports. It **keeps**: the
college's units (names only, no personal data), students' relationship history, students' academic
records and their verification state, campus drives and nominations (joint with employers and
students' applications), and everything that is the student's. The count per table is stored on the
exit and in the audit trail.

### B8. After the deletion

- Remove the college's account contacts through **College health → Contacts** (OPS-14's route erases
  the personal fields), with reason `CONTACT_LEFT` (no exit-specific reason exists; `CONTACT_LEFT` is the closest listed one).
- Nothing else: the exit record, its approvals and audit rows are AI8HT's record of the deletion.

## C. Recorded dry run (seeded data)

The integration spec `institution-contract-lifecycle.integration.spec.ts` runs this whole runbook on a
seeded college (three students — one active, one invited, one graduate; an owner, an admin and a
lecturer; one of every institution-owned record) and pins the dry run exactly:

| Deleted | Rows | Deleted | Rows |
|---|---|---|---|
| institution_student_profiles | 3 | staff_actions | 3 |
| student_roster_imports / rows | 1 / 1 | staff_action_attendees / content links | 1 / 1 |
| counselling_case_participants | 1 | learning_assignments / students / plan overrides | 1 / 1 / 1 |
| preparation_sprints | 1 | | |
| exam_subjects, syllabus nodes, questions, options, versions, reviews | 1 each | exam_definitions, events, sections, section pool | 1 each |
| exam_assignments, attempts, attempt questions, answers, results, screen events | 1 each | faculty_teaching_assignments | 1 |
| institution_announcements / recipients | 1 / 1 | institution_settings, grading scales, academic terms | 1 each |
| exam_subject_topic_links, institution_aggregate_reports | 0 | | |

Kept: institution_units 4, institution_relationships 3, student_qualifications 1,
student_academic_terms 1, organization_memberships 3 (ended). The same run proves: the end changes 2
relationships and 3 memberships and revokes 1 invitation; cancelling restores all 5 exactly; students'
accounts, verified records, external applications and notifications are identical before and after
the end, the cancel and the deletion; another college's rows are untouched; the deletion needs the 90
days, a second person and no legal hold.

## Errors a user may see

| Message | Meaning |
|---|---|
| An owner of your college must accept the current data-processing terms… | Accept under Settings before adding students |
| Your college is leaving ONE, so no more students can be added | An exit notice is open |
| The exit export is available only while an exit notice is open | Ask AI8HT to record the notice |
| The retention period has passed, so this exit can no longer be reversed | Onboard the college again |
| A legal hold covers a student of this college… | Release or wait for the hold, then execute again |
