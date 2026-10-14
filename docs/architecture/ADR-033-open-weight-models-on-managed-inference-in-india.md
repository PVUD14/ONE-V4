# ADR-033 — Open-Weight Models on Managed Inference in India

**Status:** Proposed — records a direction only. **It does not lift the AI hold (ADR-030).**
**Decision date:** 2026-09-25
**Scope:** Which kind of model ONE's AI features run on, where, through what path, and what happens to
the proprietary model the in-app assistant calls today
**Builds on:** ADR-010 (managed inference first), ADR-030 (inference waits for AWS), ADR-012 (readiness
is deterministic; an LLM is never its numerical authority), ADR-020 (readiness is a band)
**Amends:** ADR-030 — one sentence of its reasoning, see "What this corrects" (ADR-030 itself is not edited)
**Program goal:** ENG-02 (written as "ADR-031" in the program plan; that number and 032 were already
taken, so this is ADR-033)
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

ADR-030 settled *where* inference will run — AWS, managed, once access exists — and held the AI build
until then. It left open *what* runs there. The adaptive learning engine (Part D of the program) makes
that question concrete: a tutor that answers in the student's chosen language (ENG-22, ENG-25), a
content factory drafting items and hints for review (ENG-23), retrieval over approved content
(ENG-24), and an evaluation set to choose between candidates (ENG-21). Each of those is gated behind
hard gate HG-2 and nothing in this ADR changes that.

Three facts about the code shape the answer (ENG-00 baseline, verified on `feat/plan-phases-0-to-2`):

1. `packages/ai-orchestration` is built and provider-agnostic. It checks the feature flag, then the
   cap, then the input size, meters every call into `ai_generations`, returns `DRAFT`, and never falls
   back. Its default provider, `UnconfiguredInferenceProvider`, refuses every call.
2. **Two adapters already exist and are exported**, not one: `OpenAICompatibleProvider` and
   `AnthropicProvider` (`packages/ai-orchestration/src/provider.ts:105`, `:174`). Neither is
   constructed anywhere in `apps/`. The program plan's "one remaining adapter" (ENG-20) is therefore
   the *managed-inference* adapter, and the question of what the other two are for is open.
3. **The in-app assistant bypasses all of it.** `AssistantService.streamChat`
   (`apps/api/src/assistant/assistant.service.ts:106–121`) calls `https://api.anthropic.com/v1/messages`
   directly, synchronously, from inside the assistant request handler, with the proprietary model
   `claude-haiku-4-5-20251001` by default. It is not behind a row in `ai_feature_policies`, is not
   metered in `ai_generations`, and its 40-messages-a-day cap is an in-memory map per API process.
   It is enabled whenever `ANTHROPIC_API_KEY` is set. That is the one place in ONE where a model call
   sits in a request handler, which `CLAUDE.md` forbids for new work, and it predates the rule.

The students ONE serves are in India, the pilot is in Andhra Pradesh, and DPDP obligations apply from
14 May 2027. Indian-language answers are a product requirement, not a nice-to-have (ENG-16, C6).

## Decision

**ONE's AI features will run on open-weight models (Apache-2.0 or MIT licensed weights) served
pay-per-token through managed inference in the AWS Mumbai region, reached only through
`packages/ai-orchestration`. A self-hosted serving stack is the recorded exit route, not the plan.
Proprietary model APIs are not the direction; the one in use today is recorded below as a bounded,
time-limited exception.**

1. **Open weights, permissive licence.** A candidate model is eligible only if its weights are
   published under Apache-2.0 or MIT. Licences with use restrictions, user-count thresholds or
   "acceptable use" riders that could bind ONE's customers are not eligible without a new ADR. The
   licence of the exact model version is recorded with its bake-off result.
2. **Managed, pay-per-token, Mumbai region.** No always-on GPU (ADR-010, ADR-030). Inference runs in
   the Mumbai AWS region so a student's prompt does not leave India in the ordinary course. Whether a
   chosen model is actually offered pay-per-token in that region is verified when AWS access exists
   (ENG-20, HG-1); if it is not, that is brought back to Divakar as a decision — the residency
   preference is not quietly relaxed to make a model available.
