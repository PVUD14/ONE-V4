-- College payments received (GROWTH-10): what a college paid AI8HT, for how many students and which
-- period, and whether the money cleared, bounced, was refunded or was entered in error.
--
-- Design: docs/architecture/institution-payments-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §11 (college payments), §8.6 (self-dealing),
-- §15 (dual control); ADR-040 decisions D9 and D10; ADR-022 (billing deferred) stands.
--
-- ONE records payments; it moves no money. A row is never edited and never deleted: the only changes
-- are the listed state transitions, each set once with its own date, actor and reason, and a mistake
-- is corrected by voiding the row and recording a new one that names it. Clearance — the event
-- commission starts from — needs an executed INSTITUTION_PAYMENT_CLEARANCE approval (OPS-02) bound to
-- this row's amount, student count and cleared date, and is refused to anyone credited with the
-- college. No amount is put on institution_accounts.
--
-- Redefines one earlier function, operation_approval_extended_target_type() (0051, last 0089),
-- repeating every earlier key. No capability CHECK, grant trigger or scope trigger is touched.
-- Written idempotently: the migrator replays every file on every run.

-- ---------------------------------------------------------------------------
-- 1. Approval actions (0051's extension mechanism). Repeats every earlier extended key — 0051,
--    0057, 0061, 0065, 0081, 0088, 0089 — and adds INSTITUTION_PAYMENT_CLEARANCE. A later file that
--    redefines this function must repeat all of them, including this one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_QUESTION_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_LESSON_PUBLISH' THEN 'content_revision'
    WHEN 'COMMS_TEMPLATE_PUBLISH' THEN 'status_notice_template'
    WHEN 'INSTITUTION_DATA_PURGE' THEN 'institution_offboarding'
    WHEN 'AI_FEATURE_ENABLE' THEN 'ai_feature_policy'
    WHEN 'AI_FEATURE_LIMITS_RAISE' THEN 'ai_feature_policy'
    WHEN 'INSTITUTION_PAYMENT_CLEARANCE' THEN 'institution_payment'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH; 0065: CONTENT_LESSON_PUBLISH; 0081: COMMS_TEMPLATE_PUBLISH; 0088: INSTITUTION_DATA_PURGE; 0089: AI_FEATURE_ENABLE, AI_FEATURE_LIMITS_RAISE; 0111: INSTITUTION_PAYMENT_CLEARANCE. A later key repeats every earlier one.';

-- ---------------------------------------------------------------------------
-- 2. Who is credited with a college (design §8.6), for the self-dealing guard.
--    The owner of the college's lead when operations linked the handoff (GROWTH-04) is the credit
--    record on this base. Once GROWTH-07's growth_attributions exists, a live attribution's
--    beneficiary is credited too; it is read dynamically so this file does not depend on GROWTH-07,
--    and if that table lacks the columns design §8.1 names the function raises (fails closed) rather
--    than allowing. GROWTH-07 may replace this function; it must keep or supersede both rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION institution_payment_credited_user(p_institution uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  credited boolean;
BEGIN
  IF p_institution IS NULL OR p_user IS NULL THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM growth_handoff_requests
    WHERE organization_id = p_institution AND state = 'LINKED' AND owner_user_id_at_link = p_user
  ) INTO credited;
  IF credited THEN
    RETURN true;
  END IF;
  IF to_regclass('growth_attributions') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM growth_attributions WHERE organization_id = $1 AND beneficiary_user_id = $2 AND ended_at IS NULL)'
        INTO credited USING p_institution, p_user;
    EXCEPTION WHEN undefined_column THEN
      RAISE EXCEPTION 'institution_payment_credited_user cannot read growth_attributions; redefine it with that table';
    END;
  END IF;
  RETURN COALESCE(credited, false);
END;
$$;
COMMENT ON FUNCTION institution_payment_credited_user(uuid, uuid) IS
  'GROWTH-10 self-dealing guard (design §8.6): true when the user is credited with the college — the lead owner at handoff link (GROWTH-04), or a live growth_attributions beneficiary once that table exists. Fails closed.';

