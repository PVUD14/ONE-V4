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
| 1 | Dashboard | Working (placement and readiness widgets NA) | `InstitutionDashboardV3` (`rolePortalPages.tsx:194-196`; `staffDashboardsV3.tsx:70`, NA KPIs `:112-114`, `:128`) | INST-01, INST-04 built; INST-12 fills placement counts | Home (`StaffDashboards.kt:367`): activation `:433`, verification `:451`, placement NA `:468` |
| 2 | Students | Working | `InstitutionStudentsPage` + `AcademicVerificationSection` with upload (`rolePortalPages.tsx:273-281`; `rolePortal/institution.tsx:493`; `institutionAcademicVerification.tsx:20`) | INST-01, 02, 04 built; INST-10 built — Year-end actions panel (`institutionBatchLifecycle.tsx`: graduate, transfer or end a unit or a list of roll numbers, preview then commit) | Activation counts and verification review overlay (`AcademicVerification.kt:132`); roster and year-end actions web only (desk tasks) |
| 3 | Student Detail | Working | `InstitutionStudentsPage` plus INST-09's `PlacementStatusList` (placement status per student, shared applications on request) | INST-01, INST-09 built; INST-10: a graduated student stays on the roster with the new state and end date | Web only |
| 4 | Academic Structure | Working | `InstitutionAcademicStructurePage` (`rolePortalPages.tsx:290`; `institution.tsx:144`) | Pre-plan; no §4.2 goal | Web only |
| 5 | Assessments | Working | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`; `examManagerPage.tsx:30`) | Pre-plan | Exams tab (`StaffDashboards.kt:660`, results `:695`) |
| 6 | Interventions | Working | `InstitutionInterventionsPage` (`rolePortalPages.tsx:292-296`; `pilotParity/institutionInterventions.tsx:44`) + restricted counselling notes section `CounsellingNotesSection` (`rolePortal/institutionCounselling.tsx`) | Pre-plan; INST-11 | Web only (students see shared notes on web and Android) |
| 7 | Staff | Working | `InstitutionStaffPage` (`rolePortalPages.tsx:333`; `institution.tsx:187`) | INST-03 built; INST-08 adds analytics capability grants | Web only |
| 8 | Career Readiness | **View-only** | `AuthenticatedReadOnlyModule` (`rolePortalPages.tsx:339`) | INST-17 | Home "Cohort readiness", NA (`StaffDashboards.kt:399`) |
| 9 | Placement | Partial (INST-09) — consented placement status: suppressed distribution, stage and offer funnels, per-student status with shared applications; register, drives and statistics NA until INST-12 | `InstitutionPlacementPage` (`rolePortal/institutionPlacement.tsx`) | INST-09 built; INST-12 | Home pipeline card incl. students by placement status (`DepartmentWorkspace.kt`); per-student list web only |
| 10 | Reports | Partial — readiness band report only | `InstitutionReportsPage` (`rolePortalPages.tsx:334-338`; `institutionReportsPage.tsx:31`) | INST-08, INST-13 (reports, exports, accreditation packs) | Web only |
| 11 | Settings | Partial — profile, grading scales, calendar working; placement policies and data-processing terms "not built yet" | `InstitutionSettingsPage` (`rolePortalPages.tsx:341`; `institutionSettings.tsx:98`, empty sections `:115-119`) | INST-05 built; INST-12/EMP-06 (policies), INST-18 (data terms) | Academic calendar read-only (`StaffDashboards.kt:426`); rest web only |
| 12 | Help & FAQ | Working | `HelpFaqPanel` (`rolePortalPages.tsx:291`) | Pre-plan | More → Help (`StaffDashboards.kt:1096`, `:1332`) |

## Placement officer (`/institution/placement-officer`)

| # | Nav label | State | Component (branch) | Built by / to be filled by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working (placement widgets NA) | `InstitutionDashboardV3` (`rolePortalPages.tsx:194-196`) | INST-12 (drive approvals via EMP-11, register summary) | Home |
| 2 | Assessments | Working | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`) | Pre-plan | Exams tab |
| 3 | Help & FAQ | Working | `HelpFaqPanel` (`rolePortalPages.tsx:291`) | Pre-plan | More → Help |
| 4 | Students | Working | `InstitutionStudentsPage` incl. placement status column (INST-09) and consented applications | INST-01, INST-09 built | Activation counts and status distribution on Home; roster web only |
| 5 | Student Search | Working | Same page | INST-01, INST-09 built | Web only |
| 6 | Readiness | Partial — cohort band report, not by career role | `InstitutionReportsPage` (`rolePortalPages.tsx:315-322`) | INST-17 | Home "Cohort readiness", NA |
| 7 | Departments | Working (read-only by design) | `InstitutionAcademicStructurePage canManage={false}` (`rolePortalPages.tsx:323-332`) | Pre-plan | Web only |
| 8 | Batches | Working (read-only by design) | Same (`rolePortalPages.tsx:323-332`) | Pre-plan | Web only |

The placement officer has no placement item; §4.2 puts the placement register behind a Drives item
(employer plan decision #4) or a Dashboard section — a navigation decision, not made here.

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
| 8 | Placement Pipeline | Working (INST-07) — shared-application stages and offer responses, suppressed under five, never pay; drives NA until INST-12 | `PlacementPipelinePage` | INST-07 | Home "Placement Pipeline" (`DepartmentWorkspace.kt`) |
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
| 2 | My Students | Working | `FacultyMyStudentsPage` (`rolePortalPages.tsx:349`; `institutionTeaching.tsx:43`) | INST-03 | Home "My students" (`StaffDashboards.kt:422`, `:601`) |
| 3 | Student Detail | Partial — scoped faculty-notes list, no scoped student view | `InstitutionStaffActionsPage` (`rolePortalPages.tsx:353-368`) | INST-03 per §4.2 (profile view reported not done in INST-03) | Web only |
| 4 | Academic Verification | Working — queue, with the staff-action list as a second tab | `FacultyAcademicVerification` (`rolePortalPages.tsx:362-364`; `institutionAcademicVerification.tsx:37`) | INST-04 | Verification review overlay (`AcademicVerification.kt:132`) |
| 5 | Assessments | Working (no approval) | `InstitutionExamEnginePage` (`rolePortalPages.tsx:297-302`) | Pre-plan | Exams tab |
| 6 | Assessment Detail | Working (INST-07) — one assessment's scoped results, not-attempted list; average withheld under five | `FacultyAssessmentDetailPage` | INST-07 | Results overlay for one assessment |
| 7 | Assigned Tasks | Working | `InstitutionStaffActionsPage` (`rolePortalPages.tsx:353-368`) | Pre-plan | Web only |
| 8 | Interventions | Working | `InstitutionInterventionsPage` (`rolePortalPages.tsx:292-296`) + counselling notes section (`rolePortal/institutionCounselling.tsx`) | Pre-plan; INST-11 | Web only |
| 9 | Learning Resources | **View-only** | `AuthenticatedReadOnlyModule` (`rolePortalPages.tsx:376`) | INST-16 (honest empty state until then) | Web only |
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
