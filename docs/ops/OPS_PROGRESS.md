# Operations console progress

> Goal reports for the operations plan (docs/ops/OPS_CONSOLE_PLAN.md), newest last, in the plan's Section 0.6 format.

Base branch: **feat/plan-phases-0-to-2** — the most advanced non-main branch; it contains all of
integration plus the plan-phase work. Chosen 2026-09-25 (OPS-00); head c802d3b after PRG-FIX.
Repository: PVUD14/ONE-V4 (private). Goal branches are cut from the base and merged back into it;
main and production are released by Divakar only.

## PRG-00 — Program bootstrap (baseline validation) — 2026-09-25
**Result:** Complete.
**What was done:** `.program/` and `SCOPE/` (where the controller PDF was saved) added to
`.git/info/exclude`; `git status --ignored` confirms both are untracked. PDF path noted in the state file;
a text extract kept at `.program/ONE_PROGRAM_GOAL.txt` so later runs need not re-extract it. Base branch
chosen after `git fetch --all` and a head comparison: feat/plan-phases-0-to-2 @ d6687f2. State file
created with all 88 steps and all gates.
**Working tree:** the main checkout has uncommitted work not made by this program (Android, assistant/help,
contact, public profile, `.deploy/`, android-ci workflow, marketing files). Per A.3 it was left untouched;
all validation ran in a detached worktree of d6687f2 in the session scratchpad (since removed).
**Baseline validation (d6687f2, clean worktree, only DATABASE_URL exported, local dev Postgres in Docker):**
- `corepack pnpm install --frozen-lockfile` — pass
- `corepack pnpm typecheck` — pass
- `corepack pnpm build` — pass (web chunk-size warning only)
- `corepack pnpm test` — **fail**: stops at the first failing package. Rerun on a freshly migrated
  database with `pnpm -r --no-bail --workspace-concurrency=1 test`: **1 110 passed, 1 failed** across
  13 test-bearing packages (web 366, api 353, persistence 161/162, others 230).
- Failing test: `packages/persistence/test/exam-evidence-bridge.integration.test.ts` ›
  "publishes version 2 as the active model and retires version 1" — `expected [] to have a length of 1`.

**Cause (verified on a fresh database, not a stale-data artefact):** readiness model version 1
(`career-readiness-fundamentals`) is not created by any migration; it is written at runtime by the
career-readiness import (`packages/persistence/src/career-readiness.ts:331`). Migration 0030 creates
version 2 with `INSERT … SELECT … FROM readiness_model_versions WHERE version = 1`, so on any database
migrated before its first import — a fresh environment, CI, a new server — 0030 inserts nothing. A later
import then creates v1 as the active model and v2 never appears, so exam outcomes never become a
readiness input there. Separately, integration suites run `TRUNCATE users CASCADE`, which cascades via
`published_by_user_id` and wipes model versions on a reused dev database. Production is likely unaffected
if its import ran before 0030 — not verified (no production access, by rule).
**Classification:** not small and obvious — the fix decides how readiness model versions are published
(ADR-020 territory: a new migration and/or a change to the import path). A.4 hard stop for building
goals; recorded as a decision for Divakar.

## PRG-FIX — Readiness model v2 on a first import — 2026-09-25
**Result:** Complete — base green again.
**Decision:** adopted the run-1 recommendation without a recorded approval, per AGENTS.md ("ask once,
recommend, carry on") and B.6; logged as a default decision Divakar can override. On inspection the
migrator replays every file on every run (no tracking table), so a migration 0072 was unnecessary — an
environment self-heals at its next migrate; the remaining gap was the window between first import and
next migrate. Fix: the import publishes v2 in its own transaction with 0030's idempotent statements.
**Branch:** fix/prg-readiness-model-v2 → feat/plan-phases-0-to-2, commit c802d3b, fast-forward merged,
both pushed to onev4. No PR (`gh` not installed).
**Files modified:** packages/persistence/src/career-readiness.ts;
packages/persistence/test/career-readiness.integration.test.ts (new test);
packages/persistence/test/exam-evidence-bridge.integration.test.ts (precondition set up explicitly;
assertion unchanged).
**Migrations added:** none.
**Validation (fresh local DB, only DATABASE_URL exported):** typecheck pass · test pass — 1 112 passed,
0 failed (web 366, api 353, persistence 163, others 230) · build pass. The new test fails with the
source change reverted (verified), passes with it.
**Merge review (B.4):** no frozen file, navigation, migration, secret; no assertion removed or weakened.

## OPS-00 — Baseline and base-branch record — 2026-09-25
**Result:** Complete — base branch recorded with reasons; every Section 2.4 row confirmed or corrected
with file and route evidence; free migration numbers verified across all refs.
**Branch / PR:** docs/program-baselines (baseline documents only; no application code).
**Files created:** docs/ops/OPS_BASELINE.md, docs/ops/OPS_PROGRESS.md.
**Migrations added:** none.
**Validation:** as PRG-00 above.
**Acceptance criteria:** OPS progress names the base branch and why ✔ (state file + OPS_BASELINE);
every 2.4 row covered with evidence ✔; free migration numbers listed and verified across all branches ✔
(open-PR state not queryable: `gh` not installed; PR head refs checked instead).
**Corrections to the plan's Section 2:** base head is d6687f2 (integration + 25, 3 unpushed); local
`integration` is 84f915e, and 6449be1 is `onev4/integration`; "(main)" means onev4/main; the audit API is
already on integration; Overview caps each list at 200 and drops two widgets when data is missing; feature
flag overrides and caps have no API; Trust and Safety has no evidence route or detail/enforcement UI;
privacy also has POST /holds; Content Management is no longer read-only (LearnerContentStudio, whose role
list names non-existent roles); SECURITY_ADMIN is excluded from organisations, users and content;
migration numbers in AGENTS.md are stale.
**Risks / follow-ups:** the 3 base commits carrying migrations 0035, 0036 and 0071 exist only locally —
not on the onev4 backup. PR #9's external-applications design doc is the only branch work missing from
the base.
**Next goal:** EMP-00 (step 4).
