# Skill Map Editor — Design

**Status:** Adopted (OPS-09a), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0057_skill_map_editor.sql` (no new table; one approval key, two guards)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `career-catalogue-table-design.md` (OPS-08, 0051), `career-target-drafts-table-design.md` (ENG-11, 0056),
`high-risk-approvals-table-design.md` (OPS-02, 0038), the 0004 content lifecycle

## Why this exists

A verified track needs a skill map: the skills a role is measured on, what each skill looks like at each level, and
which skills come before which. Today the only way a skill reaches the live taxonomy is an engineer running a seed
(the pilot published two topics by hand). ENG-11 left the thirteen SOC Analyst L1 skills as **pending topics** —
inactive `TOPIC` nodes with an unpublished `DRAFT` content revision — and recorded that "no operator path yet publishes
a topic's content revision and switches the topic on". The C01 requirement set cannot publish until they are live
(0056 rule 3).

This editor is that path. An operator with `CONTENT_EDIT` drafts a skill, a different person with `CONTENT_REVIEW`
reviews it (including its rights), and a person with `CONTENT_PUBLISH` who wrote none of it publishes it through a
release manifest; a publish that changes what students are measured against also needs a second person's approval.

What a skill *is* for the product is unchanged: it is a `taxonomy_nodes` row of kind `TOPIC`, the kind every
requirement, mastery projection, gap, exam mapping and lesson is keyed on. The editor adds no parallel skill table.

## Decision 1: a skill is a TOPIC node; its content is a versioned content revision

**Chosen.** One `taxonomy_nodes` row per skill, identity fixed by its id and `stable_key`. Everything the editor writes
about the skill lives in the body of a `content_revisions` row (`entity_type = 'TOPIC'`, `entity_id` = the node id),
numbered 1, 2, 3 … per skill (`content_revision_entity_uq`). The node's `content_revision_id` points at the revision
students and staff currently see.

- **A new skill**: node inserted `active = false`, `source = 'AUTHORED'`, pointing at revision 1 in `DRAFT`. That is
  exactly a pending topic in 0056's sense, so an OPS-08 requirement set can already name it as a draft.
- **A pending topic from ENG-11**: already this shape (`AGENT_DRAFTED`). The editor edits its revision 1 in place.
- **A live skill**: a new revision *n+1* is started from the published body. The node keeps pointing at the
  published revision until *n+1* is published; only then does it move.

**Node `version` is not bumped.** Under 0004, a new `(kind, stable_key, version)` is a new node with a new id.
Every requirement, evidence record, projection and exam mapping points at the old id, so a new node per edit would
orphan all of them. The content revision number is the skill's version.

**Rejected: a new node row per revision.** Orphans every reference, above.
**Rejected: a `skills` table beside the taxonomy.** ENG-11 rejected it for the same reason: two identities for one
skill, and a mapping layer before the gap engine could use it.
**Rejected: `kind = 'SKILL'` nodes.** Nothing reads them (ENG-11, Decision 2).

## Decision 2: the revision body (schema `skill-map/v1`)

```json
{
  "schema": "skill-map/v1",
  "stableKey": "soc-alert-triage",
  "name": "Alert triage",
  "description": "…",
  "levels": { "AWARE": "…", "GUIDED": "…", "INDEPENDENT": "…", "TROUBLESHOOT": "…" },
  "prerequisites": ["soc-security-monitoring-siem", "soc-security-fundamentals"],
  "rights": { "licenceLabel": "AI8HT-Owned", "attribution": null },
  "basis": "…"
}
```

| Field | Rule |
| --- | --- |
| `stableKey` | `^[a-z0-9][a-z0-9-]{2,79}$` (ENG-11's rule); set at creation, never edited; unique among TOPIC nodes |
| `name` | 1–160 characters |
| `description` | 1–1000 characters |
| `levels` | The four levels of the goal, in order: **AWARE** (knows what it is), **GUIDED** (does it with help or a runbook), **INDEPENDENT** (does it unaided), **TROUBLESHOOT** (diagnoses and fixes it when it goes wrong). Each a descriptor of what a learner can do, ≤ 500 characters. A draft may leave some empty; **submitting for review needs all four**. |
| `prerequisites` | Stable keys of other skills, ≤ 20, no duplicates, never itself; each must be a live or pending TOPIC (never retired, never unknown); the whole map stays acyclic (Decision 3) |
| `rights.licenceLabel` | `AI8HT-Owned`, `CC-BY-4.0` or `CC-BY-SA-4.0`. Required to submit. |
| `rights.attribution` | ≤ 300 characters; required to submit when the licence requires attribution (both CC licences) |
| `basis` | ≤ 2000 characters: the citation the content rests on (for ENG-11's skills, the NQR criterion) |

Keys the editor does not own are **carried unchanged** from revision to revision: ENG-11's `expertCheck`, `packKey`
and `provenance` stay in the body the reviewer reads, so "check this against the qualification file" is never lost
by an edit. Levels are text, never numbers: nothing here is a score, and no level maps to a readiness value.

The validator is pure (`packages/career-readiness/src/skill-map.ts`), shared by the API and the persistence layer.

## Decision 3: prerequisites in the body, checked with the existing acyclic check

No prerequisite table exists between topics (ENG-11 recorded the same), and nothing computes on prerequisites yet —
a table now would have no reader. Prerequisites therefore live in the revision body, **versioned and reviewed with
the skill** they belong to, which is what "versioned through the content lifecycle" asks.

Acyclicity is checked with `assertAcyclicPrerequisites` (packages/career-readiness, the lesson check) with stable keys
as the node ids, twice:

1. **On every draft save and submit**, over the map as it is being built: for this skill, the draft; for every other
   live or pending skill, its latest revision (its open draft if it has one, else its published body). Two drafts
   that would close a cycle between them are refused as soon as the second is saved.
2. **On publish**, over the map as it will be live: for this skill, the revision being published; for every other
   skill, its published body. And every prerequisite must already be **live** — a live skill never depends on an
   unreviewed one, so skills publish in prerequisite order (for C01: networking fundamentals before OS log sources
   before SIEM monitoring before alert triage).

**Rejected: a `topic_prerequisites` table with a DAG trigger** (the `lesson_prerequisites` pattern). It would need
its own versioning to match the body it describes, and has no reader. The planner or ENG-10 can promote the published
bodies into a table when something consumes them.

## Decision 4: the lifecycle is 0004's, with the author rule widened to contributors

States and moves are exactly 0004's (`assertContentTransition`):

```
DRAFT ──submit──▶ IN_REVIEW ──approve (+ rights review)──▶ APPROVED ──publish──▶ PUBLISHED
                    │    ▲
      request changes    └── resubmit
                    ▼    │
               CHANGES_REQUESTED  (editable again)
