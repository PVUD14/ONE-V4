-- Data subject rights: export and deletion.
--
-- Deletion here means erasing the person, not shredding every row they touched. An
-- employer's record that a hire happened, and the audit trail of who did what, are
-- lawfully retained; the identity attached to them is not. Modelling it this way is
-- what makes deletion possible at all without destroying other parties' records.
--
-- Two guarantees are structural rather than procedural:
--   * a deletion cannot complete while a retention hold is active, enforced by a
--     trigger rather than by remembering to check;
--   * request state changes are append-only history.
--
-- No rows are seeded. These tables are created empty.

-- ---------------------------------------------------------------------------
-- Retention holds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS data_retention_holds (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  detail text,
  placed_by_user_id uuid NOT NULL REFERENCES users(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by_user_id uuid REFERENCES users(id),
  released_at timestamptz,
  CONSTRAINT retention_hold_reason_ck CHECK (reason_code IN ('LEGAL_OBLIGATION','SAFETY_INVESTIGATION','EMPLOYER_ACCOUNTABILITY_CASE','DISPUTE','REGULATORY_REQUEST')),
  CONSTRAINT retention_hold_detail_ck CHECK (detail IS NULL OR length(detail) <= 2000),
  CONSTRAINT retention_hold_release_ck CHECK (
    (released_at IS NULL AND released_by_user_id IS NULL)
    OR (released_at IS NOT NULL AND released_by_user_id IS NOT NULL AND released_at >= placed_at)
  )
);
CREATE INDEX IF NOT EXISTS retention_hold_active_idx ON data_retention_holds(subject_user_id) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS privacy_requests (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  request_type text NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED',
  reason text,
  rejection_reason_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  -- Deletion only: the grace period during which the subject may still cancel.
  deletion_scheduled_for timestamptz,
  -- Export only: the produced bundle and how long it stays downloadable.
  export_file_id uuid REFERENCES stored_files(id),
  export_expires_at timestamptz,
  export_downloaded_at timestamptz,
  correlation_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT privacy_request_type_ck CHECK (request_type IN ('EXPORT','DELETION')),
  CONSTRAINT privacy_request_state_ck CHECK (state IN ('RECEIVED','IN_PROGRESS','READY','COMPLETED','REJECTED','CANCELLED','FAILED')),
  CONSTRAINT privacy_request_reason_ck CHECK (reason IS NULL OR length(reason) <= 2000),
  CONSTRAINT privacy_request_rejection_ck CHECK (rejection_reason_code IS NULL OR length(rejection_reason_code) <= 64),
  -- The two request types do not share fields; keeping them exclusive stops a row
  -- describing a deletion that also produced a download.
  CONSTRAINT privacy_request_export_fields_ck CHECK (
    request_type = 'EXPORT' OR (export_file_id IS NULL AND export_expires_at IS NULL AND export_downloaded_at IS NULL)
  ),
  CONSTRAINT privacy_request_deletion_fields_ck CHECK (
    request_type = 'DELETION' OR deletion_scheduled_for IS NULL
  ),
  -- A deletion must state when it will happen, and never before it was asked for.
  CONSTRAINT privacy_request_deletion_schedule_ck CHECK (
    request_type <> 'DELETION' OR state IN ('REJECTED','CANCELLED','FAILED')
    OR (deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for >= requested_at)
  ),
  -- An export that is ready must actually have a bundle and an expiry.
  CONSTRAINT privacy_request_ready_ck CHECK (
    state <> 'READY' OR request_type <> 'EXPORT' OR (export_file_id IS NOT NULL AND export_expires_at IS NOT NULL)
  ),
  CONSTRAINT privacy_request_completed_ck CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT privacy_request_cancelled_ck CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT privacy_request_rejected_ck CHECK (state <> 'REJECTED' OR rejection_reason_code IS NOT NULL),
  CONSTRAINT privacy_request_download_ck CHECK (export_downloaded_at IS NULL OR export_file_id IS NOT NULL)
);

-- One open request of each type per person: a second deletion request while one is
-- pending is the same request, not a new one.
CREATE UNIQUE INDEX IF NOT EXISTS privacy_request_open_uq
  ON privacy_requests(subject_user_id, request_type)
  WHERE state IN ('RECEIVED','IN_PROGRESS','READY');
CREATE INDEX IF NOT EXISTS privacy_request_subject_idx ON privacy_requests(subject_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS privacy_request_due_idx ON privacy_requests(deletion_scheduled_for)
  WHERE request_type = 'DELETION' AND state = 'RECEIVED';
CREATE INDEX IF NOT EXISTS privacy_request_expiry_idx ON privacy_requests(export_expires_at)
  WHERE request_type = 'EXPORT' AND state = 'READY';

CREATE TABLE IF NOT EXISTS privacy_request_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES privacy_requests(id),
  from_state text,
  to_state text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  actor_role text,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_event_to_state_ck CHECK (to_state IN ('RECEIVED','IN_PROGRESS','READY','COMPLETED','REJECTED','CANCELLED','FAILED')),
  CONSTRAINT privacy_event_from_state_ck CHECK (from_state IS NULL OR from_state IN ('RECEIVED','IN_PROGRESS','READY','COMPLETED','REJECTED','CANCELLED','FAILED')),
  CONSTRAINT privacy_event_note_ck CHECK (note IS NULL OR length(note) <= 2000)
);
CREATE INDEX IF NOT EXISTS privacy_request_events_request_idx ON privacy_request_events(request_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- What a completed deletion actually did
-- ---------------------------------------------------------------------------

-- Retained as evidence of compliance: which categories were erased, which were kept,
-- and on what basis. Without this, "we deleted your data" is an unverifiable claim.
CREATE TABLE IF NOT EXISTS privacy_deletion_records (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES privacy_requests(id),
  category text NOT NULL,
  disposition text NOT NULL,
  basis text,
  record_count integer,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_deletion_category_ck CHECK (category IN (
    'IDENTITY','STUDENT_PROFILE','INSTITUTION_ROSTER','DOCUMENTS','APPLICATIONS','OFFERS','ASSESSMENT_EVIDENCE','NOTIFICATIONS','AUDIT'
  )),
  CONSTRAINT privacy_deletion_disposition_ck CHECK (disposition IN ('ERASED','ANONYMISED','RETAINED')),
  -- Retaining anything requires stating why.
  CONSTRAINT privacy_deletion_basis_ck CHECK (disposition <> 'RETAINED' OR (basis IS NOT NULL AND length(basis) BETWEEN 1 AND 500)),
  CONSTRAINT privacy_deletion_count_ck CHECK (record_count IS NULL OR record_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS privacy_deletion_request_category_uq ON privacy_deletion_records(request_id, category);

-- ---------------------------------------------------------------------------
-- A hold blocks completion, structurally
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_privacy_deletion_hold()
RETURNS trigger AS $$
BEGIN
  IF NEW.request_type = 'DELETION' AND NEW.state = 'COMPLETED' THEN
    IF EXISTS (
      SELECT 1 FROM data_retention_holds
      WHERE subject_user_id = NEW.subject_user_id AND released_at IS NULL
    ) THEN
      RAISE EXCEPTION 'deletion cannot complete while a retention hold is active';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS privacy_requests_hold_guard ON privacy_requests;
CREATE TRIGGER privacy_requests_hold_guard
BEFORE INSERT OR UPDATE ON privacy_requests
FOR EACH ROW EXECUTE FUNCTION enforce_privacy_deletion_hold();

-- Subject identity after erasure. Kept as a column rather than deleting the row so
-- every foreign key from applications, audit events and institution records stays
-- valid; the person is gone, the structure survives.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymised_at timestamptz;
CREATE INDEX IF NOT EXISTS users_anonymised_idx ON users(anonymised_at) WHERE anonymised_at IS NOT NULL;
