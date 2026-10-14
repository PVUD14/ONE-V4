-- Quarterly internal access reviews (OPS-15).
--
-- Design: docs/architecture/access-review-campaigns-table-design.md
--
-- A campaign freezes every standing internal access -- each ACTIVE platform membership
-- and each live internal or faculty-review capability grant -- into items, and a reviewer
-- holding SECURITY_ACCESS_REVIEW decides KEEP or REVOKE on each. The rules that make the
-- result evidence (a frozen snapshot, one decision per item, no attesting your own access
-- except the marked solo case, no closing with undecided items, nothing deleted) are
-- repeated here so a second writer cannot skip them.
--
-- The migrator replays every file on every run, and ADR-035 applies each file once in
-- the future; either way every statement is idempotent. References tables up to 0066.

CREATE TABLE IF NOT EXISTS access_review_campaigns (
  id uuid PRIMARY KEY,
  period_label text NOT NULL,
  state text NOT NULL DEFAULT 'OPEN',
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  open_reason_code text NOT NULL,
  open_note text,
  open_correlation_id text NOT NULL,
  item_count integer NOT NULL,
  closed_by_user_id uuid REFERENCES users(id),
  closed_at timestamptz,
  close_reason_code text,
  close_correlation_id text
);

ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_period_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_period_ck CHECK (period_label ~ '^[0-9]{4}-Q[1-4]$');
ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_state_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_state_ck CHECK (state IN ('OPEN', 'CLOSED'));
ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_reason_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_reason_ck CHECK (
  open_reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (close_reason_code IS NULL OR close_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));
ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_note_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_note_ck CHECK (open_note IS NULL OR char_length(open_note) <= 500);
ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_count_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_count_ck CHECK (item_count >= 0);
ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_due_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_due_ck CHECK (due_at = opened_at + interval '30 days');
-- An OPEN campaign has no closure; a CLOSED one has all of it, after it opened.
ALTER TABLE access_review_campaigns DROP CONSTRAINT IF EXISTS access_review_campaign_closure_ck;
ALTER TABLE access_review_campaigns ADD CONSTRAINT access_review_campaign_closure_ck CHECK (
  (state = 'OPEN' AND closed_by_user_id IS NULL AND closed_at IS NULL AND close_reason_code IS NULL AND close_correlation_id IS NULL)
  OR (state = 'CLOSED' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL AND close_reason_code IS NOT NULL
      AND close_correlation_id IS NOT NULL AND closed_at >= opened_at));

