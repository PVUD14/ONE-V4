-- INST-18: a college's data-processing terms, its exit, and the deletion of its records afterwards.
--
-- Design: docs/architecture/institution-contract-lifecycle-design.md (written first).
--
--   institution_data_terms_versions      what the terms said, immutable; the first version is material
--   institution_data_terms_acceptances   which college accepted which version, which owner, when
--   institution_offboardings             one exit: NOTICE -> ENDED -> PURGED, or CANCELLED; the 90-day
--                                        retention clock and the approval that authorised the purge
--   institution_offboarding_changes      each relationship and membership an exit ended, with its prior
--                                        state, so a cancellation restores exactly those
--
-- Plus two changes to earlier machinery, both additive:
--   * INSTITUTION_DATA_PURGE joins the extended approval vocabulary (0051's mechanism). The function
--     repeats every earlier key: 0051, 0057, 0061, 0065, 0081.
--   * The five 0082 guards that refuse DELETE are split into their unchanged INSERT/UPDATE trigger and a
--     DELETE trigger that calls the same, unchanged function unless the transaction-local setting
--     one.institution_purge names the row's college. Only the dual-controlled purge sets it.
--
-- References only tables at or below 0084. Nothing is seeded: publishing terms is an operator's act
-- against a reviewed text (the 0028 and 0084 position). Migrations apply once (ADR-035), but every
-- statement is guarded so a replay converges.

-- ---------------------------------------------------------------------------
-- 1. Data-processing terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_data_terms_versions (
  version text PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  body_sha256 text NOT NULL,
  legal_review_state text NOT NULL,
  legal_review_reference text,
  requires_reacceptance boolean NOT NULL,
  change_summary text,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  correlation_id text NOT NULL
);
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_version_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_version_ck CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_title_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_title_ck CHECK (length(title) BETWEEN 1 AND 200);
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_body_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_body_ck CHECK (length(body) BETWEEN 1 AND 60000);
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_digest_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_digest_ck CHECK (body_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_legal_state_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_legal_state_ck CHECK (legal_review_state IN ('DRAFT_FOR_LEGAL_REVIEW', 'LEGAL_APPROVED'));
-- An approval names who approved it; a draft claims no approval.
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_legal_reference_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_legal_reference_ck CHECK (
  (legal_review_state = 'LEGAL_APPROVED') = (legal_review_reference IS NOT NULL)
  AND (legal_review_reference IS NULL OR length(legal_review_reference) BETWEEN 3 AND 200));
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_change_summary_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_change_summary_ck CHECK (change_summary IS NULL OR length(change_summary) BETWEEN 1 AND 2000);
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_reason_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$');
ALTER TABLE institution_data_terms_versions DROP CONSTRAINT IF EXISTS institution_data_terms_correlation_ck;
ALTER TABLE institution_data_terms_versions ADD CONSTRAINT institution_data_terms_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128);
CREATE INDEX IF NOT EXISTS institution_data_terms_published_idx ON institution_data_terms_versions (published_at DESC, version);
CREATE INDEX IF NOT EXISTS institution_data_terms_material_idx ON institution_data_terms_versions (published_at DESC) WHERE requires_reacceptance;

CREATE TABLE IF NOT EXISTS institution_data_terms_acceptances (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  terms_version text NOT NULL REFERENCES institution_data_terms_versions(version),
  accepted_by_user_id uuid NOT NULL REFERENCES users(id),
  accepted_role text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  CONSTRAINT institution_data_terms_acceptance_once_uq UNIQUE (institution_id, terms_version)
);
ALTER TABLE institution_data_terms_acceptances DROP CONSTRAINT IF EXISTS institution_data_terms_acceptance_role_ck;
ALTER TABLE institution_data_terms_acceptances ADD CONSTRAINT institution_data_terms_acceptance_role_ck CHECK (accepted_role = 'INSTITUTION_OWNER');
ALTER TABLE institution_data_terms_acceptances DROP CONSTRAINT IF EXISTS institution_data_terms_acceptance_correlation_ck;
ALTER TABLE institution_data_terms_acceptances ADD CONSTRAINT institution_data_terms_acceptance_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128);
CREATE INDEX IF NOT EXISTS institution_data_terms_acceptance_institution_idx ON institution_data_terms_acceptances (institution_id, accepted_at DESC);

