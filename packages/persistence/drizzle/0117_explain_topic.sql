-- 0117 — "Ask ONE to explain" (ADR-052): AI lessons on any topic a student asks about, shown without a
-- person reviewing each one, under Divakar's scoped waiver of 2026-10-10.
-- Design: docs/architecture/ask-to-explain-design.md
--
-- Why: the waiver is safe only if what was generated, what ONE's guard found and what each student was
-- shown is on record and cannot be rewritten. Three tables:
--   1. explain_lessons — one generation per (normalised topic, model, prompt version), the cache. Names no
--      one. The request never changes, status only moves forward, the generation is written once, only
--      review_state moves (FLAGGED by a student report; WITHDRAWN / PROMOTED by operations). Never deleted.
--   2. explain_topic_requests — the student's own record of asking. Immutable; privacy deletion only.
--   3. explain_lesson_reports — "Report a mistake". Immutable; privacy deletion only.
-- None of these is read by readiness, skill state, evidence, placement, institutions or employers.
--
-- Idempotent: CREATE … IF NOT EXISTS, constraints dropped before being added, functions replaced, triggers
-- dropped before being created. References only tables from earlier migrations.

-- ---------------------------------------------------------------------------
-- 1. explain_lessons
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS explain_lessons (
  id uuid PRIMARY KEY,
  topic_key text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  feature_key text NOT NULL REFERENCES ai_feature_policies(feature_key),
  prompt_version text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  failure_code text,
  guard_findings text[] NOT NULL DEFAULT '{}',
  guard_version text,
  generated_text text,
  source text NOT NULL DEFAULT 'AI_GENERATED',
  generator_version text,
  served_model text,
  prompt_fingerprint text,
  truncated boolean,
  generated_at timestamptz,
  review_state text NOT NULL DEFAULT 'AI_UNREVIEWED',
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_reason_code text,
  promoted_lesson_id uuid,
  promoted_revision_id uuid REFERENCES content_revisions(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  correlation_id text NOT NULL
);

ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_topic_ck;
-- The key is the normalised topic: trimmed, lower-case, single spaces, 3-120 characters.
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_topic_ck CHECK (
  length(topic_key) BETWEEN 3 AND 120 AND topic_key = lower(regexp_replace(btrim(topic_key), '\s+', ' ', 'g')));
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_scope_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_scope_ck CHECK (
  language = 'en' AND feature_key = 'learning.explain-topic' AND source = 'AI_GENERATED'
  AND prompt_version ~ '^explain-topic@[1-9][0-9]{0,5}$' AND length(model) BETWEEN 1 AND 200
  AND correlation_id ~ '^[A-Za-z0-9._:-]{1,200}$');
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_status_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_status_ck CHECK (
  status IN ('PENDING','GENERATING','READY','REFUSED','BLOCKED','FAILED'));
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_findings_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_findings_ck CHECK (
  guard_findings <@ ARRAY['FORMAT_INVALID','TRUNCATED','LANGUAGE_MISMATCH','PERSONAL_DATA','READINESS_FIGURE','PLACEMENT_CHANCE',
    'OUTCOME_PROMISE','UNSAFE_INSTRUCTIONS','READINESS_MENTION']::text[]);
-- Generated text arrives with its provenance, all at once, at most 12000 characters.
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_generation_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_generation_ck CHECK (
  (generated_text IS NULL) = (generated_at IS NULL)
  AND (generated_text IS NULL OR (length(generated_text) BETWEEN 1 AND 12000
    AND length(generator_version) BETWEEN 1 AND 200 AND length(served_model) BETWEEN 1 AND 200
    AND prompt_fingerprint ~ '^[0-9a-f]{8,64}$' AND truncated IS NOT NULL)));
-- Open lessons carry no outcome; a ready, refused or blocked one carries the reply and the guard's
-- version; a blocked one says what the guard found; a failed one says why.
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_outcome_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_outcome_ck CHECK (
  (status IN ('PENDING','GENERATING') AND completed_at IS NULL AND failure_code IS NULL AND cardinality(guard_findings) = 0
    AND generated_text IS NULL AND guard_version IS NULL)
  OR (status = 'READY' AND completed_at IS NOT NULL AND failure_code IS NULL AND cardinality(guard_findings) = 0
    AND generated_text IS NOT NULL AND guard_version IS NOT NULL AND truncated = false)
  OR (status = 'REFUSED' AND completed_at IS NOT NULL AND failure_code IS NULL AND cardinality(guard_findings) = 0
    AND generated_text IS NOT NULL AND guard_version IS NOT NULL)
  OR (status = 'BLOCKED' AND completed_at IS NOT NULL AND failure_code IS NULL AND cardinality(guard_findings) > 0
    AND generated_text IS NOT NULL AND guard_version IS NOT NULL)
  OR (status = 'FAILED' AND completed_at IS NOT NULL AND cardinality(guard_findings) = 0 AND generated_text IS NULL
    AND failure_code IN ('AI_UNAVAILABLE','GENERATION_FAILED','EXPIRED')));
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_versions_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_versions_ck CHECK (guard_version IS NULL OR length(guard_version) BETWEEN 1 AND 64);
-- Review: only a ready lesson leaves AI_UNREVIEWED; withdraw and promote name who, when and why;
-- a promoted lesson names the official draft it became.
ALTER TABLE explain_lessons DROP CONSTRAINT IF EXISTS explain_lessons_review_ck;
ALTER TABLE explain_lessons ADD CONSTRAINT explain_lessons_review_ck CHECK (
  review_state IN ('AI_UNREVIEWED','FLAGGED','WITHDRAWN','PROMOTED')
  AND (review_state = 'AI_UNREVIEWED' OR status = 'READY')
  AND ((review_state IN ('AI_UNREVIEWED','FLAGGED') AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason_code IS NULL)
    OR (review_state IN ('WITHDRAWN','PROMOTED') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
        AND review_reason_code ~ '^[A-Z][A-Z_]{2,63}$'))
  AND ((promoted_lesson_id IS NULL) = (promoted_revision_id IS NULL))
  AND (review_state <> 'PROMOTED' OR promoted_lesson_id IS NOT NULL));

-- The cache: one live lesson per topic, model and prompt version. A FAILED attempt (provider down,
-- cap, expired) frees the topic for another try.
CREATE UNIQUE INDEX IF NOT EXISTS explain_lessons_cache_uq ON explain_lessons(topic_key, model, prompt_version) WHERE status <> 'FAILED';
CREATE INDEX IF NOT EXISTS explain_lessons_review_idx ON explain_lessons(review_state, completed_at DESC) WHERE status = 'READY';

CREATE OR REPLACE FUNCTION guard_explain_lesson() RETURNS trigger AS $$
DECLARE
  request_columns text[] := ARRAY['id','topic_key','language','feature_key','prompt_version','model','source','requested_at','correlation_id'];
  generation_columns text[] := ARRAY['generated_text','generator_version','served_model','prompt_fingerprint','truncated','generated_at'];
  outcome_columns text[] := ARRAY['failure_code','guard_findings','guard_version','completed_at'];
  column_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'explain lessons are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' OR NEW.review_state <> 'AI_UNREVIEWED' OR NEW.generated_text IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL
       OR NEW.promoted_lesson_id IS NOT NULL OR NEW.guard_version IS NOT NULL OR cardinality(NEW.guard_findings) <> 0 THEN
      RAISE EXCEPTION 'an explain lesson is requested as PENDING and AI_UNREVIEWED, with nothing generated';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  FOREACH column_name IN ARRAY request_columns LOOP
    IF (to_jsonb(OLD) -> column_name) IS DISTINCT FROM (to_jsonb(NEW) -> column_name) THEN
      RAISE EXCEPTION 'explain_lessons: the request is never changed';
    END IF;
  END LOOP;
  IF OLD.generated_at IS NOT NULL THEN
    FOREACH column_name IN ARRAY generation_columns LOOP
      IF (to_jsonb(OLD) -> column_name) IS DISTINCT FROM (to_jsonb(NEW) -> column_name) THEN
        RAISE EXCEPTION 'explain_lessons: a generation is written once';
      END IF;
    END LOOP;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('GENERATING','FAILED'))
    OR (OLD.status = 'GENERATING' AND NEW.status IN ('READY','REFUSED','BLOCKED','FAILED'))) THEN
    RAISE EXCEPTION 'explain_lessons: status moves forward only';
  END IF;
  IF OLD.status IN ('READY','REFUSED','BLOCKED','FAILED') THEN
    FOREACH column_name IN ARRAY outcome_columns LOOP
      IF (to_jsonb(OLD) -> column_name) IS DISTINCT FROM (to_jsonb(NEW) -> column_name) THEN
        RAISE EXCEPTION 'explain_lessons: a finished lesson''s outcome is final';
      END IF;
    END LOOP;
  END IF;
  IF NEW.review_state IS DISTINCT FROM OLD.review_state AND NOT (
       (OLD.review_state = 'AI_UNREVIEWED' AND NEW.review_state IN ('FLAGGED','WITHDRAWN','PROMOTED'))
    OR (OLD.review_state = 'FLAGGED' AND NEW.review_state IN ('WITHDRAWN','PROMOTED'))
    OR (OLD.review_state = 'PROMOTED' AND NEW.review_state = 'WITHDRAWN')) THEN
    RAISE EXCEPTION 'explain_lessons: review moves AI_UNREVIEWED or FLAGGED to WITHDRAWN or PROMOTED, PROMOTED to WITHDRAWN, never back';
  END IF;
  IF NEW.review_state IS NOT DISTINCT FROM OLD.review_state AND (NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code) THEN
    RAISE EXCEPTION 'explain_lessons: a review is recorded with its move';
  END IF;
  IF OLD.promoted_lesson_id IS NOT NULL AND (NEW.promoted_lesson_id IS DISTINCT FROM OLD.promoted_lesson_id
     OR NEW.promoted_revision_id IS DISTINCT FROM OLD.promoted_revision_id) THEN
    RAISE EXCEPTION 'explain_lessons: a promotion is final';
  END IF;
  IF NEW.review_state IN ('WITHDRAWN','PROMOTED') AND NEW.review_state IS DISTINCT FROM OLD.review_state THEN
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS explain_lessons_guard ON explain_lessons;
CREATE TRIGGER explain_lessons_guard BEFORE INSERT OR UPDATE OR DELETE ON explain_lessons
  FOR EACH ROW EXECUTE FUNCTION guard_explain_lesson();

