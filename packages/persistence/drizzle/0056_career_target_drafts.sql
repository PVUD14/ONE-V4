-- 0056 — Agent-drafted career targets (ENG-11).
--
-- Why: a career target written by the coding agent is model-produced content (program Part B.8)
-- and must say so on the row, immutably. Its skills do not exist in the published taxonomy yet, so
-- they are created as pending TOPIC nodes (inactive, DRAFT revision) that no picker lists, and
-- nothing may go live on a topic that is not live.
-- Design: docs/architecture/career-target-drafts-table-design.md
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, constraints dropped before being added, functions replaced,
-- triggers dropped before being created. Existing rows read AUTHORED, which satisfies every CHECK.

-- ---------------------------------------------------------------------------
-- 1. Provenance on requirement sets
-- ---------------------------------------------------------------------------
ALTER TABLE career_requirement_sets ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'AUTHORED';
ALTER TABLE career_requirement_sets ADD COLUMN IF NOT EXISTS generator_version text;
ALTER TABLE career_requirement_sets ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE career_requirement_sets ADD COLUMN IF NOT EXISTS generated_at timestamptz;
ALTER TABLE career_requirement_sets ADD COLUMN IF NOT EXISTS source_basis text;

ALTER TABLE career_requirement_sets DROP CONSTRAINT IF EXISTS career_requirement_set_provenance_ck;
ALTER TABLE career_requirement_sets ADD CONSTRAINT career_requirement_set_provenance_ck CHECK (
  source IN ('AUTHORED','AGENT_DRAFTED')
  AND (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128)
  AND (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128)
  AND (source_basis IS NULL OR length(source_basis) BETWEEN 1 AND 2000)
  AND (
    (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL AND source_basis IS NULL)
    OR (source = 'AGENT_DRAFTED' AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
        AND source_basis IS NOT NULL)
  ));

CREATE OR REPLACE FUNCTION career_requirement_set_provenance_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.source_basis IS DISTINCT FROM OLD.source_basis THEN
    RAISE EXCEPTION 'a career requirement set''s provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS career_requirement_set_provenance_guard ON career_requirement_sets;
CREATE TRIGGER career_requirement_set_provenance_guard BEFORE UPDATE ON career_requirement_sets
  FOR EACH ROW EXECUTE FUNCTION career_requirement_set_provenance_guard();

-- ---------------------------------------------------------------------------
-- 2. Provenance on taxonomy nodes; an agent-drafted node is live only once published
-- ---------------------------------------------------------------------------
ALTER TABLE taxonomy_nodes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'AUTHORED';
ALTER TABLE taxonomy_nodes ADD COLUMN IF NOT EXISTS generator_version text;
ALTER TABLE taxonomy_nodes ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE taxonomy_nodes ADD COLUMN IF NOT EXISTS generated_at timestamptz;

ALTER TABLE taxonomy_nodes DROP CONSTRAINT IF EXISTS taxonomy_node_provenance_ck;
ALTER TABLE taxonomy_nodes ADD CONSTRAINT taxonomy_node_provenance_ck CHECK (
  source IN ('AUTHORED','AGENT_DRAFTED')
  AND (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128)
  AND (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128)
  AND (
    (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL)
    OR (source = 'AGENT_DRAFTED' AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL)
  ));

CREATE OR REPLACE FUNCTION taxonomy_node_draft_guard() RETURNS trigger AS $$
DECLARE
  revision_state text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.source IS DISTINCT FROM OLD.source OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
       OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version OR NEW.generated_at IS DISTINCT FROM OLD.generated_at) THEN
    RAISE EXCEPTION 'a taxonomy node''s provenance is immutable';
  END IF;
  IF NEW.source = 'AGENT_DRAFTED' AND NEW.active THEN
    SELECT state INTO revision_state FROM content_revisions WHERE id = NEW.content_revision_id;
    IF revision_state IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'an agent-drafted taxonomy node goes live only once its content revision is published';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS taxonomy_node_draft_guard ON taxonomy_nodes;
CREATE TRIGGER taxonomy_node_draft_guard BEFORE INSERT OR UPDATE ON taxonomy_nodes
  FOR EACH ROW EXECUTE FUNCTION taxonomy_node_draft_guard();

-- ---------------------------------------------------------------------------
-- 3. Nothing goes live on a topic that is not live
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION career_requirement_live_topic_guard() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'career_role_requirements' THEN
    IF NOT EXISTS (SELECT 1 FROM taxonomy_nodes n WHERE n.id = NEW.topic_id AND n.active) THEN
      RAISE EXCEPTION 'a live career requirement needs a live topic';
    END IF;
  ELSIF NEW.state = 'PUBLISHED' AND OLD.state IS DISTINCT FROM 'PUBLISHED' THEN
    IF EXISTS (
      SELECT 1 FROM career_requirement_set_items i JOIN taxonomy_nodes n ON n.id = i.topic_id
      WHERE i.set_id = NEW.id AND NOT n.active) THEN
      RAISE EXCEPTION 'a career requirement set publishes only when every topic it names is live';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS career_role_requirement_live_topic_guard ON career_role_requirements;
CREATE TRIGGER career_role_requirement_live_topic_guard BEFORE INSERT OR UPDATE OF topic_id ON career_role_requirements
  FOR EACH ROW EXECUTE FUNCTION career_requirement_live_topic_guard();
DROP TRIGGER IF EXISTS career_requirement_set_live_topic_guard ON career_requirement_sets;
CREATE TRIGGER career_requirement_set_live_topic_guard BEFORE UPDATE OF state ON career_requirement_sets
  FOR EACH ROW EXECUTE FUNCTION career_requirement_live_topic_guard();

COMMENT ON COLUMN career_requirement_sets.source IS
  'AUTHORED (a person) or AGENT_DRAFTED (model-produced; generator_version, prompt_version, generated_at, source_basis set). Immutable. review_state is the set''s state.';
COMMENT ON COLUMN taxonomy_nodes.source IS
  'AUTHORED or AGENT_DRAFTED. An AGENT_DRAFTED node may be active only while its content revision is PUBLISHED. Immutable.';
