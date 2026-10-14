# ADR-052 — "Ask ONE to explain": AI lessons a student sees without a person reviewing each one

Records Divakar's scoped waiver of the "lands as DRAFT for a human to publish" rule for one separate
area of ONE, and the safeguards that came with it.

- **Status:** Accepted — 2026-10-10.
- **Decided by:** Divakar (owner), 2026-10-10. This is **his scoped waiver** of the CLAUDE.md AI rule
  "Anything a model produces is stored as a row carrying `source`, `generator_version`, `prompt_version`,
  `review_state`, `generated_at`, and lands as `DRAFT` for a human to publish." CLAUDE.md lets only
  Divakar waive a rule; he did, for this area only.
- **Context:** ENG-20 (inference adapter), ENG-21 (bake-off and the 0089 evaluation gate), ENG-22 (tutor
  hints, the outbox-job pattern), ENG-23 (content factory, the content guard), OPS-01/OPS-02 (capabilities,
  approvals), OPS-12 (AI console, kill switch). Design: `docs/architecture/ask-to-explain-design.md`.
- **Supersedes:** nothing. The review rule stands unchanged everywhere else.

## The decision, as taken

> A student can ask ONE to explain any topic — data science, nuclear physics — and receives an
> AI-written lesson, without a person reviewing each lesson.

## What the waiver covers, and what it does not

It covers exactly one thing: the text of an "Ask ONE to explain" lesson may be shown to the student who
asked (and to later students asking the same topic) before any person has read it. The row is stored with
the full provenance CLAUDE.md asks for; only its starting `review_state` is `AI_UNREVIEWED` instead of
`DRAFT`.

It does **not** cover:

- the official curriculum: content revisions, the content factory (ENG-23), lessons, questions, hint
  ladders — anything that counts. Those keep "DRAFT for a human to publish" unchanged. A lesson from this
  area reaches the curriculum only by an operator's *promote*, which creates an ordinary `DRAFT` lesson that
  then goes through the normal review and second-person publish;
- readiness, skill state, attempts, evidence, placement, or anything an employer or institution sees. The
  area writes none of those tables and no institution or employer endpoint reads it;
- any other AI feature. Every other model output still lands as DRAFT.

## Safeguards (all mandatory; the design doc says how each is enforced and tested)

1. **A separate, labelled area.** Every lesson carries "AI-generated — not checked by a person" on web and
   Android. It never counts toward readiness, skill state, attempts, evidence or placement and is never
   shown to an employer or institution.
2. **A job, never a request.** POST answers 202; generation is an outbox job
   (`explain.lesson.requested`); no model call in a handler.
3. **ONE AI Orchestration only.** Feature `learning.explain-topic`, its own flag (off by default), its own
   global daily cap, the kill switch, metering; per-student limits (one lesson being prepared, ten
   requests a day). Prompt `explain-topic@1`, English only, refuses harmful and off-platform requests with
   one `REFUSED:` line, never mentions readiness or job outcomes.
4. **An automatic guard before anything is shown** (ENG-23's content guard, plus unsafe-instruction
   patterns). Failing, truncated or malformed output is never shown.
5. **One cached lesson per (normalised topic, model, prompt version)**, immutable, with provenance; only
   `review_state` moves, by operations (and FLAGGED by a student report).
6. **Report a mistake** for students; an operations review-by-exception queue (flagged and most-viewed)
   with *withdraw* (hidden immediately) and *promote to official draft*. Audited, capability-gated.
7. **English only** for now; topic text 3–120 characters, no personal data.
8. **Switching on needs a passing evaluation** (0089) of the new `explain-topic` task in a new evaluation
   set, `one-ai-explain` v1, whose thresholds are stricter on facts than the reviewed lesson draft's.

## Rejected

- **Showing unreviewed AI lessons inside the official course.** The course is what readiness, staff and
  colleges read; mixing unreviewed text into it would make "everything that counts was checked by a person"
  untrue. Kept as a separate area instead, reaching the course only through promote → DRAFT → review.
- **A person reviewing every lesson before a student sees it.** The topic space is unbounded ("any topic");
  a review queue in front of every lesson means students wait days for an answer, or the queue is skipped.
  Replaced by an automatic guard, caching (each topic reviewed at most once), student reports and a
  review-by-exception queue on flagged and most-viewed lessons.
- **Synchronous generation in the request.** Breaks CLAUDE.md's "no model call in a request handler" and
  "generation is a job on the outbox", ties a web request to a 30–90 s generation, and bypasses the
  outbox's retries and idempotency. The request enqueues; the screen polls.
- **No cache (generate per student).** Multiplies cost by the number of students and means a withdrawal of
  one bad lesson does not stop the same text being generated again a minute later.
- **Requiring the `ai-tutoring` consent.** The model never receives anything about the student — only the
  normalised, PII-checked topic text — so the purpose that consent covers (a model reading the student's
  practice) does not arise. Recorded as an open point in the design doc should Divakar prefer it.
