# Career Target Drafts — Table Design

**Status:** Adopted (ENG-11), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0056_career_target_drafts.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** `career-catalogue-table-design.md` (OPS-08, 0051) — requirement sets, their lifecycle and dual-controlled publish
**Content it carries first:** `docs/career-readiness/soc-analyst-l1-target-v1.md` and `data/engine/soc-analyst-l1-target-v1.draft.json`

## Why this exists

ENG-11 asks for a draft career target for catalogue role C01 (SOC Analyst L1): requirements with levels, target
mastery, rationale and required evidence types, linked to skills. The content is written by the coding agent, so it
is model-produced (program Part B.8, `AGENTS.md` "AI"): it must land as `DRAFT`, carry `source`,
`generator_version`, `prompt_version`, `review_state` and `generated_at`, cite its basis, and reach no student
until a person approves it.

Two things stop that from fitting OPS-08 as it stands:

1. **No provenance on a requirement set.** `career_requirement_sets` records who drafted a set and why, but not
   that a model (or an agent) wrote it. A reviewer cannot tell an agent draft from a human one, and nothing stops
   that fact being lost.
2. **The skills do not exist.** A requirement points at a `taxonomy_nodes` TOPIC. The published taxonomy holds two
   topics (`professional-communication`, `interview-foundations`, from the pilot). SOC Analyst L1 needs about a
   dozen more (log analysis, alert triage, …). A topic is published content: it has a `content_revisions` row and
   goes live through the release pipeline. The draft cannot point at topics that do not exist, and it must not
   create *live* topics either — every topic picker (institution exam mapping in `exam-evidence-bridge.ts`,
   operator topic search, the starter seed, student hiring) lists `kind = 'TOPIC' AND active` topics, so a new
   active topic would reach staff screens before anyone reviewed it.

## Decision 1: provenance columns on `career_requirement_sets`