COMMENT ON TABLE explain_lessons IS
  'ADR-052: one AI lesson per (normalised topic, model, prompt version), shown to students without a person reviewing it (Divakar''s scoped waiver, 2026-10-10). Names no one; never counts toward anything.';

-- ---------------------------------------------------------------------------
-- 2. explain_topic_requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS explain_topic_requests (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  lesson_id uuid NOT NULL REFERENCES explain_lessons(id),
  topic_text text NOT NULL,
  served_from_cache boolean NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  CONSTRAINT explain_topic_requests_text_ck CHECK (length(btrim(topic_text)) BETWEEN 3 AND 120 AND length(correlation_id) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS explain_topic_requests_once_uq ON explain_topic_requests(subject_user_id, lesson_id);
CREATE INDEX IF NOT EXISTS explain_topic_requests_subject_idx ON explain_topic_requests(subject_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS explain_topic_requests_lesson_idx ON explain_topic_requests(lesson_id);

-- ---------------------------------------------------------------------------
-- 3. explain_lesson_reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS explain_lesson_reports (
  id uuid PRIMARY KEY,
  lesson_id uuid NOT NULL REFERENCES explain_lessons(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  note text,
  reported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT explain_lesson_reports_reason_ck CHECK (reason_code IN ('WRONG_FACT','CONFUSING','UNSAFE','NOT_WHAT_I_ASKED','OTHER')),
  CONSTRAINT explain_lesson_reports_note_ck CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS explain_lesson_reports_once_uq ON explain_lesson_reports(lesson_id, subject_user_id);
CREATE INDEX IF NOT EXISTS explain_lesson_reports_subject_idx ON explain_lesson_reports(subject_user_id);

-- A student asks and reports once, about a lesson they were answered with; the rows never change and are
-- removed only by privacy deletion for the same subject (the 0072 pattern).
CREATE OR REPLACE FUNCTION guard_explain_student_row() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% rows are removed only by privacy deletion', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% rows never change', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'explain_lesson_reports' AND NOT EXISTS (
    SELECT 1 FROM explain_topic_requests r JOIN explain_lessons l ON l.id = r.lesson_id
    WHERE r.lesson_id = NEW.lesson_id AND r.subject_user_id = NEW.subject_user_id AND l.status = 'READY'
  ) THEN
    RAISE EXCEPTION 'a report is about a ready lesson the student was answered with';
  END IF;
  IF TG_TABLE_NAME = 'explain_topic_requests' THEN
    NEW.requested_at := now();
  ELSE
    NEW.reported_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS explain_topic_requests_guard ON explain_topic_requests;
CREATE TRIGGER explain_topic_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON explain_topic_requests
  FOR EACH ROW EXECUTE FUNCTION guard_explain_student_row();
DROP TRIGGER IF EXISTS explain_lesson_reports_guard ON explain_lesson_reports;
CREATE TRIGGER explain_lesson_reports_guard BEFORE INSERT OR UPDATE OR DELETE ON explain_lesson_reports
  FOR EACH ROW EXECUTE FUNCTION guard_explain_student_row();

COMMENT ON TABLE explain_topic_requests IS 'ADR-052: a student asked ONE to explain a topic, and the lesson they were answered with. The student''s own record.';
COMMENT ON TABLE explain_lesson_reports IS 'ADR-052: a student reported a mistake in an AI lesson they were shown. The student''s own record.';
