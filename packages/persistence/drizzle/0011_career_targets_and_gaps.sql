-- Career targets, career requirements, and the gap between them.
--
-- This is what turns "what should I do next?" from a slogan into a computed answer.
-- A career role declares the topics it needs and to what depth; a student picks a
-- target; the gap is that requirement set measured against the mastery projections
-- the career-readiness pilot already produces.
--
-- Gaps are snapshots, not live queries. A recomputation supersedes rather than
-- overwrites, so what a student was told last week can still be reconstructed.
--
-- No rows are seeded. The starter career catalogue is a separate seed script, so
-- reference content is deployed deliberately rather than smuggled in by a migration.

-- ---------------------------------------------------------------------------
-- Career roles and what they require
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS career_roles (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  title text NOT NULL,
  family text NOT NULL,
  summary text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_role_code_ck CHECK (code ~ '^[A-Z0-9_]{2,64}$'),
  CONSTRAINT career_role_title_ck CHECK (length(title) BETWEEN 1 AND 160 AND title !~ '^[=+@-]'),
  CONSTRAINT career_role_family_ck CHECK (length(family) BETWEEN 1 AND 80),
  CONSTRAINT career_role_summary_ck CHECK (summary IS NULL OR length(summary) <= 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS career_role_code_uq ON career_roles(lower(code));
CREATE INDEX IF NOT EXISTS career_role_active_idx ON career_roles(family, title) WHERE active;

CREATE TABLE IF NOT EXISTS career_role_requirements (
  id uuid PRIMARY KEY,
  career_role_id uuid NOT NULL REFERENCES career_roles(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  requirement_level text NOT NULL,
  target_mastery numeric(4,3) NOT NULL,
  rationale text,
  CONSTRAINT career_requirement_level_ck CHECK (requirement_level IN ('ESSENTIAL','IMPORTANT','HELPFUL')),
  -- Mastery is a proportion, so a target outside 0..1 is a data error rather than a
  -- very demanding role.
  CONSTRAINT career_requirement_target_ck CHECK (target_mastery > 0 AND target_mastery <= 1),
  CONSTRAINT career_requirement_rationale_ck CHECK (rationale IS NULL OR length(rationale) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS career_requirement_role_topic_uq ON career_role_requirements(career_role_id, topic_id);
CREATE INDEX IF NOT EXISTS career_requirement_role_idx ON career_role_requirements(career_role_id, requirement_level);

-- ---------------------------------------------------------------------------
-- What a student is aiming at
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS student_career_targets (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  career_role_id uuid NOT NULL REFERENCES career_roles(id),
  priority text NOT NULL DEFAULT 'PRIMARY',
  selected_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  CONSTRAINT student_career_target_priority_ck CHECK (priority IN ('PRIMARY','SECONDARY')),
  CONSTRAINT student_career_target_cleared_ck CHECK (cleared_at IS NULL OR cleared_at >= selected_at)
);
-- One live primary target: aiming at two things at once is not a target.
CREATE UNIQUE INDEX IF NOT EXISTS student_career_target_primary_uq
  ON student_career_targets(student_user_id) WHERE priority = 'PRIMARY' AND cleared_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS student_career_target_active_uq
  ON student_career_targets(student_user_id, career_role_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS student_career_target_student_idx ON student_career_targets(student_user_id, selected_at DESC);

-- ---------------------------------------------------------------------------
-- Computed gaps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS career_gap_snapshots (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  career_role_id uuid NOT NULL REFERENCES career_roles(id),
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  requirements_total integer NOT NULL,
  requirements_met integer NOT NULL,
  requirements_unknown integer NOT NULL,
  CONSTRAINT career_gap_model_ck CHECK (length(model_version) BETWEEN 1 AND 64),
  CONSTRAINT career_gap_counts_ck CHECK (
    requirements_total >= 0 AND requirements_met >= 0 AND requirements_unknown >= 0
    AND requirements_met + requirements_unknown <= requirements_total
  ),
  CONSTRAINT career_gap_superseded_ck CHECK (superseded_at IS NULL OR superseded_at >= computed_at)
);
-- One current snapshot per student and role; older ones are superseded, never deleted.
CREATE UNIQUE INDEX IF NOT EXISTS career_gap_current_uq
  ON career_gap_snapshots(student_user_id, career_role_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS career_gap_student_idx ON career_gap_snapshots(student_user_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS career_gap_items (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES career_gap_snapshots(id),
  topic_id uuid NOT NULL REFERENCES taxonomy_nodes(id),
  requirement_level text NOT NULL,
  target_mastery numeric(4,3) NOT NULL,
  observed_mastery numeric(4,3),
  status text NOT NULL,
  priority_rank integer NOT NULL,
  CONSTRAINT career_gap_item_level_ck CHECK (requirement_level IN ('ESSENTIAL','IMPORTANT','HELPFUL')),
  -- UNKNOWN is distinct from MISSING on purpose: no evidence means we cannot say the
  -- student lacks the skill, only that nothing has been demonstrated yet.
  CONSTRAINT career_gap_item_status_ck CHECK (status IN ('MET','PARTIAL','MISSING','UNKNOWN')),
  CONSTRAINT career_gap_item_observed_ck CHECK (observed_mastery IS NULL OR (observed_mastery >= 0 AND observed_mastery <= 1)),
  -- An unknown item has no observation; anything else does.
  CONSTRAINT career_gap_item_unknown_ck CHECK ((status = 'UNKNOWN') = (observed_mastery IS NULL)),
  CONSTRAINT career_gap_item_rank_ck CHECK (priority_rank >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS career_gap_item_snapshot_topic_uq ON career_gap_items(snapshot_id, topic_id);
CREATE INDEX IF NOT EXISTS career_gap_item_rank_idx ON career_gap_items(snapshot_id, priority_rank);

-- The free-text target on the profile predates this and stays as the student's own
-- words. The structured target is what the gap is computed against; neither replaces
-- the other.
COMMENT ON COLUMN student_profiles.target_career IS 'Student-entered free text. The structured target lives in student_career_targets.';
