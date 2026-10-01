# Content factory (AI drafts to review) — Design and table design

**Status:** Adopted (ENG-23), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-02
**Migration:** `0106_content_factory.sql` (one table, `ai_content_drafts`; one widened provenance CHECK)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`. `ai_content_drafts` decides what
reaches the content review queue under a model's name, so it carries consequences and gets this document first.
**Builds on:** `inference-adapter-design.md` (ENG-20: worker-only calls), `ai-bake-off-design.md` (ENG-21: the
`content.lesson-draft` and `content.answer-check` features and their v1 prompts), `ai-evaluations-table-design.md`
(OPS-12: flags, caps, kill switch, the evaluation gate), `lesson-variant-editor-design.md` (OPS-09c),
`question-bank-editor-design.md` and `question-hint-ladders-table-design.md` (OPS-09b), `lesson-language-serving-design.md`
(ENG-16), ADR-037 (external faculty review), ADR-047.

## Why this exists

Program Part D, ENG-23: "Outbox jobs that draft items, hints and variants into the review queue as DRAFT with full
provenance; per-feature caps. Acceptance — C13: nothing publishes without an approver; the cap stops calls with a
typed error." Divakar's intent: operations presses **Draft with AI** for a skill; a background job drafts the
lesson (and its explanation), a language variant, or a practice question with its hint ladder; the draft lands in
the existing editors labelled *AI draft*, with its provenance in view, and goes through exactly the review and
second-person publish path that human content goes through. Nothing a model writes is ever published by the
system, and the person who asked for a draft cannot approve it. Off by default; first switched on in the demo
sandbox.

Everything that makes that safe already exists and is reused, not rebuilt:

| Need | Already there |
| --- | --- |
| Model calls only from workers, never a request handler | ENG-20: `createWorkerAiOrchestrator`; `inference-boundary.spec.ts` |
| A switch per feature, default off, a cap per feature, the global kill switch | 0033 / 0089: `ai_feature_policies`, `AiOrchestrator.generate` (kill switch → flag → cap → size → call), typed errors |
| A model may run only with a passing evaluation of the exact model and prompt | 0089's enable gate; ENG-21's bake-off records |
| Metering of every attempt, refusals included | `ai_generations` |
| Drafts, review, rights review, approval, publish | OPS-09a–c editors, 0004 lifecycle, 0057/0061/0065 author-never-publishes triggers, 0090 archive, `CONTENT_*_PUBLISH` approvals |
| Second-language drafts reviewed by a native speaker | ENG-16 language review code on approval |

What is missing is the job: a durable request, a worker that runs it through the orchestrator, a code guard on the
output, and the hand-off into the editors with provenance a reviewer can see.

## Decision 1: what the factory drafts

| Kind | Feature (flag, cap) | Prompt | Lands as |
| --- | --- | --- | --- |
| `LESSON` — a lesson, with its explanation, for one skill | `content.lesson-draft` (50 / day) | `content-lesson-draft` v1 (ENG-21) | revision 1 of a new base lesson, DRAFT, skill set |
| `LESSON_VARIANT` — a second-language rendering of a live lesson | `content.lesson-draft` | `content-lesson-draft` v1, in the variant's language | revision 1 of a new variant, DRAFT, marked for native-speaker review (ENG-16) |
| `QUESTION` — a practice question with its four-step hint ladder | `content.item-draft` (50 / day) | `content-item-draft` v1 (**new**, this goal) | revision 1 of a new question, DRAFT, options, key, explanation and ladder filled |
| `ANSWER_CHECK` — an independent solve of a question under review | `content.answer-check` (200 / day) | `content-answer-check` v1 (ENG-21) | a result on the job row, shown to reviewers next to the key; never content |

`content.item-draft` is new because no registered prompt drafts items. It is declared like ENG-21's three
(registration inserts it switched off), and **it cannot be switched on until a bake-off records a passing evaluation
for `content-item-draft` v1** — the 0089 gate, unchanged. ENG-21's set v1 has no item-drafting cases, so this goal
ships the kind built and tested on the local fake endpoint, and the gate keeps it off (open point 1).

Lessons and variants share one feature because they run one prompt: one evaluation, one switch, one cap.

**Rejected: a feature per kind with private prompts.** An evaluation binds `(feature, model, prompt)`; a
variant-only feature running the same prompt would need a duplicate record of the same numbers.
**Rejected: drafting misconception tags with the model.** A tag names a reviewed misconception code and why the
option signals it; a model guessing code ids would produce plausible wrong tags that look reviewed. People add
tags in the question editor, as today.

## Decision 2: the request is a row and an outbox event; the worker runs it

**Request (API, `CONTENT_EDIT`; answer checks `CONTENT_REVIEW`).** One transaction writes an `ai_content_drafts`
row in `QUEUED`, its audit row (`operations.content.ai_draft_requested`) and an outbox event
`content_factory.draft_requested` (identifiers and enums only). No model is called, and nothing about inference is
read except the policy row. The request is refused, with a typed code and no row, when:

| Code | When |
| --- | --- |
| `AI_FEATURE_NOT_REGISTERED` | no policy row for the kind's feature (`ai:register-features` not run) |
| `AI_KILL_SWITCH_ENGAGED` | `ai.global-kill-switch` is on |
| `AI_FEATURE_DISABLED` | the feature is off |
| `AI_CAP_REACHED` | successful generations in the window plus jobs still queued or running reach the cap |
| `AI_DRAFTS_IN_FLIGHT` | the requester already has 3 jobs queued or running |
| target codes | unknown or retired skill, base lesson not live, variant triple taken, key in use, question revision not reviewable … |

The request-time check is a courtesy (an operator should not wait for a job that will refuse). The worker checks
again, through the orchestrator, at the moment of the call — the only check that counts.

**Worker (`ai:content-factory`, persistence).** Claims one `QUEUED` job (or a `RUNNING` one whose lease expired)
with `FOR UPDATE SKIP LOCKED`, marks it `RUNNING` with a 10-minute lease, then — outside any transaction — calls
`orchestrator.generate`, guards the reply (Decision 4), and in one transaction writes the draft through the
editors' own functions, finishes the job, audits and emits `content_factory.draft_finished`. A job is attempted at
most three times; a crash mid-call leaves a `RUNNING` row whose lease expires, and the next claim retries it.

**Rejected: running the model call inside the local outbox dispatcher's handler.** The dispatcher holds a 60-second
lease per event and the adapter may legitimately take longer (60 s timeout, retries); a lease lost mid-call makes
the dispatcher throw `OutboxReconciliationRequiredError` and stop. The outbox event still records the request on
the pipeline (ADR-028) and the local dispatcher acknowledges it as unrouted; the job row is the work queue, as
`automation_commands` is for workflow calls.
**Rejected: a filter on `claimOutboxBatch` so a content worker drains only its own events.** It changes the claim
every other consumer relies on, for no gain over a row the worker owns.

## Decision 3: author, provenance and the review path

The person who pressed **Draft with AI** is the draft's `author_user_id`. Every separation rule then applies with
no new code: they are a contributor, so they cannot review or approve it (`refuseLessonTransition`,
`refuseQuestionTransition`, and 0004's database refusal of an author's APPROVE); they never publish it
(0057/0061/0065 triggers); the approver never publishes a lesson; every question publish and a base lesson's first
publish need a second person's approval (`CONTENT_QUESTION_PUBLISH`, `CONTENT_LESSON_PUBLISH`). No approval key is
added, so `operation_approval_extended_target_type()` is not redefined.

The revision body carries the provenance (CLAUDE.md: `source`, `generator_version`, `prompt_version`,
`review_state`, `generated_at`; `review_state` is the revision's own `state`, `DRAFT` on arrival):

```json
"provenance": { "source": "AI_GENERATED", "generatorVersion": "one-ai-orchestration-v1+openai-compatible-v1",
                "promptVersion": "content-lesson-draft@1", "promptFingerprint": "…", "model": "qwen2.5-14b-instruct",
                "generatedAt": "2026-10-02T…Z", "jobId": "…uuid…" },
