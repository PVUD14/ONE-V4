# ADR-026 — Interviewer Capability Follows Assignment, Not a Role Grant

**Status:** Accepted
**Decision date:** 2026-09-08
**Scope:** How a person gets the interviewer surface in the employer portal
**Amends:** ADR-018 — Role Model Consolidation, which enables `INTERVIEWER` as a membership role

## Context

ADR-018 decided that Interviewer would be enabled as an employer membership role, scoped to three
screens — My Interviews, Candidate Brief, Scorecards — because it is the only one of the four blocked
roles with a backend already underneath it.

That remains the right scope. The mechanism is worth revisiting.

Enabling it as a membership role means somebody has to grant it. An employer admin adds a colleague
as an Interviewer, that membership persists, and it has to be revoked when the person stops
interviewing or leaves. Every one of those steps is an administrative action that can be forgotten,
and a forgotten one leaves standing access to candidate data.

The data needed to avoid that already exists. `interview_participants` records who is on an
interview, and its `participant_role` constraint already admits `INTERVIEWER`. Being named on an
interview is a fact the system already holds, created as a natural side effect of scheduling.

## Decision

**A person sees the interviewer surface for an interview because they are a participant on that
interview, not because someone granted them an Interviewer role.**

Authorization for the three interviewer screens resolves through `interview_participants` scoped to
the specific interview, in addition to the existing employer membership and organisation scope
checks. No new membership role is admitted to the database trigger.

`INTERVIEWER` therefore joins Hiring Manager and Career Counselor as a role that is **not enabled**,
leaving all four of ADR-018's blocked roles unenabled and Institution Analyst still dropped.

## Why

- **No provisioning step to forget.** Access appears when an interview is scheduled and ends when the
  interview does. Nobody has to remember to revoke it.
- **Least privilege by construction.** A membership role grants a standing view of the employer's
  interviews. Participation grants a view of one interview. The second is what the job actually
  requires.
- **Leavers are handled by the data.** Someone who leaves the company stops being scheduled, and
  their access decays without an offboarding step. Their employer membership still gates entry, so
  removing that continues to cut access immediately.
- **It removes work rather than adding it.** ADR-018's three screens still get built, but the
  trigger migration, the workspace mapping entry, and the role-provisioning surface all disappear.

## Consequences

- The Core migration ADR-018 anticipated — adding `INTERVIEWER` to the employer role array — is **not
  written**. Migration 0016 stays unused.
- An interviewer must still hold an employer membership to reach the portal at all. This decision
  narrows what an existing member can see; it does not let a stranger in. Invariant 1 is unchanged:
  authentication is not authorization, and participation is not membership.
- The three screens are authorized per interview rather than per employer. A participant sees the
  candidate brief for interviews they are on and nothing else — which is also the correct answer for
  a panel member from another department.
- Whoever schedules an interview is implicitly granting access to that candidate's brief. That is the
  right person to hold the decision, but it should be visible in the scheduling screen rather than
  implied, so the scheduler knows what adding a participant does.
- Reversing this is not hard: the role can still be admitted to the trigger later if a customer needs
  a standing interviewer role independent of assignment. Nothing here forecloses that.

## Implementation notes

Depends on the employer interview read endpoint, which shipped in release `21adf00`. Sequence:

1. Extend the employer authorization helper so an interview-scoped read succeeds for a participant on
   that interview, not only for the manage/interview role sets.
2. Build My Interviews, Candidate Brief and Scorecards against that check.
3. Surface participant addition in the scheduling screen as what it is — granting sight of the
   candidate — rather than as a silent list edit.

Stream B owns the employer surface and the authorization helper. The policy predicate belongs in
`packages/authorization` alongside the existing employer and institution policies, which is Core.
