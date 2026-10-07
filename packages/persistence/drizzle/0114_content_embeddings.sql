-- 0114 — content embeddings (ENG-24): who owns a content revision, the one definition of approved,
-- current content a model may be shown, and one row per embedded chunk of it.
-- Design: docs/architecture/content-retrieval-design.md; ADR-050.
--
-- Why: the tutor's retrieval must return only approved content, and only content the student's
-- tenant may see. A revision now records its owner (NULL = platform content, visible to everyone);
-- a chunk copies it and the database refuses one that differs. "Approved" is a view, read live by
-- retrieval, so archiving a revision, rolling back its release or publishing a newer one removes its
-- chunks from retrieval in the same transaction — not at the next embedding run.
--
-- No extension is created: production runs postgres:16-alpine, which has no pgvector (ADR-050).
-- Vectors are unit-length real[] and retrieval is an exact scan; a later migration can add a vector
-- column and index once the image carries pgvector.
--
-- 0111 and 0112 are claimed by other goals. Applied once by the ledger runner (ADR-035); written
-- idempotently all the same (IF NOT EXISTS, CHECKs dropped IF EXISTS and re-added, CREATE OR
-- REPLACE, DROP TRIGGER IF EXISTS).

-- ---------------------------------------------------------------------------
-- 1. A content revision's owner: NULL is platform content; otherwise one institution's private content.
-- ---------------------------------------------------------------------------
ALTER TABLE content_revisions ADD COLUMN IF NOT EXISTS owner_institution_id uuid REFERENCES organizations(id);
COMMENT ON COLUMN content_revisions.owner_institution_id IS
  'ENG-24: NULL = platform content, visible to every learner; otherwise the institution whose private content this is. Fixed at creation.';

-- Fixed at creation, even on a draft: a revision's audience is part of what was reviewed. Only an
-- institution may own content. Every existing row is NULL, and no editor sets it.
CREATE OR REPLACE FUNCTION content_revision_owner_guard() RETURNS trigger AS $$
DECLARE
  owner_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.owner_institution_id IS DISTINCT FROM OLD.owner_institution_id THEN
      RAISE EXCEPTION 'a content revision''s owner is fixed when it is created';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.owner_institution_id IS NOT NULL THEN
    SELECT kind::text INTO owner_kind FROM organizations WHERE id = NEW.owner_institution_id;
    IF owner_kind IS DISTINCT FROM 'INSTITUTION' THEN
      RAISE EXCEPTION 'only an institution owns private content';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_revisions_owner_guard ON content_revisions;
CREATE TRIGGER content_revisions_owner_guard BEFORE INSERT OR UPDATE ON content_revisions
  FOR EACH ROW EXECUTE FUNCTION content_revision_owner_guard();

-- ---------------------------------------------------------------------------
-- 2. The one definition of approved, current content that may be embedded and retrieved.
-- ---------------------------------------------------------------------------
-- A LESSON revision (base lesson or variant) that is PUBLISHED, under a PUBLISHED release, the latest
-- PUBLISHED revision of its lesson, and — for a base lesson — whose lesson version is not superseded.
-- Archive (0090) moves every published revision of an item to ARCHIVED; a rolled-back release is no
-- longer PUBLISHED; a newer published revision makes the older one not the latest and supersedes its
-- lesson version (0065). Each removes the revision from this view at once. Questions are not sources:
-- their bodies carry the material of an answer key (design, Decision 3).
CREATE OR REPLACE VIEW content_retrieval_sources AS
SELECT c.id AS content_revision_id, c.entity_type, c.entity_id, c.revision, c.owner_institution_id,
       c.content_hash, c.body, c.published_at
FROM content_revisions c
JOIN release_manifests rm ON rm.id = c.release_manifest_id AND rm.status = 'PUBLISHED'
WHERE c.entity_type = 'LESSON'
  AND c.state = 'PUBLISHED'
  AND NOT EXISTS (
    SELECT 1 FROM content_revisions newer
    WHERE newer.entity_type = c.entity_type AND newer.entity_id = c.entity_id
      AND newer.state = 'PUBLISHED' AND newer.revision > c.revision)
  AND NOT EXISTS (
    SELECT 1 FROM lesson_versions l WHERE l.content_revision_id = c.id AND l.superseded_at IS NOT NULL);

COMMENT ON VIEW content_retrieval_sources IS
  'ENG-24: approved, current content that may be embedded and retrieved. Read live by retrieval, so withdrawal is immediate.';

-- ---------------------------------------------------------------------------
-- 3. content_embeddings: one row per chunk of an approved revision, per embedding model and recipe.
--    A projection: rebuildable from approved content, never edited, deletable.
-- ---------------------------------------------------------------------------

