-- Membership capabilities: permissions narrower than a role.
--
-- Design circulated in docs/architecture/membership-capabilities-table-design.md.
-- Implements ADR-018, which removed Institution Analyst as a role and replaced it
-- with a capability:
--
--   "Institution Analyst is not a role. Analytics-and-export is a capability grantable
--    to ['INSTITUTION_ADMIN','DEPARTMENT_HEAD'] and to no others."
--
-- canReadInstitutionAnalytics in packages/authorization already takes the flag this
-- table supplies. The decision was made, the predicate was written, and the input had
-- nowhere to come from.
--
-- A table rather than a boolean column on organization_memberships, because a grant
-- needs a grantor, a time, a reason and a revocation -- four more columns for the
-- first capability and four more for the second -- and because "who could see cohort
-- exports in March" is a question a boolean cannot answer.

CREATE TABLE IF NOT EXISTS membership_capabilities (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  capability text NOT NULL,
  granted_by_user_id uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  reason_code text NOT NULL,
  revoked_by_user_id uuid REFERENCES users(id),
  revoked_at timestamptz,
  -- Extended by migration, never by free text. The repository's habit of an enum-like
  -- CHECK over an open column is deliberate and worth keeping.
  CONSTRAINT membership_capability_ck CHECK (capability IN ('INSTITUTION_ANALYTICS')),
  CONSTRAINT membership_capability_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  -- A revoker requires a revocation time, and both appear together or not at all.
  CONSTRAINT membership_capability_revoked_ck CHECK (
    (revoked_by_user_id IS NULL) = (revoked_at IS NULL)),
  CONSTRAINT membership_capability_revoked_order_ck CHECK (
    revoked_at IS NULL OR revoked_at >= granted_at)
);

-- One live grant per capability per membership. Re-granting after revocation adds a
-- row rather than resurrecting one, so the history stays readable.
CREATE UNIQUE INDEX IF NOT EXISTS membership_capability_live_uq
  ON membership_capabilities(membership_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS membership_capability_membership_idx
  ON membership_capabilities(membership_id, granted_at DESC);

-- ---------------------------------------------------------------------------
-- "and to no others"
-- ---------------------------------------------------------------------------
-- The role restriction is the substance of ADR-018, so it is enforced here rather
-- than in whichever controller happens to write the grant. A CHECK cannot reach
-- another table; a trigger can, and 0001 already validates membership roles this way.

CREATE OR REPLACE FUNCTION membership_capability_role_allowed() RETURNS trigger AS $$
DECLARE
  membership_role text;
BEGIN
  SELECT role INTO membership_role FROM organization_memberships WHERE id = NEW.membership_id;
  IF membership_role IS NULL THEN
    RAISE EXCEPTION 'membership does not exist';
  END IF;
  IF NEW.capability = 'INSTITUTION_ANALYTICS'
     AND membership_role NOT IN ('INSTITUTION_ADMIN','DEPARTMENT_HEAD') THEN
    RAISE EXCEPTION 'INSTITUTION_ANALYTICS may be granted only to INSTITUTION_ADMIN or DEPARTMENT_HEAD';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS membership_capability_role_guard ON membership_capabilities;
CREATE TRIGGER membership_capability_role_guard
  BEFORE INSERT OR UPDATE ON membership_capabilities
  FOR EACH ROW EXECUTE FUNCTION membership_capability_role_allowed();

COMMENT ON TABLE membership_capabilities IS
  'Permissions narrower than a role. Scope always comes from the membership, never from the grant.';
