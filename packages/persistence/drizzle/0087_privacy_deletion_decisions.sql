-- Privacy deletion carries out Divakar's 2026-09-30 decisions (fix/privacy-deletion-decisions).
--
-- Design: docs/architecture/privacy-export-coverage.md, "Deletion decisions". Three things change in the
-- schema; everything else is in the deletion executor.
--
-- 1. Two new deletion categories. STAFF_ACTIONS (ERASED): the text of every staff-only college action
--    about the person. CONSENT_RECORDS (RETAINED, with a basis): the person's consent grants and
--    withdrawals, kept as proof on the anonymised account. The deletion record's category CHECK (0009,
--    widened by 0043, 0047, 0060, 0067, 0077) must allow both. Widened by read-and-union, as 0074 and 0077
--    do: every category the live constraint already allows is kept, the full list known today is unioned
--    in, the two new values are added, and the constraint is recreated only when one of them is missing,
--    so running this file again changes nothing and no earlier value is ever dropped.
--
-- 2. Readiness-check attempts can be erased. 0004's protect_submitted_attempt() refuses to change or
--    delete a submitted attempt, and for any other attempt a DELETE silently did nothing (it returned NEW,
--    which is NULL on DELETE), so no attempt could ever be removed. The function is replaced with exactly
--    that behaviour plus one exception, the 0047 pattern: a DELETE is allowed inside the privacy-erase
--    transaction for the attempt's own subject (transaction-local one.privacy_erase_subject). The 0004
--    trigger keeps calling the function by name, so no trigger changes.
--
-- References only tables from 0085 or earlier.

DO $$
DECLARE
  current_definition text;
  existing text[];
  wanted text[] := ARRAY['STAFF_ACTIONS', 'CONSENT_RECORDS'];
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
       'APPLICATION_MESSAGES', 'EMPLOYER_SCREENING'] || wanted) AS category));
END $$;

CREATE OR REPLACE FUNCTION protect_submitted_attempt()
RETURNS trigger AS $$
BEGIN
  -- The privacy deletion of this attempt's own subject, and nothing else, may remove it (0087).
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
    RETURN OLD;
  END IF;
  -- Unchanged since 0004: a submitted attempt is immutable, and any other DELETE does nothing.
  IF OLD.state = 'SUBMITTED' THEN RAISE EXCEPTION 'submitted assessment attempts are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. The learning-history rows 0004 made immutable can be erased for their own subject. 0004 put
--    reject_immutable_row_change() (no change, no delete, ever) on a list of tables that includes
--    mastery_projections, readiness_snapshots, readiness_factors, assessment_attempt_items and
--    assessment_responses. The shared function stays exactly as it is, for every table on that list
--    (evidence_records and the content, review and delivery logs keep it). For these five only, the
--    trigger of the same name now calls a function that behaves identically except for one case: a
--    DELETE inside the privacy-erase transaction whose one.privacy_erase_subject is the row's own
--    subject — read from the row, or for a child row from the parent it belongs to (a factor's snapshot
--    or projection, an item's attempt, a response's item's attempt), which the executor deletes after
--    its children. An UPDATE is still always refused, and so is any DELETE for anyone else.
CREATE OR REPLACE FUNCTION reject_immutable_learning_history_change()
RETURNS trigger AS $$
DECLARE
  erase_subject text := current_setting('one.privacy_erase_subject', true);
  owner text;
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(erase_subject, '') <> '' THEN
    IF TG_TABLE_NAME IN ('mastery_projections', 'readiness_snapshots') THEN
      owner := OLD.subject_user_id::text;
    ELSIF TG_TABLE_NAME = 'readiness_factors' THEN
      SELECT s.subject_user_id::text INTO owner FROM readiness_snapshots s WHERE s.id = OLD.snapshot_id;
      IF owner IS DISTINCT FROM erase_subject THEN
        SELECT p.subject_user_id::text INTO owner FROM mastery_projections p WHERE p.id = OLD.mastery_projection_id;
      END IF;
    ELSIF TG_TABLE_NAME = 'assessment_attempt_items' THEN
      SELECT a.subject_user_id::text INTO owner FROM assessment_attempts a WHERE a.id = OLD.attempt_id;
    ELSIF TG_TABLE_NAME = 'assessment_responses' THEN
      SELECT a.subject_user_id::text INTO owner
      FROM assessment_attempt_items i JOIN assessment_attempts a ON a.id = i.attempt_id WHERE i.id = OLD.attempt_item_id;
    END IF;
    IF owner = erase_subject THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'immutable record cannot be changed';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['mastery_projections', 'readiness_snapshots', 'readiness_factors', 'assessment_attempt_items', 'assessment_responses']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_immutable_guard ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_learning_history_change()', table_name, table_name);
  END LOOP;
END $$;
