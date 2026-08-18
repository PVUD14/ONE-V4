# PlanThePath V1 Screen Catalog

This catalog is the wireframe-level implementation contract. Each screen must implement permission checks, loading/empty/error states, responsive behavior and accessibility requirements defined in `UX_INFORMATION_ARCHITECTURE.md`.

## Student screens

| ID | Screen | Core components | Primary actions |
|---|---|---|---|
| STU-001 | Home | readiness card, career target, next actions, upcoming events, application updates | continue/apply/prepare/complete |
| STU-002 | Career Targets | primary/secondary targets, explorer | add/change target |
| STU-003 | Career Detail | requirements, skill gap, readiness alignment | select target, add roadmap |
| STU-004 | Roadmap | milestones, tasks, progress timeline | complete/edit allowed tasks |
| STU-005 | Readiness | score, components, history, explanation | view evidence/improvement |
| STU-006 | Assessment Library | recommended/assigned/employer/completed tabs | start/view result |
| STU-007 | Assessment Attempt | instructions, timer, question navigation, integrity notices | answer/submit |
| STU-008 | Assessment Result | score, components, evidence, improvement | add learning task |
| STU-009 | Skills | verified/assessed/declared/gaps | add evidence, view gap |
| STU-010 | Opportunities | search/filter/recommendations | save/view/apply |
| STU-011 | Opportunity Detail | terms/version, employer, eligibility, match explanation | apply/save/track |
| STU-012 | Application Form | consented profile snapshot, resume version, questions | submit |
| STU-013 | Applications | list/pipeline/status | open/withdraw where allowed |
| STU-014 | Application Detail | timeline, submitted snapshot, terms version, events | prepare/withdraw |
| STU-015 | Interviews | upcoming/history/calendar | open preparation |
| STU-016 | Interview Detail | schedule, stage, prep checklist, role context | prepare/reflect |
| STU-017 | Resume Library | versions, status, previews | upload/create/duplicate |
| STU-018 | Resume Builder | structured sections, preview, suggestions | save/export |
| STU-019 | Learning | query workspace, sources, saved learning | ask/save/add task |
| STU-020 | AI Career Coach | conversation list, context, chat, proposed actions | chat/confirm action |
| STU-021 | Tasks | roadmap/institution/completed | acknowledge/complete |
| STU-022 | Documents | file list, verification/share states | upload/manage sharing |
| STU-023 | Notifications | notification center/preferences | read/configure |
| STU-024 | Profile | personal/career/academic relationship data | edit permitted fields |
| STU-025 | Privacy & Security | sessions, sharing, export/deletion | revoke/export/delete |

## Institution screens

| ID | Screen | Primary roles | Core components/actions |
|---|---|---|---|
| INS-001 | Executive Dashboard | Owner/Admin | institution KPIs, readiness, placement, trends |
| INS-002 | Placement Dashboard | Placement | action queues, cohorts, pipeline, interviews |
| INS-003 | Department Dashboard | Dept Head | scoped KPIs, gaps, interventions |
| INS-004 | Faculty Home | Faculty | assigned students, verification queue, assessments/tasks |
| INS-005 | Student Directory | authorized staff | scoped search/filter; controlled bulk actions |
| INS-006 | Student Detail | authorized staff | career/readiness/skills/academic/applications/tasks tabs by permission |
| INS-007 | Academic Verification Queue | Faculty/authorized | verify/reject/request clarification |
| INS-008 | Assessment Library | assessment managers | create/version/assign/archive |
| INS-009 | Assessment Builder | assessment managers | metadata, questions, scoring, readiness eligibility |
| INS-010 | Assessment Assignment | assessment managers | cohorts/students/window/attempt policy |
| INS-011 | Assessment Results | authorized | cohort/student results, integrity indicators |
| INS-012 | Skills Gap Analytics | Placement/Dept/Analyst | gap distribution and drilldown |
| INS-013 | Institution Opportunities | Placement/Admin | create/manage placement opportunities |
| INS-014 | Placement Applications | Placement | institution-authorized placement visibility |
| INS-015 | Interview Calendar | Placement | schedule/status/reminders |
| INS-016 | Intervention Queue | Placement/Counselor | create/assign/track interventions |
| INS-017 | Intervention Detail | assigned staff | timeline, outcome, student response |
| INS-018 | Departments/Programs | Admin | hierarchy management |
| INS-019 | Staff & Access | Owner/Admin | invitations, roles, scopes, revoke |
| INS-020 | Reports | authorized | scoped reports/export where separately granted |
| INS-021 | Knowledge Library | authorized content staff | institution AI knowledge upload/status |
| INS-022 | Notifications | authorized | announcements/transactional templates where allowed |
| INS-023 | Institution Settings | Owner/Admin | profile, branding/co-branding, policies |
| INS-024 | Licensing/Entitlements | billing-authorized | seats/entitlements, no payment secrets |

