# Institution screen inventory — IM1 slice

> What this is: every navigation item of every institution role, in the order the sidebar shows it,
> with what it opens on the program base today, which goal built it or will fill it, and what the
> Android app offers. Why it exists: INST-19 asks for this inventory as the evidence for outcome D3 —
> "no navigation item a role can open is an empty view-only state unless its feature is explicitly out
> of scope". Navigation is not changed by this document.

Base: `feat/plan-phases-0-to-2` at `6864332`, read 2026-09-26. Navigation source:
`apps/web/src/rolePortalConfig.ts` (admin `:107`, placement officer `:117`, faculty `:122`, department
head `:136`). Dispatch: `apps/web/src/rolePortalPages.tsx` (dashboard `:194-196`, module pages
`:234-377`). Goal mapping: Appendix 3 §4.2 of the program goal.

**States.** *Working* — a real screen on real data. *Partial* — a real screen, with part of the
module's §4.2 scope still missing and shown as NA or "not built yet". *View-only* — the shared empty
state `AuthenticatedReadOnlyModule` ("View-only for your role", `apps/web/src/rolePortal/shared.tsx:36-41`).
No institution item currently falls through to `AuthenticatedNotYetAvailable` (`rolePortalPages.tsx:377`).

**Android.** One institution workspace serves all four roles (`apps/android/.../StaffDashboards.kt:232`):
Home, Exams and More tabs (`:327-332`). Items are marked "web only" where the phone has no equivalent.
Paths below are shortened to `StaffDashboards.kt` and `AcademicVerification.kt`.

## Institution owner and administrator (`/institution/admin`)

| # | Nav label | State | Component (branch) | Built by / to be filled by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working (readiness widgets NA) — placement KPIs, pipeline funnel and offers trend from INST-12's statistics (<5 withheld) | `InstitutionDashboardV3` (`staffDashboardsV3.tsx`) | INST-01, INST-04, INST-12 built | Home: activation, verification, "Students placed" and the Placement statistics card (`PlacementStatistics.kt`) |
| 2 | Students | Working | `InstitutionStudentsPage` + `AcademicVerificationSection` with upload (`rolePortalPages.tsx:273-281`; `rolePortal/institution.tsx:493`; `institutionAcademicVerification.tsx:20`) | INST-01, 02, 04 built; INST-10 built — Year-end actions panel (`institutionBatchLifecycle.tsx`: graduate, transfer or end a unit or a list of roll numbers, preview then commit) | Activation counts and verification review overlay (`AcademicVerification.kt:132`); roster and year-end actions web only (desk tasks) |
| 3 | Student Detail | Working | `InstitutionStudentsPage` plus INST-09's `PlacementStatusList` (placement status per student, shared applications on request) | INST-01, INST-09 built; INST-10: a graduated student stays on the roster with the new state and end date | Web only |
| 4 | Academic Structure | Working | `InstitutionAcademicStructurePage` (`rolePortalPages.tsx:290`; `institution.tsx:144`) | Pre-plan; no §4.2 goal | Web only |
| 5 | Assessments | Working | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`; `examManagerPage.tsx:30`) | Pre-plan | Exams tab (`StaffDashboards.kt:660`, results `:695`) |
| 6 | Interventions | Working | `InstitutionInterventionsPage` (`rolePortalPages.tsx:292-296`; `pilotParity/institutionInterventions.tsx:44`) + restricted counselling notes section `CounsellingNotesSection` (`rolePortal/institutionCounselling.tsx`) | Pre-plan; INST-11 | Web only (students see shared notes on web and Android) |
| 7 | Staff | Working | `InstitutionStaffPage` (`rolePortalPages.tsx:333`; `institution.tsx:187`) | INST-03 built; INST-08 adds analytics capability grants | Web only |
| 8 | Career Readiness | **View-only** | `AuthenticatedReadOnlyModule` (`rolePortalPages.tsx:339`) | INST-17 | Home "Cohort readiness", NA (`StaffDashboards.kt:399`) |
| 9 | Placement | Working (INST-09, INST-12) — consented placement status, season statistics by department and batch, the register (employers engaged, drive calendar with outcomes and categories), drive approvals, placement-office nominations with student opt-in in each approved drive's details (INST-14) | `InstitutionPlacementPage` (`rolePortal/institutionPlacement.tsx`, `institutionPlacementRegister.tsx`) | INST-09, INST-12, EMP-11 built | Home pipeline and Placement statistics cards; per-student list and register web only |
| 10 | Reports | Partial — readiness band report only | `InstitutionReportsPage` (`rolePortalPages.tsx:334-338`; `institutionReportsPage.tsx:31`) | INST-08, INST-13 (reports, exports, accreditation packs) | Web only |
| 11 | Settings | Partial — profile, grading scales, calendar, placement policies (EMP-11) and drive categories (INST-12) working; data-processing terms "not built yet" | `InstitutionSettingsPage` (`institutionSettings.tsx`) | INST-05, EMP-11, INST-12 built; INST-18 (data terms) | Academic calendar read-only; rest web only |
| 12 | Help & FAQ | Working | `HelpFaqPanel` (`rolePortalPages.tsx:291`) | Pre-plan | More → Help (`StaffDashboards.kt:1096`, `:1332`) |

## Placement officer (`/institution/placement-officer`)

| # | Nav label | State | Component (branch) | Built by / to be filled by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working — placement widgets from INST-12's statistics; sections for drive approvals with categories and nominations (EMP-11, INST-14), placement policies (EMP-11), season statistics and the placement register (INST-12) | `InstitutionDashboardV3` + sections (`rolePortalPages.tsx`) | EMP-11, INST-12, INST-14 built | Home incl. Placement statistics card and each scheduled drive's nomination summary |
| 2 | Assessments | Working | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`) | Pre-plan | Exams tab |
| 3 | Help & FAQ | Working | `HelpFaqPanel` (`rolePortalPages.tsx:291`) | Pre-plan | More → Help |
| 4 | Students | Working | `InstitutionStudentsPage` incl. placement status column (INST-09) and consented applications | INST-01, INST-09 built | Activation counts and status distribution on Home; roster web only |
| 5 | Student Search | Working | Same page | INST-01, INST-09 built | Web only |
| 6 | Readiness | Partial — cohort band report, not by career role | `InstitutionReportsPage` (`rolePortalPages.tsx:315-322`) | INST-17 | Home "Cohort readiness", NA |
| 7 | Departments | Working (read-only by design) | `InstitutionAcademicStructurePage canManage={false}` (`rolePortalPages.tsx:323-332`) | Pre-plan | Web only |
| 8 | Batches | Working (read-only by design) | Same (`rolePortalPages.tsx:323-332`) | Pre-plan | Web only |

