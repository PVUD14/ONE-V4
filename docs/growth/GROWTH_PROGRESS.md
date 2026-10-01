# Growth portal progress

> Goal reports for the Growth portal (docs/architecture/growth-portal-design.md §18, ADR-040), newest
> last, in the program's Section 0.6 format. Created by GROWTH-01.

Base branch: **feat/plan-phases-0-to-2** on `onev4` (PVUD14/ONE-V4, private). Goal branches are cut from
the base and merged back into it by the coordinator; main and production are released by Divakar only.

## GROWTH-01 — Growth roles, portal shell and operator isolation — 2026-09-30
**Result:** Complete — a growth person can exist, sign in to their own Growth workspace on web and
Android, and is proven unable to reach any Operations route, notice or capability.
**Branch / PR:** feat/growth-foundation → feat/plan-phases-0-to-2 (pushed; not merged — the coordinator merges)
**Commits:** 2d5bd4d (design) · 098615f, a21c9aa (tests) · c291240 (implementation) · this report
**Files created:**
- `docs/architecture/growth-team-and-staff-types-table-design.md` (written and committed before the migration)
- `packages/persistence/drizzle/0091_growth_roles_and_team.sql`
- `packages/authorization/src/growth-roles.ts`, `growth-roles.test.ts`
- `apps/api/src/http/operations-growth-team.controller.ts` (Operations → Settings → Growth team)
- `apps/api/src/http/growth-workspace.controller.ts` (`GET /api/v1/growth/me`)
- `apps/api/src/http/growth-foundation.integration.spec.ts`
- `apps/web/src/api/growth.ts`, `rolePortal/growth.tsx`, `rolePortal/growthTeam.tsx`, `growthPortal.test.tsx`,
  `rolePortal/growthTeam.test.tsx`
- `apps/android/app/src/main/java/pro/ai8ht/one/Growth.kt`
- `docs/growth/GROWTH_PROGRESS.md` (this file)
**Files modified:** `packages/authorization/src/internal-capabilities.ts`, `index.ts`;
`packages/persistence/src/operation-approvals.ts`, `jobs-health.ts`, `identity-authentication.ts`;
`packages/events/src/index.ts`; `apps/api/src/runtime-auth.ts`, `http/api-security.module.ts`,
`http/operations-staff.controller.ts`; `apps/web/src/App.tsx`, `rolePortalConfig.ts`, `rolePortalPages.tsx`,
`rolePortal/staffCapabilities.tsx`, `api.ts`, `api/operations.ts`; Android `Api.kt`, `StaffDashboards.kt`,
`MainActivity.kt`; tests `operations-approvals.integration.spec.ts`, `operations-capabilities.integration.spec.ts`,
`staff-pool-config.test.ts`, `packages/persistence/test/jobs-health.integration.test.ts`.
**Migrations added:** `0091_growth_roles_and_team.sql` (the number assigned). References only tables up to 0085.
Written idempotently and replay-checked: applied twice through `db:migrate`, and the file re-run by hand on
a migrated database without error.
**Design docs / ADRs:** `growth-team-and-staff-types-table-design.md` (new); parent design and ADR-040 unchanged.

**What was built**
1. *Operator isolation first.* `raiseSoloNotice` (approval notices) and `queueAlertNotice` (job-health
   alerts) chose "every ACTIVE platform membership" as recipients; both now also require
   `m.role IN (platformInternalRoles)`. Tests reproduce the leak with growth memberships in the platform
   organisation (they would otherwise receive both) and prove the fix; growth memberships also do not
   count as approvers, so the solo safeguard is unaffected.
2. *Migration 0091.* Both scope trigger functions redefined from their latest versions (0001, 0037) with
   the two growth roles added to the platform array and nothing else changed; `GROWTH_ADMIN` and
   `GROWTH_FINANCE` appended to `membership_capability_ck`; `membership_capability_internal_allowed()`
   redefined from 0039 with one added rule (growth capabilities only on an `OPERATIONS_ADMIN` platform
   membership); `invitations.growth_staff_type` with a CHECK that a growth invitation must carry a type and
   no other may; `growth_team_members` and `growth_staff_types`, both append-only (trigger), DELETE refused,
   one live row (partial unique index), self-administration refused; a membership that ends ends its team
   rows in the same statement; a growth membership cannot change role while on a team.
