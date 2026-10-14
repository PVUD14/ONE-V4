-- 0106 — Content factory: AI drafts to review (ENG-23).
--
-- Why: operations asks ONE's AI to draft a lesson, a language variant or a practice question for a
-- skill, or to check a question's answer key. Each request is a job a worker runs through ONE AI
-- Orchestration (never a request handler); what the model writes lands in the existing editors as a
-- DRAFT with its provenance, authored by the person who asked, and goes through the same review and
-- second-person publish as human content. This table is the job: what was asked, by whom, what
-- happened, and what landed. The generated text is never stored here.
--   1. ai_content_drafts and its guard: no delete; the request is immutable; only forward moves;
--      a finished job never changes; provenance only on a job that produced a reply.
--   2. question_hint_ladders accepts AI_GENERATED under the same provenance rule as AGENT_DRAFTED
--      (generator, prompt, time and an expert-check note all required). Nothing is relaxed.
-- Design: docs/architecture/content-factory-design.md
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS, constraints dropped before being added, functions
-- replaced, triggers dropped before being created. Survives a replay of every earlier file before it;
-- references only tables from 0001–0089. No approval key is added, so
-- operation_approval_extended_target_type() is not redefined.

-- ---------------------------------------------------------------------------
-- 1. ai_content_drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_content_drafts (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  feature_key text NOT NULL REFERENCES ai_feature_policies(feature_key),
  prompt_key text NOT NULL,
  prompt_version integer NOT NULL,
  topic_id uuid REFERENCES taxonomy_nodes(id),
  base_lesson_id uuid,
  question_revision_id uuid REFERENCES content_revisions(id),
  stable_key text,
  title text,
  language text NOT NULL,
  level text,
  style text,
  author_note text,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  correlation_id text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED',
  outcome_code text,
  guard_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  source text,
  generator_version text,
  model text,
  generated_at timestamptz,
  fitted boolean,
  truncated boolean,
  produced_lesson_id uuid,
  produced_question_id uuid,
  produced_revision_id uuid REFERENCES content_revisions(id),
  check_option text,
  check_working text,
  check_agrees boolean,
  checked_content_hash text,
  review_state text
);

ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_kind_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_kind_ck CHECK (kind IN ('LESSON','LESSON_VARIANT','QUESTION','ANSWER_CHECK'));

