# SOP — Operations Overview (daily triage)

> What this is: the standard operating procedure for starting an operations day from the
> Overview screen. Why it exists: Appendix 1 (OPS-17, M1 slice) requires an SOP for every
> shipped module so one person can run the pilot without engineering help. Built by OPS-03.
> Written 2026-09-26 against base `6864332`.

## Purpose

See, in one screen, every operator queue that needs attention and open the screen where each
is worked. The Overview only reads; nothing is changed from it.

## Who and what capability

Anyone holding any internal capability except `CONTENT_REVIEW_EXTERNAL` — today the three
ACTIVE platform roles. Each tile needs the capability of the screen it links to:

| Tile | Capability | Opens |
|---|---|---|
| Organizations | `OPS_ORG_MANAGE` | Organizations |
| Verification | `OPS_VERIFY` | Verification |
| Employer access requests | `OPS_ORG_MANAGE` | Organizations |
| Invitations | `OPS_ORG_MANAGE` | Users |
| Accounts | `ANALYTICS_VIEW` | Users |
| Trust and safety | `TRUST_SAFETY_INVESTIGATE` | Trust and Safety |
| Jobs | `OPS_JOBS_REPLAY` | System Health |
| Privacy requests | `PRIVACY_REQUESTS` | Security |
| Legal holds | `PRIVACY_HOLDS` | Security |
| Approvals | `APPROVE_HIGH_RISK` | Settings |
| Support | `SUPPORT_CASES` | Support |

A tile you are not allowed to see shows **NA** — that is expected, not a fault.

## Steps (every working day, and after any alert)

1. Sign in and open **Operations → Overview**.
2. Work the tiles in this order, because the earlier ones have deadlines or affect people:
   1. **Approvals** — pending requests expire 24 hours after they were filed. Open
      **Settings** and follow [sop-approvals.md](sop-approvals.md).
   2. **Privacy requests** — "deletions scheduled within 7 days" and "failed". Open
      **Security** and follow [sop-privacy.md](sop-privacy.md).
   3. **Jobs** — failed events and open health alerts. Open **System Health** and follow
      [sop-system-health.md](sop-system-health.md).
   4. **Support** — "past SLA" first, then "unassigned". Open **Support** and follow
      [sop-support.md](sop-support.md).
   5. **Verification** and **Employer access requests** — open **Organizations** and follow
      [sop-organizations.md](sop-organizations.md).
   6. **Invitations** — pending over 72 hours and not delivered. Open **Users** and follow the
      invitation part of [sop-organizations.md](sop-organizations.md).
   7. **Trust and safety** — see "Not in this slice" below.
3. A count shown as **10,000+** is capped on purpose; open the linked screen to work the list.
4. If the whole Overview shows an error, note the reference shown on screen and see
   Escalation.

## What the numbers mean

- Queue counts (requests, cases, events, approvals, invitations) are never suppressed: they
  count work you can open anyway.
- **Accounts** counts are counts of people; any value under 5, including 0, shows **<5**.
- Nothing on the Overview is invented. A missing source shows NA or 0; no tile is ever removed.

## Escalation

- A screen error with a reference: retry once. If it persists, open a support case for
  yourself (category `TECHNICAL_FAULT`, reason `MONITORING_ALERT`) quoting the reference, and
  check **System Health** for failed events.
- A tile that should be visible shows NA: check your capabilities on **Settings**
  ([sop-staff-capabilities.md](sop-staff-capabilities.md)).

## Never do

- Never treat NA as zero, or zero as "all clear", for a tile you cannot see.
- Never copy personal data from any screen into chat, email or a ticket outside ONE.

## Not in this slice

- **Trust and Safety** is the pre-existing screen; its evidence and enforcement workflow is a
  later OPS goal. Journey J5 is not in this slice.
- **Analytics**, **Subscriptions**, **Billing** and **AI Operations** are not built and say so.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — script O-0 (Overview triage).
