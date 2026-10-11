# Growth Territories and Regions — Table Design

**Status:** Adopted (GROWTH-02), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** `0099_growth_territories.sql` (new; no existing migration is edited, and no function defined
by an earlier migration is redefined)
**Parent design:** `growth-portal-design.md` §4 (territories), §4.2 (who sees which region), §16 (surfaces);
decision record ADR-040 (D3: teams work by region / geo-locations in India)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Growth staff work Indian territories (D3). Every later growth goal reads territory: who may see an
unowned lead (GROWTH-03), which region a handed-off college belongs to for regional rates (GROWTH-09,
GROWTH-11), regional targets (GROWTH-13). Territory decides **who sees which organisations' pipeline**,
so a wrong row leaks one salesperson's work to another, and a silently changed row rewrites who could
have claimed a lead on a given day. That is why it is designed before it is built, and why every row is
append-only with a reason.

## 1. The model

India is **state or union territory → district**. City or town is free text on a lead (GROWTH-03).

| Table | What a row is | Written by |
|---|---|---|
| `growth_states` | one of the 36 ISO 3166-2:IN subdivisions | the migration (seed), never the API |
| `growth_districts` | one district, keyed by its Local Government Directory (LGD) code | an audited CSV import by a `GROWTH_ADMIN` holder |
| `growth_district_imports` | one committed district import (who, when, which file digest, counts) | the import commit |
| `growth_regions` | a named sales region (`South-1`, `NCR`) | a `GROWTH_ADMIN` holder |
| `growth_region_areas` | "region R covers state S" or "region R covers district D of state S", from when to when | a `GROWTH_ADMIN` holder |
| `growth_territory_assignments` | "person P works region R as EXECUTIVE or MANAGER", from when to when | a `GROWTH_ADMIN` holder |

## 2. `growth_states` — seeded, because the list is a public fact

| Column | Rule |
|---|---|
| `code` | primary key, `^IN-[A-Z]{2}$` |
| `name` | 1–80, English name as ISO lists it (without diacritics) |
| `kind` | `STATE` or `UNION_TERRITORY` |

**Seeded with exactly 36 rows (28 states, 8 union territories)**, copied from ISO 3166-2:IN as amended
by ISO 3166 OBP newsletter changes of 2019-11-22 (Jammu and Kashmir became a union territory; Ladakh
added), 2020-11-11 (Dadra and Nagar Haveli and Daman and Diu merged as `IN-DH`) and 2023-11-23 (codes
changed to `IN-OD` Odisha, `IN-CG` Chhattisgarh, `IN-TS` Telangana, `IN-UK` Uttarakhand). The migration
cites the source in a comment. These are not invented data (AGENTS.md): they are the published national
list, the same for every user. `INSERT … ON CONFLICT (code) DO UPDATE SET name, kind`, so a replay is a
no-op and a later correction is a later migration.

Immutable to the API: there is no route that writes it. A trigger refuses DELETE (districts, areas and
leads point at it).

**Rejected: no state table, a CHECK listing the codes.** Districts and areas need a foreign key, and the
Territory screens need the names.

## 3. `growth_districts` — imported, because districts change every year

| Column | Rule |
|---|---|
| `lgd_code` | primary key, `integer > 0` — the LGD district code |
| `state_code` | → `growth_states(code)` |
| `name` | 1–120 |
| `created_at` | `now()` |
| `created_import_id` | → `growth_district_imports(id)` — the import that first brought it |
| `renamed_at`, `renamed_import_id` | the last import that changed its name, or NULL |

- **Not seeded.** India creates and splits districts every year; a seeded list goes stale and a stale
  list in a migration cannot be corrected without another migration. The Local Government Directory
  (`lgdirectory.gov.in`) publishes the official list as CSV. A `GROWTH_ADMIN` holder downloads it and
  imports it.
- **A district never changes state.** A row whose code exists under another state is refused in the
  import report (`DISTRICT_STATE_MISMATCH`), and a trigger repeats the rule, because a district moving
  state would silently move every lead and area under it.
- **A district is never deleted** (trigger), because areas and leads refer to it. A district that LGD
  has retired simply stays; it can no longer be added as a new area once a later goal marks it, which is
  not needed yet. **Rejected: deleting districts absent from the newest file** — a partial file (one
  state) would then delete the rest of India.
- **Renames are allowed, through the import only.** LGD corrects spellings. The new name replaces the
  old one; the old name, the new name and the import are in the import's `audit_events` context (one
  entry per renamed code), so the history is answerable. Only `name`, `renamed_at` and
  `renamed_import_id` may change (trigger).

### 3.1 The import: dry run first, then exactly what was previewed

The content bulk import (OPS-09d) is the pattern:

1. **Preview** (`POST /api/v1/operations/growth-territories/district-imports/preview`): the CSV (≤ 1 MB,
   ≤ 2 000 data rows). The server returns a row-level report — each row `NEW`, `UNCHANGED`, `RENAMED` or
   an error code — and a SHA-256 digest of the file plus the report. **Nothing is written.**
