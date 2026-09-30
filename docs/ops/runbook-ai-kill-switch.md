# Runbook — AI kill switch (pilot)

> What this is: the step-by-step procedure for switching off every AI path in ONE during an
> incident, and for proving it is off. Why it exists: ENG-17 (engine appendix) asks for pilot
> runbooks "including the AI kill switch", using the feature-flag and approval flow of OPS-02 and
> OPS-12. Every lever below was read from the code on base `4fab0c6` and rehearsed on a local,
> freshly seeded database (see [Verified locally](#verified-locally)); nothing here was run against
> staging (none exists) or production. Written 2026-09-30.

## First: what AI actually runs today

The AI hold (ADR-030) is in force. On base `4fab0c6` the complete list of places that could reach
a model, or that model-derived output could come from, is:

| # | Path | Calls a model? | State on a fresh database | Off switch |
|---|---|---|---|---|
| A | In-app assistant, `POST /api/v1/assistant/chat` (`apps/api/src/assistant/assistant.service.ts`) | **Yes** — calls the Anthropic Messages API directly from the request handler | Off: `ASSISTANT_ENABLED` is unset (`.env.example` sets it `false`) | [Lever 1](#lever-1--the-in-app-assistant-one-assistant) |
| B | ONE AI Orchestration (`packages/ai-orchestration`, `AiOrchestrator.generate`) | Only through an adapter; none is wired | No caller anywhere in `apps/`; `ai_feature_policies` has **0 rows**; the only provider is `UnconfiguredInferenceProvider` | [Lever 2](#lever-2--an-orchestrated-ai-feature-ai_feature_policies) |
| C | A feature flag guarding an AI feature (`feature_flags`, `high_risk_direction = 'ENABLE'`) | — | **No AI flag exists.** The two flags are `employer-access.allow-free-mail` and `career-catalogue.selectable-roles`, neither high-risk | [Lever 3](#lever-3--an-ai-feature-flag-operations--feature-flags) |
| D | The engine's AI tutoring purpose (`ai-tutoring` consent, ENG-01) | No tutor exists (ENG-22 not built) | No consent definitions are published (HG-6) | Nothing to switch |
| E | Seeded content generation (`worker:content-generation`, consumer `learner-content-seeded-generation-v1`) | **No** — copies fixed seed content into a DRAFT; no model | Not an AI path | Not needed |
| F | Offline calibration (`planthepath-calibration.timer`, ENG-13) and BKT in shadow (ENG-06) | **No** — statistical fitting and a formula; no LLM | Timer written, not installed | [Lever 4](#lever-4--offline-model-jobs-not-an-llm) (only if the incident is about attempt data) |

So in the pilot as built, **the only live AI path is the assistant (A)**, and it is already off
unless someone set `ASSISTANT_ENABLED=true` on the server. Levers 2 and 3 are the procedure for
AI features once the hold lifts (ENG-20 onwards); they are rehearsed now so the procedure is known
to work before it is needed.

**Not built — the one-action global kill switch.** Appendix 1 journey J10 ("one approved
kill-switch action; AI Operations shows all features disabled") belongs to OPS-12, which has not
started. **Operations → AI Operations** is a read-only page with no AI controls. Until OPS-12
ships, "turn off all AI" is the sequence below, not one button. See [Gaps](#gaps).

## Who

| Lever | Who can act | Where |
|---|---|---|
| 1 Assistant | Divakar only (root on the server; production is his alone) | `/srv/planthepath-next/shared/app.env`, `planthepath-api.service` |
| 2 AI feature policy | Divakar only (a database session; no operator route exists) | the production database |
| 3 AI feature flag | Anyone holding `OPS_FLAGS_MANAGE` (baseline OPERATIONS_ADMIN, SECURITY_ADMIN, super admin); **switching back on** also needs `APPROVE_HIGH_RISK` from a second person | **Operations → Feature Flags**; **Settings → Approvals** |
| 4 Calibration timer | Divakar only (root) | `systemctl` on the server |

Declare the incident first, or in parallel: [runbook-pilot-incident.md](runbook-pilot-incident.md)
(**Security → Incident register**, `INCIDENT_MANAGE`). Every lever below is recorded on the incident
timeline as a note with reason `DECISION_RECORDED`, because levers 1, 2 and 4 leave no audit row of
their own.

## When to pull it

- A model produced something harmful, wrong or leaking in front of a user.
- A provider key or endpoint is suspected compromised, or spend is running away.
- A model call is found in a request handler (CLAUDE.md forbids it — this is why the assistant was
  switched off on 2026-09-28, security finding OPS-SR-02).
- Divakar says so.

Pull every lever that applies; do not wait to diagnose first. Switching AI off never loses data:
generated text only ever lands as `DRAFT` rows, and metering rows stay.

## Lever 1 — the in-app assistant (ONE Assistant)

The service reads `ASSISTANT_ENABLED` once, when the API process starts
(`AssistantService` constructor), and answers only when it is exactly `true` **and**
`ANTHROPIC_API_KEY` is set. Anything else returns **503 `ASSISTANT_UNCONFIGURED`** before any
model call.

1. On the server, as root, open `/srv/planthepath-next/shared/app.env` and make the line read:

   ```
   ASSISTANT_ENABLED=false
   ```

   (Deleting the line has the same effect.) If the key itself is suspected compromised, also delete
   the `ANTHROPIC_API_KEY=` line and revoke the key at the provider — the service refuses without a
   key too. Never print or paste either value.
2. Restart the API so the new value is read:

   ```
   systemctl restart planthepath-api.service
   systemctl is-active planthepath-api.service      # active
   curl -fsS http://127.0.0.1:7310/health           # {"status":"ok"}
   ```

3. Prove it is off. Signed in as any user, open **ONE Assistant** (the floating button) and ask anything. The web
   widget and the Android app both show *"The assistant is switched off for now. Please use
   Help & FAQ, or contact support."* (web `assistantWidget.tsx`, Android `JobsAndMore.kt`, both
   keyed on HTTP 503). With a bearer token the raw check is:

   ```
   POST /api/v1/assistant/chat   {"persona":"student","messages":[{"role":"user","content":"test"}]}
   → 503 {"error":{"code":"ASSISTANT_UNCONFIGURED", ...}}
   ```

4. Note on the incident: `ASSISTANT_ENABLED=false, API restarted at <time>, 503 confirmed`
   (reason `DECISION_RECORDED`).

The per-user cap (40 messages a day, in memory) is not a kill switch: it resets on restart and per
user.

## Lever 2 — an orchestrated AI feature (`ai_feature_policies`)

Each AI feature that goes through ONE AI Orchestration has one `ai_feature_policies` row
(migration 0033): `enabled` (default `false`), `model`, `cap`, `cap_window` (`DAY`/`MONTH`) and
`max_input_chars`. `AiOrchestrator.generate` reads the row **on every call** (no cache), in this
order: unknown feature → refused; `enabled = false` → refused and metered `REFUSED` /
`FEATURE_DISABLED`; cap reached → `REFUSED` / `CAP_EXCEEDED`; prompt too long → `REFUSED` /
`INPUT_TOO_LARGE`. So setting `enabled = false` stops the next call, in every process, with no
restart.

Today there are no rows, so there is nothing to switch. When a feature exists:

1. See what is on (a database session — no operator screen or route exists yet):

   ```sql
   SELECT feature_key, enabled, model, cap, cap_window FROM ai_feature_policies ORDER BY feature_key;
   ```

2. Switch off one feature, or every feature (this is what `setAiFeatureEnabled` in
   `packages/persistence/src/ai-orchestration.ts` does):

   ```sql
   UPDATE ai_feature_policies SET enabled = false, updated_at = now() WHERE feature_key = '<key>';
   -- every feature at once:
   UPDATE ai_feature_policies SET enabled = false, updated_at = now() WHERE enabled;
   ```

3. Prove it: the first query shows `enabled = f` for every row, and new calls appear as refusals:

   ```sql
   SELECT feature_key, outcome, failure_class, count(*)
   FROM ai_generations WHERE occurred_at > now() - interval '15 minutes'
   GROUP BY 1,2,3 ORDER BY 1;          -- expect REFUSED / FEATURE_DISABLED, no SUCCEEDED
   ```

4. Note on the incident which keys were switched off and when (`DECISION_RECORDED`): this write
   has no audit row of its own.

Never lower a cap to 0 as a kill switch — `ai_feature_cap_ck` requires `cap > 0` and the update
fails. Never delete a policy row: `ai_generations.feature_key` references it.

Switching a feature back on is a release decision, not an incident step: it needs the AI hold
lifted by Divakar, and (once OPS-12 exists) a passing evaluation record and an approval.

## Lever 3 — an AI feature flag (Operations → Feature Flags)

Every AI feature must also ship behind its own `feature_flags` row, default off (CLAUDE.md, 0029).
OPS-02 marks AI flags `high_risk_direction = 'ENABLE'`, which makes **switching off an ordinary
change** (no approval, so it is fast in an incident) and **switching back on a dual-controlled
change**. No AI flag exists yet; when one does:

1. **Operations → Feature Flags**. Find the flag; its row shows the **High-risk to enable** badge.
2. Type `INCIDENT_MITIGATION` in *Reason code recorded with every change* and press **Disable**.
   API equivalent (capability `OPS_FLAGS_MANAGE`):

   ```
   POST /api/v1/operations/feature-flags/<key>/state   {"enabled": false, "reasonCode": "INCIDENT_MITIGATION"}
   → 201, and the returned flag list shows "enabled": false
   ```

   The change and reason are written to `feature_flag_events` (`DISABLED` / `INCIDENT_MITIGATION`)
   in the same transaction.
3. A per-college or per-user override can keep a flag on for one tenant even when it is off
   globally (resolution order: user override, organisation override, global). Overrides have no API
   yet and show read-only in the *Overrides* column; if the column is not 0, tell Divakar — revoking
   an override is a database step today.
4. **Switching back on after the incident** (only when the hold allows): the button shows
   **Enable…** and files an approval instead. Reason `ROLLBACK` (or `EVALUATION_COMPLETE`,
   `PILOT_ROLLOUT`, `INCIDENT_MITIGATION`). A second person holding `APPROVE_HIGH_RISK` approves it
   in **Settings → Approvals** (`VERIFIED_NEED`, `POLICY_REQUIREMENT`, `INCIDENT_RESPONSE`,
   `CUSTOMER_REQUEST`); the requester then executes it within 24 hours. Without an approval the API
   answers **403 `APPROVAL_REQUIRED`**; the requester deciding their own request is refused. Full
   procedure: [sop-approvals.md](sop-approvals.md).

## Lever 4 — offline model jobs (not an LLM)

The calibration job fits item statistics from de-identified, consented attempts; it calls no model
provider. Stop it only if the incident concerns attempt data or its export:

```
systemctl disable --now planthepath-calibration.timer
systemctl list-timers | grep planthepath-calibration     # nothing listed
```

Online code keeps using the last imported calibrations; a skipped week changes nothing for
students. The timer is not installed anywhere yet (ENG-13), so today this is a no-op.

The BKT model runs only in shadow and in the offline report (`engine:bkt-shadow-report`); it never
decides a band a student sees, so it has no switch to pull.

## After the switch

1. Record on the incident timeline which levers were pulled and the proof for each.
2. If users saw the assistant fail or disappear, a status notice to college admins is optional;
   see [runbook-pilot-incident.md](runbook-pilot-incident.md) §5.
3. Nothing is restored until the cause is fixed and Divakar decides. The assistant comes back only
   once it runs through ONE AI Orchestration (OPS-SR-02), never by flipping `ASSISTANT_ENABLED`
   back.

## Never do

- Never set `ASSISTANT_ENABLED=true` to "test" whether the switch works — the check is the 503.
- Never delete `ai_generations` or `ai_feature_policies` rows, and never set a cap to 0.
- Never re-enable an AI flag without the approval; there is no break-glass path.
- Never paste a key, token or connection string into an incident note or support case.

## Gaps

These are missing operator capabilities found while writing this runbook. None was built here.

1. **No one-action global AI kill switch (J10, OPS-12).** Needed: a high-risk flag that disables
   every AI feature in one approved action, with AI Operations showing all features disabled.
2. **No route or screen for `ai_feature_policies`.** Lever 2 needs a database session, which only
   Divakar has; the write leaves no audit row. OPS-12's configuration screen closes this.
3. **The assistant switch is an environment variable.** It needs root and an API restart, and it
   is not audited. Moving the assistant onto ONE AI Orchestration (a policy row plus an AI flag)
   would put it under levers 2 and 3.
4. **Flag overrides have no API** (already listed in sop-feature-flags.md): a per-college
   override cannot be revoked from the console.

## Verified locally

Staging does not exist and production is out of bounds, so every step was executed on a local,
fresh PostgreSQL database `one_eng17` (Docker `planthepath-postgres-dev`), migrated with
`corepack pnpm db:migrate` (twice; the second run applied 0) and seeded with the repository's own
seed scripts (`db:seed:local-users`, `db:seed:career-readiness`, `db:seed:careers`,
`db:seed:career-catalogue`, `db:import:teaching-strategies-draft`, `db:import:aptitude-bank-draft`,
`db:import:career-target-draft`). The HTTP steps ran through the real Nest controllers with a local
test identity verifier (the integration-spec pattern), because local Cognito does not exist.
The flag and the policy below are **local synthetic rows** created for the rehearsal; nothing like
them exists in any real environment.

RESULTS_AI_KILL_SWITCH

**Needs a real environment:** lever 1's `app.env` edit and `systemctl restart` (a server), lever
2's `UPDATE` on the production database (Divakar), lever 4's `systemctl` (timer not installed).
