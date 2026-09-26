# ADR-035 — Migrations Apply Once and Are Recorded

**Status:** Accepted by default under AGENTS.md ("ask once, recommend, carry on"); Divakar may override
**Date:** 2026-09-26
**Supersedes:** the implicit replay-every-run behaviour of `packages/persistence/src/migrate.ts`

## Context

`db:migrate` used to run every `.sql` file in `packages/persistence/drizzle/` on every deploy, in
lexical order, with no record of what had run. Every migration was therefore written as an idempotent
"desired state" script: `CREATE … IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`.

That holds only while no two migrations describe the same constraint. Once they do, the earlier file
re-declares the old definition on every run:

- 0043 (support cases) re-adds `privacy_deletion_category_ck` with a list that lacks ENG-03's
  `LEARNING_ACTIVITY`. On any database holding a learning-activity deletion record, replaying 0043 fails
  ("violated by some row") before 0047 can widen it again — the deploy stops.
- 0038 (operation approvals) re-adds its five-key action CHECK every run, so OPS-08 had to store new
  approval actions in separate columns to avoid the same failure.
- Every future widening of an enum-like CHECK would hit this, and it cannot be caught by a test that
  migrates an empty database, because the failure needs a row that uses the widened value.

AGENTS.md forbids editing an existing migration, so the fix cannot live in 0043 or 0038.

## Decision

`db:migrate` applies each file **once** and records it in a ledger table, `schema_migrations`
(filename, SHA-256 checksum of the contents with line endings normalised, applied_at).

- Pending files run in lexical order, each in its own transaction together with its ledger row.
- A recorded file whose contents changed is refused with an error — the machine check for AGENTS.md's
  "never edit an existing migration".
- **Bootstrap:** a database with no ledger yet (every existing environment, including production) is
  brought forward exactly as deploys always have — every file replayed once, in order — and recorded.
  This is the operation every previous deploy performed; after it, nothing replays again. Because no
  released environment holds a row using a post-0043 value, that one replay is safe everywhere.

## Rejected

- **Edit 0043 and 0038 to list every value.** Forbidden by AGENTS.md, and the next widening would
  reintroduce the problem.
- **Keep replay and require every later migration to re-declare the full list, and every earlier
  migration to read the live constraint.** It cannot be retrofitted onto merged files, and one missed
  value breaks a deploy only after real data exists.
- **Store new enum values outside CHECKs (OPS-08's workaround) everywhere.** It works but spreads
  second columns through the schema to route around the runner rather than fixing the runner.
- **Adopt a third-party migration tool.** A larger change to the release path than the problem needs;
  the ledger is a few dozen lines with tests.

## Consequences

- A migration no longer self-heals on the next deploy. PRG-FIX already made the career-readiness import
  publish model v2 itself, so nothing depends on that behaviour.
- Migrations should still be written idempotently: CI's upgrade job applies 0000–0003 by hand before
  `db:migrate`, and bootstrap replays everything once.
- Tests that replay migration files directly into a throwaway schema (the integration-spec pattern) are
  unaffected; they never used the runner.
- OPS-08's extended-action columns remain valid and harmless; new approval actions may use either.
- The migration rules in AGENTS.md ("never edit or delete an existing migration; only add new ones")
  are now enforced by the checksum as well as by review.
