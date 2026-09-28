-- 0061 — Question bank editor (OPS-09b).
--
-- Why: operators draft, review and publish readiness-check questions. Their four-step hint
-- ladders need a home (no engine goal has created one); a published new version must replace
-- the old one in the readiness-check pool; every question publish needs a second person's
-- approval, so the approval vocabulary gains CONTENT_QUESTION_PUBLISH; and a question's author
-- never publishes it, whoever the writer.
-- Designs: docs/architecture/question-bank-editor-design.md,
--          docs/architecture/question-hint-ladders-table-design.md
--
-- Idempotent: IF NOT EXISTS, functions replaced, triggers dropped before being created. Applies
-- once (ADR-035) and survives a bootstrap replay. Depends only on 0004 tables (and replaces
-- 0051/0057's approval function and 0057's publish guard, keeping everything they allowed).

-- ---------------------------------------------------------------------------
-- 1. question_hint_ladders — one per QUESTION revision, reviewed with it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_hint_ladders (
  id uuid PRIMARY KEY,
  question_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  hint_1 text NOT NULL,
  hint_2 text NOT NULL,
  hint_3 text NOT NULL,
  hint_4 text NOT NULL,
  source text NOT NULL,
  generator_version text,
  prompt_version text,
  generated_at timestamptz,
  expert_check_notes text,
  review_state text NOT NULL DEFAULT 'DRAFT',
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_hint_ladders_revision_uq UNIQUE (question_revision_id),
  CONSTRAINT question_hint_ladders_hint_1_ck CHECK (length(btrim(hint_1)) BETWEEN 1 AND 1000),
  CONSTRAINT question_hint_ladders_hint_2_ck CHECK (length(btrim(hint_2)) BETWEEN 1 AND 1000),
  CONSTRAINT question_hint_ladders_hint_3_ck CHECK (length(btrim(hint_3)) BETWEEN 1 AND 1000),
  CONSTRAINT question_hint_ladders_hint_4_ck CHECK (length(btrim(hint_4)) BETWEEN 1 AND 1000),
  CONSTRAINT question_hint_ladders_source_ck CHECK (source IN ('AUTHORED','AGENT_DRAFTED')),
  CONSTRAINT question_hint_ladders_generator_ck CHECK (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128),
  CONSTRAINT question_hint_ladders_prompt_ck CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128),
  CONSTRAINT question_hint_ladders_expert_notes_ck CHECK (expert_check_notes IS NULL OR length(btrim(expert_check_notes)) BETWEEN 1 AND 4000),
  CONSTRAINT question_hint_ladders_provenance_ck CHECK (
    (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL) OR
    (source = 'AGENT_DRAFTED' AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
      AND expert_check_notes IS NOT NULL)
  ),
  CONSTRAINT question_hint_ladders_review_state_ck CHECK (review_state IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','PUBLISHED','ARCHIVED'))
);
CREATE INDEX IF NOT EXISTS question_hint_ladders_published_idx ON question_hint_ladders(question_revision_id) WHERE review_state = 'PUBLISHED';

CREATE OR REPLACE FUNCTION question_hint_ladder_guard() RETURNS trigger AS $$
DECLARE
  rev_type text;
  rev_state text;
  identity_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hint ladders cannot be deleted';
  END IF;
  SELECT entity_type, state INTO rev_type, rev_state FROM content_revisions WHERE id = NEW.question_revision_id;
  IF rev_type IS DISTINCT FROM 'QUESTION' THEN
    RAISE EXCEPTION 'a hint ladder must belong to a QUESTION revision';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF rev_state NOT IN ('DRAFT','CHANGES_REQUESTED') THEN
      RAISE EXCEPTION 'a hint ladder can only be added while its question is being drafted';
    END IF;
    NEW.review_state := rev_state;
    RETURN NEW;
  END IF;
  FOREACH identity_column IN ARRAY ARRAY['id','question_revision_id','source','generator_version','prompt_version',
    'generated_at','expert_check_notes','created_by_user_id','created_at']
  LOOP
    IF (to_jsonb(OLD) -> identity_column) IS DISTINCT FROM (to_jsonb(NEW) -> identity_column) THEN
      RAISE EXCEPTION 'hint ladder identity and provenance are immutable';
    END IF;
  END LOOP;
  IF NEW.review_state IS DISTINCT FROM rev_state THEN
    RAISE EXCEPTION 'review_state follows the question revision and cannot be set directly';
  END IF;
  IF (to_jsonb(OLD) - 'review_state' - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'review_state' - 'updated_at')
     AND rev_state NOT IN ('DRAFT','CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'hints can only be edited while the question is DRAFT or CHANGES_REQUESTED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS question_hint_ladders_guard ON question_hint_ladders;
CREATE TRIGGER question_hint_ladders_guard BEFORE INSERT OR UPDATE OR DELETE ON question_hint_ladders
  FOR EACH ROW EXECUTE FUNCTION question_hint_ladder_guard();

CREATE OR REPLACE FUNCTION mirror_question_hint_ladder_state() RETURNS trigger AS $$
BEGIN
  UPDATE question_hint_ladders SET review_state = NEW.state WHERE question_revision_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_revisions_hint_ladder_state_mirror ON content_revisions;
CREATE TRIGGER content_revisions_hint_ladder_state_mirror AFTER UPDATE OF state ON content_revisions
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.entity_type = 'QUESTION')
  EXECUTE FUNCTION mirror_question_hint_ladder_state();

-- ---------------------------------------------------------------------------
-- 2. A published new version supersedes the old one in the readiness-check pool. The only
--    change a question_versions row ever takes is superseded_at, once.
-- ---------------------------------------------------------------------------
ALTER TABLE question_versions ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
CREATE INDEX IF NOT EXISTS question_versions_current_idx ON question_versions(stable_key) WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION question_version_supersede_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(OLD) - 'superseded_at') IS DISTINCT FROM (to_jsonb(NEW) - 'superseded_at') THEN
    RAISE EXCEPTION 'published question versions are immutable';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'a superseded question version stays superseded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS question_versions_supersede_guard ON question_versions;
CREATE TRIGGER question_versions_supersede_guard BEFORE UPDATE ON question_versions
  FOR EACH ROW EXECUTE FUNCTION question_version_supersede_guard();

-- The editor checks key uniqueness across every question's revisions; keep that lookup cheap.
CREATE INDEX IF NOT EXISTS content_revisions_question_key_idx ON content_revisions ((body ->> 'stableKey')) WHERE entity_type = 'QUESTION';

-- ---------------------------------------------------------------------------
-- 3. The approval action (0051's extension mechanism). Repeat every earlier key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    WHEN 'CONTENT_SKILL_PUBLISH' THEN 'content_revision'
    WHEN 'CONTENT_QUESTION_PUBLISH' THEN 'content_revision'
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION operation_approval_extended_target_type(text) IS
  'Approval actions added after 0038, stored in extended_action_key. 0051: CAREER_REQUIREMENT_SET_PUBLISH; 0057: CONTENT_SKILL_PUBLISH; 0061: CONTENT_QUESTION_PUBLISH. A later key repeats every earlier one.';

-- ---------------------------------------------------------------------------
-- 4. The author never publishes their own skill (0057) or question (0061). 0004 refuses only APPROVE.
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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_review_author_publish_guard ON content_review_actions;
CREATE TRIGGER content_review_author_publish_guard BEFORE INSERT ON content_review_actions
  FOR EACH ROW EXECUTE FUNCTION content_review_author_publish_guard();