3. *Authorization.* `growthRoles` (no baseline; every grant refused, so no `requireOperations` route can
   admit them); `GROWTH_ADMIN`/`GROWTH_FINANCE` baseline for the super admin, grantable to
   `OPERATIONS_ADMIN` only; `platformStaffOnlyRoles` adds the growth roles for the staff pool policy
   (`runtime-auth.ts`); `refuseGrowthTeamChange`, `growthWorkspaceRole`, reason-code lists.
4. *Operations → Settings → Growth team* (`GROWTH_ADMIN`; a section, no navigation item): list growth people
   with type, teams and manager; invite with role and a **required** staff type; revoke a pending
   invitation; set a team and manager (a change ends the old row); remove from a team; set or change the
   staff type with a reason (end plus new row, both audited); end a membership. Every write is one
   transaction with audit rows and outbox events (`growth.team_member.joined|left`,
   `growth.staff_type.set`, plus the existing invitation and membership events). The screen renders nothing
   for an operator without `GROWTH_ADMIN`. The staff-capabilities screen no longer offers a grant the server
   would refuse (`grantableToRoles`).
5. *Web Growth portal* at `/growth`: its own portal choice and protected root, the approved navigation (Home,
   Leads, Field, Territory, Targets, Commission, Team — Team for managers only), the `BrandWordmark` in the
   sidebar, a pilot-composition Home (greeting hero, four stat tiles, target ring, teams card, rail) fed only
   by `GET /api/v1/growth/me`, NA in every figure slot, and the existing empty state on every other page
   saying plainly what is not built yet ("no amount is shown" on Commission). Kept out of the demo registry:
   there is no preview data for growth. A growth person is offered no Operations workspace.
6. *Android* (field staff work on phones): `WorkspaceKind.GROWTH` in `classifyWorkspaces` (manager preferred
   when both), a Growth choice in the workspace chooser, and `GrowthScaffold`: the brand band with the silver
   wordmark, role and staff-type chips, four NA stat cells, "Your teams" from `/api/v1/growth/me`, a plain
   "Not built yet" card, and a More tab (switch workspace, sign out). Compiled with the Android Studio JBR.

**Tests added**
- `packages/authorization/src/growth-roles.test.ts` (17): growth roles hold nothing and are refused every
  grant; growth capabilities are super-admin baseline, grantable to operations admins only, `GROWTH_FINANCE`
  high-risk; staff-only roles; workspace role; team-change refusals.
- `packages/persistence/test/jobs-health.integration.test.ts`: "never queues an ops-failure email to a growth
  membership of the platform organisation".
- `apps/api/src/http/operations-approvals.integration.spec.ts` (solo safeguard): growth memberships neither
  count as approvers nor receive the solo notice.
- `apps/api/src/http/growth-foundation.integration.spec.ts` (19): the operations routes enumerated from the
  controllers' own Nest metadata (every `*.controller.ts`, including those AppModule registers) and **403 for a
  growth executive and a growth manager on every one**; scope trigger; capability refusals; the invitation
  CHECK; team and staff-type append-only rules; membership end ends team rows; **no tax column** in any growth
  table (information_schema); OPS-15 campaign lists the growth membership with an **empty capability set** and
  the operator's `GROWTH_ADMIN` grant as its own item, and a revocation suspends it; the Growth team routes
  (access, invitation without type refused, acceptance writes the first type, team/manager change, type change
  with both audit rows, end membership, revoke); `/api/v1/growth/me`.
- `apps/web/src/growthPortal.test.tsx` (5) and `apps/web/src/rolePortal/growthTeam.test.tsx` (6).
- Pins updated deliberately: super-admin baseline 19 → 21; staff-pool staff-only roles gain the growth roles.

**Validation** (fresh database `one_growth01` on the local Docker Postgres, only `DATABASE_URL` exported):
- `corepack pnpm db:migrate` twice — pass (76 applied, then 0 applied / 76 already applied); 0091 also re-run
  by hand on the migrated database — pass.
