<!--
  Target `integration`, never `main`.
  Title format: [<Stream> · <Owner>] Short description
  e.g. [C · Navya] Staff action record and intervention writes
-->

## Attribution

<!-- Must match the trailer block on your commits. -->

- **Stream:**
- **Owner:**
- **Agent:** <!-- tool and model, or: none -->
- **Agent-Scope:** <!-- what the agent actually did; omit if Agent: none -->

## What changed and why

<!-- Two or three sentences. What a reviewer needs to judge this, not a changelog. -->

## Screens affected

<!-- List them, or write: none -->

## Migrations added

<!-- Numbers used — must be inside your reserved block. Or: none.
     Reserved: Divakar 0016, 0028+ · Manisha 0017–0019 · Navya 0020–0023 · Santhosh 0024–0027 -->

## Style files touched

<!-- Must be "none" unless Divakar approved it in writing. Frozen paths are listed in AGENTS.md. -->

## What I tested

<!-- What you actually ran and what you actually clicked. Not what you intend to test. -->

---

## Checklist

- [ ] Only files my stream owns are changed
- [ ] No frozen style or brand file touched
- [ ] No navigation item added, removed or reordered
- [ ] No invented data — `NA` or `0` where a data source is missing
- [ ] No secret, key, token or connection string in the diff
- [ ] No test, CI check or authorization guard weakened
- [ ] Migration number inside my block; no existing migration edited
- [ ] Every new file carries its header banner
- [ ] Commit trailers present: Stream, Owner, Agent, Reviewed-By
- [ ] `corepack pnpm typecheck` passes
- [ ] `corepack pnpm test` passes
- [ ] Branch rebased on `integration`
- [ ] If an AI agent produced any of this, I have read the entire diff