## Employer screens

| ID | Screen | Primary roles | Core components/actions |
|---|---|---|---|
| EMP-001 | Dashboard | Owner/Admin/Recruiter | hiring KPIs, action queue |
| EMP-002 | Opportunities | Owner/Admin/Recruiter | active/draft/closed list |
| EMP-003 | Opportunity Wizard | authorized | role→requirements→eligibility→terms→selection→preview |
| EMP-004 | Opportunity Detail/Admin | authorized | posting version, metrics, edit/close |
| EMP-005 | Applicant Pipeline | authorized | stage board/list, filters, controlled bulk stage action |
| EMP-006 | Candidate Detail | opportunity-scoped | permitted snapshot, resume, skills, endorsement, results |
| EMP-007 | Employer Assessments | authorized | select platform test/create employer test/assign |
| EMP-008 | Interviews | Recruiter/Hiring/Interviewer | calendar/list and assigned interviews |
| EMP-009 | Interview Scorecard | Interviewer/authorized | competency rubric and submit feedback |
| EMP-010 | Offers | authorized | offer status/outcome tracking |
| EMP-011 | Team & Access | Owner/Admin | recruiter/hiring/interviewer roles and opportunity scope |
| EMP-012 | Company Profile | Owner/Admin | organization profile |
| EMP-013 | Verification | Owner/Admin | evidence/status/requests |
| EMP-014 | Trust Cases | Owner/Admin authorized | case notice, evidence response, appeal |
| EMP-015 | Analytics | authorized | funnel/time-to-stage/hire metrics |
| EMP-016 | Notifications | all scoped | recruitment alerts/preferences |
| EMP-017 | Settings | Owner/Admin | organization configuration |

## Platform Operations screens

| ID | Screen | Primary roles | Core components/actions |
|---|---|---|---|
| OPS-001 | Operations Overview | scoped Ops | queues, platform health, operational KPIs |
| OPS-002 | Institution Directory | Ops | verification/status/search |
| OPS-003 | Institution Review | Ops | evidence, approve/reject/suspend with reason |
| OPS-004 | Employer Directory | Ops/Moderator | verification/trust/status |
| OPS-005 | Employer Review | Ops/Moderator | evidence, approve/reject/suspend |
| OPS-006 | User Search | Support/Ops | account/support-safe metadata |
| OPS-007 | User Support Detail | Support/Ops | state, memberships, limited audit, safe actions |
| OPS-008 | Opportunity Moderation | Moderator/Ops | flags, posting terms, approve/reject/remove |
| OPS-009 | Trust & Safety Cases | Moderator/Security | queue/classification/assignment |
| OPS-010 | Case Detail | assigned investigator | evidence, response, decision, sanction, appeal |
| OPS-011 | Plans & Pricing | Billing | configurable plans/prices/versions |
| OPS-012 | Subscriptions | Billing | lifecycle/status |
| OPS-013 | Payments/Reconciliation | Billing | gateway references, reconciliation/refund controls |
| OPS-014 | Entitlements | Billing/Ops | grant/suspend/expire with audit |
| OPS-015 | Career/Skill Taxonomy | Content | versioned taxonomy management |
| OPS-016 | Platform Assessments | Content | assessment catalog/versioning |
| OPS-017 | AI Operations | restricted | routing, prompt/policy versions, usage/cost/evals |
| OPS-018 | Feature Flags | restricted Ops | scoped flag changes with audit |
| OPS-019 | Audit Search | Security/Ops scoped | privileged/security event search |
| OPS-020 | Security Overview | Security | auth/session/denial/alert views |
| OPS-021 | Integration Health | Security/Ops | dependency health/security metadata |
| OPS-022 | System Health | Ops | queues/jobs/providers/status links |

## Global dialogs/components

- Permission denied / access expired
- Organization context switcher
- Destructive-action confirmation with reason where required
- Material-term-change warning
- Consent/share confirmation
- Session-expired reauthentication
- File quarantine/scan status
- AI proposed-action confirmation
- Bulk-action scope preview
- Export request confirmation
- Account deletion workflow

## Definition of done for a screen

A screen is not complete until: authorized role/scope is documented; API dependencies are identified; loading/empty/error/permission states exist; destructive and consequential actions are confirmed; audit requirements are implemented for privileged mutations; mobile/responsive behavior is tested; keyboard/focus/accessibility checks pass; and no hidden UI action can bypass backend authorization.
