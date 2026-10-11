-- Who verified a student document (security fix: a student could mark their own document VERIFIED).
--
-- Design: docs/architecture/student-document-verification-design.md
--
-- 1. Three nullable columns record the verifier, when, and on behalf of which institution.
-- 2. Every existing VERIFIED/REJECTED row has no verifier -- no route could record one -- so each was the
--    student's own claim. They are reset to SELF_REPORTED before the constraints are added. No row or
--    file is deleted; nothing else on the row changes.
-- 3. VERIFIED/REJECTED if and only if a verifier is recorded; the verifier is never the owner.
-- 4. A guard trigger: a verifier is an ACTIVE member of the INSTITUTION named; VERIFIED is permanent;
--    a decided row's substance (title, type, description, file version, verifier) is frozen.
--
-- References users, organizations, organization_memberships (0000/0001) and student_document_metadata
-- (0006). Idempotent: IF NOT EXISTS for columns, constraints dropped and re-added under their own names,
-- CREATE OR REPLACE for the function, the trigger dropped and re-created.

ALTER TABLE student_document_metadata
  ADD COLUMN IF NOT EXISTS verified_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_institution_id uuid REFERENCES organizations(id);

-- The guard is dropped first so the reset below is never refused by an earlier run's trigger.
DROP TRIGGER IF EXISTS student_document_verification_guard ON student_document_metadata;

DO $$
DECLARE
  reset_count integer;
BEGIN
  UPDATE student_document_metadata
     SET verification_state = 'SELF_REPORTED'
   WHERE verification_state IN ('VERIFIED','REJECTED')
     AND verified_by_user_id IS NULL;
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  RAISE NOTICE '0107: % self-asserted student document verification state(s) reset to SELF_REPORTED', reset_count;
END;
$$;

ALTER TABLE student_document_metadata DROP CONSTRAINT IF EXISTS student_document_verifier_ck;
ALTER TABLE student_document_metadata ADD CONSTRAINT student_document_verifier_ck CHECK (
  (verified_by_user_id IS NULL) = (verified_at IS NULL)
  AND (verified_by_user_id IS NULL) = (verification_institution_id IS NULL));

-- No verifier, no decision; no decision, no verifier.
ALTER TABLE student_document_metadata DROP CONSTRAINT IF EXISTS student_document_decided_ck;
ALTER TABLE student_document_metadata ADD CONSTRAINT student_document_decided_ck CHECK (
  (verification_state IN ('VERIFIED','REJECTED')) = (verified_by_user_id IS NOT NULL));

ALTER TABLE student_document_metadata DROP CONSTRAINT IF EXISTS student_document_not_self_verified_ck;
ALTER TABLE student_document_metadata ADD CONSTRAINT student_document_not_self_verified_ck CHECK (
  verified_by_user_id IS NULL OR verified_by_user_id <> student_user_id);

CREATE OR REPLACE FUNCTION student_document_verification_guard() RETURNS trigger AS $$
BEGIN
  -- With no verifier recorded the CHECK constraints refuse the row and name the rule; this checks who.
  IF NEW.verification_state IN ('VERIFIED','REJECTED')
     AND NEW.verified_by_user_id IS NOT NULL AND NEW.verification_institution_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR OLD.verification_state IS DISTINCT FROM NEW.verification_state
          OR OLD.verified_by_user_id IS DISTINCT FROM NEW.verified_by_user_id
          OR OLD.verification_institution_id IS DISTINCT FROM NEW.verification_institution_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM organizations o
       WHERE o.id = NEW.verification_institution_id AND o.kind = 'INSTITUTION'
    ) THEN
      RAISE EXCEPTION 'a student document is verified only on behalf of an institution';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organization_memberships m
       WHERE m.organization_id = NEW.verification_institution_id
         AND m.user_id = NEW.verified_by_user_id
         AND m.state = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'a student document verifier must be an active member of the verifying institution';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.verification_state = 'VERIFIED' AND NEW.verification_state <> 'VERIFIED' THEN
      RAISE EXCEPTION 'a verified student document cannot be unverified';
    END IF;
    IF OLD.verification_state IN ('VERIFIED','REJECTED') AND NEW.verification_state = OLD.verification_state
       AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id
            OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
            OR NEW.verification_institution_id IS DISTINCT FROM OLD.verification_institution_id
            OR NEW.title IS DISTINCT FROM OLD.title
            OR NEW.document_type IS DISTINCT FROM OLD.document_type
            OR NEW.description IS DISTINCT FROM OLD.description
            -- Clearing the pointer is allowed: privacy deletion does it just before deleting the row.
            OR (NEW.current_version_id IS NOT NULL AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)) THEN
      RAISE EXCEPTION 'a decided student document cannot be changed; its verification covers it as it was';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_document_verification_guard
  BEFORE INSERT OR UPDATE ON student_document_metadata
  FOR EACH ROW EXECUTE FUNCTION student_document_verification_guard();

COMMENT ON COLUMN student_document_metadata.verified_by_user_id IS
  'The institution staff member who decided VERIFIED/REJECTED. NULL until a staff verification route exists; a student can never set it (0107).';
