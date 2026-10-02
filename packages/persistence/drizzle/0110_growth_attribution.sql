-- Growth attribution: who is credited for a college or an employer, the disputes about it, the
-- leave dates of growth staff, and the self-dealing guard on verification (GROWTH-07).
--
-- Design: docs/architecture/growth-attribution-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §8 (and §10, §15); GROWTH-04's
-- growth_handoff_requests (0104) and GROWTH-05's growth_employer_onboardings (0109) are the facts
-- attribution is written from.
--
-- A change of credit is an end plus a new row, so "who was credited on a date" is always answerable.
-- Nobody credits themselves, decides their own dispute or verifies an organisation credited to
-- them: those are CHECKs and triggers on the user id, whatever membership they act through. Every
-- rule is a new function on a new trigger; no earlier migration is edited, no earlier function is
-- redefined, and no capability CHECK, grant trigger, scope trigger or OPS-02 action vocabulary is
-- touched. Written idempotently: the migrator replays every file on every run.

-- ---------------------------------------------------------------------------
-- 1. Attributions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_attributions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  organization_kind text NOT NULL,
  beneficiary_user_id uuid NOT NULL REFERENCES users(id),
  basis text NOT NULL,
  reason_code text NOT NULL,
  lead_id uuid REFERENCES growth_leads(id),
  source_handoff_request_id uuid REFERENCES growth_handoff_requests(id),
  source_access_request_id uuid REFERENCES growth_employer_onboardings(access_request_id),
  dispute_id uuid,
  supersedes_id uuid REFERENCES growth_attributions(id),
  effective_from timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason_code text,
  ended_by_user_id uuid REFERENCES users(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE growth_attributions DROP CONSTRAINT IF EXISTS growth_attribution_kind_ck;
ALTER TABLE growth_attributions ADD CONSTRAINT growth_attribution_kind_ck CHECK (organization_kind IN ('INSTITUTION', 'EMPLOYER'));
ALTER TABLE growth_attributions DROP CONSTRAINT IF EXISTS growth_attribution_basis_ck;
ALTER TABLE growth_attributions ADD CONSTRAINT growth_attribution_basis_ck CHECK (
  (basis = 'LEAD_OWNER_AT_HANDOFF' AND dispute_id IS NULL AND supersedes_id IS NULL AND (
     (organization_kind = 'INSTITUTION' AND reason_code = 'COLLEGE_HANDOFF_LINKED' AND source_handoff_request_id IS NOT NULL AND source_access_request_id IS NULL)
     OR (organization_kind = 'EMPLOYER' AND reason_code = 'EMPLOYER_ONBOARDED' AND source_access_request_id IS NOT NULL AND source_handoff_request_id IS NULL)))
  OR (basis = 'REFERRAL_LINK' AND organization_kind = 'EMPLOYER' AND reason_code = 'EMPLOYER_ONBOARDED'
     AND source_access_request_id IS NOT NULL AND source_handoff_request_id IS NULL AND dispute_id IS NULL AND supersedes_id IS NULL)
  OR (basis = 'DISPUTE_DECISION' AND reason_code = 'DISPUTE_DECIDED' AND dispute_id IS NOT NULL
     AND source_handoff_request_id IS NULL AND source_access_request_id IS NULL)
  OR (basis = 'MANUAL_CORRECTION' AND reason_code IN ('BENEFICIARY_LEFT', 'WRONG_PERSON_CREDITED', 'TEAM_CHANGE', 'CORRECTION')
     AND supersedes_id IS NOT NULL AND dispute_id IS NULL AND source_handoff_request_id IS NULL AND source_access_request_id IS NULL));
ALTER TABLE growth_attributions DROP CONSTRAINT IF EXISTS growth_attribution_ended_ck;
ALTER TABLE growth_attributions ADD CONSTRAINT growth_attribution_ended_ck CHECK (
  (ended_at IS NULL AND ended_reason_code IS NULL AND ended_by_user_id IS NULL)
  OR (ended_at IS NOT NULL AND ended_by_user_id IS NOT NULL
      AND ended_reason_code IN ('REASSIGNED', 'DISPUTE_DECISION', 'CORRECTION', 'ORGANIZATION_EXITED')));
-- Self-dealing (design §8.6): nobody credits themselves, or moves credit away from themselves.
ALTER TABLE growth_attributions DROP CONSTRAINT IF EXISTS growth_attribution_self_ck;
ALTER TABLE growth_attributions ADD CONSTRAINT growth_attribution_self_ck CHECK (
  created_by_user_id <> beneficiary_user_id
  AND (ended_by_user_id IS NULL OR ended_by_user_id <> beneficiary_user_id));
ALTER TABLE growth_attributions DROP CONSTRAINT IF EXISTS growth_attribution_correlation_ck;
ALTER TABLE growth_attributions ADD CONSTRAINT growth_attribution_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS growth_attributions_live_org_uq ON growth_attributions (organization_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_attributions_org_idx ON growth_attributions (organization_id, created_at, id);
CREATE INDEX IF NOT EXISTS growth_attributions_beneficiary_idx ON growth_attributions (beneficiary_user_id, created_at DESC);

COMMENT ON TABLE growth_attributions IS
  'GROWTH-07: who is credited for a college or an employer. One live row per organisation; a change is an end plus a new row. Never deleted.';

-- ---------------------------------------------------------------------------
-- 2. Disputes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_attribution_disputes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  organization_kind text NOT NULL,
  origin text NOT NULL,
  attribution_id uuid REFERENCES growth_attributions(id),
  claimant_user_id uuid NOT NULL REFERENCES users(id),
  respondent_user_id uuid REFERENCES users(id),
  source_access_request_id uuid REFERENCES growth_employer_onboardings(access_request_id),
  statement text,
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'OPEN',
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason_code text,
  decision_note text,
  resulting_attribution_id uuid REFERENCES growth_attributions(id),
  correlation_id text NOT NULL
);

ALTER TABLE growth_attribution_disputes DROP CONSTRAINT IF EXISTS growth_dispute_kind_ck;
ALTER TABLE growth_attribution_disputes ADD CONSTRAINT growth_dispute_kind_ck CHECK (organization_kind IN ('INSTITUTION', 'EMPLOYER'));
ALTER TABLE growth_attribution_disputes DROP CONSTRAINT IF EXISTS growth_dispute_origin_ck;
ALTER TABLE growth_attribution_disputes ADD CONSTRAINT growth_dispute_origin_ck CHECK (
  (origin = 'CLAIM' AND statement IS NOT NULL AND length(btrim(statement)) BETWEEN 1 AND 2000
     AND source_access_request_id IS NULL AND opened_by_user_id = claimant_user_id
     AND (attribution_id IS NULL) = (respondent_user_id IS NULL))
  OR (origin = 'ONBOARDING_CONFLICT' AND statement IS NULL AND organization_kind = 'EMPLOYER'
     AND source_access_request_id IS NOT NULL AND attribution_id IS NULL AND respondent_user_id IS NOT NULL
     AND opened_by_user_id <> claimant_user_id AND opened_by_user_id <> respondent_user_id));
ALTER TABLE growth_attribution_disputes DROP CONSTRAINT IF EXISTS growth_dispute_parties_ck;
ALTER TABLE growth_attribution_disputes ADD CONSTRAINT growth_dispute_parties_ck CHECK (
  respondent_user_id IS NULL OR respondent_user_id <> claimant_user_id);
ALTER TABLE growth_attribution_disputes DROP CONSTRAINT IF EXISTS growth_dispute_state_ck;
ALTER TABLE growth_attribution_disputes ADD CONSTRAINT growth_dispute_state_ck CHECK (
  (state = 'OPEN' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_reason_code IS NULL
     AND decision_note IS NULL AND resulting_attribution_id IS NULL)
  OR (state IN ('UPHELD', 'REJECTED') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
     AND decision_reason_code IN ('CLAIMANT_DID_THE_WORK', 'RESPONDENT_DID_THE_WORK', 'INSUFFICIENT_EVIDENCE', 'OUTSIDE_POLICY', 'OTHER')
     AND (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 1000)
     AND (decision_reason_code <> 'OTHER' OR decision_note IS NOT NULL)));
-- The decider is neither party (design §8.4, §8.6).
ALTER TABLE growth_attribution_disputes DROP CONSTRAINT IF EXISTS growth_dispute_decider_ck;
ALTER TABLE growth_attribution_disputes ADD CONSTRAINT growth_dispute_decider_ck CHECK (
  decided_by_user_id IS NULL
  OR (decided_by_user_id <> claimant_user_id AND (respondent_user_id IS NULL OR decided_by_user_id <> respondent_user_id)));
ALTER TABLE growth_attribution_disputes DROP CONSTRAINT IF EXISTS growth_dispute_correlation_ck;
ALTER TABLE growth_attribution_disputes ADD CONSTRAINT growth_dispute_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS growth_disputes_open_org_uq ON growth_attribution_disputes (organization_id) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS growth_disputes_state_idx ON growth_attribution_disputes (state, opened_at, id);
CREATE INDEX IF NOT EXISTS growth_disputes_claimant_idx ON growth_attribution_disputes (claimant_user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS growth_disputes_respondent_idx ON growth_attribution_disputes (respondent_user_id, opened_at DESC) WHERE respondent_user_id IS NOT NULL;

ALTER TABLE growth_attributions DROP CONSTRAINT IF EXISTS growth_attributions_dispute_fk;
ALTER TABLE growth_attributions ADD CONSTRAINT growth_attributions_dispute_fk FOREIGN KEY (dispute_id) REFERENCES growth_attribution_disputes(id);

COMMENT ON TABLE growth_attribution_disputes IS
  'GROWTH-07: a claim to credit for an organisation, or the conflict an employer onboarding found. Decided once by a growth admin who is neither party. Never deleted.';

-- ---------------------------------------------------------------------------
-- 3. Helper functions (read by the guards, the routes and, later, GROWTH-09/10/11/12)
-- ---------------------------------------------------------------------------

-- When the organisation was handed to AI8HT: the college link, or the employer's first onboarding.
CREATE OR REPLACE FUNCTION growth_organization_handed_off_at(org uuid) RETURNS timestamptz AS $$
  SELECT coalesce(
    (SELECT r.decided_at FROM growth_handoff_requests r WHERE r.organization_id = org AND r.state = 'LINKED' ORDER BY r.decided_at LIMIT 1),
    (SELECT min(o.recorded_at) FROM growth_employer_onboardings o WHERE o.organization_id = org));
$$ LANGUAGE sql STABLE;

-- Whether a person worked on the organisation: owned (now or once) a lead linked to it, requested its
-- handoff, referred one of its access requests, or is named by its onboarding record (design §8.4).
CREATE OR REPLACE FUNCTION growth_user_worked_on(usr uuid, org uuid) RETURNS boolean AS $$
  SELECT EXISTS (
      SELECT 1 FROM growth_leads l JOIN organization_memberships m ON m.id = l.owner_membership_id
      WHERE l.organization_id = org AND m.user_id = usr)
    OR EXISTS (
      SELECT 1 FROM growth_leads l JOIN growth_lead_owner_history h ON h.lead_id = l.id
      JOIN organization_memberships m ON m.id = h.to_membership_id
      WHERE l.organization_id = org AND m.user_id = usr)
    OR EXISTS (
      SELECT 1 FROM growth_handoff_requests r
      WHERE r.organization_id = org AND r.state = 'LINKED' AND (r.requested_by_user_id = usr OR r.owner_user_id_at_link = usr))
    OR EXISTS (
      SELECT 1 FROM growth_employer_onboardings o
      WHERE o.organization_id = org AND (o.referrer_user_id = usr OR o.lead_owner_user_id = usr))
    OR EXISTS (
      SELECT 1 FROM employer_access_requests ar
      JOIN employer_access_request_referrals rr ON rr.access_request_id = ar.id
      JOIN growth_referral_codes c ON c.id = rr.referral_code_id
      WHERE ar.organization_id = org AND c.user_id = usr);
$$ LANGUAGE sql STABLE;

-- The people with a stake in an organisation's credit: its live beneficiary and both parties of its
-- open dispute. The self-dealing guard (design §8.6) refuses each of them.
CREATE OR REPLACE FUNCTION growth_organization_parties(org uuid) RETURNS SETOF uuid AS $$
  SELECT a.beneficiary_user_id FROM growth_attributions a WHERE a.organization_id = org AND a.ended_at IS NULL
  UNION
  SELECT d.claimant_user_id FROM growth_attribution_disputes d WHERE d.organization_id = org AND d.state = 'OPEN'
  UNION
  SELECT d.respondent_user_id FROM growth_attribution_disputes d
  WHERE d.organization_id = org AND d.state = 'OPEN' AND d.respondent_user_id IS NOT NULL;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_attribution_guard() RETURNS trigger AS $$
DECLARE
  org_kind text;
  dispute growth_attribution_disputes%ROWTYPE;
  previous growth_attributions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth attributions are never deleted; end them instead';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL OR NEW.ended_reason_code IS NOT NULL OR NEW.ended_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'an attribution starts live';
    END IF;
    SELECT kind::text INTO org_kind FROM organizations WHERE id = NEW.organization_id;
    IF org_kind IS DISTINCT FROM NEW.organization_kind THEN
      RAISE EXCEPTION 'an attribution''s organisation kind is the organisation''s own';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
      WHERE m.user_id = NEW.beneficiary_user_id AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')) THEN
      RAISE EXCEPTION 'an attribution credits a growth person';
    END IF;
    IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM growth_leads l WHERE l.id = NEW.lead_id AND l.organization_id = NEW.organization_id) THEN
      RAISE EXCEPTION 'an attribution''s lead names its organisation';
    END IF;
    NEW.created_at := now();
    IF NEW.basis = 'DISPUTE_DECISION' THEN
      SELECT * INTO dispute FROM growth_attribution_disputes WHERE id = NEW.dispute_id;
      IF dispute.id IS NULL OR dispute.state <> 'OPEN' OR dispute.organization_id <> NEW.organization_id THEN
        RAISE EXCEPTION 'a dispute decision credits from an open dispute about the same organisation';
      END IF;
      IF NEW.beneficiary_user_id <> dispute.claimant_user_id AND NEW.beneficiary_user_id IS DISTINCT FROM dispute.respondent_user_id THEN
        RAISE EXCEPTION 'a dispute decision credits a party to the dispute';
      END IF;
      IF NEW.effective_from > now() THEN
        RAISE EXCEPTION 'a dispute decision is effective from a past date';
      END IF;
    ELSE
      NEW.effective_from := now();
    END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO previous FROM growth_attributions WHERE id = NEW.supersedes_id;
      IF previous.id IS NULL OR previous.organization_id <> NEW.organization_id OR previous.ended_at IS NULL THEN
        RAISE EXCEPTION 'an attribution supersedes an ended attribution of the same organisation';
      END IF;
    END IF;
    IF NEW.source_handoff_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM growth_handoff_requests r WHERE r.id = NEW.source_handoff_request_id AND r.state = 'LINKED'
        AND r.organization_id = NEW.organization_id AND r.owner_user_id_at_link = NEW.beneficiary_user_id) THEN
      RAISE EXCEPTION 'a college attribution credits the lead owner at the link';
    END IF;
    IF NEW.source_access_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM growth_employer_onboardings o WHERE o.access_request_id = NEW.source_access_request_id
        AND o.organization_id = NEW.organization_id
        AND ((NEW.basis = 'REFERRAL_LINK' AND o.candidate_basis = 'REFERRAL_LINK' AND o.referrer_user_id = NEW.beneficiary_user_id)
          OR (NEW.basis = 'LEAD_OWNER_AT_HANDOFF' AND o.candidate_basis = 'LEAD_OWNER_AT_HANDOFF' AND o.lead_owner_user_id = NEW.beneficiary_user_id))) THEN
      RAISE EXCEPTION 'an employer attribution credits the onboarding record''s candidate';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'an ended attribution never changes';
  END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.organization_kind <> OLD.organization_kind
     OR NEW.beneficiary_user_id <> OLD.beneficiary_user_id OR NEW.basis <> OLD.basis OR NEW.reason_code <> OLD.reason_code
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id OR NEW.source_handoff_request_id IS DISTINCT FROM OLD.source_handoff_request_id
     OR NEW.source_access_request_id IS DISTINCT FROM OLD.source_access_request_id OR NEW.dispute_id IS DISTINCT FROM OLD.dispute_id
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.effective_from <> OLD.effective_from
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.correlation_id <> OLD.correlation_id OR NEW.created_at <> OLD.created_at
     OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'an attribution can only be ended, once';
  END IF;
  NEW.ended_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_attribution_guard ON growth_attributions;
