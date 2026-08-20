DO $$ BEGIN
  CREATE TYPE institution_type AS ENUM (
    'UNIVERSITY',
    'ENGINEERING_COLLEGE',
    'ARTS_SCIENCE_COLLEGE',
    'BUSINESS_SCHOOL',
    'POLYTECHNIC',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE roster_student_status AS ENUM ('INVITED','ACTIVE','TRANSFERRED','GRADUATED','ENDED','REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE roster_import_state AS ENUM ('VALIDATED','COMMITTED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE roster_import_row_state AS ENUM ('VALID','WARNING','REJECTED','COMMITTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS organization_profiles (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  display_name text,
  website_url text,
  country_code text NOT NULL,
  state_or_province text,
  city text,
  postal_code text,
  address_line_1 text,
  address_line_2 text,
  primary_contact_email text,
  institution_type institution_type,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_profile_display_name_len_ck CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 160),
  CONSTRAINT organization_profile_website_url_ck CHECK (website_url IS NULL OR (length(website_url) <= 256 AND website_url ~* '^https://[^[:space:]]+$')),
  CONSTRAINT organization_profile_country_code_ck CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT organization_profile_state_len_ck CHECK (state_or_province IS NULL OR length(state_or_province) <= 120),
  CONSTRAINT organization_profile_city_len_ck CHECK (city IS NULL OR length(city) <= 120),
  CONSTRAINT organization_profile_postal_len_ck CHECK (postal_code IS NULL OR length(postal_code) <= 32),
  CONSTRAINT organization_profile_address1_len_ck CHECK (address_line_1 IS NULL OR length(address_line_1) <= 180),
  CONSTRAINT organization_profile_address2_len_ck CHECK (address_line_2 IS NULL OR length(address_line_2) <= 180),
  CONSTRAINT organization_profile_email_ck CHECK (primary_contact_email IS NULL OR (length(primary_contact_email) <= 254 AND primary_contact_email = lower(primary_contact_email) AND primary_contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
);

CREATE INDEX IF NOT EXISTS organization_profiles_country_city_idx ON organization_profiles(country_code, city);

CREATE TABLE IF NOT EXISTS organization_verification_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_state verification_state,
  to_state verification_state NOT NULL,
  reason_code text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_verification_reason_len_ck CHECK (length(reason_code) BETWEEN 3 AND 64 AND reason_code ~ '^[A-Z0-9_:-]+$')
);

CREATE INDEX IF NOT EXISTS organization_verification_events_org_time_idx ON organization_verification_events(organization_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS institution_student_profiles (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  institution_student_id text NOT NULL,
  full_name text NOT NULL,
  department_unit_id uuid,
  program_unit_id uuid,
  batch_unit_id uuid,
  section_unit_id uuid,
  academic_start_date date,
  expected_graduation_date date,
  status roster_student_status NOT NULL DEFAULT 'INVITED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_student_profile_student_id_len_ck CHECK (length(institution_student_id) BETWEEN 1 AND 64),
  CONSTRAINT institution_student_profile_full_name_len_ck CHECK (length(full_name) BETWEEN 1 AND 160),
  CONSTRAINT institution_student_profile_graduation_after_start_ck CHECK (expected_graduation_date IS NULL OR academic_start_date IS NULL OR expected_graduation_date > academic_start_date),
  CONSTRAINT institution_student_profile_status_relationship_ck CHECK (status IN ('INVITED','ACTIVE','TRANSFERRED','GRADUATED','ENDED','REVOKED')),
  CONSTRAINT institution_student_profiles_department_fk FOREIGN KEY (department_unit_id, institution_id) REFERENCES institution_units(id, institution_id),
  CONSTRAINT institution_student_profiles_program_fk FOREIGN KEY (program_unit_id, institution_id) REFERENCES institution_units(id, institution_id),
  CONSTRAINT institution_student_profiles_batch_fk FOREIGN KEY (batch_unit_id, institution_id) REFERENCES institution_units(id, institution_id),
  CONSTRAINT institution_student_profiles_section_fk FOREIGN KEY (section_unit_id, institution_id) REFERENCES institution_units(id, institution_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS institution_student_profiles_student_id_uq ON institution_student_profiles(institution_id, lower(institution_student_id));
CREATE UNIQUE INDEX IF NOT EXISTS institution_student_profiles_user_uq ON institution_student_profiles(institution_id, student_user_id);
CREATE INDEX IF NOT EXISTS institution_student_profiles_units_idx ON institution_student_profiles(institution_id, department_unit_id, program_unit_id, batch_unit_id, section_unit_id);

CREATE TABLE IF NOT EXISTS student_roster_imports (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  state roster_import_state NOT NULL DEFAULT 'VALIDATED',
  source_filename text NOT NULL,
  row_count integer NOT NULL,
  accepted_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  correlation_id text NOT NULL,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_roster_imports_filename_len_ck CHECK (length(source_filename) BETWEEN 1 AND 160),
  CONSTRAINT student_roster_imports_counts_ck CHECK (row_count >= 0 AND accepted_count >= 0 AND warning_count >= 0 AND rejected_count >= 0),
  CONSTRAINT student_roster_imports_committed_ck CHECK ((state = 'COMMITTED' AND committed_at IS NOT NULL) OR (state <> 'COMMITTED' AND committed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS student_roster_imports_institution_time_idx ON student_roster_imports(institution_id, created_at DESC);

CREATE TABLE IF NOT EXISTS student_roster_import_rows (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES student_roster_imports(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  state roster_import_row_state NOT NULL,
  institution_student_id text,
  full_name text,
  email text,
  department text,
  program text,
  batch text,
  section text,
  issues text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_profile_id uuid REFERENCES institution_student_profiles(id),
  CONSTRAINT student_roster_import_rows_row_number_ck CHECK (row_number > 0),
  CONSTRAINT student_roster_import_rows_email_ck CHECK (email IS NULL OR (length(email) <= 254 AND email = lower(email) AND email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
);

CREATE UNIQUE INDEX IF NOT EXISTS student_roster_import_rows_import_row_uq ON student_roster_import_rows(import_id, row_number);

CREATE OR REPLACE FUNCTION enforce_organization_profile_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
  IF org_kind IS NULL OR org_kind NOT IN ('INSTITUTION','EMPLOYER') THEN
    RAISE EXCEPTION 'organization profile must belong to an institution or employer organization';
  END IF;
  IF NEW.institution_type IS NOT NULL AND org_kind <> 'INSTITUTION' THEN
    RAISE EXCEPTION 'institution_type is only valid for institution organizations';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_profiles_scope_guard ON organization_profiles;
CREATE TRIGGER organization_profiles_scope_guard
BEFORE INSERT OR UPDATE ON organization_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_organization_profile_scope();

CREATE OR REPLACE FUNCTION enforce_institution_student_profile_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.institution_id;
  IF org_kind <> 'INSTITUTION' THEN
    RAISE EXCEPTION 'student profile must belong to an institution organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_student_profiles_scope_guard ON institution_student_profiles;
CREATE TRIGGER institution_student_profiles_scope_guard
BEFORE INSERT OR UPDATE ON institution_student_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_institution_student_profile_scope();
