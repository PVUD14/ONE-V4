# ONE Role Availability V1

> **Status: partly superseded — 2026-09-05.** The role-availability gaps recorded below are
> resolved by [ADR-018 — Role Model Consolidation](../architecture/ADR-018-role-model-consolidation.md):
> Interviewer is to be enabled scoped to three screens, Hiring Manager folds into Recruiter,
> Career Counselor folds into institution staff, and Institution Analyst is dropped as a role in
> favour of an analytics capability. Read the ADR before planning work against the table below.

No credentials are stored in this document. Passwords are in the operator-local file outside Git: `E:\8-PTPN-UAT-TEMP\identity\ONE_UAT_CREDENTIALS.local.txt`.

## UAT Cognito

- AWS account: 221388536238
- Region: ap-south-1
- User pool: ap-south-1_nPl3qFkvB
- Public SPA client: 1i2kqvh3hknfq6ntf1eph6nt5t
- Managed login domain: https://one-uat-221388536238.auth.ap-south-1.amazoncognito.com

## Role availability

Phase 1.1 status: role identities are provisioned, but browser UAT must be rerun after the authenticated routing/sign-out correction before any row is promoted from "login available" to manual login PASS. The Institution Administrator and Student A mappings were verified to use different Cognito subjects and different internal users; Institution Administrator has no active Student relationship.

Phase 1.2 status: the visible ONE email/password form is the normal Cognito SRP login path, backed by the public UAT app client without a client secret. Browser auth state is session-scoped and must survive refresh; logout must clear session-scoped auth state and return to `/login`. Authenticated Student pages must use `/api/v1/students/me` and truthful empty states, never Rahul/demo fixtures.

| Role | Login available? | Backend role? | Portal | Real capabilities | Partial capabilities | Preview-only capabilities | Blockers |
|---|---:|---|---|---|---|---|---|
| Student A | Yes | Active institution relationship, no org membership | Student | Career Readiness learner endpoints where seeded data exists; lesson/assessment mutations are API-backed | Opportunity/application/profile UI mutations are session-local | Most Student modules beyond Career Readiness | Broader student persistence not implemented |
| Student B | Yes | Active institution relationship, no org membership | Student | Same as Student A; isolation test identity | Same as Student A | Same as Student A | Same as Student A |
| Institution Administrator | Yes | INSTITUTION_ADMIN | Institution | Create/edit institution units; add/update students; end/graduate/transfer relationships; roster preview/commit; invite allowed staff | Reports depend on cohort/data thresholds | Non-admin institution modules use preview shells | More UI for all admin flows and reporting depth |
| Placement Admin | Yes | PLACEMENT_ADMIN | Institution | Read institution students; institution aggregate report authorization | Placement workflow is partially modeled | Most placement coordination controls are preview | Persistent placement/intervention/applications tables missing |
| Faculty Lecturer | Yes | FACULTY_LECTURER | Institution | Institution staff context; student list authorization | Staff-facing academic workflows partly represented | Assessment/task/resource controls are preview | Backend persistence for faculty workflows missing |
| Department Head | Yes | DEPARTMENT_HEAD | Institution | Institution staff context; student list; aggregate report authorization | Department reporting partially backed | Department workload/meeting controls are preview | Department-scoped persistence/UI incomplete |
| Institution Analyst | No | Not accepted by DB trigger | Institution | None as distinct role | None | UI preview exists only in `/demo/institution/analyst` | Backend role not implemented |
| Career Counselor | No | Not accepted by DB trigger | Institution | None as distinct role | None | UI preview exists only in `/demo/institution/career-counselor` | Backend role not implemented |
| Recruiter | Yes | RECRUITER | Employer | Employer membership context; applicant grant authorization where grants exist | Employer hiring page truthfully reports partial backend | Opportunity/application/interview/offer controls are preview | Employer opportunity/application persistence missing |
| Hiring Manager | No | Not accepted by DB trigger | Employer | None as distinct role | None | UI preview exists only in `/demo/employer/hiring-manager` | Backend role not implemented |
| Interviewer | No | Not accepted by DB trigger | Employer | None as distinct role | None | UI preview exists only in `/demo/employer/interviewer` | Backend role not implemented |
| Operations Admin | Yes | OPERATIONS_ADMIN | Operations | Organization create/edit/verification/onboarding; Career Readiness import/status endpoints | Trust/support/feature flag modules are preview | Many operational queue controls are preview | Dedicated support/security/ops services missing |
| Platform Super Admin | Yes | PLATFORM_SUPER_ADMIN | Operations | Same API authorization family as Operations Admin | No distinct super-admin UI surface yet | Super-admin-specific controls are not separate | Need explicit policy/UI for super admin powers |
| Security Admin | Not provisioned | SECURITY_ADMIN accepted by DB trigger but no UI/API-specific capability found | Operations | No distinct tested capability | Role exists at persistence scope only | No visible portal differentiation | Needs policy and UI/API implementation |
| Institution + Employer | Yes | INSTITUTION_ADMIN + RECRUITER | Multi-workspace | Server-authorized workspace chooser should show Institution and Employer only | Same limitations as each role | Preview controls remain preview | Needs browser UAT confirmation after deployment |

## What roles can I actually log into today?

You can log into: Student A, Student B, Institution Administrator, Placement Admin, Faculty Lecturer, Department Head, Recruiter, Operations Admin, Platform Super Admin, and the multi-workspace Institution+Employer persona.

You cannot truthfully log into distinct real Career Counselor, Institution Analyst, Hiring Manager, or Interviewer roles yet because the current backend membership guard rejects those roles.
