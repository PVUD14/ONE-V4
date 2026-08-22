CREATE TABLE IF NOT EXISTS student_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  target_career text,
  career_interests text[] NOT NULL DEFAULT '{}',
  profile_headline text,
  profile_summary text,
  portfolio_url text,
  visibility_state text NOT NULL DEFAULT 'PRIVATE',
  employer_discovery_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_profiles_target_career_len_ck CHECK (target_career IS NULL OR length(target_career) BETWEEN 1 AND 120),
  CONSTRAINT student_profiles_headline_len_ck CHECK (profile_headline IS NULL OR length(profile_headline) BETWEEN 1 AND 160),
  CONSTRAINT student_profiles_summary_len_ck CHECK (profile_summary IS NULL OR length(profile_summary) <= 2000),
  CONSTRAINT student_profiles_portfolio_url_ck CHECK (portfolio_url IS NULL OR (length(portfolio_url) <= 256 AND portfolio_url ~* '^https://[^[:space:]]+$')),
  CONSTRAINT student_profiles_visibility_ck CHECK (visibility_state IN ('PRIVATE','INSTITUTION_VISIBLE','EMPLOYER_DISCOVERY'))
);

CREATE TABLE IF NOT EXISTS student_document_metadata (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  document_type text NOT NULL,
  description text,
  verification_state text NOT NULL DEFAULT 'SELF_REPORTED',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_document_title_len_ck CHECK (length(title) BETWEEN 1 AND 160),
  CONSTRAINT student_document_type_ck CHECK (document_type IN ('RESUME','CERTIFICATE','TRANSCRIPT','PORTFOLIO','OTHER')),
  CONSTRAINT student_document_description_len_ck CHECK (description IS NULL OR length(description) <= 1000),
  CONSTRAINT student_document_verification_ck CHECK (verification_state IN ('SELF_REPORTED','PENDING_VERIFICATION','VERIFIED','REJECTED')),
  CONSTRAINT student_document_archive_ck CHECK ((archived_at IS NULL) OR archived_at >= created_at)
);
CREATE INDEX IF NOT EXISTS student_document_metadata_student_idx ON student_document_metadata(student_user_id, archived_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS student_saved_opportunities (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  opportunity_ref text NOT NULL,
  title text NOT NULL,
  organization_name text,
  source text NOT NULL DEFAULT 'UAT_REFERENCE',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT student_saved_opportunity_ref_len_ck CHECK (length(opportunity_ref) BETWEEN 1 AND 128 AND opportunity_ref !~ '^[=+@-]'),
  CONSTRAINT student_saved_opportunity_title_len_ck CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '^[=+@-]'),
  CONSTRAINT student_saved_opportunity_org_len_ck CHECK (organization_name IS NULL OR (length(organization_name) <= 200 AND organization_name !~ '^[=+@-]')),
  CONSTRAINT student_saved_opportunity_source_ck CHECK (source IN ('UAT_REFERENCE','CAREER_READINESS_CATALOG','EMPLOYER_GRANT')),
  CONSTRAINT student_saved_opportunity_notes_len_ck CHECK (notes IS NULL OR length(notes) <= 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS student_saved_opportunities_active_ref_uq
  ON student_saved_opportunities(student_user_id, lower(opportunity_ref))
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS student_saved_opportunities_student_idx ON student_saved_opportunities(student_user_id, archived_at, updated_at DESC);
