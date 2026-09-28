-- INST-11 — Restricted counselling notes.
--
-- Counselling becomes a staff-action type (ADR-036, decision 10.2 #5) whose readers are the
-- author, institution owners and admins, and staff explicitly added to that student's
-- counselling case — not the unit scope other staff actions use. This file adds the type,
-- constrains its shape so it can never surface through a workflow column (calendar, due date,
-- evidence), adds the case-participant list, and a privacy-deletion category for the notes.
-- Design: docs/architecture/counselling-notes-table-design.md.
--
-- Migrations apply once (ADR-035), but bootstrap replays every file once and CI applies some by
-- hand, so every statement here is still idempotent. It references only tables created by files
-- numbered below 0060.

-- The full type list: every value 0020 allowed, plus COUNSELLING_NOTE.
ALTER TABLE staff_actions DROP CONSTRAINT IF EXISTS staff_actions_type_ck;
ALTER TABLE staff_actions ADD CONSTRAINT staff_actions_type_ck CHECK (action_type IN (
  'INTERVENTION', 'ASSIGNED_TASK', 'FACULTY_NOTE',
  'ACADEMIC_VERIFICATION', 'MEETING', 'COUNSELLING_NOTE'
));

-- A counselling note is about one student under one relationship, carries text, belongs to its
-- author, and has none of the workflow columns that calendars, dashboards and evidence access read.
ALTER TABLE staff_actions DROP CONSTRAINT IF EXISTS staff_actions_counselling_shape_ck;
ALTER TABLE staff_actions ADD CONSTRAINT staff_actions_counselling_shape_ck CHECK (
  action_type <> 'COUNSELLING_NOTE' OR (
    subject_student_user_id IS NOT NULL
    AND institution_relationship_id IS NOT NULL
    AND note IS NOT NULL AND length(btrim(note)) > 0
    AND due_at IS NULL
    AND scheduled_start_at IS NULL AND scheduled_end_at IS NULL
    AND source_exam_assignment_id IS NULL
    AND evidence_document_version_id IS NULL
    AND assigned_to_membership_id = actor_membership_id
  )
);

CREATE INDEX IF NOT EXISTS staff_actions_counselling_student_idx
  ON staff_actions(institution_id, subject_student_user_id, created_at DESC, id)
  WHERE action_type = 'COUNSELLING_NOTE';

-- Staff an owner or admin has added to one student's counselling case. Removal keeps the row,
-- so who could read a student's notes, and when, stays answerable.
CREATE TABLE IF NOT EXISTS counselling_case_participants (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  added_by_user_id uuid NOT NULL REFERENCES users(id),
  added_by_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  added_reason_code text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  removed_reason_code text,
  CONSTRAINT counselling_case_participants_added_reason_ck CHECK (added_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT counselling_case_participants_removed_reason_ck CHECK (removed_reason_code IS NULL OR removed_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT counselling_case_participants_removal_ck CHECK (
    (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_reason_code IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL AND removed_reason_code IS NOT NULL)
  ),
  CONSTRAINT counselling_case_participants_removed_after_ck CHECK (removed_at IS NULL OR removed_at >= added_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS counselling_case_participants_active_uq
  ON counselling_case_participants(institution_id, student_user_id, membership_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS counselling_case_participants_membership_idx
  ON counselling_case_participants(institution_id, membership_id)
  WHERE removed_at IS NULL;

-- Privacy deletion erases the notes (COUNSELLING_NOTES, ERASED). The full category list: every
-- value 0009, 0043 and 0047 allowed, plus the new one.
ALTER TABLE privacy_deletion_records DROP CONSTRAINT IF EXISTS privacy_deletion_category_ck;
ALTER TABLE privacy_deletion_records ADD CONSTRAINT privacy_deletion_category_ck CHECK (category IN (
  'IDENTITY','STUDENT_PROFILE','INSTITUTION_ROSTER','DOCUMENTS','APPLICATIONS','OFFERS','ASSESSMENT_EVIDENCE','NOTIFICATIONS','AUDIT',
  'SUPPORT_CASES','LEARNING_ACTIVITY','COUNSELLING_NOTES'
));
