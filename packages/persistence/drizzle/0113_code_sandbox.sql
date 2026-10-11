-- 0113 — the code sandbox (ENG-12): code tasks, the programs students submit, and each test case's
-- outcome; the attempt-log vocabularies widened so a graded run becomes an attempt; and the switch.
-- Design: docs/architecture/code-sandbox-design.md; the evidence decision: ADR-049.
--
-- Why: ADR-034 §6 runs untrusted student code on an isolated Piston VM reached only through the outbox.
-- A submission is a row born QUEUED with an outbox job; the worker claims it, runs it, and records the
-- outcome once — with a graded attempt in learning_attempt_events (0047) in the same transaction.
-- Nothing here writes evidence_records or readiness (ADR-049).
--
-- 0111 and 0112 are claimed by other goals. Applied once by the ledger runner (ADR-035); written
-- idempotently all the same (IF NOT EXISTS, CHECKs dropped IF EXISTS and re-added with every earlier
-- value, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS).

-- 1. The attempt log and sessions learn the new source. Every earlier value is kept.
ALTER TABLE learning_sessions DROP CONSTRAINT IF EXISTS learning_sessions_source_ck;
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_source_ck
  CHECK ((source_type IS NULL) = (source_id IS NULL)
    AND (source_type IS NULL OR source_type IN ('assessment_attempt','exam_attempt','placement_test','learning_step','code_submission')));
ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_source_type_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_source_type_ck
  CHECK (source_attempt_type IN ('assessment_attempt','exam_attempt','placement_test','learning_step','code_submission'));
ALTER TABLE learning_attempt_events DROP CONSTRAINT IF EXISTS learning_attempt_item_source_ck;
ALTER TABLE learning_attempt_events ADD CONSTRAINT learning_attempt_item_source_ck
  CHECK (item_source IN ('CAREER_READINESS_QUESTION','INSTITUTION_EXAM_QUESTION','CODE_TASK'));

-- 2. Code tasks (content). Frozen from insert; only the state moves, forward.
CREATE TABLE IF NOT EXISTS code_tasks (
  id uuid PRIMARY KEY,
  stable_key text NOT NULL,
  version integer NOT NULL,
  skill_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  language text NOT NULL,
  language_version text NOT NULL,
  title text NOT NULL,
  statement text NOT NULL,
  test_cases jsonb NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT code_tasks_key_ck CHECK (stable_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT code_tasks_version_ck CHECK (version > 0),
  CONSTRAINT code_tasks_language_ck CHECK (language = 'python' AND language_version = '3.12.0'),
  CONSTRAINT code_tasks_title_ck CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT code_tasks_statement_ck CHECK (length(statement) BETWEEN 1 AND 10000),
  CONSTRAINT code_tasks_cases_ck CHECK (jsonb_typeof(test_cases) = 'array' AND jsonb_array_length(test_cases) BETWEEN 1 AND 8),
  CONSTRAINT code_tasks_state_ck CHECK (state IN ('DRAFT','PUBLISHED','RETIRED')),
  CONSTRAINT code_tasks_lifecycle_ck CHECK (
    (state = 'DRAFT' AND published_at IS NULL AND retired_at IS NULL)
    OR (state = 'PUBLISHED' AND published_at IS NOT NULL AND retired_at IS NULL)
    OR (state = 'RETIRED' AND retired_at IS NOT NULL AND (published_at IS NULL OR retired_at >= published_at)))
);
CREATE UNIQUE INDEX IF NOT EXISTS code_tasks_key_version_uq ON code_tasks(stable_key, version);
CREATE INDEX IF NOT EXISTS code_tasks_skill_idx ON code_tasks(skill_id) WHERE state = 'PUBLISHED';

-- Every case is {stdin, expectedStdout}, both strings of at most 10,000 characters, nothing else.
CREATE OR REPLACE FUNCTION guard_code_task_insert()
RETURNS trigger AS $$
DECLARE
  test_case jsonb;
BEGIN
  FOR test_case IN SELECT value FROM jsonb_array_elements(NEW.test_cases) LOOP
    IF jsonb_typeof(test_case) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(test_case)) <> 2
       OR jsonb_typeof(test_case->'stdin') IS DISTINCT FROM 'string'
       OR jsonb_typeof(test_case->'expectedStdout') IS DISTINCT FROM 'string'
       OR length(test_case->>'stdin') > 10000 OR length(test_case->>'expectedStdout') > 10000 THEN
      RAISE EXCEPTION 'a code task test case is {stdin, expectedStdout}, each a string of at most 10000 characters';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS code_tasks_insert_guard ON code_tasks;
