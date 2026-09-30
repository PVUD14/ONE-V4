# Growth Roles, Team Members and Staff Types — Table Design

**Status:** Adopted (GROWTH-01), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-30
**Migration:** `0091_growth_roles_and_team.sql` (new; `0001`, `0037` and `0039` are not edited)
**Parent design:** `growth-portal-design.md` §3 (roles, team membership, staff types) and §15 (security);
decision record ADR-040 and its "Decisions taken 2026-09-30" (D13, staff types)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

GROWTH-01 lets a growth person exist. That needs four schema changes, each of which touches something
a person's access or pay depends on:

1. the two growth login roles admitted by the membership and invitation scope triggers;
2. the two operator-side capabilities admitted by the capability vocabulary and its grant trigger;
3. `growth_team_members` — which team (college or employer partnerships) a growth person works in, and
   who they report to; a later goal decides lead ownership from it;
4. `growth_staff_types` — whether the person is an employee or a contractor (D13); payout batches and
   the payroll export will carry it (design §3.4, §10.9).

It also records one query fix that is not a schema change but must land before (1) can be used:
approval notices and job-health alerts go to every ACTIVE membership of the platform organisation.

## 1. Roles in the scope triggers

**Chosen.** `CREATE OR REPLACE` both trigger functions in 0091 with `GROWTH_EXECUTIVE` and
`GROWTH_MANAGER` added to the **platform branch** array — organisation kind `PLATFORM`, no institution,
unit or employer scope — and every other line repeated byte-for-byte from the latest definition
(`enforce_organization_membership_scope` from 0001; `enforce_invitation_scope` from 0037, which put the
student branch in front). No rule is relaxed: a growth role on an institution or employer organisation,
or carrying any unit scope, is refused exactly as a platform role is.

**Rejected: a separate `GROWTH` branch with its own rules.** The rules are identical to the platform
branch; a second branch is a second place for them to drift.

**Rejected: an organisation kind `GROWTH`.** ADR-040 "Rejected details": growth staff are AI8HT staff;
a separate organisation would drop them from the staff list and the OPS-15 access review.

## 2. Capabilities: vocabulary and grant rule

- `membership_capability_ck` is dropped and re-added under the same name with `GROWTH_ADMIN` and
  `GROWTH_FINANCE` appended — the 0039 pattern, so there is still exactly one vocabulary.
- `membership_capability_internal_allowed()` (0039) is redefined with one added rule: `GROWTH_ADMIN` and
  `GROWTH_FINANCE` may be granted only to an `OPERATIONS_ADMIN` membership of the platform organisation.
  The super admin holds both by baseline (code), so a grant row on one is meaningless; a security admin's
  job is access control, not sales administration. Everything else in the function is unchanged, so a
  grant to a growth membership is still refused by the existing "only a membership of the ONE platform
  organisation" branch, whose role list does not include the growth roles.
- The code mirror (`packages/authorization/src/internal-capabilities.ts`): growth roles have no baseline,
  `isInternalCapabilityGrantableToRole` refuses them every capability, and the two growth capabilities
  are grantable only to `OPERATIONS_ADMIN`.

**Decision taken for Divakar (recommended):** `GROWTH_FINANCE` is a **high-risk** capability (OPS-02):
granting it needs a second person's approval, because its holder records the college payments that
make commission payable. `GROWTH_ADMIN` is not: it moves no money.

## 3. `growth_team_members`

| Column | Rule |
|---|---|
| `id` | uuid primary key |
| `membership_id` | → `organization_memberships(id)`; must be an ACTIVE `GROWTH_EXECUTIVE` or `GROWTH_MANAGER` membership of the platform organisation at insert (trigger) |
| `team` | `COLLEGE_PARTNERSHIPS` or `EMPLOYER_PARTNERSHIPS` |
| `manager_membership_id` | NULL, or → an ACTIVE `GROWTH_MANAGER` membership of the platform organisation (trigger); never the member's own membership (CHECK) |
| `joined_at` | `now()` |
| `joined_by_user_id` | → `users(id)`; never the member themselves (trigger) |
| `reason_code` | `^[A-Z0-9_]{3,64}$`; the API allows `NEW_MEMBER`, `TEAM_CHANGE`, `MANAGER_CHANGE`, `CORRECTION` |
| `left_at`, `left_by_user_id`, `left_reason_code` | NULL while live; `left_at` and `left_reason_code` set together, once. `left_by_user_id` is NULL only when the database ended the row because the membership ended |

- One live row per membership and team (partial unique index `WHERE left_at IS NULL`). A person may be
  on both teams (two rows).
- **Append-only.** Nothing but the three `left_*` columns may change, and only from NULL (trigger).
  DELETE is refused. A change of manager is an end (`MANAGER_CHANGE`) plus a new row, so "who reported to
  whom on a date" is answerable.
