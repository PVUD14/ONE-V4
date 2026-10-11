-- 0085 — preparation sprints (INST-17): a time-boxed INST-16 assignment, run by the placement office, an admin or a
-- department head for the students with a gap in one essential requirement of a career role.
-- Design: docs/architecture/preparation-sprints-table-design.md.
--
-- Why: the cohort view shows where a college's students stand against a role's essential requirements; a sprint is
-- how the college acts on it. It is one learning_assignments row (0082) — so the planner honours it, the student
-- sees it and "done" is derived exactly as for a lecturer's assignment — plus this header, which records the role,
-- the requirement, the time box and why. At ends_at the assignment stops being a constraint (derived in the
-- loader, never by a job). Nothing here writes mastery, evidence or readiness, and the row names no student.
--
-- Idempotent (ADR-035 applies it once; it also survives the bootstrap replay): IF NOT EXISTS, constraints dropped
-- IF EXISTS and re-added, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER. References only
-- tables created in files up to 0084 (0004, 0011, 0069, 0073, 0082 and the organisation, membership and unit tables).

CREATE TABLE IF NOT EXISTS preparation_sprints (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  assignment_id uuid NOT NULL REFERENCES learning_assignments(id),
  career_role_id uuid NOT NULL REFERENCES career_roles(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  campus_drive_id uuid,
  scope_unit_id uuid,
  include_unknown boolean NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_by_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  reason_code text NOT NULL,
  note text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  cancel_reason_code text
);

CREATE UNIQUE INDEX IF NOT EXISTS preparation_sprints_assignment_uq ON preparation_sprints(assignment_id);
CREATE INDEX IF NOT EXISTS preparation_sprints_institution_idx ON preparation_sprints(institution_id, starts_at DESC, id);

ALTER TABLE preparation_sprints DROP CONSTRAINT IF EXISTS preparation_sprints_drive_fk;
ALTER TABLE preparation_sprints ADD CONSTRAINT preparation_sprints_drive_fk
  FOREIGN KEY (campus_drive_id, institution_id) REFERENCES campus_drives(id, institution_id);
ALTER TABLE preparation_sprints DROP CONSTRAINT IF EXISTS preparation_sprints_unit_fk;
ALTER TABLE preparation_sprints ADD CONSTRAINT preparation_sprints_unit_fk
  FOREIGN KEY (scope_unit_id, institution_id) REFERENCES institution_units(id, institution_id);
ALTER TABLE preparation_sprints DROP CONSTRAINT IF EXISTS preparation_sprints_reason_ck;
ALTER TABLE preparation_sprints ADD CONSTRAINT preparation_sprints_reason_ck
  CHECK (reason_code IN ('CAMPUS_DRIVE_PREPARATION', 'ESSENTIAL_GAP', 'PLACEMENT_SEASON'));
ALTER TABLE preparation_sprints DROP CONSTRAINT IF EXISTS preparation_sprints_note_ck;
ALTER TABLE preparation_sprints ADD CONSTRAINT preparation_sprints_note_ck
  CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500);
-- One to six weeks: a sprint is time-boxed by definition, and an open-ended one is an ordinary assignment.
ALTER TABLE preparation_sprints DROP CONSTRAINT IF EXISTS preparation_sprints_window_ck;
ALTER TABLE preparation_sprints ADD CONSTRAINT preparation_sprints_window_ck
  CHECK (ends_at >= starts_at + interval '7 days' AND ends_at <= starts_at + interval '42 days');
ALTER TABLE preparation_sprints DROP CONSTRAINT IF EXISTS preparation_sprints_cancelled_ck;
ALTER TABLE preparation_sprints ADD CONSTRAINT preparation_sprints_cancelled_ck
  CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL) AND (cancelled_at IS NULL) = (cancel_reason_code IS NULL)
    AND (cancelled_at IS NULL OR cancelled_at >= starts_at)
    AND (cancel_reason_code IS NULL OR cancel_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));

-- Guard: the header matches the assignment it time-boxes; it may only be ended early, once; it is never deleted.
CREATE OR REPLACE FUNCTION guard_preparation_sprint()
RETURNS trigger AS $$
DECLARE
  assignment record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT institution_id, skill_id, target_kind, assigned_at, withdrawn_at INTO assignment
      FROM learning_assignments WHERE id = NEW.assignment_id;
    IF assignment.institution_id IS DISTINCT FROM NEW.institution_id OR assignment.target_kind IS DISTINCT FROM 'STUDENTS'
       OR assignment.skill_id IS DISTINCT FROM NEW.topic_id OR assignment.assigned_at IS DISTINCT FROM NEW.starts_at
       OR assignment.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a sprint time-boxes one open assignment of the same college, on its skill, from the moment it was made';
    END IF;
    IF NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'a sprint starts running';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'preparation_sprints rows are never deleted';
  END IF;
  IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL AND OLD.ends_at > NEW.cancelled_at
     AND NEW.id = OLD.id AND NEW.institution_id = OLD.institution_id AND NEW.assignment_id = OLD.assignment_id
     AND NEW.career_role_id = OLD.career_role_id AND NEW.topic_id = OLD.topic_id
     AND NEW.campus_drive_id IS NOT DISTINCT FROM OLD.campus_drive_id AND NEW.scope_unit_id IS NOT DISTINCT FROM OLD.scope_unit_id
     AND NEW.include_unknown = OLD.include_unknown AND NEW.created_by_user_id = OLD.created_by_user_id
     AND NEW.created_by_membership_id = OLD.created_by_membership_id AND NEW.reason_code = OLD.reason_code
     AND NEW.note IS NOT DISTINCT FROM OLD.note AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'preparation_sprints: only a running sprint may be ended early, once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS preparation_sprints_guard ON preparation_sprints;
CREATE TRIGGER preparation_sprints_guard
  BEFORE INSERT OR UPDATE OR DELETE ON preparation_sprints
  FOR EACH ROW EXECUTE FUNCTION guard_preparation_sprint();
