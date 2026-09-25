-- Job-role catalogue administration (OPS-08).
--
-- Design: docs/architecture/career-catalogue-table-design.md
-- Input:  docs/ops/inputs/job-role-catalogue.md (Appendix 4: 108 roles, 13 goals)
--
-- 1. Catalogue columns on career_roles (0011), keeping every 0011 constraint.
-- 2. required_evidence_types on career_role_requirements, declared exactly as ENG-04's
--    0050 declares it, so whichever lands first the replay converges on one column.
-- 3. career_role_synonyms.
-- 4. Versioned requirement sets: draft -> review -> approved publish. career_role_requirements
--    stays the live set the gap engine reads; nothing here changes computeCareerGap.
-- 5. Extension columns on operation_approvals (0038) for approval actions added after 0038.
-- 6. The student-facing feature flag, default off.
--
-- The migrator replays every file on every run, in lexical order, with no tracking table.
-- Everything here is idempotent (IF NOT EXISTS; constraints dropped and re-added under
-- their own names; CREATE OR REPLACE for functions). Only tables from 0001-0038 are
-- referenced. No rows are seeded except the feature flag: the catalogue is loaded by
-- `db:seed:career-catalogue`, reference content deployed on purpose.

-- ---------------------------------------------------------------------------
-- 1. Catalogue columns on career_roles
-- ---------------------------------------------------------------------------
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS catalogue_code text;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS catalogue_family text;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS catalogue_title text;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS eligible_branches text[] NOT NULL DEFAULT '{}';
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS core_skill_areas text;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS main_evidence text;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS planned_release text;
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS release_label text;
-- Every row that exists before this migration was written by the starter seed.
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'STARTER';
ALTER TABLE career_roles ADD COLUMN IF NOT EXISTS catalogue_version text;

