-- Growth roles, team members and staff types (GROWTH-01).
--
-- Design: docs/architecture/growth-team-and-staff-types-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §3 and §15; decision ADR-040.
--
-- Lets a growth person exist: the two growth login roles join the platform branch of the
-- membership and invitation scope triggers, the operator-side growth capabilities join the
-- internal vocabulary, and two append-only tables record a growth person's team (and
-- manager) and staff type (employee or contractor). No existing migration is edited: each
-- function is redefined here with CREATE OR REPLACE, every other line repeated unchanged
-- from its latest definition (0001, 0037, 0039). Written idempotently, although the
-- migrator now applies each file once (ADR-035).

-- ---------------------------------------------------------------------------
-- 1. Growth roles in the membership scope trigger (latest: 0001)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_organization_membership_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
  IF org_kind IS NULL THEN
    RAISE EXCEPTION 'organization_membership organization does not exist';
  END IF;

  IF NEW.scope_organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'organization_membership scope organization mismatch';
  END IF;

  IF NEW.role = ANY (ARRAY['PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN','SECURITY_ADMIN','GROWTH_EXECUTIVE','GROWTH_MANAGER']) THEN
    IF org_kind <> 'PLATFORM' OR NEW.scope_institution_id IS NOT NULL OR NEW.scope_department_unit_id IS NOT NULL OR NEW.scope_batch_unit_id IS NOT NULL OR NEW.scope_employer_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid platform role scope';
    END IF;
  ELSIF NEW.role = ANY (ARRAY['INSTITUTION_OWNER','INSTITUTION_ADMIN','PLACEMENT_ADMIN','DEPARTMENT_HEAD','FACULTY_LECTURER']) THEN
    IF org_kind <> 'INSTITUTION' OR NEW.scope_institution_id <> NEW.organization_id OR NEW.scope_employer_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid institution role scope';
    END IF;
  ELSIF NEW.role = ANY (ARRAY['EMPLOYER_OWNER','EMPLOYER_ADMIN','RECRUITER']) THEN
    IF org_kind <> 'EMPLOYER' OR NEW.scope_employer_id <> NEW.organization_id OR NEW.scope_institution_id IS NOT NULL OR NEW.scope_department_unit_id IS NOT NULL OR NEW.scope_batch_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid employer role scope';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown organization role';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. Growth roles in the invitation scope trigger (latest: 0037, student branch first)
-- ---------------------------------------------------------------------------
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

  IF NEW.role = ANY (ARRAY['PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN','SECURITY_ADMIN','GROWTH_EXECUTIVE','GROWTH_MANAGER']) THEN
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

-- A growth invitation carries the person's staff type (D13): the membership, and so the
-- growth_staff_types row, only exists once the invitation is accepted.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS growth_staff_type text;
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_growth_staff_type_value_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_growth_staff_type_value_ck CHECK (
  growth_staff_type IS NULL OR growth_staff_type IN ('EMPLOYEE', 'CONTRACTOR'));
