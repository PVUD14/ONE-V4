# All-role portal acceptance audit — 6153d0a

Commit audited: `6153d0ac2dbce9290e579c540a3e5effd7b85f9d`

Branch: `agent/all-role-portals-completion`

Audit closure timestamp: 2026-08-18, local workstation.

Verdict: accepted after one narrow functional-control correction.

## Tooling and evidence

Evidence is preserved under:

`docs/qa/evidence/acceptance-6153d0a/`

Tool versions:

- Node: `v22.18.0`
- npm: `10.9.3`
- pnpm via Corepack: `10.15.0`
- Chrome: `151.0.7922.138`

The managed in-app browser backend was unavailable during the audit (`agent.browsers.list()` returned no browser backends in the prior acceptance pass), so browser evidence was gathered with local Chrome through DevTools Protocol against the local Vite app. No browser framework was installed.

## Corrected role and route matrix

The canonical product-role route total is 135 role routes. Including `/demo`, the complete browser sweep covers 136 routes.

| Portal family | Role | Route count | Dashboard route |
| --- | --- | ---: | --- |
| Student | Student | 14 | `/student` |
| Institution | Placement Officer | 17 | `/institution/placement-officer` |
| Institution | Lecturer / Faculty | 14 | `/institution/faculty` |
| Institution | Career Counselor | 13 | `/institution/career-counselor` |
| Institution | Department Head | 13 | `/institution/department-head` |
| Institution | Institution Analyst | 11 | `/institution/analyst` |
| Employer | Recruiter | 14 | `/employer/recruiter` |
| Employer | Hiring Manager | 12 | `/employer/hiring-manager` |
| Employer | Interviewer | 9 | `/employer/interviewer` |
| Operations | Platform Administrator / Operations Administrator | 18 | `/operations/admin` |
| Preview launcher | Demo launcher | 1 | `/demo` |

Institution Analyst route correction: the Analyst portal has 11 routes, not 10: Dashboard, Analysis Overview, Placement Analysis, Readiness Analysis, Skill Gap Analysis, Cohort Comparison, Reports, Data Exports, Visualizations, Saved Views and Settings.

## Browser and validation evidence

Preserved JSON reports:

- `route-title-overflow-network-audit.json`
- `visible-sidebar-navigation-click-audit.json`
- `representative-workflow-interaction-audit.json`
- `mobile-drawer-focus-audit.json`
- `topbar-control-postfix-proof.json`
- `postfix-136-route-title-mobile-overflow-sweep.json`
- `postfix-route-sweep-transient-rerun.json`
- `acceptance-summary.json`

Representative screenshots preserved:

- `demo-desktop-1440x900.png`
- `demo-mobile-390x844.png`
- `student-mobile-390x844.png`
- `placement-officer-desktop-1440x900.png`
- `institution-analyst-mobile-390x844.png`
- `recruiter-desktop-1440x900.png`
- `operations-admin-mobile-390x844.png`

The full temporary screenshot set was not committed to avoid unnecessary duplicate binary evidence.

## Final checks

Frontend validation after the narrow correction:

- Frontend typecheck: passed.
- Frontend tests: passed, 81 tests.
- Frontend production build: passed.

Browser validation:

- 136 routes swept when `/demo` is included.
- 135 role routes confirmed.
- Route titles and headings verified after rerunning transient early-read cases.
- 390px mobile horizontal overflow checks passed.
- Console/runtime: no genuine errors.
- Network: no unexpected failed requests, HTTP 400+ responses, CORS failures, mixed-content failures or production service calls.
- Student and Placement Officer regression coverage remained included in the frontend test suite and browser route sweep.

## Exhaustive enabled-control audit

The audit covered enabled controls across:

- sidebar/navigation buttons;
- topbar buttons;
- search fields;
- filter chips/selects;
- dashboard card actions;
- table and mobile record actions;
- modal open/close actions;
- form submission, validation and cancel actions;
- confirmation dialogs;
- reset actions;
- preview notices and backend-dependency notices.

Equivalence rule: repeated data-row and card controls using the same component, accessible label pattern and handler were represented by one exercised instance. For example, repeated `View detail` / `Edit preview` role-record cards use `RoleRecordList`, repeated Placement Officer student record actions use the same staff record-action handlers, and repeated navigation buttons use their shared sidebar route handler.

Evidence proving the control audit includes:

- `visible-sidebar-navigation-click-audit.json`: 135 visible sidebar navigation clicks, 0 issues.
- `representative-workflow-interaction-audit.json`: representative filters, detail dialogs, edit dialogs, validation, confirmations and state changes for every role family.
- `topbar-control-postfix-proof.json`: post-fix proof for Student, Placement Officer, Recruiter and Operations topbar Messages/Notifications behavior.
- Frontend regression tests: 81 passing tests, including new coverage for the topbar controls.

## Defect found and corrected

Defect: enabled topbar `Messages` and `Notifications` controls in Student, Placement Officer and generic role portals were visible but did not consistently produce an observable result.

Root cause: the topbar icon buttons were rendered as enabled buttons without route navigation or preview-status handlers.

Narrow correction:

- Student Messages now reports that secure backend messaging is required.
- Student Notifications now reports local preview notification state.
- Placement Officer Messages routes to Communications.
- Placement Officer Notifications shows a visible preview notice.
- New role portal Messages routes to a Messages/Communications page when present; Operations, which has no message route, shows a backend-dependency notice.
- New role portal Notifications shows a visible preview notice.

Modified application files:

- `apps/web/src/App.tsx`
- `apps/web/src/rolePortalPages.tsx`
- `apps/web/src/staffComponents.tsx`
- `apps/web/src/App.test.tsx`

No authentication, RBAC, ABAC, CORS, backend role mapping, production credential or backend mutation behavior was changed.

## Remaining evidence limitations

- The single monolithic all-route/all-control script exceeded the tool execution ceiling and its failed run is not claimed as evidence.
- Exhaustive control closure is therefore based on combined evidence: source/component inspection, 135 sidebar navigation clicks, representative browser workflows per role, focused post-fix topbar browser proof, and passing regression tests.
- Repeated row/card controls are audited by component/handler equivalence rather than clicking every repeated row instance.

Recommendation: ACCEPT.
