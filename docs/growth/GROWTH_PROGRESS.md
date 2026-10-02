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

## GROWTH-06 — Field work on the phone: visits, follow-ups, location, offline — 2026-10-01
**Result:** Complete — field staff log visits, calls, meetings and notes and keep follow-ups on the phone and the web;
every field write lands once however often it is resent; a visit's location is optional, coarse, private to the
person and their manager, kept 180 days, exported and erasable; and the phone keeps working without a signal.
**Branch / PR:** feat/growth-field (rebased onto feat/plan-phases-0-to-2 at f501905) → feat/plan-phases-0-to-2 (pushed; not merged)
**Commits:** 6cc8129 (design) · 12986f8, 4f657bc (tests) · 66276dc, 26838fd, 54582d0, 730697d (implementation) · 0563ea8 (coverage doc) · c0bc53f (report) · 658a7ef (validation record) · this SHA update
**Files created:**
- `docs/architecture/growth-field-work-table-design.md` (written and committed before the migration)
- `docs/legal/growth-field-location-notice-DRAFT-for-legal-review.md` (DRAFT throughout; publishing is HG-6)
- `packages/persistence/drizzle/0103_growth_field_work.sql`
- `packages/authorization/src/growth-field.ts`, `growth-field.test.ts`
- `packages/persistence/src/growth-field.ts` (location and text sweeps, account-erasure step)
- `apps/api/src/http/growth-idempotency.ts`, `growth-field-service.ts`, `growth-field.controller.ts`, `growth-field.integration.spec.ts`
- `apps/web/src/rolePortal/growthField.tsx`, `growthField.test.tsx`
- Android `GrowthQueue.kt` (encrypted offline queue), `GrowthDevice.kt` (reminders, coarse location), `GrowthField.kt`
**Files modified:** `packages/authorization/src/index.ts`; `packages/events/src/index.ts` (four events);
`apps/api/src/http/api-security.module.ts`, `growth-leads.controller.ts` (optional Idempotency-Key on create),
`growth-workspace.controller.ts` (`visitsThisMonth`, `followUpsDue` on `/me`), `privacy-export-sections.ts`
(`fieldActivities`, `followUps`), `privacy-deletion.ts` (locations erased with the account), `run-privacy-worker.ts`
(two sweeps); `docs/architecture/privacy-export-coverage.md`; web `api/growth.ts`, `rolePortal/growth.tsx`,
`rolePortal/growthLeads.tsx`, `growthPortal.test.tsx`; Android `Api.kt`, `Growth.kt`, `GrowthLeads.kt`, `AndroidManifest.xml`.
**Migrations added:** `0103_growth_field_work.sql` (the number assigned). No earlier migration edited; no capability
CHECK, grant trigger or scope trigger redefined (two new tables and two new guard functions only). Applied twice by
the migrator and replayed by hand on a migrated database without error.

**What was built**
1. *Schema (0103).* `growth_activities` (VISIT/CALL/MEETING/NOTE; outcome required except for notes; the contact met
   must be a contact of the same lead; `occurred_at` as the device reported it beside `received_at = now()`;
   **refused on the database clock when more than 7 days old or more than 5 minutes ahead**; location as
   `numeric(6,3)` / `numeric(7,3)` with the reported accuracy, only on visits and meetings, **never added or changed
   after insert, erased once** with a reason; notes erased once; never deleted; refused on a do-not-contact lead).
   `growth_follow_ups` (due date a week back to a year ahead in IST; OPEN → DONE | CANCELLED once, cancellation
   reason-coded; title erased once; never deleted).
2. *Idempotency.* Every field write requires an `Idempotency-Key` (activities, follow-ups, complete, cancel; optional
   on lead create, for offline new leads), recorded in the existing `idempotency_records` inside the write's
   transaction, scoped by user and route and hashed with the body: a resend replays the first answer
   (`idempotentReplay: true`), concurrent copies block and replay, a reused key with another body is 422, and a
   refusal leaves no record so a resend is refused the same way.
3. *Rules.* The owner, or a manager who could reassign the lead, logs work; an executive claims first. Activities and
   follow-ups are visible to anyone who sees the lead; **a location only to its author and their manager** (the key is
   absent for everyone else, including another manager of the same region and growth admins). Only the author removes
   a location. A follow-up is closed by its assignee or their manager.
4. *Retention, export, erasure.* The privacy worker erases locations 180 days after the visit, and the notes and
   follow-up titles of leads quiet for 24 months (with their contacts, design §13.4), bounded and idempotent. The
   export gains the person's own field log with locations while held. Account erasure erases every location they
   logged. Audit rows and events say whether a location was attached, never where.
5. *Web.* Growth → Field (hero, four real counts, follow-ups by overdue / today / upcoming with Done and Cancel, recent
   work, team view for managers, the DRAFT location notice); each lead's detail gains its field work with forms to log
   work and add a follow-up. Home's "Visits this month" and a follow-ups-due card now read the field log.
6. *Android (primary client).* A Field tab; Home's real visits and a Today card; on a lead, Log work (kind, outcome,
   contact met, when, notes, **Attach my location** on a tap: the DRAFT notice first, then the foreground
   approximate-location prompt; declining leaves the visit whole) and Add follow-up. **One queue for every field
   write** (and new leads), encrypted with AES-256-GCM under an Android Keystore key in no-backup storage, bound to
   the signed-in person, sent in order on open, on "Send now" and whenever a network appears; a refusal is kept with
   its reason until dismissed. Saved copies of the lists, the field page and the person's own leads for offline
   reading. Local 09:00 reminders on the due date (AlarmManager, no push). **Sign-out warns about unsent items, then
   clears the queue, the cache and the reminders.** The manifest adds only `ACCESS_COARSE_LOCATION`,
   `ACCESS_NETWORK_STATE` and a non-exported reminder receiver — no fine or background location.

**Tests added**
- `packages/authorization/src/growth-field.test.ts` (17): vocabulary pinned to 0103, column precision, notice text
  identical to the legal draft, outcome/location by kind, report-time rule, rounding, due-date window in IST, who logs,
  who sees a location, who removes it and closes a follow-up.
- `apps/api/src/http/growth-field.integration.spec.ts` (25): access; logging with audit/outbox/idempotency record;
  **3-decimal storage (API and column)**; **a visit without a location is complete and counted**; kinds and location
  (API and CHECK); contact of the same lead; **a write retried five times lands once — sequentially and five at once**,
  also for a follow-up, its completion and an offline lead; key missing, malformed, reused, per-person; a refusal leaves
  no record; **reports older than 7 days or in the future refused (API and database clock)**; claim before logging;
  **location seen by author and manager only**; never added after the fact, erased once, author-only removal;
  do-not-contact; follow-up window and closing; Field page and `/me` counts; both sweeps (idempotent); export; erasure.
- `apps/web/src/rolePortal/growthField.test.tsx` (8) and a Field case in `growthPortal.test.tsx`; two GROWTH-01 web
  assertions updated on purpose (Field is no longer "not built yet").

