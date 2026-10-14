-- ENG-14: the adaptive placement test — sittings and the questions served in them.
--
-- A sitting's answers are DIAGNOSTIC rows in learning_attempt_events (source placement_test);
-- these tables hold what the attempt log cannot: which question was put to the student, with
-- which calibration, and where the sitting placed them. The ability estimate is model state and
-- is not stored. Engine behavioural data: append-only for everyone, erasable only by the
-- privacy-deletion transaction for the same subject (ADR-034).
-- Design: docs/architecture/placement-tests-table-design.md. Applies once under the ADR-035
-- ledger, but written idempotently (the integration suites replay every file); references only
-- tables created before 0064.

-- 1. The attempt log learns about placement sittings. The 0047 constraints are declared inside
--    CREATE TABLE IF NOT EXISTS, so a replay of 0047 never narrows them again; every existing value
--    stays allowed.
ALTER TABLE learning_sessions DROP CONSTRAINT IF EXISTS learning_sessions_mode_ck;
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_mode_ck
  CHECK (mode IN ('LEARN','PRACTICE','REVIEW','ASSESSMENT','EXPLORE','DIAGNOSTIC'));
ALTER TABLE learning_sessions DROP CONSTRAINT IF EXISTS learning_sessions_source_ck;
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_source_ck
  CHECK ((source_type IS NULL) = (source_id IS NULL)
    AND (source_type IS NULL OR source_type IN ('assessment_attempt','exam_attempt','placement_test')));
ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_source_type_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_source_type_ck
  CHECK (source_attempt_type IN ('assessment_attempt','exam_attempt','placement_test'));

