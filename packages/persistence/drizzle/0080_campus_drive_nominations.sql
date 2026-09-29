-- INST-14: placement-office nominations with student consent.
--
-- A college's placement office may put a student forward for one of its live campus drives only
-- with that student's opt-in for that nomination (decision 10.2 #7). A nomination is a message from
-- the college to its own student: it never creates an application, a snapshot or an employer grant,
-- and no employer route reads this table. Opting in runs the ordinary apply path, and the row then
-- points at the application it produced. Design: docs/architecture/campus-drive-nominations-table-design.md.
-- References only tables created in 0000–0077. Idempotent: every statement is guarded, so a replay
-- (bootstrap, ADR-035) is a no-op.

CREATE TABLE IF NOT EXISTS campus_drive_nominations (
  id uuid PRIMARY KEY,
  campus_drive_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES users(id),
  nominated_by_user_id uuid NOT NULL REFERENCES users(id),
  nominated_by_role text NOT NULL,
  reason_code text NOT NULL,
  note text,
  state text NOT NULL DEFAULT 'INVITED',
  application_id uuid,
  responded_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancel_reason_code text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campus_drive_nominations_drive_fk FOREIGN KEY (campus_drive_id, opportunity_id) REFERENCES campus_drives(id, opportunity_id),
  CONSTRAINT campus_drive_nominations_institution_fk FOREIGN KEY (campus_drive_id, institution_id) REFERENCES campus_drives(id, institution_id),
  CONSTRAINT campus_drive_nominations_application_fk FOREIGN KEY (application_id, opportunity_id) REFERENCES applications(id, opportunity_id),
  CONSTRAINT campus_drive_nominations_state_ck CHECK (state IN ('INVITED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'CANCELLED')),
  CONSTRAINT campus_drive_nominations_role_ck CHECK (nominated_by_role IN ('INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN')),
  CONSTRAINT campus_drive_nominations_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT campus_drive_nominations_cancel_reason_ck CHECK (cancel_reason_code IS NULL OR cancel_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT campus_drive_nominations_note_ck CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  CONSTRAINT campus_drive_nominations_application_ck CHECK ((state IN ('ACCEPTED', 'WITHDRAWN')) = (application_id IS NOT NULL)),
  CONSTRAINT campus_drive_nominations_responded_ck CHECK (state NOT IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN') OR responded_at IS NOT NULL),
  CONSTRAINT campus_drive_nominations_cancelled_ck CHECK (
    (state = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancel_reason_code IS NOT NULL)),
  CONSTRAINT campus_drive_nominations_revision_ck CHECK (revision >= 1)
);

-- One live nomination per drive and student; a cancelled one may be re-issued.
CREATE UNIQUE INDEX IF NOT EXISTS campus_drive_nominations_live_uq
  ON campus_drive_nominations (campus_drive_id, student_user_id) WHERE state <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS campus_drive_nominations_college_idx
  ON campus_drive_nominations (institution_id, campus_drive_id, created_at, id);
CREATE INDEX IF NOT EXISTS campus_drive_nominations_student_idx
  ON campus_drive_nominations (student_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campus_drive_nominations_application_idx
  ON campus_drive_nominations (application_id) WHERE application_id IS NOT NULL;

-- Who nominated whom, for what and why never changes; the state moves only along the consent
-- edges; an application belongs to the nominated student; rows are removed only by the privacy
-- erase of that student (transaction-local setting, as 0060 and 0068 do).
CREATE OR REPLACE FUNCTION campus_drive_nomination_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'campus_drive_nominations rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Every nomination starts as an invitation; only the student's answer moves it.
    IF NEW.state <> 'INVITED' OR NEW.application_id IS NOT NULL OR NEW.responded_at IS NOT NULL THEN
      RAISE EXCEPTION 'a nomination starts as INVITED' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.campus_drive_id <> OLD.campus_drive_id OR NEW.opportunity_id <> OLD.opportunity_id
     OR NEW.institution_id <> OLD.institution_id OR NEW.student_user_id <> OLD.student_user_id
     OR NEW.nominated_by_user_id <> OLD.nominated_by_user_id OR NEW.nominated_by_role <> OLD.nominated_by_role
     OR NEW.reason_code <> OLD.reason_code OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a nomination''s parties, reason and note never change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'INVITED' AND NEW.state IN ('ACCEPTED', 'DECLINED', 'CANCELLED'))
    OR (OLD.state = 'DECLINED' AND NEW.state IN ('ACCEPTED', 'CANCELLED'))
    OR (OLD.state = 'ACCEPTED' AND NEW.state = 'WITHDRAWN')) THEN
    RAISE EXCEPTION 'a nomination cannot move from % to %', OLD.state, NEW.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.application_id IS NOT NULL AND NEW.application_id IS DISTINCT FROM OLD.application_id THEN
    RAISE EXCEPTION 'a nomination''s application never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.application_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM applications a WHERE a.id = NEW.application_id AND a.student_user_id = NEW.student_user_id) THEN
    RAISE EXCEPTION 'a nomination can only point at the nominated student''s application' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campus_drive_nomination_guard' AND tgrelid = to_regclass('campus_drive_nominations')) THEN
    CREATE TRIGGER campus_drive_nomination_guard BEFORE INSERT OR UPDATE OR DELETE ON campus_drive_nominations
      FOR EACH ROW EXECUTE FUNCTION campus_drive_nomination_guard();
  END IF;
END $$;