**Manual run on the emulator** (Android Studio emulator, API 36 image; the app built from this branch; the API module
served locally against a local database with a test token verifier, as the integration specs do — no production, no
Cognito; the cleartext allowance for 10.0.2.2 was a temporary debug-only overlay, removed and never committed):
- Signed in as a seeded growth executive; Home showed Open leads 1, Visits this month 0, Today "Nothing is due".
- **Logged a visit offline:** Wi-Fi and data off, Log work → Met → Save showed "Saved on this phone. It will be sent
  when you are back online."; the server held **0** activities; the queue file in no-backup storage (437 bytes)
  contained no readable lead name, kind or path (encrypted).
- **Synced:** network back on → the connectivity callback sent it; the server held **exactly 1** activity (VISIT, MET,
  no location) and **1** SUCCEEDED idempotency record; the queue file was gone.
- **Location:** "Attach my location" showed the DRAFT notice, then the system prompt offering **approximate location
  only**. This emulator image delivered no fix to a coarse-only request (the console fix was accepted, the request
  recorded zero locations), so the app showed "No location could be read. The visit logs without one." — the no-fix
  path, working. A real coordinate from a phone was **not** observed; the provider fallback (fused → network → GPS on
  Android 12+) was added after this run.
- **Sign-out:** with one item queued offline, Sign out warned "1 item has not been sent yet. Signing out deletes it…";
  confirming removed the queue file, all 10 cached responses and the token; the server still held 1 activity.

**Acceptance criteria**
- [x] A write retried five times lands once — sequential and concurrent specs (one row, one audit row, one event);
  shown end to end on the emulator.
- [x] A report older than 7 days or in the future is refused — API and the database trigger on its own clock (5 minutes
  of phone-clock skew tolerated, recorded as a decision).
- [x] Location is stored at 3 decimal places — rounded on the phone, by the API and by the column type (spec).
- [x] Declining location permission leaves logging intact — spec and emulator.
- [x] The app compiles, and a manual run on an emulator logs a visit offline and syncs it — above.
- [x] Do not: no background or fine location requested; location read only on the tap; no refused offline write
  dropped silently.

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- An executive logs work only on a lead they own (claim first); a manager may log on any lead they could reassign.
- Activities and follow-ups are visible to anyone who sees the lead; the location only to its author and their manager.
- Up to 5 minutes ahead of the server is phone-clock skew, accepted; more is "in the future".
- Location only on visits and meetings, never calls or notes, and never attached after the fact.
- Follow-ups due a week back to a year ahead; reminders at 09:00 local showing the organisation's name only.
- The 24-month sweep also erases activity notes and follow-up titles of the same leads.
- Location erasure on account deletion is a step of the deletion run, not a new deletion category.
- After a session expires (not an explicit sign-out) the queue stays encrypted for the same person, and is discarded
  unread if someone else signs in.

**Limitations / not done**
- A visit to a lead created offline can be logged only after that lead has synced (its id comes from the server).
- Claiming, adding a contact and recording a notice still need a signal (not in the design's queue list).
- Operations (`GROWTH_ADMIN`) has no field-log view: the design limits location to the person and their manager.
- No real-device location fix observed; the location notice is a draft (HG-6).

**Validation** (`E:/one-wt/logs/validate.sh` on a fresh database `one_growth06`, only `DATABASE_URL` exported, on base af4e181):
- `corepack pnpm db:migrate` twice — pass (88 applied, then 0 applied / 88 already applied); 0103 also replayed by hand — pass.
- `corepack pnpm typecheck` — pass. `corepack pnpm build` — pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — **4 026 of 4 026 tests passed** (api 1 426, web 998,
  persistence 482, authorization 464, others). The run exits 1 only because 8 API files hit the known teardown-only
  "out of shared memory" on `DROP SCHEMA` after all their tests had passed (employer-applicant-access,
  employer-applicant-export, employer-eligibility-stages, institution-settings, institution-student-scope,
  operations-analytics, operations-institution-onboarding, staff-pool-access). Each re-run alone: pass (7, 9, 10, 24,
  15, 10, 2, 7 tests). None of them is a growth file.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR) — pass; `assembleDebug` built and ran on
  the emulator as recorded above.
- CI parity: optional-chain, private-key and conflict-marker greps — clean; `corepack pnpm audit --prod --audit-level=high` — exit 0.
- An earlier run on the pre-rebase base was abandoned when the base moved (and a leftover process from it was stopped
  before this run started on a fresh database).
- After the rebase onto f501905 (clean, no conflicts): `corepack pnpm typecheck` — pass (run on the GROWTH-04 tip, which
  contains this branch); `growth-foundation.integration.spec.ts` re-run alone on a fresh database — 19/19 pass.
- Final rebase onto 98f64d6 (the base moved again: résumés 0101, inference 0105, sandbox seed): one conflict, the
  controller list in `api-security.module.ts`, resolved by keeping the base's list and appending this goal's controller.
  Commit SHAs above are from the f501905 rebase; `git log` on the branch is authoritative. On a fresh database:
  typecheck pass; `sandbox-seed` 12/12 (it seeds growth leads with 0103/0104 present), `growth-field` 25/25 — pass.

**Next goal:** GROWTH-04 — College pipeline and the operations handoff.

## GROWTH-04 — College pipeline and the operations handoff — 2026-10-01
**Result:** Complete — a growth person moves a college lead through one stage machine, hands a signed college to
operations as a request, and follows its onboarding through milestones read from Operations' own records; only an
operator with `OPS_ORG_MANAGE` links the request to the college they created, which records the owner at that moment
and moves the handed-over contacts to the college's account.
**Branch / PR:** feat/growth-college-pipeline (stacked on feat/growth-field, both rebased onto feat/plan-phases-0-to-2 at
f501905) → feat/plan-phases-0-to-2 (pushed; not merged)
**Commits:** 46ff08e (design) · 67a9041, a427d2b (tests) · 0ac5f99, 97754bb, 746a412 (implementation) · 36effc8 (GROWTH-03
fixture updated to the new rule) · 1390b4c (report) · this validation record
**Files created:**
- `docs/architecture/growth-college-pipeline-table-design.md` (written and committed before the migration)
- `packages/persistence/drizzle/0104_growth_college_pipeline.sql`
- `packages/authorization/src/growth-pipeline.ts`, `growth-pipeline.test.ts`
- `apps/api/src/http/growth-pipeline-service.ts`, `growth-pipeline.controller.ts` (growth routes and the Operations
  queue), `growth-pipeline.integration.spec.ts`
