-- Growth lead register, contacts, owner history and stage history (GROWTH-03).
--
-- Design: docs/architecture/growth-leads-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §5 and §13; ADR-040 (D12).
--
-- The lead register holds personal data about people who are not ONE users (the contacts),
-- so the database itself refuses a contact without a permission basis, a removed contact that
-- keeps a name, email or phone, and any deletion. Ownership history is append-only because
-- attribution (GROWTH-07) is decided from it. A growth membership that leaves ACTIVE releases
-- its open leads in the same transaction. No earlier migration is edited and no earlier
-- function is redefined. Written idempotently.

-- ---------------------------------------------------------------------------
-- 1. Leads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_leads (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  name text NOT NULL,
  name_normalized text GENERATED ALWAYS AS (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) STORED,
  state_code text REFERENCES growth_states(code),
  district_code integer REFERENCES growth_districts(lgd_code),
  city text,
  aishe_code text,
  website_domain text,
  owner_membership_id uuid REFERENCES organization_memberships(id),
  stage text NOT NULL DEFAULT 'IDENTIFIED',
  lost_reason_code text,
  source text NOT NULL,
  possible_duplicate boolean NOT NULL DEFAULT false,
  do_not_contact_at timestamptz,
  do_not_contact_reason text,
  do_not_contact_by_user_id uuid REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_kind_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_kind_ck CHECK (kind IN ('COLLEGE', 'EMPLOYER'));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_name_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_name_ck CHECK (length(name) BETWEEN 1 AND 180 AND name !~ '[<>]');
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_city_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_city_ck CHECK (city IS NULL OR (length(city) BETWEEN 1 AND 120 AND city !~ '[<>]'));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_area_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_area_ck CHECK (district_code IS NULL OR state_code IS NOT NULL);
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_aishe_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_aishe_ck CHECK (
  aishe_code IS NULL OR (kind = 'COLLEGE' AND aishe_code ~ '^(C|U|S)-[0-9]{1,8}$'));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_domain_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_domain_ck CHECK (
  website_domain IS NULL OR (length(website_domain) <= 253 AND website_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$'));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_stage_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_stage_ck CHECK (
  (kind = 'COLLEGE' AND stage IN ('IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET', 'PROPOSAL_SHARED', 'NEGOTIATION',
                                  'AGREEMENT_SIGNED_REPORTED', 'HANDOFF_REQUESTED', 'ON_HOLD', 'LOST'))
  OR (kind = 'EMPLOYER' AND stage IN ('IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET', 'INTERESTED',
                                      'ACCESS_REQUEST_INVITED', 'ON_HOLD', 'LOST')));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_lost_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_lost_ck CHECK (
  (stage = 'LOST') = (lost_reason_code IS NOT NULL)
  AND (lost_reason_code IS NULL OR lost_reason_code IN ('NO_BUDGET', 'CHOSE_COMPETITOR', 'NOT_DECISION_MAKER', 'NO_RESPONSE', 'NOT_ELIGIBLE', 'DUPLICATE', 'OTHER')));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_source_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_source_ck CHECK (source IN (
  'FIELD_VISIT', 'REFERRAL_LINK', 'INBOUND_ACCESS_REQUEST', 'EVENT', 'PUBLIC_DIRECTORY', 'INTRODUCTION', 'OTHER'));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_dnc_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_dnc_ck CHECK (
  (do_not_contact_at IS NULL AND do_not_contact_reason IS NULL AND do_not_contact_by_user_id IS NULL)
  OR (do_not_contact_at IS NOT NULL AND do_not_contact_by_user_id IS NOT NULL
      AND do_not_contact_reason IN ('ORGANISATION_DECLINED', 'PERSON_REQUEST', 'PRIVACY_REQUEST', 'LEGAL')));
ALTER TABLE growth_leads DROP CONSTRAINT IF EXISTS growth_lead_version_ck;
ALTER TABLE growth_leads ADD CONSTRAINT growth_lead_version_ck CHECK (version >= 1);

-- Design §5.3: one live lead per AISHE code (colleges) and per website domain (employers). A lead
-- is live unless it is LOST without do-not-contact.
CREATE UNIQUE INDEX IF NOT EXISTS growth_leads_live_aishe_uq ON growth_leads (aishe_code)
  WHERE aishe_code IS NOT NULL AND (stage <> 'LOST' OR do_not_contact_at IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS growth_leads_live_domain_uq ON growth_leads (website_domain)
  WHERE website_domain IS NOT NULL AND kind = 'EMPLOYER' AND (stage <> 'LOST' OR do_not_contact_at IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS growth_leads_organization_uq ON growth_leads (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_leads_owner_idx ON growth_leads (owner_membership_id, created_at DESC);
CREATE INDEX IF NOT EXISTS growth_leads_area_idx ON growth_leads (state_code, district_code);
CREATE INDEX IF NOT EXISTS growth_leads_kind_created_idx ON growth_leads (kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS growth_leads_name_idx ON growth_leads (kind, name_normalized, district_code);
CREATE INDEX IF NOT EXISTS growth_leads_activity_idx ON growth_leads (last_activity_at) WHERE organization_id IS NULL;

-- Owner rule: an ACTIVE growth membership of the platform with a live team row for the lead's kind.
CREATE OR REPLACE FUNCTION growth_lead_owner_allowed(lead_kind text, membership uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL
      AND t.team = CASE lead_kind WHEN 'COLLEGE' THEN 'COLLEGE_PARTNERSHIPS' ELSE 'EMPLOYER_PARTNERSHIPS' END
    WHERE m.id = membership AND m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER'));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION growth_lead_guard() RETURNS trigger AS $$
DECLARE
  district_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth leads are never deleted';
  END IF;

  IF NEW.district_code IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.district_code IS DISTINCT FROM OLD.district_code OR NEW.state_code IS DISTINCT FROM OLD.state_code) THEN
    SELECT state_code INTO district_state FROM growth_districts WHERE lgd_code = NEW.district_code;
    IF district_state IS DISTINCT FROM NEW.state_code THEN
      RAISE EXCEPTION 'the lead''s district does not belong to its state';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.do_not_contact_at IS NOT NULL OR NEW.organization_id IS NOT NULL THEN
      RAISE EXCEPTION 'a growth lead starts open and contactable';
    END IF;
    IF NEW.owner_membership_id IS NOT NULL AND NOT growth_lead_owner_allowed(NEW.kind, NEW.owner_membership_id) THEN
      RAISE EXCEPTION 'growth lead owner must be an ACTIVE growth membership on the matching team';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.last_activity_at := now();
    NEW.version := 1;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a growth lead''s kind, creator and creation time never change';
  END IF;
  IF OLD.do_not_contact_at IS NOT NULL AND (NEW.do_not_contact_at IS DISTINCT FROM OLD.do_not_contact_at
     OR NEW.do_not_contact_reason IS DISTINCT FROM OLD.do_not_contact_reason OR NEW.do_not_contact_by_user_id IS DISTINCT FROM OLD.do_not_contact_by_user_id) THEN
    RAISE EXCEPTION 'do-not-contact is set once and never cleared';
  END IF;
  IF OLD.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'a growth lead''s organisation is set once';
  END IF;
  IF NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id THEN
    IF NEW.owner_membership_id IS NOT NULL THEN
      IF OLD.do_not_contact_at IS NOT NULL OR NEW.do_not_contact_at IS NOT NULL THEN
        RAISE EXCEPTION 'a do-not-contact lead cannot be claimed or reassigned';
      END IF;
      IF NOT growth_lead_owner_allowed(NEW.kind, NEW.owner_membership_id) THEN
        RAISE EXCEPTION 'growth lead owner must be an ACTIVE growth membership on the matching team';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_lead_guard ON growth_leads;
CREATE TRIGGER growth_lead_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_leads
  FOR EACH ROW EXECUTE FUNCTION growth_lead_guard();

COMMENT ON TABLE growth_leads IS
  'GROWTH-03: prospective colleges and employers. Organisation-level only; people are in growth_lead_contacts. Never deleted.';

-- ---------------------------------------------------------------------------
-- 2. Contacts: personal data of people who are not ONE users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_lead_contacts (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  contact_role text NOT NULL,
  full_name text,
  email text,
  phone text,
  phone_digits text GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) STORED,
  permission_basis text NOT NULL,
  source text NOT NULL,
  notice_given_at timestamptz,
  notice_version text,
  notice_recorded_by_user_id uuid REFERENCES users(id),
  added_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  removed_reason_code text
);

ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_role_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_role_ck CHECK (contact_role IN (
  'PRINCIPAL', 'DIRECTOR', 'CHAIRMAN_OR_TRUSTEE', 'PLACEMENT_OFFICER', 'HR', 'TALENT_ACQUISITION', 'FOUNDER', 'OTHER'));
ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_name_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_name_ck CHECK (
  full_name IS NULL OR (length(full_name) BETWEEN 1 AND 120 AND full_name !~ '[<>]'));
ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_email_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_email_ck CHECK (
  email IS NULL OR (length(email) <= 254 AND email = lower(email) AND email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_phone_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_phone_ck CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,24}$');
-- Design §13.2 (O-21 interim rule): only these three bases, and the source must agree with the basis.
ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_basis_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_basis_ck CHECK (
  (permission_basis = 'PROVIDED_BY_PERSON' AND source IN ('BUSINESS_CARD', 'MEETING', 'EMAIL_FROM_PERSON', 'ACCESS_REQUEST_FORM'))
  OR (permission_basis = 'PUBLIC_INSTITUTIONAL_LISTING' AND source = 'OFFICIAL_WEBSITE')
  OR (permission_basis = 'INTRODUCED_BY_COLLEAGUE' AND source = 'COLLEAGUE_INTRODUCTION'));
ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_notice_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_notice_ck CHECK (
  (notice_given_at IS NULL AND notice_version IS NULL AND notice_recorded_by_user_id IS NULL)
  OR (notice_given_at IS NOT NULL AND notice_recorded_by_user_id IS NOT NULL AND notice_version ~ '^[a-z0-9.-]{3,40}$'));
-- Acceptance: a live contact is someone reachable; a removed one keeps no name, email or phone.
ALTER TABLE growth_lead_contacts DROP CONSTRAINT IF EXISTS growth_lead_contact_state_ck;
ALTER TABLE growth_lead_contacts ADD CONSTRAINT growth_lead_contact_state_ck CHECK (
  (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_reason_code IS NULL
     AND full_name IS NOT NULL AND (email IS NOT NULL OR phone IS NOT NULL))
  OR
  (removed_at IS NOT NULL AND full_name IS NULL AND email IS NULL AND phone IS NULL
     AND removed_reason_code IN ('OWNER_REMOVED', 'WRONG_DETAILS', 'LEFT_ORGANISATION', 'PRIVACY_REQUEST', 'RETENTION_EXPIRED', 'HANDED_OVER')
     AND (removed_by_user_id IS NOT NULL OR removed_reason_code = 'RETENTION_EXPIRED')));

CREATE INDEX IF NOT EXISTS growth_lead_contacts_lead_idx ON growth_lead_contacts (lead_id, created_at) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_lead_contacts_email_idx ON growth_lead_contacts (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_lead_contacts_phone_idx ON growth_lead_contacts (phone_digits) WHERE phone IS NOT NULL;

CREATE OR REPLACE FUNCTION growth_lead_contact_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth lead contacts are never deleted; remove them instead';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a contact is added live';
    END IF;
    IF EXISTS (SELECT 1 FROM growth_leads WHERE id = NEW.lead_id AND do_not_contact_at IS NOT NULL) THEN
      RAISE EXCEPTION 'growth lead is do-not-contact: no contact may be added';
    END IF;
    NEW.created_at := now();
    IF NEW.notice_given_at IS NOT NULL THEN
      NEW.notice_given_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed contact cannot be changed';
  END IF;
  IF NEW.id <> OLD.id OR NEW.lead_id <> OLD.lead_id OR NEW.contact_role <> OLD.contact_role
     OR NEW.permission_basis <> OLD.permission_basis OR NEW.source <> OLD.source
     OR NEW.added_by_user_id <> OLD.added_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a contact can only have its notice recorded or be removed';
  END IF;
  IF NEW.removed_at IS NULL THEN
    -- The only live update: recording the notice, once.
    IF OLD.notice_given_at IS NOT NULL OR NEW.notice_given_at IS NULL
       OR NEW.full_name IS DISTINCT FROM OLD.full_name OR NEW.email IS DISTINCT FROM OLD.email OR NEW.phone IS DISTINCT FROM OLD.phone THEN
      RAISE EXCEPTION 'a contact can only have its notice recorded or be removed';
    END IF;
    NEW.notice_given_at := now();
    RETURN NEW;
  END IF;
  IF NEW.notice_given_at IS DISTINCT FROM OLD.notice_given_at OR NEW.notice_version IS DISTINCT FROM OLD.notice_version THEN
    RAISE EXCEPTION 'a contact can only have its notice recorded or be removed';
  END IF;
  NEW.removed_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_lead_contact_guard ON growth_lead_contacts;
CREATE TRIGGER growth_lead_contact_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_lead_contacts
  FOR EACH ROW EXECUTE FUNCTION growth_lead_contact_guard();

COMMENT ON TABLE growth_lead_contacts IS
  'GROWTH-03: people at a prospective organisation, who are not ONE users. Basis required; removal erases name, email and phone; retained at most 24 months after the lead''s last activity (D12). Never deleted.';

-- ---------------------------------------------------------------------------
-- 3. Owner and stage history (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_lead_owner_history (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  from_membership_id uuid REFERENCES organization_memberships(id),
  to_membership_id uuid REFERENCES organization_memberships(id),
  reason_code text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE growth_lead_owner_history DROP CONSTRAINT IF EXISTS growth_lead_owner_history_ck;
ALTER TABLE growth_lead_owner_history ADD CONSTRAINT growth_lead_owner_history_ck CHECK (
  reason_code IN ('CREATED', 'CLAIMED', 'TERRITORY_CHANGE', 'WORKLOAD', 'OWNER_LEFT', 'DISPUTE_DECISION', 'INACTIVITY', 'CORRECTION')
  AND from_membership_id IS DISTINCT FROM to_membership_id
  AND (actor_user_id IS NOT NULL OR reason_code = 'OWNER_LEFT'));
CREATE INDEX IF NOT EXISTS growth_lead_owner_history_lead_idx ON growth_lead_owner_history (lead_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS growth_lead_stage_history (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  from_stage text,
  to_stage text NOT NULL,
  reason_code text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE growth_lead_stage_history DROP CONSTRAINT IF EXISTS growth_lead_stage_history_ck;
ALTER TABLE growth_lead_stage_history ADD CONSTRAINT growth_lead_stage_history_ck CHECK (
  to_stage ~ '^[A-Z_]{3,40}$' AND (from_stage IS NULL OR from_stage ~ '^[A-Z_]{3,40}$')
  AND from_stage IS DISTINCT FROM to_stage AND (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{3,64}$'));
CREATE INDEX IF NOT EXISTS growth_lead_stage_history_lead_idx ON growth_lead_stage_history (lead_id, occurred_at, id);

CREATE OR REPLACE FUNCTION growth_lead_history_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'growth lead history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_lead_owner_history_guard ON growth_lead_owner_history;
CREATE TRIGGER growth_lead_owner_history_guard BEFORE UPDATE OR DELETE ON growth_lead_owner_history
  FOR EACH ROW EXECUTE FUNCTION growth_lead_history_guard();
DROP TRIGGER IF EXISTS growth_lead_stage_history_guard ON growth_lead_stage_history;
CREATE TRIGGER growth_lead_stage_history_guard BEFORE UPDATE OR DELETE ON growth_lead_stage_history
  FOR EACH ROW EXECUTE FUNCTION growth_lead_history_guard();

-- ---------------------------------------------------------------------------
-- 4. The leaver rule (design §5.4): a growth membership that leaves ACTIVE releases its open
--    leads in the same transaction. Converted and lost leads keep their owner.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_lead_owner_left() RETURNS trigger AS $$
BEGIN
  INSERT INTO growth_lead_owner_history (id, lead_id, from_membership_id, to_membership_id, reason_code, actor_user_id)
  SELECT gen_random_uuid(), l.id, NEW.id, NULL, 'OWNER_LEFT', NULL
  FROM growth_leads l
  WHERE l.owner_membership_id = NEW.id AND l.organization_id IS NULL AND l.stage <> 'LOST';
  UPDATE growth_leads SET owner_membership_id = NULL
  WHERE owner_membership_id = NEW.id AND organization_id IS NULL AND stage <> 'LOST';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_lead_owner_left ON organization_memberships;
CREATE TRIGGER growth_lead_owner_left
  AFTER UPDATE OF state ON organization_memberships
  FOR EACH ROW WHEN (OLD.state = 'ACTIVE' AND NEW.state <> 'ACTIVE')
  EXECUTE FUNCTION growth_lead_owner_left();
