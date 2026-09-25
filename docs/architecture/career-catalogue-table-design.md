# Career Catalogue — Table Design

**Status:** Adopted (OPS-08), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0051_career_catalogue.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Input:** `docs/ops/inputs/job-role-catalogue.md` (Appendix 4, transcribed; 108 roles, 13 goals)

## Why this exists

Students will choose from 108 campus roles. Today five roles are seeded from `data/careers/starter-v1.json` by an
engineer, their requirements are written straight into `career_role_requirements`, and the gap engine
(`computeCareerGap`, fed by `packages/persistence/src/career-targets.ts`) reads that table as the truth. There is no
catalogue code, family, branch or release label, no synonyms, no versioning and no review: whoever runs the seed
changes what every student's gap says.

A requirement set is consequential. It is the denominator of every student's gap and one of the inputs the
readiness band is explained against. Appendix 1 §5.4 lists "Publish a career-role requirement set or any change
that alters readiness or gap results" as a dual-controlled high-risk action. This design adds the catalogue, puts
requirement changes behind draft → review → approved publish, and leaves the gap engine and every existing student
target exactly as they are.

## Decision: extend `career_roles`, do not add a parallel catalogue table

**Chosen.** Catalogue columns on `career_roles` (0011). `student_career_targets`, `career_gap_snapshots` and
`career_role_requirements` already point at `career_roles.id`; a catalogue role *is* a career role.

**Rejected: a `career_catalogue_roles` table joined 1:1.** Two rows per role means two titles, two "active" flags
and a join on every student read, and the first time they disagree a student sees one role and is measured
against another.

**Rejected: `taxonomy_nodes` of kind `CAREER_ROLE`.** The kind exists in 0004 but nothing uses it. A taxonomy node
needs a `content_revision_id` from the content release pipeline and is versioned by `(kind, stable_key, version)`;
student targets reference `career_roles`, not nodes. Moving roles there would give each role two identities.

### Columns added to `career_roles`

| Column | Notes |
| --- | --- |
| `catalogue_code` | text NULL, CHECK `^[SDCELMPVB][0-9]{2}$`, unique (partial index) — S01…B14. NULL for a role outside the catalogue. |
| `catalogue_family` | text NULL, CHECK in `A`–`F` — the six families of Appendix 4. Required when `catalogue_code` is set. |
| `catalogue_title` | text NULL, 1–160 chars — the catalogue's own name for the role (see "Starter roles" below). |
| `eligible_branches` | text[] NOT NULL DEFAULT `{}` — the "Typical branches" cell as a list, source wording kept (`All branches`, `Any`, `CSE`, `maths-strong branches`, …). Each element 1–60 chars. |
| `core_skill_areas` | text NULL, ≤ 1000 — the catalogue's **draft** skill areas. Planning text; nothing computes on it. |
| `main_evidence` | text NULL, ≤ 500 — the catalogue's "Main evidence" cell. Planning text. |
| `planned_release` | text NULL, CHECK in `V1`, `V2`, `V3` — the release the plan gives the role a full track in. NULL = selectable with no plan. |
| `release_label` | text NULL, CHECK in `SELECTABLE`, `VERIFIED` — what the role *is* today. Required when `catalogue_code` is set. |
| `origin` | text NOT NULL DEFAULT `STARTER`, CHECK in `STARTER`, `CATALOGUE` — who created the row. Every existing row reads `STARTER`. |
| `catalogue_version` | text NULL, `^[a-z0-9-]{3,40}$` — which catalogue file last wrote the catalogue columns (`catalogue-v1`). |

Every 0011 constraint stays: code, title, family and summary CHECKs, the unique lower(code) index. Catalogue roles use
their catalogue code as `code` (`S02` matches `^[A-Z0-9_]{2,64}$`).

**Branch filter.** A role matches branch *X* when `eligible_branches` contains *X* (case-insensitive) or contains
`All branches` / `Any`. "CSE, IT, any" therefore matches every branch, as the source says.

### Release label and planned release are different things

Appendix 4's "Release" column says when a role is *planned* to get a full track (`V1 verified` for C01, `V2 verified`
for 13 roles, `V3 verified` for 38, `Selectable` for 56). None of those tracks exists today. So:

- `planned_release` stores the plan (V1/V2/V3, or NULL for Selectable).
- `release_label` is **`SELECTABLE` for all 108 roles at seed**. The goal forbids seeding anything as verified
  "except existing verified roles", and there are none: no role has the placement test, path, tutor and evidence
  that "verified" means, C01 included.
