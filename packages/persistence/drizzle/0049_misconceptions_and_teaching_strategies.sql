-- Misconception codes, question-option misconception tags and teaching strategies (ENG-07).
--
-- Design: docs/architecture/misconception-codes-table-design.md (shared governance),
--         docs/architecture/question-option-misconceptions-table-design.md,
--         docs/architecture/teaching-strategies-table-design.md
--
-- These are governed content. Every row points at its own content_revisions row and moves
-- through the 0004 lifecycle (author cannot approve, published is immutable, publication
-- only through an eligible release manifest). review_state mirrors the revision's state and
-- cannot be set by hand. Every row is inserted as DRAFT. Provenance columns carry what
-- AGENTS.md requires of model-produced content; GENERATED is deliberately not a source yet
-- (AI hold, ADR-030).
--
-- The migrator replays every file on every run, in lexical order, with no tracking table.
-- Everything here is idempotent and depends only on tables from 0000-0004.

-- ---------------------------------------------------------------------------
-- content_revisions admits the three new entity types (every existing value kept)
-- ---------------------------------------------------------------------------

ALTER TABLE content_revisions DROP CONSTRAINT IF EXISTS content_revisions_entity_type_check;
ALTER TABLE content_revisions ADD CONSTRAINT content_revisions_entity_type_check CHECK (entity_type IN (
  'CAREER_ROLE','SUBJECT','TOPIC','SKILL','MODULE','LESSON','QUESTION','ASSESSMENT_BLUEPRINT',
  'MISCONCEPTION','QUESTION_OPTION_MISCONCEPTION','TEACHING_STRATEGY'
));

-- ---------------------------------------------------------------------------
-- misconception_codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS misconception_codes (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  version integer NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  title text NOT NULL,
  description text NOT NULL,
  basis text NOT NULL,
  expert_check_notes text,
  source text NOT NULL,
  generator_version text,
  prompt_version text,
  generated_at timestamptz,
  review_state text NOT NULL DEFAULT 'DRAFT',
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT misconception_codes_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT misconception_codes_version_ck CHECK (version > 0),
  CONSTRAINT misconception_codes_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT misconception_codes_description_ck CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  CONSTRAINT misconception_codes_basis_ck CHECK (length(btrim(basis)) BETWEEN 1 AND 4000),
  CONSTRAINT misconception_codes_expert_notes_ck CHECK (expert_check_notes IS NULL OR length(btrim(expert_check_notes)) BETWEEN 1 AND 4000),
  CONSTRAINT misconception_codes_source_ck CHECK (source IN ('AUTHORED','AGENT_DRAFTED')),
  CONSTRAINT misconception_codes_generator_ck CHECK (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128),
  CONSTRAINT misconception_codes_prompt_ck CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128),
  CONSTRAINT misconception_codes_provenance_ck CHECK (
    (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL) OR
    (source = 'AGENT_DRAFTED' AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
      AND expert_check_notes IS NOT NULL)
  ),
  CONSTRAINT misconception_codes_review_state_ck CHECK (review_state IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','PUBLISHED','ARCHIVED')),
  CONSTRAINT misconception_codes_code_version_uq UNIQUE (code, version),
  CONSTRAINT misconception_codes_revision_uq UNIQUE (content_revision_id)
);
CREATE INDEX IF NOT EXISTS misconception_codes_skill_idx ON misconception_codes(skill_id, code);
CREATE INDEX IF NOT EXISTS misconception_codes_published_idx ON misconception_codes(code, version) WHERE review_state = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- question_option_misconceptions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS question_option_misconceptions (
  id uuid PRIMARY KEY,
  question_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  option_id text NOT NULL,
  misconception_code_id uuid NOT NULL REFERENCES misconception_codes(id),
  rationale text NOT NULL,
  basis text NOT NULL,
  expert_check_notes text,
  source text NOT NULL,
  generator_version text,
  prompt_version text,
  generated_at timestamptz,
  review_state text NOT NULL DEFAULT 'DRAFT',
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_option_misconceptions_option_ck CHECK (length(option_id) BETWEEN 1 AND 64),
  CONSTRAINT question_option_misconceptions_rationale_ck CHECK (length(btrim(rationale)) BETWEEN 1 AND 2000),
  CONSTRAINT question_option_misconceptions_basis_ck CHECK (length(btrim(basis)) BETWEEN 1 AND 4000),
  CONSTRAINT question_option_misconceptions_expert_notes_ck CHECK (expert_check_notes IS NULL OR length(btrim(expert_check_notes)) BETWEEN 1 AND 4000),
  CONSTRAINT question_option_misconceptions_source_ck CHECK (source IN ('AUTHORED','AGENT_DRAFTED')),
  CONSTRAINT question_option_misconceptions_generator_ck CHECK (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128),
  CONSTRAINT question_option_misconceptions_prompt_ck CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128),
  CONSTRAINT question_option_misconceptions_provenance_ck CHECK (
    (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL) OR
    (source = 'AGENT_DRAFTED' AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
      AND expert_check_notes IS NOT NULL)
  ),
  CONSTRAINT question_option_misconceptions_review_state_ck CHECK (review_state IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','PUBLISHED','ARCHIVED')),
  CONSTRAINT question_option_misconceptions_tag_uq UNIQUE (question_revision_id, option_id, misconception_code_id),
  CONSTRAINT question_option_misconceptions_revision_uq UNIQUE (content_revision_id)
);
CREATE INDEX IF NOT EXISTS question_option_misconceptions_published_idx
  ON question_option_misconceptions(question_revision_id, option_id) WHERE review_state = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS question_option_misconceptions_code_idx ON question_option_misconceptions(misconception_code_id);

