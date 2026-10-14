-- EMP-09: interview scheduling essentials — schedule history with reason codes, and scorecard
-- templates per selection stage.
--
-- A reschedule used to overwrite the old time with no reason, and scorecards were free text two
-- interviewers on one stage could not compare. This adds an append-only revision per schedule
-- change and employer-owned, immutable scorecard templates that a job's interview stage points at,
-- copied onto the interview when it is scheduled, with per-criterion ratings on the outcome.
-- Design: docs/architecture/interview-scheduling-and-scorecards-table-design.md.
-- References only tables created before 0063. Idempotent: every statement is guarded.

-- ---------------------------------------------------------------------------
-- Schedule history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interview_schedule_revisions (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  revision_number integer NOT NULL,
  change_kind text NOT NULL,
  mode text NOT NULL,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  location_detail text,
  joining_link text,
  reason_code text,
  note text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_schedule_revisions_interview_fk FOREIGN KEY (interview_id, employer_id) REFERENCES interviews(id, employer_id),
  CONSTRAINT interview_schedule_revisions_number_ck CHECK (revision_number >= 1),
  CONSTRAINT interview_schedule_revisions_kind_ck CHECK (change_kind IN ('BASELINE', 'SCHEDULED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW')),
  CONSTRAINT interview_schedule_revisions_mode_ck CHECK (mode IN ('ONSITE', 'VIDEO', 'PHONE')),
  CONSTRAINT interview_schedule_revisions_window_ck CHECK (scheduled_start IS NULL OR scheduled_end IS NULL OR scheduled_end > scheduled_start),
  CONSTRAINT interview_schedule_revisions_start_ck CHECK (change_kind NOT IN ('SCHEDULED', 'RESCHEDULED') OR scheduled_start IS NOT NULL),
  CONSTRAINT interview_schedule_revisions_link_ck CHECK (joining_link IS NULL OR (length(joining_link) <= 512 AND joining_link ~* '^https://[^[:space:]]+$')),
  CONSTRAINT interview_schedule_revisions_location_ck CHECK (location_detail IS NULL OR length(location_detail) <= 500),
  CONSTRAINT interview_schedule_revisions_reason_ck CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  -- Appendix 2 §5.7: moving or cancelling an interview always says why.
  CONSTRAINT interview_schedule_revisions_reason_required_ck CHECK (change_kind NOT IN ('RESCHEDULED', 'CANCELLED') OR reason_code IS NOT NULL),
  CONSTRAINT interview_schedule_revisions_note_ck CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 1000 AND note !~ '^[=+@-]'))
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_schedule_revisions_number_uq ON interview_schedule_revisions (interview_id, revision_number);
CREATE INDEX IF NOT EXISTS interview_schedule_revisions_employer_idx ON interview_schedule_revisions (employer_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION refuse_interview_schedule_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'interview_schedule_revisions is append-only';
END $$;
DROP TRIGGER IF EXISTS interview_schedule_revisions_append_only ON interview_schedule_revisions;
CREATE TRIGGER interview_schedule_revisions_append_only BEFORE UPDATE OR DELETE ON interview_schedule_revisions
  FOR EACH ROW EXECUTE FUNCTION refuse_interview_schedule_revision_change();

-- Interviews that predate the history get one BASELINE revision: how each stood when history
-- began. Not SCHEDULED, because an older interview may already have been moved.
INSERT INTO interview_schedule_revisions (id, interview_id, employer_id, revision_number, change_kind, mode, scheduled_start, scheduled_end,
                                          location_detail, joining_link, actor_user_id, recorded_at)
SELECT gen_random_uuid(), i.id, i.employer_id, 1, 'BASELINE', i.mode, i.scheduled_start, i.scheduled_end,
       i.location_detail, i.joining_link, i.created_by_user_id, i.updated_at
FROM interviews i
WHERE NOT EXISTS (SELECT 1 FROM interview_schedule_revisions r WHERE r.interview_id = i.id);

-- ---------------------------------------------------------------------------
-- Scorecard templates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interview_scorecard_templates (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  guidance text,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_by_user_id uuid REFERENCES users(id),
  CONSTRAINT interview_scorecard_templates_name_ck CHECK (length(name) BETWEEN 1 AND 120 AND name !~ '^[=+@-]'),
  CONSTRAINT interview_scorecard_templates_guidance_ck CHECK (guidance IS NULL OR (length(guidance) BETWEEN 1 AND 2000 AND guidance !~ '^[=+@-]')),
  CONSTRAINT interview_scorecard_templates_retired_ck CHECK ((retired_at IS NULL) = (retired_by_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_scorecard_templates_id_employer_uq ON interview_scorecard_templates (id, employer_id);
CREATE UNIQUE INDEX IF NOT EXISTS interview_scorecard_templates_active_name_uq
  ON interview_scorecard_templates (employer_id, lower(name)) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS interview_scorecard_criteria (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES interview_scorecard_templates(id),
  position integer NOT NULL,
  label text NOT NULL,
  guidance text,
  CONSTRAINT interview_scorecard_criteria_position_ck CHECK (position BETWEEN 1 AND 12),
  CONSTRAINT interview_scorecard_criteria_label_ck CHECK (length(label) BETWEEN 1 AND 120 AND label !~ '^[=+@-]'),
  CONSTRAINT interview_scorecard_criteria_guidance_ck CHECK (guidance IS NULL OR (length(guidance) BETWEEN 1 AND 1000 AND guidance !~ '^[=+@-]'))
);
CREATE UNIQUE INDEX IF NOT EXISTS interview_scorecard_criteria_position_uq ON interview_scorecard_criteria (template_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS interview_scorecard_criteria_label_uq ON interview_scorecard_criteria (template_id, lower(label));
CREATE UNIQUE INDEX IF NOT EXISTS interview_scorecard_criteria_id_template_uq ON interview_scorecard_criteria (id, template_id);

-- A template is never edited: only retiring it is allowed, once. A new version is a new template.
CREATE OR REPLACE FUNCTION guard_interview_scorecard_template_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'interview scorecard templates are never deleted';
  END IF;
  IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.employer_id = OLD.employer_id AND NEW.name = OLD.name
     AND NEW.guidance IS NOT DISTINCT FROM OLD.guidance AND NEW.created_by_user_id = OLD.created_by_user_id
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'interview scorecard templates are immutable except for retiring them';
END $$;
DROP TRIGGER IF EXISTS interview_scorecard_templates_immutable ON interview_scorecard_templates;
CREATE TRIGGER interview_scorecard_templates_immutable BEFORE UPDATE OR DELETE ON interview_scorecard_templates
  FOR EACH ROW EXECUTE FUNCTION guard_interview_scorecard_template_change();

-- Criteria never change, and none are added once a stage, an interview or an outcome uses the template.
CREATE OR REPLACE FUNCTION guard_interview_scorecard_criterion_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'interview scorecard criteria are immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM opportunity_selection_stages WHERE scorecard_template_id = NEW.template_id)
     OR EXISTS (SELECT 1 FROM interviews WHERE scorecard_template_id = NEW.template_id)
     OR EXISTS (SELECT 1 FROM interview_outcomes WHERE scorecard_template_id = NEW.template_id) THEN
    RAISE EXCEPTION 'a scorecard template in use cannot gain criteria';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Stage → template, interview → template, outcome → template and ratings
-- ---------------------------------------------------------------------------

ALTER TABLE opportunity_selection_stages ADD COLUMN IF NOT EXISTS scorecard_template_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('opportunity_selection_stages') AND conname = 'opportunity_selection_stages_scorecard_template_fk') THEN
    ALTER TABLE opportunity_selection_stages ADD CONSTRAINT opportunity_selection_stages_scorecard_template_fk
      FOREIGN KEY (scorecard_template_id) REFERENCES interview_scorecard_templates(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('opportunity_selection_stages') AND conname = 'opportunity_selection_stages_scorecard_kind_ck') THEN
    ALTER TABLE opportunity_selection_stages ADD CONSTRAINT opportunity_selection_stages_scorecard_kind_ck
      CHECK (scorecard_template_id IS NULL OR stage_kind IN ('INTERVIEW', 'GROUP_DISCUSSION'));
  END IF;
END $$;

-- A stage may only use a template of the employer that owns the job.
CREATE OR REPLACE FUNCTION guard_stage_scorecard_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scorecard_template_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM opportunity_versions v
    JOIN opportunities o ON o.id = v.opportunity_id
    JOIN interview_scorecard_templates t ON t.id = NEW.scorecard_template_id AND t.employer_id = o.employer_id
    WHERE v.id = NEW.opportunity_version_id
  ) THEN
    RAISE EXCEPTION 'a stage can only use a scorecard template of its own employer';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS opportunity_selection_stages_scorecard_template ON opportunity_selection_stages;
CREATE TRIGGER opportunity_selection_stages_scorecard_template BEFORE INSERT OR UPDATE OF scorecard_template_id ON opportunity_selection_stages
  FOR EACH ROW EXECUTE FUNCTION guard_stage_scorecard_template();

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS scorecard_template_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('interviews') AND conname = 'interviews_scorecard_template_fk') THEN
    -- Composite: the template belongs to the interview's own employer, structurally.
    ALTER TABLE interviews ADD CONSTRAINT interviews_scorecard_template_fk
      FOREIGN KEY (scorecard_template_id, employer_id) REFERENCES interview_scorecard_templates(id, employer_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS interviews_id_scorecard_template_uq ON interviews (id, scorecard_template_id);

-- The scorecard an interview was scheduled with is never swapped under its interviewers.
CREATE OR REPLACE FUNCTION guard_interview_scorecard_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scorecard_template_id IS DISTINCT FROM OLD.scorecard_template_id THEN
    RAISE EXCEPTION 'an interview keeps the scorecard template it was scheduled with';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS interviews_scorecard_template_fixed ON interviews;
CREATE TRIGGER interviews_scorecard_template_fixed BEFORE UPDATE OF scorecard_template_id ON interviews
  FOR EACH ROW EXECUTE FUNCTION guard_interview_scorecard_template();

ALTER TABLE interview_outcomes ADD COLUMN IF NOT EXISTS scorecard_template_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('interview_outcomes') AND conname = 'interview_outcomes_scorecard_template_fk') THEN
    -- An outcome follows its own interview's template, or none.
    ALTER TABLE interview_outcomes ADD CONSTRAINT interview_outcomes_scorecard_template_fk
      FOREIGN KEY (interview_id, scorecard_template_id) REFERENCES interviews(id, scorecard_template_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS interview_outcomes_id_scorecard_template_uq ON interview_outcomes (id, scorecard_template_id);

CREATE TABLE IF NOT EXISTS interview_outcome_criterion_ratings (
  outcome_id uuid NOT NULL,
  criterion_id uuid NOT NULL,
  template_id uuid NOT NULL,
  rating integer NOT NULL,
  note text,
  CONSTRAINT interview_outcome_criterion_ratings_pk PRIMARY KEY (outcome_id, criterion_id),
  -- The rating's criterion belongs to the outcome's own template.
  CONSTRAINT interview_outcome_criterion_ratings_outcome_fk FOREIGN KEY (outcome_id, template_id) REFERENCES interview_outcomes(id, scorecard_template_id),
  CONSTRAINT interview_outcome_criterion_ratings_criterion_fk FOREIGN KEY (criterion_id, template_id) REFERENCES interview_scorecard_criteria(id, template_id),
  CONSTRAINT interview_outcome_criterion_ratings_rating_ck CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT interview_outcome_criterion_ratings_note_ck CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 1000 AND note !~ '^[=+@-]'))
);

-- Created after the three columns it reads exist.
DROP TRIGGER IF EXISTS interview_scorecard_criteria_immutable ON interview_scorecard_criteria;
CREATE TRIGGER interview_scorecard_criteria_immutable BEFORE INSERT OR UPDATE OR DELETE ON interview_scorecard_criteria
  FOR EACH ROW EXECUTE FUNCTION guard_interview_scorecard_criterion_change();
