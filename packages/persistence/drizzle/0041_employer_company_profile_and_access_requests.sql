-- EMP-04: the employer's company profile, and the public employer access request.
--
-- Design: docs/architecture/employer-access-requests-table-design.md (read it first).
--
-- 1. organization_profiles gains four employer-only, student-facing columns the employer
--    writes itself. Every column Operations verifies against (legal name lives on
--    organizations; display name, website, address, contact email here) is untouched and
--    stays Operations-only in the API.
-- 2. employer_access_requests quarantines what an anonymous visitor submits. It can never
--    express "verified" and never creates an organisation; an operator links a request to an
--    employer they created through the existing Organizations flow.
-- 3. employer_access_request_attempts counts submissions for rate limiting, holding only a
--    digest of the network address, and is pruned after two days.
--
-- The migrator replays every file on every run, so everything here is idempotent.

ALTER TABLE organization_profiles ADD COLUMN IF NOT EXISTS about_text text;
ALTER TABLE organization_profiles ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE organization_profiles ADD COLUMN IF NOT EXISTS company_size_band text;
ALTER TABLE organization_profiles ADD COLUMN IF NOT EXISTS careers_page_url text;

ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profile_about_len_ck;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profile_about_len_ck
  CHECK (about_text IS NULL OR length(about_text) BETWEEN 1 AND 2000);
ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profile_industry_ck;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profile_industry_ck
  CHECK (industry IS NULL OR industry IN (
    'SOFTWARE_AND_IT_SERVICES','FINANCIAL_SERVICES','MANUFACTURING','ENGINEERING_AND_CONSTRUCTION',
    'HEALTHCARE_AND_LIFE_SCIENCES','CONSULTING_AND_PROFESSIONAL_SERVICES','RETAIL_AND_CONSUMER','EDUCATION',
    'MEDIA_AND_COMMUNICATIONS','ENERGY_AND_UTILITIES','LOGISTICS_AND_TRANSPORT','GOVERNMENT_AND_PUBLIC_SECTOR',
    'NON_PROFIT','OTHER'));
ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profile_size_band_ck;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profile_size_band_ck
  CHECK (company_size_band IS NULL OR company_size_band IN ('1-10','11-50','51-200','201-1000','1001-5000','5001+'));
ALTER TABLE organization_profiles DROP CONSTRAINT IF EXISTS organization_profile_careers_url_ck;
ALTER TABLE organization_profiles ADD CONSTRAINT organization_profile_careers_url_ck
  CHECK (careers_page_url IS NULL OR (length(careers_page_url) <= 256 AND careers_page_url ~* '^https://[^[:space:]]+$'));

-- The company-profile columns belong to employers. The 0005 scope trigger is left as it is;
-- this is a second trigger beside it.
CREATE OR REPLACE FUNCTION enforce_employer_company_profile_fields()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  IF NEW.about_text IS NULL AND NEW.industry IS NULL AND NEW.company_size_band IS NULL AND NEW.careers_page_url IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
  IF org_kind IS DISTINCT FROM 'EMPLOYER' THEN
    RAISE EXCEPTION 'company profile fields are only valid for employer organizations';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_profiles_company_fields_guard ON organization_profiles;
CREATE TRIGGER organization_profiles_company_fields_guard
BEFORE INSERT OR UPDATE ON organization_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_employer_company_profile_fields();

CREATE TABLE IF NOT EXISTS employer_access_requests (
  id uuid PRIMARY KEY,
  requester_name text NOT NULL,
  company_name text NOT NULL,
  work_email text NOT NULL,
  email_domain text NOT NULL,
  website_url text NOT NULL,
  email_matches_website boolean NOT NULL,
  free_mail boolean NOT NULL,
  state text NOT NULL DEFAULT 'PENDING',
  organization_id uuid REFERENCES organizations(id),
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason_code text,
  submission_count integer NOT NULL DEFAULT 1,
  last_submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employer_access_request_name_len_ck CHECK (length(requester_name) BETWEEN 1 AND 120),
  CONSTRAINT employer_access_request_company_len_ck CHECK (length(company_name) BETWEEN 1 AND 180),
  CONSTRAINT employer_access_request_email_ck CHECK (length(work_email) <= 254 AND work_email = lower(work_email)
    AND work_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT employer_access_request_domain_ck CHECK (email_domain = lower(email_domain) AND length(email_domain) BETWEEN 3 AND 253),
  CONSTRAINT employer_access_request_website_ck CHECK (length(website_url) <= 256 AND website_url ~* '^https://[^[:space:]]+$'),
  CONSTRAINT employer_access_request_state_ck CHECK (state IN ('PENDING','ONBOARDED','DECLINED','SPAM')),
  CONSTRAINT employer_access_request_submission_count_ck CHECK (submission_count >= 1),
  CONSTRAINT employer_access_request_reason_ck CHECK (decision_reason_code IS NULL OR decision_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  -- A pending request carries no decision; a decided one carries all of it.
  CONSTRAINT employer_access_request_decision_ck CHECK (
    (state = 'PENDING' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_reason_code IS NULL)
    OR (state <> 'PENDING' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason_code IS NOT NULL)),
  -- Only an onboarded request points at an organisation, and it must.
  CONSTRAINT employer_access_request_organization_ck CHECK (
    (state = 'ONBOARDED' AND organization_id IS NOT NULL) OR (state <> 'ONBOARDED' AND organization_id IS NULL))
);

-- One pending request per address: a repeated submission bumps submission_count instead.
CREATE UNIQUE INDEX IF NOT EXISTS employer_access_requests_pending_email_uq
  ON employer_access_requests(work_email) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS employer_access_requests_state_time_idx
  ON employer_access_requests(state, created_at DESC, id);

-- An onboarded request may only point at an employer.
CREATE OR REPLACE FUNCTION enforce_employer_access_request_organization()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
  IF org_kind IS DISTINCT FROM 'EMPLOYER' THEN
    RAISE EXCEPTION 'an employer access request can only be linked to an employer organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employer_access_requests_organization_guard ON employer_access_requests;
CREATE TRIGGER employer_access_requests_organization_guard
BEFORE INSERT OR UPDATE ON employer_access_requests
FOR EACH ROW EXECUTE FUNCTION enforce_employer_access_request_organization();

CREATE TABLE IF NOT EXISTS employer_access_request_attempts (
  id uuid PRIMARY KEY,
  client_key text NOT NULL,
  email_domain text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employer_access_request_attempt_client_key_ck CHECK (client_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT employer_access_request_attempt_domain_ck CHECK (length(email_domain) BETWEEN 3 AND 253)
);
CREATE INDEX IF NOT EXISTS employer_access_request_attempts_client_time_idx
  ON employer_access_request_attempts(client_key, attempted_at);
CREATE INDEX IF NOT EXISTS employer_access_request_attempts_domain_time_idx
  ON employer_access_request_attempts(email_domain, attempted_at);
CREATE INDEX IF NOT EXISTS employer_access_request_attempts_time_idx
  ON employer_access_request_attempts(attempted_at);

-- Operations may allow public webmail addresses on the request form. Off by default.
INSERT INTO feature_flags (key, description, enabled)
VALUES ('employer-access.allow-free-mail',
        'Accept employer access requests from public webmail addresses (flagged for review). Off: a work email is required.',
        false)
ON CONFLICT (key) DO NOTHING;