The placement officer has no placement item; §4.2 puts the placement register behind a Drives item
(employer plan decision #4) or a Dashboard section. Without a recorded navigation decision (HG-3) the
register and statistics are Dashboard sections (EMP-11, INST-12).

## Department head (`/institution/department-head`)

| # | Nav label | State | Component (branch) | Built by / to be filled by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working | `InstitutionDashboardV3` (`rolePortalPages.tsx:194-196`) | INST-01, 04 | Home |
| 2 | Department Overview | Working (INST-07) — roster, activation, assessments in progress, last month's readiness bands (<5 suppressed), open interventions/tasks, batches, pipeline | `DepartmentOverviewPage` (`rolePortal/institutionDepartment.tsx`) | INST-07 | Home "Department overview", "Cohort readiness" (`DepartmentWorkspace.kt`) |
| 3 | Students | Working (INST-07) — read-only department roster with consented applications, then the verification queue and upload | `InstitutionStudentsPage` + `AcademicVerificationSection` | INST-04, INST-07 | Verification review overlay (`AcademicVerification.kt`) |
| 4 | Readiness | Working (INST-07) — last month's bands plus the month-by-month scoped report; by career role is INST-17 | `DepartmentReadinessPage` | INST-07 (INST-17 adds career roles) | Home "Cohort readiness" |
| 5 | Assessments | Working (with approval) | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`) | Pre-plan | Exams tab |
| 6 | Interventions | Working | `InstitutionInterventionsPage` (`rolePortalPages.tsx:292-296`) + counselling notes section (`rolePortal/institutionCounselling.tsx`) | Pre-plan; INST-11 | Web only |
| 7 | Faculty and Staff | Working | `InstitutionFacultyAndStaffPage` (`rolePortalPages.tsx:350`; `institutionTeaching.tsx:188`) | INST-03 | Web only |
| 8 | Placement Pipeline | Working (INST-07, INST-12) — shared-application stages and offer responses, and the department's season statistics by batch, suppressed under five, never pay | `PlacementPipelinePage` + `PlacementStatisticsSection` | INST-07, INST-12 | Home "Placement Pipeline" and "Placement statistics" |
| 9 | Opportunities and Offers | Working (INST-07) — shared applications with offer existence and response, audited read | `OpportunitiesAndOffersPage` | INST-07 | Web only (audited record read) |
| 10 | Batches | Working (INST-07) — department batches with roster, enrolled and activated counts (read-only structure) | `DepartmentBatchesPage` | INST-07 | Home "Department overview" batches |
| 11 | Meetings | Working | `InstitutionStaffActionsPage` (`rolePortalPages.tsx:353-368`; `institution.tsx:350`) | Pre-plan | Web only |
| 12 | Reports and Analytics | Working (INST-07) — department summary, stages, scoped readiness report; exports NA until INST-08 | `DepartmentReportsAnalyticsPage` | INST-07 (INST-08 exports) | Web only |
| 13 | Settings | Working — college settings read-only, personal notification preferences | `InstitutionSettingsPage personal` (`rolePortalPages.tsx:372`) | INST-05 | Academic calendar only |
| 14 | Help & FAQ | Working | `HelpFaqPanel` (`rolePortalPages.tsx:291`) | Pre-plan | More → Help |

## Faculty / lecturer (`/institution/faculty`)

| # | Nav label | State | Component (branch) | Built by / to be filled by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working | `InstitutionDashboardV3` (`rolePortalPages.tsx:194-196`) | INST-01, 04 | Home |
| 2 | My Students | Working | `FacultyMyStudentsPage` (`rolePortalPages.tsx:349`; `institutionTeaching.tsx:43`); INST-15 adds the section "Learning across your students" (`FacultyLearningCohortSection`, `institutionLearningCohort.tsx`) — stuck skills, misconceptions ≥5, reviews due; NA until the adaptive-learning consent is published | INST-03, INST-15 | Home "My students" (`StaffDashboards.kt:422`, `:601`); "Learning across your students" (`LearningCohort.kt`) |
| 3 | Student Detail | Partial — scoped faculty-notes list, no scoped student view | `InstitutionStaffActionsPage` (`rolePortalPages.tsx:353-368`) | INST-03 per §4.2 (profile view reported not done in INST-03) | Web only |
| 4 | Academic Verification | Working — queue, with the staff-action list as a second tab | `FacultyAcademicVerification` (`rolePortalPages.tsx:362-364`; `institutionAcademicVerification.tsx:37`) | INST-04 | Verification review overlay (`AcademicVerification.kt:132`) |
| 5 | Assessments | Working (no approval) | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`) | Pre-plan | Exams tab |
| 6 | Assessment Detail | Working (INST-07) — one assessment's scoped results, not-attempted list; average withheld under five | `FacultyAssessmentDetailPage` | INST-07 | Results overlay for one assessment |
| 7 | Assigned Tasks | Working | `InstitutionStaffActionsPage` (`rolePortalPages.tsx:353-368`) | Pre-plan | Web only |
| 8 | Interventions | Working | `InstitutionInterventionsPage` (`rolePortalPages.tsx:292-296`) + counselling notes section (`rolePortal/institutionCounselling.tsx`) | Pre-plan; INST-11 | Web only |
| 9 | Learning Resources | Working | OPS-10's content review queue, then INST-16's "Assign and plan learning" (`FacultyLearningActionsPage`, `institutionLearningActions.tsx`): published practice sets and lessons, assign to a taught class or selected students, group sessions, a student's next step with a reason; the student's plan shown only with their adaptive-learning consent | OPS-10, INST-16 | Home "Assigned learning", read-only (`LearningActions.kt`); students: "From your lecturer" on the Learning tab |
| 10 | Reports | Working (INST-07) — a class report per assigned section or batch; averages withheld under five results | `FacultyClassReportsPage` | INST-07 | Home "My classes" (`DepartmentWorkspace.kt`) |
| 11 | Calendar | Working — academic calendar, meetings feed, staff actions | `FacultyAcademicCalendar` + `CalendarPage` (`rolePortalPages.tsx:359`) | INST-05 | Home "Academic calendar" (`StaffDashboards.kt:426`) |
| 12 | Messages | Working — announcements composer and own inbox | `FacultyMessagesPage` (`rolePortalPages.tsx:352`; `institutionAnnouncements.tsx:230`) | INST-06 | Sent announcements on Home (`StaffDashboards.kt:429`) and inbox overlay (`:303`, `:1117`); composing web only |
| 13 | Profile | Working | `StaffProfilePage` (`rolePortalPages.tsx:370`) | INST-05 | Web only |
| 14 | Settings | Working — notification preferences | `StaffSettingsPage` (`rolePortalPages.tsx:371`) | INST-05 | Web only |
| 15 | Help & FAQ | Working | `HelpFaqPanel` (`rolePortalPages.tsx:291`) | Pre-plan | More → Help |