- `corepack pnpm typecheck` — pass. `corepack pnpm build` — pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — 3 561 of 3 563 tests passed across 18
  test-bearing packages (api 1 253, web 892/893, persistence 405, authorization 381, others). Two failures,
  both environmental and both passing when re-run alone:
  - web `App.test.tsx` › "resolves every visible navigation item for every new role without disabled nav" —
    a 20 s timeout under full-suite load (it renders every demo portal; the Growth portal is not among
    them). Re-run alone: 97/97 passed.
  - api `institution-accreditation-exports.integration.spec.ts` — teardown-only "out of shared memory" on
    DROP SCHEMA; all its tests had passed. Re-run alone: 11/11 passed.
- Android: `./gradlew --no-daemon -q :app:compileDebugKotlin` with the Android Studio JBR — pass, no errors.
- CI parity: optional-chain policy grep — nothing found; private-key and conflict-marker greps — nothing found;
  `corepack pnpm audit --prod --audit-level=high` — exit 0 (2 moderate, pre-existing).

**Acceptance criteria**
- [x] A growth executive gets 403 on every `/api/v1/operations/*` route (one spec enumerates them) — also a
  growth manager.
- [x] A growth membership never receives an approval or job-health notification.
- [x] An OPS-15 campaign opened after a growth person joins lists their membership with an empty capability set.
- [x] A growth invitation without a staff type is refused (API 400 `GROWTH_STAFF_TYPE_REQUIRED` and the
  database CHECK); a type change ends the old row and writes a new one, both audited; no tax field exists
  anywhere (asserted over information_schema).
- [x] The Growth portal shows the wordmark, the approved navigation and honest empty states; Android compiles
  and shows the Growth home.

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- `GROWTH_FINANCE` is a high-risk capability: granting it needs a second person's approval (OPS-02), because its
  holder records the payments that make commission payable. `GROWTH_ADMIN` is not.
- Growth capabilities are grantable to `OPERATIONS_ADMIN` only (not `SECURITY_ADMIN`); the super admin holds both
  by baseline.
- Team rows end when a membership ends and are kept through a suspension (an OPS-15 revocation suspends); the
  staff type is kept when a membership ends (a final settlement needs it).
- A manager need not be on the same team as the people they manage (a national head manages both teams).
- The growth invitation is refused for an address that already has a membership in that role in any state, and
  for the inviting operator's own address.
- The Growth portal renders no assistant widget: the assistant has no growth persona and a student answer would
  mislead field staff.

**Limitations / not done**
- Nothing beyond the shell: leads, field work, territory, targets, commission, payments and payouts are later
  goals (GROWTH-02 onward). Every such page says so.
- Growth invitations have no resend (revoke and invite again); a reinstatement of an ended growth membership is
  not built.
- Email delivery follows the staff-invitation pattern; production email is hard gate HG-7.
- The Android Growth home is read-only; the workspace chooser and home were compiled, not run on a device.

**Risks / follow-ups**
- Other open branches that redefine `membership_capability_ck`, `membership_capability_internal_allowed()` or the
  two scope trigger functions after 0085 must carry the growth additions forward (the latest definition wins).
- `api-security.module.ts`'s controller list is a merge hotspot; the two new controllers are appended at the end.
- GROWTH-16 should add a UAT step for an access review with growth staff in it (design §15).

**Next goal:** GROWTH-02 — Territories and regions.

## GROWTH-02 — Territories and regions — 2026-10-01
**Result:** Complete — India is modelled as state → district, operations draws regions and assigns
people to them, and one scope rule decides which region (and later which leads) each growth person sees.
**Branch / PR:** feat/growth-territories → feat/plan-phases-0-to-2 (pushed; not merged — the coordinator merges)
**Commits:** 28d1c61 (design) · 09cc04f, 2d2827d, 50690e0 (tests) · da65940, 2b264b4 (implementation) · this report
**Files created:**
- `docs/architecture/growth-territories-table-design.md` (written and committed before the migration)
- `packages/persistence/drizzle/0099_growth_territories.sql`
- `packages/authorization/src/growth-scope.ts`, `growth-scope.test.ts`
- `packages/persistence/src/growth-territories.ts`, `packages/persistence/test/growth-territories.test.ts`
- `apps/api/src/http/growth-http.ts` (shared growth request helpers), `operations-growth-territories.controller.ts`,
  `growth-territories.integration.spec.ts`
