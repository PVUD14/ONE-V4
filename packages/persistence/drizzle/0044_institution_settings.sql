-- ONE · Institution settings, grading scales and academic calendar (INST-05)
--
-- Design and reasoning: docs/architecture/institution-settings-table-design.md (read it first).
--
-- 1. institution_settings: what a college writes about itself (about, placement contact
--    email). Everything Operations verifies an institution against stays on
--    organization_profiles (0005) and is never written from the institution side.
-- 2. institution_grading_scales: one scale per programme, on exactly the 0070 result-scale
--    list. No institution-wide default: a programme without a row is NA, never a guess.
-- 3. institution_academic_terms: the college's calendar (terms, examination periods,
--    breaks) for the whole college, a programme or a batch. Archived, never deleted, so a
--    later teaching-assignment link cannot dangle. Not to be confused with
--    student_academic_terms (0070), which is a period of one student's record.
--
-- The migrator replays every file on every run, so everything here is idempotent.

-- ---------------------------------------------------------------------------
-- 1. College-written settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS institution_settings (
  institution_id uuid PRIMARY KEY REFERENCES organizations(id),
  about_text text,
  placement_contact_email text,
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_settings_about_ck CHECK (
    about_text IS NULL OR (length(about_text) BETWEEN 1 AND 2000 AND about_text !~ '^[=+@-]')),
  CONSTRAINT institution_settings_placement_email_ck CHECK (
    placement_contact_email IS NULL OR (length(placement_contact_email) <= 254
      AND placement_contact_email = lower(placement_contact_email)
      AND placement_contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  CONSTRAINT institution_settings_updated_at_ck CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION enforce_institution_settings_scope()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.institution_id AND kind = 'INSTITUTION') THEN
    RAISE EXCEPTION 'institution settings must belong to an institution organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_settings_scope_guard ON institution_settings;
CREATE TRIGGER institution_settings_scope_guard
BEFORE INSERT OR UPDATE OF institution_id ON institution_settings
FOR EACH ROW EXECUTE FUNCTION enforce_institution_settings_scope();

-- ---------------------------------------------------------------------------
-- 2. Grading scale per programme
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS institution_grading_scales (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  program_unit_id uuid NOT NULL,
  result_scale text NOT NULL,
  pass_threshold numeric(6,3),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT institution_grading_scale_unit_fk FOREIGN KEY (program_unit_id, institution_id)
    REFERENCES institution_units(id, institution_id),
  -- The 0070 academic-records scale list, so a programme's scale and a student's result
  -- share one vocabulary.
  CONSTRAINT institution_grading_scale_scale_ck CHECK (result_scale IN
    ('CGPA_10','GPA_4','PERCENTAGE','LETTER','PASS_FAIL')),
  -- Thresholds only on numeric scales, and inside that scale's range (the 0070 ranges).
  CONSTRAINT institution_grading_scale_threshold_ck CHECK (
    pass_threshold IS NULL
    OR (result_scale = 'CGPA_10' AND pass_threshold >= 0 AND pass_threshold <= 10)
    OR (result_scale = 'GPA_4' AND pass_threshold >= 0 AND pass_threshold <= 4)
    OR (result_scale = 'PERCENTAGE' AND pass_threshold >= 0 AND pass_threshold <= 100)),
  CONSTRAINT institution_grading_scale_updated_at_ck CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS institution_grading_scales_program_uq
  ON institution_grading_scales(institution_id, program_unit_id);

CREATE OR REPLACE FUNCTION enforce_institution_grading_scale_unit()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM institution_units
    WHERE id = NEW.program_unit_id AND institution_id = NEW.institution_id AND kind = 'PROGRAM'
  ) THEN
    RAISE EXCEPTION 'a grading scale must name a programme unit of the institution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_grading_scales_unit_guard ON institution_grading_scales;
CREATE TRIGGER institution_grading_scales_unit_guard
BEFORE INSERT OR UPDATE OF program_unit_id, institution_id ON institution_grading_scales
FOR EACH ROW EXECUTE FUNCTION enforce_institution_grading_scale_unit();

-- ---------------------------------------------------------------------------
-- 3. Academic calendar
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS institution_academic_terms (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  kind text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  unit_id uuid,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  updated_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by_user_id uuid REFERENCES users(id),
  archive_reason_code text,
  -- Lets a later migration point faculty_teaching_assignments at a term of the same
  -- institution with a composite foreign key (see the design, Part 3).
  CONSTRAINT institution_academic_terms_id_institution_uq UNIQUE (id, institution_id),
  CONSTRAINT institution_academic_term_unit_fk FOREIGN KEY (unit_id, institution_id)
    REFERENCES institution_units(id, institution_id),
  CONSTRAINT institution_academic_term_name_ck CHECK (length(name) BETWEEN 1 AND 60 AND name !~ '^[=+@-]'),
  CONSTRAINT institution_academic_term_kind_ck CHECK (kind IN ('TERM','EXAMINATIONS','BREAK')),
  CONSTRAINT institution_academic_term_window_ck CHECK (ends_on >= starts_on AND ends_on - starts_on <= 400),
  CONSTRAINT institution_academic_term_archive_reason_ck CHECK (
    archive_reason_code IS NULL OR archive_reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT institution_academic_term_archived_ck CHECK (
    (archived_at IS NULL AND archived_by_user_id IS NULL AND archive_reason_code IS NULL)
    OR (archived_at IS NOT NULL AND archived_by_user_id IS NOT NULL AND archive_reason_code IS NOT NULL)),
  CONSTRAINT institution_academic_term_updated_at_ck CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS institution_academic_terms_live_name_uq ON institution_academic_terms (
  institution_id,
  coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(name)
) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS institution_academic_terms_calendar_idx
  ON institution_academic_terms (institution_id, starts_on, id) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_institution_academic_term_unit()
RETURNS trigger AS $$
BEGIN
  IF NEW.unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM institution_units
    WHERE id = NEW.unit_id AND institution_id = NEW.institution_id AND kind IN ('PROGRAM', 'BATCH')
  ) THEN
    RAISE EXCEPTION 'an academic term may only apply to a programme or batch of the institution';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.institution_id AND kind = 'INSTITUTION') THEN
    RAISE EXCEPTION 'an academic term must belong to an institution organization';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS institution_academic_terms_unit_guard ON institution_academic_terms;
CREATE TRIGGER institution_academic_terms_unit_guard
BEFORE INSERT OR UPDATE OF unit_id, institution_id ON institution_academic_terms
FOR EACH ROW EXECUTE FUNCTION enforce_institution_academic_term_unit();

COMMENT ON TABLE institution_settings IS
  'What a college writes about itself (INST-05). Operations-verified fields stay on organization_profiles.';
COMMENT ON TABLE institution_grading_scales IS
  'One grading scale per programme (INST-05), on the 0070 scale list. No default: a programme without a row is NA.';
COMMENT ON TABLE institution_academic_terms IS
  'The college academic calendar (INST-05): terms, examination periods and breaks. Archived, never deleted.';
