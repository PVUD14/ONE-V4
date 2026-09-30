-- 0090: two gaps found while writing the pilot runbooks (ENG-17).
--
-- 1. A status notice (OPS-16) is approved for sending by a person other than its drafter,
--    except under OPS-02's solo-operator safeguard: the sole person who can approve notices may
--    approve their own after a 15-minute cooling-off, marked SOLO.
--    Design: docs/architecture/incident-register-table-design.md ("Who approves a notice").
-- 2. Published skills, questions and lessons can be archived: the one change a PUBLISHED content
--    revision may take is PUBLISHED -> ARCHIVED, with every other column unchanged and an ARCHIVE
--    review action recorded, and an archived revision keeps its publication provenance.
--    Design: docs/architecture/content-archive-design.md.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS before
-- every ADD CONSTRAINT and CREATE TRIGGER. Survives a replay of every earlier file before it.

-- ---------------------------------------------------------------------------
-- 1. Status notice approval: a second person, or the solo safeguard
-- ---------------------------------------------------------------------------

-- Who can approve a notice: the same answer effectiveInternalCapabilities gives for
-- COMMS_TEMPLATES in packages/authorization — an ACTIVE user with an ACTIVE platform membership
-- that is PLATFORM_SUPER_ADMIN or OPERATIONS_ADMIN (baseline), or SECURITY_ADMIN with a live grant.
-- plpgsql so it is not validated against tables at creation time.
CREATE OR REPLACE FUNCTION status_notice_approver_count() RETURNS integer AS $$
BEGIN
  RETURN (
    SELECT count(DISTINCT m.user_id)::int
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.state = 'ACTIVE'
      AND (m.role IN ('PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN')
        OR (m.role = 'SECURITY_ADMIN' AND EXISTS (
          SELECT 1 FROM membership_capabilities c
          WHERE c.membership_id = m.id AND c.capability = 'COMMS_TEMPLATES' AND c.revoked_at IS NULL))));
END;
$$ LANGUAGE plpgsql STABLE;

ALTER TABLE incident_status_notices ADD COLUMN IF NOT EXISTS approve_solo boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN incident_status_notices.approve_solo IS
  'Approved by its own drafter under the solo-operator safeguard: the only COMMS_TEMPLATES holder, 15-minute cooling-off (0090).';

-- SOLO only ever describes the drafter's own approval. Rows approved before 0090 keep false.
ALTER TABLE incident_status_notices DROP CONSTRAINT IF EXISTS incident_status_notice_solo_ck;
ALTER TABLE incident_status_notices ADD CONSTRAINT incident_status_notice_solo_ck CHECK (
  NOT approve_solo
  OR (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_by_user_id = drafted_by_user_id));

