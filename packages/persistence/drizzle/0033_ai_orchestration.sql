-- AI Orchestration: what was generated, by what, at what cost.
--
-- Spec 7.17 gives AI Orchestration ownership of usage metering, cost data and execution
-- audit metadata. This is that table, plus the per-feature policy the orchestrator reads.
--
-- Two things it is deliberately not:
--
--   It is not a prompt store. Prompts live in code, versioned and immutable, because a
--   prompt edited in a database row silently invalidates the provenance of every
--   generation that cites its version. What is recorded here is which version ran.
--
--   It is not a transcript. Generated text belongs in the feature's own table, as a
--   DRAFT row a human publishes. Copying it here would create a second place where a
--   student's data lives with a different retention story.

CREATE TABLE IF NOT EXISTS ai_feature_policies (
  feature_key text PRIMARY KEY,
  description text NOT NULL,
  -- Default off, as a column default rather than a convention.
  enabled boolean NOT NULL DEFAULT false,
  model text NOT NULL,
  -- Every AI feature ships with its own cap. A feature with an unbounded ceiling is not
  -- shippable, so the columns are NOT NULL rather than optional.
  cap integer NOT NULL,
  cap_window text NOT NULL DEFAULT 'DAY',
  max_input_chars integer NOT NULL DEFAULT 16000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_feature_key_ck CHECK (feature_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT ai_feature_description_ck CHECK (length(description) BETWEEN 1 AND 500),
  CONSTRAINT ai_feature_cap_ck CHECK (cap > 0),
  CONSTRAINT ai_feature_window_ck CHECK (cap_window IN ('DAY','MONTH')),
  CONSTRAINT ai_feature_input_ck CHECK (max_input_chars BETWEEN 100 AND 500000),
  CONSTRAINT ai_feature_model_ck CHECK (length(model) BETWEEN 1 AND 200)
);

-- ---------------------------------------------------------------------------
-- Execution record
-- ---------------------------------------------------------------------------
-- One row per attempt, including the ones that were refused. A feature that is
-- refusing every call looks identical to a feature nobody uses, unless the refusal is
-- written down.

CREATE TABLE IF NOT EXISTS ai_generations (
  id uuid PRIMARY KEY,
  feature_key text NOT NULL,
  -- Nullable: some generations are about content rather than about a person.
  subject_user_id uuid REFERENCES users(id),
  prompt_key text NOT NULL,
  prompt_version integer NOT NULL,
  provider_key text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  outcome text NOT NULL,
  failure_class text,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_generation_outcome_ck CHECK (outcome IN ('SUCCEEDED','REFUSED','FAILED')),
  -- A refusal or a failure has a reason; a success does not need one.
  --
  -- The IS NOT NULL is load-bearing rather than belt-and-braces. Without it the second
  -- branch reads `outcome <> 'SUCCEEDED' AND NULL ~ '...'`, which is NULL, and Postgres
  -- treats a NULL check as satisfied -- so a failure with no reason recorded would have
  -- passed silently. It did, until a test caught it.
  CONSTRAINT ai_generation_failure_ck CHECK (
    (outcome = 'SUCCEEDED' AND failure_class IS NULL)
    OR (outcome <> 'SUCCEEDED' AND failure_class IS NOT NULL AND failure_class ~ '^[A-Z0-9_]{3,64}$')),
  CONSTRAINT ai_generation_tokens_ck CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT ai_generation_version_ck CHECK (prompt_version >= 1)
);

-- The cap query: successes in a window for one feature. Partial, because refusals and
-- failures do not consume the ceiling and should not be scanned to count it.
CREATE INDEX IF NOT EXISTS ai_generation_cap_idx
  ON ai_generations(feature_key, occurred_at DESC) WHERE outcome = 'SUCCEEDED';
CREATE INDEX IF NOT EXISTS ai_generation_subject_idx ON ai_generations(subject_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ai_generation_failure_idx
  ON ai_generations(feature_key, failure_class, occurred_at DESC) WHERE outcome <> 'SUCCEEDED';

-- ---------------------------------------------------------------------------
-- No generation without a policy
-- ---------------------------------------------------------------------------
-- The orchestrator refuses an unknown feature in code. This makes the same thing true
-- of the data, so a direct insert cannot invent a feature that was never configured and
-- therefore never had a cap.

-- Re-asserted rather than only declared inline, so a database that already ran an
-- earlier version of this file picks up the corrected predicate.
ALTER TABLE ai_generations DROP CONSTRAINT IF EXISTS ai_generation_failure_ck;
ALTER TABLE ai_generations ADD CONSTRAINT ai_generation_failure_ck CHECK (
  (outcome = 'SUCCEEDED' AND failure_class IS NULL)
  OR (outcome <> 'SUCCEEDED' AND failure_class IS NOT NULL AND failure_class ~ '^[A-Z0-9_]{3,64}$'));

ALTER TABLE ai_generations DROP CONSTRAINT IF EXISTS ai_generation_feature_fk;
ALTER TABLE ai_generations ADD CONSTRAINT ai_generation_feature_fk
  FOREIGN KEY (feature_key) REFERENCES ai_feature_policies(feature_key);

COMMENT ON TABLE ai_feature_policies IS
  'Per-feature flag, model and cap. Default off; a feature with no cap is not shippable.';
COMMENT ON TABLE ai_generations IS
  'One row per generation attempt, refusals included. Never stores the generated text.';
COMMENT ON COLUMN ai_generations.prompt_version IS
  'Which immutable prompt version ran. Prompts live in code, not here.';