CREATE OR REPLACE FUNCTION institution_data_terms_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_data_terms_versions_append_only ON institution_data_terms_versions;
CREATE TRIGGER institution_data_terms_versions_append_only BEFORE UPDATE OR DELETE ON institution_data_terms_versions
  FOR EACH ROW EXECUTE FUNCTION institution_data_terms_append_only();
DROP TRIGGER IF EXISTS institution_data_terms_acceptances_append_only ON institution_data_terms_acceptances;
CREATE TRIGGER institution_data_terms_acceptances_append_only BEFORE UPDATE OR DELETE ON institution_data_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION institution_data_terms_append_only();

-- The first version is material; the digest is computed here, from the text actually stored.
CREATE OR REPLACE FUNCTION institution_data_terms_version_guard() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('institution_data_terms_versions'));
  IF NOT NEW.requires_reacceptance AND NOT EXISTS (SELECT 1 FROM institution_data_terms_versions) THEN
    RAISE EXCEPTION 'the first institution data terms version must require acceptance';
  END IF;
  NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
  NEW.published_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_data_terms_version_guard ON institution_data_terms_versions;
CREATE TRIGGER institution_data_terms_version_guard BEFORE INSERT ON institution_data_terms_versions
  FOR EACH ROW EXECUTE FUNCTION institution_data_terms_version_guard();

-- Terms are accepted by, and exits concern, institutions only.
CREATE OR REPLACE FUNCTION institution_contract_institution_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.institution_id AND kind = 'INSTITUTION') THEN
    RAISE EXCEPTION 'institution_id must reference an institution organisation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_data_terms_acceptances_institution_guard ON institution_data_terms_acceptances;
CREATE TRIGGER institution_data_terms_acceptances_institution_guard BEFORE INSERT ON institution_data_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION institution_contract_institution_guard();

-- ---------------------------------------------------------------------------
-- 2. Offboardings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_offboardings (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  state text NOT NULL DEFAULT 'NOTICE',
  notice_at timestamptz NOT NULL DEFAULT now(),
  notice_by_user_id uuid NOT NULL REFERENCES users(id),
  notice_reason_code text NOT NULL,
  ended_at timestamptz,
  ended_by_user_id uuid REFERENCES users(id),
  end_reason_code text,
  retention_ends_at timestamptz,
  was_active boolean,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  cancel_reason_code text,
  purged_at timestamptz,
  purged_by_user_id uuid REFERENCES users(id),
  purge_approval_id uuid REFERENCES operation_approvals(id),
  purge_summary jsonb,
  correlation_id text NOT NULL
);

ALTER TABLE institution_offboardings DROP CONSTRAINT IF EXISTS institution_offboarding_state_ck;
ALTER TABLE institution_offboardings ADD CONSTRAINT institution_offboarding_state_ck CHECK (state IN ('NOTICE', 'ENDED', 'CANCELLED', 'PURGED'));

ALTER TABLE institution_offboardings DROP CONSTRAINT IF EXISTS institution_offboarding_reason_ck;
ALTER TABLE institution_offboardings ADD CONSTRAINT institution_offboarding_reason_ck CHECK (
  notice_reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (end_reason_code IS NULL OR end_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
  AND (cancel_reason_code IS NULL OR cancel_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));

ALTER TABLE institution_offboardings DROP CONSTRAINT IF EXISTS institution_offboarding_correlation_ck;
ALTER TABLE institution_offboardings ADD CONSTRAINT institution_offboarding_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128);

