-- Growth territories and regions (GROWTH-02).
--
-- Design: docs/architecture/growth-territories-table-design.md
-- Parent design: docs/architecture/growth-portal-design.md §4; decision ADR-040 (D3).
--
-- India as state or union territory -> district; named sales regions; which areas a region
-- covers; and which growth person works which region. Every row that decides who may see
-- whose pipeline is append-only with a reason. No earlier migration is edited and no
-- function an earlier migration defined is redefined: the membership triggers here are new
-- functions beside 0091's. Written idempotently.

-- ---------------------------------------------------------------------------
-- 1. States and union territories (seeded: a public fact)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_states (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL
);

ALTER TABLE growth_states DROP CONSTRAINT IF EXISTS growth_state_code_ck;
ALTER TABLE growth_states ADD CONSTRAINT growth_state_code_ck CHECK (code ~ '^IN-[A-Z]{2}$');
ALTER TABLE growth_states DROP CONSTRAINT IF EXISTS growth_state_name_ck;
ALTER TABLE growth_states ADD CONSTRAINT growth_state_name_ck CHECK (length(name) BETWEEN 1 AND 80);
ALTER TABLE growth_states DROP CONSTRAINT IF EXISTS growth_state_kind_ck;
ALTER TABLE growth_states ADD CONSTRAINT growth_state_kind_ck CHECK (kind IN ('STATE', 'UNION_TERRITORY'));

-- Source: ISO 3166-2:IN, as amended by the ISO 3166 OBP changes of 2019-11-22 (Jammu and
-- Kashmir a union territory; Ladakh added), 2020-11-11 (IN-DH merged) and 2023-11-23
-- (IN-OD, IN-CG, IN-TS, IN-UK). 28 states and 8 union territories. Names without diacritics.
INSERT INTO growth_states (code, name, kind) VALUES
  ('IN-AP', 'Andhra Pradesh', 'STATE'),
  ('IN-AR', 'Arunachal Pradesh', 'STATE'),
  ('IN-AS', 'Assam', 'STATE'),
  ('IN-BR', 'Bihar', 'STATE'),
  ('IN-CG', 'Chhattisgarh', 'STATE'),
  ('IN-GA', 'Goa', 'STATE'),
  ('IN-GJ', 'Gujarat', 'STATE'),
  ('IN-HR', 'Haryana', 'STATE'),
  ('IN-HP', 'Himachal Pradesh', 'STATE'),
  ('IN-JH', 'Jharkhand', 'STATE'),
  ('IN-KA', 'Karnataka', 'STATE'),
  ('IN-KL', 'Kerala', 'STATE'),
  ('IN-MP', 'Madhya Pradesh', 'STATE'),
  ('IN-MH', 'Maharashtra', 'STATE'),
  ('IN-MN', 'Manipur', 'STATE'),
  ('IN-ML', 'Meghalaya', 'STATE'),
  ('IN-MZ', 'Mizoram', 'STATE'),
  ('IN-NL', 'Nagaland', 'STATE'),
  ('IN-OD', 'Odisha', 'STATE'),
  ('IN-PB', 'Punjab', 'STATE'),
  ('IN-RJ', 'Rajasthan', 'STATE'),
  ('IN-SK', 'Sikkim', 'STATE'),
  ('IN-TN', 'Tamil Nadu', 'STATE'),
  ('IN-TS', 'Telangana', 'STATE'),
  ('IN-TR', 'Tripura', 'STATE'),
  ('IN-UP', 'Uttar Pradesh', 'STATE'),
  ('IN-UK', 'Uttarakhand', 'STATE'),
  ('IN-WB', 'West Bengal', 'STATE'),
  ('IN-AN', 'Andaman and Nicobar Islands', 'UNION_TERRITORY'),
  ('IN-CH', 'Chandigarh', 'UNION_TERRITORY'),
  ('IN-DH', 'Dadra and Nagar Haveli and Daman and Diu', 'UNION_TERRITORY'),
  ('IN-DL', 'Delhi', 'UNION_TERRITORY'),
  ('IN-JK', 'Jammu and Kashmir', 'UNION_TERRITORY'),
  ('IN-LA', 'Ladakh', 'UNION_TERRITORY'),
  ('IN-LD', 'Lakshadweep', 'UNION_TERRITORY'),
  ('IN-PY', 'Puducherry', 'UNION_TERRITORY')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind;

