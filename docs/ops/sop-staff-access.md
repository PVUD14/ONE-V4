# SOP — Staff access readiness (staff identity pool)

> What this is: the operator-facing summary of where staff sign-in stands after OPS-07 and what
> may and may not be done now. Why it exists: Appendix 1 OPS-17 (M1 slice) needs an SOP for
> every shipped module; OPS-07 shipped code that is off by default plus a runbook for AWS work.
> The runbook itself is [runbook-staff-pool.md](runbook-staff-pool.md); this SOP does not repeat
> it. Written 2026-09-26 against base `6864332`.

## Purpose

Once a separate staff Cognito pool (MFA required) is configured, the internal roles
PLATFORM_SUPER_ADMIN, OPERATIONS_ADMIN and SECURITY_ADMIN count only for tokens from that pool.
A student-pool token keeps the person's other access and loses only the internal roles.

## Who

**Divakar only.** Every step changes AWS or production.

## Current state (base `6864332`)

- The staff pool is **not configured**. Nothing has changed for anyone.
- The runbook's Parts A–C (create and verify the UAT staff pool without the app) can be done now.
- **Parts E (re-bind staff) and F (turn enforcement on) must wait** for the staff sign-in entry
  (ADR-025 step 3), which is not built in web or Android. Turning enforcement on before then
  locks every operator out of the Operations portal.
- The production preflight warns when the staff pool is missing; from the security go-live
  release onward run it with `--require-staff-pool`.

## Steps an operator may take today

1. None in the console. Continue signing in as now.
2. If you see *Not permitted* on every Operations screen after a release, check with Divakar
   whether enforcement was turned on; the rollback is in the runbook.

## Never do

- Never set `COGNITO_STAFF_*` on a server before Part D is complete.
- Never paste pool ids, client ids, subs or tokens into the repository, a ticket or chat.

## Gaps (need engineering)

- **Staff sign-in entry (ADR-025 step 3)** — web and Android. Its own goal.
- **Re-binding staff to the staff pool is a hand-run SQL step** (runbook Part E) with an audit
  row. There is no operator screen for it. This is an explicit "ask engineering" step.
- Institution and employer staff are not yet covered by the staff pool (runbook, "Later").

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — O-7 (local enforcement check).
