# Institution screen inventory

> What this is: every navigation item of every institution role, in the order the sidebar shows it,
> with what it opens on the program base today, which goal built it, and what the Android app
> offers. Why it exists: INST-19 asks for this inventory as the evidence for outcome D3 — "no
> navigation item a role can open is an empty view-only state unless its feature is explicitly out of
> scope". First written for the IM1 slice (2026-09-26, base `6864332`); re-read in full on 2026-10-01
> against base `719eb34`. Navigation is not changed by this document.

Base: `feat/plan-phases-0-to-2` at `719eb34`, read 2026-10-01. Navigation source:
`apps/web/src/rolePortalConfig.ts` (admin `:110`, placement officer `:120`, faculty `:125`, department
head `:139`; the `nav()` builder `:73-81`). Dispatch: `apps/web/src/rolePortalPages.tsx` — dashboard
`AuthenticatedDashboardChooser` `:235-252` (institution branch `:236-248`), module pages
`RoleModulePage` `:285-514`. Role to portal: `apps/web/src/App.tsx:605-608`. Goal mapping: Appendix 3
§4.2 of the program goal.

**States.** *Working* — a real screen on real data, with its §4.2 module. *Partial* — a real screen,
with part of its §4.2 module still missing. *View-only* — the shared empty state
`AuthenticatedReadOnlyModule` ("View-only for your role", `apps/web/src/rolePortal/shared.tsx:36-41`).
*Not built* — `AuthenticatedNotYetAvailable` (`shared.tsx:43-48`). Where a widget's data source does
not exist it shows NA in its slot (house rule); NA slots are listed under the verdict.

**Android.** One institution workspace serves every institution role
(`apps/android/.../StaffDashboards.kt:262`, mounted from `MainActivity.kt:256`): Home, Exams and More
tabs (`:365-370`). Sections depend only on the server's answer — a 403 hides the section
(`DepartmentWorkspace.kt:119-122`). Home sections in order (`InstitutionHome`, `:405`): KPI row
`:411-425`, cohort readiness `:431`, readiness by career role `:433`, department overview `:436`, My
students `:440`, class reports `:442`, learning cohort `:444`, assigned learning `:446`, academic
calendar `:450`, announcements `:453`, student activation `:457`, academic verification `:475`,
placement pipeline `:493`, placement statistics `:496`, campus drives `:500`, needing attention `:503`,
recent assessments `:523`. More: Help, switch workspace, sign out (`:1241-1259`). Paths below are
shortened to the file name. "Web only" marks a desk task the phone does not carry.

## Institution owner and administrator (`/institution/admin`)

