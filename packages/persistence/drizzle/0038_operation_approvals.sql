-- Dual control for high-risk operator actions (OPS-02).
--
-- Design: docs/architecture/high-risk-approvals-table-design.md
--
-- A high-risk action (Appendix 1 §5.4) needs an approval from a second person holding
-- APPROVE_HIGH_RISK, bound to a hash of the exact action and consumed in the action's
-- own transaction. While only one approver exists, the requester may approve their
-- own request after a 15-minute cooling-off (the solo-operator safeguard), marked SOLO.
--
-- The migrator replays every file on every run, in lexical order, with no tracking
-- table. So everything here is idempotent, and nothing depends on 0039 (which sorts
-- after this file) beyond reading membership_capabilities rows at run time.

-- ---------------------------------------------------------------------------
-- Which feature flags are high-risk, and in which direction
-- ---------------------------------------------------------------------------
-- ENABLE: switching on needs approval (AI features). DISABLE: switching off needs
-- approval (safety controls, and a kill switch whose ON state is the safe one).
-- Changed by migration only: an API that could clear this would remove the approval.
ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS high_risk_direction text;
ALTER TABLE feature_flags DROP CONSTRAINT IF EXISTS feature_flag_high_risk_direction_ck;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flag_high_risk_direction_ck
  CHECK (high_risk_direction IS NULL OR high_risk_direction IN ('ENABLE', 'DISABLE'));

-- ---------------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operation_approvals (
  id uuid PRIMARY KEY,
  action_key text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  note text,
  correlation_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'PENDING',
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_reason_code text,
  decision_note text,
  solo boolean NOT NULL DEFAULT false,
  solo_notice_state text,
  executed_at timestamptz,
  executed_by_user_id uuid REFERENCES users(id),
  execution_correlation_id text
);

