-- Candidate feedback release: telling a rejected applicant why, deliberately.
--
-- Design in docs/architecture/candidate-feedback-release-table-design.md; the decisions
-- recorded there are adopted here.
--
-- applications.rejection_reason_code has been written on every employer rejection since
-- 0007 and has never been shown to anybody. It is not repurposed here. That column and
-- application_state_history.note were written for the employer's own team, under an
-- expectation of privacy, and retroactively exposing them would both breach that
-- expectation and guarantee that nothing useful is ever written in them again.
--
-- Releasing feedback is therefore a separate, deliberate act that writes new rows. An
-- employer who has never used this feature has disclosed nothing.
--
-- Two rules shape everything below.
--
-- The vocabulary is platform-owned, not per-employer. Comparability is the whole point:
-- one employer's opinion is an anecdote, three employers saying the same thing is a
-- signal a student can act on. Per-employer codes would destroy that, and would break the
-- mapping from a reason to the topics that address it.
--
-- Feedback corrects but never retracts. Once a person has been told why they were
-- rejected, "un-telling" them is not a state this schema can represent.

-- ---------------------------------------------------------------------------
-- The shared vocabulary
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS candidate_feedback_reasons (
  code text PRIMARY KEY,
  student_label text NOT NULL,
  category text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  -- Retiring a reason must not rewrite feedback already released under it, so codes are
  -- deactivated rather than deleted.
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidate_feedback_reason_code_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- The label is read by the person who was rejected, so it is bounded and must not be
  -- a spreadsheet formula if it ever lands in an export.
  CONSTRAINT candidate_feedback_reason_label_ck
    CHECK (length(btrim(student_label)) BETWEEN 1 AND 200 AND student_label !~ '^[=+@-]'),
  CONSTRAINT candidate_feedback_reason_category_ck
    CHECK (category IN ('SKILL_GAP','EXPERIENCE','ROLE_FIT','PROCESS','COMPETITION')),
  CONSTRAINT candidate_feedback_reason_sort_ck CHECK (sort_order BETWEEN 0 AND 100000)
);
CREATE INDEX IF NOT EXISTS candidate_feedback_reason_active_idx
  ON candidate_feedback_reasons(category, sort_order) WHERE active;

COMMENT ON TABLE candidate_feedback_reasons IS
  'Platform-owned vocabulary for feedback released to a rejected candidate. Phrased to be read by the person it is about.';

-- What a student can do about a reason. Zero rows is a legitimate state: nothing a
-- candidate does about themselves addresses "another applicant was stronger", and where
-- no mapping exists the student is shown the feedback and no suggestion -- never an
-- invented one.
CREATE TABLE IF NOT EXISTS candidate_feedback_reason_topics (
  reason_code text NOT NULL REFERENCES candidate_feedback_reasons(code),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  PRIMARY KEY (reason_code, topic_id)
);
CREATE INDEX IF NOT EXISTS candidate_feedback_reason_topic_idx
  ON candidate_feedback_reason_topics(topic_id);

-- ---------------------------------------------------------------------------
-- The release
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS application_feedback_releases (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  released_by_user_id uuid NOT NULL REFERENCES users(id),
  note text,
  released_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT application_feedback_note_ck
    CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  CONSTRAINT application_feedback_supersede_order_ck
    CHECK (superseded_at IS NULL OR superseded_at >= released_at),
  -- A release can never be attached to another employer's application.
  CONSTRAINT application_feedback_application_employer_fk
    FOREIGN KEY (application_id, employer_id) REFERENCES applications(id, employer_id)
);
-- Exactly one live release per application; corrections supersede rather than overwrite.
CREATE UNIQUE INDEX IF NOT EXISTS application_feedback_live_uq
  ON application_feedback_releases(application_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS application_feedback_employer_idx
  ON application_feedback_releases(employer_id, released_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS application_feedback_id_application_uq
  ON application_feedback_releases(id, application_id);

COMMENT ON TABLE application_feedback_releases IS
  'Feedback an employer deliberately chose to show a rejected candidate. Distinct from applications.rejection_reason_code, which stays private to the employer.';

CREATE TABLE IF NOT EXISTS application_feedback_release_reasons (
  release_id uuid NOT NULL REFERENCES application_feedback_releases(id) ON DELETE CASCADE,
  reason_code text NOT NULL REFERENCES candidate_feedback_reasons(code),
  PRIMARY KEY (release_id, reason_code)
);

-- ---------------------------------------------------------------------------
-- Seed vocabulary
-- ---------------------------------------------------------------------------
--
-- COMPETITION exists deliberately. The most common honest answer is "someone else was
-- stronger", and a vocabulary that cannot say it forces employers to pick a reason that
-- implies a fault the candidate does not have.

INSERT INTO candidate_feedback_reasons (code, student_label, category, sort_order) VALUES
  ('CORE_SKILL_GAP',        'A core skill for this role was not yet demonstrated',            'SKILL_GAP',   10),
  ('DEPTH_ON_FUNDAMENTALS', 'Answers on the fundamentals needed more depth',                  'SKILL_GAP',   20),
  ('PRACTICAL_EVIDENCE',    'We were looking for more hands-on or project evidence',          'SKILL_GAP',   30),
  ('COMMUNICATION',         'Explaining your work clearly would strengthen your application', 'SKILL_GAP',   40),
  ('EXPERIENCE_LEVEL',      'We needed more experience than this application showed',         'EXPERIENCE',  50),
  ('DOMAIN_EXPOSURE',       'We were looking for exposure to this particular domain',         'EXPERIENCE',  60),
  ('ROLE_MISMATCH',         'Your strengths pointed towards a different kind of role',        'ROLE_FIT',    70),
  ('LOCATION_OR_MODE',      'Location or working arrangement did not match this role',        'ROLE_FIT',    80),
  ('APPLICATION_INCOMPLETE','Parts of the application were missing or unclear',               'PROCESS',     90),
  ('DID_NOT_PROCEED',       'We could not complete the process for this application',         'PROCESS',    100),
  ('STRONGER_APPLICANTS',   'Other applicants were a closer match for this role',             'COMPETITION',110)
ON CONFLICT (code) DO NOTHING;
