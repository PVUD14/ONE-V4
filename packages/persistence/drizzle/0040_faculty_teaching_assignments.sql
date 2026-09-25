-- ONE · Faculty teaching assignments (INST-03)
--
-- Records which faculty membership teaches which section or batch, for which subject and
-- term (decision 10.2 #3). Once an institution has any row here, a faculty member's
-- student scope is exactly the units of their active assignments (Appendix 3 Section 5.1).
-- Design and reasoning: docs/architecture/faculty-teaching-assignments-table-design.md.
--
-- The migrator replays every file on every run, so everything below is repeatable.

CREATE TABLE IF NOT EXISTS faculty_teaching_assignments (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  faculty_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  unit_id uuid NOT NULL,
  subject_id uuid,
  subject_code text,
  academic_term text NOT NULL,
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  state text NOT NULL DEFAULT 'ACTIVE',
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  ended_at timestamptz,
  ended_by_user_id uuid REFERENCES users(id),
  end_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faculty_teaching_unit_same_institution_fk FOREIGN KEY (unit_id, institution_id)
    REFERENCES institution_units(id, institution_id),
  CONSTRAINT faculty_teaching_subject_same_institution_fk FOREIGN KEY (subject_id, institution_id)
    REFERENCES exam_subjects(id, institution_id),
  CONSTRAINT faculty_teaching_subject_present_ck CHECK (subject_id IS NOT NULL OR subject_code IS NOT NULL),
  CONSTRAINT faculty_teaching_subject_code_ck CHECK (subject_code IS NULL OR (length(subject_code) BETWEEN 1 AND 32 AND subject_code !~ '^[=+@-]')),
  CONSTRAINT faculty_teaching_term_ck CHECK (length(academic_term) BETWEEN 1 AND 40 AND academic_term !~ '^[=+@-]'),
  CONSTRAINT faculty_teaching_window_ck CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT faculty_teaching_state_ck CHECK (state IN ('ACTIVE', 'ENDED')),
  CONSTRAINT faculty_teaching_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT faculty_teaching_end_reason_ck CHECK (end_reason_code IS NULL OR end_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT faculty_teaching_ended_ck CHECK (
    (state = 'ACTIVE' AND ended_at IS NULL AND ended_by_user_id IS NULL AND end_reason_code IS NULL)
    OR (state = 'ENDED' AND ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL AND end_reason_code IS NOT NULL)
  ),
  CONSTRAINT faculty_teaching_updated_at_ck CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS faculty_teaching_active_uq ON faculty_teaching_assignments (
  faculty_membership_id,
  unit_id,
  coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(coalesce(subject_code, '')),
  lower(academic_term)
) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS faculty_teaching_membership_idx ON faculty_teaching_assignments (institution_id, faculty_membership_id, state);
CREATE INDEX IF NOT EXISTS faculty_teaching_unit_idx ON faculty_teaching_assignments (institution_id, unit_id, state);
CREATE INDEX IF NOT EXISTS faculty_teaching_created_idx ON faculty_teaching_assignments (institution_id, created_at DESC, id DESC);

-- A foreign key cannot check the role or the unit kind, so a trigger does: the membership
-- must be a FACULTY_LECTURER of this institution, and the unit a section or batch.
CREATE OR REPLACE FUNCTION enforce_faculty_teaching_assignment()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE id = NEW.faculty_membership_id AND organization_id = NEW.institution_id
      AND scope_institution_id = NEW.institution_id AND role = 'FACULTY_LECTURER'
  ) THEN
    RAISE EXCEPTION 'teaching assignment must name a faculty membership of the institution';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM institution_units
    WHERE id = NEW.unit_id AND institution_id = NEW.institution_id AND kind IN ('SECTION', 'BATCH')
  ) THEN
    RAISE EXCEPTION 'teaching assignment unit must be a section or batch of the institution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS faculty_teaching_assignments_guard ON faculty_teaching_assignments;
CREATE TRIGGER faculty_teaching_assignments_guard
BEFORE INSERT OR UPDATE OF faculty_membership_id, unit_id, institution_id ON faculty_teaching_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_faculty_teaching_assignment();

COMMENT ON TABLE faculty_teaching_assignments IS
  'Which faculty membership teaches which section or batch, per subject and term (INST-03). Drives faculty student scope once an institution has any row; rows are ended, never deleted.';
