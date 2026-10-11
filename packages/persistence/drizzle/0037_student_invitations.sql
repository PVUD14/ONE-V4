-- Student invitations (INST-01). Design: docs/architecture/student-invitations-table-design.md
--
-- A rostered student is created as an INVITED user nobody ever invites, so they cannot sign in.
-- This extends the existing invitations table with a STUDENT kind and delivery state instead of
-- adding a second table with a second accept path. Idempotent: the migrator replays every file.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'STAFF';
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS student_user_id uuid REFERENCES users(id);
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'NOT_SENT';
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS bounced_at timestamptz;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS reason_code text;

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_kind_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_kind_ck CHECK (kind IN ('STAFF', 'STUDENT'));

-- A student invitation grants no membership: it binds one pre-created roster user.
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_student_shape_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_student_shape_ck CHECK (
  (kind = 'STUDENT' AND role IS NULL AND organization_id IS NOT NULL AND student_user_id IS NOT NULL)
  OR (kind = 'STAFF' AND student_user_id IS NULL)
);

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_delivery_state_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_delivery_state_ck
  CHECK (delivery_state IN ('NOT_SENT', 'SENT', 'FAILED', 'BOUNCED', 'NOT_CONFIGURED'));

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_send_count_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_send_count_ck CHECK (send_count >= 0);

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_reason_code_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_reason_code_ck
  CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_:-]{3,64}$');

CREATE INDEX IF NOT EXISTS invitations_student_lookup_idx
  ON invitations(organization_id, student_user_id, created_at DESC) WHERE kind = 'STUDENT';

COMMENT ON COLUMN invitations.kind IS
  'STAFF grants a membership on acceptance; STUDENT binds the pre-created roster user in student_user_id and activates their profile.';
COMMENT ON COLUMN invitations.delivery_state IS
  'Whether the invitation email left ONE. NOT_CONFIGURED: no sender exists yet (production sender is hard gate HG-7). The token is minted at send time, so an unsent invitation has no usable link.';

-- The scope guard from 0001 requires a role on every organisation-scoped invitation, which a
-- student invitation deliberately lacks. Redefined here with a STUDENT branch placed first; the
-- staff logic below it is 0001's, unchanged. A student invitation must name an INSTITUTION, carry
-- no role or unit scope, and point at a user rostered at that institution. The migrator replays
-- every file in order, so this definition always replaces 0001's.
CREATE OR REPLACE FUNCTION enforce_invitation_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  IF NEW.kind = 'STUDENT' THEN
    SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
    IF org_kind IS DISTINCT FROM 'INSTITUTION' THEN
      RAISE EXCEPTION 'student invitation must belong to an institution';
    END IF;
    IF NEW.role IS NOT NULL OR NEW.scope_organization_id IS NOT NULL OR NEW.scope_institution_id IS NOT NULL
       OR NEW.scope_department_unit_id IS NOT NULL OR NEW.scope_batch_unit_id IS NOT NULL OR NEW.scope_employer_id IS NOT NULL THEN
      RAISE EXCEPTION 'student invitation cannot carry a role or scope';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM institution_student_profiles
                   WHERE institution_id = NEW.organization_id AND student_user_id = NEW.student_user_id) THEN
      RAISE EXCEPTION 'student invitation must name a rostered student';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    IF NEW.role IS NOT NULL OR NEW.scope_organization_id IS NOT NULL OR NEW.scope_institution_id IS NOT NULL OR NEW.scope_department_unit_id IS NOT NULL OR NEW.scope_batch_unit_id IS NOT NULL OR NEW.scope_employer_id IS NOT NULL THEN
      RAISE EXCEPTION 'unscoped invitation cannot include role scope';
    END IF;
    RETURN NEW;
  END IF;

  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
  IF org_kind IS NULL THEN
    RAISE EXCEPTION 'invitation organization does not exist';
  END IF;

  IF NEW.role IS NULL OR NEW.scope_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'invitation role scope is incomplete';
  END IF;

  IF NEW.role = ANY (ARRAY['PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN','SECURITY_ADMIN']) THEN
    IF org_kind <> 'PLATFORM' OR NEW.scope_institution_id IS NOT NULL OR NEW.scope_department_unit_id IS NOT NULL OR NEW.scope_batch_unit_id IS NOT NULL OR NEW.scope_employer_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid platform invitation scope';
    END IF;
  ELSIF NEW.role = ANY (ARRAY['INSTITUTION_OWNER','INSTITUTION_ADMIN','PLACEMENT_ADMIN','DEPARTMENT_HEAD','FACULTY_LECTURER']) THEN
    IF org_kind <> 'INSTITUTION' OR NEW.scope_institution_id <> NEW.organization_id OR NEW.scope_employer_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid institution invitation scope';
    END IF;
  ELSIF NEW.role = ANY (ARRAY['EMPLOYER_OWNER','EMPLOYER_ADMIN','RECRUITER']) THEN
    IF org_kind <> 'EMPLOYER' OR NEW.scope_employer_id <> NEW.organization_id OR NEW.scope_institution_id IS NOT NULL OR NEW.scope_department_unit_id IS NOT NULL OR NEW.scope_batch_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid employer invitation scope';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown invitation role';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
