# SOP — AI Operations (kill switch, features, assistant, evaluations, learning-engine panels)

> What this is: the operator procedure for the AI Operations screen: stopping AI in one action,
> switching a feature or the in-app assistant off or (with approval) on, changing limits, recording
> evaluations, and reading the learning-engine health panels. Why it exists: Appendix 1 OPS-17 (full)
> needs an SOP for every shipped module; journey J10 runs through it. Built by OPS-12 and OPS-13.
> Written 2026-10-01 against base `719eb34`. The incident-time steps live in
> [runbook-ai-kill-switch.md](runbook-ai-kill-switch.md) and are not repeated here.

## Purpose

See what AI is configured and what it has done, and keep the brake within reach of whoever is on
duty. The AI hold was lifted on 2026-10-01 (HG-2, ADR-047): inference runs on an OpenAI-compatible
endpoint on a RunPod pod, reached only by background jobs through ONE AI Orchestration (ENG-20). The first
features (ENG-21's tutor hint and ENG-23's content factory) are registered **switched off**; each runs
only after its evaluation and an approved switch-on (C, F), and the assistant is off. The **Inference endpoint** panel shows whether the server has an endpoint configured,
its host and model, whether a key is set (never the key), and the latest reachability probe —
[runbook-inference-endpoint.md](runbook-inference-endpoint.md) says how to point ONE at the pod.

## Who and what capability

| Task | Capability |
|---|---|
| Read the screen | `AI_OPS_VIEW` (OPERATIONS_ADMIN and SECURITY_ADMIN by baseline) |
| **Stop**: switch a feature off, engage the kill switch, switch the assistant off | `AI_OPS_CONFIGURE` **or** `OPS_FLAGS_MANAGE` (every platform role has the latter) |
| Configure: switch on, change limits, record an evaluation | `AI_OPS_CONFIGURE`. No role holds it by baseline; it is high-risk to grant. The super admin uses it as break-glass, audited |
| Release the kill switch / switch the assistant on | `OPS_FLAGS_MANAGE` to request, plus an approval from an `APPROVE_HIGH_RISK` holder |

## Where

**Operations → AI Operations.** The sections appear in this order:

1. Global AI kill switch
2. In-app assistant
3. AI features
4. Refusals and failures by class
5. Usage over time
6. Usage by organisation
7. Prompt versions
8. Evaluations
9. Learning engine

The calibration and code-sandbox panels are on **System Health** ([sop-system-health.md](sop-system-health.md)).

## A. Stop all AI (J10)

1. **Engage kill switch…** → reason (`INCIDENT_MITIGATION`, `HARMFUL_OUTPUT`,
   `SUSPECTED_KEY_COMPROMISE`, `SPEND_RUNAWAY`, `PRECAUTION`) → **Engage kill switch**.
2. No approval is needed. Stopping is never delayed. In one transaction this:
   - sets the flag;
   - switches off every enabled feature and the assistant;
   - audits each change.

   The very next AI call is refused.
3. **Always engage from this screen, not from Feature Flags.** Setting `ai.global-kill-switch` on
   the Feature Flags screen sets only the flag. It does not switch the features off one by one, so
   they would come back on release (security review OPS-SR-31).

## B. Release the kill switch

1. **Release kill switch…** files an approval request (`FEATURE_FLAG_HIGH_RISK_CHANGE`), with reason
   `PILOT_ROLLOUT`, `EVALUATION_COMPLETE`, `INCIDENT_MITIGATION` or `ROLLBACK`.
2. An approver approves it in Settings → Approvals, and you **Execute** ([sop-approvals.md](sop-approvals.md)).
3. **Releasing switches nothing back on.** Each feature needs its own approved switch-on (C), and
   the assistant its own (D).

## C. One feature

- **Switch off…**: `INCIDENT_MITIGATION`, `QUALITY_CONCERN`, `COST_CONTROL`, `ROLLBACK` or
  `NOT_NEEDED`. Immediate, no approval.
- **Switch on…** is offered only while the kill switch is released and a **passing evaluation**
  exists for the feature's current model and prompt version. Choose `EVALUATION_COMPLETE`,
  `PILOT_ROLLOUT` or `INCIDENT_RESOLVED`.
  - This files an `AI_FEATURE_ENABLE` approval, bound to the model, prompt version and evaluation.
  - A later model change or a later FAIL voids it (`APPROVAL_PAYLOAD_MISMATCH` or `AI_EVALUATION_REQUIRED`).
- **Change limits…**:
  - Lowering takes effect at once: `COST_CONTROL`, `INCIDENT_MITIGATION` or `CORRECTION`.
  - Raising a cap or input limit, or changing the window, files an `AI_FEATURE_LIMITS_RAISE`
    approval: `DEMAND_GROWTH`, `PILOT_EXPANSION` or `CORRECTION`.
  - The bounds are cap 1–10,000,000, window DAY or MONTH, and input 100–500,000 characters.