-- Constraints are dropped and re-added so a replay converges on this definition.
ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_action_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_action_ck CHECK (action_key IN (
  'ORGANIZATION_SUSPEND', 'FEATURE_FLAG_HIGH_RISK_CHANGE', 'OUTBOX_BACKLOG_SUPERSEDE',
  'PRIVACY_HOLD_RELEASE', 'CAPABILITY_GRANT_HIGH_RISK'));

ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_target_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_target_ck CHECK (
  target_type IN ('organization', 'feature_flag', 'outbox_backlog', 'data_retention_hold', 'organization_membership')
  AND length(target_id) BETWEEN 1 AND 128);

ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_payload_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_payload_ck CHECK (
  jsonb_typeof(payload) = 'object' AND payload_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_reason_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_reason_ck CHECK (
  reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (note IS NULL OR length(note) BETWEEN 1 AND 500)
  AND (decision_reason_code IS NULL OR decision_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
  AND (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 500)
  AND correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'
  AND (execution_correlation_id IS NULL OR execution_correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$'));

-- One 24-hour window covers both deciding and executing.
ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_expiry_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_expiry_ck CHECK (
  expires_at = requested_at + interval '24 hours');

ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_state_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_state_ck CHECK (
  (state = 'PENDING'
    AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_reason_code IS NULL AND decision_note IS NULL
    AND NOT solo AND executed_at IS NULL AND executed_by_user_id IS NULL AND execution_correlation_id IS NULL)
  OR (state IN ('APPROVED', 'REJECTED')
    AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason_code IS NOT NULL
    AND executed_at IS NULL AND executed_by_user_id IS NULL AND execution_correlation_id IS NULL)
  OR (state = 'EXECUTED'
    AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason_code IS NOT NULL
    AND executed_at IS NOT NULL AND executed_by_user_id IS NOT NULL AND execution_correlation_id IS NOT NULL));

-- Approver is not the requester, unless it is a solo approval: by the requester, an
-- approval, at least 15 minutes after the request, with a recorded notice outcome.
ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_solo_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_solo_ck CHECK (
  (NOT solo AND solo_notice_state IS NULL
    AND (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id))
  OR (solo AND state IN ('APPROVED', 'EXECUTED')
    AND decided_by_user_id = requested_by_user_id
    AND decided_at >= requested_at + interval '15 minutes'
    AND solo_notice_state IN ('QUEUED', 'NOT_DELIVERED')));

-- The person who asked is the person who acts.
ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_executor_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_executor_ck CHECK (
  executed_by_user_id IS NULL OR executed_by_user_id = requested_by_user_id);

CREATE INDEX IF NOT EXISTS operation_approval_queue_idx ON operation_approvals(state, requested_at, id);
CREATE INDEX IF NOT EXISTS operation_approval_requester_idx ON operation_approvals(requested_by_user_id, requested_at, id);

-- ---------------------------------------------------------------------------
-- Who is an approver
-- ---------------------------------------------------------------------------
-- The same answer effectiveInternalCapabilities gives in packages/authorization: an
-- ACTIVE user with an ACTIVE platform membership that is PLATFORM_SUPER_ADMIN (baseline)
-- or carries a live APPROVE_HIGH_RISK grant. plpgsql so it is not validated against
-- tables at creation time.
CREATE OR REPLACE FUNCTION operation_approval_is_approver(candidate uuid) RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.user_id = candidate AND m.state = 'ACTIVE'
      AND (m.role = 'PLATFORM_SUPER_ADMIN'
        OR (m.role IN ('OPERATIONS_ADMIN', 'SECURITY_ADMIN') AND EXISTS (
          SELECT 1 FROM membership_capabilities c
          WHERE c.membership_id = m.id AND c.capability = 'APPROVE_HIGH_RISK' AND c.revoked_at IS NULL))));
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION operation_approval_approver_count() RETURNS integer AS $$
BEGIN
  RETURN (
    SELECT count(DISTINCT m.user_id)::int
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    WHERE m.state = 'ACTIVE' AND operation_approval_is_approver(m.user_id));
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------------------------------------------------------------------------
-- Lifecycle rules a second writer cannot skip
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_guard() RETURNS trigger AS $$
DECLARE
  subject_user uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operation approvals are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PENDING' THEN
      RAISE EXCEPTION 'an operation approval starts PENDING';
    END IF;
    -- The clock is the database's, never the caller's: a backdated request would
    -- skip the cooling-off, and a future one would outlive its window.
    NEW.requested_at := now();
    NEW.expires_at := now() + interval '24 hours';
    RETURN NEW;
  END IF;

  -- UPDATE: the request is a record of what was asked; only the decision and the
  -- execution are written later, and state only moves forward.
  IF NEW.id <> OLD.id OR NEW.action_key <> OLD.action_key OR NEW.target_type <> OLD.target_type
     OR NEW.target_id <> OLD.target_id OR NEW.payload <> OLD.payload OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.reason_code <> OLD.reason_code
     OR NEW.note IS DISTINCT FROM OLD.note OR NEW.correlation_id <> OLD.correlation_id
     OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'an operation approval request is immutable';
  END IF;

  IF OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'REJECTED') THEN
    IF now() >= OLD.expires_at THEN
      RAISE EXCEPTION 'operation approval has expired';
    END IF;
    IF NOT operation_approval_is_approver(NEW.decided_by_user_id) THEN
      RAISE EXCEPTION 'the decider does not hold APPROVE_HIGH_RISK';
    END IF;
    IF NEW.decided_by_user_id = OLD.requested_by_user_id THEN
      IF NOT NEW.solo OR NEW.state <> 'APPROVED' THEN
        RAISE EXCEPTION 'the requester may not decide their own request';
      END IF;
      IF now() < OLD.requested_at + interval '15 minutes' THEN
        RAISE EXCEPTION 'solo approval is available after a 15 minute cooling-off';
      END IF;
      IF operation_approval_approver_count() <> 1 THEN
        RAISE EXCEPTION 'solo approval is available only while exactly one approver exists';
      END IF;
    END IF;
    IF OLD.action_key = 'CAPABILITY_GRANT_HIGH_RISK' THEN
      SELECT m.user_id INTO subject_user FROM organization_memberships m WHERE m.id::text = OLD.target_id;
      IF subject_user = NEW.decided_by_user_id THEN
        RAISE EXCEPTION 'an approver may not approve a capability grant to themselves';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'APPROVED' AND NEW.state = 'EXECUTED' THEN
    IF now() >= OLD.expires_at THEN
      RAISE EXCEPTION 'operation approval has expired';
    END IF;
    IF NEW.decided_by_user_id <> OLD.decided_by_user_id OR NEW.decided_at <> OLD.decided_at
       OR NEW.decision_reason_code <> OLD.decision_reason_code
       OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
       OR NEW.solo <> OLD.solo OR NEW.solo_notice_state IS DISTINCT FROM OLD.solo_notice_state THEN
      RAISE EXCEPTION 'an operation approval decision is immutable';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'operation approval cannot move from % to %', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operation_approval_guard ON operation_approvals;
CREATE TRIGGER operation_approval_guard
  BEFORE INSERT OR UPDATE OR DELETE ON operation_approvals
  FOR EACH ROW EXECUTE FUNCTION operation_approval_guard();

COMMENT ON TABLE operation_approvals IS
  'Dual-control requests and decisions for high-risk operator actions (OPS-02). Never deleted.';
COMMENT ON COLUMN operation_approvals.solo IS
  'Approved by the requester under the solo-operator safeguard: one approver, 15-minute cooling-off.';
COMMENT ON COLUMN feature_flags.high_risk_direction IS
  'ENABLE or DISABLE: the change that needs a second person (OPS-02). NULL for an ordinary flag. Set by migration only.';
