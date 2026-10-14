-- EMP-10: application-bound messages between an employer and a candidate.
--
-- Recruiters and candidates had no way to coordinate inside ONE, so they swapped personal numbers
-- early — the off-application contact Appendix 2 §0.5 forbids. One thread per application, text
-- only, readable by the employer only while the student's applicant-access grant is live, erased on
-- privacy deletion and 180 days after the grant ends, reportable by the student into a trust case.
-- Design: docs/architecture/application-messages-table-design.md.
-- Idempotent: every statement is guarded, so a replay (bootstrap, ADR-035) is a no-op.

CREATE TABLE IF NOT EXISTS application_message_threads (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  opportunity_id uuid NOT NULL,
  started_by_user_id uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  student_muted_at timestamptz,
  CONSTRAINT application_message_threads_application_uq UNIQUE (application_id),
  -- The thread is pinned to its application's own employer, student and job: the grant is looked
  -- up by exactly these three, so none of them can be made to disagree with the application.
  CONSTRAINT application_message_threads_employer_fk FOREIGN KEY (application_id, employer_id) REFERENCES applications(id, employer_id),
  CONSTRAINT application_message_threads_student_fk FOREIGN KEY (application_id, student_user_id) REFERENCES applications(id, student_user_id),
  CONSTRAINT application_message_threads_opportunity_fk FOREIGN KEY (application_id, opportunity_id) REFERENCES applications(id, opportunity_id),
  CONSTRAINT application_message_threads_order_ck CHECK (last_message_at >= started_at),
  CONSTRAINT application_message_threads_mute_ck CHECK (student_muted_at IS NULL OR student_muted_at >= started_at)
);
CREATE INDEX IF NOT EXISTS application_message_threads_employer_idx
  ON application_message_threads (employer_id, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS application_message_threads_student_idx
  ON application_message_threads (student_user_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS application_messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES application_message_threads(id),
  sender_side text NOT NULL,
  sender_user_id uuid NOT NULL REFERENCES users(id),
  body text,
  contains_link boolean NOT NULL DEFAULT false,
  sent_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  reported_at timestamptz,
  report_reason_code text,
  trust_case_id uuid REFERENCES trust_cases(id),
  erased_at timestamptz,
  erasure_reason text,
  CONSTRAINT application_messages_side_ck CHECK (sender_side IN ('EMPLOYER', 'STUDENT')),
  -- Text only, at most 2,000 characters, and never empty; NULL exactly when erased, with a reason.
  CONSTRAINT application_messages_body_ck CHECK (
    (erased_at IS NULL AND body IS NOT NULL AND length(btrim(body)) >= 1 AND length(body) <= 2000 AND erasure_reason IS NULL)
    OR (erased_at IS NOT NULL AND body IS NULL AND erasure_reason IN ('PRIVACY_DELETION', 'RETENTION_EXPIRED'))),
  CONSTRAINT application_messages_read_ck CHECK (read_at IS NULL OR read_at >= sent_at),
  -- Only a student reports, only an employer's message, and the three report columns go together.
  CONSTRAINT application_messages_report_ck CHECK (
    (reported_at IS NULL AND report_reason_code IS NULL AND trust_case_id IS NULL)
    OR (reported_at IS NOT NULL AND sender_side = 'EMPLOYER' AND trust_case_id IS NOT NULL
        AND report_reason_code IN ('SCAM_OR_PAYMENT_REQUEST', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'OFF_PLATFORM_PRESSURE', 'DISCRIMINATION', 'OTHER')))
);
CREATE INDEX IF NOT EXISTS application_messages_thread_idx ON application_messages (thread_id, sent_at, id);
CREATE INDEX IF NOT EXISTS application_messages_unread_idx ON application_messages (thread_id, sender_side) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS application_messages_sender_idx ON application_messages (sender_user_id, sent_at DESC);

-- Append-only: who sent what, when and where never changes. The body changes only to NULL together
-- with an erasure; the read time and the report are set once; nothing is ever deleted.
CREATE OR REPLACE FUNCTION application_messages_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'application messages are never deleted; erase the body instead';
  END IF;
  IF NEW.id <> OLD.id OR NEW.thread_id <> OLD.thread_id OR NEW.sender_side <> OLD.sender_side
     OR NEW.sender_user_id <> OLD.sender_user_id OR NEW.sent_at <> OLD.sent_at OR NEW.contains_link <> OLD.contains_link THEN
    RAISE EXCEPTION 'an application message cannot be rewritten';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body AND NOT (NEW.body IS NULL AND NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL) THEN
    RAISE EXCEPTION 'an application message body can only be erased';
  END IF;
  IF OLD.erased_at IS NOT NULL AND (NEW.erased_at IS DISTINCT FROM OLD.erased_at OR NEW.erasure_reason IS DISTINCT FROM OLD.erasure_reason) THEN
    RAISE EXCEPTION 'an erasure cannot be undone';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'a read time is set once';
  END IF;
  IF OLD.reported_at IS NOT NULL AND (NEW.reported_at IS DISTINCT FROM OLD.reported_at
     OR NEW.report_reason_code IS DISTINCT FROM OLD.report_reason_code OR NEW.trust_case_id IS DISTINCT FROM OLD.trust_case_id) THEN
    RAISE EXCEPTION 'a report is set once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS application_messages_append_only_guard ON application_messages;
CREATE TRIGGER application_messages_append_only_guard
  BEFORE UPDATE OR DELETE ON application_messages
  FOR EACH ROW EXECUTE FUNCTION application_messages_append_only();

COMMENT ON TABLE application_message_threads IS
  'One conversation per application. Employers read it only while the student''s applicant-access grant is live.';
COMMENT ON TABLE application_messages IS
  'Append-only. Text only (<= 2000 chars), no attachments. Erased on privacy deletion and 180 days after the grant ends. Report columns are never shown to the employer.';

-- user_notifications.kind gains CANDIDATE_MESSAGE (a candidate replied; employer, in-app only).
-- EMPLOYER_MESSAGE was reserved by 0059. Same pattern as 0059 (program rule B.3): keep every kind
-- the current constraint allows and add these; recreated only when one is missing.
DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['EMPLOYER_MESSAGE', 'CANDIDATE_MESSAGE'];
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
       'OFFER_EXTENDED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED'] || wanted) AS kind));