-- Each kind runs one feature (its flag and cap).
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_feature_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_feature_ck CHECK (
  (kind IN ('LESSON','LESSON_VARIANT') AND feature_key = 'content.lesson-draft')
  OR (kind = 'QUESTION' AND feature_key = 'content.item-draft')
  OR (kind = 'ANSWER_CHECK' AND feature_key = 'content.answer-check'));

ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_prompt_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_prompt_ck CHECK (
  prompt_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$' AND prompt_version >= 1);

ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_language_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_language_ck CHECK (
  language IN ('en','hi','te','ta','kn','ml','mr','bn','gu','pa','or'));

-- What each kind targets, and nothing else. Levels and styles are words, never numbers.
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_target_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_target_ck CHECK (
  (kind = 'LESSON' AND topic_id IS NOT NULL AND base_lesson_id IS NULL AND question_revision_id IS NULL
    AND stable_key IS NOT NULL AND title IS NOT NULL AND language = 'en'
    AND level IN ('FOUNDATION','STANDARD','ADVANCED') AND style IN ('EXPLANATION','WORKED_EXAMPLE','STEP_BY_STEP','SUMMARY'))
  OR (kind = 'LESSON_VARIANT' AND base_lesson_id IS NOT NULL AND topic_id IS NULL AND question_revision_id IS NULL
    AND stable_key IS NULL AND title IS NOT NULL
    AND level IN ('FOUNDATION','STANDARD','ADVANCED') AND style IN ('EXPLANATION','WORKED_EXAMPLE','STEP_BY_STEP','SUMMARY'))
  OR (kind = 'QUESTION' AND topic_id IS NOT NULL AND base_lesson_id IS NULL AND question_revision_id IS NULL
    AND stable_key IS NOT NULL AND title IS NULL AND language = 'en'
    AND level IN ('FOUNDATION','INTERMEDIATE','ADVANCED') AND style IS NULL)
  OR (kind = 'ANSWER_CHECK' AND question_revision_id IS NOT NULL AND topic_id IS NULL AND base_lesson_id IS NULL
    AND stable_key IS NULL AND title IS NULL AND language = 'en' AND level IS NULL AND style IS NULL));

ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_text_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_text_ck CHECK (
  (stable_key IS NULL OR stable_key ~ '^[a-z0-9][a-z0-9-]{2,79}$')
  AND (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 200)
  AND (author_note IS NULL OR length(btrim(author_note)) BETWEEN 1 AND 1000)
  AND reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$');

ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_state_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_state_ck CHECK (
  state IN ('QUEUED','RUNNING','SUCCEEDED','REFUSED','REJECTED','FAILED'));

-- A job that did not land something says why; one that is still going or landed something does not.
-- The IS NOT NULL matters: a NULL inside a CHECK passes.
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_outcome_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_outcome_ck CHECK (
  (state IN ('QUEUED','RUNNING','SUCCEEDED') AND outcome_code IS NULL)
  OR (state IN ('REFUSED','REJECTED','FAILED') AND outcome_code IS NOT NULL AND outcome_code ~ '^[A-Z0-9_:-]{3,64}$'));

-- Guard findings exist exactly on a rejected job, at most twenty codes.
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_findings_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_findings_ck CHECK (
  jsonb_typeof(guard_findings) = 'array' AND jsonb_array_length(guard_findings) <= 20
  AND ((state = 'REJECTED') = (jsonb_array_length(guard_findings) > 0)));

ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_progress_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_progress_ck CHECK (
  attempts BETWEEN 0 AND 3
  AND ((state IN ('SUCCEEDED','REFUSED','REJECTED','FAILED')) = (finished_at IS NOT NULL))
  AND (state <> 'RUNNING' OR (started_at IS NOT NULL AND lease_expires_at IS NOT NULL AND attempts >= 1)));

-- Provenance of the generation: present exactly when the model produced a reply (a draft landed, the
-- guard rejected it, or the model declined), and always AI_GENERATED. A landed job always has it.
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_provenance_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_provenance_ck CHECK (
  (source IS NULL AND generator_version IS NULL AND model IS NULL AND generated_at IS NULL AND fitted IS NULL AND truncated IS NULL
    AND state <> 'SUCCEEDED')
  OR (source = 'AI_GENERATED' AND state IN ('SUCCEEDED','REJECTED','REFUSED')
    AND length(generator_version) BETWEEN 1 AND 128 AND length(model) BETWEEN 1 AND 200
    AND generated_at IS NOT NULL AND truncated IS NOT NULL));

-- What landed: a lesson (or variant) and its revision, or a question and its revision, only on success.
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_produced_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_produced_ck CHECK (
  (state = 'SUCCEEDED' AND kind IN ('LESSON','LESSON_VARIANT')
    AND produced_lesson_id IS NOT NULL AND produced_revision_id IS NOT NULL AND produced_question_id IS NULL)
  OR (state = 'SUCCEEDED' AND kind = 'QUESTION'
    AND produced_question_id IS NOT NULL AND produced_revision_id IS NOT NULL AND produced_lesson_id IS NULL)
  OR ((state <> 'SUCCEEDED' OR kind = 'ANSWER_CHECK')
    AND produced_lesson_id IS NULL AND produced_question_id IS NULL AND produced_revision_id IS NULL));

-- An answer check's result: advice to staff, never published, so its review state is always DRAFT.
ALTER TABLE ai_content_drafts DROP CONSTRAINT IF EXISTS ai_content_draft_check_ck;
ALTER TABLE ai_content_drafts ADD CONSTRAINT ai_content_draft_check_ck CHECK (
  (kind = 'ANSWER_CHECK' AND state = 'SUCCEEDED'
    AND check_option ~ '^[a-f]$' AND length(btrim(check_working)) BETWEEN 1 AND 600 AND check_agrees IS NOT NULL
    AND checked_content_hash ~ '^[0-9a-fA-F]{64}$' AND review_state = 'DRAFT')
  OR (NOT (kind = 'ANSWER_CHECK' AND state = 'SUCCEEDED')
    AND check_option IS NULL AND check_working IS NULL AND check_agrees IS NULL AND checked_content_hash IS NULL AND review_state IS NULL));

CREATE INDEX IF NOT EXISTS ai_content_drafts_queue_idx ON ai_content_drafts(requested_at, id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX IF NOT EXISTS ai_content_drafts_requester_idx ON ai_content_drafts(requested_by_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS ai_content_drafts_question_idx ON ai_content_drafts(question_revision_id, finished_at DESC) WHERE question_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_content_drafts_produced_idx ON ai_content_drafts(produced_revision_id) WHERE produced_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_content_drafts_topic_idx ON ai_content_drafts(topic_id, requested_at DESC) WHERE topic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_content_drafts_base_lesson_idx ON ai_content_drafts(base_lesson_id, requested_at DESC) WHERE base_lesson_id IS NOT NULL;

-- The request never changes; a job only moves forward; a finished job never changes; nothing is
-- deleted. Times are the database's.
CREATE OR REPLACE FUNCTION ai_content_draft_guard() RETURNS trigger AS $$
DECLARE
  request_columns text[] := ARRAY['id','kind','feature_key','prompt_key','prompt_version','topic_id','base_lesson_id',
    'question_revision_id','stable_key','title','language','level','style','author_note','requested_by_user_id','reason_code',
    'correlation_id','requested_at'];
  column_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content draft jobs are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'QUEUED' OR NEW.attempts <> 0 OR NEW.started_at IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'a content draft job starts queued';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  FOREACH column_name IN ARRAY request_columns LOOP
    IF (to_jsonb(OLD) -> column_name) IS DISTINCT FROM (to_jsonb(NEW) -> column_name) THEN
      RAISE EXCEPTION 'a content draft request is immutable';
    END IF;
  END LOOP;
  IF OLD.state IN ('SUCCEEDED','REFUSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'a finished content draft job is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'content draft attempts never decrease';
  END IF;
  IF NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('RUNNING','REFUSED','FAILED'))
    OR (OLD.state = 'RUNNING' AND NEW.state IN ('RUNNING','QUEUED','SUCCEEDED','REFUSED','REJECTED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid content draft job transition';
  END IF;
  IF NEW.state = 'RUNNING' AND (OLD.state = 'QUEUED' OR NEW.attempts > OLD.attempts) THEN
    NEW.started_at := now();
  END IF;
  IF NEW.state IN ('SUCCEEDED','REFUSED','REJECTED','FAILED') THEN
    NEW.finished_at := now();
    NEW.lease_expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ai_content_draft_guard ON ai_content_drafts;
CREATE TRIGGER ai_content_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_content_drafts
  FOR EACH ROW EXECUTE FUNCTION ai_content_draft_guard();

COMMENT ON TABLE ai_content_drafts IS
  'Content factory jobs (ENG-23): one request for an AI draft or answer check, its outcome and provenance. Never the generated text.';
COMMENT ON COLUMN ai_content_drafts.requested_by_user_id IS
  'Who asked; becomes the draft''s author, so they never review, approve or publish it.';

-- ---------------------------------------------------------------------------
-- 2. Hint ladders drafted by ONE's AI (ENG-23) keep that provenance
-- ---------------------------------------------------------------------------
ALTER TABLE question_hint_ladders DROP CONSTRAINT IF EXISTS question_hint_ladders_source_ck;
ALTER TABLE question_hint_ladders ADD CONSTRAINT question_hint_ladders_source_ck CHECK (source IN ('AUTHORED','AGENT_DRAFTED','AI_GENERATED'));
ALTER TABLE question_hint_ladders DROP CONSTRAINT IF EXISTS question_hint_ladders_provenance_ck;
ALTER TABLE question_hint_ladders ADD CONSTRAINT question_hint_ladders_provenance_ck CHECK (
  (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL) OR
  (source IN ('AGENT_DRAFTED','AI_GENERATED') AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
    AND expert_check_notes IS NOT NULL));
