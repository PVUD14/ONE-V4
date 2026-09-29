-- 0082 — faculty learning actions (INST-16): practice sets and lessons assigned by a lecturer, group sessions
-- (a MEETING staff action with attendees and linked content), and one-student plan overrides.
-- Design: docs/architecture/faculty-learning-actions-table-design.md.
--
-- Why: the planner (ENG-08, 0053) already carries faculty constraints — assignments and an override — with no
-- source. These tables are that source. A faculty action is a constraint the planner honours, never a write to
-- mastery, evidence or readiness; only published, current content can be assigned (checked here, at insert, by
-- one SQL definition); an override is linked to the learning_decisions row that applied it, so it is replayable
-- from the engine's decision audit.
--
-- Idempotent (ADR-035 applies it once; it also survives the bootstrap replay): IF NOT EXISTS, CHECKs dropped
-- IF EXISTS and re-added, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER. References
-- only tables created before it (0004, 0020, 0053, 0061, 0065 and the organisation, membership and unit tables).

-- 1. The one definition of "published and current" for assignable content.
CREATE OR REPLACE FUNCTION learning_content_published(kind text, skill uuid, lesson uuid)
RETURNS boolean AS $$
  SELECT CASE
    WHEN kind = 'PRACTICE' THEN lesson IS NULL AND EXISTS (
      SELECT 1 FROM question_versions q
      JOIN question_answer_keys k ON k.question_version_id = q.id
      JOIN release_manifests rm ON rm.id = q.release_manifest_id AND rm.status = 'PUBLISHED'
      WHERE q.topic_id = skill AND q.superseded_at IS NULL)
    WHEN kind = 'LESSON' THEN lesson IS NOT NULL AND EXISTS (
      SELECT 1 FROM lesson_versions l
      JOIN learning_modules m ON m.id = l.module_id
      JOIN release_manifests rm ON rm.id = m.release_manifest_id AND rm.status = 'PUBLISHED'
      WHERE l.id = lesson AND l.topic_id = skill AND l.superseded_at IS NULL)
    ELSE false
  END
$$ LANGUAGE sql STABLE;

-- 2. Assignments: the lecturer's act, and the students it reached.
CREATE TABLE IF NOT EXISTS learning_assignments (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  assigned_by_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  content_kind text NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  lesson_version_id uuid REFERENCES lesson_versions(id),
  target_kind text NOT NULL,
  target_unit_id uuid,
  note text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by_user_id uuid REFERENCES users(id),
  withdraw_reason_code text
);
ALTER TABLE learning_assignments DROP CONSTRAINT IF EXISTS learning_assignments_kind_ck;
ALTER TABLE learning_assignments ADD CONSTRAINT learning_assignments_kind_ck
  CHECK (content_kind IN ('PRACTICE', 'LESSON') AND (content_kind = 'LESSON') = (lesson_version_id IS NOT NULL));
ALTER TABLE learning_assignments DROP CONSTRAINT IF EXISTS learning_assignments_target_ck;
ALTER TABLE learning_assignments ADD CONSTRAINT learning_assignments_target_ck
  CHECK (target_kind IN ('UNIT', 'STUDENTS') AND (target_kind = 'UNIT') = (target_unit_id IS NOT NULL));
ALTER TABLE learning_assignments DROP CONSTRAINT IF EXISTS learning_assignments_unit_fk;
ALTER TABLE learning_assignments ADD CONSTRAINT learning_assignments_unit_fk
  FOREIGN KEY (target_unit_id, institution_id) REFERENCES institution_units(id, institution_id);
ALTER TABLE learning_assignments DROP CONSTRAINT IF EXISTS learning_assignments_note_ck;
ALTER TABLE learning_assignments ADD CONSTRAINT learning_assignments_note_ck
  CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500);
ALTER TABLE learning_assignments DROP CONSTRAINT IF EXISTS learning_assignments_withdrawn_ck;
ALTER TABLE learning_assignments ADD CONSTRAINT learning_assignments_withdrawn_ck
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by_user_id IS NULL) AND (withdrawn_at IS NULL) = (withdraw_reason_code IS NULL)
    AND (withdraw_reason_code IS NULL OR withdraw_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));
CREATE INDEX IF NOT EXISTS learning_assignments_author_idx ON learning_assignments(institution_id, assigned_by_user_id, assigned_at DESC, id);

CREATE TABLE IF NOT EXISTS learning_assignment_students (
  assignment_id uuid NOT NULL REFERENCES learning_assignments(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid NOT NULL REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, student_user_id)
);
CREATE INDEX IF NOT EXISTS learning_assignment_students_student_idx ON learning_assignment_students(student_user_id, created_at);