- A role becomes `VERIFIED` only through an approved requirement-set publish whose payload says so (below). No
  other write path exists, and seeding never changes a label an operator has already set.

## Starter roles map onto catalogue rows; nothing is duplicated

The five starter roles become the catalogue rows they are, so a student who targeted one keeps the same
`career_roles.id`, the same requirements and the same gap:

| Starter code | Starter title | Catalogue | Why |
| --- | --- | --- | --- |
| `SOC_ANALYST` | Security Operations Analyst | C01 SOC Analyst L1 | Named by the goal |
| `SOFTWARE_ENGINEER` | Software Engineer | S01 Associate Software Engineer / Programmer Analyst Trainee | The general entry-level engineering role; S02 is backend-specific |
| `DATA_ANALYST` | Data Analyst | D01 Data Analyst | Same role |
| `BUSINESS_ANALYST` | Business Analyst | S21 IT Business Analyst | The starter summary is requirements work between business and delivery teams; B02 is operations reporting |
| `CUSTOMER_SUCCESS` | Customer Success Associate | B11 Customer Success Associate | Same role |

On a mapped row the catalogue seed writes only the catalogue columns. `code`, `title`, `family` and `summary` stay
what the starter seed wrote — students already know the role by that name, and the starter seed (which overwrites
those four columns on every run) would otherwise fight the catalogue seed. The catalogue's name is kept in
`catalogue_title`, and operator search covers both. `origin` stays `STARTER`.

**Rejected: renaming the starter rows to the catalogue titles.** Two idempotent seeds overwriting each other's
titles is a flip-flop, and renaming a live target under a student is a visible change with no student benefit.

## Students see the catalogue only behind a flag

New catalogue rows are `origin = 'CATALOGUE'`. Feature flag **`career-catalogue.selectable-roles`**, default off, is
created by 0051 (`INSERT … ON CONFLICT DO NOTHING`):

- **Off** (default): the student catalogue and the selection endpoint behave exactly as today — only
  `origin = 'STARTER'` rows are offered or accepted, and the response carries no new field values.
- **On** (globally, or by organisation / user override): all active roles are offered and accepted, each with its
  `releaseLabel`, and the Android picker shows "Not yet verified" on every `SELECTABLE` role, as Appendix 4 requires
  ("an honest 'not yet verified' label").

Selection is checked server-side against the same rule, so a hidden role cannot be targeted by posting its id.
Existing targets are never cleared by the flag.

## Synonyms: a new table, not `taxonomy_aliases`

`taxonomy_aliases` (0004) references `taxonomy_nodes`, which roles are not (above). So:

`career_role_synonyms`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `career_role_id` | uuid NOT NULL → `career_roles(id)` |
| `synonym` | text NOT NULL, 2–120 chars, not starting with `= + @ -` (the 0011 title rule, against formula injection in exports) |
| `normalized` | text NOT NULL — lower-case, single-spaced; CHECK that it equals `lower(regexp_replace(btrim(synonym), '\s+', ' ', 'g'))` |
| `reason_code` | text NOT NULL, `^[A-Z0-9_:-]{3,64}$` |
| `created_by_user_id` | uuid NULL → `users(id)` (NULL only for a seed) |
| `created_at` | timestamptz NOT NULL DEFAULT now() |
| `removed_at`, `removed_by_user_id`, `removed_reason_code` | all NULL or all set, `removed_at ≥ created_at` |

Unique `(career_role_id, normalized)` among live rows. The same words may map to several roles ("developer" → S01–S04):
Appendix 4 has the student confirm the match, so a synonym is a pointer, not an identity. Removal is a soft delete so
the audit trail and the history of what students could search for survive. No synonyms are seeded — the catalogue
lists none, and inventing them would be invented data.

## Requirement sets: versioned, reviewed, published under dual control

`career_role_requirements` stays the **live** set and stays the only thing the gap engine reads — `loadRequirements`
and `computeCareerGap` are not changed. Versioning lives beside it:

`career_requirement_sets`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `career_role_id` | uuid NOT NULL → `career_roles(id)` |
| `version` | integer NOT NULL > 0; unique per role |
| `state` | `DRAFT`, `IN_REVIEW`, `REVIEWED`, `PUBLISHED`, `SUPERSEDED`, `WITHDRAWN` |
| `based_on` | text NOT NULL, `EMPTY`, `LIVE` (copied from the live table) or `SET` (copied from a set) |
| `based_on_set_id` | uuid NULL → `career_requirement_sets(id)`; set iff `based_on = 'SET'` |
| `created_by_user_id`, `created_at`, `reason_code` | the author and why the draft exists |
| `submitted_by_user_id`, `submitted_at` | set on DRAFT → IN_REVIEW |
| `reviewed_by_user_id`, `reviewed_at`, `review_reason_code`, `review_note` | set on IN_REVIEW → REVIEWED; cleared again if sent back |
| `published_by_user_id`, `published_at`, `publish_approval_id` (→ `operation_approvals`), `publish_reason_code`, `release_label_at_publish` | set on REVIEWED → PUBLISHED |
| `superseded_at`, `withdrawn_at`, `withdrawn_reason_code` | terminal stamps |

`career_requirement_set_items`: `set_id`, `topic_id` (→ `taxonomy_nodes`), `requirement_level`, `target_mastery`,
`rationale`, `required_evidence_types` — the same CHECKs as `career_role_requirements` (0011, and 0050 for
evidence types), unique `(set_id, topic_id)`.

### Lifecycle

```
DRAFT ──submit──▶ IN_REVIEW ──review passed──▶ REVIEWED ──publish (CONTENT_PUBLISH + approval)──▶ PUBLISHED ──▶ SUPERSEDED
  ▲                   │                            │
  └──changes requested┘◀───────────────────────────┘ (back to DRAFT)
DRAFT / IN_REVIEW / REVIEWED ──withdraw──▶ WITHDRAWN
```

Rules, each enforced by the 0051 trigger as well as the API, so a second writer cannot skip them:

1. Items can be written only while the set is `DRAFT`. Submitting freezes the content; the approval binds the set
   id, so "the exact payload" of §5.4 is the frozen content.
2. At most one open set (`DRAFT`/`IN_REVIEW`/`REVIEWED`) and at most one `PUBLISHED` set per role (partial unique
   indexes).
3. **The reviewer is never the author.** A self-review is refused. (OPS-09 applies the same rule to content.)
4. `PUBLISHED` requires `publish_approval_id` to name an `EXECUTED` approval for action
   `CAREER_REQUIREMENT_SET_PUBLISH` whose target is this set. The approval is consumed in the publish transaction.
5. Publishing, in one transaction: consume the approval; supersede the previous published set; replace the role's
   rows in `career_role_requirements` with the set's items; set `release_label` from the approved payload; write
   the audit row and the `career_requirement_set.published` outbox event.
6. Sets are never deleted; published and superseded sets are immutable.

Existing starter requirements have no set. The role detail shows them as "live, not versioned (starter seed)", and
an operator starts version 1 from them (`based_on = 'LIVE'`). The starter seed keeps writing the live table exactly
as before: it is an engineer-run deployment step, not an operator path, and changing it is out of this goal.

Gaps are snapshots (0011). Publishing does not recompute anyone's gap inside the request (§5.7): a student's gap is
recomputed by the existing paths (their next recompute or evidence change). The published event lets a worker do it
later; no consumer is built here.

### Required evidence types

`required_evidence_types` uses the `evidence_records.evidence_type` vocabulary (`LESSON_COMPLETION`,
`ASSESSMENT_OUTCOME`, `TOPIC_DEMONSTRATION`), so a requirement can only ask for evidence the product can record.
ENG-04 (branch `feat/eng-learning-model`, migration 0050, not yet merged) adds the same column to
`career_role_requirements`. 0051 declares it **identically** — `ADD COLUMN IF NOT EXISTS`, the same constraint name
and definition — so whichever merges first, replaying both converges on one column. Publish copies the item's
types into it.

## Capabilities and reason codes

| Action | Capability |
| --- | --- |
| Read the catalogue, role detail, sets | `CATALOGUE_MANAGE`, `CONTENT_REVIEW` or `CONTENT_PUBLISH` |
| Add / remove a synonym; create, edit, submit or withdraw a draft | `CATALOGUE_MANAGE` |
| Pass a review or send a set back | `CONTENT_REVIEW` (and not the author) |
| Request, and then execute, a publish | `CONTENT_PUBLISH`, plus an approval from a second person with `APPROVE_HIGH_RISK` |

None of these is in any role's baseline (§6.2; OPS-01 D2): they are granted explicitly, and the super admin holds
them as break-glass — every break-glass use is audited with `break_glass: true`.

Reason codes are defined in code (`packages/authorization/src/career-catalogue.ts`), per write.

## Adding the approval action without breaking the migrator