- **Record evaluation…**: the model, prompt key and version, an evaluation set, 1–20 metrics with
  thresholds, the decision, and a reason (`INITIAL_BENCHMARK`, `MODEL_CHANGE`, `PROMPT_CHANGE`,
  `PERIODIC_REVIEW` or `INCIDENT_REVIEW`).
  - A PASS must meet every threshold it records.
  - Records are append-only; the latest one wins, and a tie counts as FAIL.

## D. The in-app assistant

- **Switch assistant off…** (`INCIDENT_MITIGATION`, `HARMFUL_OUTPUT`, `SUSPECTED_KEY_COMPROMISE`,
  `POLICY_REQUIREMENT`, `PRECAUTION`) takes effect without a restart. Users then see "switched off".
- **Switch assistant on…** files an approval. It only answers when **all four** hold:
  1. the server variable `ASSISTANT_ENABLED=true`;
  2. a provider key is set on the server;
  3. the flag `ai.assistant` is on;
  4. the kill switch is released.

  The console shows the first two as true or false and never changes them. Changing them is
  Divakar's step on the server. **Do not request this while the AI hold stands.**

## E. Read the panels

- Usage, outcomes, failure classes and tokens come from ONE AI Orchestration's own tables. **Cost
  is always NA**, because there is no price table.
- **Usage by organisation**: an organisation standing for fewer than 5 people shows <5 in every figure.
- **Learning engine** (OPS-13):
  - planner decisions per day, over 7, 14 or 30 days;
  - the faculty override rate;
  - the mastery shadow comparison.

  A day with fewer than 5 students is withheld. The shadow panel is withheld under 5 consenting
  students. Each panel prints its source table.

## F. The content factory (ENG-23): switching it on, running its worker

The content factory runs three features: `content.lesson-draft` (lessons and translations),
`content.item-draft` (practice questions) and `content.answer-check`. Its output is staff-only: it
lands as a DRAFT in Content Management and reaches students only when people publish it
([sop-content-authoring.md](sop-content-authoring.md) A2). Design:
[content-factory-design.md](../architecture/content-factory-design.md).

**Switch it on — first in the demo sandbox, then anywhere else, in this order:**

1. The server has the endpoint (`ONE_AI_BASE_URL`, `ONE_AI_API_KEY`, `ONE_AI_MODEL`) in its own
   environment ([runbook-inference-endpoint.md](runbook-inference-endpoint.md)); the sandbox uses its
   own stack and database, never production's.
2. Migrations are applied (0106), then `corepack pnpm --filter @planthepath/persistence ai:register-features`
   registers any feature not yet there, switched off.
3. A bake-off is recorded for the feature's exact model and prompt
   ([deploy/ai-pod/bake-off/README.md](../../deploy/ai-pod/bake-off/README.md), `ai:bake-off-import`).
   `content.item-draft` has no bake-off cases yet, so it cannot be switched on.
4. Here: release the kill switch if engaged (B), then **Switch on…** `content.lesson-draft` and, if
   wanted, `content.answer-check` (C). A second person approves. Lower the cap to what the demo needs.
5. Start the worker where the endpoint variables are set, against the same database:
   `corepack pnpm --filter @planthepath/persistence ai:content-factory` (polls; `--once` drains the
   queue and exits, for a timer). It logs counts and codes only.
6. Check: **Content Management → Lessons and variants → AI drafts** shows **On** and today's use;
   ask for a lesson; the worker logs `content-factory.job.finished`; the draft opens marked AI draft.

**Stop it**: switch the feature off or engage the kill switch (A) — the next job is refused without a
call, even one already queued — then stop the worker. Every refused, rejected and failed job keeps
its reason on the AI drafts card; the generation attempts are in the panels above.

## Never do

- Never switch on a feature that reaches students before the privacy notice names the pod's US
  processing (HG-6); until then AI runs on sample data and staff-only paths.
- Never record an evaluation you did not run. A PASS opens a feature to students.
- Never work around the kill switch by editing `ai_feature_policies` or the flags in the database.

## Gaps

- ENG-23's content factory features are registered switched off; each needs its bake-off record
  before it can be switched on, and `content.item-draft` has no bake-off cases yet.
- The content factory worker is a separate process; nothing in the deployment pack starts it yet.
- The assistant has no prompt-registry version, so the evaluation gate does not apply to it.
- Usage by organisation has no complementary suppression against the screen's totals (security
  review OPS-SR-32).

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): J10, O-15 (engine panels).