-- One dimension, no NULL, no NaN or infinity, unit length within 2% (so the inner product is the
-- cosine). SQL and IMMUTABLE so a CHECK can use it.
CREATE OR REPLACE FUNCTION content_embedding_vector_ok(v real[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND array_ndims(v) = 1 AND array_position(v, NULL) IS NULL
    AND NOT (v && ARRAY['NaN', 'Infinity', '-Infinity']::real[])
    AND (SELECT abs(sum(x::float8 * x::float8) - 1) <= 0.02 FROM unnest(v) AS x)
$$;

CREATE TABLE IF NOT EXISTS content_embeddings (
  id uuid PRIMARY KEY,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  entity_type text NOT NULL,
  owner_institution_id uuid REFERENCES organizations(id),
  tenant_scope text NOT NULL,
  language text NOT NULL,
  chunk_index smallint NOT NULL,
  chunk_count smallint NOT NULL,
  chunk_text text NOT NULL,
  chunk_hash text NOT NULL,
  source_content_hash text NOT NULL,
  embedding real[] NOT NULL,
  dimensions smallint NOT NULL,
  embedding_model text NOT NULL,
  embedding_version text NOT NULL,
  source text NOT NULL DEFAULT 'AI_GENERATED',
  generator_version text NOT NULL,
  prompt_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE content_embeddings DROP CONSTRAINT IF EXISTS content_embeddings_entity_ck;
ALTER TABLE content_embeddings ADD CONSTRAINT content_embeddings_entity_ck CHECK (entity_type = 'LESSON');
-- The scope says what the owner says; a GLOBAL chunk has no owner, an INSTITUTION chunk always has one.
ALTER TABLE content_embeddings DROP CONSTRAINT IF EXISTS content_embeddings_scope_ck;
ALTER TABLE content_embeddings ADD CONSTRAINT content_embeddings_scope_ck CHECK (
  (tenant_scope = 'GLOBAL' AND owner_institution_id IS NULL)
  OR (tenant_scope = 'INSTITUTION' AND owner_institution_id IS NOT NULL));
ALTER TABLE content_embeddings DROP CONSTRAINT IF EXISTS content_embeddings_language_ck;
ALTER TABLE content_embeddings ADD CONSTRAINT content_embeddings_language_ck CHECK (
  language IN ('en','hi','te','ta','kn','ml','mr','bn','gu','pa','or'));
ALTER TABLE content_embeddings DROP CONSTRAINT IF EXISTS content_embeddings_chunk_ck;
ALTER TABLE content_embeddings ADD CONSTRAINT content_embeddings_chunk_ck CHECK (
  chunk_index >= 0 AND chunk_index < chunk_count AND chunk_count <= 64
  AND length(chunk_text) BETWEEN 1 AND 4000
  AND chunk_hash = encode(sha256(convert_to(chunk_text, 'UTF8')), 'hex')
  AND source_content_hash ~ '^[0-9a-fA-F]{64}$');
ALTER TABLE content_embeddings DROP CONSTRAINT IF EXISTS content_embeddings_vector_ck;
ALTER TABLE content_embeddings ADD CONSTRAINT content_embeddings_vector_ck CHECK (
  dimensions BETWEEN 8 AND 4096 AND cardinality(embedding) = dimensions AND content_embedding_vector_ok(embedding));
-- Provenance (CLAUDE.md): what produced the vector. The recipe is the embedding's prompt, so the two
-- version columns agree. No review_state: a vector is never shown or reviewable (ADR-050 §5).
ALTER TABLE content_embeddings DROP CONSTRAINT IF EXISTS content_embeddings_provenance_ck;
ALTER TABLE content_embeddings ADD CONSTRAINT content_embeddings_provenance_ck CHECK (
  source = 'AI_GENERATED'
  AND length(embedding_model) BETWEEN 1 AND 200
  AND embedding_version ~ '^[a-z0-9][a-z0-9._-]{1,63}@[1-9][0-9]{0,5}$'
  AND prompt_version = embedding_version
  AND length(generator_version) BETWEEN 1 AND 200);

-- One row per chunk per model and recipe: the job inserts ON CONFLICT DO NOTHING, so a rerun or a
-- concurrent run never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS content_embeddings_chunk_uq
  ON content_embeddings (content_revision_id, embedding_model, embedding_version, chunk_index);
-- Retrieval narrows by model, recipe, dimension count and language before scanning.
CREATE INDEX IF NOT EXISTS content_embeddings_lookup_idx
  ON content_embeddings (embedding_model, embedding_version, dimensions, language);

-- Only approved, current content is embedded; a chunk's scope and source hash are its revision's.
-- Rows are never edited: a different vector is a delete and a new row.
CREATE OR REPLACE FUNCTION content_embedding_guard() RETURNS trigger AS $$
DECLARE
  src record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'content embeddings are never edited; delete the rows and embed again';
  END IF;
  SELECT s.entity_type, s.owner_institution_id, s.content_hash INTO src
  FROM content_retrieval_sources s WHERE s.content_revision_id = NEW.content_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only approved, current content is embedded';
  END IF;
  IF NEW.owner_institution_id IS DISTINCT FROM src.owner_institution_id THEN
    RAISE EXCEPTION 'an embedding takes its tenant scope from its content revision';
  END IF;
  IF NEW.entity_type <> src.entity_type OR NEW.source_content_hash <> src.content_hash THEN
    RAISE EXCEPTION 'an embedding names its content revision''s type and hash';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_embeddings_guard ON content_embeddings;
CREATE TRIGGER content_embeddings_guard BEFORE INSERT OR UPDATE ON content_embeddings
  FOR EACH ROW EXECUTE FUNCTION content_embedding_guard();

COMMENT ON TABLE content_embeddings IS
  'ENG-24: one embedded chunk of approved, current content per model and recipe. A rebuildable projection; retrieval re-checks approval and tenant scope live.';
