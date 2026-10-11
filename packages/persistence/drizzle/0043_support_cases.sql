-- Support desk: support cases and their history (OPS-05).
--
-- Design: docs/architecture/support-cases-table-design.md
--
-- College and student issues arrive by email, phone and WhatsApp and have left no
-- record. A support case is that record: an optional person, an optional organisation,
-- how it arrived, what kind of problem, how urgent, and an append-only history of state
-- changes, notes and assignments.
--
-- A case is about a person and holds free text typed while talking to them, so the
-- privacy deletion flow must be able to strip it: on deletion the subject link is
-- removed, the summary is replaced and every note is redacted. The triggers below allow
-- exactly those changes and nothing else that would rewrite history.
--
-- The migrator replays every file on every run, in lexical order, with no tracking
-- table. Everything here is idempotent: tables are created if absent, constraints are
-- dropped and re-added so a replay converges, and functions are replaced.

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_cases (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  subject_user_id uuid REFERENCES users(id),
  subject_detached_at timestamptz,
  channel text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL,
  state text NOT NULL DEFAULT 'OPEN',
  summary text NOT NULL,
  summary_redacted_at timestamptz,
  assigned_to_user_id uuid REFERENCES users(id),
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  opening_reason_code text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  sla_due_at timestamptz NOT NULL,
  resolved_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_channel_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_channel_ck CHECK (channel IN ('EMAIL', 'PHONE', 'WHATSAPP', 'IN_APP'));

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_category_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_category_ck CHECK (category IN (
  'ACCOUNT_ACCESS', 'INVITATION', 'ONBOARDING', 'DATA_CORRECTION', 'PRIVACY_REQUEST',
  'TECHNICAL_FAULT', 'HOW_TO', 'COMPLAINT', 'OTHER'));

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_severity_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_severity_ck CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'));

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_state_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_state_ck CHECK (state IN
  ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'));

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_summary_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_summary_ck CHECK (length(summary) BETWEEN 3 AND 500);

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_reason_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_reason_ck CHECK (opening_reason_code ~ '^[A-Z0-9_:-]{3,64}$');

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_version_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_version_ck CHECK (version >= 1);

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_sla_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_sla_ck CHECK (sla_due_at > opened_at);

-- A closed case has a closing time and an open one does not; a resolved case has a
-- resolution time and a case still being worked does not. A CLOSED case may have
-- either: with one it was fixed, without one it was closed unresolved.
ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_timestamps_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_timestamps_ck CHECK (
  ((state = 'CLOSED') = (closed_at IS NOT NULL))
  AND (state <> 'RESOLVED' OR resolved_at IS NOT NULL)
  AND (state NOT IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER') OR resolved_at IS NULL));

-- Detached by a privacy deletion: the person is gone, and so is the typed summary.
ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_detached_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_detached_ck CHECK (
  subject_detached_at IS NULL OR subject_user_id IS NULL);

ALTER TABLE support_cases DROP CONSTRAINT IF EXISTS support_case_redacted_summary_ck;
ALTER TABLE support_cases ADD CONSTRAINT support_case_redacted_summary_ck CHECK (
  summary_redacted_at IS NULL OR summary = 'Summary removed on privacy deletion.');

CREATE INDEX IF NOT EXISTS support_case_list_idx ON support_cases(opened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_case_queue_idx ON support_cases(state, opened_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_case_subject_idx ON support_cases(subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_case_assignee_idx ON support_cases(assigned_to_user_id, state);
CREATE INDEX IF NOT EXISTS support_case_organization_idx ON support_cases(organization_id, opened_at DESC);

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES support_cases(id),
  event_kind text NOT NULL,
  from_state text,
  to_state text,
  assignee_user_id uuid REFERENCES users(id),
  note text,
  linked_correlation_id text,
  reason_code text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  redacted_at timestamptz
);

ALTER TABLE support_case_events DROP CONSTRAINT IF EXISTS support_case_event_kind_ck;
ALTER TABLE support_case_events ADD CONSTRAINT support_case_event_kind_ck CHECK (event_kind IN ('OPENED', 'STATE_CHANGED', 'NOTE', 'ASSIGNED'));

ALTER TABLE support_case_events DROP CONSTRAINT IF EXISTS support_case_event_states_ck;
ALTER TABLE support_case_events ADD CONSTRAINT support_case_event_states_ck CHECK (
  (from_state IS NULL OR from_state IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'))
  AND (to_state IS NULL OR to_state IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED')));

-- Each kind carries exactly its own fields.
ALTER TABLE support_case_events DROP CONSTRAINT IF EXISTS support_case_event_shape_ck;
ALTER TABLE support_case_events ADD CONSTRAINT support_case_event_shape_ck CHECK (
  (event_kind = 'OPENED' AND from_state IS NULL AND to_state = 'OPEN' AND assignee_user_id IS NULL)
  OR (event_kind = 'STATE_CHANGED' AND from_state IS NOT NULL AND to_state IS NOT NULL AND from_state <> to_state
      AND assignee_user_id IS NULL)
  OR (event_kind = 'NOTE' AND from_state IS NULL AND to_state IS NULL AND assignee_user_id IS NULL
      AND (note IS NOT NULL OR redacted_at IS NOT NULL))
  OR (event_kind = 'ASSIGNED' AND from_state IS NULL AND to_state IS NULL));

ALTER TABLE support_case_events DROP CONSTRAINT IF EXISTS support_case_event_text_ck;
ALTER TABLE support_case_events ADD CONSTRAINT support_case_event_text_ck CHECK (
  (note IS NULL OR length(note) BETWEEN 1 AND 2000)
  AND (redacted_at IS NULL OR note IS NULL)
  AND reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (linked_correlation_id IS NULL OR linked_correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$')
  AND length(correlation_id) BETWEEN 1 AND 128);

CREATE INDEX IF NOT EXISTS support_case_event_case_idx ON support_case_events(case_id, occurred_at, id);

-- ---------------------------------------------------------------------------
-- Lifecycle rules a second writer cannot skip
-- ---------------------------------------------------------------------------
-- The transition table is packages/authorization/src/support-desk.ts's, repeated.
CREATE OR REPLACE FUNCTION support_case_transition_allowed(from_state text, to_state text) RETURNS boolean AS $$
  SELECT CASE from_state
    WHEN 'OPEN' THEN to_state IN ('IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED')
    WHEN 'IN_PROGRESS' THEN to_state IN ('WAITING_ON_CUSTOMER', 'RESOLVED')
    WHEN 'WAITING_ON_CUSTOMER' THEN to_state IN ('IN_PROGRESS', 'RESOLVED', 'CLOSED')
    WHEN 'RESOLVED' THEN to_state IN ('IN_PROGRESS', 'CLOSED')
    ELSE false
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION support_case_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support cases are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'OPEN' THEN
      RAISE EXCEPTION 'a support case starts OPEN';
    END IF;
    IF NEW.subject_detached_at IS NOT NULL OR NEW.summary_redacted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a support case cannot be created detached';
    END IF;
    -- The database clock, never the caller's: the SLA stamp must not be backdated.
    NEW.opened_at := now();
    NEW.updated_at := now();
    NEW.sla_due_at := now() + CASE NEW.severity
      WHEN 'URGENT' THEN interval '4 hours'
      WHEN 'HIGH' THEN interval '24 hours'
      WHEN 'MEDIUM' THEN interval '72 hours'
      ELSE interval '120 hours'
    END;
    NEW.resolved_at := NULL;
    NEW.closed_at := NULL;
    NEW.version := 1;
    RETURN NEW;
  END IF;

  -- UPDATE. What was logged at opening is a record, not a draft.
  IF NEW.id <> OLD.id OR NEW.channel <> OLD.channel OR NEW.category <> OLD.category
     OR NEW.severity <> OLD.severity OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.opened_by_user_id <> OLD.opened_by_user_id OR NEW.opening_reason_code <> OLD.opening_reason_code
     OR NEW.opened_at <> OLD.opened_at OR NEW.sla_due_at <> OLD.sla_due_at THEN
    RAISE EXCEPTION 'the opening record of a support case is immutable';
  END IF;

  -- The subject can only be removed, and only by a privacy deletion.
  IF NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id
     AND (NEW.subject_user_id IS NOT NULL OR NEW.subject_detached_at IS NULL) THEN
    RAISE EXCEPTION 'a support case subject can only be detached by a privacy deletion';
  END IF;
  IF OLD.subject_detached_at IS NOT NULL AND NEW.subject_detached_at IS DISTINCT FROM OLD.subject_detached_at THEN
    RAISE EXCEPTION 'a support case detachment is permanent';
  END IF;
  IF NEW.summary <> OLD.summary AND NEW.summary_redacted_at IS NULL THEN
    RAISE EXCEPTION 'a support case summary can only be replaced by a privacy deletion';
  END IF;
  IF OLD.summary_redacted_at IS NOT NULL AND NEW.summary_redacted_at IS DISTINCT FROM OLD.summary_redacted_at THEN
    RAISE EXCEPTION 'a support case redaction is permanent';
  END IF;

  IF NEW.state <> OLD.state THEN
    IF NOT support_case_transition_allowed(OLD.state, NEW.state) THEN
      RAISE EXCEPTION 'support case cannot move from % to %', OLD.state, NEW.state;
    END IF;
    IF NEW.state = 'RESOLVED' THEN
      NEW.resolved_at := now();
    ELSIF NEW.state IN ('IN_PROGRESS', 'WAITING_ON_CUSTOMER') THEN
      NEW.resolved_at := NULL;
    ELSE
      NEW.resolved_at := OLD.resolved_at;
    END IF;
    NEW.closed_at := CASE WHEN NEW.state = 'CLOSED' THEN now() ELSE NULL END;
  ELSE
    NEW.resolved_at := OLD.resolved_at;
    NEW.closed_at := OLD.closed_at;
  END IF;

  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_case_guard ON support_cases;
CREATE TRIGGER support_case_guard
  BEFORE INSERT OR UPDATE OR DELETE ON support_cases
  FOR EACH ROW EXECUTE FUNCTION support_case_guard();

-- History is append-only. The one permitted update is a privacy deletion's redaction:
-- the note goes, the time it went is stamped, and nothing else changes.
CREATE OR REPLACE FUNCTION support_case_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support case history is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- clock_timestamp, not now(): an opening and its first assignment share a
    -- transaction, and the history must still read in the order it was written.
    NEW.occurred_at := clock_timestamp();
    NEW.redacted_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.note IS NULL
     AND NEW.id = OLD.id AND NEW.case_id = OLD.case_id AND NEW.event_kind = OLD.event_kind
     AND NEW.from_state IS NOT DISTINCT FROM OLD.from_state AND NEW.to_state IS NOT DISTINCT FROM OLD.to_state
     AND NEW.assignee_user_id IS NOT DISTINCT FROM OLD.assignee_user_id
     AND NEW.linked_correlation_id IS NOT DISTINCT FROM OLD.linked_correlation_id
     AND NEW.reason_code = OLD.reason_code AND NEW.actor_user_id = OLD.actor_user_id
     AND NEW.correlation_id = OLD.correlation_id AND NEW.occurred_at = OLD.occurred_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'support case history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_case_event_guard ON support_case_events;
CREATE TRIGGER support_case_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON support_case_events
  FOR EACH ROW EXECUTE FUNCTION support_case_event_guard();

-- ---------------------------------------------------------------------------
-- Privacy deletion evidence
-- ---------------------------------------------------------------------------
-- A completed deletion records what happened to each category of data. Support cases
-- become a category (disposition ANONYMISED), so the CHECK from 0009 gains one value;
-- every existing value is kept.
ALTER TABLE privacy_deletion_records DROP CONSTRAINT IF EXISTS privacy_deletion_category_ck;
ALTER TABLE privacy_deletion_records ADD CONSTRAINT privacy_deletion_category_ck CHECK (category IN (
  'IDENTITY', 'STUDENT_PROFILE', 'INSTITUTION_ROSTER', 'DOCUMENTS', 'APPLICATIONS', 'OFFERS',
  'ASSESSMENT_EVIDENCE', 'NOTIFICATIONS', 'AUDIT', 'SUPPORT_CASES'));

-- ---------------------------------------------------------------------------
-- The account view's timeline
-- ---------------------------------------------------------------------------
-- The last events about a user (resource_id) as well as by them (the existing actor
-- index), without scanning the audit table.
CREATE INDEX IF NOT EXISTS audit_resource_time_idx ON audit_events(resource_id, occurred_at DESC);

COMMENT ON TABLE support_cases IS
  'Support desk cases (OPS-05). Detached from their subject, with the summary and notes redacted, by a privacy deletion.';
COMMENT ON TABLE support_case_events IS
  'Append-only support case history; the only permitted update is a privacy deletion redacting a note.';
