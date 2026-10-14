-- 0116 — tutor rollout (ENG-25): the AI tutor switched on per college by dual control, a reproducible
-- tutor / no-tutor split of each college's consenting students, recorded once, and aggregate pilot counters.
-- Design: docs/architecture/tutor-rollout-design.md. Decision: ADR-051.
--
-- Why: the pilot asks whether students who used the tutor learned more than comparable students who did
-- not. That needs (1) a per-college switch that cannot bypass OPS-12's evaluation gate or OPS-02's dual
-- control, (2) a random split that anyone can re-derive and nobody can re-roll, recorded per student, and
-- (3) counts per group with no student in them. Readiness appears nowhere in these tables.
--
-- Redefines one earlier function, operation_approval_extended_target_type() (0051, last on this branch
-- 0089), repeating every earlier key — and INSTITUTION_PAYMENT_CLEARANCE, which 0111 on
-- feat/growth-college-payments adds and this file sorts after, so a merge of both keeps it.
-- Applied once by the ledger runner (ADR-035); written idempotently all the same.

-- ---------------------------------------------------------------------------
-- 1. Approval action: AI_TUTOR_COLLEGE_ENABLE (0051's extension mechanism)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_QUESTION_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_LESSON_PUBLISH' THEN 'content_revision'
    WHEN 'COMMS_TEMPLATE_PUBLISH' THEN 'status_notice_template'
    WHEN 'INSTITUTION_DATA_PURGE' THEN 'institution_offboarding'
    WHEN 'AI_FEATURE_ENABLE' THEN 'ai_feature_policy'
    WHEN 'AI_FEATURE_LIMITS_RAISE' THEN 'ai_feature_policy'
    WHEN 'INSTITUTION_PAYMENT_CLEARANCE' THEN 'institution_payment'
    WHEN 'AI_TUTOR_COLLEGE_ENABLE' THEN 'tutor_college'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH; 0065: CONTENT_LESSON_PUBLISH; 0081: COMMS_TEMPLATE_PUBLISH; 0088: INSTITUTION_DATA_PURGE; 0089: AI_FEATURE_ENABLE, AI_FEATURE_LIMITS_RAISE; 0111: INSTITUTION_PAYMENT_CLEARANCE; 0116: AI_TUTOR_COLLEGE_ENABLE. A later key repeats every earlier one.';

-- ---------------------------------------------------------------------------
-- 2. The assignment formula, once, in SQL (the TypeScript twin is packages/tutoring/src/rollout.ts)
-- ---------------------------------------------------------------------------
-- sha256-bucket-v1: the first four bytes of sha256(seed ":" experiment ":" student), big-endian, mod 10000.
CREATE OR REPLACE FUNCTION tutor_assignment_bucket(seed text, experiment_id uuid, subject_user_id uuid)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT (((get_byte(h, 0)::bigint << 24) | (get_byte(h, 1)::bigint << 16) | (get_byte(h, 2)::bigint << 8) | get_byte(h, 3)::bigint) % 10000)::integer
  FROM (SELECT sha256(convert_to(seed || ':' || lower(experiment_id::text) || ':' || lower(subject_user_id::text), 'UTF8')) AS h) s
$$;

-- ---------------------------------------------------------------------------
-- 3. tutor_college_rollouts: one row per college that has had the tutor switched on (the experiment)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tutor_college_rollouts (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  feature_key text NOT NULL REFERENCES ai_feature_policies(feature_key),
  enabled boolean NOT NULL,
  assignment_method text NOT NULL,
  assignment_seed text NOT NULL,
  tutor_share_basis_points integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  enabled_model text,
  enabled_prompt_key text,
  enabled_prompt_version integer,
  enabled_evaluation_id uuid REFERENCES ai_evaluations(id),
  enabled_approval_id uuid REFERENCES operation_approvals(id),
  enabled_at timestamptz,
  enabled_by_user_id uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by_user_id uuid NOT NULL REFERENCES users(id),
  change_reason_code text NOT NULL,
  correlation_id text NOT NULL,
  CONSTRAINT tutor_rollout_feature_ck CHECK (feature_key = 'tutor.hint'),
  CONSTRAINT tutor_rollout_method_ck CHECK (assignment_method = 'sha256-bucket-v1'),
  CONSTRAINT tutor_rollout_seed_ck CHECK (assignment_seed ~ '^[0-9a-f]{32}$'),
  -- v1 is an even split; any other split is a new method version and a new migration.
  CONSTRAINT tutor_rollout_share_ck CHECK (tutor_share_basis_points = 5000),
  CONSTRAINT tutor_rollout_reason_ck CHECK (change_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT tutor_rollout_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 200),
  -- The switch-on facts arrive together; a row is born by a switch-on, so they are never empty.
  CONSTRAINT tutor_rollout_enabled_facts_ck CHECK (
    enabled_model IS NOT NULL AND length(enabled_model) BETWEEN 1 AND 200
    AND enabled_prompt_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$' AND enabled_prompt_version >= 1
    AND enabled_evaluation_id IS NOT NULL AND enabled_approval_id IS NOT NULL
    AND enabled_at IS NOT NULL AND enabled_by_user_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION guard_tutor_college_rollout() RETURNS trigger AS $$
DECLARE
  policy record;
  switching_on boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tutor college rollouts are never deleted; switch the college off instead';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.institution_id <> OLD.institution_id OR NEW.feature_key <> OLD.feature_key
       OR NEW.assignment_method <> OLD.assignment_method OR NEW.assignment_seed <> OLD.assignment_seed
       OR NEW.tutor_share_basis_points <> OLD.tutor_share_basis_points
       OR NEW.created_at <> OLD.created_at OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
      RAISE EXCEPTION 'tutor_college_rollouts: the experiment (college, method, seed, split) never changes';
    END IF;
  END IF;
  switching_on := NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled);
  IF TG_OP = 'INSERT' AND NOT NEW.enabled THEN
    RAISE EXCEPTION 'a tutor college rollout is created by switching the college on';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT switching_on AND (
       NEW.enabled_model IS DISTINCT FROM OLD.enabled_model OR NEW.enabled_prompt_key IS DISTINCT FROM OLD.enabled_prompt_key
       OR NEW.enabled_prompt_version IS DISTINCT FROM OLD.enabled_prompt_version OR NEW.enabled_evaluation_id IS DISTINCT FROM OLD.enabled_evaluation_id
       OR NEW.enabled_approval_id IS DISTINCT FROM OLD.enabled_approval_id OR NEW.enabled_at IS DISTINCT FROM OLD.enabled_at
       OR NEW.enabled_by_user_id IS DISTINCT FROM OLD.enabled_by_user_id) THEN
    RAISE EXCEPTION 'tutor_college_rollouts: the switch-on facts are written only by a switch-on';
  END IF;
  IF switching_on THEN
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.institution_id AND kind::text = 'INSTITUTION') THEN
      RAISE EXCEPTION 'the tutor is switched on only for a college';
    END IF;
    IF ai_kill_switch_engaged() THEN
      RAISE EXCEPTION 'the AI kill switch is engaged';
    END IF;
    SELECT feature_key, model, prompt_key, prompt_version INTO policy FROM ai_feature_policies WHERE feature_key = NEW.feature_key;
    IF NOT FOUND OR policy.prompt_key IS NULL
       OR NOT ai_evaluation_passes(policy.feature_key, policy.model, policy.prompt_key, policy.prompt_version) THEN
      RAISE EXCEPTION 'a college is switched on only with a passing evaluation for the tutor''s model and prompt';
    END IF;
    IF NEW.enabled_model IS DISTINCT FROM policy.model OR NEW.enabled_prompt_key IS DISTINCT FROM policy.prompt_key
       OR NEW.enabled_prompt_version IS DISTINCT FROM policy.prompt_version
       OR NOT EXISTS (SELECT 1 FROM ai_evaluations e WHERE e.id = NEW.enabled_evaluation_id AND e.decision = 'PASS'
                        AND e.feature_key = policy.feature_key AND e.model = policy.model
                        AND e.prompt_key = policy.prompt_key AND e.prompt_version = policy.prompt_version) THEN
      RAISE EXCEPTION 'a college switch-on names the model, prompt and passing evaluation it was approved for';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM operation_approvals a WHERE a.id = NEW.enabled_approval_id
                     AND a.extended_action_key = 'AI_TUTOR_COLLEGE_ENABLE' AND a.state = 'EXECUTED'
                     AND a.target_id = lower(NEW.institution_id::text))
       OR (TG_OP = 'UPDATE' AND NEW.enabled_approval_id IS NOT DISTINCT FROM OLD.enabled_approval_id) THEN
      RAISE EXCEPTION 'a college is switched on only with its own executed AI_TUTOR_COLLEGE_ENABLE approval, used once';
    END IF;
    NEW.enabled_at := now();
  END IF;
  NEW.changed_at := now();
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tutor_college_rollout_guard ON tutor_college_rollouts;
CREATE TRIGGER tutor_college_rollout_guard BEFORE INSERT OR UPDATE OR DELETE ON tutor_college_rollouts
FOR EACH ROW EXECUTE FUNCTION guard_tutor_college_rollout();

