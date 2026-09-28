-- ENG-13: item calibrations — the 2PL parameters the offline calibration job fits.
--
-- Model state describing items, not people: never shown to a student as a number, never an
-- employer input, never readiness. Written only by the calibration import, one run per
-- transaction. Design: docs/architecture/item-calibrations-table-design.md. Idempotent,
-- because a fresh database's bootstrap replays every file once (ADR-035).

CREATE TABLE IF NOT EXISTS item_calibration_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  algorithm_id text NOT NULL,
  library text NOT NULL,
  min_responses integer NOT NULL,
  learners_read integer NOT NULL,
  responses_read integer NOT NULL,
  items_read integer NOT NULL,
  exported_at timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_calibration_runs_source_ck CHECK (source = 'jobs/calibration'),
  CONSTRAINT item_calibration_runs_algorithm_ck CHECK (algorithm_id IN ('item-calibration-2pl-v1')),
  CONSTRAINT item_calibration_runs_library_ck CHECK (length(library) BETWEEN 1 AND 200),
  CONSTRAINT item_calibration_runs_min_responses_ck CHECK (min_responses >= 1),
  CONSTRAINT item_calibration_runs_counts_ck CHECK (learners_read >= 0 AND responses_read >= 0 AND items_read >= 0)
);

CREATE TABLE IF NOT EXISTS item_calibrations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES item_calibration_runs(id),
  item_source text NOT NULL,
  item_id uuid NOT NULL,
  item_version integer NOT NULL,
  model text NOT NULL,
  difficulty numeric(6,4) NOT NULL,
  discrimination numeric(6,4) NOT NULL,
  responses_used integer NOT NULL,
  status text NOT NULL,
  status_reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_calibrations_item_source_ck CHECK (item_source IN ('CAREER_READINESS_QUESTION','INSTITUTION_EXAM_QUESTION')),
  CONSTRAINT item_calibrations_item_version_ck CHECK (item_version > 0),
  CONSTRAINT item_calibrations_model_ck CHECK (model = '2PL'),
  CONSTRAINT item_calibrations_difficulty_ck CHECK (difficulty BETWEEN -4 AND 4),
  CONSTRAINT item_calibrations_discrimination_ck CHECK (discrimination BETWEEN 0.2 AND 4),
  CONSTRAINT item_calibrations_responses_ck CHECK (responses_used >= 0),
  CONSTRAINT item_calibrations_status_ck CHECK (status IN ('PROVISIONAL','CALIBRATED')),
  CONSTRAINT item_calibrations_status_reason_ck CHECK (
    (status = 'CALIBRATED' AND status_reason IS NULL)
    OR (status = 'PROVISIONAL' AND status_reason IS NOT NULL AND status_reason IN ('TOO_FEW_RESPONSES','NO_VARIANCE','TOO_FEW_ITEMS','ESTIMATE_OUT_OF_RANGE'))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS item_calibrations_run_item_uq
  ON item_calibrations(run_id, item_source, item_id, item_version);
CREATE INDEX IF NOT EXISTS item_calibrations_item_latest_idx
  ON item_calibrations(item_source, item_id, item_version, recorded_at DESC);

-- Items with too few responses stay PROVISIONAL at the data layer, not only in the job:
-- a CALIBRATED row must meet its own run's threshold.
CREATE OR REPLACE FUNCTION guard_item_calibration_threshold()
RETURNS trigger AS $$
DECLARE
  threshold integer;
BEGIN
  IF NEW.status = 'CALIBRATED' THEN
    SELECT min_responses INTO threshold FROM item_calibration_runs WHERE id = NEW.run_id;
    IF threshold IS NULL OR NEW.responses_used < threshold THEN
      RAISE EXCEPTION 'item_calibrations: a CALIBRATED row needs at least its run''s min_responses responses';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS item_calibrations_threshold ON item_calibrations;
CREATE TRIGGER item_calibrations_threshold
  BEFORE INSERT ON item_calibrations
  FOR EACH ROW EXECUTE FUNCTION guard_item_calibration_threshold();

-- Append-only: a new run adds rows and never rewrites an old one. Neither table holds
-- personal data, so there is no privacy-deletion exception.
CREATE OR REPLACE FUNCTION reject_item_calibration_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS item_calibration_runs_append_only ON item_calibration_runs;
CREATE TRIGGER item_calibration_runs_append_only
  BEFORE UPDATE OR DELETE ON item_calibration_runs
  FOR EACH ROW EXECUTE FUNCTION reject_item_calibration_change();

DROP TRIGGER IF EXISTS item_calibrations_append_only ON item_calibrations;
CREATE TRIGGER item_calibrations_append_only
  BEFORE UPDATE OR DELETE ON item_calibrations
  FOR EACH ROW EXECUTE FUNCTION reject_item_calibration_change();

COMMENT ON TABLE item_calibrations IS
  'ENG-13: fitted 2PL item parameters. Model state about items; never shown to students as a number, never readiness.';
