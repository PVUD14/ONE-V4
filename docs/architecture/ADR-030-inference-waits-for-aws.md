# ADR-030 — Inference Waits for AWS; the GPU Pod Is Abandoned on Cost

**Status:** Accepted
**Decision date:** 2026-09-12
**Scope:** Where inference runs, and when the AI build resumes
**Supersedes:** ADR-029 — Inference Runs on the ONE GPU Pod
**Reinstates:** ADR-010 — Managed inference first
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

ADR-029 is a day old. It moved inference onto ONE's own RunPod GPU pod, superseded
ADR-010's "managed inference first," and lifted the hold on model-dependent code. Its
central argument was that the pod was already the platform's compute decision, so a GPU
serving models was not an incremental always-on cost.

That premise has gone. The pod is running out of funds and is being given up, and ONE
targets AWS instead.

It is worth being plain about what happened, because the specification called it. `spec/04`
§42 said *"Do not launch with an always-on GPU EC2 instance merely because model weights
are free,"* `spec/06` said start with managed inference, and ADR-010 required a measured
cost advantage before self-hosting. ADR-029 reasoned around that by treating the GPU as
the host rather than an addition — which was true while the pod was the host, and stopped
being true the moment the pod was not affordable. An always-on GPU is a standing monthly
bill measured against usage that does not exist yet, and that is the whole of the
objection the specs were making.

## Decision

**Inference will run on AWS, through managed inference, once Divakar provides AWS access.
ADR-029 is superseded and ADR-010 is reinstated.**

**The AI build is held again**, on a gate that is checkable: *held until AWS access exists
and an inference provider is reachable through ONE AI Orchestration.* Until then, do not
integrate a provider, write model-dependent code, or stand up a serving stack.

The hold does **not** cover the AI Orchestration layer itself, which is provider-agnostic
and already built.

## What this costs

Close to nothing, which was the point of building it the way it was built.

`packages/ai-orchestration` defines an `InferenceProvider` interface and takes the venue
as a constructor argument. Nothing above that interface knows or cares where a model
runs: the prompt registry, the per-feature flags and caps, the metering, the DRAFT-only
output contract and the refusal ordering are all unchanged by this decision. The default
provider is `UnconfiguredInferenceProvider`, which refuses every call with a typed error
rather than falling back — so the system's behaviour today is already correct for "no
inference available," and was before this ADR was written.

What is left to do when AWS access arrives is **one adapter**: a `BedrockProvider`
alongside the existing `OpenAICompatibleProvider` and `AnthropicProvider`, plus a
configuration entry. The two existing adapters are kept: OpenAI-compatible remains useful
for a local model during development, and Anthropic is the path the in-app assistant
already uses.

This is the second time in three days the venue for inference has changed. That is the
argument for the abstraction, not against it.

## Consequences

- `CLAUDE.md`'s AI section is amended to restate the hold and its new gate.
- AI remains where the build plan always had it — the final phase, after the pilot. No
  pilot capability depends on it, so this delays nothing that a customer is waiting for.
- The consent notice's disclosure of a US AI processor needs settling before any AI ships,
  and managed inference on AWS makes that a live question again rather than one
  self-hosting would have removed. Decide it with the provider choice, not after.
- ADR-010's requirement stands: a measured quality, latency, privacy and cost case before
  self-hosting is revisited. If the pod idea returns, it returns with numbers.
- Production remains the VPS at `one.ai8ht.pro`. Moving it to AWS is a separate decision
  and a manual release.

## Implementation notes

Unchanged by any of this, and unchanged by whatever provider is eventually chosen:

- No portal and no request handler calls an inference endpoint; everything goes through
  AI Orchestration, and generation is a job on the outbox pipeline.
- Model output lands as `DRAFT` carrying `source`, `generator_version`, `prompt_version`,
  `review_state` and `generated_at`, for a human to publish.
- Every AI feature ships behind its own flag, default off, with its own cap.
- An LLM is never the readiness scoring engine.
- Benchmark the served model against its task before anything reaches a student.