CREATE TRIGGER growth_attribution_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_attributions
  FOR EACH ROW EXECUTE FUNCTION growth_attribution_guard();

CREATE OR REPLACE FUNCTION growth_attribution_dispute_guard() RETURNS trigger AS $$
DECLARE
  org_kind text;
  live growth_attributions%ROWTYPE;
  handed_off timestamptz;
  result growth_attributions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth attribution disputes are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'OPEN' THEN
      RAISE EXCEPTION 'a dispute starts open';
    END IF;
    SELECT kind::text INTO org_kind FROM organizations WHERE id = NEW.organization_id;
    IF org_kind IS DISTINCT FROM NEW.organization_kind THEN
      RAISE EXCEPTION 'a dispute''s organisation kind is the organisation''s own';
    END IF;
    SELECT * INTO live FROM growth_attributions WHERE organization_id = NEW.organization_id AND ended_at IS NULL;
    IF NEW.origin = 'CLAIM' THEN
      IF live.id IS NOT NULL AND (NEW.attribution_id IS DISTINCT FROM live.id OR NEW.respondent_user_id IS DISTINCT FROM live.beneficiary_user_id) THEN
        RAISE EXCEPTION 'a claim disputes the organisation''s live attribution and names its beneficiary';
      END IF;
      IF live.id IS NULL AND NEW.attribution_id IS NOT NULL THEN
        RAISE EXCEPTION 'a claim disputes the organisation''s live attribution and names its beneficiary';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
        WHERE m.user_id = NEW.claimant_user_id AND m.state = 'ACTIVE' AND m.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')) THEN
        RAISE EXCEPTION 'a claim is made by an ACTIVE growth person';
      END IF;
      handed_off := growth_organization_handed_off_at(NEW.organization_id);
      IF handed_off IS NULL OR now() > handed_off + interval '90 days' THEN
        RAISE EXCEPTION 'dispute window: a claim is made within 90 days of the handoff';
      END IF;
      IF NOT growth_user_worked_on(NEW.claimant_user_id, NEW.organization_id) THEN
        RAISE EXCEPTION 'a claim is made by someone who had a lead or a referral for the organisation';
      END IF;
    ELSE
      IF live.id IS NOT NULL THEN
        RAISE EXCEPTION 'an onboarding conflict opens only where nobody is credited';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM growth_employer_onboardings o WHERE o.access_request_id = NEW.source_access_request_id
          AND o.organization_id = NEW.organization_id AND o.candidate_basis = 'CONFLICT'
          AND o.referrer_user_id = NEW.claimant_user_id AND o.lead_owner_user_id = NEW.respondent_user_id) THEN
        RAISE EXCEPTION 'an onboarding conflict names the onboarding''s referrer and lead owner';
      END IF;
    END IF;
    NEW.opened_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'a decided dispute never changes';
  END IF;
  IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.organization_kind <> OLD.organization_kind
     OR NEW.origin <> OLD.origin OR NEW.attribution_id IS DISTINCT FROM OLD.attribution_id OR NEW.claimant_user_id <> OLD.claimant_user_id
     OR NEW.respondent_user_id IS DISTINCT FROM OLD.respondent_user_id OR NEW.source_access_request_id IS DISTINCT FROM OLD.source_access_request_id
     OR NEW.statement IS DISTINCT FROM OLD.statement OR NEW.opened_by_user_id <> OLD.opened_by_user_id OR NEW.opened_at <> OLD.opened_at
     OR NEW.correlation_id <> OLD.correlation_id OR NEW.state NOT IN ('UPHELD', 'REJECTED') THEN
    RAISE EXCEPTION 'a dispute can only be decided, once';
  END IF;
  IF NEW.resulting_attribution_id IS NOT NULL THEN
    SELECT * INTO result FROM growth_attributions WHERE id = NEW.resulting_attribution_id;
    IF result.dispute_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'a dispute''s resulting attribution was written by its decision';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_attribution_dispute_guard ON growth_attribution_disputes;
