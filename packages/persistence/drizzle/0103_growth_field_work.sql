-- Growth field work: activities (visits, calls, meetings, notes) and follow-ups (GROWTH-06).
--
-- Design: docs/architecture/growth-field-work-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §13.4–13.5 and §14; ADR-040 (D5, D14 / O-23).
--
-- A visit's location is the staff member's personal data: optional, stored at 3 decimal places by
-- the column type itself, never added or changed after the visit is logged, and erasable once
-- (retention after 180 days, the author's own removal, account erasure). A device-reported time
-- more than 7 days old or in the future is refused on the database clock. Activities and
-- follow-ups are never deleted. Duplicate sends are stopped by the existing idempotency_records
-- (0001); no table is added for them. No earlier migration is edited and no earlier function is
-- redefined. Written idempotently.

-- ---------------------------------------------------------------------------
-- 1. Activities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_activities (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  kind text NOT NULL,
  outcome text,
  contact_id uuid REFERENCES growth_lead_contacts(id),
  notes text,
  notes_erased_at timestamptz,
  author_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  author_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  location_latitude numeric(6, 3),
  location_longitude numeric(7, 3),
  location_accuracy_m integer,
  location_erased_at timestamptz,
  location_erased_reason text
);

ALTER TABLE growth_activities DROP CONSTRAINT IF EXISTS growth_activity_kind_ck;
ALTER TABLE growth_activities ADD CONSTRAINT growth_activity_kind_ck CHECK (kind IN ('VISIT', 'CALL', 'MEETING', 'NOTE'));
ALTER TABLE growth_activities DROP CONSTRAINT IF EXISTS growth_activity_outcome_ck;
ALTER TABLE growth_activities ADD CONSTRAINT growth_activity_outcome_ck CHECK (
  (kind = 'NOTE' AND outcome IS NULL)
  OR (kind <> 'NOTE' AND outcome IN ('MET', 'NOT_AVAILABLE', 'RESCHEDULED', 'DECLINED', 'INTERESTED')));
ALTER TABLE growth_activities DROP CONSTRAINT IF EXISTS growth_activity_notes_ck;
ALTER TABLE growth_activities ADD CONSTRAINT growth_activity_notes_ck CHECK (
  (notes IS NULL OR (length(notes) BETWEEN 1 AND 2000 AND notes !~ '[<>]'))
  AND (notes_erased_at IS NULL OR notes IS NULL));
-- A location is all of latitude, longitude and accuracy, or none; only on the in-person kinds; and
-- once erased it is gone with its reason recorded.
ALTER TABLE growth_activities DROP CONSTRAINT IF EXISTS growth_activity_location_ck;
ALTER TABLE growth_activities ADD CONSTRAINT growth_activity_location_ck CHECK (
  (location_latitude IS NULL AND location_longitude IS NULL AND location_accuracy_m IS NULL)
  OR (location_latitude IS NOT NULL AND location_longitude IS NOT NULL AND location_accuracy_m IS NOT NULL
      AND kind IN ('VISIT', 'MEETING')
      AND location_latitude BETWEEN -90 AND 90 AND location_longitude BETWEEN -180 AND 180
      AND location_accuracy_m BETWEEN 0 AND 50000
      AND location_erased_at IS NULL));
ALTER TABLE growth_activities DROP CONSTRAINT IF EXISTS growth_activity_location_erased_ck;
ALTER TABLE growth_activities ADD CONSTRAINT growth_activity_location_erased_ck CHECK (
  (location_erased_at IS NULL AND location_erased_reason IS NULL)
  OR (location_erased_at IS NOT NULL AND location_latitude IS NULL
      AND location_erased_reason IN ('RETENTION_EXPIRED', 'AUTHOR_REMOVED', 'ACCOUNT_ERASED')));

CREATE INDEX IF NOT EXISTS growth_activities_lead_idx ON growth_activities (lead_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS growth_activities_author_idx ON growth_activities (author_membership_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS growth_activities_located_idx ON growth_activities (received_at) WHERE location_latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_activities_noted_idx ON growth_activities (lead_id) WHERE notes IS NOT NULL;

CREATE OR REPLACE FUNCTION growth_activity_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth activities are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.received_at := now();
    IF NEW.location_erased_at IS NOT NULL OR NEW.notes_erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'a growth activity is logged whole';
    END IF;
    -- Design §14.2: stored as reported, but not more than 7 days old and not in the future
    -- (5 minutes of phone-clock skew are not "the future").
    IF NEW.occurred_at < now() - interval '7 days' THEN
      RAISE EXCEPTION 'growth activity report is more than 7 days old';
    END IF;
    IF NEW.occurred_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'growth activity report is in the future';
    END IF;
    IF EXISTS (SELECT 1 FROM growth_leads WHERE id = NEW.lead_id AND do_not_contact_at IS NOT NULL) THEN
      RAISE EXCEPTION 'growth lead is do-not-contact: no activity may be logged';
    END IF;
    IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM growth_lead_contacts WHERE id = NEW.contact_id AND lead_id = NEW.lead_id) THEN
      RAISE EXCEPTION 'growth activity contact must belong to the same lead';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.lead_id <> OLD.lead_id OR NEW.kind <> OLD.kind OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.author_membership_id <> OLD.author_membership_id
     OR NEW.author_user_id <> OLD.author_user_id OR NEW.occurred_at <> OLD.occurred_at OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'a growth activity can only have its location or notes erased';
  END IF;
  -- The location: never added or changed after the visit is logged; erased once.
  IF NEW.location_latitude IS DISTINCT FROM OLD.location_latitude OR NEW.location_longitude IS DISTINCT FROM OLD.location_longitude
     OR NEW.location_accuracy_m IS DISTINCT FROM OLD.location_accuracy_m
     OR NEW.location_erased_at IS DISTINCT FROM OLD.location_erased_at OR NEW.location_erased_reason IS DISTINCT FROM OLD.location_erased_reason THEN
    IF OLD.location_latitude IS NULL OR NEW.location_latitude IS NOT NULL OR NEW.location_longitude IS NOT NULL
       OR NEW.location_accuracy_m IS NOT NULL OR NEW.location_erased_reason IS NULL OR OLD.location_erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'a growth activity location is never added or changed, only erased once';
    END IF;
    NEW.location_erased_at := now();
  END IF;
  -- The notes: erased once.
  IF NEW.notes IS DISTINCT FROM OLD.notes OR NEW.notes_erased_at IS DISTINCT FROM OLD.notes_erased_at THEN
    IF OLD.notes IS NULL OR NEW.notes IS NOT NULL OR OLD.notes_erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'growth activity notes are never changed, only erased once';
    END IF;
    NEW.notes_erased_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_activity_guard ON growth_activities;
CREATE TRIGGER growth_activity_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_activities
  FOR EACH ROW EXECUTE FUNCTION growth_activity_guard();

COMMENT ON TABLE growth_activities IS
  'GROWTH-06: visits, calls, meetings and notes about a lead. Location optional, 3 decimal places, seen by the author and their manager only, erased after 180 days (O-23). Never deleted.';

-- ---------------------------------------------------------------------------
-- 2. Follow-ups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_follow_ups (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES growth_leads(id),
  assignee_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activity_id uuid REFERENCES growth_activities(id),
  due_on date NOT NULL,
  title text,
  title_erased_at timestamptz,
  state text NOT NULL DEFAULT 'OPEN',
  closed_at timestamptz,
  closed_by_user_id uuid REFERENCES users(id),
  cancel_reason_code text
);

ALTER TABLE growth_follow_ups DROP CONSTRAINT IF EXISTS growth_follow_up_title_ck;
ALTER TABLE growth_follow_ups ADD CONSTRAINT growth_follow_up_title_ck CHECK (
  (title IS NOT NULL AND title_erased_at IS NULL AND length(title) BETWEEN 1 AND 280 AND title !~ '[<>]')
  OR (title IS NULL AND title_erased_at IS NOT NULL));
ALTER TABLE growth_follow_ups DROP CONSTRAINT IF EXISTS growth_follow_up_state_ck;
ALTER TABLE growth_follow_ups ADD CONSTRAINT growth_follow_up_state_ck CHECK (
  (state = 'OPEN' AND closed_at IS NULL AND closed_by_user_id IS NULL AND cancel_reason_code IS NULL)
  OR (state = 'DONE' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL AND cancel_reason_code IS NULL)
  OR (state = 'CANCELLED' AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
      AND cancel_reason_code IN ('NO_LONGER_NEEDED', 'LEAD_LOST', 'DUPLICATE', 'REASSIGNED', 'OTHER')));

CREATE INDEX IF NOT EXISTS growth_follow_ups_assignee_idx ON growth_follow_ups (assignee_membership_id, due_on, id) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS growth_follow_ups_lead_idx ON growth_follow_ups (lead_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION growth_follow_up_guard() RETURNS trigger AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth follow-ups are never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.state <> 'OPEN' OR NEW.title_erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'a growth follow-up starts open';
    END IF;
    IF NEW.due_on < today - 7 OR NEW.due_on > today + 366 THEN
      RAISE EXCEPTION 'growth follow-up due date is out of range';
    END IF;
    IF EXISTS (SELECT 1 FROM growth_leads WHERE id = NEW.lead_id AND do_not_contact_at IS NOT NULL) THEN
      RAISE EXCEPTION 'growth lead is do-not-contact: no follow-up may be added';
    END IF;
    IF NEW.activity_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM growth_activities WHERE id = NEW.activity_id AND lead_id = NEW.lead_id) THEN
      RAISE EXCEPTION 'growth follow-up activity must belong to the same lead';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.lead_id <> OLD.lead_id OR NEW.assignee_membership_id <> OLD.assignee_membership_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at
     OR NEW.activity_id IS DISTINCT FROM OLD.activity_id OR NEW.due_on <> OLD.due_on THEN
    RAISE EXCEPTION 'a growth follow-up can only be closed once or have its title erased';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.closed_by_user_id IS DISTINCT FROM OLD.closed_by_user_id OR NEW.cancel_reason_code IS DISTINCT FROM OLD.cancel_reason_code THEN
    IF OLD.state <> 'OPEN' OR NEW.state NOT IN ('DONE', 'CANCELLED') THEN
      RAISE EXCEPTION 'a growth follow-up is closed once';
    END IF;
    NEW.closed_at := now();
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.title_erased_at IS DISTINCT FROM OLD.title_erased_at THEN
    IF OLD.title IS NULL OR NEW.title IS NOT NULL THEN
      RAISE EXCEPTION 'a growth follow-up title is never changed, only erased once';
    END IF;
    NEW.title_erased_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_follow_up_guard ON growth_follow_ups;
CREATE TRIGGER growth_follow_up_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_follow_ups
  FOR EACH ROW EXECUTE FUNCTION growth_follow_up_guard();

COMMENT ON TABLE growth_follow_ups IS
  'GROWTH-06: what a growth person must do next about a lead, with a due date; reminders are scheduled on the phone. Never deleted.';
