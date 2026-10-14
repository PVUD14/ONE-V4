-- Résumés generated from the student's own ONE record (RESUME-GEN).
--
-- Design: docs/architecture/student-resumes-table-design.md
--
-- 1. student_resumes: one row per résumé a student keeps (a title and an owner).
-- 2. student_resume_versions: one row per save — what the student ticked and typed (selections) and the
--    résumé exactly as it was previewed (content). A version is never updated: an edit is a new version.
--    DELETE is allowed: the owner deleting a résumé (cascade) and privacy deletion.
--
-- Nobody but the student reads these tables. Content never carries readiness, a band, a score, mastery or a
-- stage; the top-level keys are refused here as a backstop to the API's contract test.
--
-- References only users (0001). Idempotent: IF NOT EXISTS everywhere, constraints dropped and re-added under
-- their own names, CREATE OR REPLACE for the function, the trigger dropped and re-created.

CREATE TABLE IF NOT EXISTS student_resumes (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE student_resumes DROP CONSTRAINT IF EXISTS student_resume_title_ck;
ALTER TABLE student_resumes ADD CONSTRAINT student_resume_title_ck
  CHECK (length(title) BETWEEN 1 AND 120 AND title !~ '^[=+@-]');
ALTER TABLE student_resumes DROP CONSTRAINT IF EXISTS student_resume_dates_ck;
ALTER TABLE student_resumes ADD CONSTRAINT student_resume_dates_ck CHECK (updated_at >= created_at);
CREATE UNIQUE INDEX IF NOT EXISTS student_resume_owner_uq ON student_resumes(id, student_user_id);
CREATE INDEX IF NOT EXISTS student_resume_student_idx ON student_resumes(student_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS student_resume_versions (
  id uuid PRIMARY KEY,
  resume_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES users(id),
  version_number integer NOT NULL,
  template_key text NOT NULL,
  selections jsonb NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A version belongs to a résumé of the same student: the owner travels through the key.
ALTER TABLE student_resume_versions DROP CONSTRAINT IF EXISTS student_resume_version_resume_fk;
ALTER TABLE student_resume_versions ADD CONSTRAINT student_resume_version_resume_fk
  FOREIGN KEY (resume_id, student_user_id) REFERENCES student_resumes(id, student_user_id) ON DELETE CASCADE;
ALTER TABLE student_resume_versions DROP CONSTRAINT IF EXISTS student_resume_version_number_ck;
ALTER TABLE student_resume_versions ADD CONSTRAINT student_resume_version_number_ck CHECK (version_number BETWEEN 1 AND 50);
ALTER TABLE student_resume_versions DROP CONSTRAINT IF EXISTS student_resume_version_template_ck;
ALTER TABLE student_resume_versions ADD CONSTRAINT student_resume_version_template_ck
  CHECK (template_key IN ('CLASSIC', 'MODERN', 'COMPACT'));
ALTER TABLE student_resume_versions DROP CONSTRAINT IF EXISTS student_resume_version_selections_ck;
ALTER TABLE student_resume_versions ADD CONSTRAINT student_resume_version_selections_ck
  CHECK (jsonb_typeof(selections) = 'object' AND octet_length(selections::text) <= 32768);
ALTER TABLE student_resume_versions DROP CONSTRAINT IF EXISTS student_resume_version_content_ck;
ALTER TABLE student_resume_versions ADD CONSTRAINT student_resume_version_content_ck
  CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 65536
    AND NOT (content ?| ARRAY['readiness', 'readinessBand', 'band', 'score', 'mastery', 'stage']));
ALTER TABLE student_resume_versions DROP CONSTRAINT IF EXISTS student_resume_version_hash_ck;
ALTER TABLE student_resume_versions ADD CONSTRAINT student_resume_version_hash_ck CHECK (content_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX IF NOT EXISTS student_resume_version_number_uq ON student_resume_versions(resume_id, version_number);
CREATE INDEX IF NOT EXISTS student_resume_version_student_idx ON student_resume_versions(student_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_student_resume_version() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a saved résumé version is what the student saw; it is never rewritten — save a new version';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS student_resume_version_guard ON student_resume_versions;
CREATE TRIGGER student_resume_version_guard BEFORE UPDATE ON student_resume_versions
  FOR EACH ROW EXECUTE FUNCTION guard_student_resume_version();

COMMENT ON TABLE student_resumes IS
  'RESUME-GEN: résumés a student generates from their own ONE record. Read by the student only; erased on account deletion.';
COMMENT ON TABLE student_resume_versions IS
  'RESUME-GEN: one immutable row per save — the selections and the résumé content as previewed. Never readiness, scores, bands, stages or identifiers in content.';
