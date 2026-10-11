# Runbook — switching the AI tutor on in the demo sandbox (ENG-22)

What this is: the steps that make "Ask the AI tutor" appear and work on demo.oneby8.com, the sandbox of
sample data (ADR-046). Why it exists: the tutor is off by default everywhere; it serves only a
deployment that declares itself the sandbox, and only through the evaluation gate. This runbook is how
that is done on purpose, and nothing else turns it on. Design: `docs/architecture/tutor-hints-table-design.md`.

**Production is not touched.** No AI reaches a real student until the privacy notice names the inference
venue (HG-6); the live path for real students is ENG-25. On `oneby8.com` the tutor reads `OFF` whatever the
database flag says, because the API and the worker there do not carry the sandbox variables below.

## Before you start

- The sandbox stack from ADR-046 is installed (`COMPOSE_PROFILES=sandbox`, `postgres-demo`, `api-demo`,
  `web-sandbox`) and seeded (`sandbox-reset`).
- The pod is up and `ai:probe` reaches it (`docs/ops/runbook-inference-endpoint.md`).
- A bake-off PASS exists for `tutor.hint` on the model the pod serves, with its human review sheet
  (`deploy/ai-pod/bake-off/README.md`). Without it, step 4 refuses — that is the gate working.

## 1. The sandbox API declares itself the sandbox

Add to the `api-demo` service's `environment` (it already has `NODE_ENV: development`):

```yaml
      ONE_SANDBOX: "true"
      ONE_AI_TUTOR_AUDIENCE: sandbox
```

The API reads both on every request; with either missing, or `NODE_ENV=production`, the tutor is `OFF`.
The API never calls the model and needs no `ONE_AI_*` variable.

## 2. A sandbox outbox worker writes the hints

The hint is written by a job on the outbox (CLAUDE.md: no model call in a request handler). The sandbox
has no n8n, so its worker runs the `local-outbox` mode (the outbox drained in-process, no workflow
service). Add a service next to `api-demo`:

```yaml
  worker-demo:
    image: one-api-sandbox:local
    restart: unless-stopped
    working_dir: /app
    command: ["corepack", "pnpm", "--filter", "@planthepath/persistence", "worker:automation"]
    environment:
      AUTOMATION_WORKER_MODE: local-outbox
      DATABASE_URL: postgresql://one_sandbox:${DEMO_POSTGRES_PASSWORD:-}@postgres-demo:5432/one_sandbox
      NODE_ENV: development
      ONE_SANDBOX: "true"
      ONE_AI_TUTOR_AUDIENCE: sandbox
      ONE_AI_BASE_URL: ${ONE_AI_BASE_URL:-}
      ONE_AI_API_KEY: ${ONE_AI_API_KEY:-}
      ONE_AI_MODEL: ${ONE_AI_MODEL:-}
    depends_on:
      postgres-demo:
        condition: service_healthy
    networks:
      - demo-db
      - demo-edge   # outbound HTTPS to the pod
    mem_limit: 384m
    profiles: ["sandbox"]
```

The worker re-checks the audience, the student's consent and that the question is still unanswered before
any call, and the orchestrator re-checks the kill switch, the feature switch and the cap. Blank `ONE_AI_*`
means every request falls back to the written hint (`AI_UNAVAILABLE`), never a crash.

## 3. Register the features in the sandbox database

```
docker compose --profile sandbox run --rm sandbox-reset \
  corepack pnpm --filter @planthepath/persistence ai:register-features
```

(or any one-off container with the sandbox `DATABASE_URL`). Registration inserts `tutor.hint` switched off.
After each nightly reset, steps 3–6 must be repeated: the reset drops the database (a reset hook can run
them; see "After a reset").

## 4. Record the evaluation in the sandbox database — the existing gate

The PASS lives in each database it is to unlock. Import the same results and review sheet into the
sandbox database (the recorder must hold `AI_OPS_CONFIGURE` there — the sandbox operations persona):

```
DATABASE_URL=<sandbox> AI_EVALUATION_RECORDER_USER_ID=<sandbox operator uuid> corepack pnpm --filter @planthepath/persistence \
  ai:bake-off-import --results results-….json --review review-….json --feature tutor.hint --dry-run
# then without --dry-run
```

Do not insert an `ai_evaluations` row by hand and do not edit the policy row: 0089 refuses to switch a
feature on without a passing record for exactly its model and prompt version, and that is the point.

## 5. Consent for the sample students

The tutor serves only students who hold `ai-tutoring` (ENG-01). Its real wording is not published (HG-6),
so in the sandbox a sandbox-only definition is put in place and granted to the sample students:

```
DATABASE_URL=<sandbox> ONE_SANDBOX=true corepack pnpm --filter @planthepath/persistence ai:tutor-sandbox-consent
```

It refuses unless `ONE_SANDBOX=true`, `NODE_ENV` is not production, the database name ends in `_sandbox` on
`postgres-demo` or this machine, and every account in the database is a sample account. It prints counts.

## 6. Switch `tutor.hint` on in AI Operations

Operations → AI Operations (signed in to the sandbox as an operator with `AI_OPS_CONFIGURE`): the
`tutor.hint` row shows the PASS; **Switch on…** with reason `PILOT_ROLLOUT` puts it to a second person
(OPS-02 dual control; with one approver the solo path applies, with its cooling-off). Leave the cap at
500/day. Each student is also capped at 20 AI hints a day.

## Check it works

Sign in as the sample student, open Learning, plan a step on a skill whose questions have published hint
ladders, and press **Ask the AI tutor for hint 1**. The level shows "being written", then the hint with
the **AI hint** label and "Written by the AI tutor and checked by ONE's rules — not reviewed by a person".
The same works on the Android app pointed at the sandbox. In AI Operations, **Tutor hints** shows the
sample and anything the guard refused.

## Switching it off

Any of these stops it at once, no restart: **Switch off…** on `tutor.hint`; the global kill switch;
removing `ONE_AI_TUTOR_AUDIENCE` from `api-demo` and `worker-demo`. Students then see the written hints
only; a hint already being written falls back to the written hint.

## After a reset

The nightly `sandbox-reset` drops and re-seeds the database, so the registration, the evaluation record,
the sandbox consent and the switch are gone. Repeat steps 3–6, or leave the tutor off between demos — off is
the safe default.