2. **Commit** (`…/commit`): the same file, the preview digest and a reason code (`INITIAL_IMPORT`,
   `LGD_UPDATE`, `CORRECTION`). The server re-evaluates; if the evaluation changed (someone else imported
   meanwhile) it answers `409 IMPORT_STALE` with the fresh report; if any row is an error it answers
   `400`. Otherwise it writes all rows or none, in one transaction with one `growth_district_imports`
   row, one `audit_events` row (`operations.growth_districts.imported`, with counts and the renamed
   codes) and one `growth.districts.imported` outbox event.

Columns are matched by header, case- and punctuation-insensitively, so the LGD download can be used as
it is: `district code` / `district lgd code` / `district_code`; `district name (in english)` /
`district name` / `district_name`; and the state as `state code` (ISO `IN-XX`) or `state name (in
english)` / `state name`. A state name is matched against the 36 seeded names after normalising (lower
case, `&` → `and`, a leading `the` dropped, everything but letters removed). A state the file names that
matches nothing is a row error (`STATE_UNKNOWN`), never a guess. Other LGD columns (census code, Hindi
name) are ignored. A code appearing twice in one file is an error on the second row
(`DISTRICT_CODE_DUPLICATE`).

`growth_district_imports`: `id`, `filename` (1–200), `file_digest` (64 hex), `row_count`,
`created_count`, `renamed_count`, `unchanged_count`, `reason_code`, `imported_by_user_id`, `created_at`.
Append-only (trigger refuses UPDATE and DELETE).

## 4. `growth_regions`

| Column | Rule |
|---|---|
| `id` | uuid |
| `name` | 2–60, `^[A-Za-z0-9][A-Za-z0-9 &()./-]*$` — a name, never a person's name by rule of use (the screen says so) |
| `created_by_user_id`, `created_at`, `reason_code` | `NEW_REGION`, `REORGANISATION`, `CORRECTION` |
| `retired_at`, `retired_by_user_id`, `retired_reason_code` | set together, once: `REORGANISATION`, `NO_LONGER_WORKED`, `CORRECTION` |

- Name unique among live regions, case-insensitively (partial unique index on `lower(name)`).
- **Append-only except retiring, once** (trigger). A rename is a retire plus a new region: regional rates
  and targets later key on the region id, and a renamed region that silently meant something else would
  carry the old rates.
- **A region in use cannot be retired** (`409 GROWTH_REGION_IN_USE`): it must have no live area and no
  live assignment, so retiring never silently drops coverage or a person's territory. The trigger
  repeats the rule.
- DELETE refused.

## 5. `growth_region_areas`

| Column | Rule |
|---|---|
| `id` | uuid |
| `region_id` | → `growth_regions(id)`; the region must be live at insert (trigger) |
| `state_code` | → `growth_states(code)` |
| `district_code` | NULL (the whole state) or → `growth_districts(lgd_code)`, whose state must be `state_code` (trigger) |
| `added_by_user_id`, `added_at`, `reason_code` | `NEW_COVERAGE`, `TERRITORY_CHANGE`, `CORRECTION` |
| `removed_at`, `removed_by_user_id`, `removed_reason_code` | set together, once: `TERRITORY_CHANGE`, `REGION_RETIRING`, `CORRECTION` |

**The two acceptance rules, in the database:**

1. **One area in at most one live region.** Two partial unique indexes on live rows:
   `(state_code) WHERE district_code IS NULL` and `(district_code) WHERE district_code IS NOT NULL`. The
   index, not code, decides a race.
2. **A whole-state area and a district area of the same state cannot both be live in different
   regions** (trigger). The trigger takes a transaction advisory lock keyed on the state code first, so
   two concurrent inserts (one whole-state, one district) serialise and the second sees the first.
   **Decision taken (recommended):** the trigger refuses the combination in the *same* region too. A
   whole state already covers its districts, so a district row beside it is redundant, and two rows
   that mean the same thing are two places for a later removal to disagree. The messages differ, so the
   screen can say which.

Append-only except the removal, once (trigger). Moving an area to another region is a removal plus an
addition, so "which region covered Mysuru on 3 March" is answerable from the rows. DELETE refused.

## 6. `growth_territory_assignments`

| Column | Rule |
|---|---|
| `id` | uuid |
| `region_id` | → `growth_regions(id)`; live at insert (trigger) |
| `membership_id` | → `organization_memberships(id)`: an ACTIVE growth membership of the platform organisation at insert (trigger) |
| `assignment_role` | `EXECUTIVE` (needs a `GROWTH_EXECUTIVE` membership) or `MANAGER` (needs a `GROWTH_MANAGER` membership) — trigger |
| `starts_at` | `now()` |
| `assigned_by_user_id`, `reason_code` | never the assigned person (trigger); `NEW_ASSIGNMENT`, `TERRITORY_CHANGE`, `COVERAGE`, `CORRECTION` |
| `ended_at`, `ended_by_user_id`, `ended_reason_code` | set together, once: `TERRITORY_CHANGE`, `WORKLOAD`, `LEFT_REGION`, `CORRECTION`; or `MEMBERSHIP_ENDED` with no person, written by the database |