| Column | Notes |
| --- | --- |
| `source` | text NOT NULL DEFAULT `'AUTHORED'`, CHECK in (`AUTHORED`, `AGENT_DRAFTED`). Every existing set reads `AUTHORED` — which is what they are (operators drafted them by hand in the OPS-08 editor). |
| `generator_version` | text NULL, 1–128 chars. The generator (for this goal, the coding agent's model id). |
| `prompt_version` | text NULL, 1–128 chars. The versioned brief the draft was written against (`eng-11-soc-analyst-l1-target-v1`). |
| `generated_at` | timestamptz NULL. When the draft pack was written. |
| `source_basis` | text NULL, 1–2000 chars. The citation the draft rests on (here: the NQR qualification file and the NICE work role). |

CHECK `career_requirement_set_provenance_ck`: `AUTHORED` has all four NULL; `AGENT_DRAFTED` has all four set. This is
the rule 0049 already uses for engine content, so every agent-drafted row in the product reads the same way.

`review_state` is the set's own `state` (`DRAFT` → `IN_REVIEW` → `REVIEWED` → `PUBLISHED`). A second column would be
a copy that can disagree with the lifecycle 0051 enforces.

**Immutable.** A trigger (`career_requirement_set_provenance_guard`) refuses any change to the five columns after
insert. Provenance is written once, by the insert that creates the set (`createRequirementSetDraft` takes an optional
provenance argument). A human editing an agent draft does not make it `AUTHORED`: the review record says who
checked it, the provenance says where it came from.

**Rejected: provenance in the audit row only.** The audit row is there, but the reviewer's screen and the publish
check read the set, not the audit log, and audit context is free-form JSON.
**Rejected: a separate `career_target_drafts` table.** A second home for the same set means two lifecycles; OPS-08
already has the lifecycle, the reviewer-is-not-the-author rule and dual-controlled publish.

## Decision 2: skills are TOPIC nodes that start *pending*

The skills of the target are new `taxonomy_nodes` rows of kind `TOPIC` — the kind every requirement, mastery
projection and gap already uses — each with its own `content_revisions` row in state `DRAFT` and **`active = false`**.

Columns added to `taxonomy_nodes`, same shape and CHECK as Decision 1 (`source`, `generator_version`,
`prompt_version`, `generated_at`; no `source_basis` — the node's content revision body carries its citation). Every
existing node reads `AUTHORED`.

**Pending topic** (the term used in code): a TOPIC node with `active = false` whose content revision is in `DRAFT`,
`IN_REVIEW`, `CHANGES_REQUESTED` or `APPROVED` — content on its way to publication, not content that was retired.
A retired topic (published, then deactivated; its revision is `PUBLISHED` or `ARCHIVED`) is not pending.

Rules, enforced in the database so a second writer cannot skip them:

1. **An agent-drafted topic goes live only once published** (`taxonomy_node_draft_guard`): a node with
   `source = 'AGENT_DRAFTED'` may be `active` only while its content revision is `PUBLISHED`. Inserting one active,
   or activating it before its revision is published, is refused. `AUTHORED` nodes keep today's behaviour.
2. **Provenance is immutable** on the node, as on the set.
3. **Nothing goes live on a topic that is not live** (`career_requirement_live_topic_guard`): a
   `career_role_requirements` row may be inserted or changed only for an active topic, and a requirement set may
   move to `PUBLISHED` only when every one of its items points at an active topic. Before this, nothing checked
   either; the pilot and starter seeds only ever wrote active topics, so nothing existing is affected.

And one rule in the API path, `saveRequirementSetItems`: a **draft** may reference an active topic *or a pending
one*. Before, it accepted active topics only. This is the one widening in this goal, so its limits are exact: it
admits only topics on their way to publication (never a retired one, never an unknown id, never a non-TOPIC node),
only into a set that is still a `DRAFT`, and rule 3 makes it impossible for such a set to publish until every topic
it names has been published. `publishRequirementSet` checks the same thing first and refuses with
`CAREER_TOPIC_NOT_LIVE`, so the operator sees a named reason rather than a database error.

Why this order is right: a reviewer should judge the requirement set and the skills it names together, before
either reaches a student. Forcing the skills to be published first would put unreviewed-for-this-role topics live on
staff screens (exam mapping) with nothing to measure against.

**Rejected: create the topics active.** Every topic picker lists active topics; an institution could map exam
subjects to an unreviewed skill and start writing evidence against it.
**Rejected: insert the items with raw SQL, bypassing `saveRequirementSetItems`.** The program asks for the existing
authoring path; a side door that skips the topic check is how a check stops meaning anything.
**Rejected: `kind = 'SKILL'` nodes.** The kind exists but nothing reads it: requirements, projections, gaps, exam
mapping and lessons are all keyed on TOPIC ids. A SKILL node would need a mapping to topics before the gap engine
could use it — a skill map in two layers for no gain today. The skill map ENG-10 builds can adopt the same
pending-TOPIC pattern.
**Rejected: a new `skills` table.** Same reason, and it would fork the taxonomy.

### Prerequisites ("linked skills in the skill map")

No prerequisite table exists between topics (only `lesson_prerequisites`). The pack records each skill's
prerequisites in its content revision body (`prerequisites: [stableKey…]`), validated as known and acyclic by the
import. Nothing computes on them yet; the planner (ENG-08) or ENG-10's skill map can adopt them. Adding a table now
would be a table with no reader.

## The import path

`packages/persistence/src/career-target-drafts.ts`:

- `validateCareerTargetDraftPack(pack)` — pure. Refuses a pack whose provenance is incomplete, whose items name an
  unknown skill, whose levels, targets (0 < t ≤ 1, three decimals), rationale (≤ 500) or evidence types break the
  0051 CHECKs, whose prerequisites are unknown or cyclic, or where any requirement or skill lacks a citation or an
  expert-check note (Part B.8: "mark every claim that needs subject-expert checking").
- `importCareerTargetDraftPack(db, pack, actor)` — one transaction:
  1. finds the role by `catalogue_code` (C01), refusing if the catalogue has not been seeded;
  2. creates each skill as a pending TOPIC (DRAFT revision, inactive node, `AGENT_DRAFTED` provenance), or reuses
     one already there with the same stable key — so a rerun creates nothing twice;
  3. if the role already has an open set: returns it unchanged when it is this pack's own draft (same
     `prompt_version`), and refuses otherwise — an import never overwrites a person's draft;
  4. else calls `createRequirementSetDraft` with the pack's provenance, then `saveRequirementSetItems` — the same
     functions, audit rows and events the operator screen uses.
  It never submits, reviews, approves or publishes.

`corepack pnpm --filter @planthepath/persistence db:import:career-target-draft` runs it with
`ENGINE_CONTENT_IMPORTER_USER_ID` (the ENG-07 convention) as the author. The importer is therefore the set's author,
and 0051 already stops the author reviewing it: a second person must review, and publishing needs `CONTENT_PUBLISH`
plus a second person's approval.

## Audit and events

Unchanged vocabulary. The set's creation and items are audited by the OPS-08 functions
(`operations.career_catalogue.requirement_set_created`, `…_items_saved`); each new topic writes
`engine.content.topic_drafted` (resource `taxonomy_node`). No new outbox event type: a pending topic is visible to
nothing that would consume one.

## What students and staff see

Nothing, until a person acts. The set is a `DRAFT` visible only on the operator catalogue screen (Content
Management, existing labels). The new topics are inactive, so no picker lists them and no gap measures them. The
operator screen shows that the set is agent-drafted (generator, prompt version, date, basis) and marks each
requirement whose skill is not yet published — so the reviewer knows what they are judging. No navigation changes
(HG-3).

## Open points (decisions for Divakar)

1. **Publishing the skills.** No operator path yet publishes a TOPIC revision and activates its node (the pilot
   seed did it by hand; OPS-09's content editor is the natural home). Until one exists, this set can be reviewed but
   not published. Recommended: build it with OPS-09, reusing the release-manifest path; keep rule 3 either way.
2. **The two starter requirements** (`professional-communication` ESSENTIAL 0.75, `interview-foundations`
   IMPORTANT 0.60) are carried into the draft unchanged, because the draft starts from the live set and changing
   them silently would change today's gaps on publish. Recommended: the reviewer decides; the content document
   flags them.
