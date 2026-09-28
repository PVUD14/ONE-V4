-- EMP-11: campus drives with placement-office approval, and college placement policies.
--
-- A campus drive is an employer's existing job offered to one college; it reaches that college's
-- students only while the college has approved it (ADR-038). Applications made while a drive is live
-- are linked to it so the college's placement policies apply, and the college's view of results is
-- limited to what students shared. Design: docs/architecture/campus-drives-table-design.md.
-- Idempotent: every statement is guarded, so a replay (bootstrap, ADR-035) is a no-op.

CREATE TABLE IF NOT EXISTS campus_drives (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  opportunity_id uuid NOT NULL,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'REQUESTED',
  proposed_start_at timestamptz,
  proposed_end_at timestamptz,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  venue_mode text,
  employer_note text,
  offer_holders_eligible boolean NOT NULL DEFAULT false,
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason_code text,
  decision_note text,
  closed_by_user_id uuid REFERENCES users(id),
  closed_at timestamptz,
  close_reason_code text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campus_drives_opportunity_employer_fk FOREIGN KEY (opportunity_id, employer_id) REFERENCES opportunities(id, employer_id),
  CONSTRAINT campus_drives_parties_ck CHECK (institution_id <> employer_id),
  CONSTRAINT campus_drives_state_ck CHECK (state IN ('REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'REJECTED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT campus_drives_venue_ck CHECK (venue_mode IS NULL OR venue_mode IN ('ON_CAMPUS', 'VIRTUAL', 'OFF_CAMPUS')),
  CONSTRAINT campus_drives_proposed_order_ck CHECK (proposed_end_at IS NULL OR (proposed_start_at IS NOT NULL AND proposed_end_at > proposed_start_at)),
  CONSTRAINT campus_drives_scheduled_order_ck CHECK (scheduled_end_at IS NULL OR (scheduled_start_at IS NOT NULL AND scheduled_end_at > scheduled_start_at)),
  CONSTRAINT campus_drives_scheduled_ck CHECK (state <> 'SCHEDULED' OR scheduled_start_at IS NOT NULL),
  CONSTRAINT campus_drives_employer_note_ck CHECK (employer_note IS NULL OR length(employer_note) BETWEEN 1 AND 1000),
  CONSTRAINT campus_drives_decision_note_ck CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 1000),
  CONSTRAINT campus_drives_decision_reason_ck CHECK (decision_reason_code IS NULL OR decision_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT campus_drives_close_reason_ck CHECK (close_reason_code IS NULL OR close_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  -- Every state the college produced records who decided and when; a refusal says why.
  CONSTRAINT campus_drives_decision_ck CHECK (
    state NOT IN ('APPROVED', 'SCHEDULED', 'REJECTED', 'CHANGES_REQUESTED')
    OR (decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT campus_drives_refusal_reason_ck CHECK (state NOT IN ('REJECTED', 'CHANGES_REQUESTED') OR decision_reason_code IS NOT NULL),
  CONSTRAINT campus_drives_closed_ck CHECK (
    (state IN ('COMPLETED', 'CANCELLED')) = (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL)),
  CONSTRAINT campus_drives_cancel_reason_ck CHECK (state <> 'CANCELLED' OR close_reason_code IS NOT NULL),
  CONSTRAINT campus_drives_revision_ck CHECK (revision >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS campus_drives_id_opportunity_uq ON campus_drives (id, opportunity_id);
-- One live drive per job and college; a new request is possible after a rejection, cancellation or completion.
CREATE UNIQUE INDEX IF NOT EXISTS campus_drives_live_uq ON campus_drives (opportunity_id, institution_id)
  WHERE state IN ('REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED');
CREATE INDEX IF NOT EXISTS campus_drives_institution_idx ON campus_drives (institution_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS campus_drives_employer_idx ON campus_drives (employer_id, created_at DESC, id DESC);

-- Every state change, append-only.
CREATE TABLE IF NOT EXISTS campus_drive_state_history (
  id uuid PRIMARY KEY,
  campus_drive_id uuid NOT NULL REFERENCES campus_drives(id),
  from_state text,
  to_state text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_side text NOT NULL,
  reason_code text,
  note text,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campus_drive_history_side_ck CHECK (actor_side IN ('EMPLOYER', 'INSTITUTION')),
  CONSTRAINT campus_drive_history_to_state_ck CHECK (to_state IN ('REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'REJECTED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT campus_drive_history_reason_ck CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT campus_drive_history_note_ck CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS campus_drive_history_drive_idx ON campus_drive_state_history (campus_drive_id, created_at, id);

-- A college's placement rules, immutable except retiring.
CREATE TABLE IF NOT EXISTS institution_placement_policies (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  policy_type text NOT NULL,
  allow_drive_exceptions boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  state text NOT NULL DEFAULT 'ACTIVE',
  note text,
  set_by_user_id uuid NOT NULL REFERENCES users(id),
  retired_by_user_id uuid REFERENCES users(id),
  retired_at timestamptz,
  retire_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_placement_policies_type_ck CHECK (policy_type IN ('ONE_OFFER_PER_STUDENT')),
  CONSTRAINT institution_placement_policies_state_ck CHECK (state IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT institution_placement_policies_window_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT institution_placement_policies_note_ck CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  CONSTRAINT institution_placement_policies_retired_ck CHECK (
    (state = 'RETIRED') = (retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL AND retire_reason_code IS NOT NULL)),
  CONSTRAINT institution_placement_policies_reason_ck CHECK (retire_reason_code IS NULL OR retire_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS institution_placement_policies_active_uq
  ON institution_placement_policies (institution_id, policy_type) WHERE state = 'ACTIVE';

-- "This application came through this drive": the college's process governs it. Append-only.
CREATE TABLE IF NOT EXISTS campus_drive_applications (
  campus_drive_id uuid NOT NULL,
  application_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  placement_policy_id uuid REFERENCES institution_placement_policies(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campus_drive_applications_pk PRIMARY KEY (campus_drive_id, application_id),
  CONSTRAINT campus_drive_applications_drive_fk FOREIGN KEY (campus_drive_id, opportunity_id) REFERENCES campus_drives(id, opportunity_id),
  CONSTRAINT campus_drive_applications_application_fk FOREIGN KEY (application_id, opportunity_id) REFERENCES applications(id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS campus_drive_applications_application_idx ON campus_drive_applications (application_id);

-- History and application links are never rewritten or removed.
CREATE OR REPLACE FUNCTION campus_drive_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campus_drive_history_append_only' AND tgrelid = to_regclass('campus_drive_state_history')) THEN
    CREATE TRIGGER campus_drive_history_append_only BEFORE UPDATE OR DELETE ON campus_drive_state_history
      FOR EACH ROW EXECUTE FUNCTION campus_drive_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campus_drive_applications_append_only' AND tgrelid = to_regclass('campus_drive_applications')) THEN
    CREATE TRIGGER campus_drive_applications_append_only BEFORE UPDATE OR DELETE ON campus_drive_applications
      FOR EACH ROW EXECUTE FUNCTION campus_drive_append_only();
  END IF;
END $$;

-- A policy may only be retired, once; it is never deleted or rewritten.
CREATE OR REPLACE FUNCTION institution_placement_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'institution_placement_policies rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'ACTIVE' OR NEW.state <> 'RETIRED'
     OR NEW.id <> OLD.id OR NEW.institution_id <> OLD.institution_id OR NEW.policy_type <> OLD.policy_type
     OR NEW.allow_drive_exceptions <> OLD.allow_drive_exceptions OR NEW.effective_from <> OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.set_by_user_id <> OLD.set_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an institution placement policy can only be retired' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'institution_placement_policy_guard' AND tgrelid = to_regclass('institution_placement_policies')) THEN
    CREATE TRIGGER institution_placement_policy_guard BEFORE UPDATE OR DELETE ON institution_placement_policies
      FOR EACH ROW EXECUTE FUNCTION institution_placement_policy_guard();
  END IF;
END $$;
