# Membership Capabilities — Table Design for Circulation

**Status:** Circulated for comment — not yet implemented
**Date:** 2026-09-12
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending
**Migration:** Core block, `0031`
**Implements:** ADR-018 — Institution Analyst is a capability, not a role
**Rule:** Circulated before any migration is written, per the migrations rule in `CLAUDE.md`

## Why this exists

ADR-018 removed Institution Analyst as a role and replaced it with a capability:

> *"ADR-018: Institution Analyst is not a role. Analytics-and-export is a capability grantable to
> `['INSTITUTION_ADMIN','DEPARTMENT_HEAD']` and to no others."*

The predicate that reads it already exists — `canReadInstitutionAnalytics` in
`packages/authorization`, taking an `analyticsCapabilityGranted` flag. **No controller calls it and
nothing stores the flag.** The decision is made, the logic is written, and the input has nowhere to
come from.

Eleven designed analyst screens depend on this being wired, and so does every future capability that
is narrower than a role — bulk export being the obvious next one.

## Why a table rather than a column

Adding `analytics_capability_granted boolean` to `organization_memberships` is one line and it is the
wrong line:

- It invites one column per capability on a table that already carries five scope columns and a
  unique index over `(organization_id, user_id, role)`.
- A grant is an **audit-worthy event**. It needs a grantor, a timestamp, a reason and a revocation —
  four more columns for the first capability, four more for the second.
- Revocation history matters. "Who could see cohort exports in March" is a question a boolean cannot
  answer.

## Proposed table

### `membership_capabilities`

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `membership_id` | references `organization_memberships(id)` |
| `capability` | text, CHECK against a small closed set — initially `INSTITUTION_ANALYTICS` only |
| `granted_by_user_id` | references `users(id)` |
| `granted_at` | timestamptz NOT NULL DEFAULT now() |
| `reason_code` | text, `^[A-Z0-9_:-]{3,64}$` — the bounded shape already used by `rights_reviews` and `quality_reviews` |
| `revoked_by_user_id`, `revoked_at` | nullable, **set together** by CHECK |

- `UNIQUE (membership_id, capability) WHERE revoked_at IS NULL` — one live grant per capability per
  membership; re-granting after revocation adds a row rather than resurrecting one.
- Extend `capability` by migration, never by free text. The repository's existing habit — an enum-like
  CHECK rather than an open column — is deliberate and worth keeping.

### Enforcing "to no others"

The role restriction is the substance of ADR-018, so it belongs in the database rather than in one
controller's memory. Proposal: a `BEFORE INSERT OR UPDATE` trigger rejecting a grant whose membership
role is not `INSTITUTION_ADMIN` or `DEPARTMENT_HEAD`, matching how `0001` already validates
membership roles.

The alternative — a CHECK cannot reach another table, so it would have to be a controller check —
puts a decision recorded in an ADR at the mercy of whoever writes the next endpoint.

## How this is consumed

- The grant resolves to the `analyticsCapabilityGranted` argument `canReadInstitutionAnalytics`
  already takes. No new authorization concept is introduced.
- **Scope comes from the membership, not the grant.** A Department Head's grant is bounded by
  `scope_department_unit_id` exactly as their other reads are; the capability widens *what* they may
  do, never *whose data*.
- Every existing disclosure rule continues to apply on top. In particular ADR-024 — an institution
  never sees offer compensation, per student or in aggregate — is unaffected, and
  `isInstitutionForbiddenDisclosureField` remains the filter on any export this capability unlocks.
- Granting and revoking are audited to `audit_events` like every other privileged mutation.

## Open questions for the owners

1. **Who may grant it?** Proposal: `INSTITUTION_OWNER` and `INSTITUTION_ADMIN` within their own
   institution, and Operations may not grant it on a customer's behalf. A Department Head may not
   grant themselves the capability — the self-grant prohibition matches the repository's existing
   refusal of self-approval on content reviews.
2. **Does a Placement Admin ever hold it?** ADR-018 says admin and department head only. Placement
   Officers arguably have the strongest day-to-day need for cohort analytics. Proposal: leave as ADR-018
   wrote it and revisit with evidence rather than widening it here by inference.
3. **Does the grant survive a role change?** If an Institution Admin is moved to Faculty, their grant
   is dangling and the trigger would not catch it after the fact. Proposal: revoke on role change,
   implemented in the membership-update path and covered by a test.
4. **Is `INSTITUTION_ANALYTICS` one capability or two?** Reading cohort analytics and exporting them
   are different risks — an export leaves the platform. Proposal: ship one now, and split into
   `INSTITUTION_ANALYTICS` and `INSTITUTION_EXPORT` when an export artifact actually exists, since the
   split is cheap while the set has one member.
5. **Does Operations need to see who holds what across all institutions?** Proposal: yes, read-only,
   in the existing Users & Access surface — it is a support question that will be asked.

## Not in scope here

The analytics surfaces themselves, the reports they render and any export artifact. This design
establishes only who is permitted to reach them.
