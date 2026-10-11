-- Stream D — Learner | D2 | migration 0024
--
-- Generic, non-assessment learner content for Practice resources, Company
-- Prep, Career Tools, Scholarships and Resume Builder. Scored questions,
-- attempts and results remain in the institution assessment engine created by
-- migration 0012.
--
-- New content always begins as DRAFT through the repository. The state set
-- matches the governed content lifecycle introduced in migration 0004 so D4
-- can add human review actions without changing this storage contract.
-- GENERATED is intentionally not an allowed source yet. Its nullable metadata
-- columns reserve the future provenance shape without activating AI/model work.

CREATE TABLE IF NOT EXISTS learner_content_items (
  id uuid PRIMARY KEY,
  content_type text NOT NULL,
  title text NOT NULL,
  summary text,
  content jsonb NOT NULL,
  source text NOT NULL,
  generator_version text,
  prompt_version text,
  review_state text NOT NULL DEFAULT 'DRAFT',
  generated_at timestamptz,
  published_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_content_type_ck CHECK (content_type IN (
    'PRACTICE', 'COMPANY_PREP', 'CAREER_TOOL', 'SCHOLARSHIP', 'RESUME_BUILDER'
  )),
  CONSTRAINT learner_content_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT learner_content_summary_ck CHECK (
    summary IS NULL OR length(btrim(summary)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT learner_content_body_ck CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT learner_content_source_ck CHECK (source IN ('SEEDED', 'AUTHORED')),
  CONSTRAINT learner_content_generator_version_ck CHECK (
    generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 128
  ),
  CONSTRAINT learner_content_prompt_version_ck CHECK (
    prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 128
  ),
  CONSTRAINT learner_content_review_state_ck CHECK (review_state IN (
    'DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'ARCHIVED'
  )),
  CONSTRAINT learner_content_current_source_provenance_ck CHECK (
    source NOT IN ('SEEDED', 'AUTHORED') OR
    (generator_version IS NULL AND prompt_version IS NULL AND generated_at IS NULL)
  ),
  CONSTRAINT learner_content_publication_ck CHECK (
    (review_state = 'PUBLISHED') = (published_at IS NOT NULL)
  ),
  CONSTRAINT learner_content_sort_order_ck CHECK (sort_order BETWEEN 0 AND 1000000),
  CONSTRAINT learner_content_metadata_ck CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS learner_content_published_idx
  ON learner_content_items(content_type, sort_order, published_at DESC, id)
  WHERE review_state = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS learner_content_review_queue_idx
  ON learner_content_items(review_state, created_at, id)
  WHERE review_state IN ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED');
