-- External review assignments (OPS-10): which college faculty member may see which
-- unpublished content revision, who decided that, until when, and what they said.
--
-- Design: docs/architecture/external-review-assignments-table-design.md
-- Decision: ADR-037 -- faculty access is a time-limited, hash-bound assignment on top of
-- the CONTENT_REVIEW_EXTERNAL grant (0039); the faculty decision is advisory, and the
-- internal approval (the rights review) and publish are unchanged.
--
-- Applies once under ADR-035 and is written to survive a bootstrap replay: CREATE ... IF
-- NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- No existing table, constraint or migration changes.

CREATE TABLE IF NOT EXISTS external_review_assignments (
  id uuid PRIMARY KEY,
  content_revision_id uuid NOT NULL REFERENCES content_revisions(id),
  content_hash text NOT NULL,
  reviewer_membership_id uuid NOT NULL REFERENCES organization_memberships(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid NOT NULL REFERENCES organizations(id),
  assigned_by_user_id uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  reason_code text NOT NULL,
  state text NOT NULL DEFAULT 'ASSIGNED',
  decision text,
  decision_reason_code text,
  decision_comment text,
  decided_at timestamptz,
  revoked_by_user_id uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoked_reason_code text,
  CONSTRAINT external_review_hash_ck CHECK (content_hash ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT external_review_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT external_review_state_ck CHECK (state IN ('ASSIGNED', 'DECIDED', 'REVOKED')),
  CONSTRAINT external_review_window_ck CHECK (
    expires_at >= assigned_at + interval '1 day' AND expires_at <= assigned_at + interval '30 days'),
  CONSTRAINT external_review_not_self_assigned_ck CHECK (assigned_by_user_id <> reviewer_user_id),
  -- The decision columns appear together, and only on a decided row.
  CONSTRAINT external_review_decision_ck CHECK (
    (state = 'DECIDED') = (decision IS NOT NULL)
    AND (decision IS NULL) = (decision_reason_code IS NULL)
    AND (decision IS NULL) = (decided_at IS NULL)
    AND (decision IS NULL OR decision IN ('APPROVE', 'REQUEST_CHANGES'))
    AND (decision_reason_code IS NULL OR decision_reason_code ~ '^[A-Z0-9_:-]{3,64}$')
    AND (decision_comment IS NULL OR (decision IS NOT NULL AND char_length(decision_comment) BETWEEN 1 AND 2000))
    AND (decision IS DISTINCT FROM 'REQUEST_CHANGES' OR decision_comment IS NOT NULL)),
  -- The revocation columns appear together, and only on a revoked row.
  CONSTRAINT external_review_revocation_ck CHECK (
    (state = 'REVOKED') = (revoked_at IS NOT NULL)
    AND (revoked_at IS NULL) = (revoked_by_user_id IS NULL)
    AND (revoked_at IS NULL) = (revoked_reason_code IS NULL)
    AND (revoked_reason_code IS NULL OR revoked_reason_code ~ '^[A-Z0-9_:-]{3,64}$'))
);

-- One open assignment of a revision to one person; several people may review one revision.
CREATE UNIQUE INDEX IF NOT EXISTS external_review_open_uq
  ON external_review_assignments (content_revision_id, reviewer_user_id) WHERE state = 'ASSIGNED';
-- The faculty queue: a reviewer's assignments, newest first.
CREATE INDEX IF NOT EXISTS external_review_reviewer_idx
  ON external_review_assignments (reviewer_user_id, assigned_at DESC, id DESC);
-- The operator list: newest first, and by revision.
CREATE INDEX IF NOT EXISTS external_review_assigned_idx
  ON external_review_assignments (assigned_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS external_review_revision_idx
  ON external_review_assignments (content_revision_id);
CREATE INDEX IF NOT EXISTS external_review_membership_idx
  ON external_review_assignments (reviewer_membership_id) WHERE state = 'ASSIGNED';

-- ---------------------------------------------------------------------------
-- The grant of access is enforced here, not only in the API
-- ---------------------------------------------------------------------------
-- Whether a membership may review right now: ACTIVE, an institution faculty member or
-- department head of the stated college, for the stated user, with a live grant.
CREATE OR REPLACE FUNCTION external_review_membership_eligible(p_membership uuid, p_user uuid, p_institution uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.id = p_membership AND m.user_id = p_user AND m.organization_id = p_institution
      AND m.state = 'ACTIVE' AND o.kind = 'INSTITUTION'
      AND m.role IN ('FACULTY_LECTURER', 'DEPARTMENT_HEAD')
      AND EXISTS (
        SELECT 1 FROM membership_capabilities c
        WHERE c.membership_id = m.id AND c.capability = 'CONTENT_REVIEW_EXTERNAL' AND c.revoked_at IS NULL))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION external_review_assignment_guard() RETURNS trigger AS $$
DECLARE
  revision_state text;
  revision_type text;
  revision_hash text;
  revision_author uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'external review assignments are never deleted';
  END IF;

  SELECT state, entity_type, content_hash, author_user_id
    INTO revision_state, revision_type, revision_hash, revision_author
  FROM content_revisions WHERE id = NEW.content_revision_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'ASSIGNED' THEN
      RAISE EXCEPTION 'an external review assignment starts ASSIGNED';
    END IF;
    NEW.assigned_at := now();
    IF NEW.expires_at < NEW.assigned_at + interval '1 day' OR NEW.expires_at > NEW.assigned_at + interval '30 days' THEN
      RAISE EXCEPTION 'an external review assignment lasts between 1 and 30 days';
    END IF;
    IF revision_type IS NULL OR revision_type NOT IN ('TOPIC', 'QUESTION', 'LESSON') THEN
      RAISE EXCEPTION 'only a skill, question or lesson revision may be assigned for external review';
    END IF;
    IF revision_state <> 'IN_REVIEW' OR revision_hash <> NEW.content_hash THEN
      RAISE EXCEPTION 'only the content of a revision in review may be assigned for external review';
    END IF;
    IF NOT external_review_membership_eligible(NEW.reviewer_membership_id, NEW.reviewer_user_id, NEW.institution_id) THEN
      RAISE EXCEPTION 'the reviewer must be an active faculty member or department head holding CONTENT_REVIEW_EXTERNAL';
    END IF;
    IF NEW.reviewer_user_id = revision_author THEN
      RAISE EXCEPTION 'the author of a revision may not review it';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: what was assigned, to whom, by whom and until when never changes.
  IF NEW.content_revision_id <> OLD.content_revision_id OR NEW.content_hash <> OLD.content_hash
     OR NEW.reviewer_membership_id <> OLD.reviewer_membership_id OR NEW.reviewer_user_id <> OLD.reviewer_user_id
     OR NEW.institution_id <> OLD.institution_id OR NEW.assigned_by_user_id <> OLD.assigned_by_user_id
     OR NEW.assigned_at <> OLD.assigned_at OR NEW.expires_at <> OLD.expires_at OR NEW.reason_code <> OLD.reason_code THEN
    RAISE EXCEPTION 'an external review assignment is immutable except for its decision or revocation';
  END IF;
  IF OLD.state <> 'ASSIGNED' THEN
    RAISE EXCEPTION 'a decided or revoked external review assignment cannot change';
  END IF;
  IF NEW.state = 'DECIDED' THEN
    NEW.decided_at := now();
    IF NEW.decided_at >= OLD.expires_at THEN
      RAISE EXCEPTION 'the external review assignment has expired';
    END IF;
    IF revision_state <> 'IN_REVIEW' OR revision_hash <> OLD.content_hash THEN
      RAISE EXCEPTION 'the assigned revision is no longer in review as assigned';
    END IF;
    IF NOT external_review_membership_eligible(OLD.reviewer_membership_id, OLD.reviewer_user_id, OLD.institution_id) THEN
      RAISE EXCEPTION 'the reviewer no longer holds CONTENT_REVIEW_EXTERNAL on an active membership';
    END IF;
  ELSIF NEW.state = 'REVOKED' THEN
    NEW.revoked_at := now();
  ELSE
    RAISE EXCEPTION 'an external review assignment moves only to DECIDED or REVOKED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS external_review_assignment_guard ON external_review_assignments;
CREATE TRIGGER external_review_assignment_guard
  BEFORE INSERT OR UPDATE ON external_review_assignments
  FOR EACH ROW EXECUTE FUNCTION external_review_assignment_guard();

DROP TRIGGER IF EXISTS external_review_assignment_no_delete ON external_review_assignments;
CREATE TRIGGER external_review_assignment_no_delete
  BEFORE DELETE ON external_review_assignments
  FOR EACH ROW EXECUTE FUNCTION external_review_assignment_guard();

COMMENT ON TABLE external_review_assignments IS
  'OPS-10 / ADR-037: one content revision assigned to one college faculty reviewer for a fixed period; the faculty decision is advisory.';