- `apps/web/src/rolePortal/growthSetup.tsx`, `growthSetup.test.tsx`
**Files modified:** `packages/authorization/src/index.ts`; `packages/events/src/index.ts` (seven events);
`apps/api/src/http/growth-workspace.controller.ts` (`GET /api/v1/growth/territory`), `api-security.module.ts`;
`apps/web/src/api/growth.ts`, `rolePortal/growth.tsx` (Territory page), `rolePortalPages.tsx` (Settings section),
`growthPortal.test.tsx`; Android `Api.kt`, `Growth.kt`.
**Migrations added:** `0099_growth_territories.sql` (the number assigned). No earlier migration edited and no earlier
function redefined (the membership triggers are new functions beside 0091's), so no capability CHECK, grant trigger or
scope trigger is touched.

**What was built**
1. *Schema (0099).* `growth_states` seeded with the 36 ISO 3166-2:IN subdivisions (28 states, 8 union territories) as
   amended to 2023-11-23 (`IN-OD`, `IN-CG`, `IN-TS`, `IN-UK`), source cited in the migration; never deleted.
   `growth_districts` keyed by LGD code, **not seeded**, filled only by the audited import; never deleted, never moves
   state, renamed only by an import. `growth_district_imports` (append-only log). `growth_regions` (live name unique
   case-insensitively; retired once, only when no live area or assignment remains). `growth_region_areas` (append-only,
   removal once). `growth_territory_assignments` (EXECUTIVE or MANAGER matching the membership role; never self-assigned;
   ended by the database with `MEMBERSHIP_ENDED` when the membership ends; a role change is refused while one is live).
2. *The area rules in the database.* Two partial unique indexes (one live region per whole state, one per district) and
   a trigger that refuses a whole-state and a district area of the same state living apart, after taking a transaction
   advisory lock on the state so a concurrent pair cannot both pass.
3. *`growthScopeFor`* (`packages/authorization/src/growth-scope.ts`), the single rule: executive — own leads plus unowned
   leads in their regions; manager — every lead in their regions plus their reports' and their own; `GROWTH_ADMIN` — all;
   anyone else or a suspended person — none. Its inputs are loaded from today's rows (`loadGrowthScope`) and its SQL form
   (`growthScopePredicate`) is what GROWTH-03 composes every lead read from.
4. *District import.* Preview (row-level report, digest, nothing written) then commit of exactly that preview, all rows
   or none, under a table lock, with an import row, an audit row listing every rename old → new, and an outbox event.
   The LGD download is accepted as it is (headers and state names matched loosely; a state that matches nothing is a row
   error, never a guess).
5. *Operations → Settings → Growth set-up* (`GROWTH_ADMIN`; a section of the existing Settings page, no navigation
   item): stat tiles, the import, regions (create, retire), areas (state or district, remove), assignments (assign, end),
   every change with a reason code.
6. *Growth → Territory* (web, approved navigation) and *Android "My territory"* (a read-only tab in the Growth app): the
   regions worked today, their areas, and the people (a manager sees everyone assigned; an executive sees the region's
   managers). Unowned leads read NA until GROWTH-03.

**Tests added**
- `packages/authorization/src/growth-scope.test.ts` (27): the vocabulary pinned to the migration's seed (36, 28 + 8, the
  2023 codes in, retired codes out); region names; `GROWTH_ADMIN` admission; `regionsCoveringArea` for district,
  state-only and no area; the three area refusals; `growthScopeFor` for every role and membership state, ended
  assignments, mismatched assignment roles, reporting lines and a person holding both roles; visibility, case by case.
- `packages/persistence/test/growth-territories.test.ts` (4): the LGD file as downloaded (BOM, quoted names, historic
  state names), row errors, file-level refusals.
- `apps/api/src/http/growth-territories.integration.spec.ts` (17): 403 for growth staff, an operations admin without the
  capability and a security admin; 36 states, undeletable; import preview writes nothing, an invalid file is refused
  whole, a stale digest is 409, renames audited, no district moves state or is deleted; regions; **one area in one live
  region (API and database), whole state vs district in different regions refused either way (API and database), a
  concurrent race leaves exactly one region**, redundant areas refused; **every assignment change audited with its
  reason**, self-assignment refused (API and database), mismatched and inactive people refused, membership end ends
  assignments; **visibility follows today's assignment** (the read empties at once when the assignment ends; a suspended
  person gets 403) and the SQL predicate agrees row for row with the pure function.