CREATE OR REPLACE FUNCTION growth_state_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'growth states are never deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_state_guard ON growth_states;
CREATE TRIGGER growth_state_guard BEFORE DELETE ON growth_states
  FOR EACH ROW EXECUTE FUNCTION growth_state_guard();

COMMENT ON TABLE growth_states IS
  'GROWTH-02: the 36 ISO 3166-2:IN states and union territories. Seeded by migration; never written by the API.';

-- ---------------------------------------------------------------------------
-- 2. District imports and districts (imported from the LGD list, never seeded)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_district_imports (
  id uuid PRIMARY KEY,
  filename text NOT NULL,
  file_digest text NOT NULL,
  row_count integer NOT NULL,
  created_count integer NOT NULL,
  renamed_count integer NOT NULL,
  unchanged_count integer NOT NULL,
  reason_code text NOT NULL,
  imported_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE growth_district_imports DROP CONSTRAINT IF EXISTS growth_district_import_ck;
ALTER TABLE growth_district_imports ADD CONSTRAINT growth_district_import_ck CHECK (
  length(filename) BETWEEN 1 AND 200
  AND file_digest ~ '^[0-9a-f]{64}$'
  AND row_count >= 0 AND created_count >= 0 AND renamed_count >= 0 AND unchanged_count >= 0
  AND created_count + renamed_count + unchanged_count = row_count
  AND reason_code IN ('INITIAL_IMPORT', 'LGD_UPDATE', 'CORRECTION'));

CREATE OR REPLACE FUNCTION growth_district_import_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'growth district imports are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_district_import_guard ON growth_district_imports;
CREATE TRIGGER growth_district_import_guard BEFORE UPDATE OR DELETE ON growth_district_imports
  FOR EACH ROW EXECUTE FUNCTION growth_district_import_guard();

CREATE TABLE IF NOT EXISTS growth_districts (
  lgd_code integer PRIMARY KEY,
  state_code text NOT NULL REFERENCES growth_states(code),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_import_id uuid NOT NULL REFERENCES growth_district_imports(id),
  renamed_at timestamptz,
  renamed_import_id uuid REFERENCES growth_district_imports(id)
);

ALTER TABLE growth_districts DROP CONSTRAINT IF EXISTS growth_district_code_ck;
ALTER TABLE growth_districts ADD CONSTRAINT growth_district_code_ck CHECK (lgd_code > 0);
ALTER TABLE growth_districts DROP CONSTRAINT IF EXISTS growth_district_name_ck;
ALTER TABLE growth_districts ADD CONSTRAINT growth_district_name_ck CHECK (length(name) BETWEEN 1 AND 120);
ALTER TABLE growth_districts DROP CONSTRAINT IF EXISTS growth_district_renamed_ck;
ALTER TABLE growth_districts ADD CONSTRAINT growth_district_renamed_ck CHECK ((renamed_at IS NULL) = (renamed_import_id IS NULL));

CREATE INDEX IF NOT EXISTS growth_districts_state_idx ON growth_districts (state_code, name);

-- A district is never deleted and never changes state: areas and leads refer to it, and a
-- district moving state would silently move them. Only a rename, by an import, is allowed.
CREATE OR REPLACE FUNCTION growth_district_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth districts are never deleted';
  END IF;
  IF NEW.lgd_code <> OLD.lgd_code OR NEW.state_code <> OLD.state_code
     OR NEW.created_at <> OLD.created_at OR NEW.created_import_id <> OLD.created_import_id
     OR NEW.renamed_import_id IS NULL THEN
    RAISE EXCEPTION 'a growth district may only be renamed, by an import';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_district_guard ON growth_districts;
CREATE TRIGGER growth_district_guard BEFORE UPDATE OR DELETE ON growth_districts
  FOR EACH ROW EXECUTE FUNCTION growth_district_guard();

COMMENT ON TABLE growth_districts IS
  'GROWTH-02: districts keyed by LGD code, imported by a GROWTH_ADMIN holder from the official list. Never deleted; renamed only by an import.';

-- ---------------------------------------------------------------------------
-- 3. Regions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_regions (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reason_code text NOT NULL,
  retired_at timestamptz,
  retired_by_user_id uuid REFERENCES users(id),
  retired_reason_code text
);

ALTER TABLE growth_regions DROP CONSTRAINT IF EXISTS growth_region_name_ck;
ALTER TABLE growth_regions ADD CONSTRAINT growth_region_name_ck CHECK (
  length(name) BETWEEN 2 AND 60 AND name ~ '^[A-Za-z0-9][A-Za-z0-9 &()./-]*$');
ALTER TABLE growth_regions DROP CONSTRAINT IF EXISTS growth_region_reason_ck;
ALTER TABLE growth_regions ADD CONSTRAINT growth_region_reason_ck CHECK (reason_code IN ('NEW_REGION', 'REORGANISATION', 'CORRECTION'));
ALTER TABLE growth_regions DROP CONSTRAINT IF EXISTS growth_region_retired_ck;
ALTER TABLE growth_regions ADD CONSTRAINT growth_region_retired_ck CHECK (
  (retired_at IS NULL AND retired_by_user_id IS NULL AND retired_reason_code IS NULL)
  OR (retired_at IS NOT NULL AND retired_at >= created_at AND retired_by_user_id IS NOT NULL
      AND retired_reason_code IN ('REORGANISATION', 'NO_LONGER_WORKED', 'CORRECTION')));

CREATE UNIQUE INDEX IF NOT EXISTS growth_regions_live_name_uq ON growth_regions (lower(name)) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Region areas
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_region_areas (
  id uuid PRIMARY KEY,
  region_id uuid NOT NULL REFERENCES growth_regions(id),
  state_code text NOT NULL REFERENCES growth_states(code),
  district_code integer REFERENCES growth_districts(lgd_code),
  added_by_user_id uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  reason_code text NOT NULL,
  removed_at timestamptz,
  removed_by_user_id uuid REFERENCES users(id),
  removed_reason_code text
);

ALTER TABLE growth_region_areas DROP CONSTRAINT IF EXISTS growth_region_area_reason_ck;
ALTER TABLE growth_region_areas ADD CONSTRAINT growth_region_area_reason_ck CHECK (reason_code IN ('NEW_COVERAGE', 'TERRITORY_CHANGE', 'CORRECTION'));
ALTER TABLE growth_region_areas DROP CONSTRAINT IF EXISTS growth_region_area_removed_ck;
ALTER TABLE growth_region_areas ADD CONSTRAINT growth_region_area_removed_ck CHECK (
  (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_reason_code IS NULL)
  OR (removed_at IS NOT NULL AND removed_at >= added_at AND removed_by_user_id IS NOT NULL
      AND removed_reason_code IN ('TERRITORY_CHANGE', 'REGION_RETIRING', 'CORRECTION')));

-- Acceptance: one area in at most one live region. The indexes decide a race.
CREATE UNIQUE INDEX IF NOT EXISTS growth_region_areas_live_state_uq
  ON growth_region_areas (state_code) WHERE removed_at IS NULL AND district_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS growth_region_areas_live_district_uq
  ON growth_region_areas (district_code) WHERE removed_at IS NULL AND district_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_region_areas_region_idx ON growth_region_areas (region_id) WHERE removed_at IS NULL;

CREATE OR REPLACE FUNCTION growth_region_area_guard() RETURNS trigger AS $$
DECLARE
  district_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth region areas are never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL
       OR NEW.id <> OLD.id OR NEW.region_id <> OLD.region_id OR NEW.state_code <> OLD.state_code
       OR NEW.district_code IS DISTINCT FROM OLD.district_code
       OR NEW.added_by_user_id <> OLD.added_by_user_id OR NEW.added_at <> OLD.added_at
       OR NEW.reason_code <> OLD.reason_code OR NEW.removed_at IS NULL THEN
      RAISE EXCEPTION 'growth region areas are append-only: only a removal may be recorded, once';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a growth region area starts live';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM growth_regions WHERE id = NEW.region_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'a growth region area needs a live region';
  END IF;
  IF NEW.district_code IS NOT NULL THEN
    SELECT state_code INTO district_state FROM growth_districts WHERE lgd_code = NEW.district_code;
    IF district_state IS DISTINCT FROM NEW.state_code THEN
      RAISE EXCEPTION 'the district does not belong to the area''s state';
    END IF;
  END IF;

  -- Serialise every area write for the same state, so a concurrent whole-state and district
  -- insert cannot both pass the check below.
  PERFORM pg_advisory_xact_lock(hashtext('growth_region_area:' || NEW.state_code));
  IF NEW.district_code IS NULL THEN
    IF EXISTS (SELECT 1 FROM growth_region_areas
               WHERE state_code = NEW.state_code AND district_code IS NOT NULL AND removed_at IS NULL
                 AND region_id <> NEW.region_id) THEN
      RAISE EXCEPTION 'growth area conflict: a district of this state is live in another region';
    END IF;
    IF EXISTS (SELECT 1 FROM growth_region_areas
               WHERE state_code = NEW.state_code AND district_code IS NOT NULL AND removed_at IS NULL) THEN
      RAISE EXCEPTION 'growth area redundant: this region already covers districts of the state';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM growth_region_areas
               WHERE state_code = NEW.state_code AND district_code IS NULL AND removed_at IS NULL
                 AND region_id <> NEW.region_id) THEN
      RAISE EXCEPTION 'growth area conflict: the whole state is live in another region';
    END IF;
    IF EXISTS (SELECT 1 FROM growth_region_areas
               WHERE state_code = NEW.state_code AND district_code IS NULL AND removed_at IS NULL) THEN
      RAISE EXCEPTION 'growth area redundant: this region already covers the whole state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_region_area_guard ON growth_region_areas;
