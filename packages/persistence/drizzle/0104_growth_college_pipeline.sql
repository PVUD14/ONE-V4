-- Growth college pipeline: handoff requests to operations and the pipeline rules on leads (GROWTH-04).
--
-- Design: docs/architecture/growth-college-pipeline-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §6 and §13.4.
--
-- Growth never creates or verifies an organisation: a college lead may name an organisation only
-- through a handoff request an operator has LINKED, which also records the lead's owner at that
-- moment (the fact attribution is later written from). A lost or handed-off lead's stage never
-- changes again. The pipeline rules are a second trigger on growth_leads beside GROWTH-03's guard;
-- no earlier migration is edited and no earlier function is redefined. Written idempotently.

-- ---------------------------------------------------------------------------
-- 1. Handoff requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_handoff_requests (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_by_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  contract_reference_reported text NOT NULL,
  state text NOT NULL DEFAULT 'REQUESTED',
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decline_reason_code text,
  organization_id uuid REFERENCES organizations(id),
  owner_membership_id_at_link uuid REFERENCES organization_memberships(id),
  owner_user_id_at_link uuid REFERENCES users(id),
  contacts_carried integer,
  contacts_erased integer
);

ALTER TABLE growth_handoff_requests DROP CONSTRAINT IF EXISTS growth_handoff_reference_ck;
ALTER TABLE growth_handoff_requests ADD CONSTRAINT growth_handoff_reference_ck CHECK (
  contract_reference_reported ~ '^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,63}$');
ALTER TABLE growth_handoff_requests DROP CONSTRAINT IF EXISTS growth_handoff_state_ck;
ALTER TABLE growth_handoff_requests ADD CONSTRAINT growth_handoff_state_ck CHECK (
  (state = 'REQUESTED' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decline_reason_code IS NULL
     AND organization_id IS NULL AND owner_membership_id_at_link IS NULL AND owner_user_id_at_link IS NULL
     AND contacts_carried IS NULL AND contacts_erased IS NULL)
  OR (state = 'DECLINED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
     AND decline_reason_code IN ('NOT_A_REAL_COLLEGE', 'DUPLICATE_OF_EXISTING', 'INCOMPLETE', 'CONTRACT_NOT_CONFIRMED')
     AND organization_id IS NULL AND owner_membership_id_at_link IS NULL AND owner_user_id_at_link IS NULL
     AND contacts_carried IS NULL AND contacts_erased IS NULL)
  OR (state = 'LINKED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND decline_reason_code IS NULL
     AND organization_id IS NOT NULL AND (owner_membership_id_at_link IS NULL) = (owner_user_id_at_link IS NULL)
     AND contacts_carried >= 0 AND contacts_erased >= 0));

CREATE UNIQUE INDEX IF NOT EXISTS growth_handoff_open_uq ON growth_handoff_requests (lead_id) WHERE state = 'REQUESTED';
CREATE UNIQUE INDEX IF NOT EXISTS growth_handoff_linked_lead_uq ON growth_handoff_requests (lead_id) WHERE state = 'LINKED';
CREATE UNIQUE INDEX IF NOT EXISTS growth_handoff_linked_org_uq ON growth_handoff_requests (organization_id) WHERE state = 'LINKED';
CREATE INDEX IF NOT EXISTS growth_handoff_queue_idx ON growth_handoff_requests (state, requested_at, id);
CREATE INDEX IF NOT EXISTS growth_handoff_lead_idx ON growth_handoff_requests (lead_id, requested_at DESC);

