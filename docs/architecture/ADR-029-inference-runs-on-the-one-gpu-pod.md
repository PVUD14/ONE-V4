# ADR-029 — Inference Runs on the ONE GPU Pod

**Status:** Accepted
**Decision date:** 2026-09-12
**Scope:** Where model inference runs, and what precisely the AI hold is waiting for
**Supersedes:** ADR-010 — Managed inference first (`docs/phase-0/adrs/ADR-001-to-015.md`)
**Amends:** `spec/04` §42, `spec/06` "AI"; answers the deferred item at `spec/08`
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

`CLAUDE.md` forbids integrating an LLM or writing model-dependent code, because **the AI build is on
hold until the GPU instance exists**. It is listed among the rules that cannot be waived in a chat
session.

Four accepted documents point the other way:

- `spec/04` §42: *"Do not launch with an always-on GPU EC2 instance merely because model weights are
  free. V1 should start with managed/pay-per-use inference for variable interactive demand unless
  benchmark data proves self-hosting cheaper at required quality and latency."*
- `spec/06`: *"Start with managed model inference (Amazon Bedrock and/or external providers selected
  by benchmark) through AI Gateway. Self-hosted GPU inference is optional later and must be
  benchmark-driven."*
- **ADR-010 — Managed inference first**: *"begin with managed/pay-per-use inference; self-hosting
  requires measured quality/latency/privacy/cost advantage. Consequence: no always-on GPU EC2
  dependency in V1 architecture."*
- `spec/08` lists as still-deferred: *"threshold at which self-hosted GPU inference becomes
  financially beneficial."*

So the contributor rule holds the work until a GPU exists, while the accepted architecture says a
GPU should not be a V1 dependency at all. As written, the hold can only be lifted by doing the thing
the architecture rejects. Nobody reading the repository can tell which governs, and the gate — *"the
GPU instance exists"* — is not checkable in any case. A rented machine sitting idle would satisfy it
literally while changing nothing about whether the product can serve a student.

Separately, the hosting decision for ONE has already been taken: the platform runs on the RunPod
RTX 6000 Ada pod rather than the VPS. **Production has not yet moved** — it is still the single VPS
at `one.ai8ht.pro` — but the destination is settled, and it is a GPU host.

## Decision

**ONE self-hosts inference on its own GPU pod. ADR-010 is superseded.**

**The AI hold is restated as a checkable gate: held until the pod serves inference behind ONE AI
Orchestration** — that is, until there is an inference endpoint the platform reaches through the
orchestration layer, with a model and version recorded. Not until a machine is rented.

Amending the rule text in `CLAUDE.md` is a pull request Divakar raises against that file. This ADR
records the decision; it does not itself change the rule, and until that PR merges the rule as
written still governs.

## Why this is not the thing ADR-010 rejected

ADR-010 and `spec/04` §42 reject **an always-on GPU added to the architecture because weights are
free**, with no measured case. That objection is sound and this decision does not overturn it on its
own terms. Two things make the situation different:

- **The GPU is the host, not an addition.** ONE's compute decision already places the platform on the
  pod. The incremental cost of serving models on hardware the platform is paying for regardless is
  not the cost ADR-010 was protecting against. This also answers the deferred question at `spec/08`:
  the financial threshold for self-hosting is moot when the GPU is not a marginal purchase.
- **Privacy weighs toward self-hosting here.** Managed inference puts student career evidence in a
  third-party processor, in another country. The consent gate currently discloses exactly that. ADR-010
  named privacy as one of the four measurable advantages that justify self-hosting; for a platform
  holding Indian students' academic and career records, it is the strongest of the four.

**What is not yet established is quality and latency**, and ADR-010 required those to be *measured*.
This decision therefore carries an obligation rather than waiving one: **no AI feature reaches a
student before a benchmark of the served model against the task it is doing, recorded and reviewed.**
Self-hosting is chosen; it is not thereby assumed adequate.

## Consequences

- The hold is now checkable, and it is unambiguous which document governs. Anyone reading
  `spec/04` §42, `spec/06` or ADR-010 is directed here.
- The pod becomes a production dependency with its own uptime, patching, capacity and cost story,
  owned by Stream A — on top of being the application host.
- The benchmark obligation above is a gate on the first AI feature, not on the migration.
- **The consent gate's disclosure must be corrected before AI ships.** It currently names a US
  processor the deployment does not use and, under this decision, will not use for inference. A
  version bump is cheap while the gate is dormant and expensive after a pilot institution has signed.
- Everything AI stays in the final phase of the build plan regardless. This ADR settles *where*
  inference runs; it does not accelerate *when* it is built.
- If the pod migration does not happen, this ADR is void and ADR-010 revives. Self-hosting is
  justified here **because** the GPU is the host; on a VPS the original reasoning stands unchanged.

## Implementation notes

The following rules are unaffected by this decision and survive any change of provider or venue:

- No portal and no request handler calls an inference endpoint. All AI requests go through ONE AI
  Orchestration, and generation is a job on the existing outbox pipeline.
- Anything a model produces is stored as a row carrying `source`, `generator_version`,
  `prompt_version`, `review_state`, `generated_at`, landing as `DRAFT` for a human to publish.
- Every AI feature ships behind its own flag, default off, with its own cap. The flag machinery does
  not exist yet and is scheduled ahead of any AI work.
- Readiness remains a published, versioned, explainable band. An LLM is never the scoring engine, and
  no model output produces or influences a numeric readiness value.