3. **Through orchestration only.** Every model call goes through `AiOrchestrator` with a per-feature
   flag (default off), a cap, metering, a recorded `prompt_version` and `generator_version`, and a
   `DRAFT` output contract. Generation is a job on the outbox pipeline (ADR-028); no request handler
   calls a provider — including interactive features such as the tutor, which enqueue a job and
   deliver its result, rather than holding a model call open inside the request.
4. **Model roles are chosen by measurement, not here.** The roles are: **router** (classifies a
   request and picks a path), **guard** (answer-leak and abuse checks, ENG-22), **tutor**,
   **Indian-language default**, **offline batch** (content-factory drafts, ENG-23) and **embeddings**
   (ENG-24). Which model fills each role — including whether one model fills several — is decided by
   the bake-off on the ENG-21 evaluation set, and no model reaches a student without a passing
   recorded result. This ADR names no model.
5. **The exit route is self-hosting the same open weights**, behind the existing
   `OpenAICompatibleProvider` shape that common open-weight servers expose. It is taken only with the
   measured quality, latency, privacy and cost case ADR-010 requires. Recording it here is not a
   proposal to self-host.
6. **The existing adapters.** `AnthropicProvider` stays in the package, unconstructed in `apps/`,
   so the assistant has somewhere orchestrated to move to (see 7). `OpenAICompatibleProvider` stays as
   the exit route and for a local model during development. Neither is wired into a student-facing
   feature by this ADR.
7. **The assistant is an explicit, bounded exception** — see the next section.

### What a model may never do (unchanged by any model choice)

- **No model output produces or influences readiness.** Readiness stays the four-value advisory band
  (ADR-020) computed by versioned deterministic code (ADR-012); `readiness_snapshots` keeps its
  `advisory` and `NOT employer_visible` CHECK constraints.
- **No model output becomes evidence.** Evidence and learning attempts are graded by an answer key,
  a sandbox test result (ENG-12) or a human. A model may *propose* a grade (the "grading" slice of the
  ENG-21 evaluation set); that proposal lands as `DRAFT` and only a human's confirmation is recorded.
  The tutor has no write access to evidence, attempts, mastery or skill state (ENG-22 acceptance).
- **A model can only ever make an attempt count less, never more.** An attempt on an item during
  which the student received any AI tutor reply about that item is recorded as **assisted** (the same
  consequence as hint level 3 or higher, D.1), so it never counts toward DEMONSTRATED. The tutor can
  therefore not inflate a student's stage, band or mastery by leaking an answer. ENG-22 implements
  this; ENG-03's attempt row carries the flag.
- Model-derived coaching results that are not readiness — such as the speaking-practice bands Divakar
  has asked for — are their own advisory results. They are bands, never numbers, never
  employer-visible, and never inputs to readiness or to evidence stages.
- Anything a model produces is stored with `source`, `generator_version`, `prompt_version`,
  `review_state`, `generated_at`, and lands as `DRAFT` for a human to publish.

## The in-app assistant: a recorded exception

The assistant is a help-desk: it answers "how do I…" questions about ONE for each persona, grounded in
a curated set of help articles selected by deterministic lexical retrieval. It does not read or write
evidence, readiness, attempts or any student record, and it is independent of the learning engine.
It is nonetheless a proprietary model, called synchronously from a request handler, outside the
orchestration layer's flag, cap and metering.

**Decision: it stands as a recorded exception, bounded as follows, until the managed-inference adapter
exists (ENG-20); then it moves behind `ai-orchestration` and the exception ends.**

- **Bound.** Help-desk questions only, grounded in the curated corpus. It must not be extended to
  tutoring, grading, content generation or anything that reads a student's record. No new feature may
  cite it as precedent for a model call in a request handler.
- **Not the AI build.** It is not "the AI hold lifted"; it is pre-existing behaviour that the hold did
  not switch off. ENG-02 changes no code.
