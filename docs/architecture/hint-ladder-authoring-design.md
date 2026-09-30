# Authored Hint Ladders — Design

**Status:** Adopted (ENG-15), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** none. Migration number 0096 was reserved for this goal and is released unused: every row this goal
writes already has a home — ladders in `question_hint_ladders` (0061), the level a learner used in
`learning_step_items.hint_level` (0072) and `learning_attempt_events.highest_hint_level` / `assisted` (0047).
**Builds on:** `question-hint-ladders-table-design.md` (OPS-09b), `aptitude-item-bank-design.md` (ENG-10),
`learning-step-items-table-design.md` (ENG-18), `learning-attempt-events-table-design.md` (ENG-03), the ENG-04 assisted
rule in `packages/learning-model`, ADR-037 (external faculty review), ADR-030 (the AI hold)

## Why this exists

Program Part D, ENG-15: "Four-step hint ladders (level 0 no hint → level 4 near-solution) for every aptitude item, as
drafts with provenance; hint use recorded on attempts (ENG-03) and assisted rule applied (ENG-04). Acceptance: every
item has a complete ladder; using hint 3 marks the attempt assisted."

By the time this goal starts, most of the machinery exists:

| Piece | Where | State before ENG-15 |
| --- | --- | --- |
| The ladder table, reviewed and published with its question | 0061, `question_hint_ladders` | Built (OPS-09b) |
| Four hints on every aptitude item, DRAFT, agent-drafted provenance | `data/engine/aptitude-bank-v1.draft.json` | Built (ENG-10) |
| Submission requires all four hints | `validateQuestionDraft(…, true)` | Built (OPS-09b) |
| Serving a published ladder one level at a time, level recorded by the server | 0072, `revealStepHint` | Built (ENG-18) |
| Hint ≥ 3 ⇒ assisted, enforced in the database | 0047 `learning_attempt_assisted_ck`, `isAssistedAttempt` | Built (ENG-03/04) |

What was missing is the part the goal is named for: **the ladders themselves were never checked as ladders.** A
review of ENG-10's 1,200 hints found that

- levels 1 and 2 are shared by every item of a skill (63 and 79 distinct texts for 300 items) — acceptable, see
  Decision 3;
- 26 items had a level-4 hint shared by three or more items ("Rule out the option that reads the words literally…"
  on all twelve idiom items), so the "near solution" said nothing about the item in front of the learner;
- several level-3 hints were already the whole answer (the data-interpretation items listed every yearly increase
  at level 3, leaving level 4 nothing to add);
- a few hints named the correct option's text outright;
- nothing recorded that ENG-15 had reviewed the ladders: the ladder rows would carry ENG-10's prompt version.

## Decision 1: ladder rules as a pure, versioned function (`hint-ladder-v1`)

`packages/career-readiness/src/hint-ladder.ts` exports `HINT_LADDER_RULES_VERSION = 'hint-ladder-v1'` and
`hintLadderFindings({ prompt, options, correctOptionId, hints })`, which returns findings `{ level, code }`:

| Code | Meaning |
| --- | --- |
| `HINT_MISSING` | The level has no text. |
| `HINT_REPEATS_EARLIER` | The level says the same as an earlier level (case and spacing ignored). A ladder must climb. |
| `HINT_NAMES_ANSWER` | The hint contains the correct option's text as a whole phrase, and that text is not already in the prompt. |
| `HINT_NAMES_OPTION` | The hint points at the correct option by its letter ("option c", "answer (c)"). |

"Not already in the prompt" is what keeps the check honest on short answers: a name, year or number the question
itself states ("Who sits in the middle?" → "Qadir") cannot be leaked by repeating it, while a meaning or a result the
learner has to find can. Matching is on whole words and phrases, so "Son" is not found inside "person".

The function needs the answer key, so it runs only where the key is visible: the pack validator, and the question bank
editor for `CONTENT_EDIT` / `CONTENT_REVIEW` holders (for a reader without the key it sees no key and reports only
missing and repeated levels).

**Where it blocks and where it advises.**

- **The aptitude pack (blocking).** `validateAptitudeBankPack` refuses any finding, plus Decision 3's rule. The pack is
  content the agent wrote; it is fixed at the source, not waved through.
- **The question bank editor (advisory).** The revision view carries `ladderChecks: { rulesVersion, findings }` and the
  screen lists them under the hint ladder for the author and the reviewer. Submission is **not** blocked: OPS-09b
  Decision 2 rejected an automatic "does level 4 give the answer away" gate because text matching cannot judge meaning,
  and that stands. The reviewer decides, with the existing change-request reason `HINTS_REVEAL_ANSWER`.

**Rejected: a model-based leak check.** The AI hold (ADR-030) forbids it, and a model judging whether a hint reveals
an answer would itself need the benchmark CLAUDE.md asks for.
**Rejected: blocking submission in the editor.** See above; a false alarm on a short numeric answer would stop a
correct item, and the person who could overrule it is the reviewer anyway.

