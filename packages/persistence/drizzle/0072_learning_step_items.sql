-- 0072 — learning_step_items (ENG-18): the practice questions served for a planner decision, with the
-- highest hint level the server released for each. Design: docs/architecture/learning-step-items-table-design.md.
--
-- Why: the attempt log (0047) marks an attempt assisted when hint level 3 or more was used, and an assisted
-- success never counts toward DEMONSTRATED (C5). The level must therefore be what the server showed, not what
-- a client reports. Also widens the session and attempt source vocabularies with 'learning_step' (a practice
-- or review step the student takes on a decision), keeping every earlier value.
--
-- Idempotent (ADR-035 applies it once; it also survives the bootstrap replay): IF NOT EXISTS, CHECKs dropped
-- IF EXISTS and re-added, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER.

-- 1. The new source of sessions and attempts.
ALTER TABLE learning_sessions DROP CONSTRAINT IF EXISTS learning_sessions_source_ck;
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_source_ck
  CHECK ((source_type IS NULL) = (source_id IS NULL)
    AND (source_type IS NULL OR source_type IN ('assessment_attempt','exam_attempt','placement_test','learning_step')));
ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_source_type_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_source_type_ck
  CHECK (source_attempt_type IN ('assessment_attempt','exam_attempt','placement_test','learning_step'));

-- 2. The served questions.
CREATE TABLE IF NOT EXISTS learning_step_items (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES learning_decisions(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES learning_sessions(id),
  position smallint NOT NULL,
  item_source text NOT NULL,
  item_id uuid NOT NULL REFERENCES question_versions(id),
  item_version integer NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  hint_level smallint NOT NULL DEFAULT 0,
  served_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_step_items_position_ck CHECK (position BETWEEN 1 AND 5),
  CONSTRAINT learning_step_items_source_ck CHECK (item_source IN ('CAREER_READINESS_QUESTION')),
  CONSTRAINT learning_step_items_version_ck CHECK (item_version > 0),
  CONSTRAINT learning_step_items_hint_ck CHECK (hint_level BETWEEN 0 AND 4)
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_step_items_position_uq ON learning_step_items(decision_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS learning_step_items_item_uq ON learning_step_items(decision_id, item_source, item_id);
CREATE INDEX IF NOT EXISTS learning_step_items_subject_idx ON learning_step_items(subject_user_id, served_at);

-- 3. A served item belongs to its decision's student and to that decision's step session.
CREATE OR REPLACE FUNCTION guard_learning_step_item_insert()
RETURNS trigger AS $$
DECLARE
  decision record;
  session record;
BEGIN
  SELECT subject_user_id, institution_id INTO decision FROM learning_decisions WHERE id = NEW.decision_id;
  IF decision.subject_user_id IS DISTINCT FROM NEW.subject_user_id
     OR decision.institution_id IS DISTINCT FROM NEW.institution_id THEN
    RAISE EXCEPTION 'a step item belongs to its decision''s student';
  END IF;
  SELECT subject_user_id, source_type, source_id INTO session FROM learning_sessions WHERE id = NEW.session_id;
  IF session.subject_user_id IS DISTINCT FROM NEW.subject_user_id
     OR session.source_type IS DISTINCT FROM 'learning_step'
     OR session.source_id IS DISTINCT FROM NEW.decision_id THEN
    RAISE EXCEPTION 'a step item belongs to its decision''s step session';
  END IF;
  IF NEW.hint_level <> 0 THEN
    RAISE EXCEPTION 'a step item is served with no hint shown';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_step_items_insert_guard ON learning_step_items;
CREATE TRIGGER learning_step_items_insert_guard
  BEFORE INSERT ON learning_step_items
  FOR EACH ROW EXECUTE FUNCTION guard_learning_step_item_insert();

-- 4. Only the hint level changes: up by one, while the item is unanswered in this step. Removed only by
--    privacy deletion for the same subject. A guard against application mistakes, with the standing of the
--    0047 and 0064 triggers.
CREATE OR REPLACE FUNCTION guard_learning_step_item_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'learning_step_items rows are removed only by privacy deletion';
  END IF;
  IF NEW.id = OLD.id AND NEW.decision_id = OLD.decision_id AND NEW.subject_user_id = OLD.subject_user_id
     AND NEW.institution_id IS NOT DISTINCT FROM OLD.institution_id AND NEW.session_id = OLD.session_id
     AND NEW.position = OLD.position AND NEW.item_source = OLD.item_source AND NEW.item_id = OLD.item_id
     AND NEW.item_version = OLD.item_version AND NEW.skill_id = OLD.skill_id AND NEW.served_at = OLD.served_at
     AND NEW.hint_level = OLD.hint_level + 1
     AND NOT EXISTS (
       SELECT 1 FROM learning_attempt_events e
       WHERE e.source_attempt_type = 'learning_step' AND e.source_attempt_id = OLD.decision_id
         AND e.item_source = OLD.item_source AND e.item_id = OLD.item_id
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'learning_step_items: only the hint level of an unanswered item may rise, one level at a time';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_step_items_change_guard ON learning_step_items;
CREATE TRIGGER learning_step_items_change_guard
  BEFORE UPDATE OR DELETE ON learning_step_items
  FOR EACH ROW EXECUTE FUNCTION guard_learning_step_item_change();