## D3 verdict

**D3 is not met on this base.** Eleven navigation items open the "View-only for your role" empty state,
and none of them is a feature the plan puts out of scope (§4.3 excludes only compensation, numeric
readiness, ERP functions, under-18 access, licensing, model-generated staff insights and new roles).
Every one is scheduled:

| Role | View-only item | Scheduled goal |
|---|---|---|
| Admin | Career Readiness | INST-17 |
| Admin | Placement | INST-12 |
| Department head | Department Overview, Readiness, Placement Pipeline, Opportunities and Offers, Batches, Reports and Analytics | INST-07 (placement items after INST-12; readiness with INST-17) |
| Faculty | Assessment Detail, Reports | INST-07 |
| Faculty | Learning Resources | INST-16 |

Partial items that are real screens but not yet their full §4.2 module: admin Reports (INST-08/13),
admin Settings placement-policy and data-terms sections (INST-12/EMP-06, INST-18), placement-officer
Readiness (INST-17), department-head Students roster (INST-07) and faculty Student Detail (scoped
student view, INST-03 follow-up). Placement widgets on every dashboard show NA until INST-12.

Related navigation decision outstanding: **HG-3** — only faculty have a `Messages` item, so owners,
admins, placement officers and department heads cannot reach the announcements composer the API
already serves them.