## Decision 2: what each level is, stated once

The levels are OPS-09b's (`HINT_LEVELS`): 1 **nudge** (points at the idea that matters), 2 **strategy** (names the
method), 3 **worked step** (does the first step — the attempt becomes assisted), 4 **near solution** (everything short
of choosing the answer — assisted). Level 0 is "no hint" and has no text. ENG-15's content rewrite follows these
meanings: where ENG-10's level 3 already finished the problem, level 3 now does only the first step and level 4 carries
the rest.

## Decision 3: levels 1–2 may be shared within a skill; levels 3–4 must be about the item

A nudge and a strategy name the skill's idea and method ("Undo the operations on x in reverse order"); writing twelve
paraphrases of the same method for twelve items would add variation without adding help. A worked step and a near
solution are about *this* item's numbers, words or clues. The pack validator therefore refuses a level-3 or level-4
text used by more than two items (`ITEM_HINT_GENERIC:<level>:<key>`). Two is allowed because two items can legitimately
share a computation (two items that both reduce to "Multiply 4 by 5").

**Rejected: every level unique per item.** It forces artificial rewording of the method at levels 1–2.
**Rejected: no cross-item rule.** It let twelve idiom items share one near solution.

## Decision 4: the ladder carries its own provenance

The ladder row's provenance (`source`, `generator_version`, `prompt_version`, `generated_at`, `expert_check_notes`)
comes from the question body at submission (ENG-10 Decision 1). ENG-15 revised the ladders, not the items, so:

- the pack gains a `hintLadder` block: `generatorVersion`, `promptVersion = 'eng-15-hint-ladders-v1'`, `generatedAt`,
  `rulesVersion = 'hint-ladder-v1'` and an `expertCheck` note for the ladder;
- the importer passes it to `createQuestion`, which stores it in the body as `hintLadderProvenance` (a key the editor
  carries unchanged on every save, like `provenance`);
- submission writes the ladder row from `hintLadderProvenance` when present and valid, and from the item's
  `provenance` otherwise (every item drafted before ENG-15, and any hand-authored item, behaves as before). The row's
  expert notes are the item's note followed by the ladder's.

**Rejected: bumping the whole pack's `promptVersion`.** It would re-attribute 300 items, 25 skills and 69 codes to a
goal that did not write them.
**Rejected: a separate ladder content revision.** OPS-09b already decided the ladder is reviewed with its question.

Everything stays `DRAFT` and `AGENT_DRAFTED`; nothing is submitted, approved or published by this goal. No model is
called by the product: the ladders are written by the coding agent, by hand, under program Part B.8.

## Decision 5: hint use and the assisted rule — unchanged, and now pinned end to end

ENG-18 already serves only `PUBLISHED` ladders (never the key or the body), releases one level per request, records the
level on `learning_step_items` (0072: it can only rise by one while the question is unanswered) and passes the
**server's** level to ENG-03's writer. 0047's CHECK makes an attempt with `highest_hint_level ≥ 3` assisted whatever the
caller says, and the learner skill state projection counts assisted successes apart from unaided ones, so they never
count toward DEMONSTRATED (ENG-04). ENG-15 adds the boundary test the acceptance names: a right answer after hint 2 stays
unaided; after hint 3 it is assisted; and the projection counts each accordingly.

Hints are offered only in practice. Readiness checks (assessment) and the placement test (diagnostic) serve no hints,
and nothing here produces or changes a readiness value.

## Decision 6: who sees a ladder

- **Operators** with `CONTENT_EDIT` / `CONTENT_REVIEW` see the ladder and its checks in the question bank editor.
- **External faculty reviewers** (ADR-037 §6) keep seeing no ladder: a level-4 hint is a near solution and sits with
  the key. No change.
- **Students** see published hints one level at a time, now labelled by level (Nudge, Strategy, Worked step, Near
  solution), with the existing warning before the level that makes an answer assisted — on the web Learning page and
  in the Android Learning tab.

No navigation item is added, removed, renamed or reordered (HG-3).

## Items already imported

The importer never overwrites an existing draft (ENG-10 Decision 5: a person may have edited it). A database that
imported ENG-10's pack keeps ENG-10's ladders on those drafts; the editor's ladder checks show the reviewer what the
rules find, and the author can paste the revised ladder from the pack before submitting. A fresh import gets the
revised ladders with ENG-15's provenance.

## Open points (decisions for Divakar)

1. **Refreshing already-imported drafts.** Recommended: leave them (above). A refresh command would have to decide
   whether a person has touched a draft, which the audit trail can answer only approximately.
2. **Making the editor's checks blocking later.** Recommended: keep them advisory until reviewers have used them on the
   aptitude items and the false-alarm rate is known.
