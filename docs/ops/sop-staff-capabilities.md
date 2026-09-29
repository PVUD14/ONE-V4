# SOP — Platform staff and capabilities (Settings)

> What this is: the operator procedure for seeing platform staff and granting or revoking
> internal capabilities. Why it exists: Appendix 1 OPS-17 (M1 slice); journey J7 ("grant a new
> staff member the support capability"). Built by OPS-01 (ADR-032) with OPS-02's approval path
> for high-risk grants. Written 2026-09-26 against base `6864332`.

## Purpose

Give each operator exactly the powers their work needs, record why, and take them away when
the work ends.

## Who and what capability

`CAPABILITY_ADMIN` — baseline PLATFORM_SUPER_ADMIN only. Granting a high-risk capability also
needs an approval ([sop-approvals.md](sop-approvals.md)).

## Where

**Operations → Settings** → *Staff and capabilities* (the Approvals queue is above it).

## How capabilities work

- Only **ACTIVE platform memberships** (PLATFORM_SUPER_ADMIN, OPERATIONS_ADMIN,
  SECURITY_ADMIN) can hold internal capabilities. A college or employer membership cannot
  (the API and a database trigger both refuse).
- Each role has a **baseline** set (shown in the *Baseline* column). An **explicit grant** adds
  one capability on top.
- Changing a person's role revokes their explicit grants automatically (`ROLE_CHANGED`).
- Nobody can change capabilities on their own membership, in either direction.
- Navigation does not grant anything; every screen's server checks the capability.

## A. Add a new staff member (J7)

1. The person must first have a platform membership. **Creating a platform staff membership
   has no screen** (Gap G1).
2. On *Staff and capabilities* find their row. Check the *Baseline* column: many tasks are
   already covered by the role.
3. For a missing capability choose it in *Grant a capability* → **Grant…** → reason
   (`NEW_RESPONSIBILITY`, `TEMPORARY_COVER`, `ACCESS_REVIEW_OUTCOME`, `CORRECTION`) → confirm.
4. For a **high-risk** capability the dialog files an approval request instead; it runs when you
   execute the approved request ([sop-approvals.md](sop-approvals.md)).
5. Ask the person to reload ONE. Check they can open the intended screen — and that screens
   outside their capabilities show *Not permitted* or NA.

## B. Revoke

1. On their row, **Revoke** next to the grant → reason (`RESPONSIBILITY_ENDED`,
   `ACCESS_REVIEW_OUTCOME`, `LEAVER`, `SECURITY_INCIDENT`, `CORRECTION`) → confirm.
2. The revoke takes effect on the person's next request. No approval is needed to revoke.

## C. A leaver

1. Revoke every explicit grant with `LEAVER`.
2. Ending the platform membership itself has no screen (Gap G1).
3. Their Cognito user must be disabled in AWS — Divakar only.

## Escalation

- A grant refused with `CAPABILITY_SELF_CHANGE_REFUSED`: someone else must do it.
- A capability that the table in Appendix 1 §6.2 lists differently from the baseline shown:
  expected — ADR-032 keeps today's behaviour (divergences D1–D6) until each is tightened by its
  own ADR.

## Never do

- Never grant a capability "to be safe"; baselines already cover the pilot's routine tasks.
- Never share a staff account.
- Never grant `CONTENT_REVIEW_EXTERNAL` from here; it belongs to the faculty-reviewer flow
  (OPS-10, not built).

## Gaps (need engineering or AWS)

- **G1 — Creating, changing or ending a platform staff membership has no screen or endpoint.**
  Today it is a data change by engineering. `changeMembershipRole` exists in persistence only.
- **G2 — Quarterly access review** (J11) is built by OPS-15: see
  [sop-access-reviews.md](sop-access-reviews.md).
- **G3 — Staff sign-in with MFA** is not live; see [sop-staff-access.md](sop-staff-access.md).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — J7.
