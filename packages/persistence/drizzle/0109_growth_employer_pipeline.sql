-- Growth employer pipeline: referral codes, the referral and lead links on public employer access
-- requests, and the onboarding record attribution is later written from (GROWTH-05).
--
-- Design: docs/architecture/growth-employer-pipeline-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §7 and §8.3; EMP-04's
-- docs/architecture/employer-access-requests-table-design.md.
--
-- The public form stays EMP-04's: its table, CHECKs and answer are unchanged. A referral and a lead
-- link are rows of their own that go with their request (ON DELETE CASCADE), so EMP-04's retention
-- takes them too. An employer lead names its organisation only through an onboarding record an
-- operator's decision wrote. Every rule is a new function on a new trigger; no earlier migration is
-- edited, no earlier function is redefined, and no capability CHECK, grant trigger or scope trigger
-- is touched. Written idempotently: the migrator replays every file on every run.

-- ---------------------------------------------------------------------------
-- 1. Referral codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_referral_codes (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason_code text,
  revoked_by_user_id uuid REFERENCES users(id)
);

ALTER TABLE growth_referral_codes DROP CONSTRAINT IF EXISTS growth_referral_code_format_ck;
ALTER TABLE growth_referral_codes ADD CONSTRAINT growth_referral_code_format_ck CHECK (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$');
ALTER TABLE growth_referral_codes DROP CONSTRAINT IF EXISTS growth_referral_code_revoked_ck;
ALTER TABLE growth_referral_codes ADD CONSTRAINT growth_referral_code_revoked_ck CHECK (
  (revoked_at IS NULL AND revoked_reason_code IS NULL AND revoked_by_user_id IS NULL)
  OR (revoked_at IS NOT NULL AND (
       (revoked_reason_code = 'OWNER_REVOKED' AND revoked_by_user_id IS NOT NULL)
    OR (revoked_reason_code IN ('OWNER_LEFT', 'LEFT_EMPLOYER_TEAM') AND revoked_by_user_id IS NULL))));

CREATE UNIQUE INDEX IF NOT EXISTS growth_referral_codes_code_uq ON growth_referral_codes (code);
CREATE INDEX IF NOT EXISTS growth_referral_codes_live_idx ON growth_referral_codes (membership_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_referral_codes_user_idx ON growth_referral_codes (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION growth_referral_code_guard() RETURNS trigger AS $$
DECLARE
  member_user uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth referral codes are never deleted; revoke them instead';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a referral code starts live';
    END IF;
    -- One creation at a time per person, so the limits below are exact.
    PERFORM pg_advisory_xact_lock(hashtext('growth_referral_codes:' || NEW.membership_id::text));
    SELECT m.user_id INTO member_user
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN growth_team_members t ON t.membership_id = m.id AND t.left_at IS NULL AND t.team = 'EMPLOYER_PARTNERSHIPS'
    WHERE m.id = NEW.membership_id AND m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER');
    IF member_user IS NULL THEN
      RAISE EXCEPTION 'a referral code belongs to an ACTIVE growth membership on the employer partnerships team';
    END IF;
    IF member_user <> NEW.user_id THEN
      RAISE EXCEPTION 'a referral code''s user is its membership''s user';
    END IF;
    IF (SELECT count(*) FROM growth_referral_codes WHERE membership_id = NEW.membership_id AND revoked_at IS NULL) >= 3 THEN
      RAISE EXCEPTION 'referral code limit: at most 3 live codes';
    END IF;
    IF (SELECT count(*) FROM growth_referral_codes WHERE membership_id = NEW.membership_id AND created_at > now() - interval '24 hours') >= 5 THEN
      RAISE EXCEPTION 'referral code limit: at most 5 codes a day';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked referral code never changes';
  END IF;
  IF NEW.id <> OLD.id OR NEW.code <> OLD.code OR NEW.membership_id <> OLD.membership_id OR NEW.user_id <> OLD.user_id
     OR NEW.created_at <> OLD.created_at OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a referral code can only be revoked, once';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_referral_code_guard ON growth_referral_codes;
CREATE TRIGGER growth_referral_code_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_referral_codes
  FOR EACH ROW EXECUTE FUNCTION growth_referral_code_guard();

COMMENT ON TABLE growth_referral_codes IS
  'GROWTH-05: a growth person''s employer referral codes. Random, no personal data, opens nothing; revoked when the owner leaves or leaves the employer team. Never deleted.';

-- A code stops working when its owner's membership leaves ACTIVE (beside 0100's leaver trigger).
CREATE OR REPLACE FUNCTION growth_referral_codes_owner_left() RETURNS trigger AS $$
BEGIN
  UPDATE growth_referral_codes SET revoked_at = now(), revoked_reason_code = 'OWNER_LEFT'
  WHERE membership_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_referral_codes_owner_left ON organization_memberships;
CREATE TRIGGER growth_referral_codes_owner_left
  AFTER UPDATE OF state ON organization_memberships
  FOR EACH ROW WHEN (OLD.state = 'ACTIVE' AND NEW.state <> 'ACTIVE')
  EXECUTE FUNCTION growth_referral_codes_owner_left();

-- ... and when its owner's employer team row ends with no other live one.
CREATE OR REPLACE FUNCTION growth_referral_codes_team_left() RETURNS trigger AS $$
BEGIN
  IF NEW.team = 'EMPLOYER_PARTNERSHIPS' AND NOT EXISTS (
    SELECT 1 FROM growth_team_members t WHERE t.membership_id = NEW.membership_id AND t.team = 'EMPLOYER_PARTNERSHIPS' AND t.left_at IS NULL) THEN
    UPDATE growth_referral_codes SET revoked_at = now(), revoked_reason_code = 'LEFT_EMPLOYER_TEAM'
    WHERE membership_id = NEW.membership_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_referral_codes_team_left ON growth_team_members;
CREATE TRIGGER growth_referral_codes_team_left
  AFTER UPDATE OF left_at ON growth_team_members
  FOR EACH ROW WHEN (OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
  EXECUTE FUNCTION growth_referral_codes_team_left();

-- ---------------------------------------------------------------------------
-- 2. The referral on a public access request (goes with its request)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employer_access_request_referrals (
  access_request_id uuid PRIMARY KEY REFERENCES employer_access_requests(id) ON DELETE CASCADE,
  referral_code_id uuid NOT NULL REFERENCES growth_referral_codes(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employer_access_request_referrals_code_idx ON employer_access_request_referrals (referral_code_id, created_at);

CREATE OR REPLACE FUNCTION employer_access_request_referral_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only with its request (the cascade runs after the request row is gone).
    IF EXISTS (SELECT 1 FROM employer_access_requests WHERE id = OLD.access_request_id) THEN
      RAISE EXCEPTION 'a referral goes only with its access request';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a referral is recorded once and never changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM employer_access_requests WHERE id = NEW.access_request_id AND state = 'PENDING') THEN
    RAISE EXCEPTION 'a referral is recorded on a pending access request';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM growth_referral_codes c JOIN organization_memberships m ON m.id = c.membership_id
    WHERE c.id = NEW.referral_code_id AND c.revoked_at IS NULL AND m.state = 'ACTIVE') THEN
    RAISE EXCEPTION 'a referral needs a live code of an ACTIVE membership';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employer_access_request_referral_guard ON employer_access_request_referrals;
CREATE TRIGGER employer_access_request_referral_guard BEFORE INSERT OR UPDATE OR DELETE ON employer_access_request_referrals
  FOR EACH ROW EXECUTE FUNCTION employer_access_request_referral_guard();

COMMENT ON TABLE employer_access_request_referrals IS
  'GROWTH-05: the growth referral code an access request arrived with. No personal data; deleted with its request (EMP-04 retention).';

-- ---------------------------------------------------------------------------
-- 3. The employer lead an access request belongs to (goes with its request)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employer_access_request_leads (
  access_request_id uuid PRIMARY KEY REFERENCES employer_access_requests(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  basis text NOT NULL,
  linked_by_user_id uuid REFERENCES users(id),
  linked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employer_access_request_leads DROP CONSTRAINT IF EXISTS employer_access_request_lead_basis_ck;
ALTER TABLE employer_access_request_leads ADD CONSTRAINT employer_access_request_lead_basis_ck CHECK (
  (basis = 'DOMAIN_MATCH' AND linked_by_user_id IS NULL) OR (basis = 'OPERATOR_LINKED' AND linked_by_user_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS employer_access_request_leads_lead_idx ON employer_access_request_leads (lead_id, linked_at);

CREATE OR REPLACE FUNCTION employer_access_request_lead_guard() RETURNS trigger AS $$
DECLARE
  request_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT state INTO request_state FROM employer_access_requests WHERE id = OLD.access_request_id;
    IF request_state IS NOT NULL AND request_state <> 'PENDING' THEN
      RAISE EXCEPTION 'a decided access request keeps its growth lead';
    END IF;
    RETURN OLD;
  END IF;
  SELECT state INTO request_state FROM employer_access_requests WHERE id = NEW.access_request_id;
  IF request_state IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'a growth lead is linked to a pending access request';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.access_request_id <> OLD.access_request_id OR NEW.basis <> 'OPERATOR_LINKED') THEN
    RAISE EXCEPTION 'only an operator moves an access request''s growth lead';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM growth_leads l WHERE l.id = NEW.lead_id AND l.kind = 'EMPLOYER' AND l.stage <> 'LOST'
      AND l.do_not_contact_at IS NULL AND l.organization_id IS NULL) THEN
    RAISE EXCEPTION 'an access request is linked to an open, contactable employer lead';
  END IF;
  NEW.linked_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employer_access_request_lead_guard ON employer_access_request_leads;
CREATE TRIGGER employer_access_request_lead_guard BEFORE INSERT OR UPDATE OR DELETE ON employer_access_request_leads
  FOR EACH ROW EXECUTE FUNCTION employer_access_request_lead_guard();

COMMENT ON TABLE employer_access_request_leads IS
  'GROWTH-05: the employer lead an access request matched (website domain) or an operator linked. Deleted with its request (EMP-04 retention).';

-- ---------------------------------------------------------------------------
-- 4. The onboarding record: who could be credited, as it stood when operations onboarded
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_employer_onboardings (
  access_request_id uuid PRIMARY KEY REFERENCES employer_access_requests(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  lead_id uuid REFERENCES growth_leads(id),
  lead_owner_membership_id uuid REFERENCES organization_memberships(id),
  lead_owner_user_id uuid REFERENCES users(id),
  referral_code_id uuid REFERENCES growth_referral_codes(id),
  referrer_membership_id uuid REFERENCES organization_memberships(id),
  referrer_user_id uuid REFERENCES users(id),
  candidate_basis text NOT NULL,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE growth_employer_onboardings DROP CONSTRAINT IF EXISTS growth_employer_onboarding_parts_ck;
ALTER TABLE growth_employer_onboardings ADD CONSTRAINT growth_employer_onboarding_parts_ck CHECK (
  (lead_owner_membership_id IS NULL) = (lead_owner_user_id IS NULL)
  AND (lead_owner_user_id IS NULL OR lead_id IS NOT NULL)
  AND (referral_code_id IS NULL) = (referrer_membership_id IS NULL)
  AND (referral_code_id IS NULL) = (referrer_user_id IS NULL));
-- Design §8.3, as GROWTH-07 will read it.
ALTER TABLE growth_employer_onboardings DROP CONSTRAINT IF EXISTS growth_employer_onboarding_basis_ck;
ALTER TABLE growth_employer_onboardings ADD CONSTRAINT growth_employer_onboarding_basis_ck CHECK (
  (candidate_basis = 'REFERRAL_LINK' AND referrer_user_id IS NOT NULL AND (lead_owner_user_id IS NULL OR lead_owner_user_id = referrer_user_id))
  OR (candidate_basis = 'LEAD_OWNER_AT_HANDOFF' AND referrer_user_id IS NULL AND lead_owner_user_id IS NOT NULL)
  OR (candidate_basis = 'CONFLICT' AND referrer_user_id IS NOT NULL AND lead_owner_user_id IS NOT NULL AND lead_owner_user_id <> referrer_user_id)
  OR (candidate_basis = 'HOUSE' AND referrer_user_id IS NULL AND lead_owner_user_id IS NULL));
CREATE INDEX IF NOT EXISTS growth_employer_onboardings_org_idx ON growth_employer_onboardings (organization_id, recorded_at);
CREATE INDEX IF NOT EXISTS growth_employer_onboardings_lead_idx ON growth_employer_onboardings (lead_id) WHERE lead_id IS NOT NULL;

CREATE OR REPLACE FUNCTION growth_employer_onboarding_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'an employer onboarding record is written once and never changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM employer_access_requests r JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = NEW.access_request_id AND r.state = 'ONBOARDED' AND r.organization_id = NEW.organization_id AND o.kind = 'EMPLOYER') THEN
    RAISE EXCEPTION 'an employer onboarding record follows an ONBOARDED access request for that employer';
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM growth_leads WHERE id = NEW.lead_id AND kind = 'EMPLOYER') THEN
    RAISE EXCEPTION 'an employer onboarding names an employer lead';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_employer_onboarding_guard ON growth_employer_onboardings;
CREATE TRIGGER growth_employer_onboarding_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_employer_onboardings
  FOR EACH ROW EXECUTE FUNCTION growth_employer_onboarding_guard();

COMMENT ON TABLE growth_employer_onboardings IS
  'GROWTH-05: written when operations onboards an access request: the linked lead and its owner at that moment, the referral and its owner, and the §8.3 credit candidate GROWTH-07 builds attribution from. Never changed or deleted.';

-- ---------------------------------------------------------------------------
-- 5. An employer lead names its organisation only through an onboarding record (the twin of
--    0104's college rule; a third trigger on growth_leads beside 0100's and 0104's)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_lead_employer_org_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'EMPLOYER' AND NEW.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM growth_employer_onboardings WHERE lead_id = NEW.id AND organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'an employer lead names an organisation only through an onboarded access request';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_lead_employer_org_guard ON growth_leads;
CREATE TRIGGER growth_lead_employer_org_guard BEFORE UPDATE ON growth_leads
  FOR EACH ROW EXECUTE FUNCTION growth_lead_employer_org_guard();
