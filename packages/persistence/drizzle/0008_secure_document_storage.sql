-- Secure document storage.
--
-- Files are represented separately from the documents that reference them so that
-- storage can move from local disk to S3 without touching the document model: only
-- storage_provider, storage_bucket and storage_key change meaning.
--
-- Two invariants are enforced structurally rather than trusted to callers:
--   * a file is only readable once it has actually been stored AND scanned clean,
--     so an unscanned or infected upload can never be served;
--   * scan results are append-only history, never an in-place edit of a verdict.
--
-- No rows are seeded. These tables are created empty.

-- ---------------------------------------------------------------------------
-- Stored files
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stored_files (
  id uuid PRIMARY KEY,
  storage_provider text NOT NULL DEFAULT 'LOCAL_DISK',
  storage_bucket text,
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint,
  checksum_sha256 text,
  upload_state text NOT NULL DEFAULT 'AWAITING_UPLOAD',
  scan_state text NOT NULL DEFAULT 'PENDING',
  scan_engine text,
  scan_engine_version text,
  scan_completed_at timestamptz,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  owner_organization_id uuid REFERENCES organizations(id),
  retention_expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stored_files_provider_ck CHECK (storage_provider IN ('LOCAL_DISK','S3')),
  -- S3 needs a bucket; local disk must not carry one, so the row cannot be ambiguous
  -- about where the bytes actually live.
  CONSTRAINT stored_files_bucket_ck CHECK (
    (storage_provider = 'S3' AND storage_bucket IS NOT NULL)
    OR (storage_provider = 'LOCAL_DISK' AND storage_bucket IS NULL)
  ),
  -- Keys are opaque and server-generated. Rejecting traversal and absolute paths here
  -- means a crafted key cannot escape the storage root even if a caller supplies one.
  CONSTRAINT stored_files_key_ck CHECK (
    length(storage_key) BETWEEN 1 AND 512
    AND storage_key !~ '\.\.'
    AND storage_key !~ '^/'
    AND storage_key !~ '[[:space:]]'
  ),
  CONSTRAINT stored_files_filename_ck CHECK (length(original_filename) BETWEEN 1 AND 255 AND original_filename !~ '[/\\]'),
  -- Allowlist, not denylist: anything not named here cannot be stored at all.
  CONSTRAINT stored_files_content_type_ck CHECK (content_type IN (
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )),
  CONSTRAINT stored_files_upload_state_ck CHECK (upload_state IN ('AWAITING_UPLOAD','STORED','ABANDONED')),
  CONSTRAINT stored_files_scan_state_ck CHECK (scan_state IN ('PENDING','SCANNING','CLEAN','INFECTED','SCAN_FAILED')),
  -- 20 MB ceiling, and a stored file must know its own size and checksum.
  CONSTRAINT stored_files_size_ck CHECK (byte_size IS NULL OR (byte_size > 0 AND byte_size <= 20971520)),
  CONSTRAINT stored_files_checksum_ck CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT stored_files_stored_complete_ck CHECK (
    upload_state <> 'STORED' OR (byte_size IS NOT NULL AND checksum_sha256 IS NOT NULL)
  ),
  -- A file cannot be scanned before it has been uploaded.
  CONSTRAINT stored_files_scan_requires_upload_ck CHECK (
    scan_state = 'PENDING' OR upload_state = 'STORED'
  ),
  CONSTRAINT stored_files_scan_completion_ck CHECK (
    (scan_state IN ('CLEAN','INFECTED','SCAN_FAILED') AND scan_completed_at IS NOT NULL AND scan_engine IS NOT NULL)
    OR (scan_state IN ('PENDING','SCANNING') AND scan_completed_at IS NULL)
  ),
  CONSTRAINT stored_files_deleted_ck CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS stored_files_location_uq
  ON stored_files(storage_provider, coalesce(storage_bucket, ''), storage_key);
CREATE INDEX IF NOT EXISTS stored_files_uploader_idx ON stored_files(uploaded_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stored_files_scan_queue_idx ON stored_files(scan_state, created_at) WHERE scan_state IN ('PENDING','SCANNING');
CREATE INDEX IF NOT EXISTS stored_files_retention_idx ON stored_files(retention_expires_at) WHERE deleted_at IS NULL AND retention_expires_at IS NOT NULL;

-- The single predicate every read path must satisfy. Expressed once, here, so no
-- caller has to remember the combination.
CREATE OR REPLACE VIEW readable_stored_files AS
  SELECT * FROM stored_files
  WHERE upload_state = 'STORED' AND scan_state = 'CLEAN' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Scan history (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS file_scan_events (
  id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES stored_files(id),
  scan_state text NOT NULL,
  engine text NOT NULL,
  engine_version text,
  signature_reference text,
  detail text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_scan_event_state_ck CHECK (scan_state IN ('SCANNING','CLEAN','INFECTED','SCAN_FAILED')),
  CONSTRAINT file_scan_event_engine_ck CHECK (length(engine) BETWEEN 1 AND 64),
  -- Detail is operator-facing text; it must never be long enough to carry a payload.
  CONSTRAINT file_scan_event_detail_ck CHECK (detail IS NULL OR length(detail) <= 1000),
  CONSTRAINT file_scan_event_signature_ck CHECK (signature_reference IS NULL OR length(signature_reference) <= 200)
);
CREATE INDEX IF NOT EXISTS file_scan_events_file_idx ON file_scan_events(file_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Document versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS student_document_versions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES student_document_metadata(id),
  version_number integer NOT NULL,
  file_id uuid NOT NULL REFERENCES stored_files(id),
  label text,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_document_version_number_ck CHECK (version_number >= 1),
  CONSTRAINT student_document_version_label_ck CHECK (label IS NULL OR (length(label) <= 120 AND label !~ '^[=+@-]'))
);
CREATE UNIQUE INDEX IF NOT EXISTS student_document_version_number_uq ON student_document_versions(document_id, version_number);
CREATE UNIQUE INDEX IF NOT EXISTS student_document_version_file_uq ON student_document_versions(file_id);
CREATE INDEX IF NOT EXISTS student_document_version_document_idx ON student_document_versions(document_id, version_number DESC);

-- Which version is live. Nullable so metadata can exist before any file is attached,
-- which is the state every document is in today.
ALTER TABLE student_document_metadata
  ADD COLUMN IF NOT EXISTS current_version_id uuid;
ALTER TABLE student_document_metadata
  DROP CONSTRAINT IF EXISTS student_document_current_version_fk;
ALTER TABLE student_document_metadata
  ADD CONSTRAINT student_document_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES student_document_versions(id);

-- The resume attached to an application must be a real stored file, not a free id.
ALTER TABLE application_profile_snapshots
  ADD COLUMN IF NOT EXISTS resume_file_id uuid;
ALTER TABLE application_profile_snapshots
  DROP CONSTRAINT IF EXISTS application_snapshot_resume_file_fk;
ALTER TABLE application_profile_snapshots
  ADD CONSTRAINT application_snapshot_resume_file_fk
  FOREIGN KEY (resume_file_id) REFERENCES stored_files(id);