- `apps/web/src/rolePortal/growthPipeline.tsx`, `growthPipeline.test.tsx`
- Android `GrowthPipeline.kt`
**Files modified:** `packages/authorization/src/index.ts`; `packages/events/src/index.ts` (four events);
`apps/api/src/http/api-security.module.ts`, `growth-leads.integration.spec.ts` (fixture); web `api/growth.ts`,
`rolePortal/growthLeads.tsx`, `rolePortal/operations.tsx` (one section, no navigation change); Android `Api.kt`,
`GrowthLeads.kt`, `GrowthQueue.kt`.
**Migrations added:** `0104_growth_college_pipeline.sql` (the number assigned). No earlier migration edited; no earlier
function redefined (the pipeline rule is a second trigger on `growth_leads` beside GROWTH-03's guard); no capability
CHECK, grant trigger or scope trigger touched. Applied twice by the migrator and replayed by hand without error.

**What was built**
1. *Stage machine* (`growth-pipeline.ts`, design §6.1): forward moves free (skips allowed), backward moves reason-coded,
   `ON_HOLD` reason-coded and resumed to the stage held before (read from the stage history), `LOST` reason-coded and
   terminal, a do-not-contact lead may only be lost, `HANDOFF_REQUESTED` only through the handoff route. A move carries
   `fromStage`; a stale (offline) move is refused `409 GROWTH_STAGE_CHANGED`. Owner or their region's manager only.
   Moves accept an `Idempotency-Key` (GROWTH-06's helper).
2. *Schema (0104).* `growth_handoff_requests` (REQUESTED → LINKED | DECLINED once; required reported contract reference in
   OPS-14's reference shape; one open and one linked request per lead; one linked request per organisation; on LINKED
   the organisation, the operator, **the lead's owner at link** and the contact counts) and
   `growth_handoff_request_contacts` (insert-only; live contacts of the same lead). `growth_lead_pipeline_guard`: a lost
   or handed-off lead's stage never changes; `HANDOFF_REQUESTED` is entered only with an open request and left only when
   it is decided; **a college lead names an organisation only through a LINKED request for that organisation**.
3. *Handoff request* (growth): from `AGREEMENT_SIGNED_REPORTED`, with the reference and the contacts to hand over; the
   stage moves to `HANDOFF_REQUESTED` in the same transaction.
4. *Operations → Organizations → Growth handoffs* (`OPS_ORG_MANAGE`; a section of the existing screen): open requests
   with area, AISHE code, the reported reference and the marked contacts **masked**. **Link** (to an `INSTITUTION` the
   operator created with the unchanged Add Organization): request LINKED with the owner at link, lead's organisation
   set, marked contacts copied into OPS-14's `institution_account_contacts` with reason `ONBOARDING` (roles mapped,
   OPS-14's limit respected) with OPS-14's own audit action, and **every** lead contact erased `HANDED_OVER`; audit and
   `growth.lead.handed_off`. **Decline** with a reason returns the lead to `NEGOTIATION`. No organisation, verification,
   account field or account owner is written.
5. *Derived milestones* (design §6.1), computed on every read, never stored: `HANDED_OFF`, `CONTRACT_RECORDED` (reached or
   not; the reference is not shown to growth), `VERIFIED` (first verification time), `ADMIN_JOINED`,
   `DATA_TERMS_ACCEPTED` (INST-18, merged; **NA** while no terms version is published), `FIRST_ROSTER`,
   `STUDENTS_ACTIVATING` (**suppressed below 5**), `FIRST_PAYMENT_CLEARED` (**NA** until GROWTH-10), `EXITED` (INST-18).
6. *Web:* the lead detail gains a Pipeline panel (stage, moves with reasons, the handoff form, requests, milestones).
7. *Android:* the same on the lead detail, with moves and the handoff request through the offline queue and refusal
   texts for a stale move.

**Tests added**
- `packages/authorization/src/growth-pipeline.test.ts` (12): vocabulary pinned to 0100/0104; forward, backward, hold,
  resume, lost, do-not-contact, other kind's stages; next-stage lists; who moves; handoff preconditions; role mapping.
- `apps/api/src/http/growth-pipeline.integration.spec.ts` (16): stage moves with history and events; stale move 409;
  resend lands once; hold/resume; LOST terminal (API and database); owner/manager only; HANDOFF_REQUESTED only by the route
  (API and database); handoff preconditions, one open request (index); growth routes write no organisation or account;
  **link refused to growth staff and a security admin, and the database refuses an organisation without a linked
  request**; masked queue; **link records the owner, carries contacts with ONBOARDING, erases every lead copy**, refuses
  an employer or an already-linked organisation; decline to NEGOTIATION and a new request; **milestones re-read after
  each source changes** (account reference, verification, admin invitation, terms published then accepted, roster,
  four then five activations, the INST-18 exit), with no student id, roll number or contract reference in the answer.
- `apps/web/src/rolePortal/growthPipeline.test.tsx` (6).
- `growth-leads.integration.spec.ts`: the retention fixture now hands its lead off through a linked request (0104 refuses
  the direct update it used); its assertion is unchanged.

**Acceptance criteria**
- [x] Only an operator with `OPS_ORG_MANAGE` can link a handoff — route check (growth executive, manager and security admin
  get 403 on queue, link and decline) and the database rule on `growth_leads.organization_id`.
- [x] Derived milestones match their source tables in a spec that changes each source — one spec changes all eight sources
  in turn and reads the milestones after each.
- [x] The student-activation count is suppressed below 5 — `suppressSmallCount`; four activations read `<5`, five read 5.
- [x] Do not: no growth route creates or verifies an organisation (asserted: organisation and account counts unchanged by
  growth routes); derived milestones are not stored.

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- Forward moves free with skips; backward moves need a reason; hold reasons `ORGANISATION_PAUSED`, `BUDGET_CYCLE`,
  `LEADERSHIP_CHANGE`, `OTHER`.
- A handoff request needs `AGREEMENT_SIGNED_REPORTED` and a reported reference in OPS-14's shape (no amounts or names).
- At link every lead contact is erased; only marked ones are carried (PRINCIPAL and PLACEMENT_OFFICER keep their role,
  others become OTHER), within OPS-14's limit; carried contacts are recorded with `ONBOARDING`, a reason written only by
  the link and not offered in OPS-14's manual form.
- `DATA_TERMS_ACCEPTED` is NA while no terms are published; `FIRST_PAYMENT_CLEARED` is NA until GROWTH-10.
- The requester cannot withdraw a request; an operator declines it.
- The same stage route serves employer leads' own working stages; employer milestones and handoff remain GROWTH-05's.

**Limitations / not done**
- Attribution rows are not written: `growth_attributions` is GROWTH-07's table. The owner at link is recorded on the
  request so GROWTH-07 can write `LEAD_OWNER_AT_HANDOFF` from it without guessing.
- The self-dealing guard on linking (§8.6) needs attribution, so it is GROWTH-07's.
- No "stale request" alert for operations; the queue is ordered oldest first.

**Validation** (`E:/one-wt/logs/validate.sh` on a fresh database `one_growth04`, only `DATABASE_URL` exported, on base af4e181
with GROWTH-06 beneath; then rebased onto f501905):
- `corepack pnpm db:migrate` twice — pass (89 applied, then 0 / 89 already applied); 0104 also replayed by hand — pass.
- `corepack pnpm typecheck` — pass (again after the rebase onto f501905). `corepack pnpm build` — pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — every growth spec passed; overall api 1 439 of 1 442, web
  1 002 of 1 004, every other package fully green (persistence 494, authorization 464, …). The run exits 1 for failures
  that are environmental, none in a growth file:
  - 12 API files hit "out of shared memory" on the shared Postgres (mostly teardown `DROP SCHEMA`). At the
    coordinator's request the listed ones were re-run alone, sequentially, on a fresh database after the rebase:
    growth-foundation 19/19, institution-exports 21/21, learner-goals 5/5, operations-lessons 19/19,
    institution-placement-visibility 15/15, institution-teaching-assignments 35/35 — pass.
    institution-learning-actions: two alone runs each failed one *different* test with "out of shared memory" (18/19);
    the third alone run passed 19/19, with the server otherwise idle. It touches no growth table.
  - web `App.test.tsx` › "resolves every visible navigation item…" — the known 20 s timeout under full-suite load.
  - web `employerReports.test.tsx` — one lookup missed under load; re-run alone 5/5 pass.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR) — pass.
- CI parity: optional-chain, private-key and conflict-marker greps — clean; `corepack pnpm audit --prod --audit-level=high` — exit 0.
- Final rebase onto 98f64d6: one conflict, the controller list in `api-security.module.ts`, resolved by keeping the
  base's list and appending this goal's two controllers. Commit SHAs above are from the f501905 rebase; `git log` on the
  branch is authoritative. On a fresh database: typecheck pass; Android compile pass; `sandbox-seed` 12/12 (its growth
  leads stop at MET and set no organisation, which 0104 allows), `growth-pipeline` 16/16, `growth-field` 25/25,
  `growth-leads` 23/23, `growth-foundation` 19/19 — pass.

**Next goal:** GROWTH-05 — Employer pipeline, referral links and the EMP-04 handoff (or GROWTH-07, as the coordinator decides).

## GROWTH-05 — Employer pipeline, referral links and the EMP-04 handoff — 2026-10-02
**Result:** Complete — a growth person on the employer team shares a referral link (web and Android share sheet) that
carries only a random code; the public EMP-04 form records the referral and the matching employer lead without its
answer or its rate limits depending on the code; operations see "Referred by" and "Matches growth lead" in the queue and
can link a request to a lead by hand; marking a request onboarded records, in the same transaction, the lead's owner
and the referrer as they stand and the §8.3 credit candidate GROWTH-07 will build attribution from, and links the lead;
every employer lead shows its milestones from the employer's own records, as counts and states only.
**Branch / PR:** feat/growth-employer-pipeline (from feat/plan-phases-0-to-2 at 772afa4) → feat/plan-phases-0-to-2 (pushed; not merged)
**Commits:** 12e3919 (design) · 7980191 (tests) · afd8f2b (server) · 29a948e (web) · 611c737 (Android) · this report
**Files created:**
- `docs/architecture/growth-employer-pipeline-table-design.md` (written and committed before the migration)
- `packages/persistence/drizzle/0109_growth_employer_pipeline.sql`
- `packages/persistence/src/employer-access-request-retention.ts`
- `packages/authorization/src/growth-employer.ts`, `growth-employer.test.ts`
- `apps/api/src/http/growth-employer-service.ts`, `growth-employer.controller.ts`, `growth-employer.integration.spec.ts`
- `apps/web/src/rolePortal/growthReferrals.tsx`, `growthEmployer.test.tsx`
- Android `GrowthReferrals.kt`
**Files modified:** `packages/authorization/src/index.ts`; `packages/events/src/index.ts` (six events);
`apps/api/src/http/employer-access-requests.controller.ts` (the form accepts `ref`; the queue's growth columns; the
onboarding record on ONBOARDED — the route contracts are unchanged), `growth-pipeline.controller.ts` (employer milestones
and access requests), `api-security.module.ts`, `privacy-export-sections.ts` (`growthWork.referralCodes`),
`run-privacy-worker.ts` (the retention sweep); `docs/architecture/privacy-export-coverage.md`; web `api/growth.ts`,
`api/operations.ts`, `publicEmployerAccessPage.tsx` (+ test), `rolePortal/growthPipeline.tsx`, `growthLeads.tsx` (the card
in the rail), `operationsEmployerAccessRequests.tsx`; Android `Api.kt`, `Growth.kt`, `GrowthPipeline.kt`.
**Migrations added:** `0109_growth_employer_pipeline.sql` (the number assigned). No earlier migration edited; no earlier
function redefined (new functions on new triggers only: a third trigger on `growth_leads`, a second leaver trigger on
`organization_memberships`, a trigger on `growth_team_members`); no capability CHECK, grant trigger or scope trigger
touched. Applied twice by the migrator (the second run applies nothing) and replayed by hand with `psql -v ON_ERROR_STOP=1`
on a migrated database without error.

**What was built**
1. *Schema (0109).* `growth_referral_codes` (10 characters of a 31-character unambiguous alphabet, CHECKed; owner an ACTIVE
   growth membership on the employer team; **at most 3 live and 5 created a day per person**, under a per-membership
   advisory lock; revoked once — by the owner, or automatically when the membership leaves ACTIVE or the employer team row
   ends; never deleted). `employer_access_request_referrals` and `employer_access_request_leads` (one per request,
   **`ON DELETE CASCADE` from the request**, so EMP-04's retention takes them; a referral needs a live code of an ACTIVE
   membership; a lead link only to an open, contactable employer lead and only while the request is PENDING; neither can be
   deleted on its own while its request exists, except an operator's unlink). `growth_employer_onboardings` (insert-only;
   only after an ONBOARDED request for that employer; owner and referrer columns paired; the §8.3 basis CHECKed against
   them). `growth_lead_employer_org_guard`: an employer lead names its organisation only through an onboarding record.
2. *The public form.* Accepts an optional `ref`, read after the unchanged rate-limit check and request upsert, inside a
   savepoint (nothing it does can fail the submission). Malformed, unknown, revoked, a left owner's and a capped code are
   ignored silently, and a well-formed one is looked up whatever its fate; **20 referrals per code per 24 hours**; the
   first referral of a pending request wins; `growth.referral.recorded` with no actor. The same transaction links the
   request to the one open, contactable employer lead whose domain matches the email domain or website host.
3. *Operations → Organizations (no navigation change).* Each queue row shows "Referred by <work email>" (and whether the
   link was since revoked), "Matches growth lead <name> · owner", and read-time candidates (same domain or name);
   `OPS_ORG_MANAGE` links, moves or removes a pending request's lead (audited old → new) and searches open employer leads.
   The unchanged decision route, on ONBOARDED, writes the onboarding record (lead owner and referrer *now*, the candidate
   `REFERRAL_LINK` / `LEAD_OWNER_AT_HANDOFF` / `CONFLICT` / `HOUSE`), links the lead when it can, audits and emits
   `growth.employer.onboarded`. A lost, do-not-contact or already-linked lead is not recorded and never blocks the decision.
4. *Growth.* `GET/POST /growth/referral-codes`, `POST …/:id/revoke` (owner only; another's is 404; creation takes an
   Idempotency-Key). An employer lead's pipeline shows `ACCESS_REQUESTED`, `ONBOARDED`, `VERIFIED` (first verification),
   `TERMS_ACCEPTED` (**NA** while no employer terms are published), `FIRST_JOB_PUBLISHED` (first publish time and the count
   **published now**), `CAMPUS_DRIVE` (a count per drive state), `SUSPENDED`; and its linked requests with time, state and
   whether the referral was "yours" or "another team member's" — never whose, and never what the requester typed.
5. *Retention (EMP-04 decision 4, unbuilt until now).* The privacy worker deletes DECLINED and SPAM requests 180 days after
   the decision, bounded and idempotent; their referral and lead link go with them by cascade.
6. *Privacy export.* A growth person's own codes, with referrals recorded, under `growthWork.referralCodes`.
7. *Web.* "Your employer referral links" card on the Leads page (copy, revoke, new link, counts per code, the limits); the
   employer pipeline on the lead; the queue's Growth column; the public page passes the link's `ref` on untouched.
8. *Android.* The same card on the Growth home for the employer team: **shares through the Android share sheet, from a saved
   copy when offline**; create and revoke need a signal and say so (the server makes the code). Employer milestones and
   access requests on the lead's pipeline (saved copy offline); employer stage moves already went through the offline queue
   (GROWTH-04).

**Tests added**
- `packages/authorization/src/growth-employer.test.ts` (10): alphabet, length, limits, revoke reasons and bases pinned to
  0109; no ambiguous character; generation; every malformed `ref` shape; the link carries only the path and code; employer
  team only; the hosts a request matches on; the §8.3 candidate; "yours" / "another's"; milestone order.
- `apps/api/src/http/growth-employer.integration.spec.ts` (21): codes (team only, audited, no code in the event; 3 live and
  5 a day in the API and the database; owner-only revoke, 404 for another's, never changed or deleted; automatic revocation
  on leaving and on leaving the team; a resent creation lands once; in the owner's export only); **twelve `ref` variants
  (valid, lower case, revoked, unknown, malformed, ambiguous, empty, 500 characters, a number, an object, null, absent)
  produce responses equal in status, every header but Date, and body text, with the correlation id pinned; only the valid
  code is recorded**; **five variants follow the identical 202×5 then 429 sequence with identical 429 responses, and a
  refused submission records nothing**; the per-code cap; first referral wins; a leaver's code is ignored; **retention
  deletes 181-day-old declined and spam requests with their referral and lead link, keeps a 179-day one, a pending and an
  onboarded one, refuses a direct referral delete, and is idempotent**; domain match (one lead; never lost; never a guess
  between two); the queue's growth facts, OPS_ORG_MANAGE-only link / move / unlink with audit, lost lead and decided request
  refused; onboarding: referral, conflict, lead owner, house, a lead naming another employer; the database rule and the
  immutable record; growth staff cannot decide; employer stage moves; **milestones re-read after each source changes
  (request, onboarding, verification, terms published then accepted, a job drafted, published then closed, a campus drive,
  suspension), with no job title or reference, college, requester or candidate anywhere in the answer**.
- `apps/web/src/rolePortal/growthEmployer.test.tsx` (8) and a referral case in `publicEmployerAccessPage.test.tsx`.

**Acceptance criteria**
- [x] A valid, revoked, unknown and malformed code produce byte-identical responses — status, all headers except Date, and
  body bytes compared across twelve variants with the per-request correlation id pinned (it is random per request
  whatever the code); and the same rate-limit behaviour — five variants, identical 202/429 sequences and identical 429s.
- [x] A referral row is deleted with its request under EMP-04 retention — `ON DELETE CASCADE` plus the 180-day sweep built
  here; a direct delete while the request exists is refused.
- [x] Growth sees job and drive counts and states, never content or candidates — the milestone spec asserts the counts and
  that no title, reference, college, requester or candidate field appears.
- [x] Design §7: employer stages and derived milestones; `growth_referral_codes`, `employer_access_request_referrals`; the
  queue shows referral and lead matches; onboarding links the lead and records the attribution candidate.
- [x] Android: share my link (share sheet, offline from a saved copy); employer pipeline on the lead.

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- Codes: 10 of 31 unambiguous characters, stored plainly (they open nothing; the owner must see the link again).
- Abuse limits: 3 live links and 5 new a day per person; 20 recorded referrals per code per day, beyond which requests are
  received normally without the referral.
- First referral wins on a repeated pending request; a referral credits its code's owner even if the code was revoked
  after use (how a leaver's credit is treated is GROWTH-07's, §8.5).
- Codes are revoked when the owner leaves ACTIVE and when they leave the employer team.
- Domain match only to exactly one open, contactable lead; lost and do-not-contact leads are never linked (form, operator
  or onboarding); operators may link, move or remove while pending.
- EMP-04's 180-day retention of declined and spam requests is built now (it was recommended and unbuilt).
- A growth person sees counts of referred requests by state, not the companies; on a lead, "yours" or "another team
  member's", not whose.
- No employer commission figure anywhere (D11); the candidate is a fact, not credit.

**Android:** changed (above). Creating and revoking a link are not queued offline, by design: the server generates the
code, so an offline creation would promise a link that does not exist yet.

**Limitations / not done**
- `growth_attributions` and disputes are GROWTH-07's: this goal records the candidate (including `CONFLICT`) and writes
  no attribution. The self-dealing guard on `OPS_VERIFY` (§8.6) needs attribution and is GROWTH-07's too.
- No growth "lead from an inbound request" creation: an unmatched request stays operations' to onboard (house).
- No manual run on an emulator this goal (compile only); the share sheet is the platform's.

**Validation** (`E:/one-wt/logs/validate.sh E:/one-wt/growth05 one_growth05 growth05 android` on a fresh database
`one_growth05`, only `DATABASE_URL` exported, on base 772afa4):
- `corepack pnpm db:migrate` twice — pass (93 applied, then 0 applied / 93 already applied); 0109 also replayed by hand — pass.
- `corepack pnpm typecheck` — pass. `corepack pnpm build` — pass. Android `:app:compileDebugKotlin` (Android Studio JBR) — pass.
- CI parity: private-key, optional-chain and conflict-marker greps — clean; `corepack pnpm audit --prod --audit-level=high` — exit 0.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — every package green except api: 1 524 of 1 525 tests passed,
  including `growth-employer.integration.spec.ts` 21/21 and every growth spec; web 1 006/1 006, persistence 504/504,
  authorization 495/495. The run exits 1 because 40 API files hit the shared Postgres's "out of shared memory" (39 in
  teardown after their tests passed) and one test failed under that load:
  `institution-accreditation-exports` › "drops a revoked share and a withdrawn self-report on the next export" (a count
  assertion; the file touches no growth or access-request table). **All 40 files were re-run alone, sequentially, on the
  same database: every test passed** (accreditation-exports 11/11, employer-company-profile 20/20, growth-field 25/25,
  growth-foundation 19/19, growth-pipeline 16/16, growth-territories 17/17, sandbox-seed 12/12, and the other 33 files in
  full). Four of them (employer-applicant-access 7/7, employer-applicant-export 9/9, employer-company-profile 20/20,
  institution-department-workspace 17/17) still printed "out of shared memory" from teardown `DROP SCHEMA` after all their
  tests had passed — the known environmental condition, not a test failure. Log: `E:/one-wt/logs/growth05-rerun.log`.
- The base moved 19 commits during the work; this branch is not rebased onto it (the coordinator merges).

## GROWTH-07 — Attribution, disputes, reassignment and leavers — 2026-10-02
**Result:** Complete — every college and employer handed to AI8HT is credited (or deliberately not) in the same
transaction as its handoff; a conflicting referral and lead owner opens a dispute instead; disputes, reassignment and
ending change credit only as an end plus a new row, by someone who is not a party, with a reason, audit and an event;
growth leave dates are recorded for the ledger; and nobody verifies, links, onboards, decides or reassigns anything that
credits them — checked on the user in the routes and in the database. No amount anywhere.
**Branch / PR:** feat/growth-attribution (from feat/plan-phases-0-to-2 at 31aaaf8) → feat/plan-phases-0-to-2 (pushed; not merged)
**Commits:** aa45815 (design) · 975043d (tests) · ec9d523 (implementation) · this report
**Files created:**
- `docs/architecture/growth-attribution-table-design.md` (written and committed before the migration)
- `packages/persistence/drizzle/0110_growth_attribution.sql`
- `packages/authorization/src/growth-attribution.ts`, `growth-attribution.test.ts`
- `apps/api/src/http/growth-attribution-service.ts`, `growth-attribution.controller.ts`, `growth-attribution.integration.spec.ts`
- `apps/web/src/rolePortal/growthCommission.tsx`, `growthAttributionAdmin.tsx`, `growthCommission.test.tsx`
- Android `GrowthCredit.kt`
**Files modified:** `packages/authorization/src/index.ts`; `packages/events/src/index.ts` (four events);
`apps/api/src/http/growth-pipeline-service.ts` (the link writes the attribution; the owner cannot link),
`growth-employer-service.ts` (the onboarding writes the attribution or opens the conflict dispute; the referrer or lead
owner cannot onboard or hand-link), `operations-institution-onboarding.controller.ts` (the verification guard, four
lines), `privacy-export-sections.ts`, `api-security.module.ts`; `docs/architecture/privacy-export-coverage.md`; web
`api/growth.ts`, `rolePortal/growth.tsx` (Commission routed), `rolePortalPages.tsx` (one Settings section),
`growthPortal.test.tsx`; Android `Api.kt`, `Growth.kt`.
**Migrations added:** `0110_growth_attribution.sql` (the number assigned). No earlier migration edited; no earlier
function redefined — new tables, new functions and new triggers only (including a `BEFORE INSERT` trigger on
`organization_verification_events` and a third `AFTER UPDATE OF state` trigger on `organization_memberships`); no
capability CHECK, grant trigger, scope trigger or `operation_approval_extended_target_type()` touched. Applied twice by
the migrator and replayed twice by hand with `psql -v ON_ERROR_STOP=1` on a migrated database without error.

**What was built**
1. *Schema (0110).* `growth_attributions` (§8.1): one live row per organisation (partial unique index); basis CHECKed
   against its source (college handoff request, employer onboarding, dispute, superseded row) and its reason; **CHECKs that
   the creator and the ender are never the beneficiary**; a guard trigger that refuses deletes, starts rows live on the
   database clock, verifies the source names the beneficiary (owner at link; the onboarding's candidate), and allows only
   the end, once. `growth_attribution_disputes` (§8.4): `CLAIM` or `ONBOARDING_CONFLICT`, one `OPEN` per organisation,
   statement 1–2000 characters for a claim, **a CHECK that the decider is neither party**, decided once; the trigger
   enforces the 90-day window on the database clock and that the claimant is ACTIVE and worked on the organisation.
   `growth_leaver_events`: `LEFT` / `RETURNED` for growth memberships, written by trigger in the same statement,
   append-only. Helper functions `growth_organization_handed_off_at`, `growth_user_worked_on` and
   `growth_organization_parties` (the last is what GROWTH-09/10/12 reuse for their own self-dealing checks).
2. *Credit at handoff.* The college link credits the lead's owner at the link (`LEAD_OWNER_AT_HANDOFF`), nobody when the
   lead had no owner. The employer onboarding, at the employer's **first** onboarding only, credits the referrer
   (`REFERRAL_LINK`) or the lead owner, writes nothing for house, and on `CONFLICT` writes **no attribution and opens an
   `ONBOARDING_CONFLICT` dispute** (referrer as claimant, lead owner as respondent).
3. *Disputes.* A growth person claims an organisation they worked on (owned or once owned its lead, requested its
   handoff, referred one of its requests, or is named by its onboarding) within 90 days of its handoff; not one already
   credited to them, not while another is open. A growth admin who is neither party decides: upheld ends the disputed row
   and credits the claimant **from the original date**; rejected changes nothing, except a conflict, where it credits the
   lead owner. The claimant sees their statement; the respondent is told a dispute exists, never what it says; the audit
   row records the statement's length, never its text.
4. *Reassignment, ending and leavers.* A growth admin reassigns (reasons `BENEFICIARY_LEFT`, `WRONG_PERSON_CREDITED`,
   `TEAM_CHANGE`, `CORRECTION`; effective now; only to an ACTIVE growth person on the matching team; not while a dispute
   is open) or ends credit (`CORRECTION`, `ORGANIZATION_EXITED`). The admin list's "Credited person left" view shows each
   leaver's leave date and the end of their 90-day settlement.
5. *Self-dealing guard (§8.6).* Refused for the person, across memberships: a verification transition of an organisation
   they are credited for or party to a dispute about (route `403 GROWTH_SELF_DEALING_REFUSED` and a trigger on
   `organization_verification_events`); linking a handoff whose lead they own; onboarding an access request they
   referred or whose lead they own (the decision rolls back; another operator must do it); hand-linking a request to
   their own lead; deciding their own dispute; reassigning or ending credit to or from themselves.
6. *Web.* Growth → Commission: "Credited to you" (basis, since, dispute open), ended credit, "Your disputes", "Dispute a
   credit" (only what the server offers), four tiles with NA in the commission slot, "Rate not set" and "Employer
   commission on hold" chips. Operations → Settings → Growth attribution (`GROWTH_ADMIN`; a section, no navigation item):
   open disputes with statement, parties and evidence, and the decision form; attributions by view with search;
   reassign and end.
7. *Android.* A read-only "Credited to you" card on the Growth home (saved copy offline), with the person's disputes and
   their states; it says disputes are opened on the web.

**Tests added**
- `packages/authorization/src/growth-attribution.test.ts` (16): vocabulary pinned to 0110; credit from the onboarding
  candidate (referral, lead owner, conflict, house, never someone the candidate does not name); window and settlement
  dates; decision effects for a claim, a house claim and a conflict; who may decide; reassignment refusals; statements
  and notes.
- `apps/api/src/http/growth-attribution.integration.spec.ts` (17): college credit with audit and event and no amount;
  house; **one live attribution per organisation (index) and only-ever-ended rows**; employer referral / lead owner /
  house / second onboarding; **conflict → no attribution, a dispute**; claims (eligible, not eligible 404, already
  credited, too long, one open per organisation in the route and the index; the respondent never sees the statement);
  **the 90-day window in the API and on the database clock**; **a disputant cannot decide, either side, route and
  CHECK**, then a third admin upholds from the original date; conflict upheld / rejected and OTHER needing a note; leaver
  date, admin LEFT view, reassignment rules and history; RETURNED events and none for operators; reassign / end never to
  or from the admin, never during a dispute; **an operator credited for an employer cannot verify it (route and
  trigger), another can**; a dispute party cannot verify; link, onboarding and hand-link refused for the person they
  would credit; access for every route; the export (own statement only).
- `apps/web/src/rolePortal/growthCommission.test.tsx` (6); `growthPortal.test.tsx` updated on purpose (Commission now
  shows credit; still no amount).

**Acceptance criteria**
- [x] One live attribution per organisation — `growth_attributions_live_org_uq`, a duplicate insert refused in the spec;
  rows are only ever ended (trigger).
- [x] A conflicting referral and lead owner writes no attribution and opens a dispute — `attributeEmployerOnboarding`;
  the trigger also refuses a conflict dispute where someone is credited.
- [x] A disputant cannot decide their own dispute — route (`403`) and `growth_dispute_decider_ck`, claimant and respondent.
- [x] An operator attributed to an employer cannot verify it — route (`403`) and the verification trigger; another
  operator verifies it.
- [x] Design §18: table design first; attribution at college handoff and employer onboarding; disputes with the 90-day
  window; admin reassignment; the self-dealing guard on `OPS_VERIFY` and on linking (deferred by GROWTH-04/05); employer
  attributions written and disputable, earning nothing (D11); Android read-only "Credited to you".

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- Attribution is written only at an organisation's first handoff; a later onboarding of the same employer writes nothing.
- A conflict's dispute names the referrer as claimant; upheld credits the referrer, rejected the lead owner.
- A claim may be made on a house organisation by someone who worked on it, within the window.
- One open dispute per organisation; the window runs from the handoff, not from a later reassignment.
- Disputes and reassignment are controlled by separation (decider not a party; admin not the old or new beneficiary) and
  audit, **not** an OPS-02 approval: a new extended action key would redefine `operation_approval_extended_target_type()`
  in parallel with GROWTH-09/10, and the money a change leads to still passes a dual-controlled payout (GROWTH-12).
- Reassignment only to an ACTIVE growth person on the matching team, never while a dispute is open.
- A referral credits its owner at onboarding even if they have left; the admin list flags it.
- The verification guard covers every transition and the parties of an open dispute; a refused link or onboarding is
  done by another operator.
- Leave dates are recorded from 0110 on, not back-filled.

**Android:** changed (above). Opening a dispute is web-only by design (§18: read-only on the phone).

**Limitations / not done**
- No ledger, so nothing yet holds or moves accruals on a dispute or a reassignment (GROWTH-11 follows the events).
- The payment and approval self-dealing checks are GROWTH-09/10/12's (they reuse `growth_organization_parties`).
- No manager team view of credit (design §10.8 places it with statements, GROWTH-11).
- The approver of an OPS-02 organisation suspension is not checked against attribution (a suspension is not in the
  credited person's favour); the executor is.
- Android compiled, not run on a device.

**Validation** (`E:/one-wt/logs/validate.sh E:/one-wt/growth07 one_growth07 growth07 android` on a fresh database
`one_growth07`, only `DATABASE_URL` exported, on base 31aaaf8):
- `corepack pnpm db:migrate` twice — pass (96 applied, then 0 applied / 96 already applied); 0110 also replayed twice by
  hand with `psql -v ON_ERROR_STOP=1` — pass.
- `corepack pnpm typecheck` — pass. `corepack pnpm build` — pass.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — **exit 0, all 4 425 tests passed** (api 1 572, web 1 030,
  authorization 524, persistence 515, others), including `growth-attribution` 17/17 and every earlier growth spec. No
  "out of shared memory" in this run; nothing re-run.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR) — pass.
- CI parity: private-key, optional-chain and conflict-marker greps — clean; `corepack pnpm audit --prod --audit-level=high` — exit 0.

## GROWTH-10 — College payments received — 2026-10-02
**Result:** Complete — finance records what a college paid AI8HT (instrument, reference, integer paise, students paid for,
period), and moves it only by the listed transitions; clearance, the event commission starts from (D10), needs a second
person's `INSTITUTION_PAYMENT_CLEARANCE` approval bound to the amount, count and cleared date; anyone credited with the
college is refused; growth sees only whether a payment has cleared.
**Branch / PR:** feat/growth-college-payments (from feat/plan-phases-0-to-2 at 31aaaf8) → feat/plan-phases-0-to-2 (pushed; not merged)
**Commits:** b32e5d7 (design) · decab48 (tests) · a631969 (server) · b6c9b10 (web) · this report
**Files created:**
- `docs/architecture/institution-payments-table-design.md` (written and committed before the migration)
- `packages/persistence/drizzle/0111_institution_payments.sql`
- `packages/authorization/src/institution-payments.ts`, `institution-payments.test.ts`
- `packages/persistence/src/institution-payments.ts`
- `apps/api/src/http/operations-college-payments.controller.ts`, `institution-payments.integration.spec.ts`
- `apps/web/src/api/collegePayments.ts`, `rolePortal/collegePayments.tsx`, `rolePortal/collegePayments.test.tsx`
**Files modified:** `packages/authorization/src/high-risk-actions.ts`, `index.ts`; `packages/events/src/index.ts` (five events
and the approval key); `packages/persistence/src/operation-approvals.ts` (the queue names the college and instrument),
`institution-contract.ts` (the exit purge's out-of-scope list); `apps/api/src/http/operation-approval-gate.ts`,
`operations-approvals.controller.ts` (request validation, the approver self-dealing check, summary fields),
`api-security.module.ts`, `growth-pipeline-service.ts` (the milestone), `growth-pipeline.integration.spec.ts` (the NA pin
becomes "not reached"); web `api.ts`, `api/operations.ts`, `rolePortal/approvals.tsx`, `rolePortalPages.tsx`.
**Migrations added:** `0111_institution_payments.sql` (the number assigned). No earlier migration edited. It redefines
`operation_approval_extended_target_type()` (0051, last 0089) repeating every earlier key — CAREER_REQUIREMENT_SET_PUBLISH,
CONTENT_SKILL/QUESTION/LESSON_PUBLISH, COMMS_TEMPLATE_PUBLISH, INSTITUTION_DATA_PURGE, AI_FEATURE_ENABLE,
AI_FEATURE_LIMITS_RAISE — and adding INSTITUTION_PAYMENT_CLEARANCE (a unit test asserts every extended key is in 0111). No
capability CHECK, grant trigger or scope trigger touched. Applied twice by the migrator and replayed by hand with
`psql -v ON_ERROR_STOP=1` on a migrated database without error.

**What was built**
1. *Schema (0111).* `institution_payments`: instrument (`CHEQUE`, `DEMAND_DRAFT`, `BANK_TRANSFER`, `UPI`), reference
   (`^[A-Za-z0-9/-]{4,40}$`), `amount_paise bigint` from 1 paisa to ₹100 crore, `currency = 'INR'`, `students_paid` 1 to
   100 000, received date (not future, IST database date), coverage period (at most 3 years), state `RECEIVED → CLEARED |
   BOUNCED`, `CLEARED → REFUNDED`, any live state `→ VOIDED`. Each transition's columns are set together, once (CHECK); the
   trigger refuses every other change, any edit of what was recorded at receipt and DELETE, and stamps every time
   with `now()`. A correction is a void plus a new row naming it (`CORRECTION`, one per voided row). The same instrument
   cannot be recorded twice while it stands (a bounced cheque presented again can). `CLEARED` needs an executed
   `INSTITUTION_PAYMENT_CLEARANCE` approval for this row, executed by the clearer, whose payload carries this row's amount,
   count and cleared date. `institution_payment_credited_user()` — the self-dealing rule — reads the handoff owner at link
   (GROWTH-04) and, once GROWTH-07's `growth_attributions` exists, its live beneficiary (fails closed if that table has
   another shape).
2. *Dual control.* New OPS-02 extended key `INSTITUTION_PAYMENT_CLEARANCE` (capability `GROWTH_FINANCE`, reasons
   `BANK_STATEMENT_CONFIRMED`, `BANK_ADVICE_RECEIVED`): the request names the payment and cleared date and the server binds the
   amount and count from the row; the approver is never the requester (OPS-02's solo safeguard unchanged) and never a person
   credited with the college (`APPROVAL_SUBJECT_CONFLICT`); `POST /operations/college-payments/:id/clear` consumes it in the
   clearance's transaction (`403 APPROVAL_REQUIRED` without one).
3. *Routes* `/api/v1/operations/college-payments` — policy and list (`GROWTH_FINANCE` or `ACCOUNT_MANAGE`), record, clear,
   bounce, refund, void (`GROWTH_FINANCE`); unknown fields refused; each write one transaction with its audit row and outbox
   event (`institution_payment.recorded|cleared|bounced|refunded|voided`). Audit context and events carry no amount and no
   reference.
4. *GROWTH-04's `FIRST_PAYMENT_CLEARED`* now reads this table: reached while a payment stands `CLEARED`; otherwise "Waiting
   for the college's payment to clear." whether or not a payment was received. Never an amount, count, reference or date.
5. *Web.* Operations → Organization Detail gains "Payments received" (a section, no navigation change): college picker, four
   state counts (NA before a college is chosen), the payments table, record (rupees typed → paise by string arithmetic),
   request clearance (date, then the standard approval dialog), bounced, refunded, void, record correction; read-only for
   account managers; the existing "Not permitted" state otherwise; a plain sentence when nothing is recorded. The approvals
   queue describes and executes the clearance.
6. *INST-18.* `institution_payments` is in the exit purge's out-of-scope list (AI8HT's finance record).

**Tests added**
- `packages/authorization/src/institution-payments.test.ts` (7): vocabulary pinned to 0111's CHECKs; the key's capability,
  target and reasons; **0111 repeats every extended key**; transitions; rupees and paise (`0.29` → 29) and Indian grouping;
  amount, count and date validators.
- `apps/api/src/http/institution-payments.integration.spec.ts` (15): access (finance writes; account manager reads only;
  growth executive, growth manager and security admin 403 on every route; growth cannot file the approval); recording, with
  audit and event free of amount and reference; **students_paid 0, negative, fractional, text, null and over the bound
  refused by the route, 0 and negative by the CHECK**; amount, reference, instrument, date and period rules; non-INR,
  non-college and future dates refused by the database; duplicate instrument; **every direct edit and DELETE
  refused**; bounce, refund, void with dates and reasons, earlier columns kept, correction rules; **clearance without
  approval, before approval, by the requester (self-decision), by another executor, for another date — all refused; with a
  second person's approval it clears once; the database refuses a clearance using another payment's approval**;
  self-dealing (record refused by route and trigger, approval request refused, approver refused, other colleges allowed); the
  milestone (not reached → same words after receipt → reached after clearance with no amount, count, reference or date for
  executive and manager → not reached after a void); **a source scan: only the payments controller, the approvals controller
  and the growth milestone read the table, and the milestone imports only the yes/no read; every non-operations GET route of
  the API, called by a college admin, a student, an employer admin, a growth executive and a growth manager, returns no
  payment field or reference and answers with the same status before any payment, after a bounce, after a clearance and
  after a void**.
- `apps/web/src/rolePortal/collegePayments.test.tsx` (9).
- `growth-pipeline.integration.spec.ts`: `FIRST_PAYMENT_CLEARED` pinned as not reached (was NA) — the change this goal makes.

**Acceptance criteria**
- [x] A payment row cannot change except by the listed transitions — trigger and CHECKs, proven by direct SQL and the routes.
- [x] Clearance needs a second person — OPS-02 approval consumed in the clearance; the trigger repeats the binding.
- [x] `students_paid` must be a positive count — route validation and CHECK.
- [x] No institution, employer, student or growth route returns an amount, a student count or a cheque reference — the sweep
  over every non-operations GET route for five kinds of caller, plus the source scan.
- [x] A college's access in ONE is unaffected by any payment state — the same sweep's statuses are identical across states.
- [x] GROWTH-04's "first payment cleared" reads this table (NA replaced).
- [x] Do not: no amount on `institution_accounts`; no payment shown to a college, employer or growth person; no bank or
  payment service; no student allocation (GROWTH-08) and no commission computed.

**Decisions for Divakar** (recommended answers taken, recorded in the table design)
- The four instruments of design §11.1; bounds ₹100 crore and 100 000 students per payment, coverage at most 3 years.
- Reason codes for record, clearance, bounce, refund and void as listed in the design.
- `ACCOUNT_MANAGE` holders read payments; only `GROWTH_FINANCE` writes.
- The milestone counts only payments currently `CLEARED` (a refunded or voided one does not), shows no date, and says the
  same words before and after a receipt.
- OPS-02's solo safeguard applies to clearance as to every high-risk action while AI8HT has one approver.
- Void is allowed from every live state and keeps every earlier column; bounce, refund and void are single-person.
- Amounts and references are kept out of audit context and events; the approver sees them in the approvals queue.

**Android:** no change, by design (§18 GROWTH-10: finance is desk work; operations is view-only on Android). The only
growth-visible effect — `FIRST_PAYMENT_CLEARED` moving from NA to reached / not reached with a note — uses the milestone
contract the app already renders generically (`GrowthPipeline.kt` shows any state and its note), so the app needs no code.

**Limitations / not done**
- Allocation of students to a payment is GROWTH-08's (`institution_payment_coverages`, `growth_student_refs`); commission is
  GROWTH-11's. Nothing here computes either.
- The self-dealing rule reads GROWTH-04's handoff owner today; GROWTH-07 should confirm the attribution branch of
  `institution_payment_credited_user()` (or redefine the function) when `growth_attributions` lands.
- No "stale received payment" alert for finance.

**Risks / follow-ups**
- GROWTH-09 (rates) also adds an OPS-02 extended key. Whichever of its migration and 0111 sorts later must repeat every key,
  including `INSTITUTION_PAYMENT_CLEARANCE` → `institution_payment`; the unit test here fails if 0111's list drops one, and
  GROWTH-09 needs the same care for this key.
- `api-security.module.ts`'s controller list and `high-risk-actions.ts` are merge hotspots; this goal appends at the end.

**Validation:** pending — recorded below once the full run completes.