-- ---------------------------------------------------------------------------
-- 4. tutor_group_assignments: one immutable row per experiment and consenting student
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tutor_group_assignments (
  id uuid PRIMARY KEY,
  rollout_id uuid NOT NULL REFERENCES tutor_college_rollouts(id),
  institution_id uuid NOT NULL REFERENCES organizations(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  assignment_method text NOT NULL,
  bucket integer NOT NULL,
  group_name text NOT NULL,
  consent_version text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  CONSTRAINT tutor_assignment_bucket_ck CHECK (bucket BETWEEN 0 AND 9999),
  CONSTRAINT tutor_assignment_group_ck CHECK (group_name IN ('TUTOR', 'NO_TUTOR')),
  CONSTRAINT tutor_assignment_consent_ck CHECK (length(consent_version) BETWEEN 1 AND 100),
  CONSTRAINT tutor_assignment_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 200),
  CONSTRAINT tutor_assignment_once_uq UNIQUE (rollout_id, subject_user_id)
);
CREATE INDEX IF NOT EXISTS tutor_assignment_subject_idx ON tutor_group_assignments(subject_user_id, institution_id);

CREATE OR REPLACE FUNCTION guard_tutor_group_assignment() RETURNS trigger AS $$
DECLARE
  rollout record;
  expected integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tutor group assignments are removed only by privacy deletion';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a tutor group assignment is never changed';
  END IF;
  SELECT id, institution_id, enabled, assignment_method, assignment_seed, tutor_share_basis_points INTO rollout
  FROM tutor_college_rollouts WHERE id = NEW.rollout_id;
  IF NOT FOUND OR NOT rollout.enabled OR rollout.institution_id <> NEW.institution_id
     OR rollout.assignment_method <> NEW.assignment_method THEN
    RAISE EXCEPTION 'a student is assigned only in a switched-on experiment of their own college, by its method';
  END IF;
  expected := tutor_assignment_bucket(rollout.assignment_seed, rollout.id, NEW.subject_user_id);
  IF NEW.bucket <> expected
     OR NEW.group_name <> (CASE WHEN expected < rollout.tutor_share_basis_points THEN 'TUTOR' ELSE 'NO_TUTOR' END) THEN
    RAISE EXCEPTION 'a tutor group is the one the experiment''s seed gives, never chosen';
  END IF;
  -- Only a current student of the college who holds ai-tutoring now (ENG-01's rule: the latest action is a
  -- GRANT of the live definition's version) is ever assigned.
  IF NOT EXISTS (
    SELECT 1 FROM institution_relationships r
    WHERE r.student_user_id = NEW.subject_user_id AND r.institution_id = NEW.institution_id
      AND r.state::text IN ('ACTIVE', 'VERIFIED') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now())
  ) THEN
    RAISE EXCEPTION 'a student is assigned only in their own current college';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM consent_definitions d
    JOIN LATERAL (
      SELECT c.version, c.action FROM user_consents c
      WHERE c.user_id = NEW.subject_user_id AND c.consent_key = d.consent_key
      ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
    ) latest ON latest.version = d.version AND latest.action = 'GRANTED'
    WHERE d.consent_key = 'ai-tutoring' AND d.retired_at IS NULL AND d.effective_from <= now() AND d.version = NEW.consent_version
  ) THEN
    RAISE EXCEPTION 'only a student who holds ai-tutoring is assigned to a tutor group';
  END IF;
  NEW.assigned_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tutor_group_assignment_guard ON tutor_group_assignments;