- **Retirement path (owner ENG-20).** When the managed adapter lands, the assistant becomes an
  orchestrated feature: a row in `ai_feature_policies` (default off), metering in `ai_generations`,
  the cap moved from process memory to the orchestrator, and delivery restructured so the model call
  runs outside the request (a job whose streamed or polled result the client reads). Whether it then
  keeps `AnthropicProvider` or moves to the open-weight default is a bake-off outcome (ENG-21) like any
  other role — the exception covers the *path*, not a permanent vendor choice.
- **Divakar decides now whether it stays live meanwhile.** Turning it off costs a configuration change
  (unset `ANTHROPIC_API_KEY`; the service already reports itself unconfigured and the widget already
  handles that). Recommended: leave it as it is if it is not live in production, and do not make it
  live until it is orchestrated; if it is live, keep it only if the cross-border-processor disclosure
  ADR-030 raised is settled for it.

## What this corrects

ADR-030 says the Anthropic adapter "is the path the in-app assistant already uses". It is not: the
assistant calls the vendor API directly and does not use `AnthropicProvider` or the orchestrator.
ADR-030's decision is unaffected; this ADR records the fact and the exception above in its place.
The program plan's "one remaining adapter" (ENG-20) likewise reads as "the managed-inference adapter,
alongside two that exist".

## Rejected options

- **Proprietary model APIs as the default (Anthropic, OpenAI, Google, or the same through a cloud
  marketplace).** Strong models and no hosting. Rejected as the direction because a per-token price
  set by one vendor becomes ONE's unit cost with no exit that keeps the same model; prompts are
  processed by a foreign processor under that vendor's terms, which DPDP disclosure and the college
  contracts must then carry; the model can be retired or changed under ONE by the vendor; and Indian
  language quality is not assumed to be better. It remains possible per role if the bake-off shows a
  measured advantage worth those costs — that needs its own ADR.
- **Self-hosting open weights now (a GPU instance or pod).** Rejected by ADR-010 and ADR-030 on cost:
  an always-on GPU is a standing bill against usage that does not yet exist. Kept as the exit route
  above, gated on ADR-010's measured case.
- **Choosing the models in this ADR.** Rejected: naming a model before the evaluation set exists is
  a guess recorded as a decision. The bake-off (ENG-21) chooses; this ADR fixes only the eligibility
  rules and the path.
- **Any-region managed inference.** Cheaper and wider model choice in some regions. Rejected as the
  default because keeping ordinary processing in India is the simplest DPDP and customer-contract
  story, and because moving region later is harder than starting in-region. Revisited with Divakar,
  not silently, if a needed model is unavailable in Mumbai.
- **Retiring the assistant immediately (removing the code).** Rejected: it is a working, bounded
  help feature that touches no student record, and removing code is not needed to stop it — unsetting
  one variable does that. Whether it runs is Divakar's call; its path is fixed by ENG-20.
- **Moving the assistant behind orchestration now, on the Anthropic adapter.** Rejected in this goal:
  wiring a provider is model-dependent work under the hold (HG-2), and ENG-02 is documentation only.

## Consequences

- The engine is designed to run fully with every AI flag off (X2). Nothing in ENG-03 to ENG-19 depends
  on a model.
- ENG-20 builds a managed-inference adapter for open-weight models in the Mumbai region, and — as part
  of the same goal — moves the assistant onto the orchestrated path or reports why not.
- ENG-21's bake-off records, for each candidate, the licence, region availability, per-token cost and
  the role results; ENG-25's per-college cost target (₹10 per student, ENG-28) is measured against it.
- The consent notice's AI-processor disclosure (ADR-030's open consequence) becomes a disclosure of an
  Indian-region processor for engine features; the assistant, while it calls a vendor API directly,
  remains the exception the notice must cover if it is live.
- Anyone later wanting a proprietary model for a role writes an ADR superseding this one for that
  role, with the bake-off result attached.

## Implementation notes

- No code, migration, flag or configuration changes with this ADR.
- The eligibility rules (licence, region, orchestration-only, DRAFT, no influence on readiness or
  evidence, tutor reply ⇒ assisted) are the review checklist for ENG-20 to ENG-25.
