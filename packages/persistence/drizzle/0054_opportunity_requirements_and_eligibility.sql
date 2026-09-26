-- Job requirements and frozen application eligibility evaluations (EMP-06).
--
-- Design: docs/architecture/application-eligibility-evaluations-table-design.md
--
-- 1. application_eligibility_evaluations: what was true about an applicant's eligibility when
--    they applied (and again when they accept a version whose eligibility changed), written once.
--    It carries each rule's outcome and its basis (VERIFIED, INSTITUTION_RECORD, SELF_REPORTED),
--    never the student's figures.
-- 2. opportunity_skill_requirements.taxonomy_topic_id: a job skill picked from the ONE skill
--    catalogue (OPS-08) points at its topic, so EMP-13 can match consented evidence without a
--    name-based guess. Free-text skills keep it NULL.
-- 3. opportunity_versions.career_role_id: the catalogue role a job version maps to (EMP-13).
--
-- Additive only; every 0007 constraint is kept and nothing is backfilled. References only tables
-- created before 0054 (users 0001, taxonomy_nodes 0004, opportunity_* and applications 0007,
-- career_roles 0011). Idempotent: IF NOT EXISTS everywhere, constraints dropped and re-added
-- under their own names, CREATE OR REPLACE for the function.

-- ---------------------------------------------------------------------------
-- 1. Frozen eligibility evaluations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_eligibility_evaluations (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  opportunity_version_id uuid NOT NULL REFERENCES opportunity_versions(id),
  trigger text NOT NULL,
  evaluator_version text NOT NULL,
  eligible boolean NOT NULL,
  outcomes jsonb NOT NULL,
  flag_count integer NOT NULL,
  self_reported_count integer NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE application_eligibility_evaluations DROP CONSTRAINT IF EXISTS application_eligibility_trigger_ck;
ALTER TABLE application_eligibility_evaluations ADD CONSTRAINT application_eligibility_trigger_ck
  CHECK (trigger IN ('APPLY', 'TERMS_ACKNOWLEDGED'));
ALTER TABLE application_eligibility_evaluations DROP CONSTRAINT IF EXISTS application_eligibility_shape_ck;
ALTER TABLE application_eligibility_evaluations ADD CONSTRAINT application_eligibility_shape_ck CHECK (
  length(evaluator_version) BETWEEN 1 AND 64
  AND jsonb_typeof(outcomes) = 'array'
  AND jsonb_array_length(outcomes) <= 64
  AND flag_count >= 0 AND self_reported_count >= 0
  AND flag_count <= jsonb_array_length(outcomes) AND self_reported_count <= jsonb_array_length(outcomes));
CREATE UNIQUE INDEX IF NOT EXISTS application_eligibility_application_version_uq
  ON application_eligibility_evaluations(application_id, opportunity_version_id);
CREATE INDEX IF NOT EXISTS application_eligibility_application_idx
  ON application_eligibility_evaluations(application_id, evaluated_at DESC);

-- A statement of what was true when it was evaluated: never rewritten.
CREATE OR REPLACE FUNCTION application_eligibility_evaluation_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'an application eligibility evaluation is never rewritten';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS application_eligibility_evaluation_immutable ON application_eligibility_evaluations;
CREATE TRIGGER application_eligibility_evaluation_immutable BEFORE UPDATE ON application_eligibility_evaluations
  FOR EACH ROW EXECUTE FUNCTION application_eligibility_evaluation_immutable();

COMMENT ON TABLE application_eligibility_evaluations IS
  'EMP-06: per application and job version, each eligibility rule''s outcome and the basis it rested on (VERIFIED, INSTITUTION_RECORD, SELF_REPORTED). Never the student''s figures. Written once.';

-- ---------------------------------------------------------------------------
-- 2. Catalogue skill on a job skill
-- ---------------------------------------------------------------------------
ALTER TABLE opportunity_skill_requirements ADD COLUMN IF NOT EXISTS taxonomy_topic_id uuid REFERENCES taxonomy_nodes(id);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_skill_version_topic_uq
  ON opportunity_skill_requirements(opportunity_version_id, taxonomy_topic_id) WHERE taxonomy_topic_id IS NOT NULL;
COMMENT ON COLUMN opportunity_skill_requirements.taxonomy_topic_id IS
  'EMP-06: set when the recruiter picked the skill from the ONE catalogue; skill_name is then the topic''s name. NULL for a free-text skill, which is never matched to a topic by name.';

-- ---------------------------------------------------------------------------
-- 3. Catalogue role on a job version
-- ---------------------------------------------------------------------------
ALTER TABLE opportunity_versions ADD COLUMN IF NOT EXISTS career_role_id uuid REFERENCES career_roles(id);
COMMENT ON COLUMN opportunity_versions.career_role_id IS
  'EMP-06: the catalogue role this job version maps to (used by EMP-13). Carried forward with the version.';