CREATE TRIGGER tutor_group_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON tutor_group_assignments
FOR EACH ROW EXECUTE FUNCTION guard_tutor_group_assignment();

-- ---------------------------------------------------------------------------
-- 5. tutor_pilot_daily_metrics: counters per experiment, group, day and metric — no student in them
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tutor_pilot_daily_metrics (
  rollout_id uuid NOT NULL REFERENCES tutor_college_rollouts(id),
  group_name text NOT NULL,
  metric_date date NOT NULL,
  metric_key text NOT NULL,
  count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rollout_id, group_name, metric_date, metric_key),
  CONSTRAINT tutor_metric_group_ck CHECK (group_name IN ('TUTOR', 'NO_TUTOR')),
  CONSTRAINT tutor_metric_key_ck CHECK (metric_key IN ('STEPS_STARTED', 'QUESTIONS_ANSWERED', 'QUESTIONS_CORRECT', 'ANSWERS_ASSISTED',
    'STEPS_COMPLETED', 'WRITTEN_HINTS_SHOWN', 'TUTOR_HINTS_REQUESTED', 'TUTOR_HINTS_SHOWN', 'TUTOR_HINTS_FALLBACK')),
  CONSTRAINT tutor_metric_count_ck CHECK (count >= 0)
);

CREATE OR REPLACE FUNCTION guard_tutor_pilot_metric() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tutor pilot metrics are never deleted';
  END IF;
  IF NEW.rollout_id <> OLD.rollout_id OR NEW.group_name <> OLD.group_name OR NEW.metric_date <> OLD.metric_date
     OR NEW.metric_key <> OLD.metric_key OR NEW.count < OLD.count THEN
    RAISE EXCEPTION 'a tutor pilot counter only grows';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tutor_pilot_metric_guard ON tutor_pilot_daily_metrics;
CREATE TRIGGER tutor_pilot_metric_guard BEFORE UPDATE OR DELETE ON tutor_pilot_daily_metrics
FOR EACH ROW EXECUTE FUNCTION guard_tutor_pilot_metric();

COMMENT ON TABLE tutor_college_rollouts IS
  'ENG-25: the AI tutor per college (the experiment). Switched on only by an executed AI_TUTOR_COLLEGE_ENABLE approval with a passing evaluation; seed, method and split never change.';
COMMENT ON TABLE tutor_group_assignments IS
  'ENG-25: a consenting student''s tutor / no-tutor group in their college''s experiment, recomputed from the recorded seed on insert. Immutable; removed only by privacy deletion.';
COMMENT ON TABLE tutor_pilot_daily_metrics IS
  'ENG-25: pilot counters per experiment, group, database day and metric. No student, no question, no readiness.';
