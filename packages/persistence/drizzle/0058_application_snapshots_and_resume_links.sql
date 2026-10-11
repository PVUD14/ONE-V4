-- Consented application snapshots and short-lived résumé links (EMP-07).
--
-- Design: docs/architecture/application-snapshots-table-design.md
--
-- 1. application_profile_snapshots (0007, résumé file pointer 0008) is written for the first time
--    by EMP-07. It gains the format version, the job version the student applied under, the exact
--    résumé version chosen and an erasure stamp, and a trigger that makes the row immutable:
--    DELETE is refused, and the only UPDATE allowed is privacy deletion for the application's own
--    student (transaction-local one.privacy_erase_subject, the 0047 pattern) stamping erased_at.
-- 2. application_resume_download_links: one row per résumé link issued to a recruiter — a digest
--    of a random token, valid for at most five minutes, redeemable once, by that person only.
--
-- Additive only; every 0007/0008 constraint is kept and nothing is backfilled (no snapshot row
-- has ever been written: EMPLOYER_BASELINE D-4). References only tables created before 0058
-- (users 0001, applications and opportunity_versions 0007, stored_files and
-- student_document_versions 0008). Idempotent: IF NOT EXISTS everywhere, constraints dropped and
-- re-added under their own names, CREATE OR REPLACE for the function.

-- ---------------------------------------------------------------------------
-- 1. Snapshots
-- ---------------------------------------------------------------------------
ALTER TABLE application_profile_snapshots ADD COLUMN IF NOT EXISTS schema_version smallint NOT NULL DEFAULT 1;
ALTER TABLE application_profile_snapshots ADD COLUMN IF NOT EXISTS opportunity_version_id uuid REFERENCES opportunity_versions(id);
ALTER TABLE application_profile_snapshots ADD COLUMN IF NOT EXISTS resume_document_version_id uuid REFERENCES student_document_versions(id);
ALTER TABLE application_profile_snapshots ADD COLUMN IF NOT EXISTS erased_at timestamptz;

ALTER TABLE application_profile_snapshots DROP CONSTRAINT IF EXISTS application_snapshot_schema_version_ck;
ALTER TABLE application_profile_snapshots ADD CONSTRAINT application_snapshot_schema_version_ck CHECK (schema_version >= 1);
ALTER TABLE application_profile_snapshots DROP CONSTRAINT IF EXISTS application_snapshot_content_ck;
ALTER TABLE application_profile_snapshots ADD CONSTRAINT application_snapshot_content_ck
  CHECK (jsonb_typeof(snapshot) = 'object' AND snapshot_hash ~ '^[0-9a-f]{64}$');
-- A résumé is all three pointers or none; an erased snapshot has none.
ALTER TABLE application_profile_snapshots DROP CONSTRAINT IF EXISTS application_snapshot_resume_shape_ck;
ALTER TABLE application_profile_snapshots ADD CONSTRAINT application_snapshot_resume_shape_ck CHECK (
  (resume_document_id IS NULL AND resume_file_id IS NULL AND resume_document_version_id IS NULL)
  OR (resume_document_id IS NOT NULL AND resume_file_id IS NOT NULL AND resume_document_version_id IS NOT NULL AND erased_at IS NULL)
);
ALTER TABLE application_profile_snapshots DROP CONSTRAINT IF EXISTS application_snapshot_erased_ck;
ALTER TABLE application_profile_snapshots ADD CONSTRAINT application_snapshot_erased_ck
  CHECK (erased_at IS NULL OR erased_at >= created_at);

CREATE OR REPLACE FUNCTION guard_application_profile_snapshot() RETURNS trigger AS $$
DECLARE
  applied uuid;
  subject uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT applied_version_id INTO applied FROM applications WHERE id = NEW.application_id;
    IF NEW.opportunity_version_id IS NULL OR applied IS DISTINCT FROM NEW.opportunity_version_id THEN
      RAISE EXCEPTION 'an application snapshot must name the job version the application was made under';
    END IF;
    IF NEW.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'an application snapshot cannot be written already erased';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an application snapshot is never deleted; privacy deletion erases its content';
  END IF;
  SELECT student_user_id INTO subject FROM applications WHERE id = OLD.application_id;
  IF current_setting('one.privacy_erase_subject', true) = subject::text
     AND OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.application_id = OLD.application_id
     AND NEW.created_at = OLD.created_at AND NEW.schema_version = OLD.schema_version
     AND NEW.opportunity_version_id IS NOT DISTINCT FROM OLD.opportunity_version_id
     AND NEW.resume_document_id IS NULL AND NEW.resume_file_id IS NULL AND NEW.resume_document_version_id IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an application snapshot is what the student shared; it is never rewritten';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS application_profile_snapshot_guard ON application_profile_snapshots;
CREATE TRIGGER application_profile_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON application_profile_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_application_profile_snapshot();

COMMENT ON TABLE application_profile_snapshots IS
  'EMP-07: what the student consented to share with this employer at apply, reviewed by them and hashed. Never readiness, figures, photos or identifiers. Immutable; privacy deletion alone erases the content.';

-- ---------------------------------------------------------------------------
-- 2. Résumé download links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_resume_download_links (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  issued_to_user_id uuid NOT NULL REFERENCES users(id),
  stored_file_id uuid NOT NULL REFERENCES stored_files(id),
  token_digest text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
ALTER TABLE application_resume_download_links DROP CONSTRAINT IF EXISTS application_resume_link_application_fk;
ALTER TABLE application_resume_download_links ADD CONSTRAINT application_resume_link_application_fk
  FOREIGN KEY (application_id, employer_id) REFERENCES applications(id, employer_id);
ALTER TABLE application_resume_download_links DROP CONSTRAINT IF EXISTS application_resume_link_digest_ck;
ALTER TABLE application_resume_download_links ADD CONSTRAINT application_resume_link_digest_ck CHECK (token_digest ~ '^[0-9a-f]{64}$');
ALTER TABLE application_resume_download_links DROP CONSTRAINT IF EXISTS application_resume_link_window_ck;
ALTER TABLE application_resume_download_links ADD CONSTRAINT application_resume_link_window_ck
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes');
ALTER TABLE application_resume_download_links DROP CONSTRAINT IF EXISTS application_resume_link_consumed_ck;
ALTER TABLE application_resume_download_links ADD CONSTRAINT application_resume_link_consumed_ck
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at);
CREATE UNIQUE INDEX IF NOT EXISTS application_resume_link_digest_uq ON application_resume_download_links(token_digest);
CREATE INDEX IF NOT EXISTS application_resume_link_application_idx ON application_resume_download_links(application_id, issued_at DESC);

COMMENT ON TABLE application_resume_download_links IS
  'EMP-07: single-use résumé links, at most five minutes, bound to one recruiter and the snapshot''s pinned file. Only a digest of the token is stored.';
