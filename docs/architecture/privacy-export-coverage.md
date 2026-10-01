# Privacy Export Coverage — Design

**Status:** Adopted (fix `fix/privacy-export-coverage`), recommended options taken per AGENTS.md ("ask once, recommend, carry on").
Deletion gaps decided by Divakar and implemented in `fix/privacy-deletion-decisions` (migration 0087): see "Deletion decisions".
**Date:** 2026-09-30
**Migration:** none. No CHECK has to change: every new export section is a read, and every deletion fix
below lands in an existing category (`STUDENT_PROFILE`, `NOTIFICATIONS`, `IDENTITY`).
**Rule:** Written before the code, per the migrations rule in `AGENTS.md`

## Why this exists

The student's data export (`apps/api/src/http/privacy-export.ts`) is how ONE honours the DPDP right of
access: one JSON file with everything the platform holds about the person. It was written in OPS-06 and
extended one table at a time (counselling notes in INST-11, messages in EMP-10, screening in EMP-12).
Every goal since then that added a personal table said, in its own design, that the export "is not
extended in this goal": learner goals (0068), outcome declarations (0083), nominations (0080), external
applications (0019), the engine's attempt log and projection (0047, 0052), and more. The result is an
export that silently omits most of what a student has done on ONE since August.

This note audits every table that holds data about a student and records, for each, whether the export
now includes it and — where it does not — why not. It also checks privacy deletion
(`apps/api/src/http/privacy-deletion.ts`) against the same list.

## The rules every section follows (unchanged from the existing sections)

1. **The subject's own data only.** Every query filters on the subject's user id, directly or through a
   row that does (their application, their attempt, their qualification). No other student appears.
2. **No other person's identity.** A staff member, recruiter or nominator appears as their organisation
   and, where the student already sees it, their role — never a name, email or user id.
3. **No answer keys**, no per-item correctness on anything whose question text is exported, and no
   question papers of tests that are reused (college exams, readiness checks).
4. **No model numbers presented as facts.** Bands, stages, counts and dates the student already sees
   are included. The engine's working estimates — mastery likelihood and uncertainty, review stability
   and difficulty, item difficulty and discrimination, the planner's recorded inputs, suspected
   misconception codes — are not, and `notIncluded` says so.
5. **No internal identifiers** beyond what the export already exposed (the subject's own user id, the
   ids of their documents and applications). New sections are keyed by names, titles and times.
6. **Staff-only text is counted, not shown**, exactly as counselling notes (ADR-036).

## Audit

"Included" names the export key. Deletion column: what `executeOne` does to the rows today, after this fix.

### Identity, consent and account

| Table | Export | Deletion |
|---|---|---|
| `users` (0001) | `identity` (existing) | IDENTITY — anonymised |
| `user_consents` (0014, 0028) | **`consents`** — key, title, version, granted/withdrawn, when | CONSENT_RECORDS — **retained** as proof of consent under the anonymised account, with a stated basis (decision D3 below). Nothing else about the person is kept with them. |
| `notification_preferences` (0004) | **`notificationPreferences`** | NOTIFICATIONS — erased (existing) |
| `user_notifications` (0013) | **`notifications`** — kind, title, body, sent, read. The `data` payload is internal references and is left out | **Fixed:** NOTIFICATIONS now erases them. They were left behind; their text names employers, jobs and interview times. |
| `device_push_tokens` (0013) | **`devices`** — platform, registered, last seen, revoked. Never the token (a credential for the device) | **Fixed:** NOTIFICATIONS now erases them. A device identifier outlived the account. |
| `invitations` (0001, 0037) | **`invitations`** — organisation, kind, state, the address it was sent to, sent/accepted | **Fixed:** IDENTITY now replaces the email on invitations addressed to or accepted by the person with the anonymised address. The real address survived there. |
| `privacy_requests` (0009) | `privacyRequests` (existing) | Retained (the request is the record of the deletion) |
| `data_retention_holds` (0009) | Excluded: a hold is placed for an investigation or a legal claim, and disclosing it can prejudice that. Listed in `notIncluded` | Blocks deletion while active (existing) |
| `audit_events` (0001) | Excluded (existing): security audit, retained under the schedule | AUDIT — retained |
| `support_cases` (0043) | **`supportCases`** — channel, category, state, opened/resolved/closed. The summary an operator typed and the case notes are operations' working notes, excluded like staff-only notes | SUPPORT_CASES — anonymised (existing) |

