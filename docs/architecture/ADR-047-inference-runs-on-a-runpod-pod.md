# ADR-047 — Inference runs on a RunPod GPU pod; the AI hold is lifted

Records where ONE's model inference runs now that Divakar has provided a GPU, and what
lifting the AI hold (hard gate HG-2) does and does not permit.

- **Status:** Accepted — Divakar, 2026-10-01: "HG-2 approved, B".
- **Supersedes:** ADR-030 (inference waits for AWS managed inference) for *where* inference
  runs. ADR-030's reasons stand: AWS refused a GPU quota for the new account (2026-09-29),
  so managed inference is not available yet. ADR-029 (the original pod, abandoned on cost)
  is not revived as written; this pod is a new decision with its cost stated below.

## Decision

1. Inference runs on a RunPod pod Divakar created: 1 × RTX A6000 (48 GB), 62 GB RAM,
   300 GB container disk, Secure Cloud, region US-KS-2, about **$0.57 an hour** (about
   $410 a month if never stopped).
2. The pod serves an **OpenAI-compatible endpoint** (vLLM) protected by a bearer key. ONE
   reaches it only through `packages/ai-orchestration`, with the endpoint and key in the API
   server's environment, never in the repository. Moving to AWS (Bedrock or a GPU instance)
   later is a configuration change, not a rewrite.
3. **HG-2 is approved**: provider adapters, model-dependent code, the evaluation and
   bake-off, tutoring logic and the content factory may now be built (ENG-20 to ENG-25).
4. Every CLAUDE.md AI rule still holds: generation is an outbox job, never a request-handler
   call; model output lands as `DRAFT` with provenance; every feature has its own flag,
   default off, with a cap; no model output touches readiness; the served model is
   benchmarked against each task before it reaches a student.

## What lifting the hold does not do

- **No AI reaches a student yet.** The pod is in the United States, so student text sent to
  it is processed outside India. The student privacy notice must say so, and that wording
  is part of the HG-6 legal review. Until then, AI runs on sample data and staff-only paths.
- **No automatic spend.** The pod bills while running. Divakar stops it when it is not in
  use; nothing in ONE starts or scales it.

## Known limits

- The pod has **no persistent volume**: its disk is cleared when stopped, so the model and
  serving software are reinstalled on start (a setup script does this). Adding a network
  volume removes the wait and costs extra storage.
- One GPU means one model at a time and modest concurrency; the bake-off (ENG-21) chooses
  the model against the plan's target of under ₹10 AI cost per student.

## Rejected

- **Keep waiting for AWS GPUs.** Blocks seven plan steps for an unknown time.
- **A hosted API (Bedrock or a vendor)** now. Divakar judged per-call pricing too high at
  ONE's scale; the adapter keeps that option open.
- **Calling the pod from portals or controllers.** Breaks the outbox rule and spreads keys.
