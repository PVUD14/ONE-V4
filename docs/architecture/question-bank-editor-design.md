# Question Bank Editor — Design

**Status:** Adopted (OPS-09b), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-28
**Migration:** `0061_question_bank_editor.sql` (one table — `question-hint-ladders-table-design.md` — one column,
one approval key, two guards)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `skill-map-editor-design.md` (OPS-09a: lifecycle, contributors, rights review, publish + approval),
`misconception-codes-table-design.md` and `question-option-misconceptions-table-design.md` (ENG-07, 0049),
`high-risk-approvals-table-design.md` (OPS-02), the 0004 content lifecycle and `question_versions`

## Why this exists

The readiness check draws its items from `question_versions`, and ENG-10/ENG-14 plan an aptitude bank and a
placement test on the same table. Today the only way an item reaches it is an engineer running the pilot
seed. Appendix 1 OPS-09b asks for an operator editor: global question versions, answer keys visible only to
content editors and reviewers, difficulty, a skill tag, a misconception code per wrong option, a four-step
hint ladder, provenance and rights review — with the author never reviewing or publishing their own item,
publishing under `CONTENT_PUBLISH`, a second person's approval when the publish changes readiness inputs,
and every transition audited. Answer keys must never reach a learner.

The editor reuses OPS-09a's shape end to end. What differs is what a question is, where its tags and hints
live, and what "publish" writes.

## Decision 1: a question is its content revisions; publishing writes `question_versions`

A question's identity is the `entity_id` of its `content_revisions` rows (`entity_type = 'QUESTION'`),
numbered 1, 2, 3 … (`content_revision_entity_uq`) — exactly how the pilot's six questions already exist. No
registry table is added: every draft is a revision, and a `question_versions` row exists only once a
revision is published (0004 makes its manifest and `published_at` NOT NULL).

- **New question:** revision 1 in `DRAFT`, authored by the creator.
- **New revision of a live question** (including a pilot question): revision *n+1* started from the latest
  published body, which the editor reads tolerantly (the pilot bodies have no difficulty, hints or rights).
- **At most one open revision per question** (DRAFT, IN_REVIEW, CHANGES_REQUESTED or APPROVED), under an
  advisory lock on the question.
- **Publish** writes `question_versions` (a new id; `version` = the revision number; `stable_key`, topic,
  prompt and `options` as `[{id, text}]` only) and `question_answer_keys` (the correct option and the
  explanation, `answer_hash` as the pilot computes it), in the publish transaction.

The stable key (`^[a-z0-9][a-z0-9-]{2,79}$`) is set at creation, never edited, and unique across every
question's revisions and `question_versions` (checked under an advisory lock on the key; an expression
index keeps it cheap).

**Rejected: a `question_bank_items` identity table.** It would duplicate what `entity_id` already is, and
the pilot's questions would have to be backfilled into it.

### Superseding the previous version (new column)

The readiness check selects from *every* published `question_versions` row. Publishing revision 2 of a
question would leave version 1 in that pool, so one question could be drawn twice. 0061 adds
`question_versions.superseded_at` (NULL = current). Publishing version *n* sets it on every earlier current
version of the same question in the same transaction, and the pool query in
`packages/persistence/src/career-readiness.ts` excludes superseded rows. The row itself stays: attempts
already holding it still grade against it. A trigger allows exactly one change to a `question_versions`
row — `superseded_at` from NULL to a time — and nothing else, so published items stay immutable.

## Decision 2: the revision body (schema `question-bank/v1`)

```json
{
  "schema": "question-bank/v1",
  "stableKey": "soc-alert-triage-q001",
  "topicId": "…uuid of a TOPIC node…",
  "prompt": "…",
  "options": [
    { "id": "a", "text": "…", "misconception": { "codeId": "…uuid…", "rationale": "…" } },
    { "id": "b", "text": "…", "misconception": null }
  ],
  "correctOptionId": "b",
  "explanation": "…",
  "difficulty": "FOUNDATION",
  "hints": ["…", "…", "…", "…"],
  "rights": { "licenceLabel": "AI8HT-Owned", "attribution": null },
  "basis": "…"
}
```

