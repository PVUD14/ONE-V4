# AI Evaluations and AI Operations Controls — Table Design

**Status:** Adopted (OPS-12), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-30
**Migration:** `0089_ai_operations.sql` (references only tables up to 0085, plus the approval function)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

The AI hold (ADR-030) is in force: no provider is integrated and no model is called. But ONE AI
Orchestration (`packages/ai-orchestration`, migration 0033) is built, and the day access arrives the
remaining work is one adapter. Before that day, operators need to see and control AI features, and
the ENG-17 runbook (`docs/ops/runbook-ai-kill-switch.md`) lists what is missing:

1. no one-action global AI kill switch;
2. `ai_feature_policies` has no route, no screen and no audit — switching a feature off needs a
   database session only Divakar has, and leaves no audit row;
3. the in-app assistant's switch is only an environment variable (`ASSISTANT_ENABLED`), which needs
   root and a restart and is not audited.

OPS-12 also carries the AGENTS.md benchmark rule into data: "Before an AI feature reaches a student,
benchmark the served model against the task it is doing and record the result." Today there is
nowhere to record that result, so nothing can check it. `ai_evaluations` is that record, and the
console refuses to switch a feature on without a passing one.

An evaluation record carries consequences — it is what lets a model reach students — so it gets a
design document.

## What this goal may and may not do (the AI hold)

- It **reads** `ai_generations` and `ai_feature_policies` and **configures** `ai_feature_policies`
  and two feature flags. It never calls a model, never adds a provider adapter, never writes
  model-dependent code.
- Evaluations are **recorded, not run**. A person benchmarks a model elsewhere and records the
  result here. The console runs nothing.
- **Cost is NA.** `ai_generations` has tokens, not money, and ONE has no price table. Cost is shown
  as NA with the reason; it is never estimated from an assumed price.

## Decision summary

| # | Decision | Where |
|---|---|---|
| 1 | New table `ai_evaluations`, append-only, one row per recorded benchmark decision | 0089 |
| 2 | `ai_feature_policies` gains `prompt_key` and `prompt_version`: the prompt the feature currently runs, so "passing for the current model and prompt version" is checkable | 0089 |
| 3 | The global AI kill switch is a feature flag, `ai.global-kill-switch`, marked `high_risk_direction = 'DISABLE'` (releasing it needs approval), default not engaged | 0089 |
| 4 | The in-app assistant gets its own flag, `ai.assistant`, marked `high_risk_direction = 'ENABLE'`, default **off**. The assistant answers only when `ASSISTANT_ENABLED=true` **and** a key is set **and** this flag is on **and** the kill switch is not engaged | 0089, assistant controller |
| 5 | Switching off — one feature, the assistant, or everything — needs no approval and takes effect on the next call; switching on and widening a limit need OPS-02 dual control | API |
| 6 | Two new extended approval keys, `AI_FEATURE_ENABLE` and `AI_FEATURE_LIMITS_RAISE` (target `ai_feature_policy`); the kill-switch release and the assistant switch-on reuse `FEATURE_FLAG_HIGH_RISK_CHANGE` | 0089, authorization |
| 7 | A 0089 trigger on `ai_feature_policies` repeats the two enabling rules (kill switch not engaged; passing evaluation) for any writer that updates a row | 0089 |
| 8 | `loadAiFeaturePolicy` (what the orchestrator reads on every call) reports a feature as disabled while the kill switch is engaged | persistence |

## `ai_evaluations`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `feature_key` | text NOT NULL → `ai_feature_policies` | an evaluation is for one feature's task |
| `provider_key` | text NOT NULL | where the evaluated model was served, `^[a-z0-9][a-z0-9._-]{1,63}$`; provenance only (see "What is matched") |
| `model` | text NOT NULL | 1–200 characters, the same shape as `ai_feature_policies.model` |
| `prompt_key`, `prompt_version` | text, integer NOT NULL | the prompt version evaluated; version ≥ 1 |
| `evaluation_set_key`, `evaluation_set_version` | text, integer NOT NULL | which benchmark, and which version of it |
| `metrics` | jsonb NOT NULL | a JSON array of 1–20 `{name, value, threshold, comparator}`; comparator `AT_LEAST` or `AT_MOST` |
| `decision` | text NOT NULL | `PASS` or `FAIL` |
| `reason_code` | text NOT NULL | why it was recorded (`INITIAL_BENCHMARK`, `MODEL_CHANGE`, `PROMPT_CHANGE`, `PERIODIC_REVIEW`, `INCIDENT_REVIEW`) |
| `note` | text NULL | ≤ 500 characters; the UI asks for no personal data |
| `decided_by_user_id` | uuid NOT NULL → users | |
| `decided_at` | timestamptz NOT NULL | stamped from the database clock by the trigger |
| `correlation_id` | text NOT NULL | |

