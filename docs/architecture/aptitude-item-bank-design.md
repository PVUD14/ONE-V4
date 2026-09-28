# Aptitude Skill Map and Draft Item Bank — Design

**Status:** Adopted (ENG-10), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** none. Every row this goal writes already has a home: skills in `taxonomy_nodes` + `content_revisions`
(0004, 0056, 0057), misconception codes in `misconception_codes` (0049), items in `content_revisions` (0004, 0061).
**Builds on:** `skill-map-editor-design.md` (OPS-09a), `question-bank-editor-design.md` (OPS-09b),
`misconception-codes-table-design.md` (ENG-07), `career-target-drafts-table-design.md` (ENG-11, the import-pack pattern)
**Content it carries:** `data/engine/aptitude-bank-v1.draft.json`, reasoning and sources in
`docs/career-readiness/aptitude-bank-v1.md`

## Why this exists

The shared aptitude block (quantitative, logical, verbal) is the part of ONE every student meets whatever role they
choose; the placement test (ENG-14) and the hint ladders (ENG-15) are built on it. ENG-10 asks for a skill map with
levels and prerequisites and about 300 items tagged to skills and misconception codes, as a governed content pack:
every item DRAFT with provenance (program B.8), an answer key, at least one misconception-tagged distractor, and a
validation script that checks tagging completeness. It must not publish anything or copy a copyrighted question bank.

The content is written by the coding agent, so it is model-produced (B.8, AGENTS.md "AI") even though the product
makes no model call: it lands as `DRAFT`, carries `source = AGENT_DRAFTED`, `generator_version`, `prompt_version` and
`generated_at`, cites its basis, marks what a subject expert must check, and reaches no learner until people review and
publish it.

## Decision 1: import through the editors, not beside them

The pack is imported by calling the operator editors' own functions — the path a person uses on the screen:

| Pack entry | Written by | Lands as |
| --- | --- | --- |
| Skill | `createSkill` then `saveSkillDraft` (OPS-09a) | a pending TOPIC: inactive node, revision 1 `DRAFT`, body `skill-map/v1` with all four levels, prerequisites, rights and basis |
| Misconception code | `createMisconceptionCodeDraft` (ENG-07) | a `misconception_codes` row, version 1, `DRAFT`, on its skill |
| Item | `createQuestion` then `saveQuestionDraft` (OPS-09b) | a QUESTION revision 1 `DRAFT`, body `question-bank/v1` with options, answer key, explanation, difficulty band, four hints, per-option misconception tags, rights and basis |

So every rule the editors enforce is enforced on the pack by the same code: stable-key patterns and uniqueness, field
lengths, the skill map's acyclic prerequisite check (`skillMapGraphProblems` → `assertAcyclicPrerequisites`, run on
each skill's save against the whole map), and the question bank's check that a tagged code exists, is not archived and
belongs to the item's own skill. Every write leaves the editor's audit row
(`operations.content.skill_created`, `…skill_draft_saved`, `…question_created`, `…question_draft_saved`) with the
importer as actor; misconception codes, which have no editor yet, get `engine.content.misconception_drafted`.

**Rejected: raw SQL or a migration that inserts the content.** The program asks for the existing authoring path; a
side door is where a check stops meaning anything, and a migration would put model-produced rows in every environment.
**Rejected: a separate `aptitude_items` table.** OPS-09b already decided that a question *is* its content revisions.

### Two small extensions to the editors (no behaviour change for a person)

1. **Provenance at creation.** `createSkill` and `createQuestion` take an optional `agentDraft` argument
   (`generatorVersion`, `promptVersion`, `generatedAt`, `packKey`, `expertCheck`). For a skill the node is inserted
   with 0056's `AGENT_DRAFTED` columns — which are immutable after insert, so they can only be set here. For both, the
   revision body carries `provenance`, `packKey` and `expertCheck`, keys the editors already carry unchanged from save
   to save (`composeSkillBody`, `composeQuestionBody`). The screen's own calls pass nothing and behave as before.
2. **Provenance survives submission.** When an item is submitted, OPS-09b writes its hint ladder
   (`question_hint_ladders`) and option tags (`question_option_misconceptions`); both tables already have the
   `AGENT_DRAFTED` provenance columns and CHECKs, and the question screen already renders "drafted by the coding agent"
   for a ladder. Until now the submission always wrote `AUTHORED`. It now reads the body's `provenance`: an
   agent-drafted item gives agent-drafted ladder and tag rows (with the expert-check note the CHECKs require). A human
   editing the draft does not make it `AUTHORED` (ENG-11's rule): the review record says who checked it, the
   provenance says where it came from. The question screen also shows the item's own provenance and expert-check note,
   as the skill screen does, so the reviewer knows what they are judging.

## Decision 2: the pack format and its validator

`data/engine/aptitude-bank-v1.draft.json` is built by `corepack pnpm --filter @planthepath/persistence
aptitude:build-pack` from the authoring source in `packages/persistence/src/aptitude-bank-content/`. The source is
TypeScript so that every quantitative answer, distractor and worked hint is **computed**, not typed: a template holds
the method, a parameter row holds the numbers, and the answer is whatever the arithmetic gives. Logical and verbal items
are written out one by one. A test pins the committed JSON to the build output, so the file cannot drift from its
source.

`validateAptitudeBankPack(pack)` (pure, `packages/persistence/src/aptitude-bank.ts`) returns every problem as a stable
code. It runs the editors' own validators *for submission* (`validateSkillDraft(…, true)`,
`validateQuestionDraft(…, true)`) so an imported draft can be submitted without edits, and adds the ENG-10 rules:

