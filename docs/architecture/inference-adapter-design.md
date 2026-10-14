# Inference adapter design (ENG-20)

What this is: the design of the adapter that lets ONE AI Orchestration reach a real model, and of
the two small additions to the AI tables it needs (migration 0105). Why it exists: ENG-20 is "the one
remaining adapter"; ADR-047 put inference on an OpenAI-compatible endpoint (vLLM on a RunPod pod,
bearer key), and the CLAUDE.md AI rules decide most of the shape before any code is written.
Written 2026-10-01.

## What already existed

- `packages/ai-orchestration` — `AiOrchestrator.generate` decides flag → cap → size → call and meters
  every attempt (0033 `ai_generations`, never the generated text). An `OpenAICompatibleProvider` sketch
  existed with no timeout, no retry and no caller.
- OPS-12 (0089) — the global kill switch (`ai.global-kill-switch`), per-feature switches that turn on
  only with a passing evaluation for the exact model and prompt, and the AI Operations console.
  `loadAiFeaturePolicy` already reads every feature as disabled while the kill switch is engaged.
- The outbox pipeline (ADR-028) — the only place a generation may run is a worker.

## Decisions

### 1. Configuration: three server variables, all or nothing

`ONE_AI_BASE_URL` (the OpenAI base, ending in `/v1`), `ONE_AI_API_KEY`, `ONE_AI_MODEL`. Read from the
worker's or API's environment only; the names appear in code, the values never do.

- **Any of the three blank → AI unavailable.** The adapter becomes `UnconfiguredInferenceProvider`:
  every call fails `PROVIDER_UNCONFIGURED`, metered, and nothing crashes or starts refusing to boot.
  A key is required even though vLLM can run without one: the pod is on a public proxy, and a missing
  key is far more likely to be a mistake than a choice.
- **`http://` is refused except for loopback**, so a bearer key is never sent in clear text. A URL with
  embedded credentials, a query or a fragment is refused. Each refusal has a reason code
  (`BASE_URL_MISSING`, `BASE_URL_INVALID`, `BASE_URL_INSECURE`, `KEY_MISSING`, `MODEL_MISSING`) that
  AI Operations shows.
- **The served model must equal the feature's model.** `ai_feature_policies.model` is what was
  evaluated (0089 binds evaluations to it). If a feature names a model the endpoint is not configured
  to serve, the adapter refuses before any network call (`PROVIDER_MODEL_MISMATCH`). Otherwise a
  feature evaluated on model A could silently run on model B.
- Moving to AWS is configuration: Bedrock exposes the same chat-completions shape at an `/openai/v1`
  base with a bearer API key.

Rejected: a per-feature endpoint (one pod, one model — ADR-047); reading the key from the database
(keys stay in the server environment, never in a row a console can read).

### 2. The call: timeout, bounded retries, no streaming

- One `POST {base}/chat/completions`, `stream: false`. Streaming is not built: generation is a
  background job whose output lands as a DRAFT for a human, so nobody is waiting on tokens.
- **Per-attempt timeout** (default 60 s, covering the body read). A timed-out attempt is **not
  retried**: the model may still be generating and billing, and a retry doubles both.
- **Retries with exponential backoff** (default 3 attempts, 500 ms × 2ⁿ) only for answers that mean
  "try again": 429, 500, 502, 503, 504, and a connection that never opened. 401/403/404/other 4xx and
  malformed bodies fail at once — retrying cannot fix them.
- A caller's `AbortSignal` cancels the attempt and the wait between attempts.
- Every failure is a typed error with a fixed message and a `failureClass`. **No error carries the
  upstream body, the status text or the key** — the body can echo the prompt, which can carry student
  data. The status code is kept as a number for operators.

| Failure class | When |
|---|---|
| `PROVIDER_UNCONFIGURED` | any of the three variables blank or refused |
| `PROVIDER_MODEL_MISMATCH` | the feature's model is not the configured model (no call made) |
| `PROVIDER_TIMEOUT` | an attempt exceeded the timeout |
| `PROVIDER_UNREACHABLE` | the connection failed on every attempt |
| `PROVIDER_AUTH_FAILED` | 401 or 403 (wrong or missing key) |
| `PROVIDER_NOT_FOUND` | 404 (usually a base URL without `/v1`, or the model not loaded) |
| `PROVIDER_RATE_LIMITED` | 429 on every attempt |
| `PROVIDER_SERVER_ERROR` | 5xx on every attempt |
| `PROVIDER_REJECTED` | any other 4xx |
| `PROVIDER_MALFORMED_RESPONSE` | not JSON, or no non-empty `choices[0].message.content` |
| `PROVIDER_CANCELLED` | the caller aborted |

### 3. Order of checks before any call

`AiOrchestrator.generate`: unknown feature → refused (unmetered, as before); **kill switch engaged →
`REFUSED / KILL_SWITCH_ENGAGED`**; feature off → `REFUSED / FEATURE_DISABLED`; cap → `CAP_EXCEEDED`;
size → `INPUT_TOO_LARGE`; then the adapter (model check, then network). The kill switch is checked by
its own query as well as being folded into `loadAiFeaturePolicy`, so the refusal says *why*, and a
stale policy object can never outrun it.

### 4. Accounting: two nullable columns on `ai_generations` (0105)

- `latency_ms` — wall time of the provider call including retries and backoff; on a refusal NULL
  (nothing was called).
- `provider_attempts` — HTTP attempts made (1–10); NULL when no attempt was made.

Token counts were already there and are filled from the provider's `usage` block (0 when the
provider omits it, so metering never breaks). Nullable rather than defaulted: a row from before 0105,
or a refusal, honestly has no latency. CHECKs bound both. The generated text is still never stored here.

### 5. Health for AI Operations: a probe table, filled by a command, never by a request (0105)

AI Operations needs "endpoint configured / reachable / model id". *Configured* and *model id* come
from the API process's own environment (only whether the key is set leaves the server, never the key;
the endpoint is shown as its host only). *Reachable* needs a network call, and CLAUDE.md forbids a
request handler calling the inference endpoint, so the console reads the **latest recorded probe**:

`ai_provider_probes` — one row per probe: provider key, endpoint host, configured, configured model,
reachable, whether the configured model is in `GET {base}/models`, failure class, latency, `probed_at`
(DB `now()`). Append-only by trigger except a retention delete of rows older than 90 days, which the
probe command performs. `corepack pnpm --filter @planthepath/persistence ai:probe` writes one row; the
runbook schedules it. The console shows `probedAt`, so a stale probe is visible as stale.

The table holds no personal data and no key; it is operational telemetry, so it does not need a
separate table-design document beyond this section.

Rejected: probing from the API on each console load (a request handler reaching the endpoint);
a background timer inside the API process (the same rule in spirit, and a second scheduler);
storing the full model list (only "is the configured model served" is a decision input).

### 6. Where calls are allowed

`createWorkerAiOrchestrator` (persistence, `ai-workers.ts`) is the only constructor that wires the
environment adapter to the database policy, kill switch and metering. It is for worker processes and
jobs. A contract test fails if any file under `apps/` imports it, `OpenAICompatibleProvider`,
`inferenceProviderFromEnvironment` or `AiOrchestrator`. The API reads configuration through
`describeInferenceConfiguration`, which never makes a call. No AI feature is registered by ENG-20:
the first one (ENG-23, content factory) is an outbox job built on this factory, behind its own flag.

## What this does not do

- No feature, prompt or outbox consumer is added; `registeredPrompts` stays empty.
- Nothing reaches a student (HG-6). Nothing starts, stops or scales the pod.
- No cost: there is still no price table, so cost stays NA.