-- 3. One-student plan overrides.
CREATE TABLE IF NOT EXISTS learning_plan_overrides (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_by_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  action text NOT NULL,
  content_kind text NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  lesson_version_id uuid REFERENCES lesson_versions(id),
  reason_code text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'PENDING',
  applied_decision_id uuid REFERENCES learning_decisions(id),
  applied_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_by_user_id uuid REFERENCES users(id),
  withdraw_reason_code text
);
ALTER TABLE learning_plan_overrides DROP CONSTRAINT IF EXISTS learning_plan_overrides_action_ck;
ALTER TABLE learning_plan_overrides ADD CONSTRAINT learning_plan_overrides_action_ck CHECK (action IN ('LEARN', 'PRACTICE', 'REVIEW'));
ALTER TABLE learning_plan_overrides DROP CONSTRAINT IF EXISTS learning_plan_overrides_kind_ck;
ALTER TABLE learning_plan_overrides ADD CONSTRAINT learning_plan_overrides_kind_ck
  CHECK (content_kind IN ('PRACTICE', 'LESSON') AND (content_kind = 'LESSON') = (lesson_version_id IS NOT NULL));
ALTER TABLE learning_plan_overrides DROP CONSTRAINT IF EXISTS learning_plan_overrides_reason_ck;
ALTER TABLE learning_plan_overrides ADD CONSTRAINT learning_plan_overrides_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$');
ALTER TABLE learning_plan_overrides DROP CONSTRAINT IF EXISTS learning_plan_overrides_note_ck;
ALTER TABLE learning_plan_overrides ADD CONSTRAINT learning_plan_overrides_note_ck CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500);
ALTER TABLE learning_plan_overrides DROP CONSTRAINT IF EXISTS learning_plan_overrides_state_ck;
ALTER TABLE learning_plan_overrides ADD CONSTRAINT learning_plan_overrides_state_ck
  CHECK (state IN ('PENDING', 'APPLIED', 'WITHDRAWN')
    AND (state = 'APPLIED') = (applied_decision_id IS NOT NULL AND applied_at IS NOT NULL)
    AND (applied_decision_id IS NULL) = (applied_at IS NULL)
    AND (state = 'WITHDRAWN') = (withdrawn_at IS NOT NULL AND withdrawn_by_user_id IS NOT NULL AND withdraw_reason_code IS NOT NULL)
    AND (withdrawn_at IS NULL) = (withdrawn_by_user_id IS NULL) AND (withdrawn_at IS NULL) = (withdraw_reason_code IS NULL)
    AND (withdraw_reason_code IS NULL OR withdraw_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));
CREATE UNIQUE INDEX IF NOT EXISTS learning_plan_overrides_pending_uq ON learning_plan_overrides(student_user_id) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS learning_plan_overrides_author_idx ON learning_plan_overrides(institution_id, created_by_user_id, created_at DESC, id);

