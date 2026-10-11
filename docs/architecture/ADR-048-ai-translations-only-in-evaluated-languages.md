# ADR-048 — AI lesson translations only in languages the model passed

Records which languages ONE's AI may translate a lesson into, after the second ENG-21 bake-off.

- **Status:** Accepted — 2026-10-07. Proposed with a recommendation and carried on per the
  repository's "ask once, recommend, carry on" rule; Divakar can reverse it.
- **Context:** ADR-047 (inference on the RunPod pod); `docs/architecture/ai-bake-off-design.md`.

## What the evaluation found

The 2026-10-07 bake-off of `qwen2.5-14b-instruct` with the v2 prompts, 200 cases:

- `content.answer-check`: every automatic threshold met.
- `tutor.hint`: every automatic threshold met in English, Hindi and Telugu (over-refusal 1.1 %,
  p95 8.9 s). Waiting only on the human review.
- `content.lesson-draft`: 43 of 57 drafts met their expectation, and **all 14 failures were
  Telugu**. Ten hit the 120-second limit and the rest were cut off or failed the format
  check. English and Hindi had no failures. The model spends many more tokens per Telugu
  word, so a whole Telugu lesson is both long and slow on this pod.

The lesson editor accepts eleven languages (`LESSON_LANGUAGES`). Only English, Hindi and
Telugu were ever evaluated.

## Decision

1. An AI translation (`LESSON_VARIANT`) may be requested only in a language in
   `AI_TRANSLATION_LANGUAGES` (`packages/persistence/src/content-factory.ts`), now
   `['en', 'hi']`. Any other language is refused with `AI_DRAFT_LANGUAGE_NOT_EVALUATED` before
   a job is queued, so nothing reaches the model.
2. The content factory status reports the list as `translationLanguages`, and the translation
   form offers only those languages.
3. People can still write a lesson in any of the eleven languages by hand. Only AI drafting is
   limited.
4. Telugu tutor hints are not affected: they passed.
5. A language joins the list only after a bake-off in which the served model passes
   `content.lesson-draft` in it, and the result is recorded.

## Rejected

- **Allow Telugu and raise the token and time limits.** The 120-second p95 limit is part of the
  evaluation design, and a cut-off lesson is not a lesson. Raising the limits to pass would be
  weakening the test.
- **Test a larger model now.** Possible, but it costs more per pod-hour and the per-student
  cost would rise. It is worth doing only when Telugu lessons are needed. It stays open.
- **Keep all eleven languages and rely on the human reviewer.** CLAUDE.md requires each AI
  feature to be benchmarked against its task before it reaches a student. Eight of the
  languages were never tested.
