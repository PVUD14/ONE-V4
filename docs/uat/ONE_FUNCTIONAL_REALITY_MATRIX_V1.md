# ONE Functional Reality Matrix V1

Status definitions: REAL = protected API + DB persistence + authorization; READ_ONLY = real API/DB read path only; PARTIAL = some real backend exists but flow incomplete; PREVIEW = fictional/session-local/demo; MISSING = no real implementation.

Phase 1.1 correction: authenticated portal mounting now requires a server-authorized family/role match from `/api/v1/security/context`; unauthorized deep links render a controlled denial instead of mounting another portal family. Authenticated role shells must not show demo preview identities or fixture records. Manual clean-browser UAT is still required before claiming end-to-end role-login PASS.

| Portal | Role | Module | Action | UI exists? | API exists? | DB persistence? | Auth enforced? | Audit? | Status | Next implementation |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|
| Student | Student | Login/workspace | Cognito sign-in and auto-route | Yes | Yes | Yes | Yes | N/A | REAL | Browser UAT evidence per persona |
| Student | Student | Career Readiness | View learner state | Yes | Yes | Yes | Yes | N/A | READ_ONLY | Seed richer learner data |
| Student | Student | Career Readiness | Complete lesson/start/submit assessment | Yes | Yes | Yes | Yes | Partial | REAL/PARTIAL | Exercise with seeded assessment options |
| Student | Student | Profile/documents/opportunities/applications | Edit/save/apply/upload metadata | Yes | No | No | Client only | No | PREVIEW_CONTROL | Add protected Student-owned persistence |
| Institution | Institution Admin | Academic Structure | Create unit | Yes | Yes | Yes | Yes | Yes | REAL | Add edit/delete controls with policy |
| Institution | Institution Admin | Students | Add/update/list student | Yes | Yes | Yes | Yes | Yes | REAL | Improve detail UX and identity activation path |
| Institution | Institution Admin | Students | Transfer/graduate/end relationship | Yes | Yes | Yes | Yes | Yes | REAL | Add clearer effective date controls |
| Institution | Institution Admin | Roster import | Validate/commit CSV | Yes | Yes | Yes | Yes | Yes | REAL | Add upload file control and error review UX |
| Institution | Institution Admin | Staff | Invite placement/faculty/department roles | Yes | Yes | Yes | Yes | Yes | REAL/PARTIAL | Needs mail delivery/UAT acceptance loop |
| Institution | Placement Admin | Students/reports | View roster and aggregate reports | Partial | Yes | Yes | Yes | Some | PARTIAL | Dedicated placement persistence |
| Institution | Faculty Lecturer | Faculty workflows | Assessments/tasks/resources | Yes | No dedicated APIs | No | Context only | No | PREVIEW_CONTROL | Add faculty-owned task/assessment persistence |
| Institution | Department Head | Department workflows | Workload/interventions/meetings | Yes | No dedicated APIs | No | Context/report only | No | PREVIEW_CONTROL | Add department-scoped services |
| Institution | Career Counselor | Counseling | Notes/sessions/follow-up | Demo only | No | No | No real role | No | MISSING | Implement backend role/policy first |
| Institution | Institution Analyst | Analytics | Save reports/exports | Demo only | No dedicated role | No | No real role | No | MISSING | Implement analyst role and read-only reporting |
| Employer | Recruiter | Employer context | Resolve employer membership | Yes | Yes | Yes | Yes | N/A | REAL | Add actual recruiter dashboard data |
| Employer | Recruiter | Applicant access | Validate active grant | Limited | Yes | Yes | Yes | N/A | PARTIAL | Build employer applicant list on grants |
| Employer | Recruiter | Opportunities/applications/interviews/offers | Create/update/schedule | Yes | No | No | Context only | No | PREVIEW_CONTROL | Implement employer hiring vertical slice |
| Employer | Hiring Manager | Hiring approvals | Approve shortlist/evaluations | Demo only | No | No | No real role | No | MISSING | Add backend role and workflow tables |
| Employer | Interviewer | Scorecards | Submit feedback | Demo only | No | No | No real role | No | MISSING | Add interview assignments/scorecards |
| Operations | Operations Admin | Organizations | Create/edit/list | Yes | Yes | Yes | Yes | Yes | REAL | Expand UI for all fields and validation details |
| Operations | Operations Admin | Verification | Transition state | Yes | Yes | Yes | Yes | Yes | REAL | Add review queue UX |
| Operations | Operations Admin | Initial admin invitation | Create bounded invitation | Yes | Yes | Yes | Yes | Yes | REAL/PARTIAL | Needs deployed local/UAT mail sink or operator delivery |
| Operations | Operations Admin | Career Readiness ops | Imports/status/workflow health | Yes | Yes | Yes | Yes | N/A | READ_ONLY | Add operational actions only where safe |
| Operations | Platform Super Admin | Super-admin controls | Separate privileged control plane | No distinct UI | Role accepted | Membership only | Same family | No | PARTIAL | Define explicit super-admin policy and surfaces |
| Operations | Security Admin | Security operations | Security admin console | No | No distinct API | Role accepted only | Not surfaced | No | MISSING | Implement policy, APIs, and UI |

## BACKEND_REAL_UI_MISSING

- Employer applicant grant authorization exists, but there is no real employer applicant UI driven by persisted opportunities/applications.
- Institution aggregate reports exist, but role-specific report UX is limited.
- Platform super-admin role exists in authorization, but no distinct super-admin interface is implemented.
- SECURITY_ADMIN exists in persistence guards, but no specific UI/API capability is implemented.

## PREVIEW_CONTROL

Most non-admin institution, employer hiring, Student profile/documents/opportunity/application, messaging, notifications, reports, feature flags, support/trust queues, and analytics controls are preview/session-local unless listed as REAL above.
