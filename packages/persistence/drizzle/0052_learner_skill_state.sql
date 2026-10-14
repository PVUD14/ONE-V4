-- ENG-05: the learner skill state projection, and ENG-07's link from a graded option to the
-- misconception codes it signalled.
--
-- learner_skill_state is a projection: one row per student per skill, computed from facts
-- (the attempt log, the published misconception catalogue, the exam subject mapping) by the
-- projector in packages/persistence/src/learner-skill-state.ts. It is never edited by hand:
-- a trigger lets only the projector write it, and privacy deletion remove a subject's rows.
-- Design: docs/architecture/learner-skill-state-table-design.md. Idempotent, because the
-- migrator replays every file on every run; references only tables created before 0052.

-- ---------------------------------------------------------------------------
-- The attempt log's misconception link (designed in misconception-codes-table-design.md)
-- ---------------------------------------------------------------------------
-- Constant defaults: a catalogue change that rewrites no row and fires no row trigger, so the
-- append-only trigger from 0047 is untouched and existing rows read NULL / '{}'.
ALTER TABLE learning_attempt_events ADD COLUMN IF NOT EXISTS selected_option_id text;
ALTER TABLE learning_attempt_events ADD COLUMN IF NOT EXISTS misconception_code_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_selected_option_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_selected_option_ck
  CHECK (selected_option_id IS NULL OR (answered AND length(selected_option_id) BETWEEN 1 AND 64));
ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_misconception_ids_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_misconception_ids_ck
  CHECK (array_position(misconception_code_ids, NULL) IS NULL AND cardinality(misconception_code_ids) <= 16);
-- A correct answer (or a blank) signals no misconception.
ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_correct_signals_nothing_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_correct_signals_nothing_ck
  CHECK (cardinality(misconception_code_ids) = 0 OR (answered AND NOT correct));

-- ---------------------------------------------------------------------------
-- learner_skill_state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS learner_skill_state (
  subject_user_id uuid NOT NULL REFERENCES users(id),
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  institution_id uuid REFERENCES organizations(id),
  attempt_count integer NOT NULL,
  attempt_day_count integer NOT NULL,
  unaided_success_count integer NOT NULL,
  unaided_success_day_count integer NOT NULL,
  assisted_success_count integer NOT NULL,
  last_attempt_at timestamptz,
  evidence_stage text NOT NULL,
  evidence_band text NOT NULL,
  active_misconception_codes text[] NOT NULL DEFAULT '{}',
  mastery_likelihood numeric(5,4),
  mastery_uncertainty numeric(5,4),
  mastery_algorithm_version text,
  review_stability numeric(10,4),
  review_difficulty numeric(6,4),
  review_due_at timestamptz,
  review_algorithm_version text,
  algorithm_version text NOT NULL,
  CONSTRAINT learner_skill_state_pk PRIMARY KEY (subject_user_id, skill_id)
);

ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_counts_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_counts_ck CHECK (
  attempt_count >= 0 AND attempt_day_count >= 0 AND attempt_day_count <= attempt_count
  AND unaided_success_count >= 0 AND assisted_success_count >= 0
  AND unaided_success_count + assisted_success_count <= attempt_count
  AND unaided_success_day_count >= 0 AND unaided_success_day_count <= unaided_success_count
);
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_last_attempt_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_last_attempt_ck
  CHECK ((last_attempt_at IS NULL) = (attempt_count = 0));
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_stage_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_stage_ck
  CHECK (evidence_stage IN ('ESTIMATED','RETAINED','DEMONSTRATED','TRANSFERRED'));
-- A per-skill evidence band in the mastery_projections vocabulary; never readiness.
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_band_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_band_ck
  CHECK (evidence_band IN ('NOT_ENOUGH_EVIDENCE','DEVELOPING','PROGRESSING','DEMONSTRATED'));
-- C3 at the data layer: fewer than two attempt days is never a band.
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_sufficiency_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_sufficiency_ck
  CHECK (attempt_day_count >= 2 OR evidence_band = 'NOT_ENOUGH_EVIDENCE');
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_codes_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_codes_ck
  CHECK (array_position(active_misconception_codes, NULL) IS NULL AND cardinality(active_misconception_codes) <= 64);
-- Model state (ENG-06, ENG-09) never appears without the algorithm that produced it.
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_mastery_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_mastery_ck CHECK (
  (mastery_likelihood IS NULL OR mastery_likelihood BETWEEN 0 AND 1)
  AND (mastery_uncertainty IS NULL OR mastery_uncertainty BETWEEN 0 AND 1)
  AND ((mastery_algorithm_version IS NULL) = (mastery_likelihood IS NULL AND mastery_uncertainty IS NULL))
  AND (mastery_algorithm_version IS NULL OR length(mastery_algorithm_version) BETWEEN 1 AND 64)
);
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_review_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_review_ck CHECK (
  (review_stability IS NULL OR review_stability > 0)
  AND ((review_algorithm_version IS NULL) = (review_stability IS NULL AND review_difficulty IS NULL AND review_due_at IS NULL))
  AND (review_algorithm_version IS NULL OR length(review_algorithm_version) BETWEEN 1 AND 64)
);
ALTER TABLE learner_skill_state DROP CONSTRAINT IF EXISTS learner_skill_state_algorithm_ck;
ALTER TABLE learner_skill_state ADD CONSTRAINT learner_skill_state_algorithm_ck
  CHECK (length(algorithm_version) BETWEEN 1 AND 64);

CREATE INDEX IF NOT EXISTS learner_skill_state_institution_idx ON learner_skill_state(institution_id, skill_id);
CREATE INDEX IF NOT EXISTS learner_skill_state_skill_idx ON learner_skill_state(skill_id);

-- Only the projector writes; privacy deletion may remove the named subject's rows. The
-- projector sets the transaction-local one.learner_skill_state_writer; the deletion executor
-- sets one.privacy_erase_subject (0047). A guard against application mistakes, with the same
-- standing as the 0004 and 0047 triggers.
CREATE OR REPLACE FUNCTION guard_learner_skill_state_write()
RETURNS trigger AS $$
BEGIN
  IF current_setting('one.learner_skill_state_writer', true) = 'learner-skill-state-projector' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learner_skill_state is a projection; only the projector writes it';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS learner_skill_state_projector_only ON learner_skill_state;
CREATE TRIGGER learner_skill_state_projector_only
  BEFORE INSERT OR UPDATE OR DELETE ON learner_skill_state
  FOR EACH ROW EXECUTE FUNCTION guard_learner_skill_state_write();