### Profile and records

| Table | Export | Deletion |
|---|---|---|
| `student_profiles` (0006) | `studentProfile` (existing) | STUDENT_PROFILE — erased |
| `student_career_targets` (0011) | **`careerTargets`** — role, priority, chosen, cleared | STUDENT_PROFILE — erased (existing since ENG-19) |
| `career_gap_snapshots`, `career_gap_items` (0011) | **`careerGaps`** — role, requirements total/met/unknown, computed, superseded, and each requirement's topic, level, status and rank from `career_gap_items` (counts and statuses, not the mastery values compared) | **Fixed:** STUDENT_PROFILE now erases them (items first) with the targets they were computed for. |
| `learner_goals` (0068) | **`goals`** — type, role/topic/catalogue goal, priority, status, origin, discovery answers, college, started, ended | STUDENT_PROFILE — erased (existing) |
| `student_outcome_declarations` (0083) | **`outcomeDeclarations`** — college, outcome, declared, withdrawn | STUDENT_PROFILE — erased (existing) |
| `talent_pool_listings`, `talent_pool_listing_evidence`, `talent_pool_blocks` (0098, EMP-14) | **`talentPool`** — each opt-in (joined, left, why, consent version), what the card showed (branch/year ticked, cities, each evidence item's skill, type, source, date, unaided, shown, removed), blocked employers by name, and the employers who opened the card (from the audit rows, employer name only) | STUDENT_PROFILE — erased. The live listing is ended (`ACCOUNT_DELETION`) first, with the grants. A listing an answered invitation points at stays, ended and emptied. |
| `talent_pool_invitations` (0098, EMP-14) | **`talentPool.invitations`** — employer, job, sent, expires, state, answered | Unanswered: erased with STUDENT_PROFILE. One that became an application stays with the anonymised application (APPLICATIONS). |
| `student_resumes`, `student_resume_versions` (0101, RESUME-GEN) | **`resumes`** — each generated résumé's title and dates, and every saved version's number, template, date and full content (the words and labels drawn). Never the selections (record ids) or the hash | STUDENT_PROFILE — erased, versions first. Nobody but the student reads these tables. |
| `external_applications` (0019) | **`externalApplications`** — every field the student typed, the college-sharing grant/revoke times | **Fixed:** STUDENT_PROFILE now erases them. They are only the student's own declarations and were left behind entirely. |
| `student_qualifications`, `student_academic_terms`, `student_academic_subjects` (0070) | **`academicRecords`** — each qualification with its terms and subjects, source, verification state and time. Never who verified | **Fixed:** STUDENT_PROFILE now erases them. Left behind before; worse, a `DOCUMENT_BACKED` term references a document version, so the document step failed and the whole deletion ended `FAILED`. See decision 2. |
| `student_document_metadata`, `_versions`, `stored_files` (0006, 0008) | `documents` (existing) | DOCUMENTS — erased |
| `public_profile_links` (0071) | **`publicProfile.links`** — cover, what each link shows, created, expires, revoked, last viewed. Never the token digest | **Fixed:** STUDENT_PROFILE now erases them. |
| `student_profile_photos` (0071) | **`publicProfile.photo`** — type, size, uploaded (metadata, as documents) | **Fixed:** STUDENT_PROFILE now deletes the bytes and the row. The public photo route does not check the account state, so a live link with the photo shown kept serving a deleted person's photo. |
| `institution_relationships`, `institution_student_profiles` (0000, 0005) | `institutionRelationships`, `institutionRecords` (existing) | INSTITUTION_ROSTER — anonymised |

### Hiring

| Table | Export | Deletion |
|---|---|---|
| `applications`, `offers` (0007) | existing | APPLICATIONS, OFFERS — anonymised |
| `application_profile_snapshots` (0007, 0058) | **`applicationSnapshots`** — for each application, what was shared with the employer (the frozen snapshot, which holds no internal ids and is the only copy of the phone number the student typed), when, and whether it has been erased | Erased in place with APPLICATIONS (existing, EMP-07) |
| `application_state_history` (0007) | **`applicationHistory`** — each move (from, to, when). Not the employer's note or reason code, which the employer wrote for its own team (the rule of `GET …/feedback`) | Retained with the application |
| `opportunity_term_change_acknowledgements` (0007) | **`jobTermChanges`** — notified, acknowledged, declined | Retained with the application |
| `interviews` (0007, 0059, 0063) | **`interviews`** — employer, job, round, mode, state, times, place, link, preparation note (as the student sees them) | Retained with the application |
| `interview_participants`, `interview_outcomes`, scorecards (0007, 0063) | Excluded (existing): the employer's assessment | Retained with the application |
| `application_feedback_releases` (+ reasons) (0035) | **`feedbackReleased`** — employer, job, note, reasons as labelled for the student, when | Retained with the application |
| `application_eligibility_evaluations` (0054) | Excluded: the employer's screening of the application against its rules, like scorecards | Retained with the application |
| `employer_applicant_access_grants` (0000) | **`employerAccess`** — which employer, granted, expires, revoked. The person's record of who could see them | Revoked first (existing) |
| `application_evidence_shares` (0093, EMP-13) | **`evidenceShares`** — employer, job, skill, evidence type and source, recorded, unaided, how and when shared, when and why revoked. No evidence identifier, no marks | Every live share revoked (`ACCOUNT_DELETION`) with the grants; rows retained as the record of consent |
| `application_resume_download_links` (0058) | Excluded: which employer member downloaded the résumé names another person. Listed in `notIncluded` | Retained (the stored file is deleted) |
| `application_message_threads`, `application_messages` (0067) | `applicationMessages` (existing) | APPLICATION_MESSAGES — erased |
| `employer_assessment_*` (0036, 0077) | `screeningAssessments` (existing) | EMPLOYER_SCREENING — anonymised |
| `campus_drive_nominations` (0080) | **`campusDriveNominations`** — college, employer, job, nominator's role, reason, note, state, when, answered, cancelled and why. Never who nominated | Unaccepted: erased; accepted/withdrawn: kept with the application (existing) |
| `hiring_notification_deliveries` (0059) | Excluded: a delivery log; the in-app copy is in `notifications` | Retained (the notification it points at is erased; the FK is `ON DELETE SET NULL`) |
| `trust_cases` reported by the person (0032, 0067) | Not a separate section: `applicationMessages[].messages[].reportedByYouAt` already records each report. How operations handled it stays excluded (existing `notIncluded`) | Retained (a case outlives the reporter) |
| `trust_cases` about the person, `trust_case_*` | Excluded: investigation material, and disclosing a report about someone can identify the reporter | Retained |
| `trust_case_employer_statements`, `employer_terms_*` (0084) | Not student data (0084 design) | — |

### College

| Table | Export | Deletion |
|---|---|---|
| `staff_actions` COUNSELLING_NOTE (0060) | `counsellingNotes` (existing) | COUNSELLING_NOTES — erased |
| `staff_actions`, other types (0020) | **`collegeActions.shared`** — interventions, tasks, notes and meetings the college made visible to the student (title, note, state, dates). **`collegeActions.heldByCollege`** — how many staff-only actions of each type each college holds, never their text | Staff-only actions about the person: STAFF_ACTIONS — **text erased**, skeleton row kept (decision D1 below). The evidence-document link is cleared first, because an `ACADEMIC_VERIFICATION` action pointing at a document version made the document step fail. Actions the college made visible to the student keep their text (outside the decision; see "Still open"). |
| `counselling_case_participants` (0060) | Excluded: which staff memberships follow the case names other people | Erased (existing) |
| `learning_assignment_students` + `learning_assignments` (0082) | **`fromYourLecturers.assignments`** — college, kind, what, skill, note, assigned, withdrawn | LEARNING_ACTIVITY — erased (existing) |
| `learning_plan_overrides` (0082) | **`fromYourLecturers.nextSteps`** — college, action, what, skill, reason, note, state, applied, withdrawn | LEARNING_ACTIVITY — erased (existing) |
| `staff_action_attendees` (0082) | **`fromYourLecturers.sessions`** — college, title, time, state, invited | LEARNING_ACTIVITY — erased (existing) |
| `institution_announcement_recipients` (0046) | Excluded as a table: a delivery log; the announcement's in-app copy is in `notifications` | Retained (college's send log; the notification is erased) |
| `exam_assignments`, `exam_attempts`, `exam_results` (0012) | **`collegeExams`** — exam, subject, college, attempt number, status, times, auto-submitted, focus-loss count; the result only once the college has published it. Not the paper or the answers (the question pool is reused) | Retained under the anonymised account: the college's assessment record. See the reported gaps. |
| `exam_attempt_questions`, `exam_answers`, `exam_screen_events` (0012) | Excluded: the paper is secured content reused across students; the focus-loss count is summarised in `collegeExams` | Retained with the attempt |

