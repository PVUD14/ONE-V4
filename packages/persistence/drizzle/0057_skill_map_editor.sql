-- 0057 — Skill map editor (OPS-09a).
--
-- Why: operators draft, review and publish skills (TOPIC nodes whose content is a versioned
-- content revision). A publish that changes readiness inputs needs a second person's approval,
-- so the approval vocabulary gains CONTENT_SKILL_PUBLISH; the author of a skill never publishes
-- it; and a live topic's content only ever moves to a published revision of itself.
-- No new table.
-- Design: docs/architecture/skill-map-editor-design.md
--
-- Idempotent: functions replaced, triggers dropped before being created. Applies once (ADR-035)
-- and survives a bootstrap replay. Nothing existing updates taxonomy_nodes, and the new
-- content_review_actions guard only refuses a PUBLISH by the revision's own author.

-- ---------------------------------------------------------------------------
-- 1. The approval action (0051's extension mechanism). Keep every earlier key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    ELSE NULL
  END
$$;

-- ---------------------------------------------------------------------------
-- 2. The author never publishes their own skill. 0004 refuses only APPROVE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION content_review_author_publish_guard() RETURNS trigger AS $$
DECLARE
  revision_author uuid;
  revision_entity text;
BEGIN
  IF NEW.action = 'PUBLISH' THEN
    SELECT author_user_id, entity_type INTO revision_author, revision_entity
    FROM content_revisions WHERE id = NEW.content_revision_id;
    IF revision_entity = 'TOPIC' AND NEW.actor_user_id = revision_author THEN
      RAISE EXCEPTION 'author cannot publish own skill revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_review_author_publish_guard ON content_review_actions;
CREATE TRIGGER content_review_author_publish_guard BEFORE INSERT ON content_review_actions
  FOR EACH ROW EXECUTE FUNCTION content_review_author_publish_guard();

-- ---------------------------------------------------------------------------
-- 3. A topic's content moves only to a published revision of itself; a topic goes live only
--    on published content. Updates only: inserts (pilot seed, fixtures) are unchanged. Named
--    to sort after 0056's taxonomy_node_draft_guard, so an agent-drafted activation keeps
--    0056's message.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION taxonomy_node_published_content_guard() RETURNS trigger AS $$
DECLARE
  target record;
BEGIN
  IF NEW.kind <> 'TOPIC' THEN
    RETURN NEW;
  END IF;
  IF NEW.content_revision_id IS DISTINCT FROM OLD.content_revision_id THEN
    SELECT entity_type, entity_id, state INTO target FROM content_revisions WHERE id = NEW.content_revision_id;
    IF target.entity_type IS DISTINCT FROM 'TOPIC' OR target.entity_id IS DISTINCT FROM NEW.id
       OR target.state IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'a topic''s content moves only to a published revision of that topic';
    END IF;
  END IF;
  IF NEW.active AND NOT OLD.active THEN
    SELECT state INTO target FROM content_revisions WHERE id = NEW.content_revision_id;
    IF target.state IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'a topic goes live only once its content revision is published';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS taxonomy_node_published_content_guard ON taxonomy_nodes;
CREATE TRIGGER taxonomy_node_published_content_guard BEFORE UPDATE ON taxonomy_nodes
  FOR EACH ROW EXECUTE FUNCTION taxonomy_node_published_content_guard();

COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH. A later key repeats every earlier one.';