-- A growth invitation must carry a type; no other invitation may. Existing rows carry no
-- growth role and no type, so they satisfy it.
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_growth_staff_type_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_growth_staff_type_ck CHECK (
  (COALESCE(role, '') IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')) = (growth_staff_type IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. Growth capabilities in the internal vocabulary (latest: 0039)
-- ---------------------------------------------------------------------------
ALTER TABLE membership_capabilities DROP CONSTRAINT IF EXISTS membership_capability_ck;
ALTER TABLE membership_capabilities ADD CONSTRAINT membership_capability_ck CHECK (capability IN (
  'INSTITUTION_ANALYTICS',
  'OPS_ORG_MANAGE', 'OPS_VERIFY', 'OPS_FLAGS_MANAGE', 'OPS_JOBS_REPLAY',
  'SUPPORT_CASES', 'SUPPORT_ACCOUNT_LOOKUP',
  'TRUST_SAFETY_INVESTIGATE', 'TRUST_SAFETY_ENFORCE',
  'PRIVACY_REQUESTS', 'PRIVACY_HOLDS',
  'SECURITY_AUDIT_SEARCH', 'SECURITY_ACCESS_REVIEW', 'INCIDENT_MANAGE',
  'CATALOGUE_MANAGE', 'CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH', 'CONTENT_REVIEW_EXTERNAL',
  'AI_OPS_VIEW', 'AI_OPS_CONFIGURE',
  'ANALYTICS_VIEW', 'ACCOUNT_MANAGE', 'COMMS_TEMPLATES',
  'CAPABILITY_ADMIN', 'APPROVE_HIGH_RISK',
  'GROWTH_ADMIN', 'GROWTH_FINANCE'
));

CREATE OR REPLACE FUNCTION membership_capability_internal_allowed() RETURNS trigger AS $$
DECLARE
  membership_role text;
  membership_user uuid;
  org_kind organization_kind;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.capability <> 'INSTITUTION_ANALYTICS' THEN
    -- A grant is a record of a decision. Only its revocation may be written later,
    -- and a revocation is never undone: re-granting adds a new row.
    IF NEW.membership_id <> OLD.membership_id OR NEW.capability <> OLD.capability
       OR NEW.granted_by_user_id <> OLD.granted_by_user_id OR NEW.granted_at <> OLD.granted_at
       OR NEW.reason_code <> OLD.reason_code THEN
      RAISE EXCEPTION 'internal capability grants are immutable except for revocation';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_by_user_id IS DISTINCT FROM OLD.revoked_by_user_id
       OR NEW.revoked_reason_code IS DISTINCT FROM OLD.revoked_reason_code) THEN
      RAISE EXCEPTION 'a revoked internal capability grant cannot be changed';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.capability = 'INSTITUTION_ANALYTICS' THEN
    RETURN NEW;
  END IF;

  SELECT m.role, m.user_id, o.kind INTO membership_role, membership_user, org_kind
  FROM organization_memberships m
  JOIN organizations o ON o.id = m.organization_id
  WHERE m.id = NEW.membership_id;
  IF membership_role IS NULL THEN
    RAISE EXCEPTION 'membership does not exist';
  END IF;

  IF NEW.capability = 'CONTENT_REVIEW_EXTERNAL' THEN
    IF org_kind <> 'INSTITUTION' OR membership_role NOT IN ('FACULTY_LECTURER','DEPARTMENT_HEAD') THEN
      RAISE EXCEPTION 'CONTENT_REVIEW_EXTERNAL may be granted only to an institution FACULTY_LECTURER or DEPARTMENT_HEAD';
    END IF;
  ELSIF NEW.capability IN ('GROWTH_ADMIN','GROWTH_FINANCE') THEN
    -- GROWTH-01 (ADR-040): growth administration and growth finance belong to operations
    -- admins. The super admin holds both by baseline; a security admin's job is access
    -- control. Growth login roles are refused here and by the branch below.
    IF org_kind <> 'PLATFORM' OR membership_role <> 'OPERATIONS_ADMIN' THEN
      RAISE EXCEPTION '% may be granted only to an OPERATIONS_ADMIN membership of the ONE platform organisation', NEW.capability;
    END IF;
  ELSIF org_kind <> 'PLATFORM'
        OR membership_role NOT IN ('PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN','SECURITY_ADMIN') THEN
    RAISE EXCEPTION 'internal capability % may be granted only to a membership of the ONE platform organisation', NEW.capability;
  END IF;

  IF NEW.granted_by_user_id = membership_user THEN
    RAISE EXCEPTION 'an internal capability may not be self-granted';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS membership_capability_internal_guard ON membership_capabilities;
CREATE TRIGGER membership_capability_internal_guard
  BEFORE INSERT OR UPDATE ON membership_capabilities
  FOR EACH ROW EXECUTE FUNCTION membership_capability_internal_allowed();

-- ---------------------------------------------------------------------------
-- 4. growth_team_members: which team a growth person works in, and who they report to
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_team_members (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  team text NOT NULL,
  manager_membership_id uuid REFERENCES organization_memberships(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  joined_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  left_at timestamptz,
  left_by_user_id uuid REFERENCES users(id),
  left_reason_code text
);

ALTER TABLE growth_team_members DROP CONSTRAINT IF EXISTS growth_team_member_team_ck;
ALTER TABLE growth_team_members ADD CONSTRAINT growth_team_member_team_ck CHECK (team IN ('COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS'));
ALTER TABLE growth_team_members DROP CONSTRAINT IF EXISTS growth_team_member_reason_ck;
ALTER TABLE growth_team_members ADD CONSTRAINT growth_team_member_reason_ck CHECK (reason_code ~ '^[A-Z0-9_]{3,64}$');
ALTER TABLE growth_team_members DROP CONSTRAINT IF EXISTS growth_team_member_not_own_manager_ck;
ALTER TABLE growth_team_members ADD CONSTRAINT growth_team_member_not_own_manager_ck CHECK (manager_membership_id IS DISTINCT FROM membership_id);
-- Leaving is recorded once, with its reason. Only the database's own end (the membership
-- ended) has no person behind it.
ALTER TABLE growth_team_members DROP CONSTRAINT IF EXISTS growth_team_member_left_ck;
ALTER TABLE growth_team_members ADD CONSTRAINT growth_team_member_left_ck CHECK (
  (left_at IS NULL AND left_reason_code IS NULL AND left_by_user_id IS NULL)
  OR (left_at IS NOT NULL AND left_at >= joined_at AND left_reason_code ~ '^[A-Z0-9_]{3,64}$'
      AND (left_by_user_id IS NOT NULL OR left_reason_code = 'MEMBERSHIP_ENDED')));

CREATE UNIQUE INDEX IF NOT EXISTS growth_team_members_live_uq ON growth_team_members (membership_id, team) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_team_members_manager_idx ON growth_team_members (manager_membership_id) WHERE left_at IS NULL;

CREATE OR REPLACE FUNCTION growth_team_member_guard() RETURNS trigger AS $$
DECLARE
  member_role text;
  member_state text;
  member_user uuid;
  member_org_kind organization_kind;
  manager_role text;
  manager_state text;
  manager_org_kind organization_kind;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth team rows are never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Append-only: a row is ended once, by setting its three left_* columns, and never
    -- changed again. A change of team or manager is an end plus a new row.
    IF OLD.left_at IS NOT NULL
       OR NEW.id <> OLD.id OR NEW.membership_id <> OLD.membership_id OR NEW.team <> OLD.team
       OR NEW.manager_membership_id IS DISTINCT FROM OLD.manager_membership_id
       OR NEW.joined_at <> OLD.joined_at OR NEW.joined_by_user_id <> OLD.joined_by_user_id
       OR NEW.reason_code <> OLD.reason_code OR NEW.left_at IS NULL THEN
      RAISE EXCEPTION 'growth team rows are append-only: only an end may be recorded, once';
    END IF;
    RETURN NEW;
  END IF;

  SELECT m.role, m.state::text, m.user_id, o.kind INTO member_role, member_state, member_user, member_org_kind
  FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
  WHERE m.id = NEW.membership_id;
  IF member_role IS NULL OR member_role NOT IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
     OR member_org_kind <> 'PLATFORM' OR member_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'growth team rows need an ACTIVE growth membership of the ONE platform organisation';
  END IF;
  IF NEW.joined_by_user_id = member_user THEN
    RAISE EXCEPTION 'a growth person may not set their own team';
  END IF;
  IF NEW.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'a growth team row starts live';
  END IF;

  IF NEW.manager_membership_id IS NOT NULL AND NEW.manager_membership_id <> NEW.membership_id THEN
    SELECT m.role, m.state::text, o.kind INTO manager_role, manager_state, manager_org_kind
    FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.id = NEW.manager_membership_id;
    IF manager_role IS DISTINCT FROM 'GROWTH_MANAGER' OR manager_org_kind <> 'PLATFORM' OR manager_state <> 'ACTIVE' THEN
      RAISE EXCEPTION 'the manager must be an ACTIVE GROWTH_MANAGER of the ONE platform organisation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_team_member_guard ON growth_team_members;
CREATE TRIGGER growth_team_member_guard
  BEFORE INSERT OR UPDATE OR DELETE ON growth_team_members
  FOR EACH ROW EXECUTE FUNCTION growth_team_member_guard();

COMMENT ON TABLE growth_team_members IS
  'GROWTH-01: which growth team a person works in and who they report to. Append-only; a move is an end plus a new row.';

-- ---------------------------------------------------------------------------
-- 5. growth_staff_types: employee or contractor (D13), with history
-- ---------------------------------------------------------------------------
-- No tax column exists here or anywhere in growth: ONE records amounts only (design §3.4).
CREATE TABLE IF NOT EXISTS growth_staff_types (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  staff_type text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  set_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  ended_at timestamptz,
  ended_by_user_id uuid REFERENCES users(id),
  ended_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE growth_staff_types DROP CONSTRAINT IF EXISTS growth_staff_type_value_ck;
ALTER TABLE growth_staff_types ADD CONSTRAINT growth_staff_type_value_ck CHECK (staff_type IN ('EMPLOYEE', 'CONTRACTOR'));
ALTER TABLE growth_staff_types DROP CONSTRAINT IF EXISTS growth_staff_type_reason_ck;
ALTER TABLE growth_staff_types ADD CONSTRAINT growth_staff_type_reason_ck CHECK (reason_code IN ('INITIAL_TYPE', 'ENGAGEMENT_CHANGED', 'CORRECTION'));
ALTER TABLE growth_staff_types DROP CONSTRAINT IF EXISTS growth_staff_type_ended_ck;
ALTER TABLE growth_staff_types ADD CONSTRAINT growth_staff_type_ended_ck CHECK (
  (ended_at IS NULL AND ended_by_user_id IS NULL AND ended_reason_code IS NULL)
  OR (ended_at IS NOT NULL AND ended_at >= effective_from AND ended_by_user_id IS NOT NULL
      AND ended_reason_code IN ('ENGAGEMENT_CHANGED', 'CORRECTION')));

CREATE UNIQUE INDEX IF NOT EXISTS growth_staff_types_live_uq ON growth_staff_types (membership_id) WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION growth_staff_type_guard() RETURNS trigger AS $$
DECLARE
  member_role text;
  member_user uuid;
  member_org_kind organization_kind;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth staff types are never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.ended_at IS NOT NULL
       OR NEW.id <> OLD.id OR NEW.membership_id <> OLD.membership_id OR NEW.staff_type <> OLD.staff_type
       OR NEW.effective_from <> OLD.effective_from OR NEW.set_by_user_id <> OLD.set_by_user_id
       OR NEW.reason_code <> OLD.reason_code OR NEW.created_at <> OLD.created_at OR NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'growth staff types are append-only: only an end may be recorded, once';
    END IF;
    RETURN NEW;
  END IF;

  SELECT m.role, m.user_id, o.kind INTO member_role, member_user, member_org_kind
  FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
  WHERE m.id = NEW.membership_id;
  IF member_role IS NULL OR member_role NOT IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER') OR member_org_kind <> 'PLATFORM' THEN
    RAISE EXCEPTION 'a staff type belongs to a growth membership of the ONE platform organisation';
  END IF;
  IF NEW.set_by_user_id = member_user THEN
    RAISE EXCEPTION 'a growth person may not set their own staff type';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a staff type row starts live';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_staff_type_guard ON growth_staff_types;
CREATE TRIGGER growth_staff_type_guard
  BEFORE INSERT OR UPDATE OR DELETE ON growth_staff_types
  FOR EACH ROW EXECUTE FUNCTION growth_staff_type_guard();

COMMENT ON TABLE growth_staff_types IS
  'GROWTH-01 (D13): whether a growth person is an EMPLOYEE or a CONTRACTOR. Append-only history; no tax is computed or stored.';

-- ---------------------------------------------------------------------------
-- 6. Membership changes that team rows must follow
-- ---------------------------------------------------------------------------
-- A membership that ends ends its live team rows in the same statement, whichever path
-- ended it. A suspension keeps them: it is reversible, and access already stops because
-- only ACTIVE memberships count.
CREATE OR REPLACE FUNCTION growth_team_membership_ended() RETURNS trigger AS $$
BEGIN
  UPDATE growth_team_members SET left_at = now(), left_reason_code = 'MEMBERSHIP_ENDED'
  WHERE membership_id = NEW.id AND left_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_team_membership_ended ON organization_memberships;
CREATE TRIGGER growth_team_membership_ended
  AFTER UPDATE OF state ON organization_memberships
  FOR EACH ROW WHEN (NEW.state = 'ENDED' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION growth_team_membership_ended();

-- A growth membership cannot change role while it is on a team, so a team row never points
-- at a membership that is no longer a growth role.
CREATE OR REPLACE FUNCTION growth_team_role_change_check() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM growth_team_members WHERE membership_id = NEW.id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'end the growth team rows before changing the membership role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_team_role_change_guard ON organization_memberships;
CREATE TRIGGER growth_team_role_change_guard
  BEFORE UPDATE OF role ON organization_memberships
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION growth_team_role_change_check();
