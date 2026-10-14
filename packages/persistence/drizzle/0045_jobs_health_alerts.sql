-- Jobs health alerts and the indexes behind the System Health console (OPS-04).
--
-- Design: docs/architecture/jobs-health-alerts-table-design.md
--
-- One row per breach of one background-jobs condition, so the evaluator raises an alert
-- once per breach rather than once per event or once per run, plus partial indexes that
-- keep the console's summary reads bounded.
--
-- The migrator replays every file on every run, in lexical order, with no tracking
-- table. Everything here is idempotent and depends only on tables from 0000-0004.

CREATE TABLE IF NOT EXISTS jobs_health_alerts (
  id uuid PRIMARY KEY,
  condition_key text NOT NULL,
  subject text,
  state text NOT NULL DEFAULT 'OPEN',
  observed_value integer NOT NULL,
  threshold integer NOT NULL,
  notice text NOT NULL,
  correlation_id text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);

-- Constraints are dropped and re-added so a replay converges on this definition.
ALTER TABLE jobs_health_alerts DROP CONSTRAINT IF EXISTS jobs_health_alert_condition_ck;
ALTER TABLE jobs_health_alerts ADD CONSTRAINT jobs_health_alert_condition_ck
  CHECK (condition_key IN ('FAILED_EVENTS_THRESHOLD', 'PENDING_EVENTS_STALLED', 'CONSUMER_SILENT'));

ALTER TABLE jobs_health_alerts DROP CONSTRAINT IF EXISTS jobs_health_alert_subject_ck;
ALTER TABLE jobs_health_alerts ADD CONSTRAINT jobs_health_alert_subject_ck CHECK (
  (condition_key = 'CONSUMER_SILENT' AND subject IS NOT NULL AND subject ~ '^[a-z0-9._-]{1,100}$')
  OR (condition_key <> 'CONSUMER_SILENT' AND subject IS NULL));

ALTER TABLE jobs_health_alerts DROP CONSTRAINT IF EXISTS jobs_health_alert_state_ck;
ALTER TABLE jobs_health_alerts ADD CONSTRAINT jobs_health_alert_state_ck CHECK (
  (state = 'OPEN' AND cleared_at IS NULL) OR (state = 'CLEARED' AND cleared_at IS NOT NULL));

ALTER TABLE jobs_health_alerts DROP CONSTRAINT IF EXISTS jobs_health_alert_values_ck;
ALTER TABLE jobs_health_alerts ADD CONSTRAINT jobs_health_alert_values_ck
  CHECK (observed_value >= 0 AND threshold >= 1);

ALTER TABLE jobs_health_alerts DROP CONSTRAINT IF EXISTS jobs_health_alert_notice_ck;
ALTER TABLE jobs_health_alerts ADD CONSTRAINT jobs_health_alert_notice_ck
  CHECK (notice IN ('QUEUED', 'NOT_DELIVERED'));

ALTER TABLE jobs_health_alerts DROP CONSTRAINT IF EXISTS jobs_health_alert_correlation_ck;
ALTER TABLE jobs_health_alerts ADD CONSTRAINT jobs_health_alert_correlation_ck
  CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$');

-- At most one open breach per condition and subject: two evaluators cannot raise it twice.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_health_alert_open_uq
  ON jobs_health_alerts (condition_key, coalesce(subject, '')) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS jobs_health_alert_recent_idx ON jobs_health_alerts (raised_at DESC, id DESC);

-- The record of alerting is evidence: business columns never change, the only transition
-- is OPEN -> CLEARED stamped by the database clock, and rows are never deleted.
CREATE OR REPLACE FUNCTION enforce_jobs_health_alert_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'jobs health alerts are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.raised_at := now();
    NEW.state := 'OPEN';
    NEW.cleared_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.id <> NEW.id OR OLD.condition_key <> NEW.condition_key OR OLD.subject IS DISTINCT FROM NEW.subject
    OR OLD.observed_value <> NEW.observed_value OR OLD.threshold <> NEW.threshold OR OLD.notice <> NEW.notice
    OR OLD.correlation_id <> NEW.correlation_id OR OLD.raised_at <> NEW.raised_at THEN
    RAISE EXCEPTION 'jobs health alert fields are immutable';
  END IF;
  IF OLD.state = 'CLEARED' THEN
    RAISE EXCEPTION 'a cleared jobs health alert cannot change';
  END IF;
  IF NEW.state = 'CLEARED' THEN
    NEW.cleared_at := now();
  ELSIF NEW.state <> 'OPEN' THEN
    RAISE EXCEPTION 'invalid jobs health alert state';
  ELSE
    NEW.cleared_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_health_alert_guard ON jobs_health_alerts;
CREATE TRIGGER jobs_health_alert_guard BEFORE INSERT OR UPDATE OR DELETE ON jobs_health_alerts
FOR EACH ROW EXECUTE FUNCTION enforce_jobs_health_alert_guard();

-- ---------------------------------------------------------------------------
-- Bounded reads for the console (partial indexes: small, and only where needed)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS outbox_failed_keyset_idx
  ON outbox_events (occurred_at DESC, id DESC) WHERE delivery_state = 'FAILED';
CREATE INDEX IF NOT EXISTS outbox_failed_type_keyset_idx
  ON outbox_events (event_type, occurred_at DESC, id DESC) WHERE delivery_state = 'FAILED';
CREATE INDEX IF NOT EXISTS outbox_pending_oldest_idx
  ON outbox_events (occurred_at) WHERE delivery_state = 'PENDING';
CREATE INDEX IF NOT EXISTS outbox_published_latest_idx
  ON outbox_events (published_at DESC) WHERE delivery_state = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS event_consumer_receipts_activity_idx
  ON event_consumer_receipts (consumer_name, updated_at DESC);
