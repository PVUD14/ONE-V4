# Lesson Languages for Students — Design (learner_language_preferences)

**Status:** Adopted (ENG-16), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** `0097_learner_language_preferences.sql` (one table)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** `lesson-variant-editor-design.md` (OPS-09c: variants as their own LESSON entities, Decision 3 left
serving to ENG-16), `content-archive-design.md` (an archived variant has no PUBLISHED revision),
`content-bulk-import-design.md` (OPS-09d: imported and agent-drafted variants land as DRAFT with provenance),
ADR-037 (external faculty review is advisory)

## Why this exists

Appendix D, ENG-16: "Variant metadata on content revisions (language, level, style) if OPS-09c did not add it; draft
second-language variants for the aptitude lessons in the language Divakar chooses … marked for native-speaker review.
Acceptance: students can select a language; missing variants fall back to English with a notice."

OPS-09c added the metadata and the editor: a Telugu rendering of a lesson is its own LESSON entity whose body names
its base (`variantOf`) and its triple (`te`/level/style), reviewed and published like any lesson, writing no
`lesson_versions` row. Nothing yet lets a student choose a language, and nothing serves a published variant. The
recorded default second language for the Andhra Pradesh pilot is **Telugu** (Divakar was asked once; no other answer
was given).

## Decision 1: where the student's choice lives

**Chosen: a small table, `learner_language_preferences`,** one row per person who has chosen:

| Column | Type | Rule |
| --- | --- | --- |
| `user_id` | `uuid` PK, FK `users(id)` | the learner; one row each |
| `lesson_language` | `text NOT NULL` | CHECK in the eleven OPS-09c codes (`en hi te ta kn ml mr bn gu pa or`) |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | set by the database on every change |

No row means English. Choosing English again keeps the row (with `en`); nothing else reads it. The row is upserted by
the learner only, through `PUT /api/v1/career-readiness/me/lesson-language`, and written with an audit row
(`learner.lesson_language.changed`, resource `learner_language_preference`, context `{ from, to }`).

**Privacy.** It is the person's own setting: included in their export (`lessonLanguage` beside the notification
preferences) and deleted with the account (counted under `STUDENT_PROFILE`, the category the profile and goals use).
Nobody else reads it: no college, employer or operator screen shows which language a student reads in.

**Rejected: a column on `student_profiles`.** The profile routes require a student relationship; lessons are open to
any signed-in learner (the career-readiness routes take the principal only), and writing the column would create
profile rows as a side effect for people who never made one.
**Rejected: the browser or phone only.** The choice would not follow the student between the web and the Android app,
which must tell the same story.
**Rejected: a whole-app locale on `users`.** ONE's interface is not translated; only lessons have renderings. Calling
this a locale would promise a Telugu interface that does not exist.

## Decision 2: which languages a student may choose

**English, Telugu, and any language that has at least one published variant.** Telugu is always offered because it
is the pilot's second language, so a Telugu reader can choose it before every lesson is translated and sees each
missing one fall back with a notice — which is the goal's acceptance. Another language appears only once there is
something to read in it. The server refuses a language not offered (`LESSON_LANGUAGE_NOT_OFFERED`); a stored choice
that later stops being offered (its only variant archived) keeps working and simply falls back everywhere.

Each language is shown by its own name and script (`తెలుగు`), with the English name beside it.

## Decision 3: what a student is served (`lesson-rendering-v1`, pure)