-- Each step's columns are set together, and a step's columns exist exactly when the state says the
-- step happened. The retention clock is 90 days from the end (decision 10.2 #10), on the database clock.
ALTER TABLE institution_offboardings DROP CONSTRAINT IF EXISTS institution_offboarding_shape_ck;
ALTER TABLE institution_offboardings ADD CONSTRAINT institution_offboarding_shape_ck CHECK (
  ((ended_at IS NULL) = (ended_by_user_id IS NULL))
  AND ((ended_at IS NULL) = (end_reason_code IS NULL))
  AND ((ended_at IS NULL) = (retention_ends_at IS NULL))
  AND ((ended_at IS NULL) = (was_active IS NULL))
  AND (ended_at IS NULL OR retention_ends_at = ended_at + interval '90 days')
  AND ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL))
  AND ((cancelled_at IS NULL) = (cancel_reason_code IS NULL))
  AND ((purged_at IS NULL) = (purged_by_user_id IS NULL))
  AND ((purged_at IS NULL) = (purge_approval_id IS NULL))
  AND ((purged_at IS NULL) = (purge_summary IS NULL))
  AND (state <> 'NOTICE' OR (ended_at IS NULL AND cancelled_at IS NULL AND purged_at IS NULL))
  AND (state <> 'ENDED' OR (ended_at IS NOT NULL AND cancelled_at IS NULL AND purged_at IS NULL))
  AND (state <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND purged_at IS NULL))
  AND (state <> 'PURGED' OR (ended_at IS NOT NULL AND purged_at IS NOT NULL AND cancelled_at IS NULL)));

-- One open exit per college.
CREATE UNIQUE INDEX IF NOT EXISTS institution_offboarding_open_uq ON institution_offboardings (institution_id) WHERE state IN ('NOTICE', 'ENDED');
CREATE INDEX IF NOT EXISTS institution_offboarding_institution_idx ON institution_offboardings (institution_id, notice_at DESC);
CREATE INDEX IF NOT EXISTS institution_offboarding_retention_idx ON institution_offboardings (retention_ends_at) WHERE state = 'ENDED';

CREATE OR REPLACE FUNCTION institution_offboarding_guard() RETURNS trigger AS $$
DECLARE
  approval record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'institution offboardings are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'NOTICE' THEN
      RAISE EXCEPTION 'an exit starts with a notice';
    END IF;
    NEW.notice_at := now();
    RETURN NEW;
  END IF;

  -- What an earlier step recorded never changes.
  IF NEW.id <> OLD.id OR NEW.institution_id <> OLD.institution_id OR NEW.notice_at <> OLD.notice_at
     OR NEW.notice_by_user_id <> OLD.notice_by_user_id OR NEW.notice_reason_code <> OLD.notice_reason_code
     OR NEW.correlation_id <> OLD.correlation_id THEN
    RAISE EXCEPTION 'an exit notice cannot be changed';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id
     OR NEW.end_reason_code IS DISTINCT FROM OLD.end_reason_code OR NEW.retention_ends_at IS DISTINCT FROM OLD.retention_ends_at
     OR NEW.was_active IS DISTINCT FROM OLD.was_active) THEN
    RAISE EXCEPTION 'the end of an exit cannot be changed';
  END IF;

  IF OLD.state = 'NOTICE' AND NEW.state = 'ENDED' THEN
    NEW.ended_at := now();
    NEW.retention_ends_at := NEW.ended_at + interval '90 days';
    RETURN NEW;
  END IF;

  IF OLD.state IN ('NOTICE', 'ENDED') AND NEW.state = 'CANCELLED' THEN
    IF OLD.state = 'ENDED' AND now() >= OLD.retention_ends_at THEN
      RAISE EXCEPTION 'an exit cannot be cancelled after its retention period';
    END IF;
    NEW.cancelled_at := now();
    RETURN NEW;
  END IF;

  IF OLD.state = 'ENDED' AND NEW.state = 'PURGED' THEN
    IF now() < OLD.retention_ends_at THEN
      RAISE EXCEPTION 'a college''s records are deleted only after the retention period';
    END IF;
    SELECT state, extended_action_key, target_id INTO approval FROM operation_approvals WHERE id = NEW.purge_approval_id;
    IF NOT FOUND OR approval.state <> 'EXECUTED' OR approval.extended_action_key IS DISTINCT FROM 'INSTITUTION_DATA_PURGE'
       OR approval.target_id <> NEW.id::text THEN
      RAISE EXCEPTION 'a purge needs an executed INSTITUTION_DATA_PURGE approval for this exit';
    END IF;
    NEW.purged_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'institution offboarding: % -> % is not a permitted step', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_offboarding_guard ON institution_offboardings;