-- ---------------------------------------------------------------------------
-- 3. institution_payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS institution_payments (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  instrument text NOT NULL,
  instrument_reference text NOT NULL,
  amount_paise bigint NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  students_paid integer NOT NULL,
  received_on date NOT NULL,
  covers_from date NOT NULL,
  covers_to date NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVED',
  record_reason_code text NOT NULL,
  replaces_payment_id uuid REFERENCES institution_payments(id),
  note text,
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  cleared_on date,
  cleared_at timestamptz,
  cleared_recorded_by_user_id uuid REFERENCES users(id),
  clearance_approval_id uuid REFERENCES operation_approvals(id),
  bounced_on date,
  bounced_at timestamptz,
  bounced_recorded_by_user_id uuid REFERENCES users(id),
  bounce_reason_code text,
  refunded_on date,
  refunded_at timestamptz,
  refunded_recorded_by_user_id uuid REFERENCES users(id),
  refund_reason_code text,
  voided_at timestamptz,
  voided_by_user_id uuid REFERENCES users(id),
  void_reason_code text,
  correlation_id text NOT NULL
);

ALTER TABLE institution_payments DROP CONSTRAINT IF EXISTS institution_payment_values_ck;
ALTER TABLE institution_payments ADD CONSTRAINT institution_payment_values_ck CHECK (
  instrument IN ('CHEQUE', 'DEMAND_DRAFT', 'BANK_TRANSFER', 'UPI')
  AND instrument_reference ~ '^[A-Za-z0-9/-]{4,40}$'
  AND amount_paise > 0 AND amount_paise <= 100000000000
  AND currency = 'INR'
  AND students_paid > 0 AND students_paid <= 100000
  AND received_on >= DATE '2020-01-01'
  AND covers_from >= DATE '2020-01-01'
  AND covers_to >= covers_from AND covers_to - covers_from <= 1096
  AND state IN ('RECEIVED', 'CLEARED', 'BOUNCED', 'REFUNDED', 'VOIDED')
  AND (note IS NULL OR length(note) BETWEEN 1 AND 500)
  AND length(correlation_id) BETWEEN 1 AND 128);

ALTER TABLE institution_payments DROP CONSTRAINT IF EXISTS institution_payment_reasons_ck;
ALTER TABLE institution_payments ADD CONSTRAINT institution_payment_reasons_ck CHECK (
  record_reason_code IN ('PAYMENT_RECEIVED', 'CORRECTION')
  AND ((record_reason_code = 'CORRECTION') = (replaces_payment_id IS NOT NULL))
  AND (replaces_payment_id IS NULL OR replaces_payment_id <> id)
  AND (bounce_reason_code IS NULL OR bounce_reason_code IN ('INSUFFICIENT_FUNDS', 'SIGNATURE_MISMATCH', 'STOPPED', 'STALE', 'OTHER'))
  AND (refund_reason_code IS NULL OR refund_reason_code IN ('OVERPAYMENT', 'DUPLICATE_PAYMENT', 'COLLEGE_EXITED', 'COMMERCIAL_SETTLEMENT', 'OTHER'))
  AND (void_reason_code IS NULL OR void_reason_code IN ('ENTERED_IN_ERROR', 'DUPLICATE_ENTRY', 'WRONG_COLLEGE', 'WRONG_DETAILS')));

