-- EMP-08: student hiring notifications and the student interview view.
--
-- Students were never told about stage changes, interviews or offers (Appendix 2 defect D-6).
-- This adds the hiring notification kinds, a delivery log that makes each notice exactly-once
-- per event and recipient and records whether its email left, and the preparation note an
-- employer can give a candidate for an interview.
-- Design: docs/architecture/hiring-notification-deliveries-table-design.md.
-- Idempotent: every statement is guarded, so a replay (bootstrap, ADR-035) is a no-op.

-- user_notifications.kind gains the hiring kinds. Shared constraint (program rule B.3): keep
-- every kind the current constraint allows — 0013's, 0046's ANNOUNCEMENT, and anything another
-- goal added — and add these. Recreated only when one is missing.
DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['APPLICATION_STAGE_CHANGED', 'APPLICATION_TERMS_CHANGED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_CHANGED',
                         'OFFER_EXTENDED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED', 'EMPLOYER_MESSAGE'];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('user_notifications') AND c.conname = 'user_notifications_kind_ck';
  -- Either form Postgres prints: ARRAY['A'::text, ...] or '{A,B}'::text[].
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
  -- An IN list, like 0013 and 0046, so the next goal that widens it reads it the same way.
  EXECUTE format('ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_ck CHECK (kind IN (%s))',
    (SELECT string_agg(DISTINCT quote_literal(kind), ', ')
     FROM unnest(existing || ARRAY['EXAM_ASSIGNED', 'EXAM_REOPENED', 'RESULT_PUBLISHED', 'SYSTEM', 'ANNOUNCEMENT'] || wanted) AS kind));
END $$;

-- What the candidate should prepare, set by the employer when scheduling; shown to the student.
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS preparation_note text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('interviews') AND conname = 'interviews_preparation_note_ck') THEN
    ALTER TABLE interviews ADD CONSTRAINT interviews_preparation_note_ck
      CHECK (preparation_note IS NULL OR length(preparation_note) BETWEEN 1 AND 1000);
  END IF;
END $$;

-- One row per outbox event and person notified: the in-app copy and the email outcome.
CREATE TABLE IF NOT EXISTS hiring_notification_deliveries (
  source_event_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  recipient_kind text NOT NULL,
  application_id uuid NOT NULL REFERENCES applications(id),
  kind text NOT NULL,
  notification_id uuid REFERENCES user_notifications(id) ON DELETE SET NULL,
  email_template_key text,
  email_template_version integer,
  email_state text NOT NULL,
  email_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hiring_notification_deliveries_pk PRIMARY KEY (source_event_id, recipient_user_id),
  CONSTRAINT hiring_notification_deliveries_recipient_kind_ck CHECK (recipient_kind IN ('STUDENT', 'EMPLOYER_MEMBER')),
  CONSTRAINT hiring_notification_deliveries_kind_ck CHECK (kind IN ('APPLICATION_STAGE_CHANGED', 'APPLICATION_TERMS_CHANGED',
    'INTERVIEW_SCHEDULED', 'INTERVIEW_CHANGED', 'OFFER_EXTENDED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED')),
  CONSTRAINT hiring_notification_deliveries_email_state_ck CHECK (email_state IN ('NOT_REQUESTED', 'SKIPPED', 'NOT_CONFIGURED',
    'PENDING', 'SENDING', 'SENT', 'FAILED', 'BOUNCED')),
  -- No template exactly when no email was requested; a requested email always names its template.
  CONSTRAINT hiring_notification_deliveries_template_ck CHECK (
    (email_state = 'NOT_REQUESTED') = (email_template_key IS NULL)
    AND (email_template_key IS NULL) = (email_template_version IS NULL)),
  CONSTRAINT hiring_notification_deliveries_template_version_ck CHECK (email_template_version IS NULL OR email_template_version > 0),
  CONSTRAINT hiring_notification_deliveries_attempt_ck CHECK (
    email_attempted_at IS NULL OR email_state IN ('SENDING', 'SENT', 'FAILED', 'BOUNCED'))
);
CREATE INDEX IF NOT EXISTS hiring_notification_deliveries_application_idx
  ON hiring_notification_deliveries (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hiring_notification_deliveries_pending_idx
  ON hiring_notification_deliveries (source_event_id) WHERE email_state = 'PENDING';

COMMENT ON COLUMN hiring_notification_deliveries.email_state IS
  'NOT_CONFIGURED: no email sender exists yet (hard gate HG-7); the email was not sent and nothing claims it was.';