CREATE TRIGGER institution_offboarding_guard BEFORE INSERT OR UPDATE OR DELETE ON institution_offboardings
  FOR EACH ROW EXECUTE FUNCTION institution_offboarding_guard();

DROP TRIGGER IF EXISTS institution_offboarding_institution_guard ON institution_offboardings;
CREATE TRIGGER institution_offboarding_institution_guard BEFORE INSERT ON institution_offboardings
  FOR EACH ROW EXECUTE FUNCTION institution_contract_institution_guard();

CREATE TABLE IF NOT EXISTS institution_offboarding_changes (
  offboarding_id uuid NOT NULL REFERENCES institution_offboardings(id),
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  prior_state text NOT NULL,
  prior_profile_status text,
  restored_at timestamptz,
  PRIMARY KEY (offboarding_id, target_kind, target_id)
);
ALTER TABLE institution_offboarding_changes DROP CONSTRAINT IF EXISTS institution_offboarding_change_kind_ck;
ALTER TABLE institution_offboarding_changes ADD CONSTRAINT institution_offboarding_change_kind_ck CHECK (
  (target_kind = 'RELATIONSHIP' AND prior_state IN ('PENDING', 'VERIFIED', 'ACTIVE'))
  OR (target_kind = 'MEMBERSHIP' AND prior_state IN ('ACTIVE', 'SUSPENDED') AND prior_profile_status IS NULL));
CREATE INDEX IF NOT EXISTS institution_offboarding_change_target_idx ON institution_offboarding_changes (target_kind, target_id);

-- Written while the exit ends; restored once, only after the exit is cancelled; never removed.
CREATE OR REPLACE FUNCTION institution_offboarding_change_guard() RETURNS trigger AS $$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'institution offboarding changes are never deleted';
  END IF;
  SELECT state INTO parent_state FROM institution_offboardings WHERE id = NEW.offboarding_id;
  IF TG_OP = 'INSERT' THEN
    IF parent_state IS DISTINCT FROM 'ENDED' OR NEW.restored_at IS NOT NULL THEN
      RAISE EXCEPTION 'changes are recorded only while an exit ends';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.restored_at IS NOT NULL OR NEW.restored_at IS NULL OR parent_state IS DISTINCT FROM 'CANCELLED'
     OR NEW.offboarding_id <> OLD.offboarding_id OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id
     OR NEW.prior_state <> OLD.prior_state OR NEW.prior_profile_status IS DISTINCT FROM OLD.prior_profile_status THEN
    RAISE EXCEPTION 'a change is only ever restored, once, after its exit is cancelled';
  END IF;
  NEW.restored_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_offboarding_change_guard ON institution_offboarding_changes;
CREATE TRIGGER institution_offboarding_change_guard BEFORE INSERT OR UPDATE OR DELETE ON institution_offboarding_changes
  FOR EACH ROW EXECUTE FUNCTION institution_offboarding_change_guard();

COMMENT ON TABLE institution_data_terms_versions IS
  'College data-processing terms, one immutable row per version. DRAFT_FOR_LEGAL_REVIEW text is always labelled as a draft.';
COMMENT ON TABLE institution_data_terms_acceptances IS
  'Which college accepted which data-processing terms version, by which owner and when. Append-only.';
COMMENT ON TABLE institution_offboardings IS
  'A college leaving ONE: notice, end (relationships and staff memberships ended), cancel while the 90-day retention runs, or purge of institution-owned records with an INSTITUTION_DATA_PURGE approval.';
COMMENT ON TABLE institution_offboarding_changes IS
  'Each relationship and staff membership an exit ended, with its prior state, so a cancellation restores exactly those.';

