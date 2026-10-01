# Tutor Hints — Brief, Hint Policy, Guard and Table Design (ENG-22)

**Status:** Adopted (ENG-22). Recommended options taken per AGENTS.md ("ask once, recommend, carry on");
every decision below records what was rejected.
**Date:** 2026-10-02
**Migration:** `0107_tutor_hints.sql` (see "Migration number" — 0105, the number on the register, is
already used by ENG-20's `0105_inference_adapter.sql`)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`. The table carries
provenance and an audit trail of what a model said to a student, so it is a table with consequences.

## Why this exists

A student stuck on a practice question can already climb ENG-15's human hint ladder (nudge → strategy →
worked step → near solution). ENG-21 registered the prompt `tutor-hint` v1 and the feature `tutor.hint`
and built the evaluation set that decides whether a model may run it. ENG-22 is the piece between them:
the student asks for help, a model writes one hint at the right ladder level, ONE's code checks it, and
the student sees either that hint, labelled as AI, or the human hint for the same level.

The product rules this has to keep (Divakar, CLAUDE.md, Part D):

- never the answer; AI help is labelled as AI;
- it counts as assisted exactly like the human ladder (0047/0072: a success after hint 3 or 4 is assisted
  and never counts toward DEMONSTRATED);
- off by default; first switched on in the demo sandbox (sample data), not production; the switch-on path
  needs a passing `ai_evaluations` record (0089) and is not bypassed;
- generation is an outbox job — the request enqueues, the screen polls; no model call in a handler;
- output stored with `source`, `generator_version`, `prompt_version`, `review_state`, `generated_at`;
- readiness never enters a prompt; a guard refuses leaks, readiness/score/placement talk, personal data and
  the wrong language; a refused output falls back to the human ladder;
- a cap per student per day; everything audited; the tutor cannot write evidence or mastery.

## What already existed

| Piece | Where | Used as |
|---|---|---|
| Practice on a learning step, server-recorded hint level, assisted rule | `learning-experience.ts`, 0072 `learning_step_items`, 0047 | The only place the tutor exists; an AI hint raises the same `hint_level` |
| Published human ladders | `question_hint_ladders` (OPS-09b / ENG-15) | The grounding for every AI hint and the fallback |
| `tutor-hint` v1 prompt, `tutor.hint` feature (cap 500/day, off) | `ai-orchestration/src/first-features.ts` (ENG-21) | Run unchanged — the evaluation is bound to it |
| Bake-off checks | `ai-evaluation/src/checks.ts` (`parseTutorReply`, `tutorFormatOk`, `tutorLeaks` → ENG-15 `hintLeakFinding`, `languageMatches`, `unsafeContent`) | Imported by the runtime guard, not copied |
| Worker-only orchestrator | `persistence/src/ai-workers.ts` (ENG-20) | The only way the job reaches the model |
| Flag, cap, kill switch, evaluation gate | 0033, 0089 (OPS-12) | Unchanged; the tutor reads them, never writes them |
| `ai-tutoring` consent purpose | ENG-01 `consent-purposes.ts` | Required for every request; no definition is published (HG-6) |

## Decision 1 — How the DRAFT / human-publish rule applies to per-student hints

CLAUDE.md: "Anything a model produces is stored as a row carrying `source`, `generator_version`,
`prompt_version`, `review_state`, `generated_at`, and lands as `DRAFT` for a human to publish." The rule's
intent is that a model is never the last check on what a person reads: a human stands behind it.

A tutor hint is unlike a lesson draft: it is written for one student, about one question, at the moment
they are stuck, and is worthless an hour later. Four ways to keep the rule were weighed.

