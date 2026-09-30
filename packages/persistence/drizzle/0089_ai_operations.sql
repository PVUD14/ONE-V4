-- AI Operations console (OPS-12): evaluation records, the global kill switch, the assistant switch.
--
-- Design: docs/architecture/ai-evaluations-table-design.md
--
-- Within the AI hold (ADR-030): this configures ai-orchestration tables (0033) and feature flags
-- (0029, 0038). Nothing here calls a model or knows a provider's price.
--
-- Migrations apply once (ADR-035) but are still written idempotently: bootstrap replays every
-- file once, and integration specs replay every file into throwaway schemas. References only
-- tables up to 0085, plus operation_approval_extended_target_type() (0051, last redefined 0081).

-- ---------------------------------------------------------------------------
-- 1. The prompt a feature currently runs
-- ---------------------------------------------------------------------------
-- "A passing evaluation for the current model and prompt version" needs the policy to name its
-- prompt. Set by registration code; prompts live in code (0033), so changing one is a release.
ALTER TABLE ai_feature_policies ADD COLUMN IF NOT EXISTS prompt_key text;
ALTER TABLE ai_feature_policies ADD COLUMN IF NOT EXISTS prompt_version integer;
ALTER TABLE ai_feature_policies DROP CONSTRAINT IF EXISTS ai_feature_prompt_ck;
ALTER TABLE ai_feature_policies ADD CONSTRAINT ai_feature_prompt_ck CHECK (
  (prompt_key IS NULL AND prompt_version IS NULL)
  OR (prompt_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$' AND prompt_version >= 1));

-- ---------------------------------------------------------------------------
-- 2. ai_evaluations: recorded benchmark decisions (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_evaluations (
  id uuid PRIMARY KEY,
  feature_key text NOT NULL REFERENCES ai_feature_policies(feature_key),
  provider_key text NOT NULL,
  model text NOT NULL,
  prompt_key text NOT NULL,
  prompt_version integer NOT NULL,
  evaluation_set_key text NOT NULL,
  evaluation_set_version integer NOT NULL,
  metrics jsonb NOT NULL,
  decision text NOT NULL,
  reason_code text NOT NULL,
  note text,
  decided_by_user_id uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL
);

ALTER TABLE ai_evaluations DROP CONSTRAINT IF EXISTS ai_evaluation_shape_ck;
ALTER TABLE ai_evaluations ADD CONSTRAINT ai_evaluation_shape_ck CHECK (
  provider_key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  AND length(model) BETWEEN 1 AND 200
  AND prompt_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$' AND prompt_version >= 1
  AND evaluation_set_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$' AND evaluation_set_version >= 1
  AND CASE WHEN jsonb_typeof(metrics) = 'array' THEN jsonb_array_length(metrics) BETWEEN 1 AND 20 ELSE false END
  AND decision IN ('PASS', 'FAIL')
  AND reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (note IS NULL OR length(note) BETWEEN 1 AND 500)
  AND correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$');

CREATE INDEX IF NOT EXISTS ai_evaluation_match_idx
  ON ai_evaluations (feature_key, model, prompt_key, prompt_version, decided_at DESC);
CREATE INDEX IF NOT EXISTS ai_evaluation_list_idx ON ai_evaluations (decided_at DESC, id DESC);

-- Each metric is {name, value, threshold, comparator}; a PASS must meet every threshold it records.
CREATE OR REPLACE FUNCTION ai_evaluation_guard() RETURNS trigger AS $$
DECLARE
  metric jsonb;
  met boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AI evaluation records are never deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'AI evaluation records are immutable; record a later one instead'; END IF;
  NEW.decided_at := now();
  IF jsonb_typeof(NEW.metrics) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'AI evaluation metrics are a list';
  END IF;
  FOR metric IN SELECT value FROM jsonb_array_elements(NEW.metrics) LOOP
    IF jsonb_typeof(metric) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(metric)) <> 4
       OR jsonb_typeof(metric->'name') <> 'string' OR (metric->>'name') !~ '^[a-z][a-z0-9_]{1,63}$'
       OR jsonb_typeof(metric->'value') IS DISTINCT FROM 'number'
       OR jsonb_typeof(metric->'threshold') IS DISTINCT FROM 'number'
       OR (metric->>'comparator') IS NULL OR (metric->>'comparator') NOT IN ('AT_LEAST', 'AT_MOST') THEN
      RAISE EXCEPTION 'an AI evaluation metric is {name, value, threshold, comparator}';
    END IF;
    met := CASE metric->>'comparator'
      WHEN 'AT_LEAST' THEN (metric->>'value')::numeric >= (metric->>'threshold')::numeric
      ELSE (metric->>'value')::numeric <= (metric->>'threshold')::numeric END;
    IF NEW.decision = 'PASS' AND NOT met THEN
      RAISE EXCEPTION 'a PASS must meet every threshold it records';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_evaluation_guard ON ai_evaluations;
CREATE TRIGGER ai_evaluation_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_evaluations
FOR EACH ROW EXECUTE FUNCTION ai_evaluation_guard();

-- The one definition of "passing for this model and prompt": the latest record for exactly this
-- combination is a PASS. A tie on decided_at resolves to FAIL. plpgsql, so it is not validated
-- against tables at creation time.
CREATE OR REPLACE FUNCTION ai_evaluation_passes(feature text, eval_model text, eval_prompt_key text, eval_prompt_version integer)
RETURNS boolean AS $$
BEGIN
  RETURN COALESCE((
    SELECT e.decision = 'PASS' FROM ai_evaluations e
    WHERE e.feature_key = feature AND e.model = eval_model
      AND e.prompt_key = eval_prompt_key AND e.prompt_version = eval_prompt_version
    ORDER BY e.decided_at DESC, (e.decision = 'FAIL') DESC, e.id DESC
    LIMIT 1), false);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 3. The two AI flags
-- ---------------------------------------------------------------------------
-- The kill switch: ON means AI is stopped. Engaging it is ordinary; releasing it needs a second
-- person (high_risk_direction DISABLE, 0038). Default not engaged: every feature and the assistant
-- are already off by default. The assistant switch: default OFF; switching it on needs a second
-- person (ENABLE) and still needs ASSISTANT_ENABLED=true on the server. Inserted only if absent,
-- so a replay never changes a live switch; the high-risk marking is re-asserted.
INSERT INTO feature_flags (key, description, enabled, high_risk_direction)
VALUES ('ai.global-kill-switch',
        'Global AI kill switch. On means every AI feature and the in-app assistant are stopped. Releasing it needs a second person.',
        false, 'DISABLE')
ON CONFLICT (key) DO NOTHING;
INSERT INTO feature_flags (key, description, enabled, high_risk_direction)
VALUES ('ai.assistant',
        'In-app ONE Assistant. It answers only when this is on, ASSISTANT_ENABLED=true on the server, a provider key is set and the kill switch is not engaged.',
        false, 'ENABLE')
ON CONFLICT (key) DO NOTHING;
UPDATE feature_flags SET high_risk_direction = 'DISABLE'
WHERE key = 'ai.global-kill-switch' AND high_risk_direction IS DISTINCT FROM 'DISABLE';
UPDATE feature_flags SET high_risk_direction = 'ENABLE'
WHERE key = 'ai.assistant' AND high_risk_direction IS DISTINCT FROM 'ENABLE';

CREATE OR REPLACE FUNCTION ai_kill_switch_engaged() RETURNS boolean AS $$
BEGIN
  RETURN COALESCE((SELECT enabled FROM feature_flags WHERE key = 'ai.global-kill-switch'), false);
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- 4. Enabling rules for any writer of ai_feature_policies
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ai_feature_policy_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.enabled AND ai_kill_switch_engaged() THEN
      RAISE EXCEPTION 'the AI kill switch is engaged';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.enabled AND NOT OLD.enabled THEN
    IF ai_kill_switch_engaged() THEN
      RAISE EXCEPTION 'the AI kill switch is engaged';
    END IF;
    IF NEW.prompt_key IS NULL
       OR NOT ai_evaluation_passes(NEW.feature_key, NEW.model, NEW.prompt_key, NEW.prompt_version) THEN
      RAISE EXCEPTION 'an AI feature is switched on only with a passing evaluation for its model and prompt';
    END IF;
  ELSIF NEW.enabled AND OLD.enabled
        AND (NEW.model IS DISTINCT FROM OLD.model OR NEW.prompt_key IS DISTINCT FROM OLD.prompt_key
             OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version)
        AND (NEW.prompt_key IS NULL
             OR NOT ai_evaluation_passes(NEW.feature_key, NEW.model, NEW.prompt_key, NEW.prompt_version)) THEN
    -- Fail closed: a model or prompt change nobody evaluated switches the feature off.
    NEW.enabled := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_feature_policy_guard ON ai_feature_policies;
CREATE TRIGGER ai_feature_policy_guard BEFORE INSERT OR UPDATE ON ai_feature_policies
FOR EACH ROW EXECUTE FUNCTION ai_feature_policy_guard();

-- ---------------------------------------------------------------------------
-- 5. Approval actions (0051's extension mechanism). Repeats every earlier extended key — 0051,
--    0057, 0061, 0065, 0081 — and INSTITUTION_DATA_PURGE from 0088 (feat/inst-contract-lifecycle),
--    which this file sorts after and must not drop.
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
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH; 0065: CONTENT_LESSON_PUBLISH; 0081: COMMS_TEMPLATE_PUBLISH; 0088: INSTITUTION_DATA_PURGE; 0089: AI_FEATURE_ENABLE, AI_FEATURE_LIMITS_RAISE. A later key repeats every earlier one.';

COMMENT ON TABLE ai_evaluations IS
  'Recorded benchmark decisions per feature, model and prompt version (OPS-12). Append-only; never run here.';
COMMENT ON COLUMN ai_feature_policies.prompt_key IS
  'The prompt this feature currently runs (with prompt_version). Set by registration code; evaluated with the model.';