-- ---------------------------------------------------------------------------
-- 3. The approval action for the purge (0051's extension mechanism).
--    Repeat every earlier extended key: 0051, 0057, 0061, 0065, 0081.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_QUESTION_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_LESSON_PUBLISH' THEN 'content_revision'
    WHEN 'COMMS_TEMPLATE_PUBLISH' THEN 'status_notice_template'
    WHEN 'INSTITUTION_DATA_PURGE' THEN 'institution_offboarding'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH; 0065: CONTENT_LESSON_PUBLISH; 0081: COMMS_TEMPLATE_PUBLISH; 0088: INSTITUTION_DATA_PURGE. A later key repeats every earlier one.';

-- ---------------------------------------------------------------------------
-- 4. The purge's one exception to the 0082 delete guards.
--    Each guard is split: INSERT and UPDATE keep the 0082 trigger and function exactly; DELETE calls
--    the same function unless the transaction-local one.institution_purge names the row's college.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION institution_purge_covers(institution uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('one.institution_purge', true) IS NOT NULL
     AND current_setting('one.institution_purge', true) = institution::text
$$;

CREATE OR REPLACE FUNCTION institution_purge_covers_staff_action(action_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM staff_actions a WHERE a.id = action_id AND institution_purge_covers(a.institution_id))
$$;

DROP TRIGGER IF EXISTS learning_assignments_guard ON learning_assignments;
CREATE TRIGGER learning_assignments_guard BEFORE INSERT OR UPDATE ON learning_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_learning_assignment();
DROP TRIGGER IF EXISTS learning_assignments_delete_guard ON learning_assignments;
CREATE TRIGGER learning_assignments_delete_guard BEFORE DELETE ON learning_assignments
  FOR EACH ROW WHEN (NOT institution_purge_covers(OLD.institution_id)) EXECUTE FUNCTION guard_learning_assignment();

DROP TRIGGER IF EXISTS learning_assignment_students_guard ON learning_assignment_students;
CREATE TRIGGER learning_assignment_students_guard BEFORE INSERT OR UPDATE ON learning_assignment_students
  FOR EACH ROW EXECUTE FUNCTION guard_learning_assignment_student();
DROP TRIGGER IF EXISTS learning_assignment_students_delete_guard ON learning_assignment_students;
CREATE TRIGGER learning_assignment_students_delete_guard BEFORE DELETE ON learning_assignment_students
  FOR EACH ROW WHEN (NOT institution_purge_covers(OLD.institution_id)) EXECUTE FUNCTION guard_learning_assignment_student();

DROP TRIGGER IF EXISTS learning_plan_overrides_guard ON learning_plan_overrides;
CREATE TRIGGER learning_plan_overrides_guard BEFORE INSERT OR UPDATE ON learning_plan_overrides
  FOR EACH ROW EXECUTE FUNCTION guard_learning_plan_override();
DROP TRIGGER IF EXISTS learning_plan_overrides_delete_guard ON learning_plan_overrides;
CREATE TRIGGER learning_plan_overrides_delete_guard BEFORE DELETE ON learning_plan_overrides
  FOR EACH ROW WHEN (NOT institution_purge_covers(OLD.institution_id)) EXECUTE FUNCTION guard_learning_plan_override();

DROP TRIGGER IF EXISTS staff_action_attendees_guard ON staff_action_attendees;
CREATE TRIGGER staff_action_attendees_guard BEFORE INSERT OR UPDATE ON staff_action_attendees
  FOR EACH ROW EXECUTE FUNCTION guard_staff_action_attendee();
DROP TRIGGER IF EXISTS staff_action_attendees_delete_guard ON staff_action_attendees;
CREATE TRIGGER staff_action_attendees_delete_guard BEFORE DELETE ON staff_action_attendees
  FOR EACH ROW WHEN (NOT institution_purge_covers(OLD.institution_id)) EXECUTE FUNCTION guard_staff_action_attendee();

DROP TRIGGER IF EXISTS staff_action_content_links_guard ON staff_action_content_links;
CREATE TRIGGER staff_action_content_links_guard BEFORE INSERT OR UPDATE ON staff_action_content_links
  FOR EACH ROW EXECUTE FUNCTION guard_staff_action_content_link();
DROP TRIGGER IF EXISTS staff_action_content_links_delete_guard ON staff_action_content_links;
CREATE TRIGGER staff_action_content_links_delete_guard BEFORE DELETE ON staff_action_content_links
  FOR EACH ROW WHEN (NOT institution_purge_covers_staff_action(OLD.staff_action_id)) EXECUTE FUNCTION guard_staff_action_content_link();