## Update after INST-07 (2026-09-26)

The department head's six view-only items and the faculty Assessment Detail and Reports are now real
screens (rows above updated). Remaining view-only items: admin Career Readiness (INST-17), admin
Placement (INST-12) and faculty Learning Resources (INST-16). D3 is still not met until those land.

## Update after INST-09 (2026-09-26)

Admin Placement is no longer view-only: it shows consented placement status (INST-09); the placement
register, drives and statistics on the same page stay NA until INST-12. Admin Student Detail and the
placement officer's Students / Student Search carry each student's placement status. Remaining
view-only items: admin Career Readiness (INST-17) and faculty Learning Resources (INST-16).

## Update after INST-12 (2026-09-29)

Admin Placement carries the season statistics and the placement register; the placement officer's
Dashboard carries them as sections (no Drives item, HG-3); the department head's Placement Pipeline
carries the department's statistics; admin Settings gains drive categories; the dashboard placement
KPIs, pipeline funnel and offers trend read real, suppressed figures. Remaining view-only items:
admin Career Readiness (INST-17) and faculty Learning Resources (INST-16).

## Update after INST-13 (2026-09-29)

Admin **Reports** and department-head **Reports and Analytics**: the Exports panel gains
"Accreditation outcomes" — graduates by department, programme and year of graduation with placed
(shared applications, INST-12's rule), higher studies and entrepreneurship (self-reported), suppressed,
as of the last month end, NA for anything ONE does not hold, and a plain statement that the file is not
an official template. Admin Reports now carries both INST-08 and INST-13 exports. Web only (desk task).
Students record the self-report on their existing **Profile** page ("After college"), on the web and
on Android. No navigation item added, removed, renamed or reordered.

## Update after INST-16 (2026-09-29)

Faculty Learning Resources is no longer view-only: below the content review queue it lists the published
practice sets and lessons a lecturer can assign, and lets them assign to a taught class or selected students,
plan a group session (a MEETING on their Calendar, with attendees and linked content) and set one student's
next step with a reason code. The cohort section on My Students links each stuck skill, common misconception
and due student to these actions. Students see "From your lecturer" on the Learning page (web) and the
Learning tab (Android). Remaining view-only item: admin Career Readiness (INST-17).

## Update after INST-17 (2026-09-30)

Admin **Career Readiness** is no longer view-only: it shows cohort readiness by career role — choose a catalogue
role or the role behind one of the college's live campus drives; for each essential requirement, how the
reader's cohort stood at the end of an ended month (Met / Partly there / Not yet / Too little evidence / No
evidence yet, with gaps and unknowns; bands only, groups under five `<5`, no student named) — and preparation
sprints: a time-boxed INST-16 assignment of published practice or a lesson to the students with a gap, with
progress (now meet it / new evidence / nothing new, work done) cut at the start of each day. The same section
sits under the monthly report on the placement officer's **Readiness** (completing that partial item) and on the
department head's **Readiness**. Students see a sprint in the existing Learning card, headed "From your
college" with its end date (web and Android). Android shows the sprints and one role's view read-only on the
institution home. No navigation item added, removed, renamed or reordered. **No view-only navigation item
remains** for the institution roles.
