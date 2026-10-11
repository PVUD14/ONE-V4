-- ENG-03: the learning attempt log and learning sessions.
--
-- One append-only log of graded responses, in one shape for every item bank, written in
-- the same transaction as the grading it records; and the sessions those attempts belong
-- to. Designs: docs/architecture/learning-attempt-events-table-design.md and
-- learning-sessions-table-design.md. Both tables are engine behavioural data: append-only
-- for everyone, erasable only by the privacy-deletion transaction for the same subject
-- (ADR-034). Idempotent, because the migrator replays every file on every run.

CREATE TABLE IF NOT EXISTS learning_sessions (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  mode text NOT NULL,
  language text,
  model_version text,
  prompt_version text,
  tokens integer,
  cost_amount numeric(12,6),
  cost_currency text,
  source_type text,
  source_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_sessions_mode_ck CHECK (mode IN ('LEARN','PRACTICE','REVIEW','ASSESSMENT','EXPLORE')),
  CONSTRAINT learning_sessions_language_ck CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  CONSTRAINT learning_sessions_model_prompt_ck CHECK ((model_version IS NULL) = (prompt_version IS NULL)),
  CONSTRAINT learning_sessions_model_len_ck CHECK (model_version IS NULL OR length(model_version) BETWEEN 1 AND 128),
  CONSTRAINT learning_sessions_prompt_len_ck CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128),
  CONSTRAINT learning_sessions_tokens_ck CHECK (tokens IS NULL OR tokens >= 0),
  CONSTRAINT learning_sessions_cost_ck CHECK ((cost_amount IS NULL) = (cost_currency IS NULL)
    AND (cost_amount IS NULL OR cost_amount >= 0)
    AND (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$')),
  CONSTRAINT learning_sessions_usage_needs_model_ck CHECK (model_version IS NOT NULL OR (tokens IS NULL AND cost_amount IS NULL)),
  CONSTRAINT learning_sessions_source_ck CHECK ((source_type IS NULL) = (source_id IS NULL)
    AND (source_type IS NULL OR source_type IN ('assessment_attempt','exam_attempt'))),
  CONSTRAINT learning_sessions_window_ck CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_sessions_source_uq ON learning_sessions(source_type, source_id) WHERE source_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_sessions_subject_idx ON learning_sessions(subject_user_id, started_at);
CREATE INDEX IF NOT EXISTS learning_sessions_institution_idx ON learning_sessions(institution_id, started_at);

CREATE TABLE IF NOT EXISTS learning_attempt_events (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES learning_sessions(id),
  item_source text NOT NULL,
  item_id uuid NOT NULL,
  item_version integer NOT NULL,
  skill_id uuid REFERENCES taxonomy_nodes(id),
  context text NOT NULL,
  answered boolean NOT NULL,
  correct boolean NOT NULL,
  score numeric(5,4) NOT NULL,
  response_time_ms integer,
  highest_hint_level smallint NOT NULL DEFAULT 0,
  assisted boolean NOT NULL DEFAULT false,
  content_version text NOT NULL,
  source_attempt_type text NOT NULL,
  source_attempt_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_attempt_item_source_ck CHECK (item_source IN ('CAREER_READINESS_QUESTION','INSTITUTION_EXAM_QUESTION')),
  CONSTRAINT learning_attempt_item_version_ck CHECK (item_version > 0),
  CONSTRAINT learning_attempt_context_ck CHECK (context IN ('PRACTICE','DIAGNOSTIC','ASSESSMENT','REVIEW')),
  CONSTRAINT learning_attempt_correct_needs_answer_ck CHECK (answered OR NOT correct),
  CONSTRAINT learning_attempt_score_ck CHECK (score >= 0 AND score <= 1),
  CONSTRAINT learning_attempt_response_time_ck CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  CONSTRAINT learning_attempt_hint_level_ck CHECK (highest_hint_level BETWEEN 0 AND 4),
  -- C5 at the data layer: a success after hint 3 or higher can never be stored as unaided.
  CONSTRAINT learning_attempt_assisted_ck CHECK (highest_hint_level < 3 OR assisted),
  CONSTRAINT learning_attempt_content_version_ck CHECK (length(content_version) BETWEEN 1 AND 64),
  CONSTRAINT learning_attempt_source_type_ck CHECK (source_attempt_type IN ('assessment_attempt','exam_attempt'))
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_attempt_response_uq
  ON learning_attempt_events(source_attempt_type, source_attempt_id, item_source, item_id);
CREATE INDEX IF NOT EXISTS learning_attempt_subject_idx ON learning_attempt_events(subject_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS learning_attempt_institution_idx ON learning_attempt_events(institution_id, occurred_at);
CREATE INDEX IF NOT EXISTS learning_attempt_skill_idx ON learning_attempt_events(skill_id, occurred_at);
CREATE INDEX IF NOT EXISTS learning_attempt_session_idx ON learning_attempt_events(session_id);

-- Append-only; DELETE only inside the privacy-deletion transaction for the same subject,
-- which sets the transaction-local one.privacy_erase_subject. A guard against application
-- mistakes, with the same standing as the 0004 immutability trigger.
CREATE OR REPLACE FUNCTION guard_learning_attempt_event_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning_attempt_events is append-only; rows are removed only by privacy deletion';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_attempt_events_append_only ON learning_attempt_events;
CREATE TRIGGER learning_attempt_events_append_only
  BEFORE UPDATE OR DELETE ON learning_attempt_events
  FOR EACH ROW EXECUTE FUNCTION guard_learning_attempt_event_change();

-- Sessions: the same rule, plus closing an open session once (ended_at from NULL, with
-- usage filled at the same moment); every other column is frozen from insert.
CREATE OR REPLACE FUNCTION guard_learning_session_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'learning_sessions is append-only; rows are removed only by privacy deletion';
  END IF;
  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
     AND OLD.tokens IS NULL AND OLD.cost_amount IS NULL
     AND NEW.id = OLD.id AND NEW.subject_user_id = OLD.subject_user_id
     AND NEW.institution_id IS NOT DISTINCT FROM OLD.institution_id
     AND NEW.mode = OLD.mode
     AND NEW.language IS NOT DISTINCT FROM OLD.language
     AND NEW.model_version IS NOT DISTINCT FROM OLD.model_version
     AND NEW.prompt_version IS NOT DISTINCT FROM OLD.prompt_version
     AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.started_at = OLD.started_at
     AND NEW.recorded_at = OLD.recorded_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'learning_sessions is append-only; only an open session may be closed, once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_sessions_append_only ON learning_sessions;
CREATE TRIGGER learning_sessions_append_only
  BEFORE UPDATE OR DELETE ON learning_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_learning_session_change();

-- Privacy deletion records a new category, LEARNING_ACTIVITY (ERASED). The 0009 CHECK is
-- widened to admit it; every existing value stays allowed, including SUPPORT_CASES from 0043.
-- The migrator replays every file in order, so this list must always be the full set: a value
-- left out here would be removed again on every run after 0043 added it.
ALTER TABLE privacy_deletion_records DROP CONSTRAINT IF EXISTS privacy_deletion_category_ck;
ALTER TABLE privacy_deletion_records ADD CONSTRAINT privacy_deletion_category_ck CHECK (category IN (
  'IDENTITY','STUDENT_PROFILE','INSTITUTION_ROSTER','DOCUMENTS','APPLICATIONS','OFFERS','ASSESSMENT_EVIDENCE','NOTIFICATIONS','AUDIT',
  'SUPPORT_CASES','LEARNING_ACTIVITY'
));
