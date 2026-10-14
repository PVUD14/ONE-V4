# Question Hint Ladders — Table Design

**Status:** Adopted (OPS-09b), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0061_question_bank_editor.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `0004_v4_career_readiness.sql` (content lifecycle, `question_versions`), `0047_learning_attempt_log.sql`
(`highest_hint_level` 0–4, the assisted rule), `misconception-codes-table-design.md` (provenance and the
mirrored `review_state`), `question-bank-editor-design.md` (the editor that writes it)

## Why this exists

Appendix 1 OPS-09b asks the question bank editor for a **four-step hint ladder** per question, and says to
create the hint table here "only if the engine plan has not". It has not: ENG-03 (0047) already records the
highest hint level a learner used on an attempt (`highest_hint_level`, 0–4) and applies the assisted rule
(hint 3 or higher is never unaided, `learning_attempt_assisted_ck`), but no table holds the hints
themselves, and ENG-15 ("four-step hint ladders … for every aptitude item, as drafts with provenance") has
not been built. A level recorded on an attempt means nothing unless the text shown at that level is kept,
reviewed and versioned with the item it helps with.

## Decision 1: one row per question *revision*, not per published version

A ladder belongs to exactly one `content_revisions` row of `entity_type = 'QUESTION'` — the revision the
published `question_versions` row points at (`question_versions.content_revision_id`). This is the same
choice ENG-07 made for option tags: `question_versions` rows exist only once published, but ladders are
drafted and reviewed with the item. A new version of a question is a new revision and gets its own ladder,
which is right because the hints may depend on changed options.

**Rejected: `question_version_id → question_versions(id)`.** Drafts could not carry a ladder until after
publication, forcing a second review of a question already approved.

## Decision 2: the ladder is reviewed *with* its question (no revision of its own)

`review_state` mirrors the **question revision's** state; the ladder's text can change only while that
revision is `DRAFT` or `CHANGES_REQUESTED`, and becomes immutable when it is published. The reviewer who
approves the question approves its hints in the same act, and the publish that makes the question live
makes its ladder live.

Why not a revision of its own, as ENG-07 gave option tags? A tag is a separate claim that can be added to
an existing item later. A hint ladder is part of *what the item is*: a level-4 hint that gives the answer
away breaks the item, so it must be judged by the same reviewer in the same review. A ladder added to an
already-published question therefore needs a new question revision — which is exactly when a reviewer
should look at the item again.

**Rejected: a `QUESTION_HINT_LADDER` content revision per ladder.** A second lifecycle that could publish a
ladder its question's reviewer never saw, and a sixth widening of `content_revisions.entity_type`.
**Rejected: hints only inside the question revision body.** The learner runtime (ENG-15/ENG-18) would then
have to read the body that also holds the answer key (`correctOptionId`, `explanation`) to show a hint. A
separate row carries hint text and nothing else, so a learner-facing read never touches the key.
The body keeps a copy (the reviewed snapshot the content hash and the release manifest pin); the editor
writes both in one transaction.

## The table: `question_hint_ladders`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `question_revision_id` | uuid NOT NULL UNIQUE → `content_revisions(id)`. Trigger: `entity_type = 'QUESTION'`. One ladder per revision. |
| `hint_1` … `hint_4` | text NOT NULL, 1–1000 characters each (trimmed). Level 1 **nudge** (points at the idea that matters), level 2 **strategy** (names the method), level 3 **worked step** (does the first step), level 4 **near solution** (everything short of choosing the answer). Level 0 is "no hint" and has no text. Using level 3 or 4 marks an attempt assisted (0047). |
| `source` | text NOT NULL, `AUTHORED` or `AGENT_DRAFTED` (as ENG-07; `GENERATED` waits for the AI hold to lift, ADR-030). |
| `generator_version`, `prompt_version`, `generated_at`, `expert_check_notes` | Provenance, with 0049's rule: all NULL for `AUTHORED`; all set (and expert notes present) for `AGENT_DRAFTED`. |
| `review_state` | text NOT NULL, the six lifecycle states; **mirrors the question revision** and cannot be set by hand. |
| `created_by_user_id` | uuid NOT NULL → `users(id)`. Who first wrote the ladder. |
| `created_at`, `updated_at` | timestamptz |

### Guard (trigger `question_hint_ladders_guard`)

- **Insert** only against a `QUESTION` revision that is `DRAFT` or `CHANGES_REQUESTED`; `review_state` is set
  to the revision's state.
- **Update**: identity and provenance (`id`, `question_revision_id`, `source`, the three provenance columns,
  `created_by_user_id`, `created_at`) never change; `review_state` must equal the revision's state; hint
  text changes only while the revision is `DRAFT` or `CHANGES_REQUESTED`.
- **Delete** is refused. A ladder is part of a reviewed record.

### Mirror (trigger on `content_revisions`)

`AFTER UPDATE OF state … WHEN entity_type = 'QUESTION'`: the ladder of that revision takes the new state.
Kept separate from 0049's `content_revisions_engine_state_mirror` (which lists its own three types), so
neither migration has to replace the other's function.

## Who reads it

- **Operators** with `CONTENT_EDIT`, `CONTENT_REVIEW` or `CONTENT_PUBLISH` see the ladder in the question
  bank editor.
- **Learners**: no route reads this table in OPS-09b. The runtime that shows hints and records the level
  used is ENG-15/ENG-18; it must read only rows whose `review_state = 'PUBLISHED'` and never join the
  answer key. Nothing here changes a readiness value: hints change how an attempt is *classified*
  (assisted), which 0047 already decides.

## Idempotency and replay

`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before each
`CREATE TRIGGER`. It depends only on 0000–0004 tables. It applies once under ADR-035 and survives the
bootstrap replay.

## Open points (decisions for Divakar)

1. **A complete ladder is required to submit a question for review.** Recommended (ENG-15's acceptance is
   "every item has a complete ladder"). The six pilot questions have none; their next revision will need
   one written.
2. **No automatic "does level 4 give the answer away" check.** Text matching produces false alarms on short
   numeric answers; the reviewer judges it, with a dedicated change-request reason `HINTS_REVEAL_ANSWER`.
