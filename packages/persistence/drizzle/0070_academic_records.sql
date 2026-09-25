-- Academic records: what a student studied, what they were awarded, and who stands
-- behind it.
--
-- Design frozen in docs/architecture/academic-records-table-design.md on 2026-09-12.
-- Cross-stream schema (block 0070-0079): three streams write these tables and none of
-- them owns the shape, so Core writes the migration.
--
-- Two rules are load-bearing and are enforced here rather than left to a service:
--
--   Store the value as issued, together with the scale it was issued on. A marksheet
--   saying 8.2/10 is stored as 8.2 on CGPA_10 and displayed that way. Normalisation
--   happens at comparison time only, and nothing converted is ever written back --
--   once a converted figure is stored, nobody can tell whether a number was issued by
--   the institution or computed by us.
--
--   A record with no issuing ONE organisation can never be verified. Prior education
--   elsewhere is kept, because refusing it loses the student's history, but it stays
--   self-reported forever and never satisfies an employer's eligibility rule.
--
-- Verification is permanent; visibility is not. Nothing here is cleared when an
-- institution relationship ends -- a graduate's degree does not become unverified
-- because they stopped being a current student. What an institution may *read* about
-- ongoing activity remains relationship- and time-scoped under DP-010, which is a
-- different rule and is unaffected by this migration.

-- ---------------------------------------------------------------------------
-- Programmes of study
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS student_qualifications (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  -- Nullable: prior education at an institution that is not a ONE customer has no
  -- organisation to point at.
  institution_id uuid REFERENCES organizations(id),
  institution_name_declared text,
  qualification_type text NOT NULL,
  programme_name text NOT NULL,
  started_on date,
  completed_on date,
  awarded boolean NOT NULL DEFAULT false,
  verification_state text NOT NULL DEFAULT 'SELF_REPORTED',
  verified_by_user_id uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Extended by migration, never by free text, so a typo cannot become a new
  -- qualification type.
  CONSTRAINT student_qualification_type_ck CHECK (qualification_type IN (
    'BTECH','BE','BSC','BA','BCOM','BBA','BCA','MBBS','BDS','DIPLOMA',
    'MTECH','ME','MBA','MSC','MA','MCOM','MCA','PHD','OTHER')),
  CONSTRAINT student_qualification_state_ck CHECK (verification_state IN
    ('SELF_REPORTED','PENDING_VERIFICATION','VERIFIED','REJECTED')),
  CONSTRAINT student_qualification_programme_ck CHECK (
    length(programme_name) BETWEEN 1 AND 200 AND programme_name !~ '^[=+@-]'),
  -- Formula-injection guard matching the one external_applications already applies:
  -- these strings reach CSV exports.
  CONSTRAINT student_qualification_declared_name_ck CHECK (
    institution_name_declared IS NULL
    OR (length(institution_name_declared) BETWEEN 1 AND 200 AND institution_name_declared !~ '^[=+@-]')),
  -- Exactly one source of the institution's identity.
  CONSTRAINT student_qualification_institution_ck CHECK (
    (institution_id IS NOT NULL AND institution_name_declared IS NULL)
    OR (institution_id IS NULL AND institution_name_declared IS NOT NULL)),
  -- No issuer, no verification. This is the rule that keeps "verified" meaning
  -- something, expressed where it cannot be forgotten.
  CONSTRAINT student_qualification_unverifiable_ck CHECK (
    institution_id IS NOT NULL OR verification_state = 'SELF_REPORTED'),
  -- A reviewer identity requires a review time, and both appear only once a decision
  -- has actually been taken.
  CONSTRAINT student_qualification_reviewer_ck CHECK (
    (verified_by_user_id IS NULL) = (verified_at IS NULL)),
  CONSTRAINT student_qualification_decided_ck CHECK (
    verification_state IN ('VERIFIED','REJECTED') OR verified_by_user_id IS NULL),
  CONSTRAINT student_qualification_dates_ck CHECK (
    completed_on IS NULL OR started_on IS NULL OR completed_on >= started_on)
);
CREATE INDEX IF NOT EXISTS student_qualification_student_idx
  ON student_qualifications(student_user_id, started_on DESC NULLS LAST);
