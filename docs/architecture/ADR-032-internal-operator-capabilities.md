# ADR-032 — Internal Operator Access Is Granted as Capabilities on the Three Platform Roles

**Status:** Accepted (OPS-01), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Decision date:** 2026-09-25
**Scope:** How AI8HT staff are given narrower or wider authority inside the Operations portal
**Builds on:** ADR-018 (a narrower permission is a capability, not a role); migration `0031`
**Design:** `docs/architecture/internal-capabilities-table-design.md`
**Migration:** `0039_internal_capabilities.sql`

## Context

ONE has exactly three internal roles — `PLATFORM_SUPER_ADMIN`, `OPERATIONS_ADMIN` and
`SECURITY_ADMIN` — and the membership trigger in `0001` refuses any other. Every operations endpoint
inlines one of two role lists:

- `canSearchAuditEvents` (all three roles) guards audit search, the outbox dead letter, privacy
  requests and holds, trust-and-safety and feature flags;
- a literal `['PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN']` guards organisations, verification, users
  and invitations.

So there is no separation of duties. Anyone who can search the audit record can also switch a
feature off for every college, release a legal hold and supersede a backlog of failed events, and
there is no way to let a support person look up an account without also handing them all of that.
`INTERNAL_ROLE_PRIVILEGE_MATRIX_V1.md` designed 26 internal bundles for exactly this; the operations
plan (Appendix 1 §6.2) reduces them to 23 named capabilities.

## Decision

**Internal authority is expressed as named capabilities. Each of the three platform roles carries a
baseline bundle of capabilities, held as data in `packages/authorization`; anything beyond the
baseline is an explicit, reason-coded, audited, revocable grant stored in the existing
`membership_capabilities` table.** Controllers ask one question — *does this caller hold capability
X?* — through a pure function, and never name a role.

1. **Vocabulary.** The 23 capabilities of §6.2 (`OPS_ORG_MANAGE` … `APPROVE_HIGH_RISK`), extended
   into `membership_capability_ck` by a new migration. `INSTITUTION_ANALYTICS` (0031) stays and
   keeps its own rules.
2. **Baselines preserve today's behaviour exactly.** Where §6.2's baseline column and the code
   disagree, the code wins, as §6.2's own transition rule requires. Every such case is listed in the
   design document as a *tighten-later* item; tightening one is a future ADR, not a side effect.
3. **Only ACTIVE memberships count.** A pending, suspended or ended membership has no capability,
   baseline or granted.
4. **Grantable only inside the ONE platform organisation**, to the three platform roles — enforced
   by a database trigger, so a second writer cannot get it wrong. The single exception is
   `CONTENT_REVIEW_EXTERNAL`, grantable only to institution `FACULTY_LECTURER` and `DEPARTMENT_HEAD`
   memberships (OPS-10 builds the path; the staff screen does not grant it).
5. **`PLATFORM_SUPER_ADMIN` keeps every capability.** Its *baseline* is the union of what the other
   two roles hold plus `CAPABILITY_ADMIN` and `APPROVE_HIGH_RISK`; the remaining capabilities — the
   ones no role holds by default (content, catalogue, AI configuration) — it holds as break-glass,
   and `resolveInternalCapability` reports that source so the endpoints that later use them can audit
   `break_glass: true` (§5.1). No endpoint that exists today is reached by break-glass.
6. **Granting is itself a capability.** `CAPABILITY_ADMIN` (baseline: super admin only) is required
   to grant or revoke. Nobody may change capabilities on their own membership — refused by the API
   and, for grants, by the trigger. Until OPS-02 builds dual control, a grant of a high-risk
   capability (`APPROVE_HIGH_RISK`, `CAPABILITY_ADMIN`, `PRIVACY_HOLDS`, `TRUST_SAFETY_ENFORCE`,
   `CONTENT_PUBLISH`, `AI_OPS_CONFIGURE`) additionally requires the actor to be an ACTIVE
   `PLATFORM_SUPER_ADMIN`.
7. **Every grant and revoke carries a reason code** from a fixed list defined in code (matching
   `^[A-Z0-9_:-]{3,64}$`), an optional short note, and writes an `audit_events` row and an outbox
   event in the same transaction as the change.
8. **A role change revokes internal capabilities.** `changeMembershipRole` revokes every live grant
   in the same transaction as the role update, and a trigger refuses a role change that would leave
   an internal grant live — a grant is validated against the role it was written for, and a trigger
   on the grant table cannot see a later change to the membership.

## Rejected

### Twenty-three new login roles in the membership trigger

The obvious reading of the privilege matrix is to add `SUPPORT_AGENT`, `PRIVACY_ADMIN`,
`CONTENT_ADMIN` and the rest to the `0001` trigger. Rejected, for the same reason ADR-018 rejected
four new institution roles:

- A role is not one line. Each needs a `workspaceForMembership` mapping, a portal, a navigation
  config and the scope rules in the trigger; a portal per bundle multiplies screens for a team that
  is, today, one person.
- Roles are exclusive per membership row; authority is not. A person who covers support *and*
  privacy for a week would need two memberships and two portals, and the audit record would split
  across them.
- Every endpoint would go back to inlining a role list — the pattern this ADR exists to remove — and
  every new role would mean editing every list.
- It would widen the membership trigger, which several security tests pin down, for no capability a
  grant cannot express.

### A boolean or JSON column of capabilities on `organization_memberships`

Rejected in 0031's design and still wrong: a grant needs a grantor, a time, a reason and a
revocation, and "who could release a legal hold in March" is a question a column cannot answer.

### A new `internal_capabilities` table beside `membership_capabilities`

Two grant tables means two revocation paths, two role-change hooks and two places for an access
review (OPS-15) to look. `membership_capabilities` already has the right shape — reason code,
grantor, revocation pair, one live grant per capability — and was built to be extended by migration.

### Deriving baselines from the §6.2 table as written

It would silently remove authority people have today: `SECURITY_ADMIN` would lose feature flags, and
the super admin would lose nothing but be reported as break-glass for routine work. §6.2's transition
rule forbids that, and a regression in who can switch off a safety control should never arrive as a
by-product of a refactor.

### Checking grants only in the controller

The grant rules (platform organisation only, no self-grant) are the substance of this decision, so
they sit in a trigger as well as in the pure function, exactly as 0031 did for ADR-018.

## Consequences

- Every retrofitted endpoint (organisations, verification, flags, audit, outbox, privacy,
  trust-and-safety) behaves identically for the three roles, proven by the pre-existing integration
  tests running unchanged plus new allow/deny tests.
- A baseline check needs no database read; only a caller whose baseline lacks the capability costs
  one indexed query for live grants.
- The learner-content and career-readiness operations controllers are not retrofitted in OPS-01
  (outside the goal's list); they keep their role lists until their own goals (OPS-08/09) move them.
- High-risk grants route through OPS-02's approvals once it exists; the super-admin-only restriction
  is the interim safeguard, not the design.
