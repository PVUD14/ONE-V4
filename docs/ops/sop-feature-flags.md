# SOP — Feature Flags

> What this is: the operator procedure for switching a feature flag globally, including the
> dual-controlled direction of a high-risk flag. Why it exists: Appendix 1 OPS-17 (M1 slice);
> OPS-02 put high-risk flag changes under dual control. Written 2026-09-26 against base
> `6864332`; updated 2026-10-01 against base `719eb34` (flags marked high-risk by OPS-12, EMP-13
> and EMP-14).

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

## The flags that exist

| Flag | Default | High-risk direction | Notes |
|---|---|---|---|
| `employer-access.allow-free-mail` | off | none | Lets webmail addresses request employer access. It relaxes an abuse control, so change it only with a support case recording why |
| `career-catalogue.selectable-roles` | off | none | Shows the full 108-role catalogue to students ([sop-role-catalogue.md](sop-role-catalogue.md)) |
| `ai.global-kill-switch` | off (not engaged) | DISABLE | **Engage and release it from AI Operations, not here** ([sop-ai-operations.md](sop-ai-operations.md)) |
| `ai.assistant` | off | ENABLE | It is switched on only together with the server variables. The AI hold applies |
| `employer.skill-evidence` (EMP-13) | off | ENABLE | HG-4 approved 2026-10-01 (ADR-043/044) |
| `employer.talent-pool` (EMP-14) | off | ENABLE | HG-4 approved. **Publish the legally approved discovery-consent wording (HG-6) before switching on.** Nothing in the code enforces this order |

### Switching on an employer evidence flag (EMP-13 / EMP-14)

1. Confirm with Divakar that it is time. For `employer.talent-pool`, also confirm that the HG-6
   consent wording has been published.
2. Press **Enable…** on the row, choose the reason `PILOT_ROLLOUT`, then press **Request approval**.
3. A second person approves it in **Settings → Approvals**. If you are alone, you can approve it
   yourself after the 15-minute cooling-off; it is marked SOLO.
4. **Execute** within 24 hours.

Switching either flag **off** is an ordinary change and takes effect at once.

## Never do

- Never enable an AI feature: the AI hold (ADR-030) stands until Divakar lifts it.
- Never use a flag to give one customer something another has not paid for.

## Gaps

- **Per-college enablement (J6) is not built.** Organisation overrides and caps have no API.
  - The *Live overrides* and *With a cap* tiles can only be non-zero through a direct database change.
  - Only `career-catalogue.selectable-roles` reads overrides at all.
- **Reason codes for ordinary changes are free text.** They are checked only against the pattern,
  not against a fixed list as Appendix 1 §5.3 asks (security review OPS-SR-16).
- **An ordinary change writes no audit-log row.** It is recorded only in the flag's own history,
  which no screen shows, so it does not appear in Audit Logs (security review OPS-SR-33). Log every
  ordinary change in a support case or incident note as well.
- Marking another flag high-risk needs a migration (engineering).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-6 and O-19. J6 is not built.
