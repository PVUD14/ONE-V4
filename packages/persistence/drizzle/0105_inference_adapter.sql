-- Inference adapter (ENG-20): latency and attempts on every generation, and the endpoint probe.
--
-- Design: docs/architecture/inference-adapter-design.md (§4 accounting, §5 the probe table).
--
-- ADR-047 lifted the AI hold: ONE AI Orchestration now reaches an OpenAI-compatible endpoint
-- configured only from the server environment. Neither table here holds the key, the endpoint
-- URL beyond its host, a prompt or generated text.
--
-- Idempotent: bootstrap and the integration specs replay every file. References only tables up
-- to 0089 (ai_generations, 0033) and nothing numbered 0101-0104.

-- ---------------------------------------------------------------------------
-- 1. ai_generations: provider wall time and attempts
-- ---------------------------------------------------------------------------
-- Nullable on purpose: a refusal made no call, and a row from before this file honestly has no
-- latency. A default of 0 would read as "instant".
ALTER TABLE ai_generations ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE ai_generations ADD COLUMN IF NOT EXISTS provider_attempts integer;

ALTER TABLE ai_generations DROP CONSTRAINT IF EXISTS ai_generation_latency_ck;
ALTER TABLE ai_generations ADD CONSTRAINT ai_generation_latency_ck CHECK (
  (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 86400000)
  AND (provider_attempts IS NULL OR provider_attempts BETWEEN 1 AND 10)
  -- A refusal made no call, so it carries neither.
  AND (outcome <> 'REFUSED' OR (latency_ms IS NULL AND provider_attempts IS NULL)));

COMMENT ON COLUMN ai_generations.latency_ms IS
  'Provider wall time in ms, retries and backoff included (ENG-20). NULL when no call was made.';
COMMENT ON COLUMN ai_generations.provider_attempts IS
  'HTTP attempts made to the inference endpoint (ENG-20). NULL when no call was made.';

-- ---------------------------------------------------------------------------
-- 2. ai_provider_probes: is the endpoint reachable, and does it serve the model
-- ---------------------------------------------------------------------------
-- Written by the `ai:probe` command, never by a request handler: CLAUDE.md forbids a request
-- handler calling the inference endpoint, so AI Operations reads the latest recorded probe.
CREATE TABLE IF NOT EXISTS ai_provider_probes (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL,
  -- The host only (e.g. <pod-id>-8888.proxy.runpod.net); never the path, never the key.
  endpoint_host text,
  configured boolean NOT NULL,
  configured_model text,
  reachable boolean NOT NULL,
  -- Whether the configured model is in GET /models; NULL when the endpoint could not be asked.
  model_served boolean,
  failure_class text,
  latency_ms integer,
  probed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_provider_probes DROP CONSTRAINT IF EXISTS ai_provider_probe_shape_ck;
ALTER TABLE ai_provider_probes ADD CONSTRAINT ai_provider_probe_shape_ck CHECK (
  provider_key ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  AND (endpoint_host IS NULL OR (length(endpoint_host) BETWEEN 1 AND 255 AND endpoint_host !~ '[/@?#[:space:]]'))
  AND (configured_model IS NULL OR length(configured_model) BETWEEN 1 AND 200)
  AND (failure_class IS NULL OR failure_class ~ '^[A-Z0-9_]{3,64}$')
  AND (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000)
  -- Unconfigured is never reachable, and says nothing about a host.
  AND (configured OR (NOT reachable AND endpoint_host IS NULL AND model_served IS NULL))
  -- An unreachable endpoint always says why.
  AND (reachable OR failure_class IS NOT NULL));

CREATE INDEX IF NOT EXISTS ai_provider_probe_latest_idx ON ai_provider_probes (probed_at DESC, id DESC);

-- Probes are evidence of what the console showed: never edited, and deleted only once older than
-- the retention window (the probe command prunes).
CREATE OR REPLACE FUNCTION ai_provider_probe_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AI provider probes are immutable; record a later one instead';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.probed_at > now() - interval '90 days' THEN
      RAISE EXCEPTION 'AI provider probes are kept for 90 days';
    END IF;
    RETURN OLD;
  END IF;
  NEW.probed_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_provider_probe_guard ON ai_provider_probes;
CREATE TRIGGER ai_provider_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_provider_probes
FOR EACH ROW EXECUTE FUNCTION ai_provider_probe_guard();

COMMENT ON TABLE ai_provider_probes IS
  'Reachability probes of the inference endpoint (ENG-20), written by the ai:probe command. No key, no URL path, no prompt.';