END $$;

-- The delivery log records the two message kinds. Every kind 0059 allowed, plus these.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('hiring_notification_deliveries') AND c.conname = 'hiring_notification_deliveries_kind_ck'
      AND pg_get_constraintdef(c.oid) LIKE '%CANDIDATE_MESSAGE%'
  ) THEN
    ALTER TABLE hiring_notification_deliveries DROP CONSTRAINT IF EXISTS hiring_notification_deliveries_kind_ck;
    ALTER TABLE hiring_notification_deliveries ADD CONSTRAINT hiring_notification_deliveries_kind_ck CHECK (kind IN (
      'APPLICATION_STAGE_CHANGED', 'APPLICATION_TERMS_CHANGED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_CHANGED', 'OFFER_EXTENDED',
      'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED', 'EMPLOYER_MESSAGE', 'CANDIDATE_MESSAGE'));
  END IF;
END $$;

-- A reported conversation is trust-case evidence by reference: the thread, and the message reported.
-- Every kind 0032 allowed, plus these two.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('trust_case_evidence') AND c.conname = 'trust_case_evidence_kind_ck'
      AND pg_get_constraintdef(c.oid) LIKE '%APPLICATION_MESSAGE_THREAD%'
  ) THEN
    ALTER TABLE trust_case_evidence DROP CONSTRAINT IF EXISTS trust_case_evidence_kind_ck;
    ALTER TABLE trust_case_evidence ADD CONSTRAINT trust_case_evidence_kind_ck CHECK (evidence_kind IN (
      'REVIEW_SIGNAL', 'OPPORTUNITY_VERSION', 'DOCUMENT_VERSION', 'AUDIT_CORRELATION', 'REPORTER_STATEMENT',
      'APPLICATION_MESSAGE_THREAD', 'APPLICATION_MESSAGE'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS trust_case_evidence_reference_idx ON trust_case_evidence (evidence_kind, reference_id);

-- Privacy deletion erases message text (APPLICATION_MESSAGES, ERASED). The full category list:
-- every value 0060 allowed, plus the new one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('privacy_deletion_records') AND c.conname = 'privacy_deletion_category_ck'
      AND pg_get_constraintdef(c.oid) LIKE '%APPLICATION_MESSAGES%'
  ) THEN
    ALTER TABLE privacy_deletion_records DROP CONSTRAINT IF EXISTS privacy_deletion_category_ck;
    ALTER TABLE privacy_deletion_records ADD CONSTRAINT privacy_deletion_category_ck CHECK (category IN (
      'IDENTITY','STUDENT_PROFILE','INSTITUTION_ROSTER','DOCUMENTS','APPLICATIONS','OFFERS','ASSESSMENT_EVIDENCE','NOTIFICATIONS','AUDIT',
      'SUPPORT_CASES','LEARNING_ACTIVITY','COUNSELLING_NOTES','APPLICATION_MESSAGES'
    ));
  END IF;
END $$;
