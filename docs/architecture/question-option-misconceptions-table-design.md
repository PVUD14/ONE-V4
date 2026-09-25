# Question Option Misconceptions — Table Design

**Status:** Adopted (ENG-07), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-26
**Migration:** `0049_misconceptions_and_teaching_strategies.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Governance, provenance and `review_state`:** shared with `misconception_codes` — see
`misconception-codes-table-design.md`. This document covers only what is specific to tags.

## Why this exists

A tag says: *choosing this wrong option is evidence of this misconception*. It is the join that lets a
graded answer name a misconception (ENG-07 acceptance) and lets the planner pick a strategy for it
(ENG-08, scenario X1). ENG-10 requires every item in the aptitude bank to have at least one
misconception-tagged distractor; OPS-09b's question editor sets "misconception code per wrong option".

## Which question bank

Two question banks exist:

- **Career-readiness items (0004):** `question_versions` — global, versioned, immutable once published,
  governed by `content_revisions`, options stored as `[{id, text}]` with the key in
  `question_answer_keys` (and in the revision body as `correctOptionId`).
- **Institution exam questions (0012):** `exam_questions` + `exam_question_options` — owned by one
  institution, authored and approved by its faculty under their own `exam_question_reviews`, options
  keyed by `option_key`, the question row itself updated in place (`version` increments, `updated_at`).

**Chosen: the career-readiness bank only, for v1.** The engine's item bank is this one: ENG-10's draft
aptitude pack "imports as drafts through the content path", ENG-14's placement test selects from it, and
OPS-09b specifies "global question versions". ENG-03's attempt log carries a skill for these items and
`skill_id = NULL` for exam items (an exam question has no readiness topic; the subject mapping in 0030 is
about the paper, not the question), and a misconception belongs to a skill.
*Rejected for v1: tagging `exam_question_options`.* The tag would be ONE's claim about an institution's own
question, in a different review regime, on a row that is edited in place. If institutions want this later
it is a separate table (`exam_question_option_misconceptions`, keyed by `exam_questions.id`,
`version` and `option_key`, reviewed by that institution's faculty) and a separate decision — noted, not
built.

### Tag the question *revision*, not the published `question_versions` row

`question_versions` rows exist **only once published** (`release_manifest_id` and `published_at` are NOT
NULL). ENG-10's items are drafts for a long time, and their tags must be drafted and reviewed alongside
them. So a tag references the question's **content revision** — the `content_revisions` row with
`entity_type = 'QUESTION'` — which exists from the first draft, and which the published
`question_versions` row points at (`question_versions.content_revision_id`). A published revision is
immutable (0004 trigger), so its option ids are stable forever; a new version of the question is a new
revision and needs its own tags, which is correct because its options may differ.

*Rejected: `question_version_id → question_versions(id)`.* Draft items could not be tagged until after
publication, forcing a second review of a question that was already approved.

## The table: `question_option_misconceptions`

| Column | Notes |
| --- | --- |
| `id` | uuid PK. Also the `entity_id` of its own revision. |
| `question_revision_id` | uuid NOT NULL → `content_revisions(id)`. Trigger: `entity_type = 'QUESTION'`. |
| `option_id` | text NOT NULL, 1–64. Trigger: present in the question revision's `body->'options'[*].id`, and **not** equal to `body->>'correctOptionId'` — a correct option can never carry a misconception. |
| `misconception_code_id` | uuid NOT NULL → `misconception_codes(id)`. A specific version. |
| `rationale` | text NOT NULL, 1–2000. Why choosing this distractor indicates this misconception. |
| `basis`, `expert_check_notes`, `source`, `generator_version`, `prompt_version`, `generated_at`, `review_state` | As in the shared design. |
| `content_revision_id` | uuid NOT NULL UNIQUE → `content_revisions(id)`, `entity_type = 'QUESTION_OPTION_MISCONCEPTION'`. The tag's own review trail. |
| `created_by_user_id`, `created_at` | As in the shared design. |

`UNIQUE (question_revision_id, option_id, misconception_code_id)`. An option may carry more than one code
(a distractor can be consistent with two wrong ideas); the resolver returns all published ones.

### Why the tag has its own revision

A tag is a separate claim from the question: an approved question can be tagged later, a tag can be
withdrawn (`ARCHIVED`) without re-versioning the question, and — B.8 — an agent-drafted tag on a
human-authored question must still go through review on its own. *Rejected: putting tags only inside the
question revision's body.* Retagging a published question would then need a new question version, and the
tag would have no provenance of its own.

### Publication rules (trigger)

When a tag's `review_state` becomes `PUBLISHED`:

- the question revision must be `PUBLISHED` (a tag cannot go live on an unpublished item), and the option
  must still exist and still be wrong in that (now immutable) body;
- the misconception code version must be `PUBLISHED`.

`publishEngineContentRelease` publishes codes before tags within one release, so a code and its tags can
ship together.

## Reading

`resolveResponseMisconceptions(db, [{ questionVersionId, selectedOptionId }])` joins
`question_versions.content_revision_id = question_option_misconceptions.question_revision_id` and returns
only rows where the tag and its code are both `PUBLISHED`; it applies `misconceptionsForResponse`
(correct → none). How the result reaches the attempt log and learner skill state is designed in
`misconception-codes-table-design.md` ("Recording a misconception on an attempt …").
