-- Assessment engine: governed question bank, blueprint-assembled assessments,
-- timed student attempts with deterministic per-student papers, server-side
-- scoring and append-only integrity events.
--
-- Structural rules enforced here rather than only in application code:
--   * every row is institution-scoped, and composite foreign keys make it
--     impossible for a question, section, pool entry, assignment or attempt to
--     drift to a different institution than its parent;
--   * only APPROVED questions may enter a published assessment's pool - the
--     publish step re-validates, and the pool rows pin the approved version;
--   * attempts are append-only: answers upsert while IN_PROGRESS, and a result
--     row is written exactly once per attempt;
--   * screen-shift (focus-loss) events are an immutable log per attempt.
--
-- No rows are seeded. These tables are created empty.

-- ---------------------------------------------------------------------------
-- Subjects and syllabus nodes (content hierarchy, per institution)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_subjects (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  code text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_subjects_name_ck CHECK (length(name) BETWEEN 1 AND 160),
  CONSTRAINT exam_subjects_code_ck CHECK (code IS NULL OR (length(code) BETWEEN 1 AND 32 AND code !~ '^[=+@-]'))
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_subjects_institution_name_uq ON exam_subjects(institution_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS exam_subjects_id_institution_uq ON exam_subjects(id, institution_id);

CREATE TABLE IF NOT EXISTS exam_syllabus_nodes (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  parent_node_id uuid,
  kind text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_syllabus_nodes_kind_ck CHECK (kind IN ('UNIT','TOPIC')),
  CONSTRAINT exam_syllabus_nodes_name_ck CHECK (length(name) BETWEEN 1 AND 160),
  CONSTRAINT exam_syllabus_nodes_subject_fk FOREIGN KEY (subject_id, institution_id) REFERENCES exam_subjects(id, institution_id),
  CONSTRAINT exam_syllabus_nodes_parent_fk FOREIGN KEY (parent_node_id) REFERENCES exam_syllabus_nodes(id),
  CONSTRAINT exam_syllabus_nodes_topic_has_parent_ck CHECK (kind = 'UNIT' OR parent_node_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_syllabus_nodes_id_institution_uq ON exam_syllabus_nodes(id, institution_id);
CREATE INDEX IF NOT EXISTS exam_syllabus_nodes_subject_idx ON exam_syllabus_nodes(subject_id, kind, position);

-- ---------------------------------------------------------------------------
-- Question bank: lifecycle-governed, versioned, reviewed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_questions (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  subject_id uuid NOT NULL,
  unit_node_id uuid,
  topic_node_id uuid,
  question_type text NOT NULL,
  question_text text NOT NULL,
  difficulty text NOT NULL DEFAULT 'MEDIUM',
  marks numeric(6,2) NOT NULL DEFAULT 1,
  negative_marks numeric(6,2),
  explanation text,
  category text,
  accepted_answers jsonb,
  case_sensitive boolean NOT NULL DEFAULT false,
  question_hash text NOT NULL,
  approval_status text NOT NULL DEFAULT 'DRAFT',
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_questions_type_ck CHECK (question_type IN ('SINGLE_CHOICE_MCQ','MULTIPLE_SELECT','TRUE_FALSE','FILL_IN_THE_BLANK','MATCH_THE_FOLLOWING','ASSERTION_REASON','SCENARIO_MCQ','CODE_OUTPUT_MCQ','NUMERICAL_MCQ')),
  CONSTRAINT exam_questions_difficulty_ck CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  CONSTRAINT exam_questions_status_ck CHECK (approval_status IN ('DRAFT','UNDER_REVIEW','APPROVED','REJECTED','ARCHIVED')),
  CONSTRAINT exam_questions_text_ck CHECK (length(question_text) BETWEEN 1 AND 4000),
  CONSTRAINT exam_questions_marks_ck CHECK (marks > 0),
  CONSTRAINT exam_questions_negative_ck CHECK (negative_marks IS NULL OR negative_marks >= 0),
  CONSTRAINT exam_questions_version_ck CHECK (version >= 1),
  CONSTRAINT exam_questions_subject_fk FOREIGN KEY (subject_id, institution_id) REFERENCES exam_subjects(id, institution_id),
  CONSTRAINT exam_questions_unit_fk FOREIGN KEY (unit_node_id, institution_id) REFERENCES exam_syllabus_nodes(id, institution_id),
  CONSTRAINT exam_questions_topic_fk FOREIGN KEY (topic_node_id, institution_id) REFERENCES exam_syllabus_nodes(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_questions_id_institution_uq ON exam_questions(id, institution_id);
CREATE INDEX IF NOT EXISTS exam_questions_bank_idx ON exam_questions(institution_id, subject_id, approval_status, question_type);
CREATE INDEX IF NOT EXISTS exam_questions_hash_idx ON exam_questions(institution_id, question_hash);

CREATE TABLE IF NOT EXISTS exam_question_options (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  option_key text NOT NULL,
  option_text text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  match_key text,
  position integer NOT NULL DEFAULT 0,
  CONSTRAINT exam_question_options_key_ck CHECK (length(option_key) BETWEEN 1 AND 8),
  CONSTRAINT exam_question_options_text_ck CHECK (length(option_text) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_question_options_key_uq ON exam_question_options(question_id, option_key);

CREATE TABLE IF NOT EXISTS exam_question_versions (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES exam_questions(id),
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_question_versions_version_ck CHECK (version >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_question_versions_uq ON exam_question_versions(question_id, version);

CREATE TABLE IF NOT EXISTS exam_question_reviews (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES exam_questions(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_question_reviews_note_ck CHECK (note IS NULL OR length(note) <= 2000)
);
CREATE INDEX IF NOT EXISTS exam_question_reviews_question_idx ON exam_question_reviews(question_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Assessment definitions and blueprint sections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_definitions (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  subject_id uuid NOT NULL,
  title text NOT NULL,
  exam_kind text NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'DRAFT',
  total_marks numeric(8,2) NOT NULL,
  duration_seconds integer NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  attempts_allowed integer NOT NULL DEFAULT 1,
  publish_results_immediately boolean NOT NULL DEFAULT true,
  auto_submit_on_focus_loss integer,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_definitions_title_ck CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT exam_definitions_kind_ck CHECK (exam_kind IN ('MID_EXAM','UNIT_TEST','MOCK_TEST')),
  CONSTRAINT exam_definitions_state_ck CHECK (lifecycle_state IN ('DRAFT','PUBLISHED','CLOSED','ARCHIVED')),
  CONSTRAINT exam_definitions_marks_ck CHECK (total_marks > 0),
  CONSTRAINT exam_definitions_duration_ck CHECK (duration_seconds BETWEEN 60 AND 21600),
  CONSTRAINT exam_definitions_window_ck CHECK (ends_at > starts_at),
  CONSTRAINT exam_definitions_attempts_ck CHECK (attempts_allowed BETWEEN 1 AND 10),
  CONSTRAINT exam_definitions_focus_ck CHECK (auto_submit_on_focus_loss IS NULL OR auto_submit_on_focus_loss BETWEEN 1 AND 50),
  CONSTRAINT exam_definitions_published_ck CHECK (lifecycle_state = 'DRAFT' OR published_at IS NOT NULL),
  CONSTRAINT exam_definitions_subject_fk FOREIGN KEY (subject_id, institution_id) REFERENCES exam_subjects(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_definitions_id_institution_uq ON exam_definitions(id, institution_id);
CREATE INDEX IF NOT EXISTS exam_definitions_institution_idx ON exam_definitions(institution_id, lifecycle_state, starts_at DESC);

CREATE TABLE IF NOT EXISTS exam_definition_events (
  id uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES exam_definitions(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exam_definition_events_idx ON exam_definition_events(definition_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exam_sections (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  title text NOT NULL,
  pool_size integer NOT NULL,
  display_count integer NOT NULL,
  marks_per_question numeric(6,2) NOT NULL,
  negative_marks numeric(6,2) NOT NULL DEFAULT 0,
  position integer NOT NULL DEFAULT 0,
  CONSTRAINT exam_sections_title_ck CHECK (length(title) BETWEEN 1 AND 160),
  CONSTRAINT exam_sections_pool_ck CHECK (pool_size >= 1),
  CONSTRAINT exam_sections_display_ck CHECK (display_count >= 1 AND display_count <= pool_size),
  CONSTRAINT exam_sections_marks_ck CHECK (marks_per_question > 0),
  CONSTRAINT exam_sections_negative_ck CHECK (negative_marks >= 0),
  CONSTRAINT exam_sections_definition_fk FOREIGN KEY (definition_id, institution_id) REFERENCES exam_definitions(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_sections_id_institution_uq ON exam_sections(id, institution_id);
CREATE INDEX IF NOT EXISTS exam_sections_definition_idx ON exam_sections(definition_id, position);

-- Pool membership pins the question at its approved version. The composite
-- foreign keys guarantee the section and question share one institution.
CREATE TABLE IF NOT EXISTS exam_section_pool (
  section_id uuid NOT NULL,
  question_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  question_version integer NOT NULL,
  PRIMARY KEY (section_id, question_id),
  CONSTRAINT exam_section_pool_section_fk FOREIGN KEY (section_id, institution_id) REFERENCES exam_sections(id, institution_id),
  CONSTRAINT exam_section_pool_question_fk FOREIGN KEY (question_id, institution_id) REFERENCES exam_questions(id, institution_id)
);
CREATE INDEX IF NOT EXISTS exam_section_pool_question_idx ON exam_section_pool(question_id);

-- ---------------------------------------------------------------------------
-- Assignment, attempts, answers, results, focus-loss events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exam_assignments (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES users(id),
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_assignments_definition_fk FOREIGN KEY (definition_id, institution_id) REFERENCES exam_definitions(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_assignments_uq ON exam_assignments(definition_id, student_user_id);
CREATE INDEX IF NOT EXISTS exam_assignments_student_idx ON exam_assignments(student_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS exam_attempts (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  student_user_id uuid NOT NULL REFERENCES users(id),
  attempt_number integer NOT NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  paper_seed text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  auto_submitted boolean NOT NULL DEFAULT false,
  screen_shift_count integer NOT NULL DEFAULT 0,
  CONSTRAINT exam_attempts_number_ck CHECK (attempt_number >= 1),
  CONSTRAINT exam_attempts_status_ck CHECK (status IN ('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','EXPIRED')),
  CONSTRAINT exam_attempts_submitted_ck CHECK ((status = 'IN_PROGRESS' AND submitted_at IS NULL) OR (status <> 'IN_PROGRESS' AND submitted_at IS NOT NULL)),
  CONSTRAINT exam_attempts_definition_fk FOREIGN KEY (definition_id, institution_id) REFERENCES exam_definitions(id, institution_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_uq ON exam_attempts(definition_id, student_user_id, attempt_number);
CREATE INDEX IF NOT EXISTS exam_attempts_student_idx ON exam_attempts(student_user_id, started_at DESC);

-- The paper: which questions this attempt shows, in which order, with which
-- per-attempt option shuffle. Written once when the attempt starts.
CREATE TABLE IF NOT EXISTS exam_attempt_questions (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES exam_sections(id),
  question_id uuid NOT NULL REFERENCES exam_questions(id),
  position integer NOT NULL,
  option_map jsonb NOT NULL,
  marks numeric(6,2) NOT NULL,
  negative_marks numeric(6,2) NOT NULL DEFAULT 0,
  CONSTRAINT exam_attempt_questions_position_ck CHECK (position >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempt_questions_uq ON exam_attempt_questions(attempt_id, question_id);
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempt_questions_position_uq ON exam_attempt_questions(attempt_id, position);

CREATE TABLE IF NOT EXISTS exam_answers (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES exam_questions(id),
  response jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_answers_uq ON exam_answers(attempt_id, question_id);

CREATE TABLE IF NOT EXISTS exam_results (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES exam_attempts(id),
  score numeric(8,2) NOT NULL,
  max_score numeric(8,2) NOT NULL,
  percentage numeric(5,2) NOT NULL,
  correct_count integer NOT NULL,
  wrong_count integer NOT NULL,
  not_attempted_count integer NOT NULL,
  time_taken_seconds integer NOT NULL,
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_results_percentage_ck CHECK (percentage >= -100 AND percentage <= 100),
  CONSTRAINT exam_results_counts_ck CHECK (correct_count >= 0 AND wrong_count >= 0 AND not_attempted_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS exam_results_attempt_uq ON exam_results(attempt_id);

CREATE TABLE IF NOT EXISTS exam_screen_events (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
  level text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_screen_events_level_ck CHECK (level IN ('INFO','WARNING','FINAL'))
);
CREATE INDEX IF NOT EXISTS exam_screen_events_attempt_idx ON exam_screen_events(attempt_id, created_at);
