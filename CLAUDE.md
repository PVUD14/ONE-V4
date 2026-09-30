# ONE — Rules for this repository

ONE is built by two of us: **Divakar**, and the AI agent working in this repository.
There is no wider team. Earlier versions of this file described five ownership streams
with named owners; those people do not exist, and enacting that fiction cost real time.
Anything in the repository still written for a team — scoped exceptions addressed to
absent owners, per-stream migration blocks, fork-based pull requests — is history, not
instruction.

Work anywhere in the repository. The rules below are not about who owns what. They are
the small number of things that protect the product, its users and Divakar from a bad
day, and they stay.

## Never do these

- Deploy, release or publish anything to production: `oneby8.com`, its AWS server,
  or the retired `one.ai8ht.pro` host.
- Connect to the production server: no SSH, no database client, no file copy.
- Read, copy, restore or derive from production data.
- Commit a key, token, password, connection string or private key — anywhere,
  including tests, fixtures, comments and documentation. Open a `.env` or any file
  holding secrets only when the task genuinely requires it, and never print it.
- Edit or delete an existing migration; run any migration against production.
- Put invented data — fictional people, sample numbers, plausible figures — on any
  screen a real user can reach.
- Compute, project or display a numeric readiness value, or expose readiness to an
  employer. Readiness is an advisory band. This is enforced by CHECK constraints in
  `readiness_snapshots`; do not work around them.
- Add a synchronous model/LLM call inside a request handler.
- Disable, skip, weaken or delete a test or an authorization guard to make something
  pass. Fix the cause.

Divakar can waive any of these, in a session, by saying so. He is the only person who
can. If a waiver would put real user data, a credential or production at risk, say so
once and then do as he asks.

## Frozen by design, not by ownership

Do not modify these without Divakar saying so explicitly. They are frozen because
consistency in them is the product, not because someone else owns them.

    apps/web/src/styles.css
    apps/web/src/pilot/pilot.css
    apps/web/src/brand.tsx
    apps/web/src/pilot/pilotComponents.tsx
    apps/web/public/assets/ai8ht-*.png

`deploy/**`, `infra/**` and `.github/workflows/**` are editable, but nothing in them
reaches production without Divakar running the release by hand. Infrastructure that
needs an AWS account is out of reach until he provides access.

## Build rules

- Use the existing pilot design tokens, classes and components. No new stylesheets,
  no inline restyling of shared components.
- The AI8HT wordmark is the brand everywhere, in every client. Never substitute text,
  initials, a placeholder icon or another logo. Render it with `BrandWordmark`.
- The pilot's design system is the canonical UI for the web app and the mobile app —
  its composition and density, not only its tokens.
- Never invent data. If a data source does not exist, render `NA` or `0` in the same
  slot. Never drop a widget because its data is missing.
- An unbuilt screen uses the existing empty state and says so plainly. Never borrow
  another role's data to make a page look populated.
- Never expose internal identifiers, stack traces or upstream error text to an end user.
- Preserve existing schema constraints and consent/visibility behaviour. Do not relax a
  constraint to make a feature easier.
- Navigation items are not removed, renamed or reordered to hide an unfinished screen.

## AI

**Held.** Inference will run on AWS through managed inference, once Divakar provides AWS
access (ADR-030, superseding ADR-029). The RunPod GPU pod was abandoned on cost. Until
that access exists, do not integrate a provider, write model-dependent code, or stand up
a serving stack — and do not propose self-hosting again without the measured cost case
ADR-010 asks for.

The hold does not cover `packages/ai-orchestration`, which is provider-agnostic and
built. When access arrives the remaining work is one adapter.

These rules survive whatever the model is and wherever it runs:

- No portal and no request handler calls an inference endpoint. Everything goes through
  ONE AI Orchestration.
- Generation is a job on the outbox/event pipeline, never a call from a controller.
- Anything a model produces is stored as a row carrying `source`, `generator_version`,
  `prompt_version`, `review_state`, `generated_at`, and lands as `DRAFT` for a human to
  publish.
- Every AI feature ships behind its own flag, default off, with its own cap.
- An LLM is never the readiness scoring engine, and no model output produces or
  influences a numeric readiness value.
- Before an AI feature reaches a student, benchmark the served model against the task it
  is doing and record the result.

## Migrations

- Never edit or delete an existing migration; only add new ones.
- Numbers are sequential. `0016`, `0033`–`0039` and `0071`+ are free; everything else up
  to `0070` is used. The old per-owner blocks are retired.
- For a table that carries real consequences — provenance, consent, enforcement,
  anything a person's record depends on — write the design down first, in
  `docs/architecture/`, and put the reasoning in it. Several of those documents exist and
  have already caught mistakes worth catching.

## Decisions

Architecture decisions live in `docs/architecture/ADR-*.md`. When a decision is taken,
write the ADR — including what was rejected and why. When an ADR is superseded, say so
in the new one rather than editing the old one.

## Commits and branches

Branch names are descriptive: `feat/academic-records`, `fix/consent-gate`. No prefix
scheme.

Commit messages explain *why*, not what — the diff already says what. End with:

    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

New files get a short header saying what they are and why they exist. No owner or
stream line.

`main` is Divakar's alone and production is released from it by hand. Everything else
can be pushed and merged freely; `onev4` (`PVUD14/ONE-V4`) is the backup remote.

## Local development

    corepack enable && corepack prepare pnpm@10.15.0 --activate
    corepack pnpm install
    cp .env.example .env          # then set DATABASE_URL
    set -a; . ./.env; set +a      # the API does not load .env itself
    corepack pnpm db:migrate
    corepack pnpm api:dev         # 127.0.0.1:3000
    corepack pnpm web:dev         # 127.0.0.1:5173

Before every push: `corepack pnpm typecheck && corepack pnpm test`.

Note that sourcing the whole `.env` into a web test run sets `VITE_COGNITO_*` and makes
sign-in tests fail for reasons unrelated to the change. Export only `DATABASE_URL` for
the database-backed suites.

Seeded or synthetic data only. Production data never leaves production.

## When in doubt

Build the thing. If a choice is genuinely consequential and you cannot resolve it from
the code, ask once, recommend an answer, and carry on. Do not stop and wait.
