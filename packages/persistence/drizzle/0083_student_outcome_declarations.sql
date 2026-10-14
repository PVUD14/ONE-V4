-- INST-13: graduates' self-reported outcomes, shared with one college by the graduate's own choice.
--
-- Colleges report placed, higher-studies and entrepreneurship figures for accreditation. ONE knows
-- "placed" from applications students shared (ADR-019, INST-12) and nothing about the other two, so
-- a student may tell one college they studied at that they went on to higher studies or started a
-- venture. The row is the consent: it exists only while shared, carries no detail, is withdrawable,
-- and is read only by the accreditation export as a suppressed count — never shown to a college per
-- person. Design: docs/architecture/student-outcome-declarations-table-design.md.
-- References only tables created in 0000–0080. Idempotent: every statement is guarded, so a replay
-- (bootstrap, ADR-035) is a no-op.

CREATE TABLE IF NOT EXISTS student_outcome_declarations (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid NOT NULL REFERENCES organizations(id),
  outcome text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_outcome_declarations_outcome_ck CHECK (outcome IN ('HIGHER_STUDIES', 'ENTREPRENEURSHIP')),
  CONSTRAINT student_outcome_declarations_withdrawn_ck CHECK (withdrawn_at IS NULL OR withdrawn_at >= declared_at)
);

-- One live declaration per student and college; a withdrawn one may be followed by a new one.
CREATE UNIQUE INDEX IF NOT EXISTS student_outcome_declarations_live_uq
  ON student_outcome_declarations (student_user_id, institution_id) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS student_outcome_declarations_college_idx
  ON student_outcome_declarations (institution_id, student_user_id) WHERE withdrawn_at IS NULL;

-- A declaration starts shared; the only change is its withdrawal, once; rows are removed only by the
-- privacy erase of that student (transaction-local setting, as 0060, 0068 and 0080 do).
CREATE OR REPLACE FUNCTION student_outcome_declaration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'student_outcome_declarations rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a declaration starts shared' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.student_user_id <> OLD.student_user_id OR NEW.institution_id <> OLD.institution_id
     OR NEW.outcome <> OLD.outcome OR NEW.declared_at <> OLD.declared_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a declaration never changes; withdraw it and declare again' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'a withdrawn declaration never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'student_outcome_declaration_guard' AND tgrelid = to_regclass('student_outcome_declarations')) THEN
    CREATE TRIGGER student_outcome_declaration_guard BEFORE INSERT OR UPDATE OR DELETE ON student_outcome_declarations
      FOR EACH ROW EXECUTE FUNCTION student_outcome_declaration_guard();
  END IF;
END $$;