-- 4. Group sessions: attendees and linked content of a MEETING staff action.
CREATE TABLE IF NOT EXISTS staff_action_attendees (
  staff_action_id uuid NOT NULL REFERENCES staff_actions(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid NOT NULL REFERENCES organizations(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_action_id, student_user_id)
);
CREATE INDEX IF NOT EXISTS staff_action_attendees_student_idx ON staff_action_attendees(student_user_id, added_at);

CREATE TABLE IF NOT EXISTS staff_action_content_links (
  staff_action_id uuid NOT NULL REFERENCES staff_actions(id),
  position smallint NOT NULL,
  content_kind text NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  lesson_version_id uuid REFERENCES lesson_versions(id),
  PRIMARY KEY (staff_action_id, position)
);
ALTER TABLE staff_action_content_links DROP CONSTRAINT IF EXISTS staff_action_content_links_ck;
ALTER TABLE staff_action_content_links ADD CONSTRAINT staff_action_content_links_ck
  CHECK (position BETWEEN 1 AND 5 AND content_kind IN ('PRACTICE', 'LESSON') AND (content_kind = 'LESSON') = (lesson_version_id IS NOT NULL));

-- 5. Guards. A guard against application mistakes, with the standing of the 0047, 0053 and 0072 triggers.
CREATE OR REPLACE FUNCTION guard_learning_assignment()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT learning_content_published(NEW.content_kind, NEW.skill_id, NEW.lesson_version_id) THEN
      RAISE EXCEPTION 'only published content can be assigned';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'an assignment starts open';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'learning_assignments rows are never deleted';
  END IF;
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.institution_id = OLD.institution_id AND NEW.assigned_by_user_id = OLD.assigned_by_user_id
     AND NEW.assigned_by_membership_id = OLD.assigned_by_membership_id AND NEW.content_kind = OLD.content_kind
     AND NEW.skill_id = OLD.skill_id AND NEW.lesson_version_id IS NOT DISTINCT FROM OLD.lesson_version_id
     AND NEW.target_kind = OLD.target_kind AND NEW.target_unit_id IS NOT DISTINCT FROM OLD.target_unit_id
     AND NEW.note IS NOT DISTINCT FROM OLD.note AND NEW.assigned_at = OLD.assigned_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'learning_assignments: only an open assignment may be withdrawn, once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_assignments_guard ON learning_assignments;
CREATE TRIGGER learning_assignments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON learning_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_learning_assignment();

CREATE OR REPLACE FUNCTION guard_learning_assignment_student()
RETURNS trigger AS $$
DECLARE
  header record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT institution_id, withdrawn_at INTO header FROM learning_assignments WHERE id = NEW.assignment_id;
    IF header.institution_id IS DISTINCT FROM NEW.institution_id OR header.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a student is added only to an open assignment of the same college';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning_assignment_students rows are removed only by privacy deletion and never changed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_assignment_students_guard ON learning_assignment_students;
CREATE TRIGGER learning_assignment_students_guard
  BEFORE INSERT OR UPDATE OR DELETE ON learning_assignment_students
  FOR EACH ROW EXECUTE FUNCTION guard_learning_assignment_student();

CREATE OR REPLACE FUNCTION guard_learning_plan_override()
RETURNS trigger AS $$
DECLARE
  decision record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' THEN
      RAISE EXCEPTION 'an override starts pending';
    END IF;
    IF NOT learning_content_published(NEW.content_kind, NEW.skill_id, NEW.lesson_version_id) THEN
      RAISE EXCEPTION 'only published content can be set as a next step';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'learning_plan_overrides rows are removed only by privacy deletion';
  END IF;
  IF OLD.state <> 'PENDING'
     OR NEW.id <> OLD.id OR NEW.institution_id <> OLD.institution_id OR NEW.student_user_id <> OLD.student_user_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_by_membership_id <> OLD.created_by_membership_id
     OR NEW.action <> OLD.action OR NEW.content_kind <> OLD.content_kind OR NEW.skill_id <> OLD.skill_id
     OR NEW.lesson_version_id IS DISTINCT FROM OLD.lesson_version_id OR NEW.reason_code <> OLD.reason_code
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'learning_plan_overrides: only a pending override may be applied or withdrawn';
  END IF;
  IF NEW.state = 'APPLIED' THEN
    SELECT subject_user_id, override_by_user_id, inputs -> 'constraints' -> 'override' ->> 'overrideId' AS override_id
      INTO decision FROM learning_decisions WHERE id = NEW.applied_decision_id;
    IF decision.subject_user_id IS DISTINCT FROM NEW.student_user_id
       OR decision.override_by_user_id IS DISTINCT FROM NEW.created_by_user_id
       OR lower(decision.override_id) IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION 'an override is applied only by the decision that carries it';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'WITHDRAWN' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'learning_plan_overrides: only a pending override may be applied or withdrawn';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learning_plan_overrides_guard ON learning_plan_overrides;
CREATE TRIGGER learning_plan_overrides_guard
  BEFORE INSERT OR UPDATE OR DELETE ON learning_plan_overrides
  FOR EACH ROW EXECUTE FUNCTION guard_learning_plan_override();

CREATE OR REPLACE FUNCTION guard_staff_action_attendee()
RETURNS trigger AS $$
DECLARE
  action record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT institution_id, action_type INTO action FROM staff_actions WHERE id = NEW.staff_action_id;
    IF action.action_type IS DISTINCT FROM 'MEETING' OR action.institution_id IS DISTINCT FROM NEW.institution_id THEN
      RAISE EXCEPTION 'attendees belong to a meeting of the same college';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'staff_action_attendees rows are removed only by privacy deletion and never changed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS staff_action_attendees_guard ON staff_action_attendees;
CREATE TRIGGER staff_action_attendees_guard
  BEFORE INSERT OR UPDATE OR DELETE ON staff_action_attendees
  FOR EACH ROW EXECUTE FUNCTION guard_staff_action_attendee();

CREATE OR REPLACE FUNCTION guard_staff_action_content_link()
RETURNS trigger AS $$
DECLARE
  action_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a.action_type INTO action_type FROM staff_actions a WHERE a.id = NEW.staff_action_id;
    IF action_type IS DISTINCT FROM 'MEETING' THEN
      RAISE EXCEPTION 'content is linked only to a meeting';
    END IF;
    IF NOT learning_content_published(NEW.content_kind, NEW.skill_id, NEW.lesson_version_id) THEN
      RAISE EXCEPTION 'only published content can be linked to a session';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'staff_action_content_links rows are never changed or removed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS staff_action_content_links_guard ON staff_action_content_links;
CREATE TRIGGER staff_action_content_links_guard
  BEFORE INSERT OR UPDATE OR DELETE ON staff_action_content_links
  FOR EACH ROW EXECUTE FUNCTION guard_staff_action_content_link();