- **A membership that ends ends its team rows** in the same statement (trigger on
  `organization_memberships`, reason `MEMBERSHIP_ENDED`), whichever path ended it: the Growth team
  screen or any later writer. A SUSPENDED membership keeps its rows — an OPS-15 access-review
  revocation suspends — because suspension is reversible, access stops at once anyway (memberships are
  read per request and only ACTIVE ones count), and the growth scope rules (GROWTH-02) will read ACTIVE
  memberships only.
- A growth membership's role cannot change while it has live team rows (trigger), so a row can never
  point at a membership that is no longer a growth role.

**Rejected: the manager must be on the same team.** A national head manages managers of both teams;
requiring team equality would force every head onto both teams for no gain.

## 4. `growth_staff_types` (D13)

| Column | Rule |
|---|---|
| `id` | uuid primary key |
| `membership_id` | → `organization_memberships(id)`; a `GROWTH_EXECUTIVE` or `GROWTH_MANAGER` membership of the platform organisation (trigger) |
| `staff_type` | `EMPLOYEE` or `CONTRACTOR` |
| `effective_from` | `now()` at insert |
| `set_by_user_id` | → `users(id)`: the `GROWTH_ADMIN` holder who set it (for the first row, the person who sent the invitation) |
| `reason_code` | `INITIAL_TYPE`, `ENGAGEMENT_CHANGED`, `CORRECTION` (CHECK) |
| `ended_at`, `ended_by_user_id`, `ended_reason_code` | NULL while live; set together, once (`ENGAGEMENT_CHANGED` or `CORRECTION`) |
| `created_at` | `now()` |

- One live row per membership (partial unique index). A type change ends the live row and inserts a new
  one in one transaction, each with its own `audit_events` row.
- Append-only exactly like team rows (trigger); DELETE refused.
- The type is not ended when the membership ends: it records how the person was engaged, which a final
  settlement (design O-5) still needs.
- **No tax column.** No TDS, GST, withholding or net figure exists on this table or anywhere in the
  growth schema; a spec asserts it over `information_schema`.

### How "a type is required when a growth person is invited" is enforced

A membership only exists once the invitation is accepted, so the type travels on the invitation:

- `invitations.growth_staff_type` (new, nullable) with CHECK `EMPLOYEE | CONTRACTOR`, and
  `invitation_growth_staff_type_ck`: **a staff invitation for a growth role must carry a type, and no
  other invitation may**. Existing rows have no growth role and no type, so they satisfy it.
- The one acceptance path (`acceptInvitation`, `packages/persistence/src/identity-authentication.ts`)
  writes the first `growth_staff_types` row (`INITIAL_TYPE`, set by the inviter) in the same transaction
  that creates the membership, with an `audit_events` row.
- An operator can set a type for a growth membership that has none (`INITIAL_TYPE`) — only possible for a
  membership created outside the invitation path — and change it later with `ENGAGEMENT_CHANGED` or
  `CORRECTION`.

**Rejected: a trigger on membership insert that looks up the accepted invitation.** It would work for
every writer, but it hides a write inside the security-critical acceptance transaction; an explicit
statement next to the membership insert is easier to review. The invitation CHECK is the hard rule.

**Rejected: two more login roles for the two types.** ADR-040 D13: the type changes nothing anyone may do.

## 5. Operator isolation (no schema change)

`raiseSoloNotice` (`packages/persistence/src/operation-approvals.ts`) and `queueAlertNotice`
(`packages/persistence/src/jobs-health.ts`) choose recipients as "every ACTIVE membership of the platform
organisation". Once a growth membership can exist that includes field staff, who must never receive
operator security notices or system alerts. Both queries gain `m.role IN (platformInternalRoles)`, taken
from `packages/authorization` so the list has one definition. Tests reproduce the leak first (a growth
membership would receive both) and prove the fix.

Other platform-wide queries were checked: the staff list (`platform-controls.ts`) should show growth
staff; support assignees are already filtered by `SUPPORT_CASES`; the OPS-14 account-owner options are
already restricted to the three internal roles; the OPS-15 snapshot should include growth memberships
(with an empty capability set), and does.

## 6. Events

`growth.team_member.joined`, `growth.team_member.left` and `growth.staff_type.set` are registered in
`packages/events/src/index.ts` (identifiers and enums only). The growth roles are added to the event
registry's role list so `organization_membership.ended` can name them (an OPS-15 revocation of a growth
membership emits it).

## Open points (decisions for Divakar)

- `GROWTH_FINANCE` as a high-risk capability (§2) — recommended and built.
- Team rows kept on suspension, ended on end (§3) — recommended and built.