Rules (CHECKs and a trigger, so a second writer cannot skip them):

- **Append-only.** No UPDATE, no DELETE. A result is overturned by recording a later `FAIL`, not by
  editing the `PASS`: the history of what was believed, and when, is the point.
- **A `PASS` must meet every threshold it records.** The trigger walks the metrics and refuses a
  `PASS` where any metric misses its own threshold. A `FAIL` may be recorded at any time — a person
  may fail a model that met its numbers (a safety concern the metrics do not capture).
- **Metrics are numbers, not transcripts.** Names are `^[a-z][a-z0-9_]{1,63}$`, values and
  thresholds are finite numbers. No model output, prompt text or student data is stored — the same
  boundary 0033 draws for `ai_generations`.

### What "passing for the current model and prompt version" means

`ai_evaluation_passes(feature, model, prompt_key, prompt_version)` is true when the **latest**
evaluation for exactly that combination is `PASS` (ties on `decided_at` resolve to `FAIL`). It is one
SQL function used by the API and by the 0089 trigger, so the two cannot drift.

**What is matched:** feature, model, prompt key and prompt version. **Not the provider.**
`ai_feature_policies` has no provider column — the provider is a constructor argument of the
orchestrator — so there is nothing on the policy to match it against. The provider is stored for
provenance and shown next to each record. When the one adapter lands (ADR-030), adding a provider
to the policy and to this match is a small, later migration; it is listed under Open points.

## `ai_feature_policies`: `prompt_key`, `prompt_version`

Without these the rule "a passing evaluation for the current prompt version" has nothing to check:
the policy knew its model but not its prompt. Both are nullable (a feature registered before 0089 has
none), must be set together, and are set by registration code (`upsertAiFeaturePolicy`), not by the
console — changing which prompt a feature runs is a code release, because prompts live in code.

A feature with no declared prompt **cannot be switched on** (`AI_PROMPT_UNDECLARED`).

## The global kill switch

A feature flag, `ai.global-kill-switch`, rather than a new table: 0029 and OPS-02 already give flags
an audited event log (`feature_flag_events`), a reason code on every change and a high-risk
direction. The flag being **on means AI is stopped.** It is marked `high_risk_direction = 'DISABLE'`:
engaging it is an ordinary change (fast, in an incident), releasing it needs a second person — the
§5.4 row "AI global kill switch off".

**Engaging it** (`POST /operations/ai/kill-switch/engage`) is one action, in one transaction:
the flag goes on; every enabled `ai_feature_policies` row is switched off; the `ai.assistant` flag is
switched off; each change writes its audit row (and flag events), and one outbox event records the
whole action. While it is engaged:

- `loadAiFeaturePolicy` reports every feature as disabled, so the orchestrator refuses the next call
  in every process with no restart (belt and braces over the rows already switched off, and the
  guard against a flag engaged from the Feature Flags page, which flips only the flag);
- the 0089 trigger refuses to switch any policy on;
- the assistant answers 503.

**Default: not engaged.** Every feature is already off by default (0033 column default) and the
assistant flag is off by default, so an engaged default would add a second approval to every future
switch-on without making anything safer today. Rejected: engaged by default.

**Releasing it** does not switch anything back on. Each feature, and the assistant, must then be
switched on individually, each with its own approval (and, for a feature, its passing evaluation).

Flag overrides (0029) are **ignored** for both AI flags: the kill switch is global by definition, and
a per-college override that could exempt one tenant from it would defeat it. Overrides have no API,
so none can be created from the console; the screen says overrides do not apply.

## The in-app assistant

Today (`apps/api/src/assistant`) the assistant calls the provider directly from a request handler,
which CLAUDE.md forbids; Divakar switched it off on 2026-09-28 (OPS-SR-02) and it is off unless
`ASSISTANT_ENABLED=true`. This goal does not change that code path's model call, and it adds none.

**Decision: the console can switch the assistant off without a restart; switching it on still needs
the environment variable and an approval.** The assistant now answers only when all four hold:

1. `ASSISTANT_ENABLED=true` in the server environment (unchanged — root and a restart);
2. a provider key is configured (unchanged);
3. the `ai.assistant` flag is on — **default off**, so a server with the variable set still refuses
   until a second person approves (`FEATURE_FLAG_HIGH_RISK_CHANGE`, high-risk direction ENABLE);
4. the global kill switch is not engaged.

Why this, and not the alternatives:

- **Rejected — show the variable read-only and change nothing.** The runbook's gap 3 is exactly that
  switching the assistant off needs root, a restart and leaves no audit. An operator in an incident
  should be able to stop it in one audited action.
- **Rejected — let the console turn the assistant on by itself.** An API key alone must never turn it
  on (OPS-SR-02), and neither should one person at a console: switching on keeps the environment
  variable as a hard server-side precondition and adds dual control on top.
- **Rejected — register the assistant as an `ai_feature_policies` row.** It does not go through the
  orchestrator: a policy row would imply a cap and metering the assistant does not have. Its return
  path is through ONE AI Orchestration (OPS-SR-02); when that happens it becomes a policy like any
  other and the evaluation gate applies to it.
- **The flag is read on each request, fail-closed.** If the flag cannot be read, the assistant
  answers 503. The read is one indexed primary-key lookup; it adds no model call.

Default off also means: **merging this changes nothing for users.** The assistant is off today
(`ASSISTANT_ENABLED` unset or false) and stays off.

The evaluation gate does not apply to the assistant flag: the assistant has no prompt-registry
version to evaluate against (its prompt is assembled in the service). This is recorded as an open
point, and is one more reason it should come back only through orchestration.

## Who may do what

| Action | Capability | Approval |
|---|---|---|
| Read the console (usage, outcomes, tokens, evaluations, prompts) | `AI_OPS_VIEW` | — |
| Switch one feature off; engage the kill switch; switch the assistant off | `AI_OPS_CONFIGURE` **or** `OPS_FLAGS_MANAGE` | none — immediate |
| Lower a cap, shorten the window's reach, lower the input limit | `AI_OPS_CONFIGURE` | none |
| Switch a feature on | `AI_OPS_CONFIGURE` | `AI_FEATURE_ENABLE`, plus a passing evaluation, plus kill switch released |
| Raise a cap, change the window, raise the input limit | `AI_OPS_CONFIGURE` | `AI_FEATURE_LIMITS_RAISE` |
| Release the kill switch; switch the assistant on | `OPS_FLAGS_MANAGE` | `FEATURE_FLAG_HIGH_RISK_CHANGE` (existing) |
| Record an evaluation | `AI_OPS_CONFIGURE` | none (it gates an approved action; it is not itself one) |

Why "off" is wider than "on": an AI brake must be reachable by the operator on duty. By baseline
nobody but the super admin (as break-glass, OPS-01 D2) holds `AI_OPS_CONFIGURE`, while
OPERATIONS_ADMIN and SECURITY_ADMIN hold `OPS_FLAGS_MANAGE` — the capability that already switches
flags off in an incident (runbook lever 3). Stopping AI loses nothing: generated text only ever
lands as DRAFT and metering rows stay.

A window change (`DAY` ↔ `MONTH`) is treated as widening either way: the two ceilings are not
comparable, so it is put to a second person rather than argued about.

The super admin's use of `AI_OPS_CONFIGURE` is break-glass (OPS-01 D2), and every such write is
audited with `break_glass: true`.

The solo-operator safeguard (OPS-02: 15-minute cooling-off, marked SOLO) applies to every approval
here, so a one-person pilot can still switch a feature on — after 15 minutes, visibly.

## Approval payloads

Bound to the exact configuration, so an approval for one model or prompt cannot be spent on another:

- `AI_FEATURE_ENABLE`: `{ featureKey, model, promptKey, promptVersion, evaluationId, reasonCode }`
  — `evaluationId` is the passing record the request relied on; execution re-checks that the latest
  record for the combination is still a `PASS` (a `FAIL` recorded after the approval blocks it).
- `AI_FEATURE_LIMITS_RAISE`: `{ featureKey, cap, capWindow, maxInputChars, reasonCode }`.

`operation_approval_extended_target_type()` is redefined in full by 0089. It lists every earlier key
(0051, 0057, 0061, 0065, 0081) **and `INSTITUTION_DATA_PURGE`**, which a parallel branch
(`feat/inst-contract-lifecycle`, migration 0088) adds: 0089 sorts after 0088, so omitting it would
silently remove that key on a database that has both. Listing a key whose code is not on this branch
is harmless — the function only validates `extended_target_type`.

