-- ENG-19: student goal types (ROLE / TOPIC / EXAM / COMPANY / DISCOVERY) and the catalogue's goal rows.
--
-- Role goals keep using student_career_targets (0011): a ROLE goal points at its target row, and triggers
-- on student_career_targets insert and end it, so the gap engine, the planner and role demand keep one
-- source of truth. One primary role goal; any number of topic, exam and company goals; at most one live
-- "Not sure yet". Goals end once (ACHIEVED or WITHDRAWN) and are never rewritten or deleted, except by the
-- privacy-deletion transaction for the same subject.
-- Design: docs/architecture/learner-goals-table-design.md. Applies once under the ADR-035 ledger, but
-- written idempotently (the integration suites replay every file); references only tables created before it.

-- 1. The Appendix 4 §G goals, as the catalogue seed stores them.
CREATE TABLE IF NOT EXISTS career_catalogue_goals (
  code text PRIMARY KEY,
  title text NOT NULL,
  source_goal_type text NOT NULL,
  links_to_roles text NOT NULL,
  main_evidence text NOT NULL,
  release text NOT NULL,
  learner_goal_type text,
  selectable boolean NOT NULL DEFAULT false,
  catalogue_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE career_catalogue_goals DROP CONSTRAINT IF EXISTS career_catalogue_goals_code_ck;
ALTER TABLE career_catalogue_goals ADD CONSTRAINT career_catalogue_goals_code_ck CHECK (code ~ '^G[0-9]{2}$');
ALTER TABLE career_catalogue_goals DROP CONSTRAINT IF EXISTS career_catalogue_goals_text_ck;
ALTER TABLE career_catalogue_goals ADD CONSTRAINT career_catalogue_goals_text_ck CHECK (
  length(title) BETWEEN 1 AND 200 AND title !~ '^[=+@-]'
  AND length(source_goal_type) BETWEEN 1 AND 80 AND length(links_to_roles) BETWEEN 1 AND 300
  AND length(main_evidence) BETWEEN 1 AND 300 AND length(release) BETWEEN 1 AND 80);
ALTER TABLE career_catalogue_goals DROP CONSTRAINT IF EXISTS career_catalogue_goals_type_ck;
ALTER TABLE career_catalogue_goals ADD CONSTRAINT career_catalogue_goals_type_ck
  CHECK (learner_goal_type IS NULL OR learner_goal_type IN ('EXAM','COMPANY','TOPIC','DISCOVERY'));
-- Only an exam or company goal is held by reference to its catalogue row ("Not sure yet" is the survey).
ALTER TABLE career_catalogue_goals DROP CONSTRAINT IF EXISTS career_catalogue_goals_selectable_ck;
ALTER TABLE career_catalogue_goals ADD CONSTRAINT career_catalogue_goals_selectable_ck
  CHECK (NOT selectable OR learner_goal_type IN ('EXAM','COMPANY'));
ALTER TABLE career_catalogue_goals DROP CONSTRAINT IF EXISTS career_catalogue_goals_version_ck;
ALTER TABLE career_catalogue_goals ADD CONSTRAINT career_catalogue_goals_version_ck CHECK (catalogue_version ~ '^[a-z0-9-]{3,40}$');

-- 2. Goals.
CREATE TABLE IF NOT EXISTS learner_goals (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  goal_type text NOT NULL,
  career_target_id uuid REFERENCES student_career_targets(id),
  topic_id uuid REFERENCES taxonomy_nodes(id),
  catalogue_goal_code text REFERENCES career_catalogue_goals(code),
  priority text NOT NULL DEFAULT 'SECONDARY',
  status text NOT NULL DEFAULT 'ACTIVE',
  origin text NOT NULL,
  discovery_interests text[],
  discovery_strengths text[],
  discovery_branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_type_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_type_ck
  CHECK (goal_type IN ('ROLE','TOPIC','EXAM','COMPANY','DISCOVERY'));
-- Exactly the reference the type needs, and no other.
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_reference_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_reference_ck CHECK (
  (career_target_id IS NOT NULL) = (goal_type = 'ROLE')
  AND (topic_id IS NOT NULL) = (goal_type = 'TOPIC')
  AND (catalogue_goal_code IS NOT NULL) = (goal_type IN ('EXAM','COMPANY')));
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_priority_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_priority_ck
  CHECK (priority IN ('PRIMARY','SECONDARY') AND (priority = 'SECONDARY' OR goal_type = 'ROLE'));
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_status_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_status_ck CHECK (status IN ('ACTIVE','ACHIEVED','WITHDRAWN'));
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_origin_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_origin_ck
  CHECK (origin IN ('ONBOARDING','GOALS','DISCOVERY_SUGGESTION','CAREER_TARGET'));
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_ended_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_ended_ck
  CHECK ((ended_at IS NULL) = (status = 'ACTIVE') AND (ended_at IS NULL OR ended_at >= created_at));
-- Survey answers belong to a "Not sure yet" goal only, in the career-discovery-v1 vocabulary.
ALTER TABLE learner_goals DROP CONSTRAINT IF EXISTS learner_goals_discovery_ck;
ALTER TABLE learner_goals ADD CONSTRAINT learner_goals_discovery_ck CHECK (
  CASE WHEN goal_type = 'DISCOVERY' THEN
    discovery_interests IS NOT NULL AND cardinality(discovery_interests) BETWEEN 1 AND 3
    AND discovery_interests <@ ARRAY['BUILDING_SOFTWARE','WORKING_WITH_DATA','SECURING_SYSTEMS','ELECTRONICS_AND_POWER',
      'MACHINES_AND_PLANTS','BUILDINGS_AND_INFRASTRUCTURE','BUSINESS_AND_PEOPLE']::text[]
    AND discovery_strengths IS NOT NULL AND cardinality(discovery_strengths) <= 3
    AND discovery_strengths <@ ARRAY['NUMBERS','PROGRAMMING','COMMUNICATION','PROBLEM_SOLVING','HANDS_ON']::text[]
    AND discovery_branch IS NOT NULL AND length(discovery_branch) BETWEEN 1 AND 60 AND discovery_branch !~ '^[=+@-]'
  ELSE discovery_interests IS NULL AND discovery_strengths IS NULL AND discovery_branch IS NULL END);

CREATE UNIQUE INDEX IF NOT EXISTS learner_goals_one_primary_uq ON learner_goals(student_user_id)
  WHERE priority = 'PRIMARY' AND status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS learner_goals_target_uq ON learner_goals(career_target_id) WHERE career_target_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS learner_goals_topic_uq ON learner_goals(student_user_id, topic_id)
  WHERE topic_id IS NOT NULL AND status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS learner_goals_catalogue_uq ON learner_goals(student_user_id, catalogue_goal_code)
  WHERE catalogue_goal_code IS NOT NULL AND status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS learner_goals_discovery_uq ON learner_goals(student_user_id)
  WHERE goal_type = 'DISCOVERY' AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS learner_goals_student_idx ON learner_goals(student_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS learner_goals_institution_idx ON learner_goals(institution_id, created_at);

-- 3. Role goals mirror student_career_targets. The origin of a target set through the goals routes is
--    passed in the transaction-local one.goal_origin; the existing career-target routes leave it unset.
CREATE OR REPLACE FUNCTION sync_learner_role_goal()
RETURNS trigger AS $$
DECLARE
  chosen_origin text := coalesce(nullif(current_setting('one.goal_origin', true), ''), 'CAREER_TARGET');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cleared_at IS NULL THEN
      IF NEW.priority = 'PRIMARY' THEN
        -- A primary role answers "Not sure yet".
        UPDATE learner_goals SET status = 'ACHIEVED', ended_at = greatest(now(), created_at)
        WHERE student_user_id = NEW.student_user_id AND goal_type = 'DISCOVERY' AND status = 'ACTIVE';
      END IF;
      INSERT INTO learner_goals (id, student_user_id, institution_id, goal_type, career_target_id, priority, origin, created_at)
      VALUES (gen_random_uuid(), NEW.student_user_id,
        (SELECT p.institution_id FROM institution_student_profiles p
         WHERE p.student_user_id = NEW.student_user_id AND p.status = 'ACTIVE' ORDER BY p.updated_at DESC LIMIT 1),
        'ROLE', NEW.id, NEW.priority, chosen_origin, NEW.selected_at);
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.cleared_at IS NULL AND NEW.cleared_at IS NOT NULL THEN
    UPDATE learner_goals SET status = 'WITHDRAWN', ended_at = greatest(NEW.cleared_at, created_at)
    WHERE career_target_id = NEW.id AND status = 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS student_career_targets_goal_sync ON student_career_targets;
CREATE TRIGGER student_career_targets_goal_sync
  AFTER INSERT OR UPDATE OF cleared_at ON student_career_targets
  FOR EACH ROW EXECUTE FUNCTION sync_learner_role_goal();

-- 4. Live targets set before 0068 get their role goal, from their own rows. Runs before the guard below is
--    recreated, so a replay (guard present from the earlier run) drops it first.
DROP TRIGGER IF EXISTS learner_goals_guard_insert ON learner_goals;
INSERT INTO learner_goals (id, student_user_id, institution_id, goal_type, career_target_id, priority, origin, created_at)
SELECT gen_random_uuid(), t.student_user_id,
  (SELECT p.institution_id FROM institution_student_profiles p
   WHERE p.student_user_id = t.student_user_id AND p.status = 'ACTIVE' ORDER BY p.updated_at DESC LIMIT 1),
  'ROLE', t.id, t.priority, 'CAREER_TARGET', t.selected_at
FROM student_career_targets t
WHERE t.cleared_at IS NULL AND NOT EXISTS (SELECT 1 FROM learner_goals g WHERE g.career_target_id = t.id);

-- 5. A ROLE goal is written only by the sync trigger.
CREATE OR REPLACE FUNCTION guard_learner_goal_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.goal_type = 'ROLE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'role goals are set through student_career_targets';
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a goal starts ACTIVE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER learner_goals_guard_insert
  BEFORE INSERT ON learner_goals
  FOR EACH ROW EXECUTE FUNCTION guard_learner_goal_insert();

-- 6. A goal ends once and is otherwise never changed; a ROLE goal ends only through its target. DELETE only
--    in the privacy-deletion transaction for the named subject (as 0047, 0052, 0053).
CREATE OR REPLACE FUNCTION guard_learner_goal_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'learner_goals rows are removed only by privacy deletion';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status IN ('ACHIEVED','WITHDRAWN')
     AND (to_jsonb(NEW) - 'status' - 'ended_at') = (to_jsonb(OLD) - 'status' - 'ended_at')
     AND (OLD.goal_type <> 'ROLE' OR pg_trigger_depth() > 1) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a goal only ends, once; a role goal ends when its career target is cleared';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learner_goals_guard_change ON learner_goals;
CREATE TRIGGER learner_goals_guard_change
  BEFORE UPDATE OR DELETE ON learner_goals
  FOR EACH ROW EXECUTE FUNCTION guard_learner_goal_change();
