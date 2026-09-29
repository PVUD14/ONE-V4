-- 0081 — Incident register, breach clocks and status notices (OPS-16).
--
-- Why: the breach runbook's incident log lived outside ONE, with no clock and no record of who was
-- told what and when. This adds the register and its append-only timeline, the organisations an
-- incident affects, draft versions of status-notice wording that a second person must approve
-- (through OPS-02 dual control) before they are copied into notification_templates, and status
-- notices to the administrators of affected organisations with a per-recipient delivery record.
--
-- The 72-hour Board clock is the ONE plan's period, pending legal confirmation; it is stamped on each
-- breach incident (board_clock_hours) so a later change never moves a running deadline. Every
-- lifecycle time is the database clock. Nothing here contacts a regulator or any external party.
--
-- Design: docs/architecture/incident-register-table-design.md. References only tables up to 0077.
-- Idempotent: CREATE ... IF NOT EXISTS, constraints dropped and re-added, functions replaced.

-- ---------------------------------------------------------------------------
-- 1. incidents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  summary text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL,
  state text NOT NULL DEFAULT 'OPEN',
  detected_at timestamptz NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  declared_by_user_id uuid NOT NULL REFERENCES users(id),
  declare_reason_code text NOT NULL,
  contained_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  board_clock_hours integer,
  board_notified_at timestamptz,
  board_notified_by_user_id uuid REFERENCES users(id),
  board_reference text,
  users_notified_at timestamptz,
  users_notified_by_user_id uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_title_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_title_ck CHECK (length(btrim(title)) BETWEEN 3 AND 120);
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_summary_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_summary_ck CHECK (length(btrim(summary)) BETWEEN 3 AND 1000);
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_category_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_category_ck CHECK (category IN
  ('PERSONAL_DATA_BREACH', 'SECURITY', 'SERVICE_OUTAGE', 'DEGRADED_SERVICE', 'DATA_INTEGRITY', 'OTHER'));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_severity_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_severity_ck CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_state_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_state_ck CHECK (state IN ('OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_reason_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_reason_ck CHECK (declare_reason_code ~ '^[A-Z0-9_:-]{3,64}$');
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_board_clock_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_board_clock_ck CHECK (
  (category = 'PERSONAL_DATA_BREACH' AND board_clock_hours BETWEEN 1 AND 720)
  OR (category <> 'PERSONAL_DATA_BREACH' AND board_clock_hours IS NULL));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_board_notified_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_board_notified_ck CHECK (
  (board_notified_at IS NULL AND board_notified_by_user_id IS NULL AND board_reference IS NULL)
  OR (board_notified_at IS NOT NULL AND board_notified_by_user_id IS NOT NULL AND category = 'PERSONAL_DATA_BREACH'
      AND board_notified_at >= detected_at));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_board_reference_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_board_reference_ck CHECK (board_reference IS NULL OR board_reference ~ '^[A-Za-z0-9._:/-]{3,64}$');
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_users_notified_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_users_notified_ck CHECK (
  (users_notified_at IS NULL AND users_notified_by_user_id IS NULL)
  OR (users_notified_at IS NOT NULL AND users_notified_by_user_id IS NOT NULL AND category = 'PERSONAL_DATA_BREACH'
      AND users_notified_at >= detected_at));
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incident_lifecycle_ck;
ALTER TABLE incidents ADD CONSTRAINT incident_lifecycle_ck CHECK (
  detected_at <= declared_at
  AND (state <> 'CLOSED' OR closed_at IS NOT NULL)
  AND (state = 'CLOSED' OR closed_at IS NULL)
  AND (state <> 'RESOLVED' OR resolved_at IS NOT NULL)
  AND (state = 'OPEN' OR contained_at IS NOT NULL OR state = 'CLOSED'));

CREATE INDEX IF NOT EXISTS incidents_declared_idx ON incidents (declared_at, id);
CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (state) WHERE state <> 'CLOSED';

COMMENT ON TABLE incidents IS
  'OPS-16 incident register. Lifecycle times are the database clock; detected_at and the two notified-at times are operator facts bounded by it. board_clock_hours is the plan''s period (72), pending legal confirmation, stamped per breach.';

CREATE OR REPLACE FUNCTION incident_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'incidents are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'OPEN' THEN RAISE EXCEPTION 'an incident is declared OPEN'; END IF;
    IF NEW.detected_at > now() THEN RAISE EXCEPTION 'detected_at cannot be later than the database clock'; END IF;
    NEW.declared_at := now();
    NEW.updated_at := now();
    NEW.contained_at := NULL; NEW.resolved_at := NULL; NEW.closed_at := NULL;
    IF NEW.board_notified_at IS NOT NULL OR NEW.users_notified_at IS NOT NULL THEN
      RAISE EXCEPTION 'notifications are recorded after declaration';
    END IF;
    NEW.board_clock_hours := CASE WHEN NEW.category = 'PERSONAL_DATA_BREACH' THEN 72 ELSE NULL END;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.title <> OLD.title OR NEW.summary <> OLD.summary OR NEW.detected_at <> OLD.detected_at
     OR NEW.declared_at <> OLD.declared_at OR NEW.declared_by_user_id <> OLD.declared_by_user_id
     OR NEW.declare_reason_code <> OLD.declare_reason_code THEN
    RAISE EXCEPTION 'the declaration of an incident is immutable';
  END IF;
  IF OLD.state = 'CLOSED' THEN RAISE EXCEPTION 'a closed incident is final'; END IF;

  -- Category: a breach cannot be reclassified away once the Board was notified; the clock is
  -- stamped when an incident becomes a breach and removed when it stops being one.
  IF NEW.category <> OLD.category THEN
    IF OLD.category = 'PERSONAL_DATA_BREACH' AND (OLD.board_notified_at IS NOT NULL OR OLD.users_notified_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a breach that has been notified cannot be reclassified';
    END IF;
    NEW.board_clock_hours := CASE WHEN NEW.category = 'PERSONAL_DATA_BREACH' THEN 72 ELSE NULL END;
  ELSIF NEW.board_clock_hours IS DISTINCT FROM OLD.board_clock_hours THEN
    RAISE EXCEPTION 'the breach clock period is stamped, not edited';
  END IF;

  -- Notified-at records: set once, bounded by the database clock.
  IF OLD.board_notified_at IS NOT NULL AND (NEW.board_notified_at IS DISTINCT FROM OLD.board_notified_at
     OR NEW.board_notified_by_user_id IS DISTINCT FROM OLD.board_notified_by_user_id OR NEW.board_reference IS DISTINCT FROM OLD.board_reference) THEN
    RAISE EXCEPTION 'the Board notification record is set once';
  END IF;
  IF OLD.board_notified_at IS NULL AND NEW.board_notified_at IS NOT NULL AND NEW.board_notified_at > now() THEN
    RAISE EXCEPTION 'board_notified_at cannot be later than the database clock';
  END IF;
  IF OLD.users_notified_at IS NOT NULL AND (NEW.users_notified_at IS DISTINCT FROM OLD.users_notified_at
     OR NEW.users_notified_by_user_id IS DISTINCT FROM OLD.users_notified_by_user_id) THEN
    RAISE EXCEPTION 'the affected-users notification record is set once';
  END IF;
  IF OLD.users_notified_at IS NULL AND NEW.users_notified_at IS NOT NULL AND NEW.users_notified_at > now() THEN
    RAISE EXCEPTION 'users_notified_at cannot be later than the database clock';
  END IF;

  -- State machine (packages/authorization/src/incidents.ts). Times are stamped here.
  IF NEW.state <> OLD.state THEN
    IF NOT (
      (OLD.state = 'OPEN' AND NEW.state IN ('CONTAINED', 'RESOLVED', 'CLOSED')) OR
      (OLD.state = 'CONTAINED' AND NEW.state IN ('OPEN', 'RESOLVED')) OR
      (OLD.state = 'RESOLVED' AND NEW.state IN ('OPEN', 'CLOSED'))
    ) THEN
      RAISE EXCEPTION 'invalid incident state transition';
    END IF;
    IF NEW.state = 'CLOSED' AND NEW.category = 'PERSONAL_DATA_BREACH'
       AND (NEW.board_notified_at IS NULL OR NEW.users_notified_at IS NULL) THEN
      RAISE EXCEPTION 'a breach cannot be closed before the Board and affected users are recorded as notified';
    END IF;
    IF NEW.state = 'CONTAINED' THEN NEW.contained_at := COALESCE(OLD.contained_at, now()); END IF;
    IF NEW.state = 'RESOLVED' THEN
      NEW.contained_at := COALESCE(OLD.contained_at, now());
      NEW.resolved_at := now();
    END IF;
    IF NEW.state = 'OPEN' THEN NEW.resolved_at := NULL; END IF;
    IF NEW.state = 'CLOSED' THEN NEW.closed_at := now(); END IF;
  ELSIF NEW.contained_at IS DISTINCT FROM OLD.contained_at OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
        OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'lifecycle times are stamped by transitions';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_guard ON incidents;
CREATE TRIGGER incident_guard BEFORE INSERT OR UPDATE OR DELETE ON incidents
FOR EACH ROW EXECUTE FUNCTION incident_guard();

-- ---------------------------------------------------------------------------
-- 2. incident_events (append-only timeline)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_events (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id),
  event_kind text NOT NULL,
  from_value text,
  to_value text,
  organization_id uuid REFERENCES organizations(id),
  notice_id uuid,
  note text,
  reason_code text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL
);

ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_event_kind_ck;
ALTER TABLE incident_events ADD CONSTRAINT incident_event_kind_ck CHECK (event_kind IN (
  'DECLARED', 'STATE_CHANGED', 'SEVERITY_CHANGED', 'CATEGORY_CHANGED', 'NOTE', 'ORGANIZATION_ADDED', 'ORGANIZATION_REMOVED',
  'BOARD_NOTIFIED', 'USERS_NOTIFIED', 'NOTICE_DRAFTED', 'NOTICE_QUEUED', 'NOTICE_SENT', 'NOTICE_WITHDRAWN'));
ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_event_values_ck;
ALTER TABLE incident_events ADD CONSTRAINT incident_event_values_ck CHECK (
  (from_value IS NULL OR from_value ~ '^[A-Z_]{2,40}$') AND (to_value IS NULL OR to_value ~ '^[A-Z_]{2,40}$'));
ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_event_note_ck;
ALTER TABLE incident_events ADD CONSTRAINT incident_event_note_ck CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500);
ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_event_reason_ck;
ALTER TABLE incident_events ADD CONSTRAINT incident_event_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$');
ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_event_correlation_ck;
ALTER TABLE incident_events ADD CONSTRAINT incident_event_correlation_ck CHECK (correlation_id ~ '^[A-Za-z0-9._:-]{8,128}$');
ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_event_shape_ck;
ALTER TABLE incident_events ADD CONSTRAINT incident_event_shape_ck CHECK (
  (event_kind IN ('ORGANIZATION_ADDED', 'ORGANIZATION_REMOVED')) = (organization_id IS NOT NULL)
  AND (event_kind LIKE 'NOTICE_%') = (notice_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS incident_events_timeline_idx ON incident_events (incident_id, occurred_at, id);

CREATE OR REPLACE FUNCTION incident_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occurred_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incident timeline rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_event_guard ON incident_events;
CREATE TRIGGER incident_event_guard BEFORE INSERT OR UPDATE OR DELETE ON incident_events
FOR EACH ROW EXECUTE FUNCTION incident_event_guard();

-- ---------------------------------------------------------------------------
-- 3. incident_affected_organizations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_affected_organizations (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  added_by_user_id uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id)
);

ALTER TABLE incident_affected_organizations DROP CONSTRAINT IF EXISTS incident_affected_org_removed_ck;
ALTER TABLE incident_affected_organizations ADD CONSTRAINT incident_affected_org_removed_ck CHECK ((removed_at IS NULL) = (removed_by_user_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS incident_affected_org_live_uq ON incident_affected_organizations (incident_id, organization_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS incident_affected_org_incident_idx ON incident_affected_organizations (incident_id);

CREATE OR REPLACE FUNCTION incident_affected_organization_guard() RETURNS trigger AS $$
DECLARE
  org_kind text;
  incident_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'affected organisation rows are never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT kind::text INTO org_kind FROM organizations WHERE id = NEW.organization_id;
    IF org_kind IS NULL OR org_kind NOT IN ('INSTITUTION', 'EMPLOYER') THEN
      RAISE EXCEPTION 'only a college or an employer can be an affected organisation';
    END IF;
    SELECT state INTO incident_state FROM incidents WHERE id = NEW.incident_id;
    IF incident_state = 'CLOSED' THEN RAISE EXCEPTION 'a closed incident is final'; END IF;
    NEW.added_at := now();
    NEW.removed_at := NULL; NEW.removed_by_user_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.incident_id <> OLD.incident_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.added_by_user_id <> OLD.added_by_user_id OR NEW.added_at <> OLD.added_at THEN
    RAISE EXCEPTION 'an affected organisation row is immutable';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN RAISE EXCEPTION 'a removed affected organisation stays removed'; END IF;
  IF NEW.removed_by_user_id IS NOT NULL THEN NEW.removed_at := now(); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_affected_organization_guard ON incident_affected_organizations;
CREATE TRIGGER incident_affected_organization_guard BEFORE INSERT OR UPDATE OR DELETE ON incident_affected_organizations
FOR EACH ROW EXECUTE FUNCTION incident_affected_organization_guard();

-- ---------------------------------------------------------------------------
-- 4. The approval action for template publication (0051's extension mechanism).
--    Repeat every earlier extended key: 0051, 0057, 0061, 0065.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_QUESTION_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_LESSON_PUBLISH' THEN 'content_revision'
    WHEN 'COMMS_TEMPLATE_PUBLISH' THEN 'status_notice_template'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH; 0065: CONTENT_LESSON_PUBLISH; 0081: COMMS_TEMPLATE_PUBLISH. A later key repeats every earlier one.';

-- ---------------------------------------------------------------------------
-- 5. status_notice_templates (drafts awaiting a second person)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS status_notice_templates (
  id uuid PRIMARY KEY,
  template_key text NOT NULL,
  version integer NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  content_hash text NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  drafted_by_user_id uuid NOT NULL REFERENCES users(id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  draft_reason_code text NOT NULL,
  published_template_id uuid REFERENCES notification_templates(id),
  publish_approval_id uuid REFERENCES operation_approvals(id),
  published_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_by_user_id uuid REFERENCES users(id),
  withdraw_reason_code text,
  CONSTRAINT status_notice_template_version_uq UNIQUE (template_key, version)
);

ALTER TABLE status_notice_templates DROP CONSTRAINT IF EXISTS status_notice_template_key_ck;
ALTER TABLE status_notice_templates ADD CONSTRAINT status_notice_template_key_ck CHECK (template_key ~ '^[a-z][a-z0-9-]{2,48}$');
ALTER TABLE status_notice_templates DROP CONSTRAINT IF EXISTS status_notice_template_version_ck;
ALTER TABLE status_notice_templates ADD CONSTRAINT status_notice_template_version_ck CHECK (version > 0);
ALTER TABLE status_notice_templates DROP CONSTRAINT IF EXISTS status_notice_template_text_ck;
ALTER TABLE status_notice_templates ADD CONSTRAINT status_notice_template_text_ck CHECK (
  length(btrim(subject)) BETWEEN 3 AND 160 AND length(btrim(body)) BETWEEN 3 AND 500);
ALTER TABLE status_notice_templates DROP CONSTRAINT IF EXISTS status_notice_template_hash_ck;
ALTER TABLE status_notice_templates ADD CONSTRAINT status_notice_template_hash_ck CHECK (content_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE status_notice_templates DROP CONSTRAINT IF EXISTS status_notice_template_reason_ck;
ALTER TABLE status_notice_templates ADD CONSTRAINT status_notice_template_reason_ck CHECK (
  draft_reason_code ~ '^[A-Z0-9_:-]{3,64}$' AND (withdraw_reason_code IS NULL OR withdraw_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));
ALTER TABLE status_notice_templates DROP CONSTRAINT IF EXISTS status_notice_template_state_ck;
ALTER TABLE status_notice_templates ADD CONSTRAINT status_notice_template_state_ck CHECK (
  (state = 'DRAFT' AND published_template_id IS NULL AND publish_approval_id IS NULL AND published_at IS NULL AND withdrawn_at IS NULL)
  OR (state = 'PUBLISHED' AND published_template_id IS NOT NULL AND publish_approval_id IS NOT NULL AND published_at IS NOT NULL AND withdrawn_at IS NULL)
  OR (state = 'WITHDRAWN' AND published_template_id IS NULL AND withdrawn_at IS NOT NULL AND withdrawn_by_user_id IS NOT NULL
      AND withdraw_reason_code IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS status_notice_template_published_uq ON status_notice_templates (published_template_id) WHERE published_template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS status_notice_templates_drafted_idx ON status_notice_templates (drafted_at, id);

CREATE OR REPLACE FUNCTION status_notice_template_guard() RETURNS trigger AS $$
DECLARE
  approval record;
  published record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'status notice templates are never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN RAISE EXCEPTION 'a template version starts as a draft'; END IF;
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.template_key <> OLD.template_key OR NEW.version <> OLD.version OR NEW.subject <> OLD.subject
     OR NEW.body <> OLD.body OR NEW.content_hash <> OLD.content_hash OR NEW.drafted_by_user_id <> OLD.drafted_by_user_id
     OR NEW.drafted_at <> OLD.drafted_at OR NEW.draft_reason_code <> OLD.draft_reason_code THEN
    RAISE EXCEPTION 'a template version''s content is immutable';
  END IF;
  IF OLD.state <> 'DRAFT' THEN RAISE EXCEPTION 'a published or withdrawn template version is final'; END IF;
  IF NEW.state = 'PUBLISHED' THEN
    SELECT state, extended_action_key, target_id, requested_by_user_id, decided_by_user_id INTO approval
    FROM operation_approvals WHERE id = NEW.publish_approval_id;
    IF NOT FOUND OR approval.extended_action_key IS DISTINCT FROM 'COMMS_TEMPLATE_PUBLISH' OR approval.target_id <> NEW.id::text
       OR approval.state <> 'EXECUTED' OR approval.requested_by_user_id <> NEW.drafted_by_user_id OR approval.decided_by_user_id IS NULL THEN
      RAISE EXCEPTION 'a template version is published only through its executed approval, requested by its author';
    END IF;
    SELECT stable_key, version, approved_by_user_id INTO published FROM notification_templates WHERE id = NEW.published_template_id;
    IF NOT FOUND OR published.stable_key <> 'status-notice.' || NEW.template_key OR published.version <> NEW.version
       OR published.approved_by_user_id <> approval.decided_by_user_id THEN
      RAISE EXCEPTION 'the published template must carry this version and its approver';
    END IF;
    NEW.published_at := now();
  ELSIF NEW.state = 'WITHDRAWN' THEN
    NEW.withdrawn_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS status_notice_template_guard ON status_notice_templates;
CREATE TRIGGER status_notice_template_guard BEFORE INSERT OR UPDATE OR DELETE ON status_notice_templates
FOR EACH ROW EXECUTE FUNCTION status_notice_template_guard();

-- ---------------------------------------------------------------------------
-- 6. incident_status_notices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_status_notices (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES incidents(id),
  template_id uuid NOT NULL REFERENCES notification_templates(id),
  state text NOT NULL DEFAULT 'DRAFT',
  drafted_by_user_id uuid NOT NULL REFERENCES users(id),
  drafted_at timestamptz NOT NULL DEFAULT now(),
  draft_reason_code text NOT NULL,
  approved_by_user_id uuid REFERENCES users(id),
  approved_at timestamptz,
  approve_reason_code text,
  sent_at timestamptz,
  recipient_count integer,
  organization_count integer,
  withdrawn_at timestamptz,
  withdrawn_by_user_id uuid REFERENCES users(id),
  withdraw_reason_code text
);

ALTER TABLE incident_status_notices DROP CONSTRAINT IF EXISTS incident_status_notice_reason_ck;
ALTER TABLE incident_status_notices ADD CONSTRAINT incident_status_notice_reason_ck CHECK (
  draft_reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (approve_reason_code IS NULL OR approve_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
  AND (withdraw_reason_code IS NULL OR withdraw_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));
ALTER TABLE incident_status_notices DROP CONSTRAINT IF EXISTS incident_status_notice_state_ck;
ALTER TABLE incident_status_notices ADD CONSTRAINT incident_status_notice_state_ck CHECK (
  (state = 'DRAFT' AND approved_at IS NULL AND sent_at IS NULL AND withdrawn_at IS NULL)
  OR (state = 'QUEUED' AND approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND approve_reason_code IS NOT NULL
      AND sent_at IS NULL AND withdrawn_at IS NULL)
  OR (state = 'SENT' AND approved_at IS NOT NULL AND sent_at IS NOT NULL AND recipient_count >= 0 AND organization_count >= 0
      AND withdrawn_at IS NULL)
  OR (state = 'WITHDRAWN' AND approved_at IS NULL AND sent_at IS NULL AND withdrawn_at IS NOT NULL
      AND withdrawn_by_user_id IS NOT NULL AND withdraw_reason_code IS NOT NULL));
CREATE INDEX IF NOT EXISTS incident_status_notices_incident_idx ON incident_status_notices (incident_id, drafted_at, id);

CREATE OR REPLACE FUNCTION incident_status_notice_guard() RETURNS trigger AS $$
DECLARE
  incident_state text;
  recent integer;
  daily integer;
  live_orgs integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'status notices are never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN RAISE EXCEPTION 'a status notice starts as a draft'; END IF;
    IF NOT EXISTS (SELECT 1 FROM status_notice_templates s WHERE s.published_template_id = NEW.template_id AND s.state = 'PUBLISHED') THEN
      RAISE EXCEPTION 'a status notice uses only an approved status notice template version';
    END IF;
    SELECT state INTO incident_state FROM incidents WHERE id = NEW.incident_id;
    IF incident_state = 'CLOSED' THEN RAISE EXCEPTION 'a closed incident is final'; END IF;
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.incident_id <> OLD.incident_id OR NEW.template_id <> OLD.template_id
     OR NEW.drafted_by_user_id <> OLD.drafted_by_user_id OR NEW.drafted_at <> OLD.drafted_at OR NEW.draft_reason_code <> OLD.draft_reason_code THEN
    RAISE EXCEPTION 'a status notice''s draft is immutable';
  END IF;
  IF NEW.state = OLD.state THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN RAISE EXCEPTION 'a status notice changes only by a transition'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'DRAFT' AND NEW.state = 'QUEUED' THEN
    -- Serialise approvals for one incident, then apply the rate limit on the database clock.
    SELECT state INTO incident_state FROM incidents WHERE id = NEW.incident_id FOR UPDATE;
    IF incident_state = 'CLOSED' THEN RAISE EXCEPTION 'a closed incident is final'; END IF;
    SELECT count(*) INTO live_orgs FROM incident_affected_organizations WHERE incident_id = NEW.incident_id AND removed_at IS NULL;
    IF live_orgs = 0 THEN RAISE EXCEPTION 'a status notice needs at least one affected organisation'; END IF;
    SELECT count(*) FILTER (WHERE approved_at > now() - interval '15 minutes'), count(*) FILTER (WHERE approved_at > now() - interval '24 hours')
      INTO recent, daily
    FROM incident_status_notices WHERE incident_id = NEW.incident_id AND id <> NEW.id AND approved_at IS NOT NULL;
    IF recent > 0 OR daily >= 6 THEN RAISE EXCEPTION 'status notice rate limit reached for this incident'; END IF;
    NEW.approved_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'DRAFT' AND NEW.state = 'WITHDRAWN' THEN
    NEW.withdrawn_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'QUEUED' AND NEW.state = 'SENT' THEN
    IF NEW.approved_at <> OLD.approved_at OR NEW.approved_by_user_id <> OLD.approved_by_user_id OR NEW.approve_reason_code <> OLD.approve_reason_code THEN
      RAISE EXCEPTION 'the approval of a status notice is immutable';
    END IF;
    NEW.sent_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid status notice transition';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_status_notice_guard ON incident_status_notices;
CREATE TRIGGER incident_status_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON incident_status_notices
FOR EACH ROW EXECUTE FUNCTION incident_status_notice_guard();

-- ---------------------------------------------------------------------------
-- 7. incident_status_notice_recipients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_status_notice_recipients (
  notice_id uuid NOT NULL REFERENCES incident_status_notices(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  notification_id uuid REFERENCES user_notifications(id) ON DELETE SET NULL,
  email_state text NOT NULL,
  email_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, recipient_user_id)
);

ALTER TABLE incident_status_notice_recipients DROP CONSTRAINT IF EXISTS incident_status_notice_recipient_email_ck;
ALTER TABLE incident_status_notice_recipients ADD CONSTRAINT incident_status_notice_recipient_email_ck CHECK (email_state IN
  ('PENDING', 'SENDING', 'SENT', 'FAILED', 'BOUNCED', 'NOT_CONFIGURED', 'SKIPPED'));
CREATE INDEX IF NOT EXISTS incident_status_notice_recipients_pending_idx
  ON incident_status_notice_recipients (notice_id) WHERE email_state = 'PENDING';

CREATE OR REPLACE FUNCTION incident_status_notice_recipient_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'status notice recipients are never deleted'; END IF;
  IF NEW.notice_id <> OLD.notice_id OR NEW.recipient_user_id <> OLD.recipient_user_id OR NEW.organization_id <> OLD.organization_id
     OR NEW.created_at <> OLD.created_at
     OR (NEW.notification_id IS DISTINCT FROM OLD.notification_id AND NEW.notification_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a status notice recipient changes only its email state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_status_notice_recipient_guard ON incident_status_notice_recipients;
CREATE TRIGGER incident_status_notice_recipient_guard BEFORE UPDATE OR DELETE ON incident_status_notice_recipients
FOR EACH ROW EXECUTE FUNCTION incident_status_notice_recipient_guard();

-- ---------------------------------------------------------------------------
-- 8. user_notifications.kind gains STATUS_NOTICE. Same pattern as 0059/0067/0074 (program rule
--    B.3): keep every kind the live constraint allows and add this one; recreated only when missing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['STATUS_NOTICE'];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('user_notifications') AND c.conname = 'user_notifications_kind_ck';
  SELECT coalesce(array_agg(DISTINCT kind), '{}') INTO existing
  FROM (
    SELECT (regexp_matches(coalesce(current_definition, ''), '''([A-Z0-9_]+)''', 'g'))[1] AS kind
    UNION
    SELECT btrim(unnest(string_to_array((regexp_matches(coalesce(current_definition, ''), '''[{]([A-Z0-9_, ]*)[}]''', 'g'))[1], ',')))
  ) found
  WHERE kind <> '';
  IF current_definition IS NOT NULL AND wanted <@ existing THEN
    RETURN;
  END IF;
  ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_ck;
  EXECUTE format('ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_ck CHECK (kind IN (%s))',
    (SELECT string_agg(DISTINCT quote_literal(kind), ', ')
     FROM unnest(existing || ARRAY['EXAM_ASSIGNED', 'EXAM_REOPENED', 'RESULT_PUBLISHED', 'SYSTEM', 'ANNOUNCEMENT',
       'APPLICATION_STAGE_CHANGED', 'APPLICATION_TERMS_CHANGED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_CHANGED',
       'OFFER_EXTENDED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED', 'EMPLOYER_MESSAGE', 'CANDIDATE_MESSAGE',
       'ASSESSMENT_INVITED'] || wanted) AS kind));
END $$;
