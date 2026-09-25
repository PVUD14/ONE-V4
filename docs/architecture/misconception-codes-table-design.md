# Misconception Codes — Table Design (and the governance shared by the ENG-07 tables)

**Status:** Adopted (ENG-07), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0049_misconceptions_and_teaching_strategies.sql` (with `question_option_misconceptions`
and `teaching_strategies`, designed in `question-option-misconceptions-table-design.md` and
`teaching-strategies-table-design.md`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** ADR-034 (TypeScript online, data rules), ADR-033 (no model in the decision loop),
`0004_v4_career_readiness.sql` (content lifecycle), program Part B.8 (content written by Claude Code)

## Why this exists

A wrong answer is information only if we know *which* wrong idea it points to. Today ONE records that a
student chose option `a` and that `a` was wrong (`assessment_responses`), and nothing else. The planner
(ENG-08) needs more than "wrong": scenario X1 is a student who gets subnet host counts right but subnet
boundaries wrong three times, and the right response is block-size practice, not a fourth identical
question. That needs a named, reviewed catalogue of misconceptions per skill, a statement of which
distractor signals which misconception, and a catalogue of teaching strategies the planner can choose
between. Those are the three ENG-07 tables. This document covers `misconception_codes` and the
governance all three share.

## Governance: reuse the 0004 content lifecycle, not a parallel one

The three tables are **content**, and content in ONE already has a governed lifecycle: `content_revisions`
(`DRAFT → IN_REVIEW → CHANGES_REQUESTED/APPROVED → PUBLISHED → ARCHIVED`), `content_review_actions`
(every transition, with reason code and correlation ID), a trigger that rejects an author approving their
own revision (`enforce_content_review_separation`), a trigger that makes a published or archived revision
immutable (`protect_published_content_revision`), and publication only through a release manifest whose
source records passed rights review (`enforce_release_manifest_eligibility`). The question bank the
engine uses is governed by exactly this lifecycle (`question_versions.content_revision_id`), and the
OPS-09b question editor is specified against it.

**Chosen.** Every row in the three tables points at its own `content_revisions` row
(`content_revision_id`, one-to-one). 0049 widens `content_revisions.entity_type` with three values —
`MISCONCEPTION`, `QUESTION_OPTION_MISCONCEPTION`, `TEACHING_STRATEGY` — keeping every existing value.
Review, approval and publication are the existing actions on that revision. Nothing new decides who may
approve: the 0004 trigger does.

**Rejected: the learner-content pattern (`learner_content_items.review_state` + `learner_content_reviews`,
0024/0026).** It is a second lifecycle: its review rows have no author-≠-approver trigger, no reason
codes, no release manifest and no rights review, and it governs non-assessment guide text. Misconception
tags change how a graded answer is interpreted, so they belong with the graded item bank's lifecycle, not
the guide-text one. Using it would put the question and the tag on its distractor under two different
review regimes.

**Rejected: a bespoke `*_reviews` table per engine table.** Three more copies of the transition rules to
drift from the one in `packages/career-readiness` (`assertContentTransition`) and the 0004 triggers.

### Provenance on the row (AGENTS.md, program B.8)

AGENTS.md requires anything a model produces to be stored "as a row carrying `source`,
`generator_version`, `prompt_version`, `review_state`, `generated_at`, and lands as `DRAFT`". Each of the
three tables therefore carries:

| Column | Notes |
| --- | --- |
| `source` | text NOT NULL, CHECK in (`AUTHORED`, `AGENT_DRAFTED`). `AUTHORED` = typed by a person. `AGENT_DRAFTED` = written by a coding agent (Claude Code) into the repository and imported, which B.8 classes as model-produced. **`GENERATED` (an orchestrated model call) is deliberately not allowed yet** — the AI hold (ADR-030, HG-2); ENG-23 adds it with its own migration, as 0024 did for learner content. |
| `generator_version` | text NULL, 1–128. Which model/agent produced it (e.g. `claude-opus-5-5`). |
| `prompt_version` | text NULL, 1–128. The goal/brief it was produced under (e.g. `eng-07-teaching-strategies-v1`). |
| `generated_at` | timestamptz NULL. |
| `review_state` | text NOT NULL, the lifecycle state. **A mirror of the revision's `state`, never an independent value** — see below. |
| `basis` | text NOT NULL, 1–4000. What the content rests on: a citation, a qualification file, a textbook section, the author's reasoning. B.8 "cite their basis". |
| `expert_check_notes` | text NULL, 1–4000. The claims a subject expert must check. **Required when `source = 'AGENT_DRAFTED'`** (CHECK), because B.8 requires every such claim to be marked. |

CHECKs: `source = 'AUTHORED'` ⇒ `generator_version`, `prompt_version`, `generated_at` all NULL;
`source = 'AGENT_DRAFTED'` ⇒ all three NOT NULL and `expert_check_notes` NOT NULL.

### `review_state` is the revision's state, mirrored — one source of truth

Two independent state columns would disagree. So:

- **Insert** (BEFORE INSERT trigger): the referenced revision must exist, have the right `entity_type`,
  have `entity_id = NEW.id`, have `author_user_id = NEW.created_by_user_id`, and be in `DRAFT`. The
  trigger sets `NEW.review_state := 'DRAFT'`. **Every row, from any source, lands as DRAFT** — the rule
  AGENTS.md states for model output is applied to everything, because nothing here needs a shortcut.
- **Revision transitions** (AFTER UPDATE OF `state` on `content_revisions`): the new state is copied onto
  the engine row that references the revision. This trigger touches only rows in the three new tables;
  other entity types are unaffected.
- **Direct edits** (BEFORE UPDATE trigger on each table): `review_state` must equal the revision's current
  state (so it cannot be set by hand); business fields may change only while the revision is `DRAFT` or
  `CHANGES_REQUESTED` (a reviewer never approves something that then changes under them; published
  content never changes); identity and provenance columns (`id`, `code`, `version`, `source`,
  `generator_version`, `prompt_version`, `generated_at`, `content_revision_id`, `created_by_user_id`,
  `created_at`, and for a tag `question_revision_id`, `option_id`, `misconception_code_id`) never change —
  a different tag is a new row.
- **Delete** is rejected. Abandoned drafts stay as history, like `content_revisions`.

### Publication

Publishing goes through a release manifest exactly as the pilot does (`publishCareerReadinessPilot`):
items are added while the manifest is `DRAFT`, the manifest is approved and published, then each revision
moves `APPROVED → PUBLISHED` with a `PUBLISH` review action. The persistence function
`publishEngineContentRelease` does this in one transaction and refuses unless every revision is
`APPROVED`, belongs to one of the three engine entity types, and **the publisher is not the author of any
of them** (OPS-09 rule "the author cannot review or publish their own item"; the 0004 trigger enforces
only the approve half). The source record must be release-eligible (0004 trigger), so rights review is
not bypassed.

**Nothing written by the agent is published by the agent.** The ENG-07 draft pack (seven teaching
strategies) is imported as `DRAFT` only; `publishEngineContentRelease` is exercised in tests on synthetic
data inside a rolled-back transaction.

### Who reads published rows

Only published rows are ever read by engine code (`resolveResponseMisconceptions`,
`listPublishedTeachingStrategies`). Draft rows are reachable by no student route and no screen: this goal
adds no API route and no UI. The editor (OPS-09b) will add authoring routes under `CONTENT_EDIT` /
`CONTENT_REVIEW` / `CONTENT_PUBLISH`.

## The table: `misconception_codes`

One row = one **version** of one misconception.

| Column | Notes |
| --- | --- |
| `id` | uuid PK. Also the `entity_id` of its revision. |
| `code` | text NOT NULL, `^[A-Z][A-Z0-9_]{2,63}$`, e.g. `SUBNET_BOUNDARY_OFF_BY_ONE`. Stable across versions; what `learner_skill_state` lists as an active code. |
| `version` | integer NOT NULL, > 0. `UNIQUE (code, version)`. A changed meaning is a new version, never an edit of a published one. |
| `skill_id` | uuid NOT NULL → `taxonomy_nodes(id)`. Trigger: node `kind` in (`SKILL`, `TOPIC`). See "Skill". |
| `title` | text NOT NULL, 1–160. Short staff-facing label. |
| `description` | text NOT NULL, 1–2000. What the student believes and why it is wrong. |
| `basis`, `expert_check_notes`, `source`, `generator_version`, `prompt_version`, `generated_at`, `review_state` | As above. |
| `content_revision_id` | uuid NOT NULL UNIQUE → `content_revisions(id)`, `entity_type = 'MISCONCEPTION'`. |
| `created_by_user_id` | uuid NOT NULL → `users(id)`. Equals the revision author. |
| `created_at` | timestamptz NOT NULL DEFAULT now(). |

Indexes: `(skill_id, code)`; partial `(code, version) WHERE review_state = 'PUBLISHED'`.

### Skill

The plan says a misconception belongs to a *skill*. ONE's taxonomy already has a `SKILL` kind
(`taxonomy_nodes.kind`), but no skill nodes exist yet (the skill map is ENG-10 / OPS-09a); readiness-check
questions and ENG-03's attempt rows carry a `TOPIC`. So `skill_id` accepts a `SKILL` or a `TOPIC` node,
enforced by trigger (a CHECK cannot look at another table). *Rejected:* `SKILL` only — nothing could be
tagged until ENG-10, and every existing question is topic-level. *Rejected:* a free-text skill key — it
would not join to the taxonomy the rest of the engine uses.

### Versions and published history

More than one version of a code may be published at once: a tag points at a **specific** version, so a
question tagged against v1 keeps meaning v1 until someone tags it against v2. The resolver returns a tag
only while both the tag and its code version are `PUBLISHED`, so archiving either would withdraw it.
**But archiving is not possible today:** the 0004 trigger `protect_published_content_revision` rejects
every update of a published revision, including `PUBLISHED → ARCHIVED`, and this goal does not relax it.
Withdrawing a published code or tag therefore needs its own decision (see open points).

## Recording a misconception on an attempt and in learner skill state

The goal's acceptance — "a wrong option tagged with a code records that code on the attempt and in
`learner_skill_state`" — needs two tables that are **not on this branch**: `learning_attempt_events`
(ENG-03, migration 0047, in flight in parallel) and `learner_skill_state` (ENG-05, not started). This goal
must not depend on either, so it delivers the resolution and designs the link:

- **Built here.** `resolveResponseMisconceptions(db, responses)` in
  `packages/persistence/src/misconceptions.ts` returns, for each `(question_version_id,
  selected_option_id)`, the published codes of that option — and nothing for a correct option, an
  untagged option, a draft tag, or a tag whose code is not published. The pure rule
  (`misconceptionsForResponse`, algorithm `misconception-tagging-v1`, `packages/career-readiness`) is what
  decides; the persistence function only loads published tags.
- **Designed, left out (ENG-03 / ENG-05 own the columns).** A later migration, numbered after both 0047
  and 0049, adds to `learning_attempt_events`:
  - `selected_option_id text NULL` — the option chosen (NULL for non-choice items and blanks);
  - `misconception_code_ids uuid[] NOT NULL DEFAULT '{}'` — the `misconception_codes.id` values
    `resolveResponseMisconceptions` returned, **fixed at insert** in the same transaction as the grading,
    so a later re-tag never rewrites history (the attempt log is append-only). No FK on an array; the ids
    are resolved server-side from the paper, never from client input.

  and ENG-05's projector derives `learner_skill_state.active_misconception_codes` (the `code` strings) from
  those attempt rows, keyed by `misconception_codes.skill_id`. When those land, the acceptance test is:
  submit a wrong tagged answer → the attempt row carries the code id → a rebuild shows the code active.
  *Rejected:* adding the columns to 0047's table from 0049 — 0049 does sort after 0047, but the brief
  forbids this goal depending on an unmerged branch, and the columns belong to the attempt log's design.

## Consent and privacy

The three tables hold content, not student data. The only personal reference is the staff author
(`created_by_user_id`), kept exactly as `content_revisions.author_user_id` already is. Recording a code on
a student's attempt is ENG-03's row and inherits its consent and erasure rules (ADR-034: engine behavioural
data is ERASED on deletion); deriving active codes is ENG-05's projection, written only with the
`adaptive-learning` purpose (ENG-01).

## Readiness

Nothing here reads or writes readiness. A misconception code never changes a band, a mastery projection
or evidence; it only informs what to teach next (ENG-08).

## Open points (decisions for Divakar)

1. **Who may approve engine content in production.** Today the only content approvers are whoever the
   OPS-09 editor will grant `CONTENT_REVIEW` / `CONTENT_PUBLISH`. Recommended: a subject expert per track
   for misconception codes and tags (they are claims about how students think in that subject), and
   Divakar for teaching strategies. Nothing is published until then.
2. **Withdrawing published content.** The 0004 trigger makes a published revision immutable, archive
   included, so a wrong published misconception or tag cannot be retired. Recommended: a later migration
   lets `protect_published_content_revision` allow exactly `PUBLISHED → ARCHIVED` (state, nothing else),
   for every content type at once, as its own reviewed change — not an engine-only exception.
