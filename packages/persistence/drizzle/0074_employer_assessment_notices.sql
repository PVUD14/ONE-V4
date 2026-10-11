-- EMP-12: a student is told when an employer sends them a screening test.
--
-- Design: docs/architecture/employer-assessment-windows-and-notices-design.md (section 7); ADR-039.
-- The invitation route writes `employer_assessment.invited` to the outbox; the EMP-08 hiring
-- notification consumer delivers it as an ASSESSMENT_INVITED notice. That kind has to be allowed by
-- the two CHECK lists that name notification kinds. Nothing else changes: no table is added, and the
-- 0036 assessment tables are untouched.
--
-- Both lists are widened by read-and-union (program rule B.3, as 0059 and 0067 did): every kind the
-- live constraint already allows is kept, ASSESSMENT_INVITED is added, and the constraint is recreated
-- only when that kind is missing, so replaying this file changes nothing.

DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['ASSESSMENT_INVITED'];
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
       'OFFER_EXTENDED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED', 'EMPLOYER_MESSAGE', 'CANDIDATE_MESSAGE'] || wanted) AS kind));
END $$;

-- The delivery log (0059, widened by 0067) records the same kind. Read-and-union here too, so a kind
-- another migration adds is never dropped.
DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['ASSESSMENT_INVITED'];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('hiring_notification_deliveries') AND c.conname = 'hiring_notification_deliveries_kind_ck';
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
  ALTER TABLE hiring_notification_deliveries DROP CONSTRAINT IF EXISTS hiring_notification_deliveries_kind_ck;
  EXECUTE format('ALTER TABLE hiring_notification_deliveries ADD CONSTRAINT hiring_notification_deliveries_kind_ck CHECK (kind IN (%s))',
    (SELECT string_agg(DISTINCT quote_literal(kind), ', ')
     FROM unnest(existing || ARRAY['APPLICATION_STAGE_CHANGED', 'APPLICATION_TERMS_CHANGED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_CHANGED',
       'OFFER_EXTENDED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRING', 'OFFER_RESPONDED', 'EMPLOYER_MESSAGE', 'CANDIDATE_MESSAGE'] || wanted) AS kind));
END $$;
