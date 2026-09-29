-- INST-12: college-defined campus drive categories (for example Dream, Core, Mass).
--
-- A category is the college's own label on an employer's drive, set in Settings and attached to
-- drives by the placement office. It is internal to the college: never shown to employers or
-- students. Categories are immutable except retiring; a drive's category history is append-only,
-- the latest row being current. Design: docs/architecture/placement-register-design.md.
-- Idempotent: every statement is guarded, so a replay (bootstrap, ADR-035) is a no-op.

CREATE TABLE IF NOT EXISTS institution_drive_categories (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  description text,
  rank smallint NOT NULL DEFAULT 10,
  state text NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_by_user_id uuid REFERENCES users(id),
  retired_at timestamptz,
  retire_reason_code text,
  CONSTRAINT institution_drive_categories_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 40 AND name = btrim(name) AND name !~ '^[=+@-]'),
  CONSTRAINT institution_drive_categories_description_ck CHECK (description IS NULL OR (length(description) BETWEEN 1 AND 200 AND description !~ '^[=+@-]')),
  CONSTRAINT institution_drive_categories_rank_ck CHECK (rank BETWEEN 1 AND 20),
  CONSTRAINT institution_drive_categories_state_ck CHECK (state IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT institution_drive_categories_retired_ck CHECK (
    (state = 'RETIRED') = (retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL AND retire_reason_code IS NOT NULL)),
  CONSTRAINT institution_drive_categories_reason_ck CHECK (retire_reason_code IS NULL OR retire_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS institution_drive_categories_id_institution_uq ON institution_drive_categories (id, institution_id);
-- One active label per name (case-insensitive) per college; a retired name can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS institution_drive_categories_active_name_uq
  ON institution_drive_categories (institution_id, lower(name)) WHERE state = 'ACTIVE';

-- Lets an assignment prove the drive belongs to the category's college.
CREATE UNIQUE INDEX IF NOT EXISTS campus_drives_id_institution_uq ON campus_drives (id, institution_id);

-- Every category a drive has had; the latest row is current, a NULL category clears it. Append-only.
CREATE TABLE IF NOT EXISTS campus_drive_category_assignments (
  id uuid PRIMARY KEY,
  campus_drive_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  category_id uuid,
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campus_drive_category_assignments_drive_fk FOREIGN KEY (campus_drive_id, institution_id) REFERENCES campus_drives(id, institution_id),
  CONSTRAINT campus_drive_category_assignments_category_fk FOREIGN KEY (category_id, institution_id) REFERENCES institution_drive_categories(id, institution_id)
);
CREATE INDEX IF NOT EXISTS campus_drive_category_assignments_drive_idx ON campus_drive_category_assignments (campus_drive_id, created_at DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'campus_drive_category_assignments_append_only' AND tgrelid = to_regclass('campus_drive_category_assignments')) THEN
    CREATE TRIGGER campus_drive_category_assignments_append_only BEFORE UPDATE OR DELETE ON campus_drive_category_assignments
      FOR EACH ROW EXECUTE FUNCTION campus_drive_append_only();
  END IF;
END $$;

-- A category may only be retired, once; it is never deleted or rewritten.
CREATE OR REPLACE FUNCTION institution_drive_category_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'institution_drive_categories rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'ACTIVE' OR NEW.state <> 'RETIRED'
     OR NEW.id <> OLD.id OR NEW.institution_id <> OLD.institution_id OR NEW.name <> OLD.name
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.rank <> OLD.rank
     OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a drive category can only be retired' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'institution_drive_category_guard' AND tgrelid = to_regclass('institution_drive_categories')) THEN
    CREATE TRIGGER institution_drive_category_guard BEFORE UPDATE OR DELETE ON institution_drive_categories
      FOR EACH ROW EXECUTE FUNCTION institution_drive_category_guard();
  END IF;
END $$;