CREATE TRIGGER growth_attribution_dispute_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_attribution_disputes
  FOR EACH ROW EXECUTE FUNCTION growth_attribution_dispute_guard();

-- ---------------------------------------------------------------------------
-- 5. The self-dealing guard on verification (design §8.6): an operator never verifies (or moves the
--    verification state of) an organisation they are credited for or party to a dispute about.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_verification_self_dealing_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.actor_user_id IN (SELECT growth_organization_parties(NEW.organization_id)) THEN
    RAISE EXCEPTION 'self-dealing: the actor is credited for this organisation or party to a dispute about it';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_verification_self_dealing_guard ON organization_verification_events;
CREATE TRIGGER growth_verification_self_dealing_guard BEFORE INSERT ON organization_verification_events
  FOR EACH ROW EXECUTE FUNCTION growth_verification_self_dealing_guard();

-- ---------------------------------------------------------------------------
-- 6. Leave dates (design §8.5): the database time a growth membership left ACTIVE, and came back.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_leaver_events (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  user_id uuid NOT NULL REFERENCES users(id),
  event text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE growth_leaver_events DROP CONSTRAINT IF EXISTS growth_leaver_event_ck;
ALTER TABLE growth_leaver_events ADD CONSTRAINT growth_leaver_event_ck CHECK (
  (event = 'LEFT' AND from_state = 'ACTIVE' AND to_state IN ('SUSPENDED', 'ENDED'))
  OR (event = 'RETURNED' AND from_state IN ('SUSPENDED', 'ENDED') AND to_state = 'ACTIVE'));
CREATE INDEX IF NOT EXISTS growth_leaver_events_user_idx ON growth_leaver_events (user_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION growth_leaver_events_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'growth leaver events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_leaver_events_guard ON growth_leaver_events;
CREATE TRIGGER growth_leaver_events_guard BEFORE UPDATE OR DELETE ON growth_leaver_events
  FOR EACH ROW EXECUTE FUNCTION growth_leaver_events_guard();

CREATE OR REPLACE FUNCTION growth_leaver_events_record() RETURNS trigger AS $$
BEGIN
  IF OLD.state::text = 'ACTIVE' THEN
    INSERT INTO growth_leaver_events (id, membership_id, user_id, event, from_state, to_state)
    VALUES (gen_random_uuid(), NEW.id, NEW.user_id, 'LEFT', OLD.state::text, NEW.state::text);
  ELSIF NEW.state::text = 'ACTIVE' THEN
    INSERT INTO growth_leaver_events (id, membership_id, user_id, event, from_state, to_state)
    VALUES (gen_random_uuid(), NEW.id, NEW.user_id, 'RETURNED', OLD.state::text, NEW.state::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_leaver_events_record ON organization_memberships;
CREATE TRIGGER growth_leaver_events_record
  AFTER UPDATE OF state ON organization_memberships
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.role IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER'))
  EXECUTE FUNCTION growth_leaver_events_record();

COMMENT ON TABLE growth_leaver_events IS
  'GROWTH-07: when a growth membership left ACTIVE (the leave date the ledger settles from) and when it returned. Append-only; not back-filled.';
