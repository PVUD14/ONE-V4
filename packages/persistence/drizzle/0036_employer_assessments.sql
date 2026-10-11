-- Employer screening assessments.
--
-- Design in docs/architecture/employer-assessment-table-design.md; the decisions recorded
-- there are adopted here.
--
-- The institution engine in 0012 already does all of this, and its tables are keyed on
-- institution_id -- a foreign key to organizations, which an employer also satisfies.
-- Writing employer rows there would run and would pass every constraint. It is not done,
-- because the column would then lie to every future reader, and the first query that joins
-- those tables to a roster on the reasonable assumption that institution_id means an
-- institution would leak across tenants with no constraint to stop it.
--
-- Two rules shape everything below.
--
-- An employer assessment result is never readiness evidence. Nothing here references
-- evidence_records, readiness_snapshots, taxonomy_nodes or mastery_projections, and no
-- route added with this migration writes to them. If a screening test could feed the band,
-- an employer would be shaping readiness indirectly and the band's central promise --
-- advisory, sourced from the institution and ONE, never employer-driven -- would be hollow.
--
-- An employer's bank is their own, permanently. The composite-key technique from 0012 is
-- used again: every reference carries employer_id, so one employer's question cannot be
-- referenced by another employer's assessment. Not forbidden -- inexpressible.

-- ---------------------------------------------------------------------------
-- The employer's question bank
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employer_assessment_questions (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  question_text text NOT NULL,
  question_type text NOT NULL,
  difficulty text NOT NULL DEFAULT 'MEDIUM',
  marks numeric(6,2) NOT NULL DEFAULT 1,
  -- Catches the same question written twice by two recruiters.
  question_hash text NOT NULL,
  approval_status text NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employer_question_type_ck CHECK (question_type IN
    ('SINGLE_CHOICE_MCQ','MULTIPLE_SELECT','TRUE_FALSE','SCENARIO_MCQ','CODE_OUTPUT_MCQ','NUMERICAL_MCQ')),
  CONSTRAINT employer_question_difficulty_ck CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  CONSTRAINT employer_question_status_ck CHECK (approval_status IN
    ('DRAFT','UNDER_REVIEW','APPROVED','REJECTED','ARCHIVED')),
  CONSTRAINT employer_question_text_ck CHECK (length(btrim(question_text)) BETWEEN 1 AND 4000),
  CONSTRAINT employer_question_marks_ck CHECK (marks > 0 AND marks <= 100),
  CONSTRAINT employer_question_version_ck CHECK (version >= 1),
  CONSTRAINT employer_question_reviewed_pair_ck CHECK ((reviewed_by_user_id IS NULL) = (reviewed_at IS NULL))
);
-- The composite key every reference below carries, so a question can never be pulled into
-- another employer's assessment.
CREATE UNIQUE INDEX IF NOT EXISTS employer_question_id_employer_uq
  ON employer_assessment_questions(id, employer_id);
CREATE INDEX IF NOT EXISTS employer_question_bank_idx
  ON employer_assessment_questions(employer_id, approval_status, question_type);
CREATE INDEX IF NOT EXISTS employer_question_hash_idx
  ON employer_assessment_questions(employer_id, question_hash);