- provenance complete; the notice says `DRAFT`; the pack's licence is one the editors accept;
- every skill: area, all four levels, basis, expert-check note; prerequisites known within the pack and acyclic;
- every code: the ENG-07 pattern, unique, on a skill in the pack, used by at least one item;
- every item: on a skill in the pack, key prefixed by its skill, an answer key, **at least one misconception-tagged
  distractor**, tags only on wrong options and only with codes of the item's own skill, option texts distinct, four
  hints, a basis and an expert-check note;
- coverage: every skill has at least eight items and every area is present.

`corepack pnpm --filter @planthepath/persistence aptitude:validate [pack.json]` prints the counts (per area, skill,
difficulty; tagged distractors) and exits non-zero on any problem. It needs no database.

## Decision 3: the skill map

25 skills in three areas, keys `apt-q-*`, `apt-l-*`, `apt-v-*`, each a pending TOPIC. Levels are the skill map's four
(AWARE, GUIDED, INDEPENDENT, TROUBLESHOOT), written as what a learner can do — text, never numbers. Prerequisites
express teaching order (percentages before profit and loss; vocabulary before reading comprehension) and form a DAG;
the root skills have none. The full map and its sources are in `docs/career-readiness/aptitude-bank-v1.md`.

Area is recorded in the skill body (`area`), carried by the editor. **Rejected: an `APTITUDE` parent node or a SKILL
kind** — nothing reads a hierarchy above TOPIC (ENG-11 Decision 2), and a new kind would be a second skill identity.

## Decision 4: sources, licence and originality

- The **skill list** follows public examination syllabi: the Staff Selection Commission's Combined Graduate Level
  examination notice (Tier-I: General Intelligence and Reasoning, Quantitative Aptitude, English Comprehension), the
  UPSC Civil Services (Preliminary) General Studies Paper II syllabus (comprehension, logical reasoning and analytical
  ability, basic numeracy, data interpretation, Class X level), and the NCERT mathematics textbooks for the Class X
  level they cite. A syllabus is a list of topics; using it to decide what to cover copies no expression.
- **Every item, passage, hint and explanation is original**, written for this pack. No item is taken or adapted from a
  question bank, previous-year paper, coaching book or website. Numbers in word problems are chosen for clean
  arithmetic and describe no real person, shop or place.
- Licence **`AI8HT-Owned`** on every skill and item (the editors' list); no attribution is required because nothing is
  reproduced. The citations sit in each record's `basis`, and the reviewer confirms rights at approval
  (`OWNERSHIP_VERIFIED`), as for any operator-authored item.

## Decision 5: nothing is submitted, reviewed, approved or published

The importer is attributed to `ENGINE_CONTENT_IMPORTER_USER_ID` (ENG-07's convention). It never moves a revision out
of `DRAFT`. From there the ordinary lifecycle applies, item by item: someone submits (which writes the ladder and tags),
a reviewer who wrote none of it approves with the rights review, and a publish needs `CONTENT_PUBLISH`, a publisher who
is not a contributor, a live skill, published codes, and a second person's approval (every question publish changes
readiness inputs, OPS-09b Decision 6).

**Answer keys never reach a learner.** Nothing is written to `question_versions` or `question_answer_keys` by this
goal; after a future publish, `question_versions.options` holds `{id, text}` only (OPS-09b Decision 7).

**Readiness.** The pack computes and shows no readiness value. Difficulty is a band (`FOUNDATION`, `INTERMEDIATE`,
`ADVANCED`); measured difficulty is ENG-13's calibration.

## Idempotency

Rerunning the import creates nothing twice: a skill whose key exists is reused and left untouched (a person may have
edited it), a code whose latest version sits on the same skill is reused (on another skill it is refused), and an item
whose key is in use is skipped. The result lists what was created and what was reused or skipped.

## What students and staff see

Students see nothing. Operators with `CONTENT_EDIT`, `CONTENT_REVIEW` or `CONTENT_PUBLISH` see 25 pending skills in the
skill map and 300 draft items in the question bank, under the existing **Content Management** label, each marked as
drafted by the coding agent. No navigation item is added, removed, renamed or reordered (HG-3). Operator screens are
web-only (Appendix 1 §4.3); Android has no operator surface and needs no change.

## Open points (decisions for Divakar)

1. **Who submits.** A submitter becomes a contributor and can no longer review the item. With two people, one submits
   (after checking the expert notes) and the other reviews. Recommended: keep the rule; it is OPS-09b's.
2. **Codes have no review screen.** ENG-07 codes are reviewed and published through `transitionEngineContent` /
   `publishEngineContentRelease`, not the console. Items can be *approved* one by one today; *publishing* a tagged item
   needs its codes published first. Recommended follow-up: a small code review screen under Content Management.
3. **The readiness-check pool.** Once published, aptitude items would join the Career Readiness Fundamentals check,
   which draws from every published question (OPS-09b open point 2). Recommended: scope the pool to blueprint topics
   before the first aptitude publish.