"expertCheck": "Drafted by ONE's AI from the skill description. Check every fact, example and number …",
"aiDraft": { "sections": { "What you will learn": "…", … }, "fitted": false, "truncated": false, "guard": "content-guard-v1" }
```

The editors carry keys they do not own, so the label survives every edit, and `publishedLessonBody` /
`publishedQuestionColumns` copy only the learner text — **a student never sees that a lesson or question started as
an AI draft**, and nothing about provenance reaches `lesson_versions` or `question_versions`. The editors read the
block with a new pure reader (`readAiDraftProvenance`, beside `readAgentDraftProvenance`): `AI_GENERATED` is a
third source, distinct from `AGENT_DRAFTED` (a coding agent writing into the repository).

**Lesson mapping.** The v1 lesson prompt returns five fixed headings. The learner text is `summary` (≤ 1000) and
`practice` (≤ 2000), so: summary = *What you will learn* + *Explanation*; practice = *Worked example* + *Common
mistakes* + *Check yourself*, each heading kept as a line. A part longer than its limit is cut at the last paragraph
or sentence that fits and the draft is marked `fitted`; the reviewer sees the full model text under **AI draft**
in the editor. Title and stable key are the requester's (defaulting to the skill's name and key); module and
licence are left for a person (a draft cannot be submitted without a licence). `basis` names the source.
**Rejected: a new prompt version asking for shorter lessons.** It would need its own bake-off; the fit is
mechanical and visible.

**Question mapping.** The item prompt returns `{prompt, options[4], correct, explanation, hints[4]}`; it becomes a
question with options a–d, the key, the explanation, difficulty as requested, the four hints, no tags and no
licence. At submission the hint ladder row is written with the item's provenance: 0106 widens
`question_hint_ladders_source_ck` to accept `AI_GENERATED` under the same rule as `AGENT_DRAFTED` (generator,
prompt, time and an expert-check note all required) — a stricter-or-equal rule for the new value, nothing relaxed.
A person adding a misconception tag to an AI item writes an `AUTHORED` tag: the model wrote no tag.

**Answer check.** The result (the model's option, its ≤ 60-word working, whether it agrees with the key, and the
revision's content hash at the time) is stored on the job and shown only to viewers who may see answer keys, next
to the key, as advice. It never changes the question, never blocks a transition, and a later edit shows it as
stale (the hash differs).

## Decision 4: the guard (code, before anything lands)

`packages/ai-evaluation/src/content-guard.ts` (`content-guard-v1`) reuses the bake-off's checks, so what was measured
is what is enforced. A reply that fails lands nothing; the job ends `REJECTED` with finding codes.

| Finding | Lesson / variant | Question | Answer check |
| --- | --- | --- | --- |
| `MODEL_REFUSED` (one line `REFUSED: …`) | job `REFUSED` | — | — |
| `FORMAT_INVALID` | five headings in order, 150–900 words, no `<think>` | one JSON object, 4 non-empty options, key in a–d, 4 hints, lengths within the editor's limits | `{option, working}` with option in the item's ids |
| `TRUNCATED` | output stopped at the token limit | same | same |
| `LANGUAGE_MISMATCH` | script share (ENG-21 rule) for the requested language | English | — |
| `PERSONAL_DATA` | e-mail address or Indian mobile number | same | same |
| `READINESS_OR_SCORE` | a readiness / score / marks / rank figure (`\d+ %` near those words) | same | — |
| `OUTCOME_PROMISE` | a guaranteed job, placement, offer | same | — |
| `QUOTES_ASSESSMENT_ITEM` | the lesson repeats the prompt of a question in the bank for that skill (any state) | — | — |
| `HINT_NAMES_ANSWER`, `HINT_NAMES_OPTION`, … | — | ENG-15's `hintLadderFindings` on the ladder against the drafted key | — |
| `DUPLICATE_OPTIONS` | — | two options with the same text | — |

An answer key may appear in a question's explanation (that is what it is for); it may not appear in a lesson as a
copy of a bank item a student will be assessed on, nor in a hint.

**Rejected: a second model as the guard.** The bake-off rejected model-as-judge; the same reason applies here.

## Decision 5: caps, kill switch, audit

- **Per-feature cap**, enforced by the orchestrator at call time: `AiCapExceededError` (typed), metered
  `REFUSED / CAP_EXCEEDED`; the job ends `REFUSED` with `outcome_code = CAP_EXCEEDED`. The request API refuses
  `AI_CAP_REACHED` (HTTP 429) once successes plus queued work reach the cap. A guard-rejected reply still counts:
  the model was called.
- **Kill switch / feature off** at call time: `REFUSED / KILL_SWITCH_ENGAGED` or `FEATURE_DISABLED`, nothing called.
  A queued job meeting an engaged kill switch ends refused rather than waiting.
- **C13's "per-college cap"** is about the tutor (ENG-25), whose calls are about a college's students. Content
  drafts are platform content requested by operations staff; their cap is the feature's.
- **Audit** (`resource_type = 'ai_content_draft'`): `operations.content.ai_draft_requested` (requester) and
  `operations.content.ai_draft_finished` (the requester as actor — the worker acts for them — with the state,
  outcome code, findings and produced revision). The draft itself gets the editors' usual
  `operations.content.lesson_created` / `question_created` / `…_draft_saved` rows with `source: AI_GENERATED`.
- **No personal data goes to the model.** Prompts carry a skill's name and description, a staff author note, and
  for answer checks a question's text; the author note is checked for e-mail addresses and phone numbers at request.

## Table: `ai_content_drafts`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `kind` | text NOT NULL, CHECK in (`LESSON`, `LESSON_VARIANT`, `QUESTION`, `ANSWER_CHECK`) |
| `feature_key` | text NOT NULL → `ai_feature_policies` (the feature the kind runs; registration must have happened) |
| `prompt_key`, `prompt_version` | what the job will run, from the policy row at request time |
| `topic_id` | uuid → `taxonomy_nodes`; required for `LESSON`, `QUESTION`; else NULL |
| `base_lesson_id` | uuid; required for `LESSON_VARIANT` (a lesson is an entity id, not a table row) |
| `question_revision_id` | uuid → `content_revisions`; required for `ANSWER_CHECK` |
| `stable_key` | text; the new lesson's or question's key (`LESSON`, `QUESTION`), `^[a-z0-9][a-z0-9-]{2,79}$` |
| `title` | text 1–200; the new lesson's or variant's title (`LESSON`, `LESSON_VARIANT`) |
| `language` | text NOT NULL, ISO 639-1 from the lesson vocabulary; `en` for questions and checks |
| `level`, `style` | lesson level / style, or question difficulty band in `level`; words, never numbers |
| `author_note` | text ≤ 1000, NULL; what the requester asked for. No e-mail or phone (checked by the API) |
| `requested_by_user_id` | uuid NOT NULL → `users`; becomes the draft's author |
| `reason_code`, `correlation_id` | the request's reason (`AI_DRAFT_*`) and correlation id |
| `state` | `QUEUED` → `RUNNING` → `SUCCEEDED` / `REFUSED` / `REJECTED` / `FAILED` |
| `outcome_code` | NULL until terminal; required for every terminal state but `SUCCEEDED` (`^[A-Z0-9_:-]{3,64}$`) |
| `guard_findings` | jsonb array of finding codes, ≤ 20; non-empty only on `REJECTED` |
| `attempts`, `lease_expires_at` | 0–3; the worker's lease |
| `requested_at`, `started_at`, `finished_at` | database clock |
| `source`, `generator_version`, `model`, `generated_at`, `fitted`, `truncated` | provenance of the generation (with `prompt_key` / `prompt_version` above), set exactly when a reply was produced (`SUCCEEDED`, `REJECTED`, model `REFUSED`); `source = 'AI_GENERATED'` |
| `produced_lesson_id`, `produced_question_id`, `produced_revision_id` | what landed; `produced_revision_id` → `content_revisions`, required for a `SUCCEEDED` draft kind |
| `check_option`, `check_working`, `check_agrees`, `checked_content_hash`, `review_state` | the answer check's result; required together for a `SUCCEEDED` `ANSWER_CHECK`, with `review_state = 'DRAFT'` (advice to staff, never published) |

**Guard trigger** (`ai_content_draft_guard`): no delete; the request columns (`id` … `correlation_id`,
`requested_at`) never change; a terminal row never changes; the only moves are `QUEUED → RUNNING`,
`RUNNING → RUNNING` (lease renewal on retry), `RUNNING → QUEUED` (released for retry), `QUEUED|RUNNING → terminal`;
`finished_at` set by the database on the terminal move. The generated text itself is not stored on the row: it is
the content revision's body (or, for a rejected reply, nowhere — a rejected reply is not kept, so nothing a guard
refused can be read back into a screen).

Indexes: the queue (`state, requested_at` where `QUEUED`/`RUNNING`), the requester (`requested_by_user_id,
requested_at DESC`), and lookups by `question_revision_id`, `produced_revision_id`, `topic_id`, `base_lesson_id`.

Idempotent: `CREATE TABLE IF NOT EXISTS`, constraints dropped and re-added, functions replaced, triggers dropped
before created. It applies once and survives a replay of every earlier file.

## Screens

**Web (operations, under Content Management; no navigation change, HG-3).** Lessons and Question bank each get an
**AI drafts** card: the feature's state (off / on / stopped by the kill switch), today's use against the cap, a
**Draft with AI** button when the viewer may edit and the feature is on, and the viewer's recent jobs with their
state (queued, running, drafted, refused, rejected with findings, failed) and a link to the draft. A live lesson
gets **Draft a translation with AI**. A drafted revision shows an **AI draft** badge, the provenance (model, prompt
version, when, requested by, job) and the model's full text; the list marks AI drafts. A question in review shows
**Check the answer key with AI** to reviewers and the latest check beside the key. Nothing renders an invented
value: a missing figure reads NA.

**Android.** Operations is view-only on Android and has no content editors, so nothing changes there. A lesson or
question that started as an AI draft reaches the app only after a person publishes it, through the same
`lesson_versions` / `question_versions` rows as any other content, with no provenance — it looks like any other
content to students on both clients.

## What this does not do

- Switch anything on. Registration inserts `content.item-draft` off; enabling any of the three needs a passing
  evaluation, the kill switch released and a second person's approval (OPS-12).
- Publish anything, or move a draft past `DRAFT`.
- Send any student's data to a model.
- Touch readiness. A published AI-drafted question joins the readiness-check pool only through the
  `CONTENT_QUESTION_PUBLISH` approval, exactly like ENG-10's agent-drafted items.

## Open points (decisions for Divakar)

1. **Item drafting needs its own bake-off cases.** Recommended: ENG-21's set v2 adds ~30 item-drafting cases scored
   with the guard above plus the answer-check solve of each drafted item; until then `content.item-draft` stays off.
2. **Who may request.** Recommended `CONTENT_EDIT` for drafts and `CONTENT_REVIEW` for answer checks, three jobs in
   flight per person.
3. **Rejected replies are not kept.** Recommended (nothing refused can leak into a screen); operators see the
   findings and the metered call. Keeping them for prompt tuning would be a separate, access-controlled store.
