# Lesson and Variant Editor — Design

**Status:** Adopted (OPS-09c), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0065_lesson_variant_editor.sql` (no new table; one column, one approval key, two guards, one index)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `skill-map-editor-design.md` (OPS-09a: lifecycle, contributors, rights review, publish + approval),
`question-bank-editor-design.md` (OPS-09b: supersede-on-publish, submitters as contributors), the 0004 content
lifecycle and `lesson_versions`, and the learner-content lifecycle (0024/0026, `packages/learner-content`)

## Why this exists

A verified track needs lessons, and ENG-16 needs those lessons in more than one language. Today the only lessons
are the pilot's three, written by an engineer-run seed straight into `lesson_versions`. Appendix 1 OPS-09c asks for
an operator editor: lesson versions with variant metadata (language, level, style), reviewed through the
learner-content lifecycle, with the author never reviewing or publishing their own item, publishing under
`CONTENT_PUBLISH`, a second person's approval when the publish changes readiness inputs, and every transition
audited. ENG-16 (Part D) depends on this goal and will add "second-language drafts … marked for native-speaker
review" and a student language choice that "falls back to English with a notice".

## Decision 1: where a lesson lives

**Chosen: a lesson is the 0004 lesson.** Its identity is the `entity_id` of its `content_revisions` rows
(`entity_type = 'LESSON'`), numbered 1, 2, 3 …; publishing writes a `lesson_versions` row (version = the revision
number). This is the only lesson a student has: the web and Android learning screens list
`lesson_versions` through the published catalogue, completing one writes `learner_progress` and a
`LESSON_COMPLETION` evidence record, and the gap engine and readiness band read that evidence. The pilot's three
lessons already have exactly this shape (revision 1 of each, entity id = the lesson version id).

**Review follows the learner-content lifecycle.** 0024 says its state set "matches the governed content lifecycle
introduced in migration 0004", and the two are one lifecycle: `DRAFT → IN_REVIEW → (CHANGES_REQUESTED →
IN_REVIEW)* → APPROVED → PUBLISHED`. Every move this editor makes is checked against **both** rule sets —
`assertContentTransition` (0004, `packages/career-readiness`) and `assertLearnerContentReviewTransition`
(`packages/learner-content`) — so a move either one forbids is refused. The editor also adopts the learner-content
lifecycle's two separation rules (`transitionLearnerContentReview`, 0026): **the author never reviews**
(widened to contributors, as OPS-09a/09b do) and **the approver never publishes**. The second is stricter than the
skill map and question bank, and deliberate: lessons are learner-facing reading content, like every other item that
lifecycle governs.

**Rejected: storing lessons as `learner_content_items` rows.** 0024's `learner_content_type_ck` has no LESSON type
(Practice, Company Prep, Career Tools, Scholarships, Resume Builder only); adding one means replacing a CHECK to
widen it. The table has one mutable row per item and no versions, so "lesson versions" would need a second table
anyway; nothing a student completes reads it; and a lesson written there could never produce the completion
evidence every learning screen promises. It would be a second, parallel "lesson" that no learning screen shows.

## Decision 2: the revision body (schema `lesson/v1`)

```json
{
  "schema": "lesson/v1",
  "stableKey": "write-for-action",
  "variantOf": null,
  "variant": { "language": "en", "level": "STANDARD", "style": "EXPLANATION" },
  "basedOnRevision": null,
  "moduleKey": "career-readiness-fundamentals",
  "topicId": "…uuid of a TOPIC node…",
  "prerequisites": ["another-lesson-key"],
  "title": "Write for action",
  "body": { "summary": "…", "practice": "…" },
  "rights": { "licenceLabel": "AI8HT-Owned", "attribution": null },
  "basis": "…"
}
```

| Field | Rule |
| --- | --- |
| `stableKey` | `^[a-z0-9][a-z0-9-]{2,79}$`; set at creation, never edited; unique among lessons (every base revision and every `lesson_versions.stable_key`) |
| `title` | 1–200 characters |
| `body.summary` | ≤ 1000; required to submit (it is what the learning screens show) |
| `body.practice` | ≤ 2000; optional (the pilot's lessons all have one; a lesson need not) |
| `moduleKey` | base lessons: a **published** `learning_modules` key; required to submit |
| `topicId` (skill) | base lessons: a live or pending TOPIC; required to submit; **live** to publish |
| `prerequisites` | base lessons: stable keys of other base lessons, ≤ 20, no duplicates, never itself, live or pending; the lesson graph stays acyclic (Decision 5) |
| `rights`, `basis` | OPS-09a's licences (`AI8HT-Owned`, `CC-BY-4.0`, `CC-BY-SA-4.0`), attribution ≤ 300 and required for CC; basis ≤ 2000 |

Keys the editor does not own (the pilot's `id`, an import pack's `provenance`, `expertCheck`, `packKey`) are carried
unchanged, and an agent-drafted body is labelled as such on screen (program B.8). The pure validator is
`packages/career-readiness/src/lesson-editor.ts`. Pilot bodies are read tolerantly: no `variant` reads as the base
defaults below, and `prerequisiteLessonIds` gives way to the live prerequisite rows when a revision is started.

## Decision 3: variants

**Variant metadata** is three enumerations, defined in code:

| Field | Values | Base lesson |
| --- | --- | --- |
| `language` | `en`, `hi`, `te`, `ta`, `kn`, `ml`, `mr`, `bn`, `gu`, `pa`, `or` (ISO 639-1) | always `en` — ENG-16's fallback |
| `level` | `FOUNDATION` (simpler, more scaffolding), `STANDARD`, `ADVANCED` (denser, assumes more) | chosen at creation, default `STANDARD` |
| `style` | `EXPLANATION`, `WORKED_EXAMPLE`, `STEP_BY_STEP`, `SUMMARY` | chosen at creation, default `EXPLANATION` |

Levels and styles are text, never numbers; no level maps to a score.

**A variant is its own lesson entity** — its own content revisions, contributors, rights review, release manifest
and publish — whose body names its base (`variantOf` = the base lesson's entity id) and its triple. It carries its
own title, summary, practice, licence and basis; the structure (module, skill, prerequisites) is the base
lesson's and is not repeated. The triple is fixed at creation and is unique per base lesson, and never equal to the
base's own triple (checked under an advisory lock on the base). A variant can be created only for a **live** base
lesson: a translation of text that is still moving would chase every edit.

**Publishing a variant writes no `lesson_versions` row.** It is another rendering of the same lesson, not another
lesson: a student who reads the Telugu rendering completes the base lesson (ENG-16 wires that), so completion,
prerequisites and evidence stay per lesson. The published variant is its PUBLISHED content revision, immutable
under 0004 — the same way a published skill's levels live in its revision body (OPS-09a). ENG-16 reads "the latest
published revision of the variant of lesson L for (language, level, style)", and falls back to the base lesson.

**`basedOnRevision`** records which published revision of the base the variant renders; it is refreshed on every
draft save and frozen with the reviewed body. When the base is later revised, the variant is shown as *based on
revision n; the lesson is now at m*. Publishing an older-based variant is allowed (an approved revision cannot be
edited, and refusing would strand it); whether to serve a stale rendering, with a notice, is ENG-16's call.

**Rejected: a `lesson_variants` table.** It would have no reader until ENG-16, and would duplicate what the
published revision already holds. ENG-16 can add one if serving needs it.
**Rejected: a variant as another `lesson_versions` row.** The catalogue would list every rendering as a separate
lesson, each completable for its own evidence, and prerequisites would have to name renderings.
**Rejected: variant metadata as columns on `content_revisions`.** Three columns meaningful for one entity type out
of nine; the body is where every editor keeps its fields.

## Decision 4: a revision supersedes the previous lesson version

`getPublishedCareerReadinessCatalog` lists every `lesson_versions` row of a module. Publishing revision 2 of a lesson
would list it twice. 0065 adds `lesson_versions.superseded_at` (NULL = current), set on the previous current version
in the publish transaction, with a guard that makes it the only change a lesson version ever takes, once (as 0061
does for questions). The row stays: progress and evidence already pointing at it remain valid.

Because a lesson is now more than one row, three learner reads resolve a lesson **by its stable key**:

- **The catalogue** lists current versions only, and names each prerequisite by its current version id.
- **Completion** is idempotent per lesson: a student who completed version 1 is not asked to complete version 2,
  and no second `LESSON_COMPLETION` evidence is written for the same lesson (which would otherwise inflate the
  topic's evidence). A prerequisite is met by completing any version of it.
- **Progress** reports a completion against the lesson's current version id, so web and Android show the lesson as
  done without any client change.

The evidence provenance now records the lesson's own release manifest instead of the pilot's fixed id.

## Decision 5: prerequisites by key, checked with the existing acyclic check

Prerequisites are stable keys in the body, reviewed with the lesson. `assertAcyclicPrerequisites` — the lesson
check it was written for — runs with keys as node ids:

1. **On every draft save and submit**, over the map being built: this lesson's draft; for every other lesson, its
   open revision's prerequisites if it has one, else its live prerequisites.
2. **On publish**, over the live map (current versions and their prerequisite rows), and every prerequisite must be
   **live** — lessons publish in prerequisite order.

At publish, `lesson_prerequisites` rows are written from the new version to each prerequisite's current version;
0004's DAG trigger still guards the version graph.

## Decision 6: lifecycle, contributors and separation

| Move | Capability | Refused when |
| --- | --- | --- |
| Create a lesson or a variant, start a revision, save a draft | `CONTENT_EDIT` | another open revision; invalid body; duplicate key or triple; base not live (variant) |
| Submit / resubmit | `CONTENT_EDIT` | the body is incomplete; a reference is unknown; the lesson graph would cycle |
| Request changes, approve (with the rights review) | `CONTENT_REVIEW` | the actor is a contributor |
| Publish | `CONTENT_PUBLISH` (+ an approval, Decision 8) | the actor is a contributor **or approved the revision**; skill not live; module not published; a prerequisite not live; the graph would cycle |

**Contributors** are the revision's author, everyone with an `operations.content.lesson_draft_saved` audit row for it,
and everyone who submitted it (`operations.content.lesson_transitioned` to `IN_REVIEW`) — OPS-09b's rule. Audit rows
are never updated or deleted, so the list cannot be edited after the fact. **The approver** is the actor of the
revision's latest `APPROVE` review action.

0065 extends `content_review_author_publish_guard` from `TOPIC`, `QUESTION` to `TOPIC`, `QUESTION`, `LESSON`: a
revision's author never publishes it, whoever the writer. The pilot seed publishes with a separate publisher.

## Decision 7: rights review and release manifest (OPS-09a Decision 5, unchanged)

Approving writes, in the approval's transaction, one `migration_runs` + `source_packages` row per reviewed revision
(`package_identity = 'ops-lesson-editor:<revision id>'`, `source_commit` = SHA-1 of the reviewed body,
`transform_version = 'lesson-editor-v1'`), a release-eligible `source_records` row (`source_entity_type =
'LESSON_EDITOR_REVISION'`), the `rights_reviews` row with the reviewer's rights reason, an `SME` quality review, and
`content_provenance`. Publishing creates a release manifest named `Lesson: <key>` or
`Lesson variant: <key> <language>/<level>/<style>` (version = revision), approved by the revision's reviewer and
published by the actor, so the 0004 eligibility trigger enforces the rights review.

## Decision 8: when a publish needs an approval

Appendix 1 §5.4: publishing content that changes readiness inputs needs an approval. A lesson publish changes them
when completing it would produce different evidence:

1. **A base lesson's first publish** — a new completable lesson writes new `LESSON_COMPLETION` evidence.
2. **A revision that changes the skill** — completion evidence moves to another topic.
3. **A revision that changes the prerequisites** — which lessons a student can complete, and so when evidence can be
   recorded, changes.

A wording-only revision of a live lesson (title, summary, practice, module, rights, basis) and **every variant
publish** need `CONTENT_PUBLISH` only: completion and its evidence are unchanged. The rule is the pure function
`lessonPublishAltersReadinessInputs` in `packages/authorization`, evaluated against rows read under lock.

The approval action is **`CONTENT_LESSON_PUBLISH`** (capability `CONTENT_PUBLISH`, target type
`content_revision`), payload `{ revisionId, contentHash, reasonCode }`. It is requested only for an `APPROVED`
revision that needs one, and only by someone who is neither a contributor nor its approver (they will execute it).
Any publish may carry an approval; if one is given it is consumed. `operation_approval_extended_target_type` is
replaced repeating **all three** earlier keys (`CAREER_REQUIREMENT_SET_PUBLISH`, `CONTENT_SKILL_PUBLISH`,
`CONTENT_QUESTION_PUBLISH`) and adding this one.

## Migration 0065

1. `lesson_versions.superseded_at` and the supersede-once guard (`lesson_version_supersede_guard`). Nothing updates
   `lesson_versions` today, so no existing path changes.
2. The approval key, repeating every earlier extended key.
3. `content_review_author_publish_guard` extended to `LESSON`.
4. An expression index on `(body ->> 'stableKey')` for LESSON revisions (key checks and listing).

Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` before
`CREATE TRIGGER`, `CREATE INDEX IF NOT EXISTS`. It applies once under ADR-035 and survives a bootstrap replay.