-- 0081's guard, with the approver rule added to DRAFT -> QUEUED and approve_solo made part of the
-- immutable approval.
CREATE OR REPLACE FUNCTION incident_status_notice_guard() RETURNS trigger AS $$
DECLARE
  incident_state text;
  recent integer;
  daily integer;
  live_orgs integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'status notices are never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'DRAFT' THEN RAISE EXCEPTION 'a status notice starts as a draft'; END IF;
    IF NEW.approve_solo THEN RAISE EXCEPTION 'a status notice starts unapproved'; END IF;
    IF NOT EXISTS (SELECT 1 FROM status_notice_templates s WHERE s.published_template_id = NEW.template_id AND s.state = 'PUBLISHED') THEN
      RAISE EXCEPTION 'a status notice uses only an approved status notice template version';
    END IF;
    SELECT state INTO incident_state FROM incidents WHERE id = NEW.incident_id;
    IF incident_state = 'CLOSED' THEN RAISE EXCEPTION 'a closed incident is final'; END IF;
    NEW.drafted_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.incident_id <> OLD.incident_id OR NEW.template_id <> OLD.template_id
     OR NEW.drafted_by_user_id <> OLD.drafted_by_user_id OR NEW.drafted_at <> OLD.drafted_at OR NEW.draft_reason_code <> OLD.draft_reason_code THEN
    RAISE EXCEPTION 'a status notice''s draft is immutable';
  END IF;
  IF NEW.state = OLD.state THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN RAISE EXCEPTION 'a status notice changes only by a transition'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'DRAFT' AND NEW.state = 'QUEUED' THEN
    -- Serialise approvals for one incident, then apply the rate limit on the database clock.
    SELECT state INTO incident_state FROM incidents WHERE id = NEW.incident_id FOR UPDATE;
    IF incident_state = 'CLOSED' THEN RAISE EXCEPTION 'a closed incident is final'; END IF;
    SELECT count(*) INTO live_orgs FROM incident_affected_organizations WHERE incident_id = NEW.incident_id AND removed_at IS NULL;
    IF live_orgs = 0 THEN RAISE EXCEPTION 'a status notice needs at least one affected organisation'; END IF;
    SELECT count(*) FILTER (WHERE approved_at > now() - interval '15 minutes'), count(*) FILTER (WHERE approved_at > now() - interval '24 hours')
      INTO recent, daily
    FROM incident_status_notices WHERE incident_id = NEW.incident_id AND id <> NEW.id AND approved_at IS NOT NULL;
    IF recent > 0 OR daily >= 6 THEN RAISE EXCEPTION 'status notice rate limit reached for this incident'; END IF;
    -- 0090: the approver is not the drafter, except the sole approver after the cooling-off (SOLO).
    IF NEW.approved_by_user_id = NEW.drafted_by_user_id THEN
      IF NOT NEW.approve_solo THEN
        RAISE EXCEPTION 'a status notice is approved by a person other than its drafter';
      END IF;
      IF now() < NEW.drafted_at + interval '15 minutes' THEN
        RAISE EXCEPTION 'solo approval of a status notice is available after a 15 minute cooling-off';
      END IF;
      IF status_notice_approver_count() <> 1 THEN
        RAISE EXCEPTION 'solo approval of a status notice is available only while one person can approve notices';
      END IF;
    ELSIF NEW.approve_solo THEN
      RAISE EXCEPTION 'only the drafter''s own approval of a status notice is solo';
    END IF;
    NEW.approved_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'DRAFT' AND NEW.state = 'WITHDRAWN' THEN
    IF NEW.approve_solo THEN RAISE EXCEPTION 'a withdrawn status notice was never approved'; END IF;
    NEW.withdrawn_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'QUEUED' AND NEW.state = 'SENT' THEN
    IF NEW.approved_at <> OLD.approved_at OR NEW.approved_by_user_id <> OLD.approved_by_user_id OR NEW.approve_reason_code <> OLD.approve_reason_code
       OR NEW.approve_solo <> OLD.approve_solo THEN
      RAISE EXCEPTION 'the approval of a status notice is immutable';
    END IF;
    NEW.sent_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid status notice transition';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_status_notice_guard ON incident_status_notices;
CREATE TRIGGER incident_status_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON incident_status_notices
FOR EACH ROW EXECUTE FUNCTION incident_status_notice_guard();

-- ---------------------------------------------------------------------------
-- 2. Archiving published skills, questions and lessons
-- ---------------------------------------------------------------------------

-- 0004's guard, with one allowance: a PUBLISHED TOPIC, QUESTION or LESSON revision may become
-- ARCHIVED when nothing else changes and its ARCHIVE review action is already recorded. Every
-- other change to a PUBLISHED or ARCHIVED row, and every delete, stays refused. Engine content
-- (misconception codes, teaching strategies, option tags) keeps 0004's behaviour.
CREATE OR REPLACE FUNCTION protect_published_content_revision()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IN ('PUBLISHED','ARCHIVED') THEN
      RAISE EXCEPTION 'content revisions must enter the review lifecycle before publication';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'PUBLISHED' AND NEW.state = 'ARCHIVED'
     AND OLD.entity_type IN ('TOPIC','QUESTION','LESSON') THEN
    IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
      RAISE EXCEPTION 'archiving changes only the state of a published content revision';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM content_review_actions a
      WHERE a.content_revision_id = NEW.id AND a.action = 'ARCHIVE' AND a.from_state = 'PUBLISHED' AND a.to_state = 'ARCHIVED') THEN
      RAISE EXCEPTION 'a published content revision is archived only with its ARCHIVE review action recorded';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('PUBLISHED','ARCHIVED') THEN
    RAISE EXCEPTION 'published content revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS content_revisions_published_guard ON content_revisions;
CREATE TRIGGER content_revisions_published_guard BEFORE INSERT OR UPDATE OR DELETE ON content_revisions
FOR EACH ROW EXECUTE FUNCTION protect_published_content_revision();

-- 0004's rule for every state but ARCHIVED; an archived revision keeps when and by which release it
-- was published (the guard above makes that possible only from a real publication).
ALTER TABLE content_revisions DROP CONSTRAINT IF EXISTS content_revision_publication_ck;
ALTER TABLE content_revisions ADD CONSTRAINT content_revision_publication_ck CHECK (
  state = 'ARCHIVED' OR ((state = 'PUBLISHED') = (published_at IS NOT NULL AND release_manifest_id IS NOT NULL)));