| Field | Rule (draft / to submit) |
| --- | --- |
| `topicId` (skill tag) | a live or pending `TOPIC`; **live** to publish (a live item never measures an unpublished skill) |
| `prompt` | 1–2000 characters |
| `options` | 2–6, ids `a`–`f` in order, unique; text ≤ 500; every option has text to submit |
| `correctOptionId` | one of the option ids — required to submit |
| `explanation` | ≤ 2000; required to submit (`question_answer_keys.explanation` is NOT NULL) |
| `difficulty` | `FOUNDATION`, `INTERMEDIATE` or `ADVANCED` — a band, never a number; required to submit. Measured difficulty is ENG-13's calibration, not this. |
| `options[].misconception` | optional per **wrong** option; the code must belong to the question's topic and not be archived; the rationale (1–2000) is required when a code is set. Never on the correct option. **Published** codes only at publish. |
| `hints` | four texts, levels 1–4, each ≤ 1000; all four required to submit |
| `rights` | licence `AI8HT-Owned`, `CC-BY-4.0` or `CC-BY-SA-4.0` (OPS-09a's list) required to submit; attribution ≤ 300 and required for the CC licences |
| `basis` | ≤ 2000, optional: what the item rests on |

Keys the editor does not own (the pilot's `id`, an importer's provenance) are carried unchanged. The pure
validator is `packages/career-readiness/src/question-bank.ts`.

**Tagging every wrong option is not required to submit.** ENG-10 requires "at least one misconception-tagged
distractor" for its aptitude pack, and its validation script will check that; the editor serves every
bank, and a distractor that matches no catalogued misconception should not be forced onto one. The screen
shows "n of m wrong options tagged".

## Decision 3: tags and hints are written into ENG-07's and 0061's tables at submission

The body is the draft. **Submitting** turns it into the rows the reviewer approves, in the submit
transaction:

- **Option tags** (`question_option_misconceptions`, ENG-07 — no new misconception table): for each tagged
  wrong option, the tag row for `(question revision, option, code)` is created (its own
  `QUESTION_OPTION_MISCONCEPTION` revision, authored by the submitter, `AUTHORED` provenance, basis naming
  the question and revision) or, on a resubmission, reused with its rationale updated; then submitted.
  Request changes and approve move the tags with the question (`REQUEST_CHANGES` / `APPROVE` actions by the
  reviewer). Publish publishes every approved tag of the revision through the question's release manifest,
  after the question (0049's guard: the question and the code must be published first).
  A tag dropped between submissions stays in `CHANGES_REQUESTED` forever and is never published: 0049
  forbids deleting it, and its option may since have become the correct one, which 0049's guard would
  refuse on any update. The resolver reads only published tags, so it is inert.
- **Hint ladder** (`question_hint_ladders`, 0061): upserted from the body; its state then mirrors the
  question revision.

**Rejected: writing tags on every draft save.** Every change of a distractor's code would strand another
undeletable row; submission is when the author vouches for the set.
**Rejected: writing tags at publish.** The review actions on the tag would then be recorded as happening at
publish time by people who acted earlier — a false audit trail.

## Decision 4: lifecycle and contributors are OPS-09a's

States and moves are 0004's (`assertContentTransition`):
`DRAFT → IN_REVIEW → (CHANGES_REQUESTED → IN_REVIEW)* → APPROVED → PUBLISHED`.

| Move | Capability | Refused when |
| --- | --- | --- |
| Create, start a revision, save a draft | `CONTENT_EDIT` | another open revision; invalid body |
| Submit / resubmit | `CONTENT_EDIT` | the body is not complete (Decision 2) |
| Request changes, approve (with the rights review) | `CONTENT_REVIEW` | the actor is a contributor |
| Publish | `CONTENT_PUBLISH` **and an approval** | the actor is a contributor; topic not live; a tagged code not published |

**Contributors** are the revision's author, everyone with an `operations.content.question_draft_saved`
audit row for it, and everyone who submitted it (`operations.content.question_transitioned` to
`IN_REVIEW`). The submitter is added because the tag rows are authored by the submitter, and 0004's trigger
would refuse their approval by that person anyway. Audit rows are never updated or deleted, so the list
cannot be edited after the fact.

0061 extends 0057's `content_review_author_publish_guard` from `TOPIC` to `TOPIC` and `QUESTION`: a
revision's author never publishes it, whoever the writer. The pilot seed and every existing test publish
questions with a separate publisher.

## Decision 5: rights review and release manifest (OPS-09a Decision 5, unchanged)

Approving writes, in the approval's transaction, one `migration_runs` + `source_packages` row per reviewed
revision (`package_identity = 'ops-question-bank:<revision id>'`, `source_commit` = SHA-1 of the reviewed
body, `transform_version = 'question-bank-editor-v1'`), a release-eligible `source_records` row
(`source_entity_type = 'QUESTION_BANK_REVISION'`), the `rights_reviews` row with the reviewer's rights
reason (`OWNERSHIP_VERIFIED` / `LICENCE_VERIFIED`), an `SME` quality review, and `content_provenance`.
Publishing creates a release manifest `Question bank: <key>` (version = revision), with the question
revision and its approved tag revisions as items against that source record, approved by the revision's
reviewer and published by the actor — so the 0004 eligibility trigger enforces the rights review.

## Decision 6: every publish changes readiness inputs, so every publish needs an approval

Appendix 1 §5.4 requires an approval for "any change that alters readiness or gap results". A question
publish always does today: `startAssessmentAttempt` draws from **every** current published question, so a
new or revised item changes what the readiness check can ask and how its evidence is scored. The approval
action is **`CONTENT_QUESTION_PUBLISH`** (capability `CONTENT_PUBLISH`, target type `content_revision`,
target = the revision), payload `{ revisionId, contentHash, reasonCode }` — an approved revision is frozen,
so the hash binds the exact content, answer key included. It is requested only for an `APPROVED` question
revision, and only by someone who is not a contributor (they will execute it). Expiry, requester ≠
approver and the solo safeguard are OPS-02's.

`operation_approval_extended_target_type` is replaced repeating **both** earlier keys
(`CAREER_REQUIREMENT_SET_PUBLISH`, `CONTENT_SKILL_PUBLISH`) and adding this one. The rule lives as the pure
function `questionPublishAltersReadinessInputs` so it changes in one place if the pool is ever scoped.

## Decision 7: who sees the answer key

- **Read** the bank: `CONTENT_EDIT`, `CONTENT_REVIEW` or `CONTENT_PUBLISH`. Nobody else — no catalogue
  managers, no institution staff, no students.
- **Answer key** (`correctOptionId`, `explanation`, and the per-option misconception tags, which reveal
  which options are wrong): only with `CONTENT_EDIT` or `CONTENT_REVIEW`. A publisher without either sees
  the item with the key withheld and a plain notice, and approves the release on the reviewer's word. The
  approvals queue shows the key and revision, never the answer.
- **Learners**: the published `question_versions.options` holds `{id, text}` only; the answer is in
  `question_answer_keys`, which only the grading path reads; `startAssessmentAttempt` already strips the key
  (`toLearnerQuestionDto`'s rule). Difficulty, hints, tags and explanation are never in a learner DTO.
- **Audit context and outbox payloads** carry identifiers, keys and states only — never the answer.

## Audit and events

Audit (`resource_type = 'content_revision'`, resource id = the revision, reason code, break_glass when it
applies): `operations.content.question_created`, `…question_revision_started`, `…question_draft_saved`,
`…question_transitioned`, `…question_rights_reviewed`, `…question_published`.
Outbox (registered in `packages/events`, no consumer yet): `question_bank.revision_state_changed`,
`question_bank.question_published`.

## Screens

Under the existing **Content Management** label, below the skill map; no navigation item is added,
removed, renamed or reordered (HG-3). Operator screens are web-only (Appendix 1 §4.3): Android has no
operator surface and needs no change.

## Open points (decisions for Divakar)

1. **Every question publish needs an approval** (Decision 6), with the 15-minute solo cooling-off while
   Divakar is the only approver. Recommended until the pool is scoped.
2. **The readiness-check pool is every published question, whatever its topic.** A SOC question published
   here would join the Career Readiness Fundamentals check. The blueprint already declares its topics
   (`assessment_blueprints.constraints.topics`); recommended follow-up: select only from those topics, then
   relax Decision 6 for items outside every live blueprint. Not changed here: it alters live selection.
3. **Tagging is optional per wrong option** (Decision 2). Recommended.
4. **Misconception codes are chosen, not authored, here.** ENG-07 has no operator path to draft or publish
   a code; a tagged question cannot publish until its codes are published. A code editor is a follow-up.
5. **Difficulty bands** `FOUNDATION` / `INTERMEDIATE` / `ADVANCED`. Recommended; changing them is a code change.
