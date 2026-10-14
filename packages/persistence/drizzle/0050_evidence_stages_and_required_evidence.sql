-- ENG-04: evidence stages, the assisted flag and required evidence types.
--
-- Design: docs/architecture/evidence-stages-table-design.md. The rules live in
-- packages/learning-model (learning-model-v1); these columns only hold what those rules
-- said at the moment a record was captured.
--
-- evidence_records stays immutable (0004 trigger). Adding a column with a constant default
-- rewrites no row and fires no row trigger, so existing rows read the defaults, which are the
-- conservative ones: no hints existed before ENG-15, so assisted = false is true of every
-- existing row, and ESTIMATED is the lowest stage. Nothing is back-filled.
--
-- Idempotent, because the migrator replays every file on every run: ADD COLUMN IF NOT EXISTS,
-- and each CHECK dropped and re-added. Only 0004 and 0011 tables are referenced.

ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS assisted boolean NOT NULL DEFAULT false;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS stage_at_capture text NOT NULL DEFAULT 'ESTIMATED';
ALTER TABLE evidence_records DROP CONSTRAINT IF EXISTS evidence_stage_at_capture_ck;
ALTER TABLE evidence_records ADD CONSTRAINT evidence_stage_at_capture_ck
  CHECK (stage_at_capture IN ('ESTIMATED','RETAINED','DEMONSTRATED','TRANSFERRED'));

COMMENT ON COLUMN evidence_records.assisted IS
  'True when any graded response behind this row was assisted (hint 3+ or an AI tutor reply). Fixed at insert.';
COMMENT ON COLUMN evidence_records.stage_at_capture IS
  'The stage (learning-model-v1) the skill had reached, including this evidence, when it was recorded. Fixed at insert; the live stage is a projection (ENG-05).';

-- Required evidence types per career requirement. Empty means none is required, which is
-- what every existing requirement gets; the vocabulary is evidence_records.evidence_type, so a
-- requirement can only ask for evidence the product can record.
ALTER TABLE career_role_requirements ADD COLUMN IF NOT EXISTS required_evidence_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE career_role_requirements DROP CONSTRAINT IF EXISTS career_requirement_evidence_types_ck;
ALTER TABLE career_role_requirements ADD CONSTRAINT career_requirement_evidence_types_ck
  CHECK (array_position(required_evidence_types, NULL) IS NULL
    AND required_evidence_types <@ ARRAY['LESSON_COMPLETION','ASSESSMENT_OUTCOME','TOPIC_DEMONSTRATION']::text[]);

COMMENT ON COLUMN career_role_requirements.required_evidence_types IS
  'Evidence types a student must hold, unaided, for this requirement''s topic (learning-model-v1 checkRequiredEvidenceTypes). Empty = none.';
