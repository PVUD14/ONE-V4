-- The bridge between institution assessments and career readiness.
--
-- Design circulated in docs/architecture/exam-topic-bridge-table-design.md; the
-- proposals recorded there are adopted here and confirmed at review.
--
-- There have been two assessment engines and one readiness loop with nothing between
-- them: an institution could run a whole examination programme and every student's
-- band would sit exactly where it was. The missing piece was never the write, it was
-- the mapping -- evidence_records.topic_id references taxonomy_nodes, and an
-- exam_subjects row is institution-local free text.
--
-- The rule that keeps this honest: an unmapped subject contributes nothing and says
-- so. Guessing a topic from a subject name, or falling back to a default, would put
-- invented evidence under a student's readiness band, which is the one thing the
-- readiness model may never contain.

CREATE TABLE IF NOT EXISTS exam_subject_topic_links (
  id uuid PRIMARY KEY,
  exam_subject_id uuid NOT NULL,
  -- Denormalised so the composite foreign key below can pin a link inside one
  -- institution structurally. The unique index it references already exists.
  institution_id uuid NOT NULL REFERENCES organizations(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  -- A subject such as "Aptitude" plainly covers more than one readiness topic, and
  -- retrofitting weights later would mean rewriting evidence provenance.
  weight numeric(4,3) NOT NULL DEFAULT 1.000,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Retired, never deleted, so evidence written under a past mapping stays explicable.
  retired_at timestamptz,
  CONSTRAINT exam_subject_topic_weight_ck CHECK (weight > 0 AND weight <= 1),
  CONSTRAINT exam_subject_topic_retired_ck CHECK (retired_at IS NULL OR retired_at >= created_at),
  CONSTRAINT exam_subject_topic_subject_fk FOREIGN KEY (exam_subject_id, institution_id)
    REFERENCES exam_subjects(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_subject_topic_live_uq
  ON exam_subject_topic_links(exam_subject_id, topic_id) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS exam_subject_topic_subject_idx
  ON exam_subject_topic_links(exam_subject_id) WHERE retired_at IS NULL;

-- A CHECK cannot reach another table, and a mapping to a CAREER_ROLE or a SUBJECT node
-- would produce evidence against something that is not a topic. Same enforcement shape
-- 0031 uses for its role restriction.
CREATE OR REPLACE FUNCTION exam_subject_topic_is_topic() RETURNS trigger AS $$
DECLARE
  node_kind text;
BEGIN
  SELECT kind INTO node_kind FROM taxonomy_nodes WHERE id = NEW.topic_id;
  IF node_kind IS DISTINCT FROM 'TOPIC' THEN
    RAISE EXCEPTION 'an exam subject may only be mapped to a TOPIC taxonomy node';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS exam_subject_topic_kind_guard ON exam_subject_topic_links;
CREATE TRIGGER exam_subject_topic_kind_guard
  BEFORE INSERT OR UPDATE ON exam_subject_topic_links
  FOR EACH ROW EXECUTE FUNCTION exam_subject_topic_is_topic();

-- ---------------------------------------------------------------------------
-- Readiness model version 2
-- ---------------------------------------------------------------------------
-- Institution exam results become an input to the band, so the band means something
-- different from today. ADR-020 requires readiness to be a published, versioned,
-- explainable model, so this cannot be slipped into version 1: a new version is
-- published and the old one deactivated rather than edited.
--
-- Historical snapshots are NOT recalculated. readiness_snapshots already carries its
-- model version, and ADR-020 forbids silently recalculating history.

INSERT INTO readiness_model_versions (id, stable_key, version, policy, published_by_user_id, published_at, active)
SELECT '26000000-0000-4000-8000-000000000002', 'career-readiness-fundamentals', 2,
       jsonb_build_object(
         'algorithm', 'career-readiness-mastery-v1',
         'advisory', true,
         'employerVisible', false,
         'inputs', jsonb_build_array('LESSON_COMPLETION', 'ASSESSMENT_OUTCOME', 'INSTITUTION_EXAM_OUTCOME'),
         'supersedes', 1),
       m.published_by_user_id, now(), true
FROM readiness_model_versions m
WHERE m.stable_key = 'career-readiness-fundamentals' AND m.version = 1
ON CONFLICT (id) DO NOTHING;

-- Exactly one active version. v2 accepts a new input; with no subject mappings yet it
-- produces the same bands v1 did, so nothing moves on the day this migrates -- what
-- changes is what a future recomputation is allowed to consider.
UPDATE readiness_model_versions SET active = false
WHERE stable_key = 'career-readiness-fundamentals' AND version = 1;

COMMENT ON TABLE exam_subject_topic_links IS
  'Maps an institution exam subject onto readiness topics. Unmapped subjects contribute no evidence.';
COMMENT ON COLUMN exam_subject_topic_links.weight IS
  'Share of the result attributed to this topic. Never used to invent evidence for an unmapped subject.';
