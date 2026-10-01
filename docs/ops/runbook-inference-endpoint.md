# Runbook — point ONE at the inference endpoint

> What this is: how to connect ONE to its model endpoint, check it, disconnect it and rotate its
> key. Why it exists: ENG-20 built the adapter (ADR-047: an OpenAI-compatible vLLM endpoint on a
> RunPod pod, behind a bearer key), and its address and key live only in the server's environment.
> How to bring the pod itself up is in [deploy/ai-pod/README.md](../../deploy/ai-pod/README.md).
> Written 2026-10-01; nothing here was run against production.

## What ONE reads

Three variables, in the **server's** `.env` beside `deploy/vps/docker-compose.yml`, passed to the
`api` container (where AI jobs and the probe run). Names only are in the repository.

| Variable | Value for the pod | Notes |
|---|---|---|
| `ONE_AI_BASE_URL` | `https://<pod-id>-8888.proxy.runpod.net/v1` (currently `https://sc8nlai7mv5i08-8888.proxy.runpod.net/v1`) | Must end in `/v1`. `https` only (`http` is accepted only for `localhost`). No credentials, query or fragment in it. The pod id changes if the pod is recreated |
| `ONE_AI_API_KEY` | the contents of `/root/one-ai/api-key` on the pod | Set **only** on the server, by Divakar. Never in the repository, a ticket, a chat or an incident note |
| `ONE_AI_MODEL` | `qwen2.5-14b-instruct` | The served model name. A feature whose policy names a different model is refused before any call (`PROVIDER_MODEL_MISMATCH`), so evaluations always match what runs |

**Any of the three blank = AI unavailable.** Nothing crashes and the API starts normally; every AI
job fails `PROVIDER_UNCONFIGURED` (metered), and AI Operations says which part is missing.

## Connect

1. Start the pod and run `deploy/ai-pod/setup-pod.sh` on it until it prints
   `self-test: key -> 200` ([README](../../deploy/ai-pod/README.md), steps 1–3).
2. On the ONE server, in the compose directory: `sudo nano .env` and set the three variables above.
3. Apply — this recreates only the API container:

   ```
   docker compose up -d api
   docker compose ps api                          # State: running
   ```

4. Probe once and record the result (no request handler ever contacts the endpoint, so AI
   Operations shows the latest probe this writes):

   ```
   docker compose exec -w /app/packages/persistence api node --import tsx src/run-ai-probe.ts
   ```

   Expected: one JSON line with `"configured":true,"reachable":true,"modelServed":true`. It prints
   the host and model, never the key or the URL path.
5. **Operations → AI Operations → Inference endpoint** shows *Configured: Yes*, the host, the model,
   *Key set on the server: Yes* and *Reachable* with the probe time.

Connecting switches no AI feature on. Each feature stays off until it has a passing evaluation for
its exact model and prompt and a second person's approval; the global kill switch overrides all of
them. No AI reaches a student before HG-6.

## Keep the probe fresh (optional)

The console shows when the probe ran, so a stale result is visible as stale. To refresh it every
15 minutes, add on the server (root crontab):

```
*/15 * * * * cd /srv/planthepath-next/deploy/vps && docker compose exec -T -w /app/packages/persistence api node --import tsx src/run-ai-probe.ts >/dev/null 2>&1
```

Adjust the path to wherever `docker-compose.yml` lives. The probe keeps 90 days of rows and prunes
older ones itself. A stopped pod shows as *Unreachable* (`PROVIDER_UNREACHABLE` or
`PROVIDER_SERVER_ERROR` from the RunPod proxy) — expected while it is stopped.

## Reading a failure

Failures are recorded by class only — never the upstream body (it can echo a student's text) or the
key. In AI Operations: *Refusals and failures by class*, and the probe's class.

| Class | Usual cause | Fix |
|---|---|---|
| `PROVIDER_UNCONFIGURED` | a variable is blank or refused | the panel names which; fix `.env`, step 3 |
| `PROVIDER_AUTH_FAILED` | key wrong, or the pod made a new key on a fresh start | copy the pod's key again (README step 4) |
| `PROVIDER_NOT_FOUND` | base URL without `/v1` | add `/v1` |
| `PROVIDER_UNREACHABLE` / `PROVIDER_SERVER_ERROR` | pod stopped, still loading, or the proxy is down | start the pod and run `setup-pod.sh` |
| `PROVIDER_TIMEOUT` | an answer took over 60 s (not retried, to avoid paying twice) | look at load on the pod; a smaller output cap |
| `PROVIDER_MODEL_MISMATCH` | the feature's model is not `ONE_AI_MODEL` | change the feature's model through AI Operations (it switches off until re-evaluated) or the variable |
| `PROVIDER_MALFORMED_RESPONSE` | the endpoint answered without usable text | check `/root/one-ai/vllm.log` on the pod |
| `PROVIDER_RATE_LIMITED` | 429 on every retry | lower the feature's cap |

Retries: 429, 500, 502, 503, 504 and dropped connections are retried twice with backoff (0.5 s,
1 s); 401/403/404 and malformed answers fail at once.

## Disconnect

Blank the three variables (or only `ONE_AI_BASE_URL`) in `.env` and `docker compose up -d api`. To
stop AI *now* without a restart, engage the kill switch in AI Operations instead — it is read before
every call ([runbook-ai-kill-switch.md](runbook-ai-kill-switch.md)).

## Rotate the key

1. Generate a new key on the pod (README §6). The old key stops working when vLLM restarts.
2. Set the new `ONE_AI_API_KEY` on the server and `docker compose up -d api`.
3. Probe (step 4). Between 1 and 2, jobs fail `PROVIDER_AUTH_FAILED` — harmless and metered; nothing
   is retried with the old key.

## Moving off the pod later

The adapter speaks the OpenAI chat-completions shape, so moving to AWS is configuration: for
Bedrock's OpenAI-compatible endpoint set `ONE_AI_BASE_URL` to its `/openai/v1` base, a Bedrock API
key as `ONE_AI_API_KEY`, and the Bedrock model id as `ONE_AI_MODEL`. Each feature's model then needs a
passing evaluation for the new model id before it can be switched back on.

## Never do

- Never commit, print, paste or log the key. Never put it in the URL.
- Never point `ONE_AI_BASE_URL` at plain `http` on another host.
- Never call the endpoint from a controller or a portal; AI runs only in jobs (CLAUDE.md, ADR-028).
