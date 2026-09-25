-- ONE · Stream C — Institution
-- Owner: Navya · Created: 2026-09-05
-- Agent-assisted: yes (Codex) · Reviewed: pending
--
-- C3: one staff-action record for five institution workflows.
-- Provisional C2 approvals remain deferred application-layer policy:
-- role/scope permissions, transitions and self-review, student visibility and
-- submissions, verification/evidence access, meeting scope, membership and
-- relationship ending, audit history, and cross-record identity matching.
-- Foreign keys establish existence (and unit tenancy), not authorization.
-- No audit/event writes, shared-table changes, or policy triggers are added.
-- The migration runner replays SQL files; creation must remain repeatable.

CREATE TABLE IF NOT EXISTS staff_actions (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  subject_student_user_id uuid REFERENCES users(id),
  institution_relationship_id uuid REFERENCES institution_relationships(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  assigned_to_membership_id uuid REFERENCES organization_memberships(id),
  department_unit_id uuid,
  batch_unit_id uuid,
  action_type text NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  title text NOT NULL,
  note text,
  outcome_note text,
  due_at timestamptz,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  source_exam_assignment_id uuid REFERENCES exam_assignments(id),
  evidence_document_version_id uuid REFERENCES student_document_versions(id),
  visibility text NOT NULL DEFAULT 'STAFF_ONLY',
  version integer NOT NULL DEFAULT 1,
  last_reviewed_by_user_id uuid REFERENCES users(id),
  last_reviewed_at timestamptz,
  resolved_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  CONSTRAINT staff_actions_type_ck CHECK (action_type IN (
    'INTERVENTION', 'ASSIGNED_TASK', 'FACULTY_NOTE',
    'ACADEMIC_VERIFICATION', 'MEETING'
  )),
  CONSTRAINT staff_actions_state_ck CHECK (state IN (
    'DRAFT', 'OPEN', 'IN_PROGRESS', 'UNDER_REVIEW', 'CHANGES_REQUESTED',
    'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'ARCHIVED'
  )),
  CONSTRAINT staff_actions_visibility_ck CHECK (visibility IN ('STAFF_ONLY', 'SUBJECT_VISIBLE')),
  CONSTRAINT staff_actions_version_ck CHECK (version >= 1),
  CONSTRAINT staff_actions_meeting_pair_ck CHECK (
    (scheduled_start_at IS NULL) = (scheduled_end_at IS NULL)
  ),
  CONSTRAINT staff_actions_meeting_window_ck CHECK (scheduled_end_at > scheduled_start_at),
  CONSTRAINT staff_actions_reviewer_pair_ck CHECK (
    (last_reviewed_by_user_id IS NULL) = (last_reviewed_at IS NULL)
  ),
  CONSTRAINT staff_actions_updated_at_ck CHECK (updated_at >= created_at),
  CONSTRAINT staff_actions_department_fk FOREIGN KEY (department_unit_id, institution_id)
    REFERENCES institution_units(id, institution_id),
  CONSTRAINT staff_actions_batch_fk FOREIGN KEY (batch_unit_id, institution_id)
    REFERENCES institution_units(id, institution_id)
);

CREATE INDEX IF NOT EXISTS staff_actions_student_history_idx
  ON staff_actions(institution_id, subject_student_user_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS staff_actions_type_state_idx
  ON staff_actions(institution_id, action_type, state, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS staff_actions_assignee_due_idx
  ON staff_actions(institution_id, assigned_to_membership_id, due_at, id)
  WHERE assigned_to_membership_id IS NOT NULL AND due_at IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_actions_unit_scope_idx
  ON staff_actions(institution_id, department_unit_id, batch_unit_id, state)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_actions_meetings_idx
  ON staff_actions(institution_id, scheduled_start_at, id)
  WHERE action_type = 'MEETING' AND scheduled_start_at IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_actions_source_assessment_idx
  ON staff_actions(institution_id, source_exam_assignment_id)
  WHERE source_exam_assignment_id IS NOT NULL;
