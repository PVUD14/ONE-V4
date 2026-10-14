# Internal Capabilities — Table Design

**Status:** Adopted (OPS-01), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0039_internal_capabilities.sql` (new; `0031` is not edited)
**Decision:** ADR-032 — internal operator access is granted as capabilities on the three platform roles
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Every operations endpoint decides access by inlining a role list, and there are only three internal
roles. Audit search, the outbox dead letter, privacy, trust-and-safety and feature flags all reuse
`canSearchAuditEvents`, so whoever can read the audit record can also release a legal hold and
switch off a safety flag for every college. Organisations, verification, users and invitations use a
second literal list. Nothing in between is expressible: a support person cannot be given account
lookup alone.

`membership_capabilities` (0031) already stores granted, reason-coded, revocable permissions narrower
than a role — for one capability, `INSTITUTION_ANALYTICS`. This design extends it to the internal
vocabulary of the operations plan (Appendix 1 §6.2) rather than adding roles or tables.

## Decision: extend `membership_capabilities`, do not add roles or a second table

**Chosen.** Widen the capability CHECK, add a second trigger with the internal grant rules, add a
revocation reason column, and guard role changes. Baselines live in code, grants live in the table.

**Rejected: 23 new roles in the `0001` membership trigger.** Each role needs a workspace mapping, a
portal and trigger scope rules; roles are exclusive per membership row while duties overlap; and every
endpoint would go on inlining role lists. ADR-018 rejected the same move for institution roles.

**Rejected: a separate `internal_capabilities` table.** Two grant tables mean two revocation paths,
two role-change hooks and two places for the access review (OPS-15) to look, for no difference in
shape.

**Rejected: baselines stored as rows.** Seeding a baseline row per platform membership would make
every new staff member depend on a seeding step, and a missed seed is a silent loss of access. A
baseline is a property of the role and belongs next to the predicate that reads it, as data in
`packages/authorization`, where a change to it is a reviewed code change.

## Vocabulary (25)

`INSTITUTION_ANALYTICS` (0031) is unchanged. The CHECK gains:

| Capability | Allows | High-risk |
| --- | --- | --- |
| `OPS_ORG_MANAGE` | organisations: list, create, edit, invite first admin, onboarding status; users and invitations lookup | |
| `OPS_VERIFY` | verification transitions | |
| `OPS_FLAGS_MANAGE` | list and change feature flags | |
| `OPS_JOBS_REPLAY` | failed-event list, replay, backlog supersede | |
| `SUPPORT_CASES` | support cases (OPS-05) | |
| `SUPPORT_ACCOUNT_LOOKUP` | account lookup and user timeline (OPS-05) | |
| `TRUST_SAFETY_INVESTIGATE` | case list, detail, open, transition | |
| `TRUST_SAFETY_ENFORCE` | enforcement actions on a case | Yes |
| `PRIVACY_REQUESTS` | privacy request queue and hold list | |
| `PRIVACY_HOLDS` | place and release legal holds | Yes |
| `SECURITY_AUDIT_SEARCH` | audit and security event search | |
| `SECURITY_ACCESS_REVIEW` | access reviews (OPS-15) | |
| `INCIDENT_MANAGE` | incident register (OPS-16) | |
| `CATALOGUE_MANAGE` | job-role catalogue (OPS-08) | |
| `CONTENT_EDIT` | draft content (OPS-09) | |
| `CONTENT_REVIEW` | review drafts (OPS-09) | |
| `CONTENT_PUBLISH` | publish reviewed content | Yes |
| `CONTENT_REVIEW_EXTERNAL` | faculty review of assigned global drafts (OPS-10) | |
| `AI_OPS_VIEW` | AI usage, outcomes, cost (OPS-12) | |
| `AI_OPS_CONFIGURE` | AI caps, policies, evaluation records | Yes |
| `ANALYTICS_VIEW` | aggregate analytics (OPS-11/14) | |
| `ACCOUNT_MANAGE` | college account fields (OPS-14) | |
| `COMMS_TEMPLATES` | status notices (OPS-16) | |
| `CAPABILITY_ADMIN` | grant and revoke capabilities | Yes |
| `APPROVE_HIGH_RISK` | approve dual-control requests (OPS-02) | Yes |

## Baseline bundles (held as data in `packages/authorization`)

A baseline is derived from **what the code allows today** for every capability that already guards an
endpoint, and from §6.2's baseline column for capabilities whose endpoints do not exist yet (granting
those changes no behaviour until a later goal builds the endpoint — and that goal may tighten them).

| Capability | SUPER_ADMIN | OPERATIONS_ADMIN | SECURITY_ADMIN | Source |
| --- | :-: | :-: | :-: | --- |
| `OPS_ORG_MANAGE` | ✔ | ✔ | | code: `operations-institution-onboarding.controller.ts` `platformMutationRoles` |
| `OPS_VERIFY` | ✔ | ✔ | | code: same list |
| `OPS_FLAGS_MANAGE` | ✔ | ✔ | ✔ **(D1)** | code: `platform-controls.controller.ts` → `canSearchAuditEvents` |
| `OPS_JOBS_REPLAY` | ✔ | ✔ | ✔ | code: `operations-outbox.controller.ts` → `canSearchAuditEvents` |
| `SUPPORT_CASES` | ✔ | ✔ | | §6.2 (no endpoint yet) |
| `SUPPORT_ACCOUNT_LOOKUP` | ✔ | ✔ | ✔ | §6.2 (no endpoint yet — see D3) |
| `TRUST_SAFETY_INVESTIGATE` | ✔ | ✔ | ✔ | code: `trust-safety.controller.ts` → `canSearchAuditEvents` |
| `TRUST_SAFETY_ENFORCE` | ✔ | ✔ | ✔ | code: same |
| `PRIVACY_REQUESTS` | ✔ | ✔ | ✔ | code: `operations-privacy.controller.ts` → `canSearchAuditEvents` |
| `PRIVACY_HOLDS` | ✔ | ✔ | ✔ | code: same |
| `SECURITY_AUDIT_SEARCH` | ✔ | ✔ | ✔ | code: `operations-audit.controller.ts` → `canSearchAuditEvents` |
| `SECURITY_ACCESS_REVIEW` | ✔ | | ✔ | §6.2 |
| `INCIDENT_MANAGE` | ✔ | | ✔ | §6.2 |
| `AI_OPS_VIEW` | ✔ | ✔ | ✔ | §6.2 |
| `ANALYTICS_VIEW` | ✔ | ✔ | | §6.2 |
| `ACCOUNT_MANAGE` | ✔ | ✔ | | §6.2 |
| `COMMS_TEMPLATES` | ✔ | ✔ | | §6.2 |
| `CAPABILITY_ADMIN` | ✔ | | | §6.2 |
| `APPROVE_HIGH_RISK` | ✔ | | | §6.2 |
| `CATALOGUE_MANAGE`, `CONTENT_EDIT`, `CONTENT_REVIEW`, `CONTENT_PUBLISH`, `AI_OPS_CONFIGURE` | break-glass **(D2)** | grant | grant | §6.2 "grant explicitly" |
| `CONTENT_REVIEW_EXTERNAL` | — | — | — | institution faculty only |

`PLATFORM_SUPER_ADMIN` therefore holds every capability except `CONTENT_REVIEW_EXTERNAL` (which is a
faculty permission; the super admin's `CONTENT_REVIEW` covers the same work), 19 by baseline and 5 as
break-glass. `resolveInternalCapability` returns `BASELINE`, `GRANT` or `BREAK_GLASS` so that the
endpoints OPS-08/09/12 add can audit `break_glass: true`. No endpoint that exists today is reached
by break-glass.

### Divergences from §6.2 preserved — tighten later, each by its own ADR

- **D1.** `SECURITY_ADMIN` holds `OPS_FLAGS_MANAGE` (§6.2: `OPERATIONS_ADMIN` only). Today it can list
  and toggle every feature flag.
- **D2.** §6.2 says the super admin "keeps every capability"; five of them are recorded as
  break-glass rather than baseline so their eventual use is audited as such (§5.1). Access is the same.
- **D3.** Users and invitations lookup (`/operations/users-access`, `/operations/invitations`) stays on
  `OPS_ORG_MANAGE`, not `SUPPORT_ACCOUNT_LOOKUP`, because moving it would give `SECURITY_ADMIN` a
  read it does not have today. OPS-05 decides when account lookup moves.
- **D4.** Reads share the write capability of their module: flag list (`OPS_FLAGS_MANAGE`),
  failed-event list (`OPS_JOBS_REPLAY`), hold list (`PRIVACY_REQUESTS`), trust case list and detail
  (`TRUST_SAFETY_INVESTIGATE`). §6.2 names no read-only capability for these.
- **D5.** `TRUST_SAFETY_ENFORCE` and `PRIVACY_HOLDS` are high-risk yet baseline for two roles — §6.2
  says so explicitly as "today's behaviour".
- **D6.** Organisation suspension, hold release, backlog supersede and flag changes are not yet
  dual-controlled (OPS-02).

## Grant rules

| Rule | Where enforced |
| --- | --- |
| Capability is in the vocabulary | CHECK `membership_capability_ck` (same name as 0031, redefined) |
| Internal capability → membership in the `PLATFORM` organisation with a platform role | trigger `membership_capability_internal_guard` |
| `CONTENT_REVIEW_EXTERNAL` → `INSTITUTION` organisation, `FACULTY_LECTURER` or `DEPARTMENT_HEAD` | same trigger |
| Grantor is not the grantee (internal capabilities) | same trigger + pure function + API |
| A grant row is immutable except for its revocation, and a revocation is never undone | same trigger |
| `INSTITUTION_ANALYTICS` → `INSTITUTION_ADMIN`/`DEPARTMENT_HEAD` | 0031's trigger, unchanged |
| Actor holds `CAPABILITY_ADMIN` | pure function, API |
| High-risk grant → actor is an ACTIVE `PLATFORM_SUPER_ADMIN` (until OPS-02) | pure function, API |
| Target membership is ACTIVE; capability not already held | pure function, API |
| Reason code from the module's fixed list | API; pattern by CHECK |

The new trigger fires before 0031's (`internal_guard` sorts before `role_guard`) and returns early for
`INSTITUTION_ANALYTICS`, so 0031's messages and behaviour are unchanged.

## Columns added

| Column | Notes |
| --- | --- |
| `revoked_reason_code` | text NULL; when set, `revoked_at` must be set and it must match `^[A-Z0-9_:-]{3,64}$`. Old revocations (and 0031's institution path, which carries no reason) stay NULL. |

## Revocation on role change

A trigger on the grant table cannot see a later change to the membership, so a role change would
leave a grant the rules no longer permit. Two parts:

- `changeMembershipRole` (persistence) revokes every live grant with reason `ROLE_CHANGED`, updates the
  role and writes the audit row, in one transaction.
- trigger `organization_membership_role_change_guard` (`BEFORE UPDATE OF role`) refuses a role change
  while an **internal** grant is live, so a second writer cannot skip the revocation. It is scoped to
  internal capabilities so 0031's institution behaviour is untouched.

## Replay safety

The migrator replays every file on every run. 0031 uses `CREATE TABLE IF NOT EXISTS`, so replaying it
does not restore the narrow CHECK; it does re-create its own trigger function, which only concerns
`INSTITUTION_ANALYTICS`. 0039 drops and re-adds its CHECKs by name, adds columns `IF NOT EXISTS`,
uses `CREATE OR REPLACE FUNCTION` and `DROP TRIGGER IF EXISTS`, and uses separate function names from
0031, so either order of replay leaves the same result. Verified by migrating twice.

## How this is consumed

- `effectiveInternalCapabilities(role, grants)` and `hasInternalCapability(context, capability)` are
  pure; the API loads live grants for the caller's ACTIVE memberships only when the baseline does not
  already answer.
- `GET /operations/staff` lists platform memberships with baseline, grants and effective set;
  `POST /operations/staff/:membershipId/capabilities` grants; `POST …/capabilities/:capability/revoke`
  revokes. All three require `CAPABILITY_ADMIN`.
- Audit actions: `operations.staff_capability.granted`, `operations.staff_capability.revoked`,
  `organization_membership.role_changed`. Outbox events: `organization_membership.capability_granted`
  and `organization_membership.capability_revoked` (registered, no consumer yet).

## Open points (decisions for Divakar)

1. Tighten D1 (`SECURITY_ADMIN` and feature flags)? Recommended: yes, in OPS-02's ADR, once high-risk
   flags are marked — Security needs the kill switch, not rollout control.
2. Should a revoke of a high-risk capability also need a second person? Recommended: no; removing
   authority reduces risk.
3. Keep the reason-code lists short (grant: 4, revoke: 5) and extend by code change? Recommended: yes.