- One live row per `(region_id, membership_id)` (partial unique index).
- **Every assignment change is audited with its reason** (acceptance): the API writes an `audit_events`
  row (`growth.territory_assignment.started` / `.ended`, context: region, membership, role, reason) and an
  outbox event in the same transaction as the row. The reason is on the row too, so the history survives
  without the audit table.
- **A membership that ends ends its live assignments** in the same statement (trigger on
  `organization_memberships`, reason `MEMBERSHIP_ENDED`) — the 0091 team-row pattern, in a new trigger
  function so 0091's function is not redefined. A **suspended** membership keeps its rows (suspension is
  reversible), but its scope is empty because only ACTIVE memberships count (§7).
- **A growth membership cannot change role while it holds a live assignment** (a new `BEFORE UPDATE OF
  role` trigger), so an `EXECUTIVE` assignment never points at a manager membership.
- Append-only except the end, once; DELETE refused.

**Rejected: future-dated assignments** (`starts_at` chosen by the operator). Visibility follows the
assignment *today* (§4.2); an assignment that exists but has not started is a second meaning for "live"
that every scope query would have to repeat. An operator assigns on the day.

## 7. Who sees which region: `growthScopeFor`

One pure function, `packages/authorization/src/growth-scope.ts`, the way `institution-scope.ts` does it
for colleges (INST-02): every growth read composes its predicate from it; no controller writes its own.
Its inputs are loaded in one place (`packages/persistence/src/growth-scope.ts`) from rows as they stand
**now** — live assignments of ACTIVE memberships, live team rows — so visibility follows today's
assignment with no cache.

- **Executive** (`GROWTH_EXECUTIVE`, ACTIVE): leads they own, anywhere; plus unowned leads in the
  regions of their live `EXECUTIVE` assignments.
- **Manager** (`GROWTH_MANAGER`, ACTIVE): every lead, owned or not, in the regions of their live
  `MANAGER` assignments; plus leads owned by anyone whose live team row names them as manager; plus their
  own.
- **GROWTH_ADMIN holder** (an operator, from Operations): everything.
- Anyone else, or a growth person whose memberships are all suspended or ended: nothing.

A lead's area is its district, or its state when the district is unknown. A region covers a lead when
it has a live area for the lead's district, or a live whole-state area for the lead's state.
**Decision taken (recommended):** a lead with a state and no district falls only in a region that
covers the *whole* state, not in every region holding some district of it — the narrower reading,
because the wider one would show an unowned lead to several regions' staff at once. Until someone sets
its district it is visible to its owner, the managers of a whole-state region, and growth admins. A lead
with neither is visible only to its owner and growth admins (design §4.2).

GROWTH-02 has no leads yet; the function and the SQL predicate it produces are built and tested now,
and GROWTH-03 composes every lead read from them. The Territory page uses the same scope to list the
regions a person works.

## 8. Surfaces

- **Operations → Settings → "Growth set-up"** (`GROWTH_ADMIN`; a section of the existing Settings page,
  no navigation change, O-24): the states with their imported district counts; the district import
  (dry run, then commit); regions (create, retire); areas (add a whole state or a district, remove);
  assignments (assign a growth person as executive or manager, end). Every change takes a reason code
  from the server's fixed list.
- **Growth → Territory** (web, approved navigation): the regions the person works today, each with its
  areas and its people (managers see everyone assigned to their regions; executives see their region's
  managers, so they know whom to ask). Unowned-lead counts read NA until GROWTH-03.
- **Android "My territory"** (read-only, a Territory tab in the Growth app): the same read. Territory
  set-up is desk work and stays off the phone (design §14.1).

No route returns a student, an amount, or anything about a growth person beyond the work email of the
people assigned to the same region.

## 9. Events

Registered in `packages/events/src/index.ts`, identifiers and enums only:
`growth.region.created`, `growth.region.retired`, `growth.region_area.added`, `growth.region_area.removed`,
`growth.territory_assignment.started`, `growth.territory_assignment.ended`, `growth.districts.imported`.

## 10. Privacy

None of these tables holds personal data about anyone outside AI8HT. An assignment says which region a
staff member works — the staff member's own work record (design §13.5). It refers to the membership,
not to an email, so erasing a user (which anonymises the `users` row) leaves an assignment that names
nobody. The growth person sees their own assignments on the Territory page; the privacy export of their
own data is GROWTH-15's (design §18).

## Open points (decisions taken for Divakar, recommended and built)

- A whole-state and a district area of the same state are refused in the same region too (§5).
- A state-only lead falls only in a whole-state region (§7).
- Districts are never deleted by an import; renames are allowed and audited (§3).
- A region in use cannot be retired; a rename is retire plus create (§4).
- Assignments start on the day they are made; no future dating (§6).
