# SOP — Growth team (Settings → Growth team)

> What this is: the operator procedure for the operations side of the Growth portal: inviting growth
> people, setting their staff type and team, and ending their access. Why it exists: Appendix 1
> OPS-17 (full) needs an SOP for every shipped operations module, and the Growth portal (ADR-040,
> GROWTH-01) added this one to Operations → Settings. Written 2026-10-01 against base `719eb34`.
> The Growth portal itself (its Home, Leads, Field and other pages) is its own module and is
> documented separately when it is built further.

## Purpose

Bring field growth staff onto ONE without giving them anything from Operations. Growth people hold
login roles with **no capability at all**. Every Operations route refuses them, and they never
receive approval or job-health notices.

## Who and what capability

You need `GROWTH_ADMIN`. The super admin holds it by baseline, and it can be granted to an
OPERATIONS_ADMIN only. `GROWTH_FINANCE` is high-risk to grant, and nothing uses it yet. Without
`GROWTH_ADMIN` the section does not appear.

## Where

**Operations → Settings → Growth team**, the last section.

## Steps

1. **Invite a growth person**: **Invitee email**, **Growth role** (Growth executive or Regional
   manager) and **Staff type** (Employee or Contractor, required), then **Send growth invitation**.
   - The invitation lasts 14 days.
   - Until a mail sender is switched on, it is recorded but not emailed. Send the person the link
     through a channel you both trust.
2. **Revoke** a pending invitation with `SENT_IN_ERROR`, `WRONG_EMAIL`, `WRONG_ROLE` or
   `NO_LONGER_NEEDED`. Revoke and re-invite to "resend".
3. For an ACTIVE person:
   - **Save team**: College partnerships or Employer partnerships, a manager, and `NEW_MEMBER`,
     `TEAM_CHANGE`, `MANAGER_CHANGE` or `CORRECTION`.
   - **Remove from <team>**: `LEFT_TEAM`, `TEAM_CHANGE` or `CORRECTION`.
   - **Save staff type**: `ENGAGEMENT_CHANGED` or `CORRECTION`.
   - **End membership**: `LEFT_AI8HT`, `ACCESS_NO_LONGER_NEEDED`, `SECURITY_CONCERN` or
     `CORRECTION`. This also ends their team rows.
4. You cannot act on yourself, or on an operator.

## Never do

- Never give a growth person an operations role or capability. The server refuses it, and it would
  defeat the isolation.
- Never record pay, commission rates or tax details. ONE has no field for them, by design.

## Gaps

- An ended growth membership cannot be reinstated, and the same email cannot be re-invited in the
  same role.
- There is no resend.
- `GROWTH_FINANCE` has no function yet.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-17.