CREATE TABLE IF NOT EXISTS employer_assessment_question_options (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES employer_assessment_questions(id) ON DELETE CASCADE,
  option_key text NOT NULL,
  option_text text NOT NULL,
  -- The answer key. Never selected into anything a candidate receives.
  is_correct boolean NOT NULL DEFAULT false,
  CONSTRAINT employer_option_key_ck CHECK (length(option_key) BETWEEN 1 AND 8),
  CONSTRAINT employer_option_text_ck CHECK (length(btrim(option_text)) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_option_question_key_uq
  ON employer_assessment_question_options(question_id, option_key);

COMMENT ON COLUMN employer_assessment_question_options.is_correct IS
  'Answer key. Server-side only: candidate payloads are built without this column.';

-- ---------------------------------------------------------------------------
-- The assessment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employer_assessments (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  opportunity_id uuid,
  title text NOT NULL,
  duration_seconds integer NOT NULL,
  total_marks numeric(8,2) NOT NULL DEFAULT 0,
  lifecycle_state text NOT NULL DEFAULT 'DRAFT',
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employer_assessment_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT employer_assessment_duration_ck CHECK (duration_seconds BETWEEN 300 AND 14400),
  CONSTRAINT employer_assessment_state_ck CHECK (lifecycle_state IN ('DRAFT','PUBLISHED','CLOSED','ARCHIVED')),
  CONSTRAINT employer_assessment_published_ck CHECK (lifecycle_state = 'DRAFT' OR published_at IS NOT NULL),
  -- The opportunity must belong to the same employer; 0007 carries that composite key.
  CONSTRAINT employer_assessment_opportunity_fk
    FOREIGN KEY (opportunity_id, employer_id) REFERENCES opportunities(id, employer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_assessment_id_employer_uq
  ON employer_assessments(id, employer_id);
CREATE INDEX IF NOT EXISTS employer_assessment_employer_idx
  ON employer_assessments(employer_id, lifecycle_state, created_at DESC);

CREATE TABLE IF NOT EXISTS employer_assessment_items (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  question_id uuid NOT NULL,
  sequence integer NOT NULL,
  marks numeric(6,2) NOT NULL,
  CONSTRAINT employer_item_sequence_ck CHECK (sequence >= 1 AND sequence <= 500),
  CONSTRAINT employer_item_marks_ck CHECK (marks > 0 AND marks <= 100),
  CONSTRAINT employer_item_assessment_fk
    FOREIGN KEY (assessment_id, employer_id) REFERENCES employer_assessments(id, employer_id),
  -- The wall: the question must belong to the same employer as the assessment.
  CONSTRAINT employer_item_question_fk
    FOREIGN KEY (question_id, employer_id) REFERENCES employer_assessment_questions(id, employer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_item_assessment_sequence_uq
  ON employer_assessment_items(assessment_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS employer_item_assessment_question_uq
  ON employer_assessment_items(assessment_id, question_id);

-- ---------------------------------------------------------------------------
-- Inviting an applicant
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employer_assessment_invitations (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  application_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'INVITED',
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  invited_at timestamptz NOT NULL DEFAULT now(),
  opens_at timestamptz NOT NULL DEFAULT now(),
  closes_at timestamptz NOT NULL,
  -- No CANCELLED state. Withdrawing an invitation a candidate has already begun would
  -- discard work they have done; an employer who changes their mind lets it expire.
  CONSTRAINT employer_invitation_state_ck CHECK (state IN ('INVITED','STARTED','SUBMITTED','EXPIRED')),
  CONSTRAINT employer_invitation_window_ck CHECK (closes_at > opens_at),
  CONSTRAINT employer_invitation_assessment_fk
    FOREIGN KEY (assessment_id, employer_id) REFERENCES employer_assessments(id, employer_id),
  CONSTRAINT employer_invitation_application_fk
    FOREIGN KEY (application_id, employer_id) REFERENCES applications(id, employer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_invitation_assessment_application_uq
  ON employer_assessment_invitations(assessment_id, application_id);
CREATE INDEX IF NOT EXISTS employer_invitation_application_idx
  ON employer_assessment_invitations(application_id, invited_at DESC);

COMMENT ON TABLE employer_assessment_invitations IS
  'A screening test sent to one applicant. Requires a live, consented application: the employer''s access to that person ended with the application, and an invitation must not be a way to reach them after it did.';

-- ---------------------------------------------------------------------------
-- Taking it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employer_assessment_attempts (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES employer_assessment_invitations(id),
  candidate_user_id uuid NOT NULL REFERENCES users(id),
  -- Frozen at start: the per-candidate question and option order derive from this, so the
  -- same attempt always renders the same paper.
  seed text NOT NULL,
  state text NOT NULL DEFAULT 'IN_PROGRESS',
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  score numeric(8,2),
  max_score numeric(8,2),
  percentage numeric(5,2),
  CONSTRAINT employer_attempt_state_ck CHECK (state IN ('IN_PROGRESS','SUBMITTED','EXPIRED')),
  CONSTRAINT employer_attempt_seed_ck CHECK (length(seed) BETWEEN 8 AND 128),
  -- A submitted attempt carries its numbers; an unsubmitted one carries none.
  CONSTRAINT employer_attempt_submitted_ck CHECK (
    (state = 'SUBMITTED') = (submitted_at IS NOT NULL)),
  CONSTRAINT employer_attempt_score_ck CHECK (
    (submitted_at IS NULL AND score IS NULL AND max_score IS NULL AND percentage IS NULL)
    OR (submitted_at IS NOT NULL AND score IS NOT NULL AND max_score IS NOT NULL AND percentage IS NOT NULL)),
  CONSTRAINT employer_attempt_percentage_ck CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100))
);
-- One attempt per invitation. A second sitting is a second invitation, deliberately.
CREATE UNIQUE INDEX IF NOT EXISTS employer_attempt_invitation_uq
  ON employer_assessment_attempts(invitation_id);
CREATE INDEX IF NOT EXISTS employer_attempt_candidate_idx
  ON employer_assessment_attempts(candidate_user_id, started_at DESC);

-- The exact revision of each question as the candidate saw it, in their order. Kept so an
-- edited question can never change what someone was actually asked.
CREATE TABLE IF NOT EXISTS employer_assessment_attempt_questions (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES employer_assessment_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES employer_assessment_questions(id),
  display_order integer NOT NULL,
  question_version integer NOT NULL,
  marks numeric(6,2) NOT NULL,
  -- Displayed key -> stored key, so the option order differs per candidate and a leaked
  -- "the answer is B" is worth nothing.
  option_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT employer_attempt_question_order_ck CHECK (display_order >= 1),
  CONSTRAINT employer_attempt_question_version_ck CHECK (question_version >= 1),
  CONSTRAINT employer_attempt_question_map_ck CHECK (jsonb_typeof(option_map) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_attempt_question_uq
  ON employer_assessment_attempt_questions(attempt_id, question_id);
CREATE UNIQUE INDEX IF NOT EXISTS employer_attempt_question_order_uq
  ON employer_assessment_attempt_questions(attempt_id, display_order);

CREATE TABLE IF NOT EXISTS employer_assessment_answers (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES employer_assessment_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES employer_assessment_questions(id),
  selected_option_keys text[] NOT NULL DEFAULT '{}',
  numeric_response numeric(12,4),
  answered_at timestamptz NOT NULL DEFAULT now(),
  is_correct boolean,
  marks_awarded numeric(6,2),
  CONSTRAINT employer_answer_marks_ck CHECK (marks_awarded IS NULL OR marks_awarded >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_answer_attempt_question_uq
  ON employer_assessment_answers(attempt_id, question_id);

COMMENT ON TABLE employer_assessment_attempts IS
  'A screening attempt. The score is stored at submission rather than recomputed, because recomputing against an edited question would silently change a number a hiring decision was already made on.';
