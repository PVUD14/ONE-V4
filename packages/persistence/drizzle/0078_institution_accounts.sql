-- College account fields (OPS-14): renewal date, contract reference, AI8HT account
-- owner, and the college's own contacts.
--
-- Design: docs/architecture/institution-accounts-table-design.md
--
-- Customer success needs to record when a college's agreement renews, who at AI8HT looks
-- after it and whom to call at the college. These are AI8HT's internal commercial record,
-- kept apart from organization_profiles so no college-facing query can serve them. Billing
-- stays deferred (ADR-022): no amount is stored anywhere here.
--
-- Contacts are personal data. Removing one erases its name, email and phone in the same
-- statement; the trigger allows exactly that change and nothing else, and no row is ever
-- deleted.
--
-- Migrations apply once (ADR-035), but every statement is still guarded so a replay
-- converges: tables if absent, constraints dropped and re-added, functions replaced.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_accounts (
  institution_id uuid PRIMARY KEY REFERENCES organizations(id),
  renewal_date date,
  contract_reference text,
  account_owner_membership_id uuid REFERENCES organization_memberships(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid NOT NULL REFERENCES users(id)
);

ALTER TABLE institution_accounts DROP CONSTRAINT IF EXISTS institution_account_renewal_ck;
ALTER TABLE institution_accounts ADD CONSTRAINT institution_account_renewal_ck CHECK (
  renewal_date IS NULL OR renewal_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31');

-- An identifier for the paper agreement, not a note: no spaces, commas or currency
-- symbols, so an amount cannot be typed into it.
ALTER TABLE institution_accounts DROP CONSTRAINT IF EXISTS institution_account_contract_ck;
ALTER TABLE institution_accounts ADD CONSTRAINT institution_account_contract_ck CHECK (
  contract_reference IS NULL OR contract_reference ~ '^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,63}$');

ALTER TABLE institution_accounts DROP CONSTRAINT IF EXISTS institution_account_version_ck;
ALTER TABLE institution_accounts ADD CONSTRAINT institution_account_version_ck CHECK (version >= 1);

CREATE INDEX IF NOT EXISTS institution_account_renewal_idx ON institution_accounts(renewal_date, institution_id);

CREATE OR REPLACE FUNCTION institution_account_guard() RETURNS trigger AS $$
DECLARE
  org_kind text;
  owner_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'institution accounts are never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.institution_id <> OLD.institution_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'an institution account cannot move to another organisation';
    END IF;
    NEW.updated_at := now();
  ELSE
    NEW.created_at := now();
    NEW.updated_at := now();
  END IF;

  SELECT kind::text INTO org_kind FROM organizations WHERE id = NEW.institution_id;
  IF org_kind IS DISTINCT FROM 'INSTITUTION' THEN
    RAISE EXCEPTION 'account fields may be kept only for an institution';
  END IF;

  -- The owner is checked when set or changed: an ACTIVE internal membership of the ONE
  -- platform organisation. A later end of that membership does not rewrite history; the
  -- account view shows the owner's current state.
  IF NEW.account_owner_membership_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.account_owner_membership_id IS DISTINCT FROM OLD.account_owner_membership_id) THEN
    SELECT EXISTS (
      SELECT 1 FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.id = NEW.account_owner_membership_id
        AND o.kind::text = 'PLATFORM'
        AND m.state::text = 'ACTIVE'
        AND m.role IN ('PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN')
    ) INTO owner_ok;
    IF NOT owner_ok THEN
      RAISE EXCEPTION 'the account owner must be an active member of AI8HT operations';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_account_guard ON institution_accounts;
CREATE TRIGGER institution_account_guard
  BEFORE INSERT OR UPDATE OR DELETE ON institution_accounts
  FOR EACH ROW EXECUTE FUNCTION institution_account_guard();

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_account_contacts (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institution_accounts(institution_id),
  contact_role text NOT NULL,
  full_name text,
  email text,
  phone text,
  added_by_user_id uuid NOT NULL REFERENCES users(id),
  added_reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  removed_reason_code text
);

ALTER TABLE institution_account_contacts DROP CONSTRAINT IF EXISTS institution_account_contact_role_ck;
ALTER TABLE institution_account_contacts ADD CONSTRAINT institution_account_contact_role_ck CHECK (contact_role IN (
  'PRINCIPAL', 'PLACEMENT_OFFICER', 'ACADEMIC_COORDINATOR', 'IT_CONTACT', 'ACCOUNTS', 'OTHER'));

ALTER TABLE institution_account_contacts DROP CONSTRAINT IF EXISTS institution_account_contact_name_ck;
ALTER TABLE institution_account_contacts ADD CONSTRAINT institution_account_contact_name_ck CHECK (
  full_name IS NULL OR length(full_name) BETWEEN 1 AND 120);

ALTER TABLE institution_account_contacts DROP CONSTRAINT IF EXISTS institution_account_contact_email_ck;
ALTER TABLE institution_account_contacts ADD CONSTRAINT institution_account_contact_email_ck CHECK (
  email IS NULL OR (length(email) <= 254 AND email = lower(email) AND email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

ALTER TABLE institution_account_contacts DROP CONSTRAINT IF EXISTS institution_account_contact_phone_ck;
ALTER TABLE institution_account_contacts ADD CONSTRAINT institution_account_contact_phone_ck CHECK (
  phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,24}$');

ALTER TABLE institution_account_contacts DROP CONSTRAINT IF EXISTS institution_account_contact_reason_ck;
ALTER TABLE institution_account_contacts ADD CONSTRAINT institution_account_contact_reason_ck CHECK (
  added_reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (removed_reason_code IS NULL OR removed_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));

-- A live contact is someone reachable; a removed one is nobody at all.
ALTER TABLE institution_account_contacts DROP CONSTRAINT IF EXISTS institution_account_contact_state_ck;
ALTER TABLE institution_account_contacts ADD CONSTRAINT institution_account_contact_state_ck CHECK (
  (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_reason_code IS NULL
     AND full_name IS NOT NULL AND (email IS NOT NULL OR phone IS NOT NULL))
  OR
  (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL AND removed_reason_code IS NOT NULL
     AND full_name IS NULL AND email IS NULL AND phone IS NULL));

CREATE INDEX IF NOT EXISTS institution_account_contact_live_idx
  ON institution_account_contacts(institution_id, created_at) WHERE removed_at IS NULL;

CREATE OR REPLACE FUNCTION institution_account_contact_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'institution account contacts are never deleted; remove them instead';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a contact is added live';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  -- The only update: live -> removed, with the personal fields erased (the state CHECK
  -- enforces the erasure). Everything else stays as it was added.
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed contact cannot be changed';
  END IF;
  IF NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'a contact can only be removed, not edited';
  END IF;
  IF NEW.id <> OLD.id OR NEW.institution_id <> OLD.institution_id OR NEW.contact_role <> OLD.contact_role
     OR NEW.added_by_user_id <> OLD.added_by_user_id OR NEW.added_reason_code <> OLD.added_reason_code
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a contact can only be removed, not edited';
  END IF;
  NEW.removed_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_account_contact_guard ON institution_account_contacts;
CREATE TRIGGER institution_account_contact_guard
  BEFORE INSERT OR UPDATE OR DELETE ON institution_account_contacts
  FOR EACH ROW EXECUTE FUNCTION institution_account_contact_guard();
