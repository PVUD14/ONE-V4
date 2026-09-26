-- ENG-08: the learning decisions audit — every next step the planner (learning-orchestrator-v1)
-- gave a student, stored with the exact inputs it was computed from, their hash, the policy
-- version and the output, so it can be replayed and compared (C4). A faculty override (INST-16)
-- is recorded in the same row. Append-only: the only change allowed is linking more outcome
-- attempts; rows are removed only by privacy deletion.
-- Design: docs/architecture/learning-decisions-table-design.md. Applies once under the ADR-035
-- ledger, but written idempotently (CI bootstrap and the integration-test replay pattern run it
-- again); references only tables created before 0053.

CREATE TABLE IF NOT EXISTS learning_decisions (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  policy_version text NOT NULL,
  adaptive boolean NOT NULL,
  inputs jsonb NOT NULL,
  inputs_hash text NOT NULL,
  action text NOT NULL,
  skill_id uuid REFERENCES taxonomy_nodes(id),
  focus_misconception_code text,
  strategy_code text,
  strategy_version integer,
  reason_codes text[] NOT NULL,
  outcome_attempt_ids uuid[] NOT NULL DEFAULT '{}',
  override_by_user_id uuid REFERENCES users(id),
  override_reason_code text,
  correlation_id text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_decisions_strategy_fk FOREIGN KEY (strategy_code, strategy_version)
    REFERENCES teaching_strategies(code, version)
);

ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_policy_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_policy_ck
  CHECK (length(policy_version) BETWEEN 1 AND 64);
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_inputs_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_inputs_ck
  CHECK (jsonb_typeof(inputs) = 'object' AND inputs_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_action_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_action_ck
  CHECK (action IN ('REVIEW','REMEDIATE','PRACTICE','LEARN','FOLLOW_ASSIGNMENT','NONE'));
-- A step acts on a skill exactly when it is not NONE.
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_skill_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_skill_ck
  CHECK ((skill_id IS NULL) = (action = 'NONE'));
-- A remediation names the misconception it targets; nothing else does.
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_focus_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_focus_ck
  CHECK ((focus_misconception_code IS NOT NULL) = (action = 'REMEDIATE')
         AND (focus_misconception_code IS NULL OR focus_misconception_code ~ '^[A-Z][A-Z0-9_]{2,63}$'));
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_strategy_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_strategy_ck
  CHECK ((strategy_code IS NULL) = (strategy_version IS NULL));
-- C4: every step carries at least one reason, from the code vocabulary.
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_reasons_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_reasons_ck
  CHECK (cardinality(reason_codes) BETWEEN 1 AND 16
         AND array_position(reason_codes, NULL) IS NULL
         AND array_to_string(reason_codes, ',') ~ '^[A-Z][A-Z0-9_]{2,63}(,[A-Z][A-Z0-9_]{2,63})*$');
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_outcomes_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_outcomes_ck
  CHECK (array_position(outcome_attempt_ids, NULL) IS NULL AND cardinality(outcome_attempt_ids) <= 256);
-- An override names who and why, and says so among the reasons.
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_override_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_override_ck
  CHECK ((override_by_user_id IS NULL) = (override_reason_code IS NULL)
         AND (override_reason_code IS NULL
              OR (override_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$' AND 'FACULTY_OVERRIDE' = ANY(reason_codes))));
ALTER TABLE learning_decisions DROP CONSTRAINT IF EXISTS learning_decisions_correlation_ck;
ALTER TABLE learning_decisions ADD CONSTRAINT learning_decisions_correlation_ck
  CHECK (length(correlation_id) BETWEEN 1 AND 128);

CREATE INDEX IF NOT EXISTS learning_decisions_subject_idx ON learning_decisions(subject_user_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS learning_decisions_institution_idx ON learning_decisions(institution_id, decided_at);

-- Append-only. UPDATE may only grow outcome_attempt_ids, leaving every other column as it was;
-- DELETE only in the privacy-deletion transaction for the named subject (one.privacy_erase_subject,
-- as 0047 and 0052). A guard against application mistakes, with the standing of those triggers.
CREATE OR REPLACE FUNCTION guard_learning_decision_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'learning_decisions is append-only; rows are removed only by privacy deletion';
  END IF;
  IF NEW.outcome_attempt_ids @> OLD.outcome_attempt_ids
     AND (to_jsonb(NEW) - 'outcome_attempt_ids') = (to_jsonb(OLD) - 'outcome_attempt_ids') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'learning_decisions is append-only; only more outcome attempts may be linked';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_decisions_append_only ON learning_decisions;
CREATE TRIGGER learning_decisions_append_only
  BEFORE UPDATE OR DELETE ON learning_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_learning_decision_change();