- `apps/web/src/rolePortal/growthSetup.test.tsx` (4) and two new cases in `apps/web/src/growthPortal.test.tsx`.
- `growthPortal.test.tsx`'s GROWTH-01 cases were updated deliberately: Territory is no longer "not built yet".

**Acceptance criteria**
- [x] One area in at most one live region — partial unique indexes (state, district), refused by the API with
  `GROWTH_AREA_TAKEN` and by the database.
- [x] A whole-state and a district area of the same state cannot be in different regions — trigger with an advisory lock,
  API `GROWTH_AREA_CONFLICT`, both directions, and a concurrent race.
- [x] Visibility follows today's assignment — `growthScopeFor` reads live rows of ACTIVE memberships only; the Territory
  read and the SQL predicate change the moment an assignment ends.
- [x] Every assignment change is audited with its reason — `growth.territory_assignment.started|ended` audit rows and
  outbox events carry the reason, which is also on the row; the database's own end is `MEMBERSHIP_ENDED`.
- [x] Built per §18: states seeded with source, districts by audited dry-run import, `growth-scope.ts` with exhaustive
  tests, Operations → Settings "Growth set-up", Growth → Territory, Android "My territory".

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- A whole-state and a district area of the same state are refused in the *same* region too (redundant).
- A lead with a state but no district falls only in a region covering the whole state.
- Districts are never deleted by an import; renames are allowed and audited.
- A region in use cannot be retired; a rename is retire plus create (rates and targets will key on the id).
- Assignments start the day they are made; no future-dated assignments.

**Limitations / not done**
- No lead exists yet, so the unowned-lead count reads NA (GROWTH-03 fills it).
- The LGD list itself is not shipped: operations must download and import it. Until then regions can cover whole states.
- The Android tab was compiled, not run on a device.

**Validation** (`E:/one-wt/logs/validate.sh` on a fresh database `one_growth02`, only `DATABASE_URL` exported, after
rebasing on `da353ad`):
- `corepack pnpm db:migrate` twice — pass (86 applied, then 0 applied / 86 already applied); 0099 also re-run by hand on
  a migrated database — pass.
- `corepack pnpm typecheck` — pass. `corepack pnpm build` — pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — 3 911 of 3 912 passed (api 1 378, web 963/964,
  persistence 464, authorization 450, others). The one failure is the known environmental timeout: web `App.test.tsx` ›
  "resolves every visible navigation item for every new role without disabled nav" (20 s under full-suite load). Re-run
  alone: 97/97 passed.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR) — pass.
- CI parity: optional-chain, private-key and conflict-marker greps — clean; `corepack pnpm audit --prod --audit-level=high` — exit 0.

**Next goal:** GROWTH-03 — Lead register, contacts and the contact notice.

## GROWTH-03 — Lead register, contacts and the contact notice — 2026-10-01
**Result:** Complete — growth staff keep one shared register of the colleges and employers they work, and the
personal data of the people in it (who are not ONE users) has a stated purpose, a required basis, a recorded notice,
a 24-month retention sweep, an access answer and an erasure path, each enforced by the database where it can be.
**Branch / PR:** feat/growth-leads (cut from feat/growth-territories) → feat/plan-phases-0-to-2 (pushed; not merged)
**Commits:** f489f4d (design) · 00ef9d8, 73041aa (tests) · ffa2e51, 437a423, 21ee113 (implementation) · this report
**Files created:**
- `docs/architecture/growth-leads-table-design.md` (written and committed before the migration)
- `docs/legal/growth-lead-contact-notice-DRAFT-for-legal-review.md` (DRAFT throughout; publishing is HG-6)
- `packages/persistence/drizzle/0100_growth_leads.sql`
- `packages/authorization/src/growth-leads.ts`, `growth-leads.test.ts`
- `packages/persistence/src/growth-leads.ts` (retention sweep, privacy lookup and erasure)
- `apps/api/src/http/growth-leads.controller.ts`, `growth-leads-service.ts`, `growth-leads-input.ts`,
  `operations-growth-leads.controller.ts` (growth admin + privacy console), `growth-leads.integration.spec.ts`
