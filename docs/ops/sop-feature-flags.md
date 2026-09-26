# SOP — Feature Flags

> What this is: the operator procedure for switching a feature flag globally, including the
> dual-controlled direction of a high-risk flag. Why it exists: Appendix 1 OPS-17 (M1 slice);
> OPS-02 put high-risk flag changes under dual control. Written 2026-09-26 against base
> `6864332`.

## Purpose

Roll a feature out, or switch it off in an incident. A flag is never an entitlement: access
still depends on role and membership.

## Who and what capability

`OPS_FLAGS_MANAGE` — baseline OPERATIONS_ADMIN, and SECURITY_ADMIN (ADR-032 divergence D1).
The risky direction of a high-risk flag also needs an approval.

## Where

**Operations → Feature Flags**.

## Steps

1. Read the flag's row: key, description, state, cap, overrides, last changed. A
   **High-risk to enable / disable** badge marks the direction that needs approval.
2. **Ordinary change:** type a reason code in *Reason code recorded with every change* (capital
   letters, digits, `_ : -`, 3–64 characters, e.g. `PILOT_ROLLOUT`), then **Enable** or
   **Disable**. The change and reason are audited.
3. **High-risk direction:** the button shows **Enable…** / **Disable…** and opens an approval
   request instead (`PILOT_ROLLOUT`, `EVALUATION_COMPLETE`, `INCIDENT_MITIGATION`, `ROLLBACK`).
   Follow [sop-approvals.md](sop-approvals.md); the change happens when you execute it.

## Never do

- Never enable an AI feature: the AI hold (ADR-030) stands until Divakar lifts it.
- Never use a flag to give one customer something another has not paid for.

## Gaps

- **Per-college enablement (J6)** — organisation overrides and caps have no API; the
  *Overrides* and *Cap* columns are read-only. Not in this slice.
- **Reason codes for ordinary changes are free text** checked only against the pattern, not a
  fixed list as Appendix 1 §5.3 asks (recorded in the operations security review).
- **No flag is marked high-risk yet**; marking one is a migration (engineering).
- The AI global kill switch (J10) belongs to AI Operations (OPS-12); not in this slice.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — O-6.