## Audit and events

Audit (`resource_type = 'content_revision'`, resource id = the revision, reason code, `break_glass` when it
applies): `operations.content.lesson_created`, `…lesson_variant_created`, `…lesson_revision_started`,
`…lesson_draft_saved`, `…lesson_transitioned`, `…lesson_rights_reviewed`, `…lesson_published`.
Outbox (registered in `packages/events`, identifiers and enums only, no consumer yet):
`lesson_editor.revision_state_changed`, `lesson_editor.lesson_published`.

## Screens

Under the existing **Content Management** label, below the question bank; no navigation item is added, removed,
renamed or reordered (HG-3). Operator screens are web-only (Appendix 1 §4.3). The learner contract is unchanged in
shape (the catalogue and progress DTOs keep their fields), so the Android app needs no change: it shows current
lesson versions and completion exactly as the web does.

## Open points (decisions for Divakar)

1. **Three people per lesson.** Following the learner-content lifecycle, the approver never publishes, so a lesson
   needs an author, a different reviewer and a third person to publish. Recommended while lessons are learner-facing
   reading content; relaxing it is one rule in `refuseLessonPublish`.
2. **Modules are chosen, not authored.** Only the pilot module exists; a new track's lessons need a module first.
   A module editor is a small follow-up.
3. **Variant vocabularies** (eleven languages, three levels, four styles) and **English base lessons**. Recommended;
   changing them is a code change.
4. **Stale variants publish.** A variant based on an older base revision may still be published; ENG-16 decides
   whether to serve it with a notice.
5. **Misconception codes still have no console path** (ENG-10's note). A small review/publish screen for ENG-07's
   codes, reusing this lifecycle, would unblock tagged questions; recommended as a follow-up, not built here.