-- Each transition's columns are set together, and exist exactly when the state says it happened.
ALTER TABLE institution_payments DROP CONSTRAINT IF EXISTS institution_payment_shape_ck;
ALTER TABLE institution_payments ADD CONSTRAINT institution_payment_shape_ck CHECK (
  ((cleared_on IS NULL) = (cleared_at IS NULL))
  AND ((cleared_on IS NULL) = (cleared_recorded_by_user_id IS NULL))
  AND ((cleared_on IS NULL) = (clearance_approval_id IS NULL))
  AND ((bounced_on IS NULL) = (bounced_at IS NULL))
  AND ((bounced_on IS NULL) = (bounced_recorded_by_user_id IS NULL))
  AND ((bounced_on IS NULL) = (bounce_reason_code IS NULL))
  AND ((refunded_on IS NULL) = (refunded_at IS NULL))
  AND ((refunded_on IS NULL) = (refunded_recorded_by_user_id IS NULL))
  AND ((refunded_on IS NULL) = (refund_reason_code IS NULL))
  AND ((voided_at IS NULL) = (voided_by_user_id IS NULL))
  AND ((voided_at IS NULL) = (void_reason_code IS NULL))
  AND NOT (cleared_on IS NOT NULL AND bounced_on IS NOT NULL)
  AND (refunded_on IS NULL OR cleared_on IS NOT NULL)
  AND (cleared_on IS NULL OR cleared_on >= received_on)
  AND (bounced_on IS NULL OR bounced_on >= received_on)
  AND (refunded_on IS NULL OR refunded_on >= cleared_on)
  AND (state <> 'RECEIVED' OR (cleared_on IS NULL AND bounced_on IS NULL AND refunded_on IS NULL AND voided_at IS NULL))
  AND (state <> 'CLEARED' OR (cleared_on IS NOT NULL AND refunded_on IS NULL AND voided_at IS NULL))
  AND (state <> 'BOUNCED' OR (bounced_on IS NOT NULL AND voided_at IS NULL))
  AND (state <> 'REFUNDED' OR (refunded_on IS NOT NULL AND voided_at IS NULL))
  AND (state <> 'VOIDED' OR voided_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS institution_payment_institution_idx ON institution_payments (institution_id, received_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS institution_payment_cleared_idx ON institution_payments (institution_id) WHERE state = 'CLEARED';
-- The same cheque, draft or transfer is recorded once while it stands; a bounced cheque presented
-- again is a new row.
CREATE UNIQUE INDEX IF NOT EXISTS institution_payment_reference_uq ON institution_payments (institution_id, instrument, upper(instrument_reference))
  WHERE state IN ('RECEIVED', 'CLEARED', 'REFUNDED');
-- One correction per voided row.
CREATE UNIQUE INDEX IF NOT EXISTS institution_payment_replaces_uq ON institution_payments (replaces_payment_id) WHERE replaces_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. The guard: insert rules, the listed transitions only, set once, never deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION institution_payment_guard() RETURNS trigger AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  replaced record;
  approval record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'college payments are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.institution_id AND kind = 'INSTITUTION') THEN
      RAISE EXCEPTION 'a college payment belongs to an institution';
    END IF;
    IF NEW.state <> 'RECEIVED' THEN
      RAISE EXCEPTION 'a college payment is recorded as received';
    END IF;
    IF NEW.received_on > today THEN
      RAISE EXCEPTION 'a payment cannot be received in the future';
    END IF;
    IF institution_payment_credited_user(NEW.institution_id, NEW.recorded_by_user_id) THEN
      RAISE EXCEPTION 'a person credited with this college cannot record its payments';
    END IF;
    IF NEW.replaces_payment_id IS NOT NULL THEN
      SELECT institution_id, state INTO replaced FROM institution_payments WHERE id = NEW.replaces_payment_id;
      IF NOT FOUND OR replaced.state <> 'VOIDED' OR replaced.institution_id <> NEW.institution_id THEN
        RAISE EXCEPTION 'a correction replaces a voided payment of the same college';
      END IF;
    END IF;
    NEW.recorded_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: nothing recorded at receipt ever changes.
  IF (NEW.id, NEW.institution_id, NEW.instrument, NEW.instrument_reference, NEW.amount_paise, NEW.currency, NEW.students_paid,
      NEW.received_on, NEW.covers_from, NEW.covers_to, NEW.record_reason_code, NEW.replaces_payment_id, NEW.note,
      NEW.recorded_by_user_id, NEW.recorded_at, NEW.correlation_id)
     IS DISTINCT FROM
     (OLD.id, OLD.institution_id, OLD.instrument, OLD.instrument_reference, OLD.amount_paise, OLD.currency, OLD.students_paid,
      OLD.received_on, OLD.covers_from, OLD.covers_to, OLD.record_reason_code, OLD.replaces_payment_id, OLD.note,
      OLD.recorded_by_user_id, OLD.recorded_at, OLD.correlation_id) THEN
    RAISE EXCEPTION 'a college payment is immutable; void it and record a correction';
  END IF;

  IF OLD.state = 'RECEIVED' AND NEW.state = 'CLEARED' THEN
    IF (NEW.bounced_on, NEW.refunded_on, NEW.voided_at) IS DISTINCT FROM (OLD.bounced_on, OLD.refunded_on, OLD.voided_at) THEN
      RAISE EXCEPTION 'a clearance sets only the clearance columns';
    END IF;
    IF NEW.cleared_on > today THEN
      RAISE EXCEPTION 'a payment cannot clear in the future';
    END IF;
    SELECT state, extended_action_key, target_id, payload, requested_by_user_id, decided_by_user_id, executed_by_user_id
      INTO approval FROM operation_approvals WHERE id = NEW.clearance_approval_id;
    IF NOT FOUND OR approval.state <> 'EXECUTED' OR approval.extended_action_key IS DISTINCT FROM 'INSTITUTION_PAYMENT_CLEARANCE'
       OR approval.target_id <> NEW.id::text OR approval.executed_by_user_id IS DISTINCT FROM NEW.cleared_recorded_by_user_id
       OR (approval.payload->>'amountPaise')::bigint IS DISTINCT FROM NEW.amount_paise
       OR (approval.payload->>'studentsPaid')::integer IS DISTINCT FROM NEW.students_paid
       OR (approval.payload->>'clearedOn') IS DISTINCT FROM to_char(NEW.cleared_on, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'a clearance needs an executed INSTITUTION_PAYMENT_CLEARANCE approval for this payment, amount, count and date';
    END IF;
    IF institution_payment_credited_user(NEW.institution_id, NEW.cleared_recorded_by_user_id)
       OR institution_payment_credited_user(NEW.institution_id, approval.requested_by_user_id)
       OR institution_payment_credited_user(NEW.institution_id, approval.decided_by_user_id) THEN
      RAISE EXCEPTION 'a person credited with this college cannot clear or approve its payments';
    END IF;
    NEW.cleared_at := now();
    RETURN NEW;
  END IF;

  IF OLD.state = 'RECEIVED' AND NEW.state = 'BOUNCED' THEN
    IF (NEW.cleared_on, NEW.clearance_approval_id, NEW.refunded_on, NEW.voided_at) IS DISTINCT FROM (OLD.cleared_on, OLD.clearance_approval_id, OLD.refunded_on, OLD.voided_at) THEN
      RAISE EXCEPTION 'a bounce sets only the bounce columns';
    END IF;
    IF NEW.bounced_on > today THEN
      RAISE EXCEPTION 'a payment cannot bounce in the future';
    END IF;
    NEW.bounced_at := now();
    RETURN NEW;
  END IF;

  IF OLD.state = 'CLEARED' AND NEW.state = 'REFUNDED' THEN
    IF (NEW.cleared_on, NEW.cleared_at, NEW.cleared_recorded_by_user_id, NEW.clearance_approval_id, NEW.bounced_on, NEW.voided_at)
       IS DISTINCT FROM (OLD.cleared_on, OLD.cleared_at, OLD.cleared_recorded_by_user_id, OLD.clearance_approval_id, OLD.bounced_on, OLD.voided_at) THEN
      RAISE EXCEPTION 'a refund sets only the refund columns';
    END IF;
    IF NEW.refunded_on > today THEN
      RAISE EXCEPTION 'a payment cannot be refunded in the future';
    END IF;
    NEW.refunded_at := now();
    RETURN NEW;
  END IF;

  IF OLD.state IN ('RECEIVED', 'CLEARED', 'BOUNCED', 'REFUNDED') AND NEW.state = 'VOIDED' THEN
    IF (NEW.cleared_on, NEW.cleared_at, NEW.cleared_recorded_by_user_id, NEW.clearance_approval_id,
        NEW.bounced_on, NEW.bounced_at, NEW.bounced_recorded_by_user_id, NEW.bounce_reason_code,
        NEW.refunded_on, NEW.refunded_at, NEW.refunded_recorded_by_user_id, NEW.refund_reason_code)
       IS DISTINCT FROM
       (OLD.cleared_on, OLD.cleared_at, OLD.cleared_recorded_by_user_id, OLD.clearance_approval_id,
        OLD.bounced_on, OLD.bounced_at, OLD.bounced_recorded_by_user_id, OLD.bounce_reason_code,
        OLD.refunded_on, OLD.refunded_at, OLD.refunded_recorded_by_user_id, OLD.refund_reason_code) THEN
      RAISE EXCEPTION 'a void sets only the void columns and keeps every earlier one';
    END IF;
    NEW.voided_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'college payment: % -> % is not a permitted step', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_payment_guard ON institution_payments;
CREATE TRIGGER institution_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON institution_payments
  FOR EACH ROW EXECUTE FUNCTION institution_payment_guard();

-- No TRUNCATE trigger: test fixtures reset their private schemas with TRUNCATE … CASCADE, and a TRUNCATE
-- needs table ownership, which no application role uses. Rows are protected against DELETE above.
DROP TRIGGER IF EXISTS institution_payment_truncate_guard ON institution_payments;
DROP FUNCTION IF EXISTS institution_payment_truncate_guard();

COMMENT ON TABLE institution_payments IS
  'College payments received (GROWTH-10). Recorded, never processed; append-only — only the listed transitions, each set once; corrections by void plus a new row. Clearance is dual-controlled (INSTITUTION_PAYMENT_CLEARANCE). Read only by GROWTH_FINANCE and ACCOUNT_MANAGE operators; growth sees only whether a payment has cleared. Not billing (ADR-022).';
COMMENT ON COLUMN institution_payments.amount_paise IS 'Integer paise, INR. Never a float.';
COMMENT ON COLUMN institution_payments.students_paid IS
  'How many students the college pays for with this payment, as its payment letter states. A count, never a list; not an entitlement.';