-- Each branch label is a short trimmed phrase from the catalogue's "Typical branches" cell.
CREATE OR REPLACE FUNCTION career_branch_labels_valid(labels text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(labels) <= 20
     AND NOT EXISTS (SELECT 1 FROM unnest(labels) AS label
                     WHERE label IS NULL OR label <> btrim(label) OR length(label) NOT BETWEEN 1 AND 60)
$$;

ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_catalogue_code_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_catalogue_code_ck
  CHECK (catalogue_code IS NULL OR catalogue_code ~ '^[SDCELMPVB][0-9]{2}$');
ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_catalogue_family_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_catalogue_family_ck
  CHECK (catalogue_family IS NULL OR catalogue_family IN ('A','B','C','D','E','F'));
ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_catalogue_text_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_catalogue_text_ck CHECK (
  (catalogue_title IS NULL OR (length(catalogue_title) BETWEEN 1 AND 160 AND catalogue_title !~ '^[=+@-]'))
  AND (core_skill_areas IS NULL OR length(core_skill_areas) BETWEEN 1 AND 1000)
  AND (main_evidence IS NULL OR length(main_evidence) BETWEEN 1 AND 500)
  AND (catalogue_version IS NULL OR catalogue_version ~ '^[a-z0-9-]{3,40}$'));
ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_branches_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_branches_ck CHECK (career_branch_labels_valid(eligible_branches));
-- The plan (when a full track is due) and the label (what the role is today) are separate.
ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_release_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_release_ck CHECK (
  (planned_release IS NULL OR planned_release IN ('V1','V2','V3'))
  AND (release_label IS NULL OR release_label IN ('SELECTABLE','VERIFIED')));
ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_origin_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_origin_ck CHECK (origin IN ('STARTER','CATALOGUE'));
-- A catalogued role carries its family, name, label and source; a catalogue-born role is catalogued.
ALTER TABLE career_roles DROP CONSTRAINT IF EXISTS career_role_catalogue_shape_ck;
ALTER TABLE career_roles ADD CONSTRAINT career_role_catalogue_shape_ck CHECK (
  (catalogue_code IS NULL OR (catalogue_family IS NOT NULL AND catalogue_title IS NOT NULL
                              AND release_label IS NOT NULL AND catalogue_version IS NOT NULL))
  AND (origin <> 'CATALOGUE' OR catalogue_code IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS career_role_catalogue_code_uq ON career_roles(catalogue_code) WHERE catalogue_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS career_role_catalogue_family_idx ON career_roles(catalogue_family, catalogue_code);

COMMENT ON COLUMN career_roles.planned_release IS
  'Appendix 4 plan: the release in which the role is due a full track (V1/V2/V3). Planning data, not a claim.';
COMMENT ON COLUMN career_roles.release_label IS
  'What the role is today: SELECTABLE, or VERIFIED only through an approved requirement-set publish (OPS-08).';
COMMENT ON COLUMN career_roles.origin IS
  'STARTER: created by the starter seed (offered to students today). CATALOGUE: created by the catalogue seed (offered only behind career-catalogue.selectable-roles).';

-- ---------------------------------------------------------------------------
-- 2. Required evidence types on the live requirements (same definition as 0050)
-- ---------------------------------------------------------------------------
ALTER TABLE career_role_requirements ADD COLUMN IF NOT EXISTS required_evidence_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE career_role_requirements DROP CONSTRAINT IF EXISTS career_requirement_evidence_types_ck;
ALTER TABLE career_role_requirements ADD CONSTRAINT career_requirement_evidence_types_ck
  CHECK (array_position(required_evidence_types, NULL) IS NULL
    AND required_evidence_types <@ ARRAY['LESSON_COMPLETION','ASSESSMENT_OUTCOME','TOPIC_DEMONSTRATION']::text[]);

-- ---------------------------------------------------------------------------
-- 3. Synonyms: the words students use for a role
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_role_synonyms (
  id uuid PRIMARY KEY,
  career_role_id uuid NOT NULL REFERENCES career_roles(id),
  synonym text NOT NULL,
  normalized text NOT NULL,
  reason_code text NOT NULL,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  removed_reason_code text
);
ALTER TABLE career_role_synonyms DROP CONSTRAINT IF EXISTS career_role_synonym_text_ck;
ALTER TABLE career_role_synonyms ADD CONSTRAINT career_role_synonym_text_ck CHECK (
  length(synonym) BETWEEN 2 AND 120 AND synonym = btrim(synonym) AND synonym !~ '^[=+@-]'
  AND normalized = lower(normalized) AND normalized = btrim(normalized) AND length(normalized) BETWEEN 2 AND 120
  AND reason_code ~ '^[A-Z0-9_:-]{3,64}$');
ALTER TABLE career_role_synonyms DROP CONSTRAINT IF EXISTS career_role_synonym_removed_ck;
ALTER TABLE career_role_synonyms ADD CONSTRAINT career_role_synonym_removed_ck CHECK (
  (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_reason_code IS NULL)
  OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL AND removed_at >= created_at
      AND removed_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));
CREATE UNIQUE INDEX IF NOT EXISTS career_role_synonym_live_uq ON career_role_synonyms(career_role_id, normalized) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS career_role_synonym_normalized_idx ON career_role_synonyms(normalized) WHERE removed_at IS NULL;

-- A synonym is added and may later be removed; nothing else about it changes, and it is
-- never deleted, so what students could search for stays reconstructable.
CREATE OR REPLACE FUNCTION career_role_synonym_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'career role synonyms are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a career role synonym starts live';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.career_role_id <> OLD.career_role_id OR NEW.synonym <> OLD.synonym
     OR NEW.normalized <> OLD.normalized OR NEW.reason_code <> OLD.reason_code
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a career role synonym is immutable';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a removed career role synonym stays removed';
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    NEW.removed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS career_role_synonym_guard ON career_role_synonyms;
CREATE TRIGGER career_role_synonym_guard BEFORE INSERT OR UPDATE OR DELETE ON career_role_synonyms
  FOR EACH ROW EXECUTE FUNCTION career_role_synonym_guard();

-- ---------------------------------------------------------------------------
-- 5 (first, because 4 references it). Approval actions added after 0038
-- ---------------------------------------------------------------------------
-- 0038 drops and re-adds operation_approval_action_ck and operation_approval_target_ck with
-- its five keys on every replay, and ADD CONSTRAINT validates existing rows. A sixth key in
-- action_key would make every later migrate fail once one such row exists. So a key added
-- after 0038 lives in extended_action_key, with action_key and target_type NULL (a NULL
-- satisfies 0038's CHECKs on every replay), and its vocabulary lives in a function that a
-- later migration replaces with CREATE OR REPLACE -- which converges on replay because
-- later files run later, and never re-validates existing rows.
ALTER TABLE operation_approvals ADD COLUMN IF NOT EXISTS extended_action_key text;
ALTER TABLE operation_approvals ADD COLUMN IF NOT EXISTS extended_target_type text;
ALTER TABLE operation_approvals ALTER COLUMN action_key DROP NOT NULL;
ALTER TABLE operation_approvals ALTER COLUMN target_type DROP NOT NULL;

ALTER TABLE operation_approvals DROP CONSTRAINT IF EXISTS operation_approval_action_extension_ck;
ALTER TABLE operation_approvals ADD CONSTRAINT operation_approval_action_extension_ck CHECK (
  length(target_id) BETWEEN 1 AND 128
  AND ((action_key IS NOT NULL AND target_type IS NOT NULL
        AND extended_action_key IS NULL AND extended_target_type IS NULL)
    OR (action_key IS NULL AND target_type IS NULL
        AND extended_action_key ~ '^[A-Z][A-Z0-9_]{2,63}$'
        AND extended_target_type ~ '^[a-z][a-z0-9_]{2,63}$')));

-- The extended vocabulary: the target type each extended action acts on, or NULL for an
-- unknown key. A later goal adds its key by replacing this function in its own migration.
CREATE OR REPLACE FUNCTION operation_approval_extended_target_type(action text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE action
    WHEN 'CAREER_REQUIREMENT_SET_PUBLISH' THEN 'career_requirement_set'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION operation_approval_extension_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.extended_action_key IS NOT NULL
       AND operation_approval_extended_target_type(NEW.extended_action_key) IS DISTINCT FROM NEW.extended_target_type THEN
      RAISE EXCEPTION 'unknown extended approval action';
    END IF;
    RETURN NEW;
  END IF;
  -- 0038's guard compares these with <>, which a NULL slips past; IS DISTINCT FROM does not.
  IF NEW.action_key IS DISTINCT FROM OLD.action_key OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.extended_action_key IS DISTINCT FROM OLD.extended_action_key
     OR NEW.extended_target_type IS DISTINCT FROM OLD.extended_target_type THEN
    RAISE EXCEPTION 'an operation approval request is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS operation_approval_extension_guard ON operation_approvals;
CREATE TRIGGER operation_approval_extension_guard BEFORE INSERT OR UPDATE ON operation_approvals
  FOR EACH ROW EXECUTE FUNCTION operation_approval_extension_guard();

COMMENT ON COLUMN operation_approvals.extended_action_key IS
  'An approval action added after 0038 (OPS-08 onward); action_key is then NULL. Vocabulary: operation_approval_extended_target_type().';

-- ---------------------------------------------------------------------------
-- 4. Requirement sets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS career_requirement_sets (
  id uuid PRIMARY KEY,
  career_role_id uuid NOT NULL REFERENCES career_roles(id),
  version integer NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  based_on text NOT NULL,
  based_on_set_id uuid REFERENCES career_requirement_sets(id),
  reason_code text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_by_user_id uuid REFERENCES users(id),
  submitted_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_reason_code text,
  review_note text,
  published_by_user_id uuid REFERENCES users(id),
  published_at timestamptz,
  publish_approval_id uuid REFERENCES operation_approvals(id),
  publish_reason_code text,
  release_label_at_publish text,
  superseded_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_reason_code text
);

ALTER TABLE career_requirement_sets DROP CONSTRAINT IF EXISTS career_requirement_set_basics_ck;
ALTER TABLE career_requirement_sets ADD CONSTRAINT career_requirement_set_basics_ck CHECK (
  version > 0
  AND state IN ('DRAFT','IN_REVIEW','REVIEWED','PUBLISHED','SUPERSEDED','WITHDRAWN')
  AND based_on IN ('EMPTY','LIVE','SET')
  AND ((based_on = 'SET') = (based_on_set_id IS NOT NULL))
  AND reason_code ~ '^[A-Z0-9_:-]{3,64}$'
  AND (review_reason_code IS NULL OR review_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
  AND (review_note IS NULL OR length(review_note) BETWEEN 1 AND 500)
  AND (publish_reason_code IS NULL OR publish_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
  AND (release_label_at_publish IS NULL OR release_label_at_publish IN ('SELECTABLE','VERIFIED'))
  AND (withdrawn_reason_code IS NULL OR withdrawn_reason_code ~ '^[A-Z0-9_:-]{3,64}$'));

-- Which stamps each state carries. The reviewer is never the author. review_reason_code and
-- review_note hold the last review decision: the pass on a REVIEWED set, or why a set was
-- sent back to DRAFT.
ALTER TABLE career_requirement_sets DROP CONSTRAINT IF EXISTS career_requirement_set_state_ck;
ALTER TABLE career_requirement_sets ADD CONSTRAINT career_requirement_set_state_ck CHECK (
  (reviewed_by_user_id IS NULL OR reviewed_by_user_id <> created_by_user_id)
  AND ((submitted_by_user_id IS NULL) = (submitted_at IS NULL))
  AND ((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL))
  AND ((published_by_user_id IS NULL) = (published_at IS NULL)
       AND (published_at IS NULL) = (publish_approval_id IS NULL)
       AND (published_at IS NULL) = (publish_reason_code IS NULL)
       AND (published_at IS NULL) = (release_label_at_publish IS NULL))
  AND ((withdrawn_at IS NULL) = (withdrawn_reason_code IS NULL))
  AND CASE state
    WHEN 'DRAFT' THEN submitted_at IS NULL AND reviewed_at IS NULL AND published_at IS NULL
                      AND superseded_at IS NULL AND withdrawn_at IS NULL
    WHEN 'IN_REVIEW' THEN submitted_at IS NOT NULL AND reviewed_at IS NULL AND published_at IS NULL
                      AND superseded_at IS NULL AND withdrawn_at IS NULL
    WHEN 'REVIEWED' THEN submitted_at IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason_code IS NOT NULL AND published_at IS NULL
                      AND superseded_at IS NULL AND withdrawn_at IS NULL
    WHEN 'PUBLISHED' THEN submitted_at IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NOT NULL
                      AND superseded_at IS NULL AND withdrawn_at IS NULL
    WHEN 'SUPERSEDED' THEN published_at IS NOT NULL AND superseded_at IS NOT NULL AND withdrawn_at IS NULL
    WHEN 'WITHDRAWN' THEN published_at IS NULL AND superseded_at IS NULL AND withdrawn_at IS NOT NULL
    ELSE false
  END);

CREATE UNIQUE INDEX IF NOT EXISTS career_requirement_set_version_uq ON career_requirement_sets(career_role_id, version);
-- One set in progress and one published set per role.
CREATE UNIQUE INDEX IF NOT EXISTS career_requirement_set_open_uq ON career_requirement_sets(career_role_id)
  WHERE state IN ('DRAFT','IN_REVIEW','REVIEWED');
CREATE UNIQUE INDEX IF NOT EXISTS career_requirement_set_published_uq ON career_requirement_sets(career_role_id)
  WHERE state = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS career_requirement_set_queue_idx ON career_requirement_sets(state, created_at, id);

CREATE TABLE IF NOT EXISTS career_requirement_set_items (
  id uuid PRIMARY KEY,
  set_id uuid NOT NULL REFERENCES career_requirement_sets(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  requirement_level text NOT NULL,
  target_mastery numeric(4,3) NOT NULL,
  rationale text,
  required_evidence_types text[] NOT NULL DEFAULT '{}'
);
-- The same rules as the live table (0011, 0050), so anything that can be drafted can go live.
ALTER TABLE career_requirement_set_items DROP CONSTRAINT IF EXISTS career_requirement_set_item_ck;
ALTER TABLE career_requirement_set_items ADD CONSTRAINT career_requirement_set_item_ck CHECK (
  requirement_level IN ('ESSENTIAL','IMPORTANT','HELPFUL')
  AND target_mastery > 0 AND target_mastery <= 1
  AND (rationale IS NULL OR length(rationale) BETWEEN 1 AND 500)
  AND array_position(required_evidence_types, NULL) IS NULL
  AND required_evidence_types <@ ARRAY['LESSON_COMPLETION','ASSESSMENT_OUTCOME','TOPIC_DEMONSTRATION']::text[]);
CREATE UNIQUE INDEX IF NOT EXISTS career_requirement_set_item_topic_uq ON career_requirement_set_items(set_id, topic_id);

-- Lifecycle rules a second writer cannot skip.
CREATE OR REPLACE FUNCTION career_requirement_set_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'career requirement sets are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN
      RAISE EXCEPTION 'a career requirement set starts as DRAFT';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.career_role_id <> OLD.career_role_id OR NEW.version <> OLD.version
     OR NEW.based_on <> OLD.based_on OR NEW.based_on_set_id IS DISTINCT FROM OLD.based_on_set_id
     OR NEW.reason_code <> OLD.reason_code OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a career requirement set''s identity is immutable';
  END IF;

  IF (OLD.state, NEW.state) IN (('DRAFT','IN_REVIEW'), ('IN_REVIEW','REVIEWED'), ('IN_REVIEW','DRAFT'),
                                ('REVIEWED','DRAFT'), ('DRAFT','WITHDRAWN'), ('IN_REVIEW','WITHDRAWN'),
                                ('REVIEWED','WITHDRAWN'), ('REVIEWED','PUBLISHED'), ('PUBLISHED','SUPERSEDED')) THEN
    IF NEW.state = 'IN_REVIEW' THEN NEW.submitted_at := now(); END IF;
    -- Back to DRAFT: the submission and any pass are void; the last review reason and note
    -- stay, so the author can see why it came back.
    IF NEW.state = 'DRAFT' THEN
      NEW.submitted_by_user_id := NULL; NEW.submitted_at := NULL;
      NEW.reviewed_by_user_id := NULL; NEW.reviewed_at := NULL;
    END IF;
    IF NEW.state = 'REVIEWED' THEN NEW.reviewed_at := now(); END IF;
    IF NEW.state = 'WITHDRAWN' THEN NEW.withdrawn_at := now(); END IF;
    IF NEW.state = 'SUPERSEDED' THEN
      IF NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.publish_approval_id IS DISTINCT FROM OLD.publish_approval_id
         OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
         OR NEW.release_label_at_publish IS DISTINCT FROM OLD.release_label_at_publish THEN
        RAISE EXCEPTION 'a published career requirement set is immutable';
      END IF;
      NEW.superseded_at := now();
    END IF;
    IF NEW.state = 'PUBLISHED' THEN
      -- Only through an approval for exactly this set, consumed in this transaction.
      IF NOT EXISTS (
        SELECT 1 FROM operation_approvals a
        WHERE a.id = NEW.publish_approval_id AND a.extended_action_key = 'CAREER_REQUIREMENT_SET_PUBLISH'
          AND a.target_id = NEW.id::text AND a.state = 'EXECUTED') THEN
        RAISE EXCEPTION 'publishing a career requirement set needs an executed approval for it';
      END IF;
      NEW.published_at := now();
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'career requirement set cannot move from % to %', OLD.state, NEW.state;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS career_requirement_set_guard ON career_requirement_sets;
CREATE TRIGGER career_requirement_set_guard BEFORE INSERT OR UPDATE OR DELETE ON career_requirement_sets
  FOR EACH ROW EXECUTE FUNCTION career_requirement_set_guard();

-- Items change only while their set is a DRAFT: submitting freezes what is reviewed and approved.
CREATE OR REPLACE FUNCTION career_requirement_set_item_guard() RETURNS trigger AS $$
DECLARE
  set_state text;
BEGIN
  SELECT state INTO set_state FROM career_requirement_sets
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.set_id ELSE NEW.set_id END;
  IF set_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'requirement set items change only while the set is a DRAFT';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.set_id <> OLD.set_id) THEN
    RAISE EXCEPTION 'a requirement set item cannot move between sets';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS career_requirement_set_item_guard ON career_requirement_set_items;
CREATE TRIGGER career_requirement_set_item_guard BEFORE INSERT OR UPDATE OR DELETE ON career_requirement_set_items
  FOR EACH ROW EXECUTE FUNCTION career_requirement_set_item_guard();

-- A role's release label starts SELECTABLE and changes only as a published set said.
CREATE OR REPLACE FUNCTION career_role_release_label_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.release_label = 'VERIFIED' THEN
      RAISE EXCEPTION 'a career role is verified only through an approved requirement-set publish';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.release_label IS DISTINCT FROM OLD.release_label THEN
    IF OLD.release_label IS NULL AND NEW.release_label = 'SELECTABLE' THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM career_requirement_sets s
      WHERE s.career_role_id = NEW.id AND s.state = 'PUBLISHED' AND s.release_label_at_publish = NEW.release_label
        AND s.published_at = now()) THEN
      RAISE EXCEPTION 'a career role''s release label changes only with an approved requirement-set publish';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS career_role_release_label_guard ON career_roles;
CREATE TRIGGER career_role_release_label_guard BEFORE INSERT OR UPDATE OF release_label ON career_roles
  FOR EACH ROW EXECUTE FUNCTION career_role_release_label_guard();

COMMENT ON TABLE career_requirement_sets IS
  'Versioned career requirement sets (OPS-08): draft, review by someone other than the author, publish with a dual-control approval. The published set is copied into career_role_requirements, which the gap engine reads.';

-- ---------------------------------------------------------------------------
-- 6. Student-facing flag, default off
-- ---------------------------------------------------------------------------
INSERT INTO feature_flags (key, description, enabled)
VALUES ('career-catalogue.selectable-roles',
        'Offer students the full job-role catalogue (108 roles, each labelled with its release status). Off: only the starter roles are offered.',
        false)
ON CONFLICT (key) DO NOTHING;