| # | Nav label | State | Component (dispatch line) | Built by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working — activation, verification backlog, placement KPIs, pipeline funnel and offers trend (suppressed); cohort-readiness widgets NA (see verdict) | `InstitutionDashboardV3` (`staffDashboardsV3.tsx:103`; `:236-247`) | INST-01, INST-04, INST-12 | Home KPI row, activation, verification, statistics |
| 2 | Students | Working — roster, invitations and activation, verification queue with results upload, Year-end actions | `InstitutionStudentsPage` (`rolePortal/institution.tsx:498`) + `AcademicVerificationSection canUpload` (`institutionAcademicVerification.tsx:20`) + `institutionBatchLifecycle.tsx` (`:337-348`) | INST-01, 02, 04, 10 | Activation card (`StaffDashboards.kt:457-471`); verification overlay (`AcademicVerification.kt:140`); roster and year-end actions web only |
| 3 | Student Detail | Working — the roster with each student's placement status and shared applications on request; graduated students keep their row with the new state and date | Same roster page + `PlacementStatusList` (`institutionPlacement.tsx:91`) (`:337-348`) | INST-01, INST-09, INST-10 | Web only (audited read of application records) |
| 4 | Academic Structure | Working | `InstitutionAcademicStructurePage` (`institution.tsx:148`; `:358`) | Pre-plan | Web only |
| 5 | Assessments | Working (with approval) | `InstitutionExamEnginePage canApprove` (`examManagerPage.tsx:30`; `:367-375`) | Pre-plan; INST-07 scoped assignment | Exams tab (`StaffDashboards.kt:685`, results `:720`) |
| 6 | Interventions | Working — interventions and the restricted counselling notes | `InstitutionInterventionsPage` (`pilotParity/institutionInterventions.tsx:44`) + `CounsellingNotesSection` (`institutionCounselling.tsx:44`) (`:360-366`) | Pre-plan; INST-11 | Web only (students see shared notes on web and Android) |
| 7 | Staff | Working — invitations with scope, scope changes, teaching assignments, analytics and exports access. "Revoke/resend/end membership: NOT YET AVAILABLE" is shown in each row (`institution.tsx:268`) | `InstitutionStaffPage` (`institution.tsx:191`; `:408`) | INST-02, INST-03, INST-08 | Web only |
| 8 | Career Readiness | Working — cohort readiness by career role and preparation sprints | `CohortReadinessByRoleSection` (`institutionCohortReadiness.tsx:94`; `:419-424`) | INST-17 | Readiness by career role and sprints, read-only (`CohortByRole.kt:118`, called `:433`) |
| 9 | Placement | Working — status by student, season statistics, register, campus drive approvals with nominations | `InstitutionPlacementPage` (`institutionPlacement.tsx:30`; statistics `:64`, register `:65`, drives `:68`) (`:417`) | INST-09, INST-12, INST-14, EMP-11 | Pipeline card (`DepartmentWorkspace.kt:220`), statistics (`PlacementStatistics.kt:79`), drives with nomination summary (`CampusDrives.kt:122`, `:175`) |
| 10 | Reports | Working — readiness band report and the Exports panel (roster, readiness bands, assessment results, staff-action summary, accreditation outcomes) | `InstitutionReportsPage` (`institutionReportsPage.tsx:61`) + `InstitutionExportsPanel` (`institutionAnalytics.tsx:151`) (`:409-415`) | INST-08, INST-13 | Web only (exports are desk files) |
| 11 | Settings | Working — profile, grading scales, calendar, placement policies, drive categories, data-processing terms and Leaving ONE | `InstitutionSettingsPage` (`institutionSettings.tsx:101`; policies `:119`, categories `:121`, terms and exit `:123`) (`:427`) | INST-05, EMP-11, INST-12, INST-18 | Academic calendar read-only (`StaffDashboards.kt:552`); rest web only |
| 12 | Help & FAQ | Working | `HelpFaqPanel` (`helpFaqPanel.tsx:8`; `:359`) | Pre-plan | More → Help (`StaffDashboards.kt:1241`, `:1481`) |

## Placement officer (`/institution/placement-officer`)

| # | Nav label | State | Component (dispatch line) | Built by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working — campus drive approvals with nominations, placement policies, season statistics, placement register (sections, because there is no Drives item — HG-3); cohort-readiness widgets NA | `InstitutionDashboardV3` + `CampusDriveApprovalsSection` (`institutionCampusDrives.tsx:81`), `PlacementPoliciesSection` (`:254`), `PlacementStatisticsSection` (`institutionPlacementRegister.tsx:86`), `PlacementRegisterSection` (`:124`) (`:239-245`) | EMP-11, INST-12, INST-14 | Home incl. statistics and drives with the nomination summary |
| 2 | Assessments | Working (with approval) | `InstitutionExamEnginePage canApprove` (`:367-375`) | Pre-plan | Exams tab |
| 3 | Help & FAQ | Working | `HelpFaqPanel` (`:359`) | Pre-plan | More → Help |
| 4 | Students | Working — roster with placement status and shared applications; the roster's "Readiness band" column is NA (`institution.tsx:557`) | `InstitutionStudentsPage` → `PlacementStudentRoster` (`institution.tsx:512`) (`:382-387`) | INST-01, INST-09 | Activation card; roster web only |
| 5 | Student Search | Working | Same page (`:382-387`) | INST-01, INST-09 | Web only |
| 6 | Readiness | Working — the monthly band report, cohort readiness by career role, preparation sprints | `InstitutionReportsPage` + `CohortReadinessByRoleSection` (`:388-397`) | INST-17 | Readiness by career role and sprints, read-only |
| 7 | Departments | Working (read-only by design) | `InstitutionAcademicStructurePage canManage={false}` (`:398-407`) | Pre-plan | Web only |
| 8 | Batches | Working (read-only by design) | Same (`:398-407`) | Pre-plan | Web only |

## Department head (`/institution/department-head`)

| # | Nav label | State | Component (dispatch line) | Built by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working; cohort-readiness widgets NA | `InstitutionDashboardV3` (`:247`) | INST-01, INST-04 | Home |
| 2 | Department Overview | Working | `DepartmentOverviewPage` (`institutionDepartment.tsx:146`; `:443`) | INST-07 | Department overview (`DepartmentWorkspace.kt:170`) and cohort readiness (`:134`) |
| 3 | Students | Working — read-only department roster with placement status and shared applications, verification queue and results upload | `InstitutionStudentsPage` + `AcademicVerificationSection` (`:349-357`) | INST-04, INST-07, INST-09 | Verification overlay |
| 4 | Readiness | Working — last month's bands, the month-by-month report, readiness by career role and sprints | `DepartmentReadinessPage` (`institutionDepartment.tsx:249`) + `CohortReadinessByRoleSection` (`:444-447`) | INST-07, INST-17 | Cohort readiness and readiness by career role |
| 5 | Assessments | Working (with approval), plus the external content review queue for heads holding the grant | `InstitutionExamEnginePage` + `FacultyContentReviewsPage hideWhenForbidden` (`externalReviews.tsx:337`) (`:367-375`) | Pre-plan; OPS-10 | Exams tab |
| 6 | Interventions | Working — interventions and counselling notes | `InstitutionInterventionsPage` + `CounsellingNotesSection` (`:360-366`) | Pre-plan; INST-11 | Web only |
| 7 | Faculty and Staff | Working | `InstitutionFacultyAndStaffPage` (`institutionTeaching.tsx:191`; `:440`) | INST-03, INST-07 | Web only |
| 8 | Placement Pipeline | Working — shared applications by stage, offers by response, status distribution, the department's season statistics | `PlacementPipelinePage` (`institutionDepartment.tsx:268`) + `PlacementStatisticsSection` (`:449-452`) | INST-07, INST-09, INST-12 | Pipeline card and statistics |
| 9 | Opportunities and Offers | Working | `OpportunitiesAndOffersPage` (`institutionDepartment.tsx:314`; `:453`) | INST-07 | Web only (audited read) |
| 10 | Batches | Working (structure read-only) | `DepartmentBatchesPage` (`institutionDepartment.tsx:221`; `:448`) | INST-07 | Batches inside the department overview |
| 11 | Meetings | Working | `InstitutionStaffActionsPage` (MEETING) (`institution.tsx:355`; `:470-483`) | Pre-plan | Web only |
| 12 | Reports and Analytics | Working — department summary, stages, scoped readiness report, Exports panel | `DepartmentReportsAnalyticsPage` (`institutionDepartment.tsx:369`, exports `:406`) (`:455`) | INST-07, INST-08, INST-13 | Web only |
| 13 | Settings | Working — college settings read-only, own notification preferences | `InstitutionSettingsPage personal` (`:489`) | INST-05 | Academic calendar |
| 14 | Help & FAQ | Working | `HelpFaqPanel` (`:359`) | Pre-plan | More → Help |

## Faculty / lecturer (`/institution/faculty`)