-- ---------------------------------------------------------------------------
-- teaching_strategies
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teaching_strategies (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  version integer NOT NULL,
  strategy_kind text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  applicability jsonb NOT NULL,
  requires_model boolean NOT NULL DEFAULT false,
  basis text NOT NULL,
  expert_check_notes text,
  source text NOT NULL,
  generator_version text,
  prompt_version text,
  generated_at timestamptz,
  review_state text NOT NULL DEFAULT 'DRAFT',
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teaching_strategies_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT teaching_strategies_version_ck CHECK (version > 0),
  CONSTRAINT teaching_strategies_kind_ck CHECK (strategy_kind IN (
    'WORKED_EXAMPLE','GUIDED_PRACTICE','SOCRATIC_QUESTIONING','HINT_LADDER','ERROR_CORRECTION','RETRIEVAL_PRACTICE','TEACH_BACK'
  )),
  CONSTRAINT teaching_strategies_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT teaching_strategies_description_ck CHECK (length(btrim(description)) BETWEEN 1 AND 4000),
  CONSTRAINT teaching_strategies_applicability_ck CHECK (jsonb_typeof(applicability) = 'object'),
  CONSTRAINT teaching_strategies_basis_ck CHECK (length(btrim(basis)) BETWEEN 1 AND 4000),
  CONSTRAINT teaching_strategies_expert_notes_ck CHECK (expert_check_notes IS NULL OR length(btrim(expert_check_notes)) BETWEEN 1 AND 4000),
  CONSTRAINT teaching_strategies_source_ck CHECK (source IN ('AUTHORED','AGENT_DRAFTED')),
  CONSTRAINT teaching_strategies_generator_ck CHECK (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128),
  CONSTRAINT teaching_strategies_prompt_ck CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128),
  CONSTRAINT teaching_strategies_provenance_ck CHECK (
    (source = 'AUTHORED' AND generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL) OR
    (source = 'AGENT_DRAFTED' AND generator_version IS NOT NULL AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
      AND expert_check_notes IS NOT NULL)
  ),
  CONSTRAINT teaching_strategies_review_state_ck CHECK (review_state IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED','PUBLISHED','ARCHIVED')),
  CONSTRAINT teaching_strategies_code_version_uq UNIQUE (code, version),
  CONSTRAINT teaching_strategies_revision_uq UNIQUE (content_revision_id)
);
CREATE INDEX IF NOT EXISTS teaching_strategies_published_idx ON teaching_strategies(strategy_kind, code, version) WHERE review_state = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- Shared guard: rows are born DRAFT against their own revision, review_state follows the
-- revision, identity and provenance never change, content changes only while the revision
-- is DRAFT or CHANGES_REQUESTED, and nothing is deleted.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION engine_content_row_guard()
RETURNS trigger AS $$
DECLARE
  expected_type text;
  rev_type text;
  rev_entity uuid;
  rev_author uuid;
  rev_state text;
  identity_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'engine content rows cannot be deleted';
  END IF;
  expected_type := CASE TG_TABLE_NAME
    WHEN 'misconception_codes' THEN 'MISCONCEPTION'
    WHEN 'question_option_misconceptions' THEN 'QUESTION_OPTION_MISCONCEPTION'
    WHEN 'teaching_strategies' THEN 'TEACHING_STRATEGY'
  END;
  SELECT entity_type, entity_id, author_user_id, state INTO rev_type, rev_entity, rev_author, rev_state
  FROM content_revisions WHERE id = NEW.content_revision_id;
  IF rev_type IS NULL THEN
    RAISE EXCEPTION 'engine content requires a content revision';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF rev_type <> expected_type OR rev_entity <> NEW.id THEN
      RAISE EXCEPTION 'content revision does not belong to this engine content row';
    END IF;
    IF rev_author <> NEW.created_by_user_id THEN
      RAISE EXCEPTION 'engine content author must be the revision author';
    END IF;
    IF rev_state <> 'DRAFT' THEN
      RAISE EXCEPTION 'engine content must be inserted as DRAFT';
    END IF;
    NEW.review_state := 'DRAFT';
    RETURN NEW;
  END IF;

  FOREACH identity_column IN ARRAY ARRAY['id','code','version','source','generator_version','prompt_version',
    'generated_at','content_revision_id','created_by_user_id','created_at','question_revision_id','option_id',
    'misconception_code_id']
  LOOP
    IF (to_jsonb(OLD) -> identity_column) IS DISTINCT FROM (to_jsonb(NEW) -> identity_column) THEN
      RAISE EXCEPTION 'engine content identity and provenance are immutable';
    END IF;
  END LOOP;
  IF NEW.review_state IS DISTINCT FROM rev_state THEN
    RAISE EXCEPTION 'review_state follows the content revision and cannot be set directly';
  END IF;
  IF (to_jsonb(OLD) - 'review_state') IS DISTINCT FROM (to_jsonb(NEW) - 'review_state')
     AND rev_state NOT IN ('DRAFT','CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'engine content can only be edited while DRAFT or CHANGES_REQUESTED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['misconception_codes','question_option_misconceptions','teaching_strategies']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_content_guard ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_content_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION engine_content_row_guard()', table_name, table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- A misconception belongs to a SKILL or TOPIC node.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION misconception_code_skill_guard()
RETURNS trigger AS $$
DECLARE node_kind text;
BEGIN
  SELECT kind INTO node_kind FROM taxonomy_nodes WHERE id = NEW.skill_id;
  IF node_kind IS NULL OR node_kind NOT IN ('SKILL','TOPIC') THEN
    RAISE EXCEPTION 'a misconception must belong to a SKILL or TOPIC node';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS misconception_codes_skill_guard ON misconception_codes;
CREATE TRIGGER misconception_codes_skill_guard BEFORE INSERT OR UPDATE ON misconception_codes
FOR EACH ROW EXECUTE FUNCTION misconception_code_skill_guard();

-- ---------------------------------------------------------------------------
-- A tag sits on a wrong option of a QUESTION revision, and goes live only on a published
-- question with a published misconception code.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION question_option_misconception_guard()
RETURNS trigger AS $$
DECLARE
  question_type text;
  question_state text;
  question_body jsonb;
  code_state text;
BEGIN
  SELECT entity_type, state, body INTO question_type, question_state, question_body
  FROM content_revisions WHERE id = NEW.question_revision_id;
  IF question_type IS DISTINCT FROM 'QUESTION' THEN
    RAISE EXCEPTION 'a misconception tag must reference a QUESTION revision';
  END IF;
  IF jsonb_typeof(question_body -> 'options') IS DISTINCT FROM 'array' OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(question_body -> 'options') option_row
    WHERE option_row ->> 'id' = NEW.option_id
  ) THEN
    RAISE EXCEPTION 'tagged option does not exist on the question revision';
  END IF;
  IF question_body ->> 'correctOptionId' IS NULL THEN
    RAISE EXCEPTION 'question revision has no answer key';
  END IF;
  IF question_body ->> 'correctOptionId' = NEW.option_id THEN
    RAISE EXCEPTION 'the correct option cannot carry a misconception';
  END IF;
  IF NEW.review_state = 'PUBLISHED' AND (TG_OP = 'INSERT' OR OLD.review_state IS DISTINCT FROM 'PUBLISHED') THEN
    IF question_state <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'a misconception tag can only be published on a published question';
    END IF;
    SELECT review_state INTO code_state FROM misconception_codes WHERE id = NEW.misconception_code_id;
    IF code_state IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'a misconception tag can only be published with a published misconception code';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS question_option_misconceptions_tag_guard ON question_option_misconceptions;