### Learning engine

| Table | Export | Deletion |
|---|---|---|
| `learning_sessions` (0047) | **`learning.sessions`** — mode, language, start, end. Not model/prompt/token/cost columns (internal metering) | LEARNING_ACTIVITY — erased |
| `learning_attempt_events` (0047, 0052) | **`learning.attempts`** — when, context, skill, answered, correct, assisted, highest hint, response time. Not the item, the selected option or the misconception codes (item + selection + correctness is an answer key) | LEARNING_ACTIVITY — erased |
| `learner_activity_events` (0015) | **`learning.activity`** | LEARNING_ACTIVITY — erased |
| `learner_progress` (0004) | **`learning.lessons`** — lesson, state, started, completed | LEARNING_ACTIVITY — erased (decision D2) |
| `learning_decisions` (0053) | **`learning.steps`** — when, what the planner chose, skill, reason codes, adaptive or not. Not the recorded inputs (the planner's working numbers) | LEARNING_ACTIVITY — erased |
| `learning_step_items` (0072) | **`learning.steps[].items`** — position, skill, highest hint shown, when served. Not the question | LEARNING_ACTIVITY — erased |
| `tutor_hints` (0107, ENG-22) | **`learning.steps[].aiTutorHints`** — level, language, outcome, the AI hint text when it was shown, model and prompt version, review state, times. A refused reply and the guard's findings are staff working notes, listed in `notIncluded` | LEARNING_ACTIVITY — erased (before the step items) |
| `placement_tests` (0064) | **`learning.placementTests`** — scope, state, times, the level shown to the student, items answered, why it stopped | LEARNING_ACTIVITY — erased |
| `placement_test_items` (0064) | Excluded: which calibrated items were served, with their difficulty and discrimination — model parameters | LEARNING_ACTIVITY — erased |
| `learner_skill_state` (0052) | **`learning.skills`** — skill, attempt and success counts, days, last attempt, evidence stage and band, next review date. Not mastery likelihood/uncertainty, review stability/difficulty or misconception codes (rule 4) | LEARNING_ACTIVITY — erased (rebuilt empty) |
| `evidence_records` (0004, 0050) | **`learning.evidence`** — type, topic, demonstrated of possible, assisted, stage at capture, when | ASSESSMENT_EVIDENCE — anonymised (existing) |
| `mastery_projections` (0004) | **`learning.topicBands`** — topic, band, when | LEARNING_ACTIVITY — erased (decision D2) |
| `readiness_snapshots`, `readiness_factors` (0004) | **`learning.readiness`** — the advisory band and when. Never a number; `advisory`/`employer_visible` are constants | LEARNING_ACTIVITY — erased, factors first (decision D2). A plain DELETE; no CHECK is touched |
| `roadmap_actions` (0004) | **`learning.roadmap`** — action, topic, reason, state, due, created, completed | LEARNING_ACTIVITY — erased (decision D2) |
| `assessment_assignments`, `assessment_attempts` (0004) | **`learning.readinessChecks`** — check, state, started, submitted, correct of possible (the score the student is shown on submitting) | LEARNING_ACTIVITY — erased (decision D2). The 0004 guard freezing a submitted attempt gains one exception in 0087: DELETE inside the privacy-erase transaction for that subject |
| `assessment_attempt_items`, `assessment_responses` (0004) | Excluded: the readiness check's items are reused; responses carry correctness | LEARNING_ACTIVITY — erased with their attempt (they reference it) |
| `ai_generations` (0033) | Excluded: metering only (feature, model, tokens), no content; AI is held (ADR-030) so the table is empty | Retained |

### Not about a student

Staff-side tables that carry a user id for the actor (`*_by_user_id`), operations tables
(`access_review_*`, `incident_*`, `operation_approvals`, `feature_flag_*`, `membership_capabilities`,
`external_review_assignments`, `faculty_teaching_assignments`) and content tables. A staff member's own
export is out of scope here: the route is `/students/me/…`.

### Growth (GROWTH-03, `growth-leads-table-design.md` §6)

| Table | Export | Deletion |
|---|---|---|
| `growth_staff_types`, `growth_team_members` (0091), `growth_territory_assignments` (0099), `growth_leads` (0100) | **`growthWork`** — a growth staff member's own staff type, teams, territory assignments and the leads they created or own (organisation, kind, stage, source, dates). Empty for everyone else. Never a lead contact's details | Retained: work records about organisations; the reference to an erased user then names nobody (the `users` row is anonymised by IDENTITY) |
| `growth_lead_contacts` (0100) | **Not in any user's export:** the people in it are not ONE users. Their access request is answered from **Operations → Privacy → Growth lead contacts** (lookup by email or phone, audited by reference and key hash), which returns everything held about them | Erased on request from the same console (`PRIVACY_REQUEST`, fields nulled by CHECK), by the owner or manager, and by the daily retention sweep 24 months after the lead's last activity (`RETENTION_EXPIRED`, D12) |
| `growth_activities` (0103, GROWTH-06, `growth-field-work-table-design.md` §6) | **`growthWork.fieldActivities`** — the author's own visits, calls, meetings and notes (organisation, kind, outcome, the contact met by role only, notes, device and server times) with each visit's **location while it is still held** | The **location** is erased when the author's account is erased (`ACCOUNT_ERASED`, a step of the deletion run with no category of its own), by the author at any time (`AUTHOR_REMOVED`) and by the daily sweep 180 days after the visit (`RETENTION_EXPIRED`, O-23). The row is retained as AI8HT's record of work on an organisation; its notes are erased with the lead's contacts after 24 months |
| `growth_follow_ups` (0103) | **`growthWork.followUps`** — follow-ups the person created or was assigned (organisation, due date, title, state) | Retained; the title is erased with the lead's contacts after 24 months |
| `growth_lead_owner_history`, `growth_lead_stage_history`, `growth_district_imports`, `growth_regions`, `growth_region_areas`, `growth_states`, `growth_districts` | Not personal data (organisations, regions, staff actions by id) | Retained |

## Decisions

1. **One export, extended in place; no new route, no UI change.** Both clients already download the
   bundle as a file. Taken.
2. **Academic records are erased with the profile (recommended, taken).** They are the person's own
   history; the college keeps enrolment under INSTITUTION_ROSTER and its marks in its own system. The
   alternative — keep verified terms as the college's record — leaves a `DOCUMENT_BACKED` term pointing
   at an erased document, which the schema forbids, so it would need the evidence rule relaxed. Rejected.
3. **Staff-only college actions** — reported by this fix; **decided by Divakar on 2026-09-30**: erase
   their text under a new `STAFF_ACTIONS` category (D1 below).
4. **Engine read models without a category** (`learner_progress`, `mastery_projections`,
   `readiness_snapshots`, `roadmap_actions`, `assessment_attempts`) — reported; **decided**: erase under
   LEARNING_ACTIVITY (D2).
5. **Consent records** — reported; **decided**: retain as proof under `CONSENT_RECORDS` (D3).
6. **Results imports recreating records** — reported; **decided**: skip a deleted person (D4).

## Deletion decisions (Divakar, 2026-09-30 — branch `fix/privacy-deletion-decisions`, migration 0087)

Written before the code. Divakar decided the four gaps this note reported. Each is implemented as he
decided it; what follows records what was checked first and what was rejected.

### D1. Staff-only college actions — `STAFF_ACTIONS`, ERASED

**Scope.** Every `staff_actions` row with `subject_student_user_id` = the person and `visibility =
'STAFF_ONLY'`, of any type except `COUNSELLING_NOTE` (already deleted outright under COUNSELLING_NOTES):
interventions, faculty notes, academic verifications, and tasks or meetings the college kept to itself.
Group sessions (0082) carry no subject; the person's invitation to one is already erased under
LEARNING_ACTIVITY and the session, which is the lecturer's, is untouched.

**What is erased.** All free text. `title` becomes the fixed text `Erased: the student deleted their
account` (the column is NOT NULL, so it cannot be emptied), `note` and `outcome_note` become NULL. The
evidence-document link is already cleared. `version` is bumped and `updated_at` set, so an edit form a
member of staff still has open is refused as stale rather than writing the old text back.

**What survives, and why the row is kept.** The skeleton: institution, type, state, visibility, units,
dates, the acting and reviewing staff, and the links to the (anonymised) account and relationship. It is
kept because other things need it:
- structurally: `staff_action_attendees` and `staff_action_content_links` (0082) reference
  `staff_actions(id)`, so deleting an action a content link hangs off would fail on the foreign key, and
  audit rows naming the action's id stay resolvable (AUDIT is retained);
- as the college's own record of what it did, which its counts read by type, state and date: college
  health (OPS-14, `college-health.ts`), the department workspace, the teaching-assignment view, the
  calendar and the institution exports (`institution-exports.ts`). Deleting the rows would rewrite the
  college's history; erasing the text removes everything about the person from it.
No surviving column identifies the person: the account is anonymised and the roster name is `Deleted user`.

**Guards.** `staff_actions` has no append-only trigger (0020, 0060, 0082 checked), so the update needs no
exception. Rejected: deleting the rows (breaks 0082's foreign keys and the college's counts); keeping the
text (it is about the person and is the one part of the row that identifies them).

### D2. Learning history — LEARNING_ACTIVITY, ERASED

Added to the LEARNING_ACTIVITY transaction (the one that sets `one.privacy_erase_subject`), children
before parents: `readiness_factors` of the person's snapshots or projections, `readiness_snapshots`,
`mastery_projections`, `roadmap_actions`, `learner_progress`, `assessment_responses`,
`assessment_attempt_items`, `assessment_attempts`, `assessment_assignments`. Each row counts toward the
category's record count. Self-references (`supersedes_*`) stay within one person's rows and go in the same
statement.

**Who reads these tables, checked first** (every reader found by searching the code for each table name):
- `learner_progress`: INST-17 cohort readiness and preparation sprints (`cohort-readiness.ts`
  `sprintStudentFacts`), INST-16's "done" rule (`faculty-learning-actions.ts`), the public profile and
  career readiness (the person's own). Each is an `EXISTS` per student; the person's lecturer assignments
  are already erased under LEARNING_ACTIVITY, so they are not in a sprint's population at all.
- `mastery_projections`: the BKT shadow report (`bkt-shadow-report.ts`, operator), per student and only for
  holders of the adaptive-learning consent; learning experience (the person's own).
- `readiness_snapshots`, `readiness_factors`, `roadmap_actions`: only the person's own reads (career
  readiness, calendar, career targets, the export). No college or operator aggregate reads them. INST-12
  (placement register) and INST-13 (outcome exports) read applications, placements and outcome
  declarations; OPS-14 reads staff actions, relationships and invitations; INST-17 reads the skill-state,
  evidence and progress facts above.
- `assessment_*`: only the person's own learning-experience reads.
No reader requires these rows, holds a foreign key to them, or stores a total the deletion would falsify.
Erasing a person's rows removes them from every future aggregate and breaks none. Reports a college already
downloaded are its own files and are not touched.

**Guards and CHECKs.** The `readiness_snapshots` CHECKs (`advisory`, `NOT employer_visible`) stay as they
are; a DELETE touches neither. Two guards from 0004 stand in the way, and each gains exactly one
exception, the 0047 pattern (a DELETE inside the transaction whose `one.privacy_erase_subject` names the
row's own subject):
- `assessment_attempts`: `protect_submitted_attempt` refuses to change or delete a submitted attempt, and
  for any other attempt a DELETE silently did nothing (the function returned NEW, which is NULL on
  DELETE). 0087 replaces the function with that behaviour plus the exception.
- `mastery_projections`, `readiness_snapshots`, `readiness_factors`, `assessment_attempt_items`,
  `assessment_responses`: the shared `reject_immutable_row_change` (never change, never delete). The
  shared function is left alone, because `evidence_records` and the content, review and delivery logs
  also use it; for these five tables only, the trigger of the same name now calls
  `reject_immutable_learning_history_change`, identical except for the exception. A child row's subject
  is read from its parent (a factor's snapshot or projection, an item's attempt, a response's item's
  attempt), which the executor deletes after its children. An UPDATE is still always refused.
Outside the setting, and for anyone but the named person, nothing changes. (The first draft of this note
missed the second guard; the deletion test found it by ending FAILED.) `evidence_records` stay ANONYMISED (unchanged), so the evidence the aggregates count survives,
detached.

Rejected: ANONYMISED for these tables (they are derived views of the person's own learning and carry
nothing another party needs; engine data is erased); a new category (LEARNING_ACTIVITY is the declared
home of engine behavioural data).

### D3. Consent records — `CONSENT_RECORDS`, RETAINED

`user_consents` rows stay, linked to the anonymised account, and the deletion record says so with the
basis *"Proof of what you agreed to is kept as a legal obligation: which notice and version, whether you
granted or withdrew it, and when. It is linked only to the anonymised account; nothing else about you is
kept with it."* The count is the person's consent rows.

Each column is what proof needs: `consent_key` and `version` (which text, through `consent_definitions`),
`action` (granted or withdrawn), `recorded_at` (when), `user_id` (to whom, now the anonymised account) and
`correlation_id` (the request that recorded it, which ties the row to the retained audit trail; a random
request id, not personal). Nothing else about the person is in the row, and every other personal table
is erased or anonymised under its own category, so nothing survives alongside the consent beyond the
anonymised account. The rows are append-only by design (0014) and are not modified.
Rejected: erasing them (loses the proof that processing was consented to while the account existed);
cutting the account link (the rows would no longer prove anything about anyone).

### D4. Results imports skip a deleted person

`evaluateResultsImport` reads `users.anonymised_at` with the roster row. A row whose roll number belongs
to a deleted student gets the new outcome **`SKIPPED`** with the issue code **`student_deleted`**. It is
never CREATE or CONFIRM, writes nothing on commit, does not block the other rows (unlike INVALID), and is
counted in `counts.skipped`. It takes precedence over the row's other checks, since nothing will be written
for that person whatever the row says. Scope still applies first: a deleted student outside the
uploader's scope reads as `student_not_found`, like any out-of-scope roll number.

The roster import already cannot reattach: a roll number already on the roster is rejected
(`student_id_already_exists`), a committed row always creates a new account, and the deleted person's
email is anonymised. Year-end batches (INST-10) only end relationships. No change there.

The web results-upload screen gains the outcome's label, the issue's text and the count in its summary
line (strings in the existing maps; no layout, route or navigation change). The Android app has no results
upload.

### Migration 0087

1. The deletion-category CHECK is widened by read-and-union (the 0074/0077 pattern): the live definition is
   read, every value in it is kept, the full list known today is unioned in, and `STAFF_ACTIONS` and
   `CONSENT_RECORDS` are added. The constraint is recreated only when a wanted value is missing, so a
   second run changes nothing.
2. `protect_submitted_attempt()` is replaced as described in D2 (CREATE OR REPLACE; the 0004 trigger keeps
   calling it).
3. `reject_immutable_learning_history_change()` is created and the five learning-history
   `*_immutable_guard` triggers are recreated on it (DROP IF EXISTS, then CREATE), as described in D2.
It references only tables from 0085 or earlier.

### Still open (outside the decisions; reported)

- Staff actions the college made **visible to the student** (`SUBJECT_VISIBLE`) keep their text under the
  anonymised account. They are about the person too, but the decision named staff-only actions.

## Tests

`apps/api/src/http/privacy.integration.spec.ts` seeds every newly exported record for the subject and
for another student, and asserts the subject's appear and the other's do not; that no forbidden field
(token, token digest, model estimates, planner inputs, verifier, nominator) is present; and that
deletion removes the rows fixed above — including a deletion that previously ended `FAILED` on a
document-backed academic term and on a verification action's document link.