```

| Move | Capability | Refused when |
| --- | --- | --- |
| Create a skill, start a revision, save a draft (DRAFT or CHANGES_REQUESTED) | `CONTENT_EDIT` | another revision of the skill is open; the body is invalid |
| Submit / resubmit (→ IN_REVIEW) | `CONTENT_EDIT` | levels, licence or attribution missing; prerequisites unknown or cyclic |
| Request changes (→ CHANGES_REQUESTED) | `CONTENT_REVIEW` | the actor is a contributor |
| Approve (→ APPROVED), with the rights review | `CONTENT_REVIEW` | the actor is a contributor |
| Publish (→ PUBLISHED) | `CONTENT_PUBLISH` (+ an approval, Decision 6) | the actor is a contributor; a prerequisite is not live; the map would cycle |

**Contributors.** 0004 stops the *author* approving (`enforce_content_review_separation`). An editor who is not the
revision's author is just as much its writer: if operator B edits operator A's draft, B must not approve it either.
The contributors of a revision are its `author_user_id` plus everyone with an
`operations.content.skill_draft_saved` audit row for it. Audit rows are written in the save's transaction and are
never updated or deleted (Appendix 1 §5.2), so the list cannot be edited after the fact.

For ENG-11's agent drafts the author is the importer user (`ENGINE_CONTENT_IMPORTER_USER_ID`). The person who fills
in the levels becomes a contributor, and review and publish fall to someone else — which is the point.

At most **one open revision per skill** (DRAFT, IN_REVIEW, CHANGES_REQUESTED or APPROVED), enforced under a row lock
on the node. There is no "withdraw": 0004's lifecycle has none, and an open draft can always be edited.

Published revisions are immutable (0004 trigger `protect_published_content_revision`), so an older published
revision stays `PUBLISHED`; which one is current is the node's pointer.

## Decision 5: the rights review is real, and publishing goes through a release manifest

A content revision reaches `PUBLISHED` only with a `release_manifest_id` (0004 CHECK), a manifest reaches `APPROVED`
only if every item's `source_records` row is `release_eligible` (0004 trigger), and a source record is release
eligible only with `rights_state = 'APPROVED'`. The editor uses that pipeline unchanged — nothing bypasses rights.

**At approval** the reviewer confirms the rights the author declared, with a rights reason code
(`OWNERSHIP_VERIFIED` for `AI8HT-Owned`, `LICENCE_VERIFIED` for a CC licence). In the approval's transaction:

| Row | Written |
| --- | --- |
| `migration_runs` | one per reviewed revision: `package_identity = 'ops-skill-map:<revision id>'`, `source_repository = 'one-operations-console'`, `transform_version = 'skill-map-editor-v1'`, `status = 'STAGED'`, started by the reviewer. `source_commit` holds the **SHA-1 content address of the reviewed body**: console-authored content has no repository commit, and the column's CHECK asks for a 40-hex address. `manifest_hash` is the revision's `content_hash`. |
| `source_packages` | its package, `source_paths = ['console://skill-map/<stable key>/r<revision>']` |
| `source_records` | `source_entity_type = 'SKILL_MAP_REVISION'`, `source_record_id` = the revision id, `source_hash` = its content hash, the declared licence and attribution, rights/SME/quality `APPROVED`, `MAPPED`, `UNIQUE` (the stable key is unique), `ELIGIBLE`, release eligible. Created once, in its final state: source records are immutable (0004). |
| `rights_reviews` | the reviewer, `APPROVED`, the licence, the attribution requirement, the rights reason code |
| `quality_reviews` | one `SME` review by the reviewer, `APPROVED`, the review reason code |
| `content_provenance` | source record → the TOPIC node at this revision number |

A reviewer who finds the rights wrong requests changes with `RIGHTS_NOT_CLEARED`; nothing is recorded as approved.

**At publish**, in one transaction: a release manifest named `Skill map: <stable key>`, version = the revision
number, one item (the revision, its source record, its hash); approved by the revision's reviewer; published by the
actor; the revision moves to `PUBLISHED` with a `PUBLISH` review action; the node takes the body's name and
description, points at the revision and becomes `active`. 0056's `taxonomy_node_draft_guard` is satisfied by
construction: the revision is `PUBLISHED` before the node that points at it is switched on.

**Rejected: one shared "console" source package for every skill.** Its single `source_commit` would have to be a
made-up value, and its hash could not describe what was reviewed. One package per reviewed revision is honest.
**Rejected: marking the source record eligible at creation (import time).** That is the bypass the goal forbids:
rights must be decided by a reviewer, after the content is final.

## Decision 6: when a publish needs an approval

Appendix 1 §5.4: "publishing content that changes readiness inputs also needs an approval". A skill publish changes
readiness inputs when:

1. **It is the skill's first publish.** A new live topic becomes measurable: institutions can map exam subjects to
   it, evidence can be recorded against it, and requirement sets naming it become publishable. Every pending topic
   is in this case, including all thirteen C01 skills.
2. **The skill is named by a live requirement** (`career_role_requirements`). The definition students' gaps are
   measured against changes.

Otherwise (a revision of a live skill no role requires yet) the publish needs `CONTENT_PUBLISH` only. The rule is the
pure function `skillPublishAltersReadinessInputs` in packages/authorization, evaluated against rows read under lock.

The approval action is **`CONTENT_SKILL_PUBLISH`** (capability `CONTENT_PUBLISH`, target type `content_revision`,
target id = the revision id). Its payload binds `{ revisionId, contentHash, reasonCode }`: an APPROVED revision is
frozen, and the hash makes "the exact action payload" of §5.4 literal. The approval is requested only for an
`APPROVED` revision that needs one, and only by someone who is not a contributor (they will execute it). The solo
safeguard, expiry and requester-is-not-approver rules are OPS-02's, unchanged.

Any publish may carry an approval; if one is given it is consumed, so an approval granted while the rule applied is
never left dangling if a requirement stops naming the skill in between.

## Migration 0057

1. **Approval key.** `CREATE OR REPLACE FUNCTION operation_approval_extended_target_type` adds
   `CONTENT_SKILL_PUBLISH → content_revision` beside 0051's `CAREER_REQUIREMENT_SET_PUBLISH`. This is the extension
   mechanism 0051 documented; the key lives in `extended_action_key`, so 0038's CHECK is never involved. A later
   goal adding a key must repeat both keys in its replacement.
2. **The author never publishes their own skill** (`content_review_author_publish_guard`, BEFORE INSERT on
   `content_review_actions`): a `PUBLISH` action by the revision's author is refused for `TOPIC` revisions. 0004
   refuses only `APPROVE`. Scoped to TOPIC so the engine-content path (which refuses it in code already) and the
   other entity types keep exactly their behaviour. The one other writer of TOPIC publishes is the pilot seed, which
   takes separate author and publisher users (`CAREER_READINESS_AUTHOR_USER_ID`, `…_PUBLISHER_USER_ID`; every test
   uses distinct users); a deployment that set both to one person would now be refused, which is the rule.
   Contributors beyond the author are enforced in the API (the audit-derived list above).
3. **A live topic moves only to published content of its own** (`taxonomy_node_published_content_guard`, BEFORE
   UPDATE on `taxonomy_nodes`, named to fire after 0056's guard): for a `TOPIC`, changing `content_revision_id`
   requires the new revision to be a `PUBLISHED` TOPIC revision of this node, and switching `active` on requires the
   node's revision to be `PUBLISHED`. 0056 enforces the second for agent-drafted nodes only; this extends it to every
   topic on update. Inserts are untouched (the pilot seed and existing fixtures insert directly). Nothing in the
   codebase updates `taxonomy_nodes` today, so no existing path changes.

Idempotent: `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`. It applies once under
ADR-035 and survives a bootstrap replay.

## Audit and events

Audit (every write, in its transaction, `resource_type = 'content_revision'`, resource id = the revision, with the
reason code, the topic id and stable key, and `break_glass` when it applies):
`operations.content.skill_created`, `…skill_revision_started`, `…skill_draft_saved`, `…skill_transitioned`,
`…skill_rights_reviewed`, `…skill_published`.

Outbox events (registered in `packages/events`, identifiers and enums only; no consumer yet):
`skill_map.revision_state_changed` and `skill_map.skill_published`.

## What students and staff see

Students see nothing until a publish, and then only what a live topic already gives them (a named topic in a gap,
evidence against it). Levels and prerequisites are not shown to students by this goal. The operator screen sits
under the existing **Content Management** label, below the job-role catalogue; no navigation item is added, removed,
renamed or reordered (HG-3). Android: operator surfaces are web-only (Appendix 1 §4.3).

## Open points (decisions for Divakar)

1. **Thirteen approvals for C01.** Each first publish is a readiness-input change, so the thirteen SOC skills need
   thirteen approvals (each with the 15-minute solo cooling-off while Divakar is the only approver). Recommended:
   keep per-skill approvals for now; a batch "publish these skills together" action bound to one approval is a
   small follow-up if the queue proves tedious.
2. **All four levels required to submit.** Some skills may have no meaningful TROUBLESHOOT level. Recommended: keep
   it required; the descriptor can say what troubleshooting means for that skill.
3. **Licence list.** `AI8HT-Owned`, `CC-BY-4.0`, `CC-BY-SA-4.0`. Recommended as above; adding one is a code change.
4. **Retiring a skill** (switching a live topic off) is not built: it would change gaps and needs its own rules.
