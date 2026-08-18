ALTER TYPE organization_kind ADD VALUE IF NOT EXISTS 'PLATFORM';

DO $$ BEGIN
  CREATE TYPE verification_state AS ENUM ('PENDING','UNDER_REVIEW','VERIFIED','REJECTED','SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE invitation_state AS ENUM ('PENDING','ACCEPTED','REVOKED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE institution_unit_kind AS ENUM ('INSTITUTION','CAMPUS','DEPARTMENT','PROGRAM','BATCH','SECTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE outbox_delivery_state AS ENUM ('PENDING','PROCESSING','PUBLISHED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE idempotency_status AS ENUM ('STARTED','SUCCEEDED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users ALTER COLUMN external_subject DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DROP INDEX IF EXISTS users_external_subject_uq;
CREATE UNIQUE INDEX IF NOT EXISTS users_external_subject_uq ON users(external_subject) WHERE external_subject IS NOT NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'legal_name'
  ) THEN
    ALTER TABLE organizations RENAME COLUMN name TO legal_name;
  END IF;
END $$;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verification_state verification_state NOT NULL DEFAULT 'PENDING';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS institution_units (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  kind institution_unit_kind NOT NULL,
  name text NOT NULL,
  parent_unit_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_units_id_institution_uq UNIQUE (id, institution_id),
  CONSTRAINT institution_units_parent_same_institution_fk FOREIGN KEY (parent_unit_id, institution_id)
    REFERENCES institution_units(id, institution_id)
);
CREATE INDEX IF NOT EXISTS institution_units_institution_parent_idx ON institution_units(institution_id, parent_unit_id);

ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS scope_organization_id uuid;
UPDATE organization_memberships SET scope_organization_id = organization_id WHERE scope_organization_id IS NULL;
ALTER TABLE organization_memberships ALTER COLUMN scope_organization_id SET NOT NULL;
ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS scope_institution_id uuid;
ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS scope_department_unit_id uuid;
ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS scope_batch_unit_id uuid;
ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS scope_employer_id uuid;
ALTER TABLE organization_memberships ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS organization_memberships_scope_organization_id_fkey;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_scope_organization_id_fkey FOREIGN KEY (scope_organization_id) REFERENCES organizations(id);
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS organization_memberships_scope_institution_id_fkey;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_scope_institution_id_fkey FOREIGN KEY (scope_institution_id) REFERENCES organizations(id);
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS organization_memberships_scope_employer_id_fkey;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_scope_employer_id_fkey FOREIGN KEY (scope_employer_id) REFERENCES organizations(id);
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS membership_scope_org_match_ck;
ALTER TABLE organization_memberships ADD CONSTRAINT membership_scope_org_match_ck CHECK (scope_organization_id = organization_id);
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS membership_department_same_institution_fk;
ALTER TABLE organization_memberships ADD CONSTRAINT membership_department_same_institution_fk FOREIGN KEY (scope_department_unit_id, organization_id)
  REFERENCES institution_units(id, institution_id);
ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS membership_batch_same_institution_fk;
ALTER TABLE organization_memberships ADD CONSTRAINT membership_batch_same_institution_fk FOREIGN KEY (scope_batch_unit_id, organization_id)
  REFERENCES institution_units(id, institution_id);
DROP INDEX IF EXISTS membership_org_user_role_uq;
CREATE UNIQUE INDEX IF NOT EXISTS membership_org_user_role_scope_uq ON organization_memberships(
  organization_id,
  user_id,
  role,
  scope_organization_id,
  coalesce(scope_department_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(scope_batch_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(scope_employer_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE state <> 'ENDED';
CREATE INDEX IF NOT EXISTS membership_active_scope_idx ON organization_memberships(organization_id, user_id, state);

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  token_hash text NOT NULL,
  state invitation_state NOT NULL DEFAULT 'PENDING',
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid REFERENCES organizations(id),
  role text,
  scope_organization_id uuid REFERENCES organizations(id),
  scope_institution_id uuid REFERENCES organizations(id),
  scope_department_unit_id uuid,
  scope_batch_unit_id uuid,
  scope_employer_id uuid REFERENCES organizations(id),
  expires_at timestamptz NOT NULL,
  accepted_by_user_id uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitation_token_hash_length_ck CHECK (length(token_hash) >= 32),
  CONSTRAINT invitation_role_scope_pair_ck CHECK ((role IS NULL AND scope_organization_id IS NULL) OR (role IS NOT NULL AND scope_organization_id IS NOT NULL)),
  CONSTRAINT invitation_consumed_state_ck CHECK ((state = 'ACCEPTED' AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL) OR (state <> 'ACCEPTED' AND accepted_by_user_id IS NULL AND accepted_at IS NULL)),
  CONSTRAINT invitation_department_same_institution_fk FOREIGN KEY (scope_department_unit_id, organization_id)
    REFERENCES institution_units(id, institution_id),
  CONSTRAINT invitation_batch_same_institution_fk FOREIGN KEY (scope_batch_unit_id, organization_id)
    REFERENCES institution_units(id, institution_id)
);
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitation_token_hash_length_ck;
ALTER TABLE invitations ADD CONSTRAINT invitation_token_hash_length_ck CHECK (length(token_hash) >= 32);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_uq ON invitations(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email_org_uq ON invitations(lower(email), coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS invitations_pending_lookup_idx ON invitations(id, state, expires_at);

ALTER TABLE institution_relationships ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS institution_relationship_identity_window_uq ON institution_relationships(institution_id, student_user_id, effective_from);

ALTER TABLE employer_applicant_access_grants ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE employer_applicant_access_grants ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE employer_applicant_access_grants ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE employer_applicant_access_grants DROP CONSTRAINT IF EXISTS employer_applicant_expiry_ck;
ALTER TABLE employer_applicant_access_grants ADD CONSTRAINT employer_applicant_expiry_ck CHECK (expires_at IS NULL OR expires_at > granted_at);
DROP INDEX IF EXISTS employer_applicant_scope_uq;
CREATE UNIQUE INDEX IF NOT EXISTS employer_applicant_active_scope_uq ON employer_applicant_access_grants(employer_id, student_user_id, opportunity_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  organization_id uuid REFERENCES organizations(id),
  outcome text NOT NULL,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_outcome_ck CHECK (outcome IN ('SUCCESS','DENIED'))
);
CREATE INDEX IF NOT EXISTS audit_actor_time_idx ON audit_events(actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_organization_time_idx ON audit_events(organization_id, occurred_at);

ALTER TABLE outbox_events ALTER COLUMN aggregate_id TYPE text USING aggregate_id::text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS event_version integer NOT NULL DEFAULT 1;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS correlation_id text NOT NULL DEFAULT 'system';
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS delivery_state outbox_delivery_state NOT NULL DEFAULT 'PENDING';
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_event_version_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_event_version_ck CHECK (event_version > 0);
ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_attempts_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0);
DROP INDEX IF EXISTS outbox_unpublished_idx;
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events(delivery_state, occurred_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status idempotency_status NOT NULL DEFAULT 'STARTED',
  response_resource_type text,
  response_resource_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_scope_key_uq UNIQUE (scope, key),
  CONSTRAINT idempotency_request_hash_ck CHECK (length(request_hash) >= 32),
  CONSTRAINT idempotency_response_pair_ck CHECK ((response_resource_type IS NULL AND response_resource_id IS NULL) OR (response_resource_type IS NOT NULL AND response_resource_id IS NOT NULL))
);

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

  IF NEW.role = ANY (ARRAY['PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN','SECURITY_ADMIN']) THEN
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
DROP TRIGGER IF EXISTS organization_memberships_scope_guard ON organization_memberships;
CREATE TRIGGER organization_memberships_scope_guard
BEFORE INSERT OR UPDATE ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION enforce_organization_membership_scope();

CREATE OR REPLACE FUNCTION enforce_institution_unit_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.institution_id;
  IF org_kind <> 'INSTITUTION' THEN
    RAISE EXCEPTION 'institution unit must belong to an institution organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS institution_units_scope_guard ON institution_units;
CREATE TRIGGER institution_units_scope_guard
BEFORE INSERT OR UPDATE ON institution_units
FOR EACH ROW EXECUTE FUNCTION enforce_institution_unit_scope();

CREATE OR REPLACE FUNCTION enforce_student_institution_relationship_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.institution_id;
  IF org_kind <> 'INSTITUTION' THEN
    RAISE EXCEPTION 'student institution relationship must reference an institution organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS institution_relationships_scope_guard ON institution_relationships;
CREATE TRIGGER institution_relationships_scope_guard
BEFORE INSERT OR UPDATE ON institution_relationships
FOR EACH ROW EXECUTE FUNCTION enforce_student_institution_relationship_scope();

CREATE OR REPLACE FUNCTION enforce_employer_applicant_grant_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
  SELECT kind INTO org_kind FROM organizations WHERE id = NEW.employer_id;
  IF org_kind <> 'EMPLOYER' THEN
    RAISE EXCEPTION 'employer applicant grant must reference an employer organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS employer_applicant_grants_scope_guard ON employer_applicant_access_grants;
CREATE TRIGGER employer_applicant_grants_scope_guard
BEFORE INSERT OR UPDATE ON employer_applicant_access_grants
FOR EACH ROW EXECUTE FUNCTION enforce_employer_applicant_grant_scope();

CREATE OR REPLACE FUNCTION enforce_invitation_scope()
RETURNS trigger AS $$
DECLARE
  org_kind organization_kind;
BEGIN
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

  IF NEW.role = ANY (ARRAY['PLATFORM_SUPER_ADMIN','OPERATIONS_ADMIN','SECURITY_ADMIN']) THEN
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
DROP TRIGGER IF EXISTS invitations_scope_guard ON invitations;
CREATE TRIGGER invitations_scope_guard
BEFORE INSERT OR UPDATE ON invitations
FOR EACH ROW EXECUTE FUNCTION enforce_invitation_scope();
