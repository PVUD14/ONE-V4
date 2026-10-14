# Content Bulk Import — Design

**Status:** Adopted (OPS-09d), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** none. No table, column, constraint or approval key is added (Decision 3).
**Builds on:** `skill-map-editor-design.md` (OPS-09a), `question-bank-editor-design.md` (OPS-09b),
`lesson-variant-editor-design.md` (OPS-09c), the ENG-10/ENG-11 import packs (`aptitude-bank.ts`,
`career-target-drafts.ts`), and the preview/commit pattern of the institution imports
(`academic-results-import.ts`, INST-04; the student roster import in `operations-institution-onboarding.controller.ts`).

## Why this exists

Verified tracks need skills, questions, hint ladders, misconception tags and lessons in volume. The three editors
built in OPS-09a–c take one item at a time, and the only bulk path is an engineer running an import pack from a
terminal. Appendix 1 OPS-09d asks for an operator upload: a CSV or JSON file, a server-side validation report, a
preview, and a commit in which every imported row lands as DRAFT. The rules for all four OPS-09 PRs still hold:
the author never reviews or publishes their own item, publishing needs CONTENT_PUBLISH (plus an approval where the
editors say so), every transition is audited, answer keys never reach a student route, rights review is never
bypassed, and imports are never auto-published. The acceptance line specific to this PR is: **an invalid file shows
row-level errors and writes nothing.**

## Decision 1: the import goes through the editors' own functions

**Chosen.** Each row is created and saved by exactly the functions an operator's single edit uses:

| Kind | Per row |
| --- | --- |
| `SKILL` | `createSkill`, then `saveSkillDraft` (levels, prerequisites, rights) |
| `QUESTION` | `createQuestion`, then `saveQuestionDraft` (options, answer key, difficulty, hint ladder, misconception tags, rights) |
| `LESSON` | `createLesson`, then `saveLessonDraft` (text, module, skill, prerequisites, rights) |
| `LESSON_VARIANT` | `createLessonVariant` of a live lesson, then `saveLessonDraft` (the variant's text and rights) |

So every rule the editors apply applies here without a copy: key patterns and uniqueness, text limits, the
acyclic prerequisite check (`assertAcyclicPrerequisites` through `skillMapGraphProblems` and
`lessonGraphProblems`), known and non-retired skills, a misconception code on the question's own skill, a live
base for a variant, one variant per language/level/style, and the editors' audit rows
(`operations.content.*_created`, `…_draft_saved`) carrying the reason code and break_glass. The importer is the
`author_user_id` of every revision it creates and the actor of every save, so the editors' contributor rule (the
author and anyone who saved an edit never review or publish that revision) and 0057/0061/0065's
`content_review_author_publish_guard` refuse the importer as reviewer and publisher with no new code.

The ENG-10 and ENG-11 packs already work this way (skills created first, then saved in prerequisite order so the
acyclic check runs on each). The importer follows them: for skills and lessons every row is created first and
then saved in prerequisite order within the file, so a file may name a prerequisite that a later row defines.

**Rejected: a separate bulk writer with its own validation.** It would duplicate every editor rule and drift from
them — the failure OPS-09a–c were built to prevent. **Rejected: the file creating revisions of existing items.**
An imported row only creates; a key that already exists is a row error (`*_KEY_EXISTS`). Revising live content is
the editor's job, where the reviewer sees the previous published revision beside the change.

## Decision 2: preview and commit are the same evaluation, in a transaction

**Chosen: stateless preview and commit bound to a digest,** the academic-results pattern (INST-04).

* **Preview** parses the file, then runs every row through the editors inside one database transaction, each
  row in its own savepoint so one failing row does not hide the next row's problems. The transaction is then
  **rolled back**: nothing the preview did persists. The report lists each row with its outcome (`CREATE` or
  `INVALID`) and its issue codes, and a SHA-256 **digest** over the kind, format, the normalised row values and
  every row's outcome and issues.
* **Commit** repeats the same evaluation in a new transaction. It writes only if no row is invalid **and** the
  digest equals the one the uploader previewed; otherwise the transaction is rolled back and the answer is
  `IMPORT_HAS_INVALID_ROWS` (400) or `IMPORT_STALE` (409). All rows commit or none do.

Running the real editors in a rolled-back transaction makes the preview exact: a cycle through a draft skill, a
key another operator took a minute ago, a misconception code on the wrong skill — all appear in the preview
exactly as the commit would meet them. A digest that includes the outcomes means a commit cannot write a
different result from the one the uploader saw (someone created a key meanwhile, the file changed): it is refused
as stale and the screen previews again.

**Rejected: storing the preview in an import table** (the roster pattern, `student_roster_imports`). It needs a
table, a lifecycle and a clean-up for abandoned previews, and it stores content (including answer keys) outside
the content tables for no gain: the commit must re-validate against the live state anyway.

