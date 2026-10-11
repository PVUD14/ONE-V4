-- Internal operator capabilities (OPS-01).
--
-- Design: docs/architecture/internal-capabilities-table-design.md
-- Decision: ADR-032 -- internal operator access is granted as capabilities on the
-- three platform roles, not as new login roles.
--
-- Extends membership_capabilities (0031) with the internal vocabulary and its grant
-- rules. 0031 is not edited. The migrator replays every file on every run, so every
-- statement here is idempotent and independent of 0031 being replayed first: the
-- CHECK is dropped and re-added under 0031's own name, and the new rules live in a
-- separate function and trigger so 0031's CREATE OR REPLACE of its own function can
-- never overwrite them.

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------
-- Same constraint name as 0031, so there is one vocabulary and 0031's replay (which
-- skips its CREATE TABLE) cannot bring the narrow set back.
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
  'CAPABILITY_ADMIN', 'APPROVE_HIGH_RISK'
));

-- ---------------------------------------------------------------------------
-- Why a grant ended
-- ---------------------------------------------------------------------------
-- A revocation of internal authority is as audit-worthy as the grant. Nullable:
-- revocations before this migration, and 0031's institution path, carry no reason.
ALTER TABLE membership_capabilities ADD COLUMN IF NOT EXISTS revoked_reason_code text;
ALTER TABLE membership_capabilities DROP CONSTRAINT IF EXISTS membership_capability_revoked_reason_ck;
ALTER TABLE membership_capabilities ADD CONSTRAINT membership_capability_revoked_reason_ck CHECK (
  revoked_reason_code IS NULL
  OR (revoked_at IS NOT NULL AND revoked_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));

-- ---------------------------------------------------------------------------
-- Grant rules for the internal vocabulary
-- ---------------------------------------------------------------------------
-- Enforced here rather than only in the API, as 0031 did for ADR-018: the rules are the
-- substance of ADR-032, and a second writer must not be able to skip them.
--
-- This trigger sorts before 0031's (membership_capability_internal_guard <
-- membership_capability_role_guard) and returns at once for INSTITUTION_ANALYTICS, so
-- 0031's behaviour and messages are unchanged.
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
-- A role change must not carry internal grants across
-- ---------------------------------------------------------------------------
-- The grant trigger validates a grant against the role it was written for and cannot
-- see a later change to the membership. changeMembershipRole revokes first, in the
-- same transaction; this refuses any other writer that forgets to. Scoped to the
-- internal vocabulary so 0031's institution behaviour is untouched.
CREATE OR REPLACE FUNCTION organization_membership_role_change_capability_check() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM membership_capabilities
    WHERE membership_id = NEW.id AND revoked_at IS NULL AND capability <> 'INSTITUTION_ANALYTICS'
  ) THEN
    RAISE EXCEPTION 'revoke internal capabilities before changing the membership role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_membership_role_change_guard ON organization_memberships;
CREATE TRIGGER organization_membership_role_change_guard
  BEFORE UPDATE OF role ON organization_memberships
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION organization_membership_role_change_capability_check();

COMMENT ON COLUMN membership_capabilities.revoked_reason_code IS
  'Why the grant ended. ROLE_CHANGED when revoked by a membership role change.';
