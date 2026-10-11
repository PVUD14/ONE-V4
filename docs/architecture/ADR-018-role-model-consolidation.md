# ADR-018 — Role Model Consolidation

**Status:** Accepted
**Decision date:** 2026-09-05
**Scope:** The four organization roles that are designed and coded but cannot be signed into
**Supersedes:** the "role availability" gaps recorded in `docs/uat/ONE_ROLE_AVAILABILITY_V1.md`

## Context

Four roles have complete navigation, complete page components and a named backend role, but no
identity can be provisioned for them: the membership scope trigger in
`0001_identity_organization_persistence.sql` accepts only

```
PLATFORM_SUPER_ADMIN, OPERATIONS_ADMIN, SECURITY_ADMIN
INSTITUTION_OWNER, INSTITUTION_ADMIN, PLACEMENT_ADMIN, DEPARTMENT_HEAD, FACULTY_LECTURER
EMPLOYER_OWNER, EMPLOYER_ADMIN, RECRUITER
```

and raises `unknown organization role` for anything else. Between them, Career Counselor,
Institution Analyst, Hiring Manager and Interviewer account for **45 designed screens that no user
can open** — roughly a third of the product's designed surface.

Admitting a role to that trigger is one line. That is the cheap part and it is misleading on its
own: each role then needs a `workspaceForMembership` mapping, and beyond that its nine to thirteen
screens need backends that do not exist. Enabling all four would produce four portals of empty
states and four more streams of work, for no capability a user could not already reach.

The decision is therefore taken per role, not as a block.

## Decision

### Interviewer — enable, scoped to three screens

`INTERVIEWER` joins the employer role array in the membership scope trigger.

This is the only one of the four with a backend already underneath it. The `interviews` table
exists, its `participant_role` CHECK already admits `'INTERVIEWER'` and `'HIRING_MANAGER'`, and
interview scheduling is implemented and in use. The role's actual job — see my assigned interviews,
read the candidate brief, submit a scorecard — sits on tables we already have.

Scope is **My Interviews, Candidate Brief, Scorecards**, not the nine screens in the design. The
remaining six are deferred until someone asks for them.

Depends on the employer interview read endpoint (Stream B). Do not enable the role before that
exists, or the portal is three empty states.

### Hiring Manager — fold into Recruiter

Not enabled. Its twelve screens are the Recruiter pipeline under different labels: Requisitions is
Opportunities, Candidates is Applicants, and the remainder are the same records at the same stages.
Two roles over one backend buys nothing until a customer needs approval separated from sourcing.

Revisit when a customer states that requirement, not before.

### Career Counselor — fold into institution staff

Not enabled as a distinct backend role. It is institution staff with counseling vocabulary, and its
distinctive screens — Counselor Sessions, Student Cases, Counseling Notes — are the same record type
Faculty and Department Head also lack: *actor, subject student, type, state, note, due date, audit
trail.*

That record is being built once (Stream C) with a type discriminator. Counseling becomes a type on
it, and three roles are served by one table instead of three tables by three roles.

Note the front end already lists `CAREER_COUNSELOR` in `institutionStaffWorkspaceRoles`; that is
harmless and should stay, because it is where the role will land if this decision is ever reversed.

### Institution Analyst — drop the role, keep the capability

Not enabled, and removed from the roadmap as a role. All eleven of its screens are read and export
over data other institution roles already hold — placement analysis, readiness analysis, skill-gap
analysis, cohort comparison, saved views, exports.

Analytics-and-export becomes a **capability grantable to `INSTITUTION_ADMIN` and `DEPARTMENT_HEAD`**,
not a login. This removes an entire portal from the backlog rather than scheduling it.

## Consequences

- 45 unreachable screens become roughly **three to build**, one capability flag, and two deferrals.
- One migration in the Core block (0016) adds `INTERVIEWER` to the employer role array and nothing
  else. Existing rows are unaffected; the trigger is `BEFORE INSERT OR UPDATE`, so no backfill.
- `workspaceForMembership` in `App.tsx` gains one entry. Roles with no entry return `null` and the
  user reaches an access-denied page rather than another role's workspace — the correct failure.
- The four demo portals stay in the preview build as design reference. They are unreachable in
  production because the demo portal is disabled there, and they must not be presented to customers
  as available capability.
- Reversing any of these is a one-line trigger change plus a workspace mapping. Nothing here is
  hard to undo; the point is to stop building screens for roles nobody can sign into.

## Compliance with existing invariants

Unchanged. Invariant 1 (*authentication is not authorization*) and DP-009 still hold: admitting a
role to the trigger grants scope eligibility, not capability. Every endpoint continues to authorize
on membership, organization scope and relationship state, and an enabled Interviewer with no
interview assignment sees nothing.