## Decision 3: no migration

Every row lands in tables and states that already exist (`content_revisions` DRAFT, `taxonomy_nodes` inactive,
the editors' audit rows). The import's own records are two audit actions (Decision 6). Migration number 0066 was
reserved for this goal and is left unused.

## Decision 4: the file

* **Formats:** CSV (RFC 4180: quoted fields may hold commas, quotes and line breaks) or JSON (an array of flat
  objects). The operator chooses the kind; one file holds one kind.
* **Fields:** the same names in both formats, listed by the policy endpoint and the screen. Required fields per
  kind are few (the key and what `create*` needs); everything else may be left blank and finished in the editor.

  | Kind | Required | Optional |
  | --- | --- | --- |
  | `SKILL` | `stable_key`, `name`, `description` | `level_aware`, `level_guided`, `level_independent`, `level_troubleshoot`, `prerequisites`, `licence`, `attribution`, `basis` |
  | `QUESTION` | `stable_key`, `skill_key`, `prompt` | `option_a`–`option_f`, `correct_option`, `explanation`, `difficulty`, `hint_1`–`hint_4`, `misconception_a`–`misconception_f`, `rationale_a`–`rationale_f`, `licence`, `attribution`, `basis` |
  | `LESSON` | `stable_key`, `title`, `level`, `style` | `summary`, `practice`, `module_key`, `skill_key`, `prerequisites`, `licence`, `attribution`, `basis` |
  | `LESSON_VARIANT` | `base_lesson_key`, `language`, `level`, `style`, `title` | `summary`, `practice`, `licence`, `attribution`, `basis` |

  `prerequisites` is a list of keys separated by `;` (in JSON also an array of strings). A misconception is named
  by its ENG-07 **code** (not an internal id); the importer resolves it to the latest non-archived version.
* **Unknown columns and fields are refused.** An unknown, duplicated or missing required CSV column is a
  file problem; an unknown JSON field is an issue on that row. Either way the file cannot be committed.
* **Caps:** 200 rows and 90,000 characters per file. The API's JSON body limit (100 KB, the framework default,
  unchanged) is the outer bound; 90,000 leaves room for escaping. 200 rows keeps the evaluation (a few queries
  per row, run twice) well inside one request, so no outbox job is needed (§5.7). Larger sets are split.
* **What the report shows:** per row its number, its key, its outcome and issue codes. It never echoes the
  row's text — in particular never an answer key or explanation.

## Decision 5: who, and with which reason

* **CONTENT_EDIT** previews and commits: an import is authoring. The policy endpoint is readable by the same
  holders (the screen shows a forbidden state to anyone else).
* **Reason codes** (§5.3, in code): `TRACK_BUILD`, `CONTENT_MIGRATION`, `EXPERT_BATCH`. The chosen code is
  carried into every row's `*_created` audit row and the import's own audit row.
* **No approval.** An import changes nothing a student sees: every row is a DRAFT that still needs a reviewer
  who is not the importer, the rights review, a publisher, and — where the editors require it — a second
  person's approval. Dual control applies at publish, where it already is.

## Decision 6: audit, events and answer keys

* `operations.content.import_previewed` (resource `content_import`, id = the digest): kind, format, file name,
  row count, counts, digest. Written after the rolled-back evaluation, so it is the preview's only write.
* `operations.content.import_committed` (resource `content_import`, id = a new reference): kind, format, file
  name, digest, reason code, count created and the created keys. In the commit's transaction.
* A refused commit writes nothing, including no audit row: the transaction is rolled back whole.
* No outbox event is added: the editors' create and save write none (their events are state changes), and an
  import changes no state beyond DRAFT.
* **Answer keys** travel only inside the import request and into `content_revisions.body` through
  `saveQuestionDraft`, exactly as a single edit does. They are not in the report, the audit contexts (counts,
  keys and a digest only), any outbox payload or any approval payload, and no learner DTO changes.

## Screens

Content Management gains a "Bulk import" panel below the lesson editor (no navigation change, HG-3): choose
the kind and format, pick a file, **Preview**, read the row report, choose a reason code and **Commit**. The
panel says plainly that imported rows are drafts, that the importer cannot review or publish them, and where to
continue (the three editors above it). It has loading, empty, error-with-reference and forbidden states.

Operator screens are web-only (Appendix 1 §4.3); the Android app has no operations surface and needs no change.

## Open points (decisions for Divakar)

1. **Create-only imports** (Decision 1). Recommended and adopted; revisions stay in the editors.
2. **200 rows / 90,000 characters per file** (Decision 4). Raising them means an outbox job for the evaluation.
3. **No approval for an import** (Decision 5). Recommended: approvals belong at publish, where they already are.