| # | Nav label | State | Component (dispatch line) | Built by | Android equivalent |
|---|---|---|---|---|---|
| 1 | Dashboard | Working; cohort-readiness widgets NA | `InstitutionDashboardV3` (`:247`) | INST-01, INST-04 | Home |
| 2 | My Students | Working — the students of active teaching assignments, and "Learning across your students" (NA until the adaptive-learning consent is published, HG-6) | `FacultyMyStudentsPage` (`institutionTeaching.tsx:45`) + `FacultyLearningCohortSection` (`institutionLearningCohort.tsx:38`) (`:436-439`) | INST-03, INST-15 | My students (`StaffDashboards.kt:624`) and learning cohort (`LearningCohort.kt:67`) |
| 3 | Student Detail | **Partial** — a scoped, staff-only *Faculty Notes* list; there is no scoped single-student profile view | `InstitutionStaffActionsPage` mapped to `FACULTY_NOTE` (`institution.tsx:325`) (`:470-482`) | Pre-plan; §4.2 assigns the scoped student view to INST-03, which did not build it | Web only |
| 4 | Academic Verification | Working — the queue, with the staff-action list as a second tab. A side card says evidence cannot be opened (ADR-027, `institution.tsx:492`) | `FacultyAcademicVerification` (`institutionAcademicVerification.tsx:37`; `:479-481`) | INST-04 | Verification overlay |
| 5 | Assessments | Working (no approval) | `InstitutionExamEnginePage canApprove={false}` (`:367-375`) | Pre-plan | Exams tab |
| 6 | Assessment Detail | Working | `FacultyAssessmentDetailPage` (`institutionDepartment.tsx:440`; `:456`) | INST-07 | Results overlay (`StaffDashboards.kt:720`) |
| 7 | Assigned Tasks | Working | `InstitutionStaffActionsPage` (ASSIGNED_TASK) (`:470-482`) | Pre-plan | Web only |
| 8 | Interventions | Working — interventions and counselling notes | `InstitutionInterventionsPage` + `CounsellingNotesSection` (`:360-366`) | Pre-plan; INST-11 | Web only |
| 9 | Learning Resources | Working — the external content review queue, then "Assign and plan learning" | `FacultyContentReviewsPage` + `FacultyLearningActionsPage` (`institutionLearningActions.tsx:114`) (`:462-467`) | OPS-10, INST-16 | Assigned learning, read-only (`LearningActions.kt:202`) |
| 10 | Reports | Working — a class report per taught section or batch | `FacultyClassReportsPage` (`institutionDepartment.tsx:502`; `:457`) | INST-07 | My classes (`DepartmentWorkspace.kt:289`) |
| 11 | Calendar | Working — academic calendar, meetings feed, staff actions | `FacultyAcademicCalendar` (`institutionSettings.tsx:387`) + `CalendarPage` (`calendarPage.tsx:40`) (`:476`) | INST-05 | Academic calendar |
| 12 | Messages | Working — announcements composer and own inbox | `FacultyMessagesPage` (`institutionAnnouncements.tsx:230`; `:469`) | INST-06 | Announcements (`StaffDashboards.kt:577`) and inbox (`:1262`); composing web only |
| 13 | Profile | Working | `StaffProfilePage` (`institutionSettings.tsx:481`; `:487`) | INST-05 | Web only |
| 14 | Settings | Working — notification preferences | `StaffSettingsPage` (`institutionSettings.tsx:491`; `:488`) | INST-05 | Web only |
| 15 | Help & FAQ | Working | `HelpFaqPanel` (`:359`) | Pre-plan | More → Help |

## Roles that are not institution portals