CREATE TRIGGER growth_region_area_guard
  BEFORE INSERT OR UPDATE OR DELETE ON growth_region_areas
  FOR EACH ROW EXECUTE FUNCTION growth_region_area_guard();

COMMENT ON TABLE growth_region_areas IS
  'GROWTH-02: which states, or districts of a state, a region covers. One live region per area; a whole state and its districts never live apart. Append-only.';

-- ---------------------------------------------------------------------------
-- 5. Territory assignments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_territory_assignments (
  id uuid PRIMARY KEY,
  region_id uuid NOT NULL REFERENCES growth_regions(id),
  membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  assignment_role text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  ended_at timestamptz,
  ended_by_user_id uuid REFERENCES users(id),
  ended_reason_code text
);

ALTER TABLE growth_territory_assignments DROP CONSTRAINT IF EXISTS growth_territory_assignment_role_ck;
ALTER TABLE growth_territory_assignments ADD CONSTRAINT growth_territory_assignment_role_ck CHECK (assignment_role IN ('EXECUTIVE', 'MANAGER'));
ALTER TABLE growth_territory_assignments DROP CONSTRAINT IF EXISTS growth_territory_assignment_reason_ck;
ALTER TABLE growth_territory_assignments ADD CONSTRAINT growth_territory_assignment_reason_ck CHECK (
  reason_code IN ('NEW_ASSIGNMENT', 'TERRITORY_CHANGE', 'COVERAGE', 'CORRECTION'));
