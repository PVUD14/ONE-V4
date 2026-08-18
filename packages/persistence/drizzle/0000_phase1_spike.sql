DO $$ BEGIN
  CREATE TYPE account_state AS ENUM ('INVITED','ACTIVE','SUSPENDED','DELETION_PENDING','DELETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE organization_kind AS ENUM ('INSTITUTION','EMPLOYER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE membership_state AS ENUM ('ACTIVE','SUSPENDED','ENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE relationship_state AS ENUM ('PENDING','VERIFIED','ACTIVE','ENDED','TRANSFERRED','GRADUATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  external_subject text NOT NULL,
  email text NOT NULL,
  state account_state NOT NULL DEFAULT 'INVITED',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_external_subject_uq ON users(external_subject);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users(lower(email));

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  kind organization_kind NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  state membership_state NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_org_user_role_uq ON organization_memberships(organization_id,user_id,role);
CREATE INDEX IF NOT EXISTS membership_user_org_idx ON organization_memberships(user_id,organization_id);

CREATE TABLE IF NOT EXISTS institution_relationships (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  state relationship_state NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_relationship_window_ck CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS institution_relationship_scope_idx ON institution_relationships(institution_id,student_user_id,effective_from,effective_to);

CREATE TABLE IF NOT EXISTS employer_applicant_access_grants (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  opportunity_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT employer_applicant_revocation_ck CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_applicant_scope_uq ON employer_applicant_access_grants(employer_id,student_user_id,opportunity_id);
CREATE INDEX IF NOT EXISTS employer_applicant_lookup_idx ON employer_applicant_access_grants(employer_id,opportunity_id,student_user_id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events(published_at,occurred_at);