`CAREER_COUNSELOR` and "Institution Analyst" have portal entries in `rolePortalConfig.ts` (`:130-135`,
`:144-149`) but exist only as demo portals behind `demoPortalEnabled`; ADR-018 made counselling a
staff-action type (now INST-11's counselling notes) and analytics a capability (INST-08), and §4.3 puts
new roles out of scope. The web maps `CAREER_COUNSELOR` to no workspace (`App.tsx:619`); **the Android
app still classifies `CAREER_COUNSELOR` as an institution role** (`StaffDashboards.kt:67`) — a small
parity gap with no effect while no such membership can be created.

## D3 verdict

**D3 is met on this base, with one honest qualification.** Of the 49 navigation items of the four
institution roles that can sign in, none opens the "View-only for your role" or "Not built yet" state:

- The admin fallback to `AuthenticatedReadOnlyModule` for Career Readiness, Placement and Reports
  (`rolePortalPages.tsx:425`) is now unreachable — the three labels are caught earlier at `:409`,
  `:417` and `:419`.
- The faculty and department-head fallback (`:493`) and the general `AuthenticatedNotYetAvailable`
  (`:494`) are reached by no institution label.

The qualification — items that are real screens but not yet their full §4.2 module:

| Role | Item | What is missing | Out of scope? |
|---|---|---|---|
| Faculty | Student Detail | A scoped single-student view; today it is the *Faculty Notes* list (not empty) | No — §4.2 assigns it to INST-03; not scheduled in any later goal. **Recommended follow-up** |

NA slots by design (a widget kept in place with NA because its source is not wired; never invented):

- Every role's Dashboard: the *Cohort Readiness* ring and legend and the department readiness bars
  read NA (`staffDashboardsV3.tsx:161-166`, about `:236`). The ring is labelled "Avg readiness"; ADR-020
  forbids a numeric average, so this slot must stay NA or be re-fed from band data (INST-07's
  last-month bands or INST-17's view) — **recommended follow-up**, not a D3 failure.
- Placement officer roster: the "Readiness band" column reads NA (`institution.tsx:557`).
- Faculty Academic Verification: "NA — institution access to student evidence is not available"
  (ADR-027 not built).
- Staff page: "Revoke/resend/end membership: NOT YET AVAILABLE" (`institution.tsx:268`).
- Learning cohort and a student's plan: NA until the adaptive-learning consent is published (HG-6).
- Dashboard placement and drive widgets read NA for a role the server refuses.

Related navigation decision outstanding: **HG-3** — only faculty have a `Messages` item, so owners,
admins, placement officers and department heads cannot reach the announcements composer the API
serves them (their top-bar Messages button says no message route exists for the role,
`rolePortalPages.tsx:144`). The placement officer has no Drives item (drives live on the Dashboard)
and no Interventions item (a placement officer added to a counselling case has no screen).

## History

| Date | Goal | Change to this inventory |
|---|---|---|
| 2026-09-26 | IM1 slice (`6864332`) | Eleven items view-only: admin Career Readiness and Placement; six department-head items; faculty Assessment Detail, Reports and Learning Resources. D3 not met |
| 2026-09-26 | INST-07 | The six department-head items and faculty Assessment Detail and Reports became real screens |
| 2026-09-26 | INST-09 | Admin Placement became real (consented placement status); status added to Student Detail and the placement officer's roster |
| 2026-09-28 | INST-10, INST-11 | Year-end actions on Students; counselling notes on Interventions |
| 2026-09-29 | INST-12 | Statistics and register on admin Placement, the officer's Dashboard and the head's Placement Pipeline; drive categories in Settings |
| 2026-09-29 | INST-13, INST-14, INST-15, INST-16 | Accreditation export; nominations in drive details; learning across students on My Students; faculty Learning Resources became real |
| 2026-09-30 | INST-17 | Admin Career Readiness became real; the officer's and head's Readiness gained readiness by career role. No view-only item left |
| 2026-09-30 | INST-18 | Settings gained data-processing terms and Leaving ONE |
| 2026-10-01 | INST-19 (this edition, `719eb34`) | Every row re-read against the code; line references refreshed; admin Reports and the officer's Readiness corrected from Partial to Working; D3 verdict updated |

No navigation item was added, removed, renamed or reordered by any of these goals.