**A. Pre-generated AI ladders, reviewed before use.** The model drafts extra ladder variants offline
(ENG-23's content factory); a reviewer publishes them; students only ever see published text.
Keeps the rule literally. Rejected *as the tutor*: it is not a tutor — there is nothing per-student, and
what it produces is exactly ENG-15's human ladder with more variants, which is ENG-23's job and lands
there. It remains the right home for any AI text that is reusable.

**B. Live hints behind a code guard, with human review moved to the model and prompt, and staff
sampling after the fact. (Chosen.)** A human decision stands in front of every hint, at three levels:

1. *Before any student sees any hint:* a person approves the model + prompt pair. 0089 refuses to
   switch `tutor.hint` on without a PASS for exactly the served model and `tutor-hint@1`, and ENG-21's PASS
   for this feature requires a human review sheet (teaching quality, language quality, factual errors on
   at least 30 cases). The switch-on is itself an OPS-02 dual-control approval.
2. *For every hint:* the model only rephrases what a human already published — the AI is offered only on
   a question with a PUBLISHED ladder, and the prompt carries the approved hints up to the requested
   level. ONE's code guard (Decision 4) checks every reply before it is shown; anything it refuses is
   replaced by the human hint for that level.
3. *After the fact:* every hint is stored as `review_state = 'DRAFT'` with full provenance, and AI
   Operations shows a daily random sample and every refusal; a staff reviewer marks sampled hints
   `PUBLISHED` (reviewed, fine) or `REJECTED` (reviewed, should not have been shown), with a reason,
   audited. Rejections are counted on the console; a pattern of them is a reason to switch the feature
   off (the existing one-click switch and kill switch).

The student sees the hint while it is still DRAFT, and the screen says so in plain words: "AI hint —
written by the AI tutor and checked by ONE's rules; not reviewed by a person." That is the honest
statement of what B does, and it is why the label is not optional.

**C. Every live hint held until a person approves it.** Keeps the rule literally per hint. Rejected: the
student would wait minutes to hours for help with a question they are stuck on now; in practice they
would leave the question, and staffing a live review queue for every student's every hint is not
something a two-person project can do. It produces the outcome the rule exists to prevent — unreviewed
text — only later, or no help at all.

**D. Live hints with no stored text (metering only).** Rejected: nothing to audit, sample or export;
it breaks the provenance half of the rule.

B is chosen because it keeps the rule's intent — a human decision stands behind everything a student
reads, and every output is recorded, reviewable and attributable — at the only granularity that leaves a
tutor useful. The DRAFT state is honest about what has and has not been looked at by a person.

## Decision 2 — An AI hint is a hint level

Asking for an AI hint releases the next ladder level exactly as "Show hint" does: in the same transaction
the request raises `learning_step_items.hint_level` by one (the 0072 trigger allows only +1 on an
unanswered item) and records the request at that level. The hint the student then sees — AI or the
human fallback — is a hint at that level. So:

- the assisted rule needs no change: an answer after level 3 or 4 is assisted whether the level came from
  the ladder or the tutor (0047's `highest_hint_level >= 3`);
- the level is the server's record, never the client's or the model's;
- the four-step ladder is the tutor's policy: level 1 nudge, 2 strategy, 3 worked step, 4 near solution
  (`hintLevelMeanings`, unchanged), at most four hints per question, one level at a time.

*Rejected: AI hints outside the ladder (a separate "ask the tutor" with no level).* Every AI reply would
need its own assisted rule, and a student could get a near solution while the record said "no hint".

## Decision 3 — The tutoring brief: structured, no personal data, no free text

The brief is built by the server from content only: the question's prompt and options, the answer key
(for the model's rules and for the guard, never returned to the client), the PUBLISHED hints up to the
level, the level and its meaning, and the language. It has no field for a name, an identifier, an
institution, a band, readiness, attempt history or anything else about the student; `buildTutorBrief`
takes only those inputs, and a test pins its keys.

The student's "message" (the prompt's `studentMessage`) is not typed by the student in v1. The server
picks one of ENG-21's evaluated request phrasings in the student's language: "I don't know where to start"
for level 1 and "I've understood the first part. What should I do next?" for levels 2–4. *Rejected for
v1: free-text questions.* Free text brings personal data and prompt injection into the request, and the
evaluation covered only a small abuse set; it can be added later with its own evaluation cases.

The parameters are rendered exactly as the evaluation set renders them (option lines `a) text`, the
correct option `c) text`, approved hints `Level n: …`, `languageNames`), and a test proves the runtime
brief and the evaluated case produce byte-identical messages for the same item and level — so the PASS
record describes what students actually receive.

**Language.** The tutor serves the student's chosen lesson language (ENG-16) when it is one the
evaluation covered — English, Telugu, Hindi. For any other language the tutor is unavailable and says so;
the human ladder still works. *Rejected: falling back to English* — C6 asks for the student's language.

## Decision 4 — The guard: the bake-off's own checks, plus stricter runtime checks

`guardTutorReply` (packages/tutoring, `tutor-guard-v1`) runs on every reply before it is stored as shown.
It **imports** ENG-21's checks rather than copying them, so the rules that scored the evaluation are the
rules that guard production:

| Check | Source | Refusal code |
|---|---|---|
| One JSON object `{type, text}`, not truncated, no `<think>`, 1–600 characters | `tutorFormatOk`, `parseTutorReply` | `FORMAT` |
| States the correct option's text, or points at its letter | `tutorLeaks` → ENG-15 `hintLeakFinding` | `ANSWER_LEAK` |
| Personal data (an email address, an Indian mobile number) or a promised job/placement | `unsafeContent` | `PERSONAL_DATA` / `PROMISE` |
| Not in the requested script | `languageMatches` | `WRONG_LANGUAGE` |
| *Runtime only:* "the answer is…", "correct option is…" | tutor guard | `ANSWER_LEAK` |
| *Runtime only:* the correct option's number (e.g. `48` of `48 km/h`) when the question does not state it | tutor guard | `ANSWER_LEAK` |
| *Runtime only:* readiness, score, marks, rank, percentile, placement, job offer, hiring, chances (English, Hindi, Telugu terms), unless the question itself uses the word | tutor guard | `READINESS_OR_PLACEMENT` |
| *Runtime only:* arithmetic stated in the hint (`12 × 4 = 46`) that is false | tutor guard — maths checked by code | `ARITHMETIC_ERROR` |
| *Runtime only:* code in the reply (a fence, a program line) | tutor guard | `CODE_UNVERIFIED` |
| A `REDIRECT` reply | — | not shown; the human hint is |

The runtime-only checks can only refuse more; they never pass what the evaluation would count as a leak.
Their over-refusal is visible (fallback counts by reason on the console) and costs the student nothing but
an AI label — they get the human hint. Folding them into the next evaluation-checks version is an open
point.

**Repair vs refuse.** The guard repairs only form: surrounding whitespace, one surrounding code fence
(already tolerated by `parseTutorReply`), and runs of spaces. It never edits content — a reply with a leak,
personal data or a wrong sum is refused whole, because deleting the offending sentence leaves a hint whose
meaning nobody checked. Repairs are recorded on the row.

**Code claims and the sandbox.** Practice items today are aptitude multiple-choice questions; the isolated
code sandbox (ENG-12) is not provisioned (HG-7). Until a code check exists, a reply containing code is
refused (`CODE_UNVERIFIED`) and the human hint is shown. When code items reach practice, the guard gains a
sandbox check instead of the refusal.

## Decision 5 — The request is a job; the screen polls

`POST /api/v1/learning/steps/:decisionId/tutor-hints {questionId}` does only database work, in one
transaction under the student's step lock: checks (Decision 6), raise the hint level, insert the
`tutor_hints` row as `PENDING`, write the `tutor.hint.requested` outbox event, write the audit row. It
answers with the step view, in which that level shows as *pending*.

The worker (local outbox dispatcher, ADR-028) consumes the event: re-checks consent, the audience, that the
question is still unanswered and that the request is still fresh; claims the row (`PENDING → GENERATING`,
so a redelivered event never calls twice); builds the brief from the database; calls ONE AI Orchestration
(which applies the kill switch, the feature switch, the feature cap and the size limit, and meters the
call) with a deadline; runs the guard; and records `SHOWN` or `FALLBACK` with the outcome. The model call
is outside any database transaction.

The web and Android screens poll `GET /steps/:decisionId` every two seconds while a level is pending.
A request has **45 seconds**: after that, the step view shows the human hint for that level, and a late
generation is stored (for audit) but never shown. The same window bounds the call's deadline, which keeps
a tutor job well inside the outbox lease (60 s).

Answering the question while a hint is pending is allowed; the worker then records `FALLBACK`
(`WITHDRAWN`) without calling the model.

*Rejected: server-sent events or push.* Polling a read the screen already makes is enough for a 2–10 s
wait and needs nothing new on either client.
*Rejected: a dedicated tutor worker process.* Right at scale (a slow model call holds up other outbox
events in the single dispatcher), not needed for the sandbox. Recorded as a follow-up for ENG-25.

## Decision 6 — Who gets the button, and when it refuses

`decideTutorHintRequest` (pure, `tutor-hint-policy-v1`) answers allowed or a reason, in this order:

| Reason | Meaning | Student sees |
|---|---|---|
| `ASSESSMENT_MODE` | Not a practice/learn/review step (placement test, readiness check, exam) | — (no tutor there at all) |
| `OFF` | Deployment audience is not the sandbox, the feature is off, or the kill switch is engaged | no AI button |
| `NO_CONSENT` | No `ai-tutoring` grant (every real student until HG-6) | no AI button |
| `LANGUAGE_NOT_SUPPORTED` | Lesson language not evaluated | "The AI tutor does not write in your language yet" |
| `NO_LADDER` | Question has no published ladder (nothing to ground on, nothing to fall back to) | "No hints for this question" |
| `HINTS_USED` | Level 4 already shown | — |
| `PENDING` | A hint for this question is still being written | "The AI tutor is writing your hint…" |
| `DAILY_LIMIT` | 20 AI hints today (the student's own daily cap; the feature's global cap is separate) | "You have used today's AI hints. The written hints still work." |

**Audience.** No AI reaches a real student until the privacy notice names the pod's US processing
(HG-6). So the tutor serves only a deployment that declares itself the sandbox:
`ONE_AI_TUTOR_AUDIENCE=sandbox` **and** `ONE_SANDBOX=true` **and** `NODE_ENV` is not `production`. Any
other environment reads `OFF`, whatever the database flag says, in the API and again in the worker. The
live path for real students is ENG-25's (per-college flags), after HG-6.

**Per-student daily cap: 20.** Counted from `tutor_hints` rows requested since the start of the database
day (the same day boundary as the feature cap), in the request transaction. Fallbacks count, because the
request is what was spent. *Rejected: an environment variable for it* — a cap is a product decision; it
changes in a reviewed release (ENG-25 can move it to per-college policy).

## Decision 7 — The tutor cannot write evidence or mastery

Nothing in `packages/tutoring` touches the database. The tutor's persistence (`tutor-hints.ts` for
requests, reviews and views; `tutor-hint-worker.ts` for the job) writes only `tutor_hints`, `outbox_events`,
`audit_events`, `event_consumer_receipts`, `ai_generations` (through the orchestrator) and the one
`hint_level` increment. A test reads both modules and refuses any write to `evidence_records`,
`mastery_projections`, `learner_skill_state`, `learning_attempt_events`, `readiness_snapshots` or
`learning_decisions`; an integration test runs a full request → generation → answer cycle and shows the
evidence and mastery tables change only through the existing answer path. The tutor never reads readiness.

## Decision 8 — Staff audit and sampling

AI Operations (existing screen, no navigation change) gains a "Tutor hints" panel:

- `GET /api/v1/operations/ai/tutor-hints?view=sample|refused|reviewed` — `AI_OPS_VIEW`. A *sample* is up to
  20 DRAFT, completed hints from the last 7 days in a deterministic random order (by a hash of the id and
  the day, so two reviewers see the same sample on the same day); *refused* is every recent fallback with
  its guard findings. Each row carries the question's prompt (content), the level, the language, the
  outcome, the findings and the generated text. Never the student's name, email or id.
- `POST /api/v1/operations/ai/tutor-hints/:id/review {verdict: APPROVE|REJECT, reasonCode}` —
  `AI_OPS_CONFIGURE`; sets `review_state` to `PUBLISHED` or `REJECTED` once, audited with the reason.
  Reasons: approve `ACCURATE_AND_SAFE`; reject `LEAKS_ANSWER`, `WRONG_CONTENT`, `WRONG_LEVEL`,
  `WRONG_LANGUAGE`, `UNSAFE`, `POOR_TEACHING`.

## Table: `tutor_hints`

One row per AI hint request.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `subject_user_id` | uuid → users | The student |
| `institution_id` | uuid → organizations, null | D.1: every engine row carries it where the student belongs to one |
| `decision_id` | uuid → learning_decisions | The step |
| `item_id` | uuid → question_versions | The question |
| `hint_level` | smallint 1–4 | The ladder level this request released |
| `language` | text: `en`, `te`, `hi` | The language asked of the model |
| `status` | `PENDING`, `GENERATING`, `SHOWN`, `FALLBACK` | |
| `fallback_reason` | null or `GUARD_REFUSED`, `REDIRECTED`, `GENERATION_FAILED`, `AI_UNAVAILABLE`, `EXPIRED`, `WITHDRAWN` | Set exactly when `FALLBACK` |
| `guard_findings` | text[] | Refusal codes (Decision 4), empty when shown |
| `guard_repairs` | text[] | Form repairs applied |
| `generated_text` | text, null, ≤ 4000 | The model's hint text (staff-only when refused) |
| `source` | `AI_GENERATED` | Provenance |
| `generator_version` | text, null | From the orchestrator, set with the generation |
| `prompt_version` | text | `tutor-hint@1` |
| `prompt_fingerprint` | text, null | From the orchestrator |
| `model` | text, null | The policy's model at generation |
| `policy_version` | text | `tutor-hint-policy-v1` |
| `guard_version` | text, null | `tutor-guard-v1` when the guard ran |
| `review_state` | `DRAFT` (default), `PUBLISHED`, `REJECTED` | Decision 1 |
| `reviewed_by_user_id`, `reviewed_at`, `review_reason_code` | null until a staff review | All or none |
| `requested_at` | timestamptz, DB clock | |
| `generated_at` | timestamptz, null | Set with `generated_text` |
| `completed_at` | timestamptz, null | Set with `SHOWN` / `FALLBACK` |
| `correlation_id` | text | |

Constraints and triggers:

- one AI request per (decision, item, level) — unique;
- `SHOWN` needs generated text, provenance, the guard version, no findings and no fallback reason;
  `FALLBACK` needs a reason; `PENDING`/`GENERATING` have neither;
- insert only as `PENDING`/`DRAFT`, and only at the level the step item now records (the request raised
  it in the same transaction) — the trigger reads `learning_step_items`;
- status moves only `PENDING → GENERATING → SHOWN|FALLBACK` or `PENDING → FALLBACK`; identity, level,
  language and request columns never change; generation columns are written once;
- `review_state` moves once, from `DRAFT` to `PUBLISHED`/`REJECTED`, only on a completed row with
  generated text, with reviewer, time and reason;
- rows are removed only by privacy deletion for the same subject (the 0072 pattern,
  `one.privacy_erase_subject`).

## Privacy, purge, events

- **Export** (`privacy-export-sections.ts`, learning section): level, language, status, the text the
  student was shown (the AI text when shown), requested and completed times, review state. Guard
  findings and refused text are staff working notes and are not included; `notIncluded` says so.
- **Deletion** (`privacy-deletion.ts`): removed with the learning records, before the step items.
- **Institution exit purge:** `tutor_hints` carries `institution_id` and is the student's own learning
  record — added to `institutionPurgeOutOfScope` with that reason.
- **Event:** `tutor.hint.requested` v1, payload `{tutorHintId}`, data classification confidential,
  registered in `packages/events`. The consumer is `tutor-hint-generator`, listed in `knownJobConsumers`
  so System Health shows it and it can have a silence alert.
- **Audit:** `tutor.hint.requested` (actor: the student), `tutor.hint.completed` (actor: none, the
  worker; context: outcome, reason, findings — never text), `tutor.hint.reviewed` (actor: the reviewer).

## How it is switched on in the sandbox

`docs/ops/runbook-tutor-hints-sandbox.md`. In order: the sandbox API and a sandbox outbox worker carry
`ONE_SANDBOX=true` and `ONE_AI_TUTOR_AUDIENCE=sandbox` (the worker also the `ONE_AI_*` endpoint
variables); `ai:register-features` registers `tutor.hint`; the bake-off PASS for the served model is
imported into the sandbox database (`ai:bake-off-import` — the existing gate, unchanged);
`ai:tutor-sandbox-consent` publishes a sandbox-only `ai-tutoring` definition and grants it to the
sample students (it refuses anything that is not the sandbox database); then `tutor.hint` is switched
on in AI Operations through the existing OPS-02 approval. Production is not touched.

## Migration number

The register in `.program/PROGRAM_STATE.md` assigns 0105 to ENG-22, but ENG-20 merged
`0105_inference_adapter.sql` under that number. Two files sharing a number would sort by name and work,
but would break the "one number, one change" convention the register exists for. This change uses
**0107**, the next number nobody holds; the coordinator may renumber it before merging (no other file
refers to the number).

## Open points

1. Fold the runtime-only guard checks into `bake-off-checks-v2` so the evaluation measures them.
2. Free-text questions from the student: a v2 prompt with its own evaluation cases (PII, injection).
3. A dedicated tutor worker when ENG-25 takes the tutor beyond the sandbox.
4. The per-student daily cap (20) is a starting value; ENG-25 may make it per-college.
