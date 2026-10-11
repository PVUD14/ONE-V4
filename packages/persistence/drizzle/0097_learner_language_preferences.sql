-- 0097 — The language a learner reads lessons in (ENG-16).
--
-- Why: OPS-09c (0065) lets operators publish a lesson's variants in other languages, but a student
-- had no way to choose one. One row per person who has chosen; no row means English. Only the
-- learner writes it (through the career-readiness API), nobody else reads it, it is in the person's
-- export and is deleted with their account. The eleven codes are OPS-09c's LESSON_LANGUAGES.
-- Design: docs/architecture/lesson-language-serving-design.md
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; no data; no change to any existing table. Applies once
-- (ADR-035) and survives a bootstrap replay.

CREATE TABLE IF NOT EXISTS learner_language_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  lesson_language text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_language_preferences_language_ck
    CHECK (lesson_language IN ('en','hi','te','ta','kn','ml','mr','bn','gu','pa','or'))
);

COMMENT ON TABLE learner_language_preferences IS
  'ENG-16: the language a learner chose to read lessons in. No row = English. Personal: exported and erased with the account.';