For each **current** lesson version (the catalogue's `superseded_at IS NULL` rows) and the chosen language `L`:

1. `L = en`: the English lesson, no notice.
2. Otherwise the candidates are the **latest PUBLISHED revision** of each variant entity whose `variantOf` is the
   lesson's base entity, whose language is `L`, and whose release manifest is PUBLISHED. A DRAFT, IN_REVIEW,
   CHANGES_REQUESTED or APPROVED revision is never a candidate, and neither is an ARCHIVED one (archiving turns every
   published revision of a variant to ARCHIVED, so an older one never resurfaces).
3. Pick one deterministically: same level and style as the base first, then same level, then `STANDARD`, then the
   vocabulary order of level and style. (A student chooses a language, not a level; OPS-09c's level and style
   variants are for later adaptive serving, but a published `FOUNDATION` Telugu rendering is still the lesson in
   Telugu and better than English for that reader.)
4. No candidate: the **English** lesson with notice `TRANSLATION_MISSING` ("Not yet available in Telugu — showing
   English").
5. A candidate whose `basedOnRevision` is older than the lesson's current version: served, with notice
   `TRANSLATION_OUTDATED` ("The English lesson was updated after this Telugu version was written"). OPS-09c left this
   to ENG-16. Recommended: serve it. It passed a native-speaker check and three people; a later English revision is most
   often a wording fix, and falling back would take the lesson away from a Telugu reader until a translator catches up.
   The notice lets the student switch to English. Changing this to a fallback is one line in the pure function.

What is replaced is only the words: `title`, `body.summary`, `body.practice` (a variant without a practice prompt
shows none). The lesson's **id, version, topic and prerequisites stay the base's**: completing a lesson read in
Telugu completes the base lesson and writes the same single `LESSON_COMPLETION` evidence, so readiness inputs do
not depend on the language, and a student who switches language keeps every completion.

Each served lesson carries `language` (what the text is in) and `languageNotice` (`null`, `TRANSLATION_MISSING`,
`TRANSLATION_OUTDATED`). The learner state carries `lessonLanguage: { selected, offered[] }`.

**Where it applies:** the signed-in learner state (`GET /career-readiness/me`, whose catalogue web and Android both
read) and the lesson titles on the learning step (ENG-18). The public `GET /career-readiness/catalog` stays English:
it has no learner.

**Never served:** an unpublished draft, and nothing generated on request. There is no machine translation anywhere
in this path, and no model is called (AI hold). Text a model or the coding agent drafted reaches a student only after
it was reviewed and published by people, exactly as English content does (CLAUDE.md AI rules, program B.8).

## Decision 4: "marked for native-speaker review"

A variant in a language other than English cannot be **approved** without a language-review code from the reviewer,
in the same request as the rights review:

| Code | Meaning |
| --- | --- |
| `NATIVE_SPEAKER_REVIEWED` | the reviewer reads the language natively and checked the text against the English |
| `NATIVE_SPEAKER_CONSULTED` | a native speaker's review was obtained and checked (for example an ADR-037 faculty review) |

Refused without one (`LESSON_LANGUAGE_REVIEW_MISSING`), and refused with one on an English revision or on a move other
than APPROVED (`REASON_CODE_INVALID`). The code is recorded in the transition audit row and in the approval's
`source_records.source_metadata` (`languageReview`), beside the rights review. The pure rule is
`refuseLessonTransition` in `packages/authorization`; the persistence layer passes it the revision's language.

Until approved, a non-English variant is shown in the editor with the chip **Needs native-speaker review**. The
separation rules are unchanged: the author, editors and submitter never review; the approver never publishes.

## Decision 5: second-language drafts for the aptitude lessons

**None are written in this goal.** ENG-10 built aptitude *questions* (300 items, DRAFT) and their skills; there are no
aptitude *lessons*, and a variant can only be made for a live base lesson (OPS-09c Decision 3). The drafting path is
complete for when they exist: an operator creates the Telugu variant in the editor, or imports it (OPS-09d) with an
agent-draft provenance block (`generatorVersion`, `promptVersion`, `generatedAt`, `expertCheck`), and it lands as
DRAFT, marked for native-speaker review. A later ONE AI Orchestration job (ENG-23, gated by HG-2) fills the same
shape through `createLessonVariant(…, agentDraft)` and changes nothing downstream. Writing Telugu text here would put
agent-written language in front of a reviewer as if it were a translation, which the AI hold and the brief rule out.

## Fonts

Telugu needs a Telugu-capable font. Both clients bundle **Noto Sans Telugu** (SIL Open Font License 1.1, licence
file shipped beside it) and use it only for text whose language is Telugu:

- **Web:** `public/fonts/NotoSansTelugu-Regular.ttf`, registered at runtime through the CSS Font Loading API as
  `ONE Telugu` with `unicode-range: U+0C00-0C7F` (so it is fetched only when Telugu text appears), applied to the
  lesson text with `lang="te"`. No stylesheet is added and no shared component is restyled.
- **Android:** `res/font/noto_sans_telugu_regular.ttf` and `_bold.ttf`, used for Telugu lesson text; the system
  font fallback remains for any other script.

## Migration 0097

`CREATE TABLE IF NOT EXISTS learner_language_preferences` with its CHECK, idempotent, no data, no change to any
existing table. It applies once (ADR-035) and survives a bootstrap replay.

## Open points (decisions for Divakar)

1. **Stale translations are served with a notice** (Decision 3.5). The alternative is to fall back to English.
2. **Telugu is always offered**; other languages appear with their first published variant.
3. **No aptitude lessons exist yet**, so no Telugu drafts were written (Decision 5).
4. **Level and style are not a student choice.** The student chooses a language; level and style variants are picked
   in a fixed order until adaptive serving exists.
