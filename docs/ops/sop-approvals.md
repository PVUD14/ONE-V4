# SOP — High-risk approvals (Settings → Approvals)

> What this is: the operator procedure for requesting, deciding and executing high-risk actions
> under dual control, including the solo-operator safeguard. Why it exists: Appendix 1 §5.4 and
> OPS-17 (M1 slice) — every high-risk action needs a second person or the documented solo
> safeguard, and the operator must know exactly how. Built by OPS-02. Written 2026-09-26
> against base `6864332`; updated 2026-10-01 against base `719eb34` with the eight approval
> actions added since (OPS-08, OPS-09a/b/c, OPS-12, OPS-16, INST-18) and the flags now marked
> high-risk.

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
| Publish a role requirement set (`CAREER_REQUIREMENT_SET_PUBLISH`) | Content Management → Job-role catalogue → **Request publish…** | see [sop-role-catalogue.md](sop-role-catalogue.md) |
| Publish a skill that changes readiness inputs (`CONTENT_SKILL_PUBLISH`) | Content Management → Skill map → **Request publish…** | see [sop-content-authoring.md](sop-content-authoring.md) |
| Publish a question (`CONTENT_QUESTION_PUBLISH`) | Content Management → Question bank → **Request publish…** | see [sop-content-authoring.md](sop-content-authoring.md) |
| Publish a base lesson, or change its topic or prerequisites (`CONTENT_LESSON_PUBLISH`) | Content Management → Lessons and variants → **Request publish…** | see [sop-content-authoring.md](sop-content-authoring.md) |
| Switch an AI feature on (`AI_FEATURE_ENABLE`) | AI Operations → **Switch on…** | `EVALUATION_COMPLETE`, `PILOT_ROLLOUT`, `INCIDENT_RESOLVED` |
| Raise an AI feature's limits (`AI_FEATURE_LIMITS_RAISE`) | AI Operations → **Change limits…** | `DEMAND_GROWTH`, `PILOT_EXPANSION`, `CORRECTION` |
| Publish a status-notice template (`COMMS_TEMPLATE_PUBLISH`) | Settings → Status communications → **Ask for approval…** (the draft's author only) | `INCIDENT_COMMUNICATION`, `PLANNED_COMMUNICATION`, `WORDING_CORRECTION` |
| Delete a departed college's records (`INSTITUTION_DATA_PURGE`) | Organizations → College exits → **Request deletion…** | `RETENTION_PERIOD_ENDED` (see [../institution/sop-college-exit.md](../institution/sop-college-exit.md)) |

You always carry out an approved request from **Settings → Approvals → Execute**, or from the
module's own button, which replays it.

High-risk capabilities are `APPROVE_HIGH_RISK`, `CAPABILITY_ADMIN`, `PRIVACY_HOLDS`,
`TRUST_SAFETY_ENFORCE`, `CONTENT_PUBLISH`, `AI_OPS_CONFIGURE` and `GROWTH_FINANCE`.

A flag is high-risk only when it is marked so, and only in the marked direction. These are marked today:

| Flag | High-risk direction | Default |
|---|---|---|
| `ai.global-kill-switch` | DISABLE (releasing it) | off (not engaged) |
| `ai.assistant` | ENABLE | off |
| `employer.skill-evidence` (EMP-13) | ENABLE | off |
| `employer.talent-pool` (EMP-14) | ENABLE | off |

`employer-access.allow-free-mail` and `career-catalogue.selectable-roles` are not marked, so a
change in either direction is an ordinary change.

**Some actions are deliberately not dual-controlled.** Each is recorded and audited instead:

- archiving content;
- engaging the AI kill switch or switching AI off;
- access-review decisions;
- granting faculty review access;
- college account changes;
- incident changes;
- publishing employer and college terms;
- a college's exit notice, end and cancel.

Sending a notice has its own second-person rule (see
[sop-incidents-and-status-notices.md](sop-incidents-and-status-notices.md)).

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
3. Approve it yourself. It is recorded as **SOLO** in audit. The screen shows whether the SOLO
   email notice was delivered. Today it is **not delivered**: the SMTP sender is built but not
   switched on, and the `security-notification` workflow is not active.
4. Execute.

The safeguard switches off by itself as soon as a second person holds `APPROVE_HIGH_RISK`.

**Watch for this:** the server counts approvers at the moment of the decision. Revoking the second
approver's `APPROVE_HIGH_RISK` (on Settings, or as an access-review decision) re-opens the solo
path at once. That includes a request filed while two approvers existed (security review
OPS-SR-04). Never revoke the other approver while you have a request pending.

## Escalation

- A request you need urgently expires: file again; there is no extension.
- A refusal code you do not recognise: note the reference and log a support case.

## Never do

- Never approve a request you have not read in full.
- Never ask the approver to "just click it".
- Never try to perform a high-risk action another way (for example by editing data directly);
  there is no break-glass bypass.

## Gaps

- **SOLO email notice:** it is recorded NOT_DELIVERED until the sender is switched on and the
  `security-notification` workflow is active.
- **Not yet gated, because no endpoint exists:** raising a flag's cap (there is no cap API) and bulk
  personal-data exports.
- **Not gated although the endpoint exists:** Trust and Safety enforcement actions exist in the API
  but need **no** approval (security review OPS-SR-28).
- The "Requests in this view" figure counts the loaded page only (up to 50); the Overview's
  Approvals tile is the server-side count.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md) — J7 (high-risk grant), O-3 (solo
safeguard). Also used in J1 (suspension variant), J3 (supersede), O-4 (hold release), J8, J10,
J12, O-8, O-9, O-10 and O-19.
