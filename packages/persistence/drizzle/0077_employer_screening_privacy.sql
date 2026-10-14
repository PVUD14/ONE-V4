-- Privacy deletion covers employer screening attempts (the EMP-12 privacy fix).
--
-- Design: docs/architecture/employer-screening-privacy-design.md. Deletion records a new category,
-- EMPLOYER_SCREENING (ANONYMISED): the attempt and its score stay for the employer, detached from the
-- person, and the candidate's selected answers are erased. The deletion record's category CHECK
-- (0009, widened by 0067) has to allow that value. Nothing else changes: the 0036 tables carry no
-- append-only trigger, so no guard is relaxed.
--
-- Widened by read-and-union (program rule B.3, as 0067 and 0074 did): every category the live
-- constraint already allows is kept, EMPLOYER_SCREENING is added, and the constraint is recreated only
-- when that value is missing, so replaying this file changes nothing. 0067's own guard looks only for
-- APPLICATION_MESSAGES, so replaying 0067 before this file leaves the widened constraint alone.

DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['EMPLOYER_SCREENING'];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('privacy_deletion_records') AND c.conname = 'privacy_deletion_category_ck';
  SELECT coalesce(array_agg(DISTINCT category), '{}') INTO existing
  FROM (
    SELECT (regexp_matches(coalesce(current_definition, ''), '''([A-Z0-9_]+)''', 'g'))[1] AS category
    UNION
    SELECT btrim(unnest(string_to_array((regexp_matches(coalesce(current_definition, ''), '''[{]([A-Z0-9_, ]*)[}]''', 'g'))[1], ',')))
  ) found
  WHERE category <> '';
  IF current_definition IS NOT NULL AND wanted <@ existing THEN
    RETURN;
  END IF;
  ALTER TABLE privacy_deletion_records DROP CONSTRAINT IF EXISTS privacy_deletion_category_ck;
  EXECUTE format('ALTER TABLE privacy_deletion_records ADD CONSTRAINT privacy_deletion_category_ck CHECK (category IN (%s))',
    (SELECT string_agg(DISTINCT quote_literal(category), ', ')
     FROM unnest(existing || ARRAY['IDENTITY', 'STUDENT_PROFILE', 'INSTITUTION_ROSTER', 'DOCUMENTS', 'APPLICATIONS', 'OFFERS',
       'ASSESSMENT_EVIDENCE', 'NOTIFICATIONS', 'AUDIT', 'SUPPORT_CASES', 'LEARNING_ACTIVITY', 'COUNSELLING_NOTES',
       'APPLICATION_MESSAGES'] || wanted) AS category));
END $$;