-- 2. Sittings.
CREATE TABLE IF NOT EXISTS placement_tests (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES learning_sessions(id),
  scope text NOT NULL,
  algorithm_id text NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  completed_at timestamptz,
  stop_reason text,
  placement_level text,
  items_answered smallint,
  CONSTRAINT placement_tests_scope_ck CHECK (scope IN ('APTITUDE_V1')),
  CONSTRAINT placement_tests_algorithm_ck CHECK (algorithm_id IN ('placement-2pl-eap-v1')),
  CONSTRAINT placement_tests_state_ck CHECK (state IN ('IN_PROGRESS','COMPLETED')),
  CONSTRAINT placement_tests_deadline_ck CHECK (deadline_at > started_at AND deadline_at <= started_at + interval '25 minutes'),
  CONSTRAINT placement_tests_completed_window_ck CHECK (completed_at IS NULL OR (completed_at >= started_at AND completed_at <= deadline_at)),
  CONSTRAINT placement_tests_stop_reason_ck CHECK (stop_reason IS NULL OR stop_reason IN ('CONFIDENT','MAX_ITEMS','TIME_LIMIT','POOL_EXHAUSTED')),
  CONSTRAINT placement_tests_level_ck CHECK (placement_level IS NULL
    OR placement_level IN ('AWARE','GUIDED','INDEPENDENT','TROUBLESHOOT','NOT_ENOUGH_EVIDENCE')),
  CONSTRAINT placement_tests_items_ck CHECK (items_answered IS NULL OR items_answered BETWEEN 0 AND 25),
  CONSTRAINT placement_tests_completion_ck CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)
    AND (state = 'COMPLETED') = (stop_reason IS NOT NULL)
    AND (state = 'COMPLETED') = (placement_level IS NOT NULL)
    AND (state = 'COMPLETED') = (items_answered IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS placement_tests_session_uq ON placement_tests(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS placement_tests_one_open_uq ON placement_tests(subject_user_id) WHERE state = 'IN_PROGRESS';
CREATE INDEX IF NOT EXISTS placement_tests_subject_idx ON placement_tests(subject_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS placement_tests_institution_idx ON placement_tests(institution_id, started_at);

-- 3. The questions served, with a snapshot of the calibration each was served under.
CREATE TABLE IF NOT EXISTS placement_test_items (
  id uuid PRIMARY KEY,
  placement_test_id uuid NOT NULL REFERENCES placement_tests(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  position smallint NOT NULL,
  item_source text NOT NULL,
  item_id uuid NOT NULL REFERENCES question_versions(id),
  item_version integer NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  item_group text NOT NULL,
  difficulty numeric(6,4) NOT NULL,
  discrimination numeric(6,4) NOT NULL,
  calibration_status text NOT NULL,
  calibration_run_id uuid NOT NULL REFERENCES item_calibration_runs(id),
  served_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_test_items_position_ck CHECK (position BETWEEN 1 AND 25),
  CONSTRAINT placement_test_items_source_ck CHECK (item_source IN ('CAREER_READINESS_QUESTION')),
  CONSTRAINT placement_test_items_version_ck CHECK (item_version > 0),
  CONSTRAINT placement_test_items_group_ck CHECK (item_group IN ('QUANTITATIVE','LOGICAL','VERBAL')),
  CONSTRAINT placement_test_items_difficulty_ck CHECK (difficulty BETWEEN -4 AND 4),
  CONSTRAINT placement_test_items_discrimination_ck CHECK (discrimination BETWEEN 0.2 AND 4),
  CONSTRAINT placement_test_items_calibration_ck CHECK (calibration_status IN ('PROVISIONAL','CALIBRATED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS placement_test_items_position_uq ON placement_test_items(placement_test_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS placement_test_items_item_uq ON placement_test_items(placement_test_id, item_source, item_id);
CREATE INDEX IF NOT EXISTS placement_test_items_subject_idx ON placement_test_items(subject_user_id, served_at);

-- 4. Sittings: completed once, from IN_PROGRESS, with every other column unchanged; removed only
--    by privacy deletion for the same subject. A guard against application mistakes, with the
--    standing of the 0047 triggers.
CREATE OR REPLACE FUNCTION guard_placement_test_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement_tests is append-only; rows are removed only by privacy deletion';
  END IF;
  IF OLD.state = 'IN_PROGRESS' AND NEW.state = 'COMPLETED'
     AND NEW.id = OLD.id AND NEW.subject_user_id = OLD.subject_user_id
     AND NEW.institution_id IS NOT DISTINCT FROM OLD.institution_id
     AND NEW.session_id = OLD.session_id AND NEW.scope = OLD.scope AND NEW.algorithm_id = OLD.algorithm_id
     AND NEW.started_at = OLD.started_at AND NEW.deadline_at = OLD.deadline_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'placement_tests is append-only; an in-progress sitting may only be completed, once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS placement_tests_append_only ON placement_tests;
CREATE TRIGGER placement_tests_append_only
  BEFORE UPDATE OR DELETE ON placement_tests
  FOR EACH ROW EXECUTE FUNCTION guard_placement_test_change();

CREATE OR REPLACE FUNCTION guard_placement_test_item_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'placement_test_items is append-only; rows are removed only by privacy deletion';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS placement_test_items_append_only ON placement_test_items;
CREATE TRIGGER placement_test_items_append_only
  BEFORE UPDATE OR DELETE ON placement_test_items
  FOR EACH ROW EXECUTE FUNCTION guard_placement_test_item_change();

-- 5. A served item belongs to its sitting's student, and only an open sitting takes new items.
CREATE OR REPLACE FUNCTION guard_placement_test_item_insert()
RETURNS trigger AS $$
DECLARE
  sitting record;
BEGIN
  SELECT subject_user_id, institution_id, state INTO sitting FROM placement_tests WHERE id = NEW.placement_test_id;
  IF sitting.subject_user_id IS DISTINCT FROM NEW.subject_user_id
     OR sitting.institution_id IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'placement_test_items: an item carries its sitting''s student and institution';
  END IF;
  IF sitting.state IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'placement_test_items: only an in-progress sitting takes new items';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS placement_test_items_insert_guard ON placement_test_items;
CREATE TRIGGER placement_test_items_insert_guard
  BEFORE INSERT ON placement_test_items
  FOR EACH ROW EXECUTE FUNCTION guard_placement_test_item_insert();