-- The queue a verifying institution works from.
CREATE INDEX IF NOT EXISTS student_qualification_pending_idx
  ON student_qualifications(institution_id, verification_state)
  WHERE verification_state = 'PENDING_VERIFICATION';

-- ---------------------------------------------------------------------------
-- Periods of study within a qualification
-- ---------------------------------------------------------------------------
-- Deliberately not called "semester". A BTech runs eight semesters on a 10-point
-- CGPA; many state universities issue percentages; an MBBS runs in professional
-- years; a diploma may be pass/fail. The label is whatever the institution calls it.

CREATE TABLE IF NOT EXISTS student_academic_terms (
  id uuid PRIMARY KEY,
  qualification_id uuid NOT NULL REFERENCES student_qualifications(id),
  sequence integer NOT NULL,
  label text NOT NULL,
  result_value numeric(6,3),
  result_scale text,
  result_letter text,
  -- Per term. The cumulative figure is derived at read time and never stored: a
  -- number computed across periods is our arithmetic, not the institution's record.
  backlog_count integer,
  source text NOT NULL,
  evidence_document_version_id uuid REFERENCES student_document_versions(id),
  verification_state text NOT NULL DEFAULT 'SELF_REPORTED',
  verified_by_user_id uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_term_sequence_ck CHECK (sequence >= 1 AND sequence <= 30),
  CONSTRAINT student_term_label_ck CHECK (length(label) BETWEEN 1 AND 80 AND label !~ '^[=+@-]'),
  CONSTRAINT student_term_scale_ck CHECK (result_scale IS NULL OR result_scale IN
    ('CGPA_10','GPA_4','PERCENTAGE','LETTER','PASS_FAIL')),
  CONSTRAINT student_term_source_ck CHECK (source IN
    ('STUDENT_DECLARED','INSTITUTION_IMPORTED','DOCUMENT_BACKED')),
  CONSTRAINT student_term_state_ck CHECK (verification_state IN
    ('SELF_REPORTED','PENDING_VERIFICATION','VERIFIED','REJECTED')),
  -- A value requires the scale it was issued on. This is the provenance rule: an
  -- unlabelled number is uninterpretable and must not be storable.
  CONSTRAINT student_term_value_needs_scale_ck CHECK (
    (result_value IS NULL AND result_letter IS NULL) OR result_scale IS NOT NULL),
  -- Numeric scales carry a value; categorical scales carry a letter. Never both.
  CONSTRAINT student_term_scale_shape_ck CHECK (
    result_scale IS NULL
    OR (result_scale IN ('CGPA_10','GPA_4','PERCENTAGE') AND result_letter IS NULL)
    OR (result_scale IN ('LETTER','PASS_FAIL') AND result_value IS NULL AND result_letter IS NOT NULL)),
  -- Ranges are per scale, so an 82% cannot be recorded as a CGPA.
  CONSTRAINT student_term_value_range_ck CHECK (
    result_value IS NULL
    OR (result_scale = 'CGPA_10' AND result_value >= 0 AND result_value <= 10)
    OR (result_scale = 'GPA_4' AND result_value >= 0 AND result_value <= 4)
    OR (result_scale = 'PERCENTAGE' AND result_value >= 0 AND result_value <= 100)),
  CONSTRAINT student_term_letter_ck CHECK (
    result_letter IS NULL OR length(result_letter) BETWEEN 1 AND 16),
  CONSTRAINT student_term_backlog_ck CHECK (backlog_count IS NULL OR backlog_count >= 0),
  CONSTRAINT student_term_reviewer_ck CHECK ((verified_by_user_id IS NULL) = (verified_at IS NULL)),
  CONSTRAINT student_term_decided_ck CHECK (
    verification_state IN ('VERIFIED','REJECTED') OR verified_by_user_id IS NULL),
  -- Document-backed means there is a document.
  CONSTRAINT student_term_document_ck CHECK (
    source <> 'DOCUMENT_BACKED' OR evidence_document_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS student_term_sequence_uq
  ON student_academic_terms(qualification_id, sequence);
CREATE INDEX IF NOT EXISTS student_term_verified_idx
  ON student_academic_terms(qualification_id, verification_state, sequence DESC);

-- ---------------------------------------------------------------------------
-- Per-subject detail
-- ---------------------------------------------------------------------------
-- Optional. Employers do not filter on it, but students and staff want to see it and
-- it is what a marksheet actually contains.

CREATE TABLE IF NOT EXISTS student_academic_subjects (
  id uuid PRIMARY KEY,
  term_id uuid NOT NULL REFERENCES student_academic_terms(id),
  subject_code text,
  subject_name text NOT NULL,
  credits numeric(5,2),
  grade_value numeric(6,3),
  grade_scale text,
  grade_letter text,
  passed boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_subject_name_ck CHECK (length(subject_name) BETWEEN 1 AND 200 AND subject_name !~ '^[=+@-]'),
  CONSTRAINT student_subject_code_ck CHECK (
    subject_code IS NULL OR (length(subject_code) BETWEEN 1 AND 40 AND subject_code !~ '^[=+@-]')),
  CONSTRAINT student_subject_credits_ck CHECK (credits IS NULL OR (credits >= 0 AND credits <= 100)),
  CONSTRAINT student_subject_scale_ck CHECK (grade_scale IS NULL OR grade_scale IN
    ('CGPA_10','GPA_4','PERCENTAGE','LETTER','PASS_FAIL')),
  -- The same value/scale pairing rule as the term it belongs to.
  CONSTRAINT student_subject_value_needs_scale_ck CHECK (
    (grade_value IS NULL AND grade_letter IS NULL) OR grade_scale IS NOT NULL),
  CONSTRAINT student_subject_scale_shape_ck CHECK (
    grade_scale IS NULL
    OR (grade_scale IN ('CGPA_10','GPA_4','PERCENTAGE') AND grade_letter IS NULL)
    OR (grade_scale IN ('LETTER','PASS_FAIL') AND grade_value IS NULL AND grade_letter IS NOT NULL)),
  CONSTRAINT student_subject_value_range_ck CHECK (
    grade_value IS NULL
    OR (grade_scale = 'CGPA_10' AND grade_value >= 0 AND grade_value <= 10)
    OR (grade_scale = 'GPA_4' AND grade_value >= 0 AND grade_value <= 4)
    OR (grade_scale = 'PERCENTAGE' AND grade_value >= 0 AND grade_value <= 100)),
  CONSTRAINT student_subject_letter_ck CHECK (grade_letter IS NULL OR length(grade_letter) BETWEEN 1 AND 16)
);
CREATE UNIQUE INDEX IF NOT EXISTS student_subject_term_code_uq
  ON student_academic_subjects(term_id, subject_code) WHERE subject_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS student_subject_term_idx ON student_academic_subjects(term_id, subject_name);

-- ---------------------------------------------------------------------------
-- Verification is permanent
-- ---------------------------------------------------------------------------
-- A VERIFIED record cannot be moved back to an unverified state, by anyone, including
-- the institution that verified it. Correcting a wrong record means adding a
-- correction, not quietly withdrawing a verification a student has since relied on.
-- REJECTED is likewise terminal for that submission; a student resubmits instead.

CREATE OR REPLACE FUNCTION academic_verification_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.verification_state = 'VERIFIED' AND NEW.verification_state <> 'VERIFIED' THEN
    RAISE EXCEPTION 'a verified academic record cannot be unverified';
  END IF;
  IF OLD.verification_state = 'VERIFIED'
     AND (NEW.verified_by_user_id IS DISTINCT FROM OLD.verified_by_user_id
          OR NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
    RAISE EXCEPTION 'the verifier of a verified academic record cannot be changed';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS student_qualification_verification_final ON student_qualifications;
CREATE TRIGGER student_qualification_verification_final
  BEFORE UPDATE ON student_qualifications
  FOR EACH ROW EXECUTE FUNCTION academic_verification_is_final();

DROP TRIGGER IF EXISTS student_term_verification_final ON student_academic_terms;
CREATE TRIGGER student_term_verification_final
  BEFORE UPDATE ON student_academic_terms
  FOR EACH ROW EXECUTE FUNCTION academic_verification_is_final();

COMMENT ON TABLE student_qualifications IS
  'Programmes of study. institution_id NULL means prior education elsewhere: kept, and self-reported forever.';
COMMENT ON COLUMN student_academic_terms.result_value IS
  'The aggregate as the institution issued it, on result_scale. Never a converted figure.';
COMMENT ON COLUMN student_academic_terms.backlog_count IS
  'Per term. The cumulative figure is derived at read time and never stored.';