OPS-02 planned to add each new action key "by a new migration that widens the CHECK". That cannot work with this
migrator. `migrate.ts` replays every file on every run, and 0038 drops and re-adds `operation_approval_action_ck`
(and `operation_approval_target_ck`) with its original five keys. Once one row carries a sixth key, the next migrate
fails in 0038, because `ADD CONSTRAINT … CHECK` validates existing rows. Editing 0038 is forbidden.

**Chosen: extension columns, validated by a replaceable function.**

- 0051 adds `extended_action_key` and `extended_target_type` to `operation_approvals` and drops NOT NULL from
  `action_key` and `target_type`.
- A new CHECK (`operation_approval_action_extension_ck`) requires exactly one of each pair: 0038's columns for
  0038's five keys, or the extension columns for any later key. A NULL `action_key` satisfies 0038's CHECK on every
  replay, so 0038 never fails again.
- The extension vocabulary (`CAREER_REQUIREMENT_SET_PUBLISH` → `career_requirement_set`) lives in the function
  `operation_approval_extended_vocabulary()`, called by a BEFORE INSERT OR UPDATE trigger. A later goal adds a key
  with `CREATE OR REPLACE FUNCTION` in its own migration. Replays converge on the newest definition because later
  files run later, and the function never re-validates existing rows.
- The same trigger makes `action_key`, `target_type` and both extension columns immutable with `IS DISTINCT FROM`.
  0038's own guard compares with `<>`, which a NULL would slip past.
- `packages/persistence/src/operation-approvals.ts` writes a legacy key to `action_key` and any other key to
  `extended_action_key`, and reads `COALESCE(action_key, extended_action_key)`. Every caller keeps seeing one
  `actionKey`.

**Rejected: widen `operation_approval_action_ck` in 0051.** It is correct until the first publish, then breaks
every later migrate on every database that has published.
**Rejected: a separate approvals table for the catalogue.** It would duplicate the 0038 guard, the solo safeguard
and the Settings queue, and two approval paths drift.
**Rejected: an apply-once migration tracking table.** That would fix the root cause, but it changes how every
environment migrates and removes the self-healing replay that other goals rely on (PRG-FIX). It is Divakar's
decision, not this goal's.

## Goals G01–G13 are not stored

Program rule and the goal: store goals only if the engine plan's goal model exists. No goal table exists on any
branch (checked 2026-09-26: no `*goal*` table in any migration on any `onev4` ref). The 13 goals are recorded as
**pending** in `docs/ops/inputs/job-role-catalogue.md` and under `goals` in `data/careers/catalogue-v1.json`,
marked `stored: false`, for the goal that builds the goal model to load.

## Events and audit

Audit actions (every write, in the write's transaction, with the reason code and `break_glass` when it applies):
`operations.career_catalogue.synonym_added`, `…synonym_removed`, `…requirement_set_created`,
`…requirement_set_items_saved`, `…requirement_set_transitioned`, `…requirement_set_published`.

Outbox events (registered in `packages/events`): `career_requirement_set.state_changed` and
`career_requirement_set.published`, carrying identifiers and enums only.

## Seeding

`data/careers/catalogue-v1.json` is generated from the input file by
`packages/persistence/src/career-catalogue-input.ts`. `packages/persistence/test/career-catalogue-input.test.ts`
re-parses the markdown on every test run and fails if the JSON drifts or a count is wrong. It checks
108 = S 25, D 9, C 9, E 13, L 7, M 14, P 6, V 11, B 14; planned releases 1 V1, 13 V2, 38 V3 and 56 selectable; and
goals G01–G13.

`corepack pnpm --filter @planthepath/persistence db:seed:career-catalogue` runs the seed the way `db:seed:careers`
does. It uses deterministic ids, is idempotent, maps the starter roles, never changes a `release_label` it did not
set, writes no requirement set and publishes nothing.

## Open points (decisions for Divakar)

1. **Starter mappings** SOFTWARE_ENGINEER → S01 and BUSINESS_ANALYST → S21. The alternatives are S02 and B02.
   Recommended as above.
2. **Self-review** is refused. With one operator, a requirement set therefore needs a second person to review it.
   That is intended; the solo safeguard covers approvals only. Recommended: keep it.
3. **Every publish needs an approval.** This includes a publish whose items equal the live set. Recommended: keep it.
   Any publish can change a label or a gap, and a rule that says "unless it changes nothing" is a rule someone
   argues with.
4. **The migrator.** Replace replay-every-file with apply-once tracking, or keep extension columns as the pattern
   for every later approval key? Recommended: keep the extension pattern until Divakar decides. It is recorded in
   this document for the next goal that adds a key.