- `apps/web/src/rolePortal/growthLeads.tsx`, `growthLeadsAdmin.tsx`, `growthLeads.test.tsx`
- `apps/android/app/src/main/java/pro/ai8ht/one/GrowthLeads.kt`
**Files modified:** `packages/authorization/src/index.ts`; `packages/events/src/index.ts` (six events);
`apps/api/src/http/api-security.module.ts`, `growth-workspace.controller.ts` (`openLeads` on `/me`, `unownedLeads` per
region on `/territory`), `privacy-export-sections.ts` (`growthWork`), `apps/api/src/run-privacy-worker.ts` (retention
sweep); `docs/architecture/privacy-export-coverage.md` (growth rows); `apps/web/src/api/growth.ts`,
`rolePortal/growth.tsx`, `rolePortalPages.tsx`, `growthPortal.test.tsx`; Android `Api.kt`, `Growth.kt`.
**Migrations added:** `0100_growth_leads.sql` (the number assigned). No earlier migration edited; no capability CHECK,
grant trigger or scope trigger redefined (the leaver rule is a new trigger function on `organization_memberships`).
Replayed twice by hand on a migrated database without error.

**What was built**
1. *Schema (0100).* `growth_leads` (organisation-level only; kind, area, AISHE code, website host, owner, stage,
   source, possible-duplicate flag, do-not-contact set once, organisation set once, `last_activity_at`, `version`;
   never deleted). The owner must be an ACTIVE growth membership with a live team row matching the kind (trigger).
   Partial unique indexes on the AISHE code and the website domain among live leads. `growth_lead_contacts` (role, name,
   email, phone, **required** `permission_basis` with a source CHECKed to fit it, notice given/version/recorder set once;
   a removed contact keeps no name, email or phone — CHECK; never deleted; none added to a do-not-contact lead).
   `growth_lead_owner_history` and `growth_lead_stage_history`, append-only. The **leaver trigger**: a growth
   membership leaving ACTIVE (ended or suspended) releases its open leads with an `OWNER_LEFT` history row in the same
   statement; lost and handed-off leads keep their owner.
2. *Duplicates without disclosure.* Identifiers are normalised (AISHE upper-cased; website reduced to its host) and
   creates for one identifier are serialised; a duplicate names the existing owner only to a caller whose scope
   includes that lead, and everyone else gets "Already registered by another team member — ask your manager". A
   do-not-contact organisation and an employer already on ONE are refused; a same-name lead in the same district is
   flagged, not refused.
3. *Growth routes* (`/api/v1/growth/leads`): vocabulary (with the DRAFT notice), list (keyset, 50, mine / unowned /
   needs a new owner / all, search), detail, create, claim (first wins under a row lock), reassign (managers, reason),
   add contact, record notice, remove contact, reveal (non-owners, reason, audited), do-not-contact. Every read is
   composed from GROWTH-02's `growthScopePredicate`; a lead outside scope is 404.
4. *Operations.* Settings → Growth leads (`GROWTH_ADMIN`): every region's leads, contacts masked, reveal, reassign
   anywhere (never to their own growth membership), do-not-contact, remove contact. Security → Privacy → Growth lead
   contacts (`PRIVACY_REQUESTS`): lookup by email or phone (the access answer) and erasure, optionally with
   do-not-contact, audited by request reference and a hash of the key — never the email or phone itself.
5. *Retention (D12).* The privacy worker erases the contacts of every not-handed-off lead whose last activity is over
   24 months old (`RETENTION_EXPIRED`), in bounded, idempotent batches, and logs a summary.
