# Authorization Matrix

PlanThePath uses RBAC for coarse role assignment plus scoped/temporal ABAC for resource decisions. Every protected API performs server-side authorization.

## Platform roles

| Role | Scope | Key permissions |
|---|---|---|
| Platform Super Admin | platform | break-glass/highest privilege; tightly limited |
| Operations Admin | platform | institution/employer lifecycle, moderation operations |
| Security Admin | platform | security events, account/security enforcement |
| Support Agent | assigned cases | support workflows; no bulk sensitive export |
| Billing Admin | billing | plans, transactions, entitlements |
| Content/Moderation Admin | moderation | opportunity/content/safety workflows |

## Institution roles

| Role | Default scope |
|---|---|
| Institution Owner/Admin | institution |
| Placement Admin/Officer | institution or assigned cohorts |
| Department Head | assigned department |
| Faculty/Lecturer | assigned department/batch/students |
| Career Counselor | assigned students/cohorts |
| Analyst | approved aggregate/read-only views |

Institution access additionally requires an active, valid institution relationship. A former institution MUST NOT see student activity created after the relationship effective end time.

## Employer roles

| Role | Default scope |
|---|---|
| Employer Owner/Admin | employer organization |
| Recruiter | assigned opportunities/applicant pipelines |
| Hiring Manager | assigned opportunities/stages |
| Interviewer | assigned interview/candidate context only |

Employers cannot browse private student records. Applicant data becomes visible only through an authorized opportunity/application/consent relationship.

## Student roles

Student/Graduate can manage their own profile, roadmap, documents, applications, assessments, privacy/export/deletion requests, and private AI conversations subject to platform policy.

## Mandatory policy attributes

Authorization decisions may require: actor ID, account state, role, organization ID/type, resource owner, institution relationship type/status/effective timestamps, department/program/batch assignment, opportunity ownership, application ID/state, consent snapshot, case assignment, and requested action.

## Non-negotiable denials

- cross-tenant access without explicit platform authority
- former institution access to subsequent student activity
- employer access to non-applicant private student data
- institution/employer access to private AI chat content
- AI tool execution without the same domain authorization required of a human/API caller
- suspended/disabled principal access beyond explicitly allowed recovery/support flows
- lecturer verification outside assigned scope

## Testing requirement

Each protected resource requires positive and negative authorization tests, including cross-role, cross-tenant, expired-relationship, object-ID tampering, and privilege-escalation cases.