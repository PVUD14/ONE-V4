# All-role portal coverage

Status: completed implementation evidence for `agent/all-role-portals-completion`.

Latest validation:

- Frontend typecheck: passed.
- Frontend tests: passed, 81 tests.
- Frontend production build: passed.
- Backend typechecks: API, Persistence, Authorization and Identity passed.
- Backend tests with safe local PostgreSQL container credentials held only in process variables:
  - API: 37 passed.
  - Persistence: 27 passed.
  - Authorization: 4 passed.
  - Identity: 16 passed.
  - Total: 84 passed.
- Migration status: `0000_phase1_spike.sql` and `0001_identity_organization_persistence.sql` applied through the persistence migration runner.
- Local PostgreSQL health evidence: `planthepath-postgres-dev` is running and Docker reports it healthy on `127.0.0.1:55432`.
- Local secret files: `.env`, `.env.local` absent; `.env` and `.env.*` remain ignored.

## Portal coverage table

| Portal family | Role | Backend role mapping | Enforcement status | Dashboard route | Route count | Navigation status | Preview workflow status | Responsive status | Automated test status | Browser verification status | Remaining backend dependencies |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Student | Student | `STUDENT` | Backend enforced | `/student` | 14 | Existing approved routes preserved | Existing Student-owned workflows preserved | Existing approved responsive system | 81-test frontend suite passed | CDP desktop regression captured for dashboard and opportunities | Real auth/session persistence remains backend-owned |
| Institution | Placement Officer | `PLACEMENT_ADMIN` / `PLACEMENT_OFFICER` | Partially backend enforced | `/institution/placement-officer` | 17 | Existing approved routes preserved | Existing Placement Officer workflows preserved | Existing approved responsive system | 81-test frontend suite passed | CDP desktop regression captured for dashboard and Students | `PLACEMENT_OFFICER` enforcement mapping gap |
| Institution | Lecturer / Faculty | `FACULTY_LECTURER` | Partially backend enforced | `/institution/faculty` | 14 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, filter, detail, edit and save evidence captured | Persistent faculty workflows |
| Institution | Career Counselor | `CAREER_COUNSELOR` | Domain-model only | `/institution/career-counselor` | 13 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, filter, detail, edit and save evidence captured | Backend role enforcement and note visibility persistence |
| Institution | Department Head | `DEPARTMENT_HEAD` | Partially backend enforced | `/institution/department-head` | 13 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, filter, detail, edit and save evidence captured | Department-scoped persistence and reports |
| Institution | Institution Analyst | `INSTITUTION_ANALYST` | Domain-model only | `/institution/analyst` | 11 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, filter, detail, edit and save evidence captured | Analytics role enforcement and export service |
| Employer | Recruiter | `RECRUITER` | Backend enforced | `/employer/recruiter` | 14 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, mobile, filter, detail and edit evidence captured | Real applicant workflow persistence |
| Employer | Hiring Manager | `HIRING_MANAGER` | Domain-model only | `/employer/hiring-manager` | 12 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, filter, detail, edit and save evidence captured | Hiring manager backend enforcement |
| Employer | Interviewer | `INTERVIEWER` | Domain-model only | `/employer/interviewer` | 9 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, filter, detail, edit and save evidence captured | Interviewer backend enforcement and scorecard persistence |
| Operations | Platform Administrator / Operations Administrator | `OPERATIONS_ADMIN` | Backend enforced | `/operations/admin` | 18 | Typed registry navigation | Session-local preview forms/details/filters | Scoped role-shell responsive CSS | 81-test frontend suite passed | CDP dashboard, required viewport overflow, filter, detail, edit and save evidence captured | Real privileged mutations, billing, support and feature-flag services |

## Control inventory