6. *Export.* The privacy export gains `growthWork` (a growth person's own staff type, teams, territory and leads), never
   a contact's details; `privacy-export-coverage.md` records where each growth table lands.
7. *Web* Growth → Leads (pilot composition: hero, four real-count tiles, list, detail with contacts, the purpose and the
   DRAFT notice in the rail). Home's Open leads and Territory's unowned counts now come from the register.
8. *Android* a Leads tab: list, detail, claim, new lead, add contact (basis, source, notice), record notice, call and
   email through the phone's own apps; Home and My territory show the real counts.

**Tests added**
- `packages/authorization/src/growth-leads.test.ts` (15): vocabulary pinned to the migration, source-by-basis,
  website and AISHE normalisation, claim / reassign / contact-write / privacy-write rules, owner-only full contacts,
  duplicate disclosure, staleness, and the notice text identical to the legal draft.
- `apps/api/src/http/growth-leads.integration.spec.ts` (23): access (growth only; Operations and privacy capabilities);
  create with history, audit and outbox; team mismatch; **duplicates named only to someone in scope, anonymous
  otherwise, website forms collapsed, already-on-ONE refused, a race decided by the index**; possible-duplicate flag;
  **basis required (API and database) and source fitting the basis**; owner full / others masked / audited reveal /
  404 outside scope; notice once; **a removed contact keeps nothing (CHECK refuses partial erasure)**; ten-contact cap;
  first claim wins; manager reassign with reason; **leaver's open leads released inside the ending transaction**, lost
  lead kept, suspension also releases, manager's needs-a-new-owner list; do-not-contact freezes the lead and refuses
  the organisation again; **24-month sweep** erases exactly the expired, skips handed-off, is idempotent; privacy
  lookup by email and phone, audit without the key, erasure with do-not-contact; growth admin reassigns anywhere;
  counts on `/me` and `/territory`; export section without contact details.
- `apps/web/src/rolePortal/growthLeads.test.tsx` (8) and a new case in `apps/web/src/growthPortal.test.tsx`;
  GROWTH-01/02 web cases updated deliberately where Leads and the unowned count are now built.

**Acceptance criteria**
- [x] A duplicate AISHE code or domain is refused without revealing another team's pipeline — `409
  GROWTH_LEAD_DUPLICATE` with `existing: null` and a neutral sentence for anyone whose scope does not include the lead;
  the database's partial unique indexes decide a race.
- [x] A removed contact keeps no name, email or phone — `growth_lead_contact_state_ck`; every removal path (owner,
  manager, admin, privacy console, retention sweep) nulls the fields in the same statement.
- [x] A leaver's open leads become unowned in the same transaction — `growth_lead_owner_left` trigger, proven inside an
  open transaction before commit, for an ended and a suspended membership.
- [x] A contact's `permission_basis` is required — NOT NULL + CHECK in the database, `GROWTH_CONTACT_BASIS_REQUIRED`
  from the API, and the forms on web and Android cannot submit without one.
- [x] Built per §18: create, claim, reassign, do-not-contact, duplicate rules, masked contacts with audited reveal, the
  leaver trigger, the notice DRAFT in `docs/legal/`, Growth → Leads on web and Android. Beyond §18, at the
  coordinator's instruction: retention, export and erasure for the contacts (design §13.4–13.5, GROWTH-15's sweep and
  lookup brought forward).

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- A create by someone with no team for that kind is refused rather than left unowned.
- No fuzzy name match against existing organisations; only exact identifiers refuse; same name and district flags.
- A do-not-contact lead keeps its owner but is frozen for outreach, and the organisation cannot be entered again.
- The 24-month clock is the lead's last activity (covering both LOST and inactivity).
- The leaver's "manager task" is the derived "needs a new owner" list, not a task table.
- The duplicate answer and its wording come from the server.
- `notice_version` is `draft-2026-10` until legal review publishes a version (HG-6).

**Limitations / not done**
- Stage moves (and so LOST) are GROWTH-04/05's routes; here a lead is created `IDENTIFIED` and stays there.
- The phone sets no state or district on a new lead (the web form does); the offline write queue is GROWTH-06.
- The DPDP basis for each source (O-21) and the notice wording await legal review; the notice's privacy contact is a
  bracketed placeholder.
- Android was compiled, not run on a device.

**Validation** (`E:/one-wt/logs/validate.sh` on a fresh database `one_growth03`, only `DATABASE_URL` exported, on base
`fe3b311` with GROWTH-02 beneath it):
- `corepack pnpm db:migrate` twice — pass (87 applied, then 0 applied / 87 already applied); 0100 also applied twice by
  hand on a migrated database — pass.
- `corepack pnpm typecheck` — pass. `corepack pnpm build` — pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — all 3 975 tests passed (api 1 401, web 989,
  persistence 464, authorization 465, others). Two api files failed only in teardown with the shared Postgres's "out of
  shared memory" on DROP SCHEMA after every test had passed (`institution-learning-cohort`, `institution-student-scope`);
  re-run alone: 15/15 and 15/15 passed.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR) — pass.
- CI parity: optional-chain, private-key and conflict-marker greps — clean; `corepack pnpm audit --prod --audit-level=high` — exit 0.

**Next goal:** GROWTH-04 — College pipeline and the operations handoff.