ALTER TABLE growth_territory_assignments DROP CONSTRAINT IF EXISTS growth_territory_assignment_ended_ck;
ALTER TABLE growth_territory_assignments ADD CONSTRAINT growth_territory_assignment_ended_ck CHECK (
  (ended_at IS NULL AND ended_by_user_id IS NULL AND ended_reason_code IS NULL)
  OR (ended_at IS NOT NULL AND ended_at >= starts_at
      AND ((ended_by_user_id IS NOT NULL AND ended_reason_code IN ('TERRITORY_CHANGE', 'WORKLOAD', 'LEFT_REGION', 'CORRECTION'))
           OR (ended_by_user_id IS NULL AND ended_reason_code = 'MEMBERSHIP_ENDED'))));

CREATE UNIQUE INDEX IF NOT EXISTS growth_territory_assignments_live_uq
  ON growth_territory_assignments (region_id, membership_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS growth_territory_assignments_membership_idx
  ON growth_territory_assignments (membership_id) WHERE ended_at IS NULL;

CREATE OR REPLACE FUNCTION growth_territory_assignment_guard() RETURNS trigger AS $$
DECLARE
  member_role text;
  member_state text;
  member_user uuid;
  member_org_kind organization_kind;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth territory assignments are never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.ended_at IS NOT NULL
       OR NEW.id <> OLD.id OR NEW.region_id <> OLD.region_id OR NEW.membership_id <> OLD.membership_id
       OR NEW.assignment_role <> OLD.assignment_role OR NEW.starts_at <> OLD.starts_at
       OR NEW.assigned_by_user_id <> OLD.assigned_by_user_id OR NEW.reason_code <> OLD.reason_code
       OR NEW.ended_at IS NULL THEN
      RAISE EXCEPTION 'growth territory assignments are append-only: only an end may be recorded, once';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a growth territory assignment starts live';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM growth_regions WHERE id = NEW.region_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'a growth territory assignment needs a live region';
  END IF;
  SELECT m.role, m.state::text, m.user_id, o.kind INTO member_role, member_state, member_user, member_org_kind
  FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
  WHERE m.id = NEW.membership_id;
  IF member_role IS NULL OR member_role NOT IN ('GROWTH_EXECUTIVE', 'GROWTH_MANAGER')
     OR member_org_kind <> 'PLATFORM' OR member_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a growth territory assignment needs an ACTIVE growth membership of the ONE platform organisation';
  END IF;
  IF (NEW.assignment_role = 'EXECUTIVE' AND member_role <> 'GROWTH_EXECUTIVE')
     OR (NEW.assignment_role = 'MANAGER' AND member_role <> 'GROWTH_MANAGER') THEN
    RAISE EXCEPTION 'the assignment role does not match the growth membership role';
  END IF;
  IF NEW.assigned_by_user_id = member_user THEN
    RAISE EXCEPTION 'a growth person may not assign their own territory';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_territory_assignment_guard ON growth_territory_assignments;
CREATE TRIGGER growth_territory_assignment_guard
  BEFORE INSERT OR UPDATE OR DELETE ON growth_territory_assignments
  FOR EACH ROW EXECUTE FUNCTION growth_territory_assignment_guard();

COMMENT ON TABLE growth_territory_assignments IS
  'GROWTH-02: which growth person works which region, as EXECUTIVE or MANAGER. Append-only; visibility follows the live rows of ACTIVE memberships.';

-- A region in use cannot be retired, and a retired region stays retired.
CREATE OR REPLACE FUNCTION growth_region_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'growth regions are never deleted';
  END IF;
  IF OLD.retired_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.name <> OLD.name OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_at <> OLD.created_at OR NEW.reason_code <> OLD.reason_code OR NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'growth regions are append-only: only a retirement may be recorded, once';
  END IF;
  IF EXISTS (SELECT 1 FROM growth_region_areas WHERE region_id = NEW.id AND removed_at IS NULL)
     OR EXISTS (SELECT 1 FROM growth_territory_assignments WHERE region_id = NEW.id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'growth region in use: remove its areas and end its assignments first';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_region_guard ON growth_regions;
CREATE TRIGGER growth_region_guard BEFORE UPDATE OR DELETE ON growth_regions
  FOR EACH ROW EXECUTE FUNCTION growth_region_guard();

COMMENT ON TABLE growth_regions IS
  'GROWTH-02: named sales regions. Append-only; retired once, only when no live area or assignment remains. A rename is retire plus create.';

-- ---------------------------------------------------------------------------
-- 6. Membership changes that assignments must follow (new functions; 0091's are untouched)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION growth_territory_membership_ended() RETURNS trigger AS $$
BEGIN
  UPDATE growth_territory_assignments SET ended_at = now(), ended_reason_code = 'MEMBERSHIP_ENDED'
  WHERE membership_id = NEW.id AND ended_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_territory_membership_ended ON organization_memberships;
CREATE TRIGGER growth_territory_membership_ended
  AFTER UPDATE OF state ON organization_memberships
  FOR EACH ROW WHEN (NEW.state = 'ENDED' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION growth_territory_membership_ended();

CREATE OR REPLACE FUNCTION growth_territory_role_change_check() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM growth_territory_assignments WHERE membership_id = NEW.id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'end the growth territory assignments before changing the membership role';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS growth_territory_role_change_guard ON organization_memberships;
CREATE TRIGGER growth_territory_role_change_guard
  BEFORE UPDATE OF role ON organization_memberships
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION growth_territory_role_change_check();
