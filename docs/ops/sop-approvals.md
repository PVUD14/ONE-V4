# SOP — High-risk approvals (Settings → Approvals)

> What this is: the operator procedure for requesting, deciding and executing high-risk actions
> under dual control, including the solo-operator safeguard. Why it exists: Appendix 1 §5.4 and
> OPS-17 (M1 slice) — every high-risk action needs a second person or the documented solo
> safeguard, and the operator must know exactly how. Built by OPS-02. Written 2026-09-26
> against base `6864332`.

## Purpose

Make sure no single person can, on impulse, suspend an organisation, release a legal hold,
retire a backlog, flip a high-risk flag or hand out a high-risk capability.

## Which actions need an approval today

| Action | Filed from | Request reasons |
|---|---|---|
| Suspend an organisation (`ORGANIZATION_SUSPEND`) | Organizations → **Suspend…** | `POLICY_VIOLATION`, `FRAUD_SUSPECTED`, `CONTRACT_ENDED`, `ORGANISATION_REQUEST` |
| Change a high-risk feature flag (`FEATURE_FLAG_HIGH_RISK_CHANGE`) | Feature Flags | `PILOT_ROLLOUT`, `EVALUATION_COMPLETE`, `INCIDENT_MITIGATION`, `ROLLBACK` |
| Supersede the event backlog (`OUTBOX_BACKLOG_SUPERSEDE`) | System Health → **Request supersede…** | `PRE_DISPATCHER_BACKLOG`, `INCIDENT_CLEANUP` |
| Release a legal hold (`PRIVACY_HOLD_RELEASE`) | Security → **Request release…** | `OBLIGATION_ENDED`, `CASE_CLOSED`, `ENTERED_IN_ERROR` |
| Grant a high-risk capability (`CAPABILITY_GRANT_HIGH_RISK`) | Settings → **Grant…** | `NEW_RESPONSIBILITY`, `TEMPORARY_COVER`, `ACCESS_REVIEW_OUTCOME`, `CORRECTION` |

High-risk capabilities: `APPROVE_HIGH_RISK`, `CAPABILITY_ADMIN`, `PRIVACY_HOLDS`,
`TRUST_SAFETY_ENFORCE`, `CONTENT_PUBLISH`, `AI_OPS_CONFIGURE`. A flag is high-risk only when
it is marked so, and only in the marked direction (enable for AI features, disable for safety
controls and kill switches). **No flag is marked yet.**

## Who

- Requester: whoever holds the action's own capability.
- Approver: someone holding `APPROVE_HIGH_RISK` (baseline: PLATFORM_SUPER_ADMIN only), who is
  **not** the requester, except under the solo safeguard. An approver may never approve a
  capability grant to themselves.
- Executor: **only the requester**.

## Rules the server enforces

- The approval is bound to the exact action and payload. Any change — a different target,
  reason or cutoff — needs a new request (`APPROVAL_PAYLOAD_MISMATCH`).
- One 24-hour window from filing covers both deciding and executing (`APPROVAL_EXPIRED`).
- An approval is used once.
- A request for something that is not actually high-risk is refused (`APPROVAL_NOT_REQUIRED`).

## Steps

### Requester

1. Start the action from its own screen (table above), choose the reason, file the request.
2. Tell the approver which request it is and why, through a channel you both use. Do not paste
   personal data.
3. When **Settings → Approvals** shows it **Approved**, press **Execute** within the 24 hours.
   The action runs now and is audited with the approval attached.

### Approver

1. **Settings → Approvals**; filter **Pending**.
2. Read the request: action, target, reason, requester. Check it against what you know.
3. **Approve…** (`VERIFIED_NEED`, `POLICY_REQUIREMENT`, `INCIDENT_RESPONSE`,
   `CUSTOMER_REQUEST`) or **Reject…** (`INSUFFICIENT_JUSTIFICATION`, `WRONG_TARGET`,
   `NOT_NEEDED`, `NEEDS_MORE_INFORMATION`).

### Solo safeguard (while only one person holds APPROVE_HIGH_RISK)

1. File the request as above.
2. Wait **15 minutes** (the server refuses earlier with `APPROVAL_SOLO_COOLING_OFF`). Use the
   time to re-read the request as if someone else had filed it.
3. Approve it yourself; it is recorded as **SOLO** in audit. The screen shows whether the SOLO
   email notice was delivered — today it is **not delivered** (HG-7).
4. Execute.

The safeguard switches off by itself as soon as a second person holds `APPROVE_HIGH_RISK`.

## Escalation

- A request you need urgently expires: file again; there is no extension.
- A refusal code you do not recognise: note the reference and log a support case.

## Never do

- Never approve a request you have not read in full.
- Never ask the approver to "just click it".
- Never try to perform a high-risk action another way (for example by editing data directly);
  there is no break-glass bypass.

## Gaps

- **SOLO email notice (HG-7)** is recorded NOT_DELIVERED until a production sender and the
  `security-notification` workflow exist.
- **Not yet gated because no endpoint exists:** raising a flag's cap, publishing a role
  requirement set (OPS-08), bulk personal-data exports. Each will be added when built.
- The "Requests in this view" figure counts the loaded page only (up to 50); the Overview's
  Approvals tile is the server-side count.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — J7 (high-risk grant), O-3 (solo
safeguard); also used in J1 (suspension variant), J3 (supersede) and O-4 (hold release).
