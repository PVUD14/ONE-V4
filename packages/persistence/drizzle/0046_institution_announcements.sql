-- Institution announcements (INST-06): a college tells a cohort about a deadline, a drive or a
-- session, in-app and by email. One row per announcement and one per student who received it.
-- Design and rejected options: docs/architecture/institution-announcements-table-design.md.
-- The migrator replays every file on every run, so everything here is idempotent.

CREATE TABLE IF NOT EXISTS institution_announcements (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  sender_user_id uuid NOT NULL REFERENCES users(id),
  sender_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  sender_role text NOT NULL,
  audience_kind text NOT NULL,
  audience_unit_id uuid,
  title text NOT NULL,
  body text NOT NULL,
  channels text[] NOT NULL,
  email_template_key text NOT NULL,
  email_template_version integer NOT NULL,
  state text NOT NULL DEFAULT 'SCHEDULED',
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  recipient_count integer,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  cancel_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_announcements_audience_unit_fk
    FOREIGN KEY (audience_unit_id, institution_id) REFERENCES institution_units(id, institution_id)
);

ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_sender_role_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_sender_role_ck
  CHECK (sender_role IN ('INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'));
ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_audience_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_audience_ck
  CHECK (audience_kind IN ('INSTITUTION', 'CAMPUS', 'DEPARTMENT', 'PROGRAM', 'BATCH', 'SECTION')
    AND ((audience_kind = 'INSTITUTION') = (audience_unit_id IS NULL)));
ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_text_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_text_ck
  CHECK (length(title) BETWEEN 1 AND 160 AND length(body) BETWEEN 1 AND 500);
-- In-app is always on; email is optional; there is no SMS channel (Appendix 3 §5.5).
ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_channels_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_channels_ck
  CHECK (channels <@ ARRAY['IN_APP', 'EMAIL']::text[] AND 'IN_APP' = ANY (channels));
ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_template_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_template_ck
  CHECK (email_template_key ~ '^[a-z0-9-]{3,64}$' AND email_template_version > 0);
-- SCHEDULED -> SENT or SCHEDULED -> CANCELLED; each state carries exactly its own timestamps.
ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_state_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_state_ck
  CHECK ((state = 'SCHEDULED' AND sent_at IS NULL AND recipient_count IS NULL AND cancelled_at IS NULL)
      OR (state = 'SENT' AND sent_at IS NOT NULL AND recipient_count >= 0 AND cancelled_at IS NULL)
      OR (state = 'CANCELLED' AND cancelled_at IS NOT NULL AND sent_at IS NULL AND recipient_count IS NULL));
ALTER TABLE institution_announcements DROP CONSTRAINT IF EXISTS institution_announcements_cancel_reason_ck;
ALTER TABLE institution_announcements ADD CONSTRAINT institution_announcements_cancel_reason_ck
  CHECK ((cancelled_at IS NULL AND cancel_reason_code IS NULL AND cancelled_by_user_id IS NULL)
      OR (cancelled_at IS NOT NULL AND cancel_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));

CREATE INDEX IF NOT EXISTS institution_announcements_institution_idx
  ON institution_announcements (institution_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS institution_announcements_sender_idx
  ON institution_announcements (sender_user_id, institution_id, created_at DESC);

CREATE TABLE IF NOT EXISTS institution_announcement_recipients (
  announcement_id uuid NOT NULL REFERENCES institution_announcements(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  notification_id uuid REFERENCES user_notifications(id) ON DELETE SET NULL,
  email_state text NOT NULL,
  email_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A student receives one announcement once, whatever is replayed.
  PRIMARY KEY (announcement_id, student_user_id)
);

ALTER TABLE institution_announcement_recipients DROP CONSTRAINT IF EXISTS institution_announcement_recipients_email_state_ck;
ALTER TABLE institution_announcement_recipients ADD CONSTRAINT institution_announcement_recipients_email_state_ck
  CHECK (email_state IN ('NOT_REQUESTED', 'SKIPPED', 'NOT_CONFIGURED', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'BOUNCED'));

CREATE INDEX IF NOT EXISTS institution_announcement_recipients_pending_idx
  ON institution_announcement_recipients (announcement_id) WHERE email_state = 'PENDING';

COMMENT ON COLUMN institution_announcement_recipients.email_state IS
  'NOT_CONFIGURED: no email sender exists yet (production sender is hard gate HG-7); the email was not sent and nothing claims it was.';

-- user_notifications.kind gains ANNOUNCEMENT. The constraint is shared with other goals
-- (program rule B.3), so keep every kind the current constraint allows — whatever migrations
-- ran before this one — plus the 0013 kinds, and add ANNOUNCEMENT. Recreated only when it is
-- missing, so a replay is a no-op. to_regclass follows search_path, like the unqualified DDL.
DO $$
DECLARE
  current_definition text;
  existing text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('user_notifications') AND c.conname = 'user_notifications_kind_ck';
  -- Read the kinds in either form Postgres prints: ARRAY['A'::text, ...] (from an IN list)
  -- or '{A,B}'::text[] (from an array literal).
  SELECT coalesce(array_agg(DISTINCT kind), '{}') INTO existing
  FROM (
    SELECT (regexp_matches(coalesce(current_definition, ''), '''([A-Z0-9_]+)''', 'g'))[1] AS kind
    UNION
    SELECT btrim(unnest(string_to_array((regexp_matches(coalesce(current_definition, ''), '''[{]([A-Z0-9_, ]*)[}]''', 'g'))[1], ',')))
  ) found
  WHERE kind <> '';
  IF current_definition IS NOT NULL AND 'ANNOUNCEMENT' = ANY (existing) THEN
    RETURN;
  END IF;
  ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_ck;
  -- Written as an IN list, like 0013, so the next goal that widens it reads it the same way.
  EXECUTE format('ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_ck CHECK (kind IN (%s))',
    (SELECT string_agg(DISTINCT quote_literal(kind), ', ')
     FROM unnest(existing || ARRAY['EXAM_ASSIGNED', 'EXAM_REOPENED', 'RESULT_PUBLISHED', 'SYSTEM', 'ANNOUNCEMENT']) AS kind));
END $$;