CREATE TRIGGER question_option_misconceptions_tag_guard BEFORE INSERT OR UPDATE ON question_option_misconceptions
FOR EACH ROW EXECUTE FUNCTION question_option_misconception_guard();

-- ---------------------------------------------------------------------------
-- The revision's state is mirrored onto the engine row that references it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mirror_engine_content_review_state()
RETURNS trigger AS $$
BEGIN
  IF NEW.entity_type = 'MISCONCEPTION' THEN
    UPDATE misconception_codes SET review_state = NEW.state WHERE content_revision_id = NEW.id;
  ELSIF NEW.entity_type = 'QUESTION_OPTION_MISCONCEPTION' THEN
    UPDATE question_option_misconceptions SET review_state = NEW.state WHERE content_revision_id = NEW.id;
  ELSIF NEW.entity_type = 'TEACHING_STRATEGY' THEN
    UPDATE teaching_strategies SET review_state = NEW.state WHERE content_revision_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_revisions_engine_state_mirror ON content_revisions;
CREATE TRIGGER content_revisions_engine_state_mirror AFTER UPDATE OF state ON content_revisions
FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state
  AND NEW.entity_type IN ('MISCONCEPTION','QUESTION_OPTION_MISCONCEPTION','TEACHING_STRATEGY'))
EXECUTE FUNCTION mirror_engine_content_review_state();