-- Two open snapshots would split the decisions between them.
CREATE UNIQUE INDEX IF NOT EXISTS access_review_campaign_one_open_uq ON access_review_campaigns ((true)) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS access_review_campaign_opened_idx ON access_review_campaigns (opened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS access_review_campaign_closed_idx ON access_review_campaigns (closed_at DESC) WHERE state = 'CLOSED';

CREATE TABLE IF NOT EXISTS access_review_items (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES access_review_campaigns(id),
  position integer NOT NULL,
  item_kind text NOT NULL,
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  role text NOT NULL,
  membership_state text NOT NULL,
  capability text,
  capability_grant_id uuid REFERENCES membership_capabilities(id),
  capabilities_snapshot text[] NOT NULL,
  high_risk boolean NOT NULL,
  granted_by_user_id uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL,
  grant_reason_code text,
  decision text,
  decision_reason_code text,
  decision_note text,
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_correlation_id text,
  solo boolean NOT NULL DEFAULT false,
  revocation_outcome text
);

ALTER TABLE access_review_items DROP CONSTRAINT IF EXISTS access_review_item_kind_ck;
ALTER TABLE access_review_items ADD CONSTRAINT access_review_item_kind_ck CHECK (
  (item_kind = 'PLATFORM_ROLE' AND capability IS NULL AND capability_grant_id IS NULL AND grant_reason_code IS NULL)
  OR (item_kind = 'CAPABILITY_GRANT' AND capability IS NOT NULL AND capability_grant_id IS NOT NULL
      AND granted_by_user_id IS NOT NULL AND grant_reason_code IS NOT NULL));
ALTER TABLE access_review_items DROP CONSTRAINT IF EXISTS access_review_item_position_ck;
ALTER TABLE access_review_items ADD CONSTRAINT access_review_item_position_ck CHECK (position >= 1);
ALTER TABLE access_review_items DROP CONSTRAINT IF EXISTS access_review_item_decision_ck;
ALTER TABLE access_review_items ADD CONSTRAINT access_review_item_decision_ck CHECK (
  (decision IS NULL AND decision_reason_code IS NULL AND decision_note IS NULL AND decided_by_user_id IS NULL
    AND decided_at IS NULL AND decision_correlation_id IS NULL AND NOT solo AND revocation_outcome IS NULL)
  OR (decision IN ('KEEP', 'REVOKE') AND decision_reason_code ~ '^[A-Z0-9_:-]{3,64}$' AND decided_by_user_id IS NOT NULL
    AND decided_at IS NOT NULL AND decision_correlation_id IS NOT NULL
    AND (decision_note IS NULL OR char_length(decision_note) <= 500)
    AND ((decision = 'REVOKE') = (revocation_outcome IS NOT NULL))
    AND (revocation_outcome IS NULL OR revocation_outcome IN ('APPLIED', 'ALREADY_ENDED'))));
-- Solo is a self-attestation that keeps access, and nothing else.
ALTER TABLE access_review_items DROP CONSTRAINT IF EXISTS access_review_item_solo_ck;
ALTER TABLE access_review_items ADD CONSTRAINT access_review_item_solo_ck CHECK (
  (solo AND decision = 'KEEP' AND decided_by_user_id = subject_user_id)
  OR (NOT solo AND (decided_by_user_id IS NULL OR decided_by_user_id <> subject_user_id)));

CREATE UNIQUE INDEX IF NOT EXISTS access_review_item_position_uq ON access_review_items (campaign_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS access_review_item_role_uq ON access_review_items (campaign_id, membership_id) WHERE item_kind = 'PLATFORM_ROLE';
CREATE UNIQUE INDEX IF NOT EXISTS access_review_item_grant_uq ON access_review_items (campaign_id, capability_grant_id) WHERE item_kind = 'CAPABILITY_GRANT';
CREATE INDEX IF NOT EXISTS access_review_item_undecided_idx ON access_review_items (campaign_id) WHERE decision IS NULL;

-- ---------------------------------------------------------------------------
-- Who may review
-- ---------------------------------------------------------------------------
-- Mirrors the TypeScript baselines for SECURITY_ACCESS_REVIEW: PLATFORM_SUPER_ADMIN and
-- SECURITY_ADMIN hold it by baseline; any platform role may carry a live grant. An
-- integration test pins the two together. plpgsql so it is not validated at creation.
CREATE OR REPLACE FUNCTION access_review_is_reviewer(candidate uuid) RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.user_id = candidate AND m.state = 'ACTIVE'
      AND (m.role IN ('PLATFORM_SUPER_ADMIN', 'SECURITY_ADMIN')
        OR (m.role = 'OPERATIONS_ADMIN' AND EXISTS (
          SELECT 1 FROM membership_capabilities c
          WHERE c.membership_id = m.id AND c.capability = 'SECURITY_ACCESS_REVIEW' AND c.revoked_at IS NULL))));
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION access_review_reviewer_count() RETURNS integer AS $$
BEGIN
  RETURN (
    SELECT count(DISTINCT m.user_id)::int
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    WHERE m.state = 'ACTIVE' AND access_review_is_reviewer(m.user_id));
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- Campaign lifecycle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION access_review_campaign_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access review campaigns are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT access_review_is_reviewer(NEW.opened_by_user_id) THEN
      RAISE EXCEPTION 'only an access reviewer may open an access review';
    END IF;
    -- Stamped by the database clock, never by the caller.
    NEW.state := 'OPEN';
    NEW.opened_at := now();
    NEW.due_at := now() + interval '30 days';
    NEW.period_label := to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-Q' || to_char(now() AT TIME ZONE 'UTC', 'Q');
    NEW.closed_by_user_id := NULL;
    NEW.closed_at := NULL;
    NEW.close_reason_code := NULL;
    NEW.close_correlation_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.period_label <> OLD.period_label OR NEW.opened_by_user_id <> OLD.opened_by_user_id
     OR NEW.opened_at <> OLD.opened_at OR NEW.due_at <> OLD.due_at OR NEW.open_reason_code <> OLD.open_reason_code
     OR NEW.open_note IS DISTINCT FROM OLD.open_note OR NEW.open_correlation_id <> OLD.open_correlation_id
     OR NEW.item_count <> OLD.item_count THEN
    RAISE EXCEPTION 'an access review campaign cannot be changed once opened';
  END IF;
  IF OLD.state = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed access review cannot be changed';
  END IF;
  IF NEW.state = 'CLOSED' THEN
    IF NOT access_review_is_reviewer(NEW.closed_by_user_id) THEN
      RAISE EXCEPTION 'only an access reviewer may close an access review';
    END IF;
    IF EXISTS (SELECT 1 FROM access_review_items i WHERE i.campaign_id = NEW.id AND i.decision IS NULL) THEN
      RAISE EXCEPTION 'an access review cannot close while items are undecided';
    END IF;
    NEW.closed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_campaign_guard ON access_review_campaigns;
CREATE TRIGGER access_review_campaign_guard
  BEFORE INSERT OR UPDATE OR DELETE ON access_review_campaigns
  FOR EACH ROW EXECUTE FUNCTION access_review_campaign_guard();

-- ---------------------------------------------------------------------------
-- Items: a frozen snapshot, one decision each, not on your own access
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION access_review_item_guard() RETURNS trigger AS $$
DECLARE
  campaign_state text;
  campaign_opened timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access review items are never deleted';
  END IF;

  SELECT c.state, c.opened_at INTO campaign_state, campaign_opened
  FROM access_review_campaigns c WHERE c.id = NEW.campaign_id;
  IF campaign_state IS NULL THEN
    RAISE EXCEPTION 'access review campaign does not exist';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- now() is the transaction's start time, so only the transaction that opened the
    -- campaign can add to its snapshot. Nothing can be slipped in, or out, later.
    IF campaign_state <> 'OPEN' OR campaign_opened <> now() THEN
      RAISE EXCEPTION 'access review items are written only when the campaign opens';
    END IF;
    IF NEW.decision IS NOT NULL THEN
      RAISE EXCEPTION 'an access review item starts undecided';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.campaign_id <> OLD.campaign_id OR NEW.position <> OLD.position OR NEW.item_kind <> OLD.item_kind
     OR NEW.membership_id <> OLD.membership_id OR NEW.subject_user_id <> OLD.subject_user_id
     OR NEW.organization_id <> OLD.organization_id OR NEW.role <> OLD.role OR NEW.membership_state <> OLD.membership_state
     OR NEW.capability IS DISTINCT FROM OLD.capability OR NEW.capability_grant_id IS DISTINCT FROM OLD.capability_grant_id
     OR NEW.capabilities_snapshot <> OLD.capabilities_snapshot OR NEW.high_risk <> OLD.high_risk
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id OR NEW.granted_at <> OLD.granted_at
     OR NEW.grant_reason_code IS DISTINCT FROM OLD.grant_reason_code THEN
    RAISE EXCEPTION 'an access review snapshot cannot be changed';
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'an access review item is decided once';
  END IF;
  IF campaign_state <> 'OPEN' THEN
    RAISE EXCEPTION 'a closed access review cannot be changed';
  END IF;
  IF NEW.decision IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT access_review_is_reviewer(NEW.decided_by_user_id) THEN
    RAISE EXCEPTION 'only an access reviewer may decide an access review item';
  END IF;
  IF NEW.decided_by_user_id = NEW.subject_user_id THEN
    IF NOT NEW.solo OR NEW.decision <> 'KEEP' THEN
      RAISE EXCEPTION 'a reviewer cannot attest their own access';
    END IF;
    IF access_review_reviewer_count() <> 1 THEN
      RAISE EXCEPTION 'solo self-attestation is available only while exactly one reviewer exists';
    END IF;
    IF now() < campaign_opened + interval '15 minutes' THEN
      RAISE EXCEPTION 'solo self-attestation is available after a 15 minute cooling-off';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_item_guard ON access_review_items;
CREATE TRIGGER access_review_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON access_review_items
  FOR EACH ROW EXECUTE FUNCTION access_review_item_guard();

COMMENT ON TABLE access_review_campaigns IS
  'OPS-15: one periodic review of standing internal access. Never deleted; closes only when every item is decided.';
COMMENT ON TABLE access_review_items IS
  'OPS-15: the frozen snapshot of one standing access and the single KEEP/REVOKE decision on it.';
COMMENT ON COLUMN access_review_items.solo IS
  'A KEEP on the reviewer''s own access, allowed only while exactly one reviewer exists and 15 minutes after opening.';