CREATE OR REPLACE FUNCTION growth_handoff_request_guard() RETURNS trigger AS $$
DECLARE
  lead_row growth_leads%ROWTYPE;
  org_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth handoff requests are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO lead_row FROM growth_leads WHERE id = NEW.lead_id;
    IF lead_row.kind IS DISTINCT FROM 'COLLEGE' THEN
      RAISE EXCEPTION 'a handoff request is for a college lead';
    END IF;
    IF lead_row.do_not_contact_at IS NOT NULL OR lead_row.organization_id IS NOT NULL OR lead_row.stage = 'LOST' THEN
      RAISE EXCEPTION 'a handoff request needs an open, contactable lead';
    END IF;
    IF NEW.state <> 'REQUESTED' THEN
      RAISE EXCEPTION 'a handoff request starts REQUESTED';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.lead_id <> OLD.lead_id OR NEW.requested_by_user_id <> OLD.requested_by_user_id
     OR NEW.requested_by_membership_id <> OLD.requested_by_membership_id OR NEW.requested_at <> OLD.requested_at
     OR NEW.contract_reference_reported <> OLD.contract_reference_reported THEN
    RAISE EXCEPTION 'a handoff request can only be decided';
  END IF;
  IF OLD.state <> 'REQUESTED' OR NEW.state NOT IN ('LINKED', 'DECLINED') THEN
    RAISE EXCEPTION 'a handoff request is decided once';
  END IF;
  IF NEW.state = 'LINKED' THEN
    SELECT kind::text INTO org_kind FROM organizations WHERE id = NEW.organization_id;
    IF org_kind IS DISTINCT FROM 'INSTITUTION' THEN
      RAISE EXCEPTION 'a college lead is linked to an institution';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_handoff_request_guard ON growth_handoff_requests;
CREATE TRIGGER growth_handoff_request_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_handoff_requests
  FOR EACH ROW EXECUTE FUNCTION growth_handoff_request_guard();

COMMENT ON TABLE growth_handoff_requests IS
  'GROWTH-04: a growth person asks operations to onboard a college; an OPS_ORG_MANAGE operator links it to the organisation they created, or declines. Records the lead owner at link (for attribution). Never deleted.';

-- ---------------------------------------------------------------------------
-- 2. The contacts marked for handover
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_handoff_request_contacts (
  request_id uuid NOT NULL REFERENCES growth_handoff_requests(id),
  contact_id uuid NOT NULL REFERENCES growth_lead_contacts(id),
  PRIMARY KEY (request_id, contact_id)
);

CREATE OR REPLACE FUNCTION growth_handoff_request_contact_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'handoff contacts are recorded once and never changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM growth_handoff_requests r JOIN growth_lead_contacts c ON c.lead_id = r.lead_id
    WHERE r.id = NEW.request_id AND r.state = 'REQUESTED' AND c.id = NEW.contact_id AND c.removed_at IS NULL) THEN
    RAISE EXCEPTION 'a handoff contact must be a live contact of the requested lead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_handoff_request_contact_guard ON growth_handoff_request_contacts;
CREATE TRIGGER growth_handoff_request_contact_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_handoff_request_contacts
  FOR EACH ROW EXECUTE FUNCTION growth_handoff_request_contact_guard();

-- ---------------------------------------------------------------------------
-- 3. Pipeline rules on the lead (a second trigger beside GROWTH-03's growth_lead_guard)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_lead_pipeline_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF OLD.stage = 'LOST' THEN
      RAISE EXCEPTION 'a lost lead''s stage never changes';
    END IF;
    IF OLD.organization_id IS NOT NULL THEN
      RAISE EXCEPTION 'a handed-off lead''s stage never changes';
    END IF;
    IF NEW.stage = 'HANDOFF_REQUESTED' AND NOT EXISTS (
      SELECT 1 FROM growth_handoff_requests WHERE lead_id = NEW.id AND state = 'REQUESTED') THEN
      RAISE EXCEPTION 'HANDOFF_REQUESTED needs an open handoff request';
    END IF;
    IF OLD.stage = 'HANDOFF_REQUESTED' AND EXISTS (
      SELECT 1 FROM growth_handoff_requests WHERE lead_id = NEW.id AND state = 'REQUESTED') THEN
      RAISE EXCEPTION 'a lead leaves HANDOFF_REQUESTED only when operations decides the request';
    END IF;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id AND NEW.organization_id IS NOT NULL AND NEW.kind = 'COLLEGE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM growth_handoff_requests WHERE lead_id = NEW.id AND state = 'LINKED' AND organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'a college lead names an organisation only through a linked handoff request';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_lead_pipeline_guard ON growth_leads;
CREATE TRIGGER growth_lead_pipeline_guard BEFORE UPDATE ON growth_leads
  FOR EACH ROW EXECUTE FUNCTION growth_lead_pipeline_guard();
