# Feature Flags and Caps — Table Design for Circulation

**Status:** Circulated for comment — not yet implemented
**Date:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Migration:** Core block, `0029`
**Rule:** Circulated before any migration is written, per the migrations rule in `CLAUDE.md`

## Why this exists

`CLAUDE.md` already requires it: *"Every AI feature ships behind its own flag, default off, with its
own cap."* No such machinery exists — a repository-wide search for `feature_flag`, `featureFlag` or
`FEATURE_FLAG` returns nothing in `apps/`, `packages/` or any migration. The Operations portal has a
Feature Flags nav item that renders a not-yet-available state.

So a rule the project treats as binding has no implementation behind it, and the first AI feature
cannot comply with it. Flags are also the mechanism that lets Phase 2 and Phase 3 surfaces land dark
rather than waiting for their engines, which matters well before any AI work starts.

## What a flag is, and is not

**A flag is an operational control:** a kill switch, a staged rollout, a per-institution pilot
enablement, and a spend ceiling on an expensive operation.

**A flag is not an entitlement.** ADR-022 is explicit that capability gating built before billing
*"must not assume a billing source of truth… and do not introduce a placeholder entitlement concept
that billing would later have to displace."* Nothing in this design may be used to express what a
customer has paid for. Authorization continues to gate on role and membership. If a flag is ever
reached for to answer a commercial question, that is the signal that billing is being built by
accident.

## Proposed tables

### `feature_flags`

| Column | Notes |
| --- | --- |
| `key` | text primary key, `^[a-z0-9][a-z0-9._-]{2,63}$` |
| `description` | text — what turning this on does, in a sentence |
| `enabled` | boolean NOT NULL **DEFAULT false** |
| `cap_kind` | `NONE` / `INVOCATIONS` / `TOKENS` / `COST_MINOR_UNITS`, nullable with `cap_value` |
| `cap_value` | bigint, nullable — paired with `cap_kind` by CHECK |
| `cap_window` | `DAY` / `MONTH`, nullable — paired the same way |
| `created_at`, `updated_at` | timestamptz |

Default-off is a column default, not a convention, so a flag inserted carelessly is off.

### `feature_flag_overrides`

Narrow enablement without turning a flag on globally — one pilot institution, one test user.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `flag_key` | references `feature_flags(key)` |
| `scope_kind` | `ORGANIZATION` / `USER` |
| `scope_id` | uuid — an `organizations(id)` or a `users(id)` |
| `enabled` | boolean — an override can also force a flag **off** for one tenant |
| `created_by_user_id`, `created_at` | |
| `revoked_at` | timestamptz, nullable |

Unique on `(flag_key, scope_kind, scope_id) WHERE revoked_at IS NULL`.

**Resolution order:** user override → organization override → global `enabled`. Absent flag resolves
to off, never to on.

### `feature_flag_events`

Append-only. Who changed what, from what, to what, and why.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `flag_key` | references `feature_flags(key)` |
| `actor_user_id` | references `users(id)` |
| `change_kind` | `ENABLED` / `DISABLED` / `CAP_CHANGED` / `OVERRIDE_ADDED` / `OVERRIDE_REVOKED` |
| `from_value`, `to_value` | jsonb, payload-minimised |
| `reason_code` | text, `^[A-Z0-9_:-]{3,64}$` — the same bounded shape `rights_reviews` and `quality_reviews` already use |
| `correlation_id`, `occurred_at` | |

Spec §103 classes changing global authorization policy and disabling security controls as high-risk
actions requiring **reason capture and audit**. Flipping a flag that gates a safety behaviour is in
that class, so the reason code is mandatory rather than a nicety.

## How the cap is counted — open, and load-bearing

A cap needs a counter, and there is a real question about where it lives. Spec §7.17 gives AI
Orchestration ownership of *"usage metering, cost data"*. Two options:

- **Counter here** — a `feature_flag_usage (flag_key, window_start, scope_id, count)` table, generic
  across features. Simple, and wrong if AI Orchestration ends up metering the same calls separately.
- **Counter in AI Orchestration**, with `feature_flags` holding only the ceiling and the orchestrator
  enforcing it. Avoids two sources of truth for spend, but means a non-AI feature cannot be capped.

**Proposal: the ceiling lives here, the counting lives with whoever performs the work.** A flag
declares a limit; the subsystem doing the expensive thing reports against it. This keeps one place to
read "what is the cap" and avoids inventing a metering system before the thing being metered exists.
This is the main thing to settle in review.

## Open questions for the owners

1. The cap counter question above.
2. **Who may flip a flag?** Proposal: `PLATFORM_SUPER_ADMIN` and `OPERATIONS_ADMIN` for rollout
   flags; anything gating a safety behaviour additionally requires `SECURITY_ADMIN`, and spec §103
   suggests dual control for the highest-risk ones. Dual control is a bigger build — is it in scope?
3. **Is the resolver cached?** Reading three tables on every request is avoidable but a stale cache
   turns a kill switch into a suggestion. Proposal: short TTL with an explicit invalidate on write,
   and never cache a flag that gates a safety behaviour.
4. **Do flags appear in the student-facing API at all?** Proposal: no. The client renders what the
   server sends; a client that can read the flag set can also enumerate unreleased features.
5. **Cleanup.** A flag that is permanently on is debt. Proposal: `feature_flag_events` makes age
   visible, and the Operations screen shows last-changed so stale flags are obvious.

## Not in scope here

Entitlements, plans, seats and anything a customer buys — see ADR-022.