| Route family | Control | Interaction type | Expected result | Test covering it | Browser verified | Backend dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `/demo` | Open portal | Navigation | Opens the selected role dashboard without authentication/token creation | `renders the demo launcher...`; route coverage test | Dashboard capture confirms launcher renders; route sweeps confirmed direct portal destinations load | Real login remains separate |
| New institution/employer/operations dashboards | Create saved dashboard | Session-local state | Adds preview activity and unsaved-change state | Dashboard route/title coverage; workflow test covers dirty/reset pattern | Automated tests cover dirty/reset; dashboard captures confirm render | Persistent saved views |
| New role module pages | Filter chips | Visible filtering | Filters record cards and updates result count with `aria-pressed` | `filters, clears, opens detail...` | CDP verified representative dense route for every new role | None for preview |
| New role module pages | Clear filters | Filter reset | Restores records after filters/search | `filters, clears, opens detail...` | Automated tests plus representative CDP workflow passes verified filter/reset behavior | None for preview |
| New role module pages | View detail | Modal/detail | Opens selected record detail and preserves entity context | `filters, clears, opens detail...` | CDP verified representative dense route for every new role | Real entity read APIs |
| New role module pages | Edit preview | Validated form | Saves session-local status/note, creates preview activity, reset restores fixtures | `filters, clears, opens detail...` | CDP verified edit dialog and save-close flow for new role families | Persistent role-owned workflows |
| New role dashboards | Needs attention record: View detail / Edit preview | Modal/detail and validated preview form | Opens the selected dashboard record instead of relying only on hidden preview state; Escape closes and returns focus to the triggering control | `opens dashboard record workflows and returns focus after Escape` | CDP verified on Faculty dashboard with detail/edit dialog focus entry and Escape focus return | Real entity read/write APIs |
| New institution/employer/operations preview portals | Switch preview portal | Navigation | Returns to `/demo`; does not create auth state | Route shell renders control; direct click coverage pending | CDP verified across all 8 new role dashboards | Real auth switcher separate |
| New institution/employer/operations preview portals | Reset demo data | Reset action when dirty | Clears session-local preview state | `filters, clears, opens detail...` | CDP verified across all 8 new role dashboards after creating a saved dashboard | None for preview |
| Student topbar | Student profile menu | Navigation | Opens the Student Profile route instead of acting as a no-op menu shell | `keeps the Student route regression intact...` | CDP focused no-op correction proof | Real account menu/auth session controls remain backend-owned |
| Placement Officer topbar and dashboard sections | Calendar, report, analysis, announcement and recruiter shortcuts | Navigation | Opens the relevant Placement Officer route or report page | `routes previously topbar and section-only staff controls...` | CDP focused no-op correction proof | Persistent calendar/report services |
| Placement Officer dashboard readiness legend | Readiness band buttons | Visible selection and live result | Updates `aria-pressed` and visible selected-band status text | `routes previously topbar and section-only staff controls...` | CDP focused no-op correction proof | None for preview |
| Placement Officer operational records | Review / Assign / More actions | Dialog or navigation | Opens the preview workflow, routes to interventions, or opens Student Search context | `opens staff record review workflows...` | CDP focused no-op correction proof | Persistent placement workflow APIs |

## Static screenshot evidence

Static headless Chrome screenshots were captured in:

`C:\Users\Xevyte Technologies\AppData\Local\Temp\planthepath-all-role-portals`

- `demo-dashboard-1440x900.png`
- `institution-faculty-dashboard-1440x900.png`
- `institution-career-counselor-dashboard-1440x900.png`
- `institution-department-head-dashboard-1440x900.png`
- `institution-analyst-dashboard-1440x900.png`
- `employer-recruiter-dashboard-1440x900.png`
- `employer-hiring-manager-dashboard-1440x900.png`
- `employer-interviewer-dashboard-1440x900.png`
- `operations-admin-dashboard-1440x900.png`
- `recruiter-mobile-390x844.png`

Static captures remain route-render evidence. The CDP evidence below supplies the interactive console, network, workflow, focus, and overflow proof used for this completion checkpoint.

## Browser automation status

Interactive browser verification is complete for the scoped completion gate as of this checkpoint, using the dependency-free Chrome DevTools Protocol fallback.

The supported bundled browser runtime was attempted against `http://127.0.0.1:5173/demo`. Runtime setup succeeded, but browser discovery returned no available browser backends. The prescribed troubleshooting check was also run and `agent.browsers.list()` returned an empty list.

A dependency-free fallback pass was then run with an isolated local Chrome profile and Chrome DevTools Protocol. No browser framework was installed and no package files were changed. Local API health calls to `http://127.0.0.1:3000/health` are expected local development requests, not production targets.

CDP evidence directory:

`C:\Users\XEVYTE~1\AppData\Local\Temp\planthepath-all-role-cdp-evidence`

CDP report files:

- `cdp-verification-report.json`
- `cdp-interaction-report.json`
- `cdp-corrected-workflow-report.json`
- `cdp-react-save-proof-report.json`
- `cdp-student-placement-regression-report.json`
- `cdp-all-role-responsive-drawer-report.json`
- `cdp-route-sweep-student-placement.json`
- `cdp-route-sweep-institution-roles.json`
- `cdp-route-sweep-employer-operations.json`
- `cdp-main-control-sweep-new-roles.json`
- `cdp-main-control-sweep-student-actions.json`
- `cdp-main-control-sweep-student-actions-after-fix.json`
- `cdp-student-learning-update-filters-proof.json`
- `cdp-role-dashboard-focus-proof.json`
- `cdp-switch-reset-proof-new-roles.json`
- `cdp-broad-enabled-control-sweep.json`
- `cdp-focused-noop-corrections-proof.json`
- `cdp-broad-enabled-control-sweep-postfix.json`
- `cdp-seven-flag-postfix-proof.json`

