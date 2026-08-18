# Temporal Relationship Policy

## Canonical Policy

An institution relationship authorizes student activity only inside its effective time window.

The boundary convention is:

```text
effective_from <= activity_occurred_at < effective_to
```

`effective_to` is exclusive.

## Relationship State Semantics

| State | Access behavior |
| --- | --- |
| `PENDING` | Denied |
| `VERIFIED` | Allowed inside the effective window; may continue if `effective_to` is null |
| `ACTIVE` | Allowed inside the effective window; may continue if `effective_to` is null |
| `ENDED` | Denied in this implementation pending a separately approved historical-retention policy |
| `TRANSFERRED` | Former relationship; allowed only for eligible historical activity before a non-null `effective_to` |
| `GRADUATED` | Allowed inside the effective window; may continue if `effective_to` is null under existing behavior |
| `REVOKED` | Denied |

## TRANSFERRED Safety Invariant

A `TRANSFERRED` relationship without `effective_to` fails closed.

The database migration adds a constraint so new malformed transferred rows are rejected. The shared helper also denies such a relationship so in-memory/application behavior remains safe if it receives malformed data from a test fixture or older source.

## Aligned Layers

- `packages/authorization/src/index.ts` contains the canonical helper.
- `apps/api/src/application/identity-organization/services.ts` uses that helper for in-memory representative access checks.
- `packages/persistence/src/repositories.ts` applies the same state and timestamp rule in the PostgreSQL query.
- `packages/persistence/drizzle/0002_phase_b_event_foundation.sql` rejects `TRANSFERRED` relationships without an end timestamp.

## Known Ambiguity

Historical access for `ENDED` relationships is not fully specified beyond the existing denial behavior. Phase B preserves the narrowest safe behavior and does not silently broaden `ENDED` access. A future product/privacy decision can add an explicit historical-retention policy if needed.
