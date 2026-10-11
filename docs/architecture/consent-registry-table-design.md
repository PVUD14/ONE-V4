# Consent Registry and Withdrawal — Table Design for Circulation

**Status:** Circulated for comment — not yet implemented
**Date:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Migration:** Core block, `0028`
**Rule:** Circulated before any migration is written, per the migrations rule in `CLAUDE.md`

## Why this exists

`user_consents` (migration `0014`) is a good record and a closed vocabulary:

```sql
CONSTRAINT user_consents_key_ck CHECK (consent_key IN ('privacy-notice'))
```

One key is legal. Every additional consent the product needs — AI processing, employer discovery
beyond an application, anything an institution asks for — is therefore a migration, and the set of
keys is invisible to the application at runtime.

Three things are broken downstream of that:

1. **The gate is dormant and fails open.** The required version comes from
   `CONSENT_PRIVACY_NOTICE_VERSION`; unset means `required: false` means the gate renders its
   children. It is not in production preflight, and `consentGate.tsx` also renders children when the
   check throws — so a network blip is indistinguishable from consent.
2. **There is no withdrawal path**, though the schema supports `action = 'WITHDRAWN'` and the gate's
   own copy promises withdrawal "at any time from Settings". Under DPDP, withdrawal must be as easy
   as granting. Today it is impossible.
3. **The talent pool cannot be built** (Phase 3) because employer visibility is currently scoped to
   applications, and widening it needs a *distinct, revocable* consent — which needs a second key.

## The rule that keeps this honest

**The record stays append-only, and the registry never rewrites history.** A version bump adds a
definition row; a re-consent adds a `user_consents` row; a withdrawal adds a `user_consents` row.
Nothing is updated in place, because the history *is* the proof.

## Proposed tables

### `consent_definitions`

One row per consent key per version. The registry the CHECK constraint is standing in for today.

| Column | Notes |
| --- | --- |
| `consent_key` | text, part of the primary key — `privacy-notice`, `ai-processing`, `employer-discovery`, … |
| `version` | text, part of the primary key, 1–64 chars, matching `user_consents.version` |
| `title` | text, what the user is shown |
| `enforcement` | `BLOCKING` (the gate refuses entry without it) / `OPTIONAL` (a feature is unavailable without it) |
| `withdrawable` | boolean — see the open question below; expected `true` for every key |
| `document_ref` | text, nullable — the notice this version corresponds to |
| `effective_from` | timestamptz |
| `retired_at` | timestamptz, nullable — a retired version is no longer requestable but existing grants stand |

Primary key `(consent_key, version)`. A partial unique index enforces **one current version per key**:
`UNIQUE (consent_key) WHERE retired_at IS NULL`.

### `user_consents` — amended, not replaced

- Drop `user_consents_key_ck`.
- Add a foreign key from `(consent_key, version)` to `consent_definitions`, so a grant can only ever
  reference a version that actually existed.
- Everything else — append-only, `GRANTED`/`WITHDRAWN`, `recorded_at`, `correlation_id`, the
  `(user_id, consent_key, recorded_at DESC)` index — is unchanged.

**Current state of a consent** is the latest row per `(user_id, consent_key)`: granted at the current
version, granted at a superseded version (re-consent required), withdrawn, or absent.

## How this is consumed

- The gate reads `consent_definitions` for `BLOCKING` keys instead of an environment variable, and
  **fails closed** — an error blocks rather than renders. `CONSENT_PRIVACY_NOTICE_VERSION` stops
  being configuration and the production preflight loses one more way to be silently wrong.
- Withdrawal writes a `WITHDRAWN` row. A withdrawn `BLOCKING` consent means the gate blocks again.
- An `OPTIONAL` consent gates exactly one capability and nothing else. `employer-discovery` is the
  first: without it, employer visibility stays scoped to applications, which is today's behaviour and
  the safe default.

## Open questions for the owners

1. **What happens after a user withdraws the privacy notice?** They cannot use the product, and
   leaving them in a blocked screen forever is not a coherent answer. Proposal: withdrawal of a
   `BLOCKING` consent routes into the existing export-and-deletion flow — the 30-day grace and the
   `privacy_requests` machinery already exist — rather than inventing a limbo state.
2. **Is `withdrawable` ever false?** Proposal: no, and the column exists only to make that explicit
   rather than assumed. If no key ever sets it false, drop the column before the migration is written.
3. **Is consent per user, or per user per organization?** An institution-specific sharing consent
   would need an organization dimension. Proposal: keep it per user for now; the application- and
   external-application-level institution-visibility consents already model the per-relationship case
   in their own tables, and duplicating that here would give two answers to one question.
4. **Does a version bump on an `OPTIONAL` key re-prompt, or silently carry forward?** Proposal:
   re-prompt, since a changed notice is a changed ask.
5. **Which keys ship in the first migration?** Proposal: `privacy-notice` only, with
   `ai-processing` and `employer-discovery` added when their features are actually scheduled — a
   registry makes adding them cheap, which is the point.

## Not in scope here

The wording of any notice, and whether the current notice's disclosure of a US AI processor matches
what the deployment does. That is a content question with its own consequences and is tracked
separately against ADR-029.
