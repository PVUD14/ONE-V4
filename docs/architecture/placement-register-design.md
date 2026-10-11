# Placement Register, Statistics and Drive Categories — Design

**Status:** Adopted (INST-12), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0073_drive_categories.sql`
**Relates to:** ADR-019 (institution visibility of applications), ADR-020 (readiness is a band), ADR-023
(navigation stays), ADR-024 (no compensation to institutions), ADR-038 (campus drives), INST-02 (scope
helper), INST-08 (aggregate period rule), INST-09 (placement status from shared applications), EMP-11
(campus drives, `0069`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

The placement officer reports placements to management every season (Appendix 3, I-8). ONE already
holds the raw material — campus drives (EMP-11), applications a student chose to share with the college
(ADR-019, INST-09) and the offers on them — but no screen puts it together, and the admin's Placement
page, the placement officer's Dashboard and the department head's Placement Pipeline still show NA in
the placement widgets. INST-12 adds:

1. **A register:** employers engaged (through drives or jobs addressed to the college), the drive
   calendar with outcomes, each student's consented placement status (INST-09's list, reused), students
   with at least one offer and offers accepted.
2. **College-defined drive categories** (for example Dream, Core, Mass), set in Settings and attached
   to drives.
3. **Statistics by department and batch:** eligible, applied, placed (accepted offer), placement
   percentage and offers per placed student — every count suppressed under 5.

No compensation anywhere (ADR-024): no query in this goal selects an offer's terms, and a contract test
asserts no `compensation` key or value leaves any new route.

Only (2) needs a table. Categories carry a consequence worth writing down first: they are the
college's own labels on employers' drives, and "Mass" or "Dream" read differently to the people
labelled. They are the college's internal vocabulary and must never reach an employer or a student.

## Decision summary

| Question | Decision | Rejected |
|---|---|---|
| Where do categories live? | `institution_drive_categories`, one row per college label, immutable except retiring | A text column on `campus_drives` (free text drifts: "Dream", "dream", "Dream co."); a platform-wide enum (every college names its tiers differently) |
| How is a drive categorised? | `campus_drive_category_assignments`, append-only; the latest row is current, a row with no category clears it | A column on `campus_drives` (0069 is frozen, and a category change would bump the drive revision the employer holds, turning a college-internal relabel into a 409 for the employer) |
| Who sees categories? | College readers of drives only (owner, admin, placement admin, department head) | Employers and students: a college's tiering of employers is its internal judgement |
| What period do statistics cover? | A stock "as of the end of the last ended calendar month" — every activity counted must be dated before the first instant of the current month (UTC) | Live counts (a figure that moves day by day can be differenced to follow one student — EMP-11 decision 9, INST-SR-01); a caller-chosen month (two chosen months difference into one month's movement, at a caller-chosen point) |
| Who is "eligible"? | Every student on the roster in the reader's scope whose relationship is current now, or who graduated from the college (their own season still counts), with the relationship starting before the period end | Only students who shared something (would hide the not-shared group the acceptance requires to be visible); students who transferred out or were ended (they left the batch) |
| What is "placed"? | INST-09's `ACCEPTED`: an offer accepted, or the application hired, on a shared application, dated before the period end | Offers extended (an offer is not a placement) |
| Placement percentage over what? | Placed ÷ students who shared at least one application ("of students sharing"); the not-shared group is shown beside it, never folded in as unplaced | Placed ÷ eligible: counts every student who kept their applications private as unplaced — exactly what the acceptance forbids |
| Unit filter on statistics? | None: the table is always the reader's whole scope, broken down by department and batch | `?unitId=`: a filtered aggregate beside the unfiltered one can be differenced to isolate a small group |
| Export? | Not in this goal; INST-13 builds accreditation exports on INST-08's writer and capability | A second CSV path now |

## `institution_drive_categories`

| Column | Type | Why |
|---|---|---|
| `id` | uuid PK | |
| `institution_id` | uuid NOT NULL → `organizations(id)` | The college whose label this is |
| `name` | text NOT NULL, 1–40 characters, no leading `= + - @` | Shown on drives; the formula-prefix rule matches the house input rule (INST-SR-13) |
| `description` | text NULL, ≤ 200 | What the college means by it ("Top-tier product companies") |
| `rank` | smallint NOT NULL, 1–20 | Display order; lower is listed first. It carries no rule |
| `state` | `ACTIVE` \| `RETIRED` | |
| `created_by_user_id`, `created_at` | | Who defined it |
| `retired_by_user_id`, `retired_at`, `retire_reason_code` | all or none, with `state = 'RETIRED'` | Why it stopped being offered |

- One ACTIVE category per college and case-insensitive name (partial unique index on
  `(institution_id, lower(name)) WHERE state = 'ACTIVE'`). A retired name can be reused.
- At most 20 ACTIVE categories per college — enforced in the API under a lock on the college's
  organisation row; the number keeps the Settings list a list, not a taxonomy.
- A trigger allows only ACTIVE → RETIRED, once, with nothing else changed, and refuses deletes. A
  wrong name is retired and replaced: drives already labelled keep pointing at what the college
  meant then.
- A composite unique index on `(id, institution_id)` lets assignments prove a category belongs to the
  drive's college.

## `campus_drive_category_assignments`

| Column | Type | Why |
|---|---|---|
| `id` | uuid PK | |
| `campus_drive_id`, `institution_id` | composite FK → `campus_drives(id, institution_id)` (new unique index on 0069's table) | The drive, and proof it is this college's |
| `category_id` | uuid NULL; composite FK `(category_id, institution_id)` → `institution_drive_categories(id, institution_id)` | NULL clears the category. The FK makes a category from another college unrepresentable |
| `assigned_by_user_id`, `created_at` | | Who labelled it and when |

- Append-only (trigger). The current category of a drive is its latest row by `(created_at, id)`.
- Only an ACTIVE category may be newly assigned (API); a drive keeps showing a category that was
  retired after it was assigned, marked retired.
- Writes: owner, admin or placement admin with an institution-wide write scope — the same deciders as
  EMP-11 — under a lock on the drive row (FOR UPDATE), with an `audit_events` row
  (`campus_drive.category_set`) in the same transaction. A repeated identical assignment writes
  nothing.

## Statistics

### Population and period

`T` is the first instant (UTC) of the current month; statistics describe the college as of just
before `T` ("as of 31 August"). A student is **eligible** when they are on the roster in the reader's
INST-02 scope, their account is active, and they hold a relationship with the college that began
before `T` and is either current now (`ACTIVE` / `VERIFIED`) or `GRADUATED`. Graduated students stay
in their batch: a season is reported after the batch leaves. Transferred, ended and revoked students
are not counted.

A student's **shared applications** are those submitted before `T`, shared with the college and not
revoked now (consent is honoured as of the request, not as of `T`), with every counted event
(submission, shortlisting, offer, acceptance, hire) dated before `T` **and** inside a relationship that
authorised activity then — the relationship policy's historical rule, unchanged.

### One partition per group

Each eligible student falls in exactly one stage, from their shared applications as of `T`:

| Stage | Meaning |
|---|---|
| `NOT_SHARED` | No shared application. Never "unplaced" and never "not applied" — the college cannot tell those apart |
| `APPLIED` | Shared at least one application; none reached shortlist, none brought an offer |
| `SHORTLISTED` | An application reached `SHORTLISTED` or later (from its state history, or its current state if unchanged since before `T`); no offer |
| `OFFERED` | At least one offer extended (any non-draft offer, whatever happened to it later); none accepted |
| `PLACED` | An offer accepted, or an application hired |

The funnel the pilot shows is cumulative and derived from the partition: Applied = all stages but
`NOT_SHARED`; Shortlisted = `SHORTLISTED` + `OFFERED` + `PLACED`; With an offer = `OFFERED` +
`PLACED`; Placed = `PLACED`. External declarations (0019) never move a stage, as in INST-09.

### Suppression — rows, columns and the total

Groups are (department, batch) pairs of the students' profiles. The statistics are therefore a
two-way table — groups by stage — with row totals (eligible per group), column totals (the "all
students in scope" row) and a grand total, and each margin can be subtracted from. One helper in
`aggregate-suppression.ts`, `suppressGroupedPartition`, applies the rule to all of them:

- **Cells and row totals:** each group through `suppressAggregateTable` (cells under 5 withheld, zero
  included; the row total withheld when its withheld cells sum under 5).
- **Column totals:** a column total is withheld when it is under 5, or when the withheld cells of that
  column across groups sum to between 1 and 4 — otherwise subtracting the published cells would
  recover them.
- **Grand total:** withheld when under 5; or when the hidden people behind withheld row totals sum to
  between 1 and 4; or when the hidden people behind withheld column totals sum to between 1 and 4.
- **Derived funnel values** (`publishedSubtotal`): published only when every stage in them is
  published, or when the total and every stage outside them are published (then they were derivable
  anyway). Otherwise withheld.
- **Placement percentage** is published only when both Placed and Applied are; **offers per placed
  student** only when Placed is (offers are counted on placed students' shared applications only).

This is margin-by-margin protection, the standard secondary-suppression audit for a two-way table
with its margins. It is not a full linear-programming audit; the residual is recorded below.

### Offers trend

Offers extended in each of the last six ended months, on shared applications of eligible students,
each month suppressed under 5. Months never overlap, and no total is published beside them.

## Register

- **Employers engaged:** employers with a drive at the college that the college approved (APPROVED,
  SCHEDULED or COMPLETED), or a published job addressed to the college (`INSTITUTION` or
  `INSTITUTION_UNIT` audience). Per employer: name, drives by state, jobs addressed to the college, last
  engagement date. No people are counted.
- **Drive calendar and outcomes:** the college's drives (newest scheduled first, 200 at most) with the
  employer, job, state, dates, venue and category. Outcomes appear only once a drive is COMPLETED
  (EMP-11's rule), and count only applications through the drive that students **shared** with the
  college, of eligible students in the reader's scope — so every register count reconciles with
  consented records. EMP-11's own results view still counts every linked application; the two differ
  by design and the difference is raised below.
- **Per-student status:** INST-09's audited, keyset-paginated list, unchanged.

## Who may read and write

| Route | Who |
|---|---|
| `GET …/placement-statistics`, `GET …/placement-register` | Owner, admin, placement admin, department head — scoped by INST-02; faculty 403 |
| `GET …/drive-categories` | The same readers |
| `POST …/drive-categories`, `POST …/drive-categories/:id/retire`, `POST …/campus-drives/:id/category` | Owner, admin, placement admin with an institution-wide write scope (EMP-11's deciders) |

Aggregate reads are not audited (as INST-07's pipeline); category writes are, in the same transaction.

## Open points (decisions for Divakar)

1. **Drive outcome counts differ between EMP-11 and the register.** EMP-11's drive results count every
   application through a completed drive; the register counts only shared ones. **Recommended:** align
   EMP-11's counts to shared applications, so a college never learns an aggregate about applications no
   student shared (not changed here — it is EMP-11's tested behaviour).
2. **Ranked tier exceptions** (a Dream drive open to offer holders by default) are not built: EMP-11's
   per-drive flag still governs. Categories carry no rule yet.
3. **Statistics as of month end** means a placement made today appears next month. The alternative, a
   live figure, reopens differencing; recommended: keep.
4. **Residual differencing:** consecutive monthly snapshots observed over time give each month's
   movement; relationship and consent changes after a month ends change that month's figures; the
   grouped table is protected margin by margin, not by a full linear audit; drive outcomes and the
   statistics are separate tables over overlapping people. All counts stay under the one threshold.
5. **No Drives navigation item (HG-3):** decision 10.2 #4 recommends one; the plan's fallback is taken —
   the register is a section of the placement officer's Dashboard and of the admin's Placement page.