CREATE TRIGGER code_tasks_insert_guard
  BEFORE INSERT ON code_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_code_task_insert();

CREATE OR REPLACE FUNCTION guard_code_task_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'code_tasks rows are retired, never deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.stable_key <> OLD.stable_key OR NEW.version <> OLD.version OR NEW.skill_id <> OLD.skill_id
     OR NEW.language <> OLD.language OR NEW.language_version <> OLD.language_version OR NEW.title <> OLD.title
     OR NEW.statement <> OLD.statement OR NEW.test_cases <> OLD.test_cases
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'code_tasks: a task version is never edited; publish a new version';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'DRAFT' AND NEW.state IN ('PUBLISHED','RETIRED'))
    OR (OLD.state = 'PUBLISHED' AND NEW.state = 'RETIRED')) THEN
    RAISE EXCEPTION 'code_tasks: state moves forward only';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'code_tasks: publication is recorded once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS code_tasks_change_guard ON code_tasks;
CREATE TRIGGER code_tasks_change_guard
  BEFORE UPDATE OR DELETE ON code_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_code_task_change();

-- 3. Submissions: one program a student sent, and how its run ended.
CREATE TABLE IF NOT EXISTS code_submissions (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  task_id uuid NOT NULL REFERENCES code_tasks(id),
  purpose text NOT NULL DEFAULT 'PRACTICE',
  language text NOT NULL,
  language_version text NOT NULL,
  source_code text NOT NULL,
  source_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  failure_code text,
  verdict text,
  tests_passed smallint,
  tests_total smallint,
  runner text,
  runner_version text,
  limits_version text,
  grader_version text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  correlation_id text NOT NULL,
  -- EMP-12's employer coding items widen this in a later migration, with their own evidence writer.
  CONSTRAINT code_submissions_purpose_ck CHECK (purpose IN ('PRACTICE')),
  CONSTRAINT code_submissions_language_ck CHECK (language = 'python' AND language_version = '3.12.0'),
  CONSTRAINT code_submissions_source_ck CHECK (length(source_code) BETWEEN 1 AND 20000),
  -- The hash is the text's, by construction.
  CONSTRAINT code_submissions_hash_ck CHECK (source_sha256 = encode(sha256(convert_to(source_code, 'UTF8')), 'hex')),
  CONSTRAINT code_submissions_status_ck CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  CONSTRAINT code_submissions_failure_code_ck CHECK (failure_code IS NULL OR failure_code IN
    ('SANDBOX_UNAVAILABLE','SANDBOX_ERROR','SANDBOX_REJECTED','SWITCHED_OFF','TASK_UNAVAILABLE','EXPIRED')),
  CONSTRAINT code_submissions_verdict_ck CHECK (verdict IS NULL OR verdict IN ('PASSED','FAILED')),
  CONSTRAINT code_submissions_counts_ck CHECK ((tests_passed IS NULL) = (tests_total IS NULL)
    AND (tests_total IS NULL OR (tests_total BETWEEN 1 AND 8 AND tests_passed BETWEEN 0 AND tests_total))),
  CONSTRAINT code_submissions_provenance_ck CHECK (
    (runner IS NULL OR runner = 'piston')
    AND (runner_version IS NULL OR length(runner_version) BETWEEN 1 AND 64)
    AND (limits_version IS NULL OR limits_version ~ '^[a-z0-9][a-z0-9.-]{1,63}$')
    AND (grader_version IS NULL OR grader_version ~ '^[a-z0-9][a-z0-9.-]{1,63}$')),
  CONSTRAINT code_submissions_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 200),
  CONSTRAINT code_submissions_window_ck CHECK ((started_at IS NULL OR started_at >= requested_at)
    AND (completed_at IS NULL OR completed_at >= requested_at)),
  -- Open rows carry no outcome; a completed run carries its grade and provenance; a failure says why.
  CONSTRAINT code_submissions_outcome_ck CHECK (
    (status = 'QUEUED' AND failure_code IS NULL AND verdict IS NULL AND tests_total IS NULL AND started_at IS NULL AND completed_at IS NULL
       AND runner IS NULL AND runner_version IS NULL AND limits_version IS NULL AND grader_version IS NULL)
    OR (status = 'RUNNING' AND failure_code IS NULL AND verdict IS NULL AND tests_total IS NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND failure_code IS NULL AND verdict IS NOT NULL AND tests_total IS NOT NULL AND started_at IS NOT NULL
       AND completed_at IS NOT NULL AND runner IS NOT NULL AND runner_version IS NOT NULL AND limits_version IS NOT NULL AND grader_version IS NOT NULL
       AND ((verdict = 'PASSED') = (tests_passed = tests_total)))
    OR (status = 'FAILED' AND failure_code IS NOT NULL AND verdict IS NULL AND tests_total IS NULL AND completed_at IS NOT NULL))
);
-- At most one open submission per student (also checked under the request's lock).
CREATE UNIQUE INDEX IF NOT EXISTS code_submissions_one_open_uq ON code_submissions(subject_user_id) WHERE status IN ('QUEUED','RUNNING');
-- The per-student daily cap.
CREATE INDEX IF NOT EXISTS code_submissions_subject_idx ON code_submissions(subject_user_id, requested_at DESC);
-- The global daily cap and the operations view.
CREATE INDEX IF NOT EXISTS code_submissions_requested_idx ON code_submissions(requested_at DESC);

-- Born QUEUED with nothing filled in, for a published task in the submission's language.
CREATE OR REPLACE FUNCTION guard_code_submission_insert()
RETURNS trigger AS $$
DECLARE
  task record;
BEGIN
  IF NEW.status <> 'QUEUED' THEN
    RAISE EXCEPTION 'a code submission is created QUEUED';
  END IF;
  SELECT state, language, language_version INTO task FROM code_tasks WHERE id = NEW.task_id;
  IF NOT FOUND OR task.state <> 'PUBLISHED' OR task.language <> NEW.language OR task.language_version <> NEW.language_version THEN
    RAISE EXCEPTION 'a code submission answers a published task, in its language';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS code_submissions_insert_guard ON code_submissions;
CREATE TRIGGER code_submissions_insert_guard
  BEFORE INSERT ON code_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_code_submission_insert();

-- The request never changes; status moves forward only (QUEUED → RUNNING → COMPLETED | FAILED, or
-- QUEUED → FAILED); an outcome is written once. Removed only by privacy deletion for the same subject.
CREATE OR REPLACE FUNCTION guard_code_submission_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'code_submissions rows are removed only by privacy deletion';
  END IF;
  IF NEW.id <> OLD.id OR NEW.subject_user_id <> OLD.subject_user_id OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
     OR NEW.task_id <> OLD.task_id OR NEW.purpose <> OLD.purpose OR NEW.language <> OLD.language
     OR NEW.language_version <> OLD.language_version OR NEW.source_code <> OLD.source_code OR NEW.source_sha256 <> OLD.source_sha256
     OR NEW.requested_at <> OLD.requested_at OR NEW.correlation_id <> OLD.correlation_id THEN
    RAISE EXCEPTION 'code_submissions: the request is never changed';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING','FAILED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED','FAILED'))) THEN
    RAISE EXCEPTION 'code_submissions: status moves forward only';
  END IF;
  IF OLD.status IN ('COMPLETED','FAILED') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'code_submissions: a finished submission is final';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'code_submissions: a run starts once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS code_submissions_change_guard ON code_submissions;
CREATE TRIGGER code_submissions_change_guard
  BEFORE UPDATE OR DELETE ON code_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_code_submission_change();

-- 4. Per-case outcomes. Codes and measurements only: the program's output is never stored.
CREATE TABLE IF NOT EXISTS code_submission_cases (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES code_submissions(id),
  subject_user_id uuid NOT NULL REFERENCES users(id),
  case_index smallint NOT NULL,
  outcome text NOT NULL,
  exit_code integer,
  signal text,
  wall_time_ms integer,
  cpu_time_ms integer,
  memory_bytes bigint,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_submission_cases_index_ck CHECK (case_index BETWEEN 1 AND 8),
  CONSTRAINT code_submission_cases_outcome_ck CHECK (outcome IN
    ('PASSED','WRONG_OUTPUT','RUNTIME_ERROR','TIME_LIMIT','MEMORY_LIMIT','OUTPUT_LIMIT','NOT_RUN')),
  CONSTRAINT code_submission_cases_signal_ck CHECK (signal IS NULL OR signal ~ '^SIG[A-Z0-9]{1,12}$'),
  CONSTRAINT code_submission_cases_metrics_ck CHECK ((wall_time_ms IS NULL OR wall_time_ms >= 0)
    AND (cpu_time_ms IS NULL OR cpu_time_ms >= 0) AND (memory_bytes IS NULL OR memory_bytes >= 0)),
  -- A case that was not run has nothing measured.
  CONSTRAINT code_submission_cases_not_run_ck CHECK (outcome <> 'NOT_RUN'
    OR (exit_code IS NULL AND signal IS NULL AND wall_time_ms IS NULL AND cpu_time_ms IS NULL AND memory_bytes IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS code_submission_cases_uq ON code_submission_cases(submission_id, case_index);
CREATE INDEX IF NOT EXISTS code_submission_cases_subject_idx ON code_submission_cases(subject_user_id);

-- Written with the submission's COMPLETED, for that submission's own student, while it is RUNNING.
CREATE OR REPLACE FUNCTION guard_code_submission_case_change()
RETURNS trigger AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT subject_user_id, status INTO parent FROM code_submissions WHERE id = NEW.submission_id;
    IF NOT FOUND OR parent.subject_user_id <> NEW.subject_user_id OR parent.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'a case outcome belongs to a running submission of the same student';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'code_submission_cases is append-only; rows are removed only by privacy deletion';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS code_submission_cases_guard ON code_submission_cases;
CREATE TRIGGER code_submission_cases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON code_submission_cases
  FOR EACH ROW EXECUTE FUNCTION guard_code_submission_case_change();

-- 5. The switch: off, with its own daily ceiling. Switching it on runs untrusted code, so turning it
-- on is the high-risk direction (0038: a second person, or the solo cool-off).
INSERT INTO feature_flags (key, description, enabled, cap_kind, cap_value, cap_window, high_risk_direction)
VALUES ('learning.code-sandbox',
        'Let students send Python programs to the isolated code sandbox (ENG-12, ADR-034 §6). Cap: submissions per day across ONE. Off: nothing is queued.',
        false, 'INVOCATIONS', 2000, 'DAY', 'ENABLE')
ON CONFLICT (key) DO NOTHING;
UPDATE feature_flags SET high_risk_direction = 'ENABLE'
WHERE key = 'learning.code-sandbox' AND high_risk_direction IS DISTINCT FROM 'ENABLE';

COMMENT ON TABLE code_tasks IS
  'ENG-12: a programming task (content) on one skill, with hidden test cases. Frozen from insert; DRAFT → PUBLISHED → RETIRED.';
COMMENT ON TABLE code_submissions IS
  'ENG-12: one program a student sent to the isolated sandbox and how its run ended. Queued by the API, run by the outbox worker; a COMPLETED run is also a graded attempt (ADR-049).';
COMMENT ON TABLE code_submission_cases IS
  'ENG-12: the outcome code and measurements of each test case run. The program''s output is never stored.';
