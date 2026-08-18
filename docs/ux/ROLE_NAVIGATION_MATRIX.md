# PlanThePath Role Navigation & Privilege Matrix V1

Legend: **M** manage/create/update; **V** view within authorized scope; **S** self only; **A** assigned scope only; **—** not available by default. Additional ABAC/relationship/consent checks always apply.

| Capability | Student | Inst Owner/Admin | Placement | Dept Head | Faculty | Counselor | Inst Analyst | Employer Owner/Admin | Recruiter | Hiring Mgr | Interviewer | Ops Admin | Security | Support | Billing | Moderator |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Own career profile | M/S | V | V | V/A | V/A | V/A | V | V applicant | V applicant | V applicant | V assigned | support-limited | — | support-limited | — | — |
| Private AI conversations | S | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Career/readiness | S | V | V | V/A | V/A | V/A | V | V applicant/policy | V applicant/policy | V applicant/policy | V assigned/policy | operational | security metadata only | support-limited | — | — |
| Academic records | S submit | V | V | V/A | M/A verify | V/A | V | permitted applicant evidence only | same | same | assigned briefing only | support-limited | — | support-limited | — | — |
| Assessments take | S | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Institution assessments | — | M | M | M/A | M/A | V/A | V | — | — | — | — | platform ops only | — | — | — | platform content |
| Opportunities apply | S | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| Institution opportunities | V | M | M | V/A | V/A | V/A | V | — | — | — | — | moderate/support | — | support-limited | — | M moderate |
| Employer opportunities | V | V | V | V | V | V | V | M | M | V/M assigned | V assigned | verify/suspend | security action | support | — | M moderate |
| Applicant pipeline | S status | institution visibility only | institution visibility | scoped visibility | — | scoped coaching | V | M own org | M assigned | M assigned | V assigned interview | support-limited | security metadata | support-limited | — | case-only |
| Interviews | S | V | M | V/A | — | V/A | V | M | M | M | M assigned scorecard | support | — | support | — | — |
| Interventions | S receive | M | M | M/A | M/A | M/A | V | — | — | — | — | support | — | support | — | — |
| Staff/team access | — | M institution | limited by grant | — | — | — | — | M employer | — | — | — | support/admin | security review | support-limited | — | — |
| Employer verification | — | — | — | — | — | — | — | M submit/respond | V | V | — | M approve | V/security action | support | — | M case |
| Trust/Safety report | M | M | M | M | M | M | — | M | M | M | M | M investigate if assigned | M security cases | intake/support | — | M investigate |
| Institution reports | — | V | V | V/A | limited | V/A | V | — | — | — | — | operational | — | support-limited | — | — |
| Employer analytics | — | — | — | — | — | — | — | V | V assigned | V assigned | — | operational | — | support-limited | — | — |
| Plans/subscriptions | S own | V institution if granted | — | — | — | — | — | future employer if granted | — | — | — | operational | — | support-limited | M | — |
| AI model/prompt config | — | — | — | — | — | — | — | — | — | — | — | restricted if explicitly granted | security review | — | — | content policy only |
| Audit logs | own limited | V institution admin scope | limited | — | — | — | — | V employer admin scope | — | — | — | operational | M security scope | limited support timeline | billing events | case audit |
| Security events/sessions | own sessions | institution membership events | — | — | — | — | — | employer membership events | — | — | — | operational | M | limited | — | — |

## Navigation composition rules

1. Role names do not directly render menus. Effective capabilities render menus.
2. Multiple roles within the active organization produce the union of permitted navigation/actions, constrained by the narrowest applicable resource scope.
3. Organization context is explicit. Institution permissions do not carry into Employer context and vice versa.
4. Historical institution relationships never authorize access to activity occurring after relationship end.
5. Employer applicant access requires an opportunity relationship and valid consent/access grant.
6. Feature entitlement controls product availability but never grants data access beyond authorization policy.
7. Platform support access is deliberately narrower than Platform Super Admin and must not become a bypass.

## Sensitive UI decisions

- Never display a private-AI-chat menu to Institution, Employer or ordinary Platform staff.
- Never expose a generic student directory to Employers in V1.
- Never show a former institution current student activity.
- Never expose global export controls merely because a role can view individual records.
- Disabled actions should explain missing business preconditions when safe; authorization failures should not leak inaccessible resource existence.
- High-risk administrative actions require reason capture, confirmation and audit.