CDP checks completed:

- all new role dashboards loaded at 1440Ã—900 with route-aware titles and no page-level horizontal overflow;
- representative dense route filter/detail/edit flows completed for Faculty, Career Counselor, Department Head, Institution Analyst, Recruiter, Hiring Manager, Interviewer and Operations Administrator;
- React-controlled save workflows were verified with native input setters for Department Head and Institution Analyst after the first generic script under-filled controlled inputs;
- Operations dashboard overflow measured cleanly at 1440Ã—900, 1366Ã—768, 1024Ã—768, 768Ã—1024 and 390Ã—844;
- all portal dashboards were captured at 1024Ã—768 and 390Ã—844, with mobile drawer-open screenshots for every role;
- the responsive sweep initially found Placement Officer dashboard overflow at 1024Ã—768 from the attention table; a staff-scoped CSS correction made the attention card full-width at tablet size, and the post-fix CDP measurement was `scrollWidth=1009`, `clientWidth=1009`, `tableRight=980`, `cardRight=991`;
- Student dashboard and opportunities route desktop regressions loaded with no page-level horizontal overflow, failed local requests, bad statuses, production targets or runtime exceptions;
- Placement Officer dashboard and Students route desktop regressions loaded with no page-level horizontal overflow, failed local requests, bad statuses, production targets or runtime exceptions.
- exhaustive route sweeps loaded all 135 visible portal routes at desktop 1440Ã—900 and mobile 390Ã—844, for 270 total route checks:
  - Student and Placement Officer: 31 routes, 62 checks, 0 issues;
  - additional Institution roles: 51 routes, 102 checks, 0 issues;
  - Employer and Operations roles: 53 routes, 106 checks, 0 issues.

The route sweep issue criteria were: page-level horizontal overflow, missing heading, 404/not-found body text, runtime exception, non-canceled failed request, HTTP status 400 or higher, production network target, or enabled icon-only button without an accessible label.

Main-content control sweeps:

- Representative dense module routes for Faculty, Career Counselor, Department Head, Institution Analyst, Recruiter, Hiring Manager, Interviewer and Operations Administrator were sampled for enabled main-content button behavior; 8 routes produced 0 sampled no-op controls.
- Student action-heavy routes were sampled for enabled main-content button behavior across Skills, Assessments, Learning, Experience, Opportunities and Applications. The first sweep found one genuine no-op-style interaction: `/student/learning` â†’ `Update filters`.
- `Update filters` now reveals a visible `Filters focused...` note and moves focus to the filter card while preserving the existing scroll-to-filter behavior in browsers.
- The post-fix Student control sweep covered the same 6 action-heavy routes and produced 0 sampled no-op controls.
- The role dashboard record workflow proof opened Faculty dashboard `View detail` and `Edit preview` actions from a dashboard card, verified dialog focus entry, Escape close, focus return to the triggering button, no failed requests and no 1440px page-level horizontal overflow.
- The switch/reset proof clicked `Create saved dashboard`, verified the dirty-state reset flow, then clicked `Switch preview portal` and verified navigation to `/demo` with the non-authentication preview notice across Faculty, Career Counselor, Department Head, Institution Analyst, Recruiter, Hiring Manager, Interviewer and Operations Administrator dashboards.
- A broader enabled-control sweep across all 135 portal routes produced zero failed requests and identified real no-op-style controls in the Student topbar and Placement Officer topbar/dashboard/record areas. Those controls were corrected with route navigation, visible selected-band status, or preview workflow dialogs.
- The focused no-op correction proof verified Student profile menu navigation, Placement Officer calendar navigation, dashboard report navigation, readiness legend live status, record Review dialog opening, and More-actions routing with no failed requests or 1440px horizontal overflow.
- The post-fix broad enabled-control sweep recorded all 135 routes with zero failed requests and zero non-benign console messages. It still flagged 7 repeat/current-context controls; these were corrected by adding prompt-specific coach status, repeat-aware interview request status, disabled current-route profile/calendar/action buttons, and a visible readiness-band refresh counter.
- The seven-flag post-fix proof verified all 7 remaining controls: AI Coach prompt suggestion, Student interview request change, active Profile menu disabled state, active readiness-band refresh, current Students/Interventions action disabled states, and current Events calendar disabled state, with no failed requests and no 1440px horizontal overflow.

Additional focused screenshots:

- `role-dashboard-detail-focus-1440x900.png`
- `role-dashboard-edit-focus-1440x900.png`

Source audit:

- Targeted source search found no `href="#"`, `localStorage`, `sessionStorage`, `document.cookie`, `dangerouslySetInnerHTML`, `eval(`, `new Function`, or app-code `Access-Control` changes in the portal implementation.
- Targeted source search found no `onClick={() => undefined}`, `onClick={() => null}`, `onClick={() => false}` or `onClick={() => void 0}` no-op handlers in the portal implementation.
- The only `aria-disabled` and storage-string matches were automated tests or documentation assertions, not application behavior.

Browser validation scope notes:

- Full click-by-click manual acceptance has not been repeated for every individual secondary control in every route; automated route sweeps, focused broad enabled-control sweeps, source scans, and targeted workflow proofs were used for the completion gate.
- Focus entry and return are CDP-verified for representative Student, Placement Officer, new role module, and new role dashboard workflows, but focus trapping has not been exhaustively measured for every dialog instance.
- Switch preview portal and reset demo data are browser-click verified for all 8 new role dashboards. Student and Placement Officer retain their dedicated earlier workflow evidence and route sweeps, but this all-role report does not restate every legacy click proof inline.
- Student and Placement Officer now have desktop and mobile route-sweep coverage across all visible routes; their detailed workflow/browser evidence still comes from their dedicated earlier review passes.

Existing static Chrome captures remain useful render evidence. The CDP evidence adds interaction and overflow proof for representative all-role workflows and the post-fix enabled-control sweep; a human browser acceptance pass remains useful for product signoff, not as a blocker for the implementation checkpoint.

## Manual browser acceptance checklist

Use the running local Vite application at `http://127.0.0.1:5173`. Keep DevTools Console and Network open for every check. Clear the console, disable narrow Network filters, reload the route, then perform the listed interactions.

Global checks for every viewport:

- Confirm `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.
- Confirm no horizontal scrolling at the page level.
- Confirm no red console errors, React warnings, CORS failures, mixed-content failures, or unexpected failed requests.
- Confirm requests target the local development app/API only and do not target production services.
- Confirm Escape closes any open drawer/dialog and returns focus to the triggering control.
- Confirm visible navigation items have meaningful destinations and `aria-current` appears on the active route.
- Confirm filter buttons expose selected/unselected state and `aria-pressed`.

Required viewports:

- 1440Ã—900
- 1366Ã—768
- 1024Ã—768
- 768Ã—1024
- 390Ã—844

For each product role, capture:

- dashboard at 1440Ã—900;
- one dense operational page at 1440Ã—900;
- dashboard at 1024Ã—768;
- mobile dashboard at 390Ã—844;
- mobile drawer open at 390Ã—844;
- one detail or edit workflow open;
- one saved/changed preview state.

For primary workflow roles, additionally capture before/after evidence for:

- filter before;
- filter after;
- detail open;
- edit form open;
- saved result.

Role routes to verify:

| Role | Dashboard | Dense route suggestion | Edit/detail workflow suggestion |
| --- | --- | --- | --- |
| Student | `/student` | `/student/opportunities` | Opportunity explain/apply and application draft edit |
| Placement Officer | `/institution/placement-officer` | `/institution/placement-officer/students` | Student detail/intervention workflow |
| Faculty | `/institution/faculty` | `/institution/faculty/my-students` | Student detail and faculty-owned preview edit |
| Career Counselor | `/institution/career-counselor` | `/institution/career-counselor/student-cases` | Counseling note/follow-up preview edit |
| Department Head | `/institution/department-head` | `/institution/department-head/faculty-staff` | Department note/workload preview edit |
| Institution Analyst | `/institution/analyst` | `/institution/analyst/placement-analysis` | Saved view/report preview edit |
| Recruiter | `/employer/recruiter` | `/employer/recruiter/applicants` | Candidate detail and recruiter-owned stage/note edit |
| Hiring Manager | `/employer/hiring-manager` | `/employer/hiring-manager/candidates` | Candidate review/evaluation preview edit |
| Interviewer | `/employer/interviewer` | `/employer/interviewer/scorecards` | Scorecard draft/feedback preview edit |
| Operations Administrator | `/operations/admin` | `/operations/admin/audit-logs` | Operational note/status preview edit |

Manual workflow script for each non-Student/non-Placement preview portal:

1. Open the role dashboard from `/demo`.
2. Confirm the role title, preview user, organization, family, and accent identity match the role.
3. Open the dense route suggestion from the sidebar.
4. Use search to narrow visible records and confirm the count changes.
5. Select one filter chip and confirm visible records change.
6. Clear filters and confirm the original set returns.
7. Open a record detail and confirm the selected entity appears in the dialog.
8. Open the preview edit workflow.
9. Submit an empty or invalid form if validation is present and confirm the validation message is visible.
10. Save a legitimate session-local edit and confirm the changed value appears in the page and preview activity.
11. Use Reset demo data and confirm fixtures return.
12. Repeat at mobile width with drawer navigation and confirm actions wrap without clipping.

Until this checklist is completed in a real browser session, the all-role implementation is code/test validated but not fully browser-validated.