## The 0089 trigger on `ai_feature_policies`

For any writer, not only the console:

- switching a row on (UPDATE `enabled` false → true) is refused unless the kill switch is released and
  `ai_evaluation_passes(...)` holds for the row's model and prompt;
- an enabled row whose model or prompt changes without a passing evaluation for the new combination
  is **switched off** in the same statement (fail closed rather than refuse, so a registration
  deploy that changes the model does not fail — the feature simply stops until evaluated);
- an INSERT with `enabled = true` is refused while the kill switch is engaged.

**Not enforced at the database: an INSERT with `enabled = true` while the kill switch is released.**
An evaluation references its feature, so no evaluation can exist before the row; refusing such an
insert would forbid the pattern the existing orchestration integration test uses to set up an
enabled fixture. Registration code (`upsertAiFeaturePolicy`) never sets `enabled`; the console never
inserts. Recorded as a known gap.

## Reading: what the console shows, and where each figure comes from

Every figure comes from `ai_generations` or `ai_feature_policies` (plus `ai_evaluations` and the two
flags), or shows NA:

| Figure | Source |
|---|---|
| Enabled, model, cap, window, input limit, prompt | `ai_feature_policies` |
| Used against cap (current window) | `ai_generations`, `outcome = 'SUCCEEDED'`, from `date_trunc(window, now())` — the orchestrator's own cap query |
| Outcomes (succeeded / refused / failed) and failure classes | `ai_generations.outcome`, `failure_class` |
| Tokens in and out | `ai_generations.input_tokens`, `output_tokens` |
| Usage by day (last 31 days) or month (last 12) | `ai_generations`, grouped by `date_trunc` on the database clock |
| Usage by organisation | `ai_generations.subject_user_id` → the subject's ACTIVE institution relationship or ACTIVE membership; small groups suppressed (below) |
| Prompts in use | distinct `(prompt_key, prompt_version)` in `ai_generations` and on policies |
| Prompts registered | the code registry (`packages/ai-orchestration/src/registry.ts`) — empty under the hold, and shown as such |
| Cost | **NA** — no price table exists |

**Suppression (§5.5).** A per-organisation row counts people's AI use. Where fewer than 5 distinct
subjects stand behind a row, its figures are withheld and it shows `<5`, using the shared
`suppressSmallCount` helper. Generations with no subject (content about content, not about a person)
form their own row. A person in two organisations is counted in each; the screen says so.

No generated text, prompt text, subject identity or conversation is ever returned — none is stored.

## Audit and outbox

Every write writes an `audit_events` row in the same transaction, with actor, action, the feature,
reason code and correlation ID, and `break_glass: true` where it applies:

- `operations.ai.feature.disabled`, `operations.ai.feature.enabled` (with the approval, the mode and
  the evaluation), `operations.ai.feature.limits_changed` (from and to; the approval when widened);
- `operations.ai.kill_switch.engaged` (with the features and flags it switched off);
- `operations.ai.assistant.disabled`;
- `operations.ai.evaluation.recorded`.

Outbox events (identifiers and enums only; registered in `packages/events`):
`ai_feature_policy.changed`, `ai_kill_switch.engaged`, `ai_evaluation.recorded`. No consumer yet.

## Rejected alternatives (summary)

- **A new `ai_kill_switch` table.** Flags already have the audited event log and high-risk marking;
  a second mechanism would be a second place to look in an incident.
- **Gating in the orchestrator code only.** The console would be the only guard; a second writer could
  switch a feature on with no evaluation. The trigger repeats the rule.
- **Requiring an evaluation for staff-only features too, via an audience column.** There is no
  audience column, and one that the console could change would be a way around the gate. Every
  feature is treated as one that may reach students — stricter, and simpler.
- **Estimating cost from published list prices.** Invented data under the AI hold; NA instead.
- **Letting an evaluation be edited or deleted.** It is evidence; overturn it with a later record.

## Open points (decisions for Divakar)

1. **Provider in the match.** Add `provider_key` to `ai_feature_policies` and to the evaluation match
   when the ADR-030 adapter lands (recommended then, not now).
2. **The assistant and the evaluation gate.** Recommended: bring the assistant back only through ONE
   AI Orchestration, where the gate applies; until then its switch-on needs the variable and an
   approval, not an evaluation.
3. **Kill switch default.** Adopted: not engaged. Engaging it by default is a one-line data change if
   preferred.
