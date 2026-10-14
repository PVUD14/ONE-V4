# Operations baseline

> docs/ops/OPS_CONSOLE_PLAN.md goal OPS-00: what the operations console actually has on the base branch, so later OPS goals start from verified facts rather than the plan's assumptions.

Date: 2026-09-25 · Base: feat/plan-phases-0-to-2 @ d6687f2 · Evidence read from a clean worktree of
that commit. Line numbers refer to d6687f2.

## Branch heads

| Ref | Head | Date | Plan claim → verified |
|---|---|---|---|
| main (local) | 988d1ce | 18 Aug | — ; ancestor of onev4/main, 105 behind; tracks origin (planthepath-next); no operations surface |
| onev4/main | e928d12 | 27 Aug | e928d126 — confirmed. Every "(main)" claim in the plan means this ref |
| integration (local) | 84f915e | 27 Aug | onev4/main + 1 Android commit; 80 behind onev4/integration |
| onev4/integration | 6449be1 | 9 Sep | confirmed; 81 ahead of onev4/main |
| onev4/feat/plan-phases-0-to-2 | 07b3747 | 12 Sep | confirmed; onev4/integration + 22 |
| feat/plan-phases-0-to-2 (local) | d6687f2 | 14 Sep | **plan is stale**: + 3 unpushed commits (fd53ac1, f22e8d4, d6687f2) carrying migrations 0035, 0036, 0071 — not on the backup remote |

Branches with commits not in the base, all superseded: integ-try-manisha (alternate merge, both
parents in base); stream/d-santhosh/content-tables and content-generation-pipeline (patch-equivalent);
stream/e-divakar/phase-0-governance-amendment (CLAUDE.md "Stream F", superseded by the solo rewrite);
onev4/stream/b-manisha/interviews-offers-api (re-committed as 034147c); source/* (unrelated history,
imported verbatim as c39786b). **One gap:** onev4 PR #9 (stream/b-manisha/external-applications-design,
bbb8c0c) carries `packages/hiring/EXTERNAL_APPLICATIONS_DESIGN.md`, absent from the base (a document; the
implementation is present).

Base branch: **feat/plan-phases-0-to-2** — most advanced non-main branch, contains all others' operations work.

## Migrations

Base (33 files): 0000–0015, 0017–0020, 0024, 0026, 0028–0036, 0070, 0071. No ref (local or remote,
checked with git ls-tree) has a migration absent from the base; no number collisions. onev4 PR heads
#1–#17 checked via refs; `gh` is not installed, so open-PR state could not be queried by API.
Runner applies in lexical order (`packages/persistence/src/migrate.ts:19`).

**Free:** 0016, 0021, 0022, 0023, 0025, 0027, 0037–0069, and 0072+. Next sequential after highest: **0072**.
AGENTS.md/CLAUDE.md line 96 is stale (lists 0033–0039 and 0071 as free).

## Section 2.4 — confirmed / corrected

| Row | Verified state | Evidence |
|---|---|---|
| Organisations | Working on onev4/main and base. Guard excludes SECURITY_ADMIN. Organization Detail and Verification render the same page as Organizations. Web sends hard-coded reason code `OPERATIONS_UAT` | operations-institution-onboarding.controller.ts:71, 86–333, 762–765; rolePortalPages.tsx:232–246; api/operations.ts:78 |
| Users / invitations | Read-only, confirmed; `LIMIT 200`; User Detail = same page as Users | onb controller :263, :298, :303, :328; rolePortalPages.tsx:234–235 |
| Overview | **Corrected:** loads the three lists capped at 200 rows each — counts silently wrong above 200; also *drops* the ring and Accounts widgets when data is missing (conflicts with "never drop a widget") | dashboardsV2.tsx:633–675 |
| Audit search | **Corrected:** API is on onev4/integration (8 Sep, ae8810b), not only the plan branch; web page is plan-branch. Keyset (occurred_at,id), 50/200 | operations-audit.controller.ts:21–84; rolePortalPages.tsx:244 |
| Feature flags | **Overstated:** only the global enabled toggle is settable; org/user overrides and caps exist in schema but have no API; UI shows override count read-only | platform-controls.controller.ts:54–83; 0029_feature_flags.sql:17–60; operations.tsx:228–280 |
| Trust and safety | **Partial:** API list/detail/open/transition/actions; no evidence-add route; UI covers queue and transitions only — no detail, evidence or enforcement UI | trust-safety.controller.ts:49–135; api/operations.ts:180–189; trustSafety.tsx:106 |
| Failed events | API only, confirmed | operations-outbox.controller.ts:50, 61, 94 |
| Privacy | API only, confirmed; plan omits **POST /operations/privacy/holds** (place a hold) | operations-privacy.controller.ts:59–125 |
| Career-readiness content | **Stale:** Content Management now also renders `LearnerContentStudio`, which authors and transitions learner content. Its role list names three non-existent roles and excludes PLATFORM_SUPER_ADMIN | rolePortalPages.tsx:238–240; learner-content.controller.ts:44, 65–98; career-readiness.controller.ts:35, 121–138 |
| System/Security/AI status | Read-only status, confirmed | rolePortalPages.tsx:245; operations.tsx:138 |
| Subscriptions, Billing, Analytics, Support, Settings | Not yet available, confirmed | rolePortalPages.tsx:249 |

## Sections 2.2 / 2.3

- Internal roles exactly PLATFORM_SUPER_ADMIN, OPERATIONS_ADMIN, SECURITY_ADMIN — confirmed
  (authorization/src/index.ts:89). Membership trigger in 0001 (:175–211) confines them to the PLATFORM org
  and rejects unknown roles; no later migration changes it.
- "All three roles alike" holds only for the canSearchAuditEvents family (index.ts:105–108: audit,
  outbox, privacy, trust, feature flags). **Not** for organisations/users/invitations and career-readiness
  ops (SECURITY_ADMIN excluded), nor learner content (only OPERATIONS_ADMIN effectively).
- membership_capabilities CHECK allows only INSTITUTION_ANALYTICS (0031:30) — confirmed.
- Operations nav order confirmed exactly (rolePortalConfig.ts:171).
- Career roles from data/careers/starter-v1.json (5 roles) via seed-careers.ts:50–52 — confirmed.
  deploy/scripts/monitor.sh exists with a dead-man's-switch — confirmed.

## Validation on the base (d6687f2, clean worktree)

| Check | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | pass |
| `corepack pnpm typecheck` | **pass** (all packages) |
| `corepack pnpm db:migrate` (local dev DB) | pass |
| `corepack pnpm build` | **pass** (web: chunk-size warning only) |
| `corepack pnpm test` | **FAIL** — 1 test, reproduced on a freshly migrated database: `packages/persistence/test/exam-evidence-bridge.integration.test.ts` › "publishes version 2 as the active model and retires version 1". Cause and fix: OPS_PROGRESS.md (PRG-FIX). Full per-package counts: see OPS_PROGRESS.md |
