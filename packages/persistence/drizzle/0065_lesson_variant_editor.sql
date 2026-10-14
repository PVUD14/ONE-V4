-- 0065 — Lesson and variant editor (OPS-09c).
--
-- Why: operators draft, review and publish lessons and their language, level and style variants.
-- A published revision of a lesson must replace the old version in the catalogue students see
-- (lesson_versions.superseded_at, set once, the only change a lesson version ever takes); a publish
-- that changes what completing a lesson proves needs a second person's approval, so the approval
-- vocabulary gains CONTENT_LESSON_PUBLISH; and a lesson's author never publishes it, whoever the
-- writer.
-- Design: docs/architecture/lesson-variant-editor-design.md
--
-- Idempotent: IF NOT EXISTS, functions replaced, triggers dropped before being created. Applies
-- once (ADR-035) and survives a bootstrap replay. Depends only on 0004 tables, and replaces the
-- 0061 approval function and publish guard, keeping everything they allowed.

-- ---------------------------------------------------------------------------
-- 1. A published new version supersedes the old one in the catalogue. Nothing else changes.
-- ---------------------------------------------------------------------------
ALTER TABLE lesson_versions ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
CREATE INDEX IF NOT EXISTS lesson_versions_current_idx ON lesson_versions(stable_key) WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION lesson_version_supersede_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published lesson versions cannot be deleted';
  END IF;
  IF (to_jsonb(OLD) - 'superseded_at') IS DISTINCT FROM (to_jsonb(NEW) - 'superseded_at') THEN
    RAISE EXCEPTION 'published lesson versions are immutable';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'a superseded lesson version stays superseded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lesson_versions_supersede_guard ON lesson_versions;
CREATE TRIGGER lesson_versions_supersede_guard BEFORE UPDATE OR DELETE ON lesson_versions
  FOR EACH ROW EXECUTE FUNCTION lesson_version_supersede_guard();

-- The editor checks key uniqueness and lists lessons by key; keep that lookup cheap.
CREATE INDEX IF NOT EXISTS content_revisions_lesson_key_idx ON content_revisions ((body ->> 'stableKey')) WHERE entity_type = 'LESSON';

-- ---------------------------------------------------------------------------
-- 2. The approval action (0051's extension mechanism). Repeat every earlier key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_QUESTION_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_LESSON_PUBLISH' THEN 'content_revision'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH; 0065: CONTENT_LESSON_PUBLISH. A later key repeats every earlier one.';

-- ---------------------------------------------------------------------------
-- 3. The author never publishes their own skill (0057), question (0061) or lesson (0065).
--    0004 refuses only APPROVE.
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
    IF revision_entity = 'QUESTION' AND NEW.actor_user_id = revision_author THEN
      RAISE EXCEPTION 'author cannot publish own question revision';
    END IF;
    IF revision_entity = 'LESSON' AND NEW.actor_user_id = revision_author THEN
      RAISE EXCEPTION 'author cannot publish own lesson revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_review_author_publish_guard ON content_review_actions;
CREATE TRIGGER content_review_author_publish_guard BEFORE INSERT ON content_review_actions
  FOR EACH ROW EXECUTE FUNCTION content_review_author_publish_guard();
