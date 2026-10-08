-- ENG-26: recalibration runs — monthly 2PL recalibrations and BKT refits, held for review.
--
-- A refit is recorded here as a proposal with its comparison against the parameters it would
-- replace; nothing is adopted until a decision row accepts it (items are then imported through
-- ENG-13's item_calibrations guards; BKT fits are only recorded — ENG-27 / HG-5 own using them).
-- Parameters and counts only: no learner, no readiness. Design:
-- docs/architecture/recalibration-runs-table-design.md. Idempotent, because a fresh database's
-- bootstrap replays every file once (ADR-035).

CREATE TABLE IF NOT EXISTS recalibration_runs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  source text NOT NULL,
  algorithm_id text NOT NULL,
  library text NOT NULL,
  threshold integer NOT NULL,
  units_read integer NOT NULL,
  observations_read integer NOT NULL,
  units_compared integer NOT NULL,
  units_drifted integer NOT NULL,
  verdict text NOT NULL,
  baseline_digest text NOT NULL,
  previous_run_id uuid,
  results jsonb NOT NULL,
  report jsonb NOT NULL,
  exported_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recalibration_runs_kind_ck CHECK (kind IN ('ITEM_2PL','BKT')),
  CONSTRAINT recalibration_runs_source_ck CHECK (source = 'jobs/calibration'),
  CONSTRAINT recalibration_runs_algorithm_ck CHECK (
    (kind = 'ITEM_2PL' AND algorithm_id = 'item-calibration-2pl-v1')
    OR (kind = 'BKT' AND algorithm_id = 'bkt-fit-mle-v1')
  ),
  CONSTRAINT recalibration_runs_library_ck CHECK (length(library) BETWEEN 1 AND 200),
  CONSTRAINT recalibration_runs_threshold_ck CHECK (threshold >= 1),
  CONSTRAINT recalibration_runs_counts_ck CHECK (
    units_read >= 0 AND observations_read >= 0 AND units_compared >= 0
    AND units_drifted >= 0 AND units_drifted <= units_compared
  ),
  CONSTRAINT recalibration_runs_verdict_ck CHECK (
    (verdict = 'DRIFTED' AND units_drifted > 0)
    OR (verdict = 'STABLE' AND units_drifted = 0 AND units_compared > 0)
    OR (verdict = 'NO_COMPARISON' AND units_compared = 0)
  ),
  CONSTRAINT recalibration_runs_digest_ck CHECK (baseline_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recalibration_runs_documents_ck CHECK (jsonb_typeof(results) = 'object' AND jsonb_typeof(report) = 'object')
);
CREATE INDEX IF NOT EXISTS recalibration_runs_kind_recorded_idx ON recalibration_runs(kind, recorded_at DESC);

CREATE TABLE IF NOT EXISTS recalibration_decisions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES recalibration_runs(id),
  decision text NOT NULL,
  reason text NOT NULL,
  item_run_id uuid REFERENCES item_calibration_runs(id),
  -- clock_timestamp, not now(): decisions taken in one transaction still order (latest accepted wins).
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT recalibration_decisions_decision_ck CHECK (decision IN ('ACCEPTED','REJECTED','REVERTED')),
  CONSTRAINT recalibration_decisions_reason_ck CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT recalibration_decisions_item_run_ck CHECK (decision <> 'REJECTED' OR item_run_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS recalibration_decisions_run_decision_uq ON recalibration_decisions(run_id, decision);

-- The decision order is a rule of the data, not only of the command: a run is accepted or
-- rejected once, and only an accepted run can be reverted.
CREATE OR REPLACE FUNCTION guard_recalibration_decision()
RETURNS trigger AS $$
DECLARE
  run_kind text;
BEGIN
  SELECT kind INTO run_kind FROM recalibration_runs WHERE id = NEW.run_id;
  IF NEW.decision = 'REVERTED' THEN
    IF NOT EXISTS (SELECT 1 FROM recalibration_decisions WHERE run_id = NEW.run_id AND decision = 'ACCEPTED') THEN
      RAISE EXCEPTION 'recalibration_decisions: only an accepted run can be reverted';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM recalibration_decisions WHERE run_id = NEW.run_id AND decision IN ('ACCEPTED','REJECTED')) THEN
    RAISE EXCEPTION 'recalibration_decisions: a run is accepted or rejected once';
  END IF;
  IF run_kind = 'BKT' AND NEW.item_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'recalibration_decisions: a BKT decision imports no item run';
  END IF;
  IF run_kind = 'ITEM_2PL' AND NEW.decision = 'ACCEPTED' AND NEW.item_run_id IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'recalibration_decisions: an accepted item run imports itself';
  END IF;
  IF run_kind = 'ITEM_2PL' AND NEW.decision = 'REVERTED' AND NEW.item_run_id IS NULL THEN
    RAISE EXCEPTION 'recalibration_decisions: an item revert names the run it wrote';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recalibration_decisions_order ON recalibration_decisions;
CREATE TRIGGER recalibration_decisions_order
  BEFORE INSERT ON recalibration_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_recalibration_decision();

-- Append-only, like the calibrations themselves (reuses 0062's function). Neither table holds
-- personal data, so there is no privacy-deletion exception.
DROP TRIGGER IF EXISTS recalibration_runs_append_only ON recalibration_runs;
CREATE TRIGGER recalibration_runs_append_only
  BEFORE UPDATE OR DELETE ON recalibration_runs
  FOR EACH ROW EXECUTE FUNCTION reject_item_calibration_change();

DROP TRIGGER IF EXISTS recalibration_decisions_append_only ON recalibration_decisions;
CREATE TRIGGER recalibration_decisions_append_only
  BEFORE UPDATE OR DELETE ON recalibration_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_item_calibration_change();

COMMENT ON TABLE recalibration_runs IS
  'ENG-26: proposed 2PL recalibrations and BKT refits with their drift comparison. Parameters and counts only; never readiness.';
COMMENT ON TABLE recalibration_decisions IS
  'ENG-26: the recorded accept / reject / revert of a recalibration run. Nothing is adopted without one.';
