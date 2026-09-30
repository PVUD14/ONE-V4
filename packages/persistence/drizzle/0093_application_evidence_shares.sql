-- EMP-13: the student's per-application choice of verified skill evidence to share with an employer.
--
-- Design: docs/architecture/application-evidence-shares-table-design.md; decision: ADR-043 (Proposed,
-- awaiting HG-4). One row per (application, evidence record) the student chose to share; revocable,
-- never deleted, never rewritten except to revoke once. The triggers make it impossible to share
-- another person's evidence or to share into another person's application.
--
-- The feature ships dark: the flag employer.skill-evidence is inserted OFF, and switching it ON is a
-- high-risk direction (0038) that needs a second person.
--
-- Idempotent, because the migrator replays every file on every run: IF NOT EXISTS, constraints dropped
-- and re-added by name, CREATE OR REPLACE functions, triggers dropped and re-created, the flag inserted
-- ON CONFLICT DO NOTHING. References only users (0001), applications (0007), evidence_records (0004)
-- and feature_flags (0029, high_risk_direction 0038).

CREATE TABLE IF NOT EXISTS application_evidence_shares (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  evidence_record_id uuid NOT NULL REFERENCES evidence_records(id),
  shared_via text NOT NULL,
  shared_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text
);

ALTER TABLE application_evidence_shares DROP CONSTRAINT IF EXISTS application_evidence_share_via_ck;
ALTER TABLE application_evidence_shares ADD CONSTRAINT application_evidence_share_via_ck
  CHECK (shared_via IN ('APPLY', 'APPLICATION'));
ALTER TABLE application_evidence_shares DROP CONSTRAINT IF EXISTS application_evidence_share_revocation_ck;
ALTER TABLE application_evidence_shares ADD CONSTRAINT application_evidence_share_revocation_ck
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)
    AND (revoked_reason IS NULL OR revoked_reason IN ('STUDENT_REVOKED', 'ACCOUNT_DELETION'))
    AND (revoked_at IS NULL OR revoked_at >= shared_at));

-- One live share per item per application; a re-share after a revocation is a new row.
CREATE UNIQUE INDEX IF NOT EXISTS application_evidence_share_live_uq
  ON application_evidence_shares(application_id, evidence_record_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS application_evidence_share_application_idx
  ON application_evidence_shares(application_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS application_evidence_share_student_idx
  ON application_evidence_shares(student_user_id);

CREATE OR REPLACE FUNCTION guard_application_evidence_share() RETURNS trigger AS $$
DECLARE
  applicant uuid;
  subject uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT student_user_id INTO applicant FROM applications WHERE id = NEW.application_id;
    SELECT subject_user_id INTO subject FROM evidence_records WHERE id = NEW.evidence_record_id;
    IF applicant IS DISTINCT FROM NEW.student_user_id OR subject IS DISTINCT FROM NEW.student_user_id THEN
      RAISE EXCEPTION 'a student shares only their own evidence, on their own application';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'an evidence share cannot be written already revoked';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an evidence share is never deleted; it is revoked';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.application_id = OLD.application_id
     AND NEW.student_user_id = OLD.student_user_id AND NEW.evidence_record_id = OLD.evidence_record_id
     AND NEW.shared_via = OLD.shared_via AND NEW.shared_at = OLD.shared_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an evidence share is never rewritten; it is revoked once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS application_evidence_share_guard ON application_evidence_shares;
CREATE TRIGGER application_evidence_share_guard BEFORE INSERT OR UPDATE OR DELETE ON application_evidence_shares
  FOR EACH ROW EXECUTE FUNCTION guard_application_evidence_share();

COMMENT ON TABLE application_evidence_shares IS
  'EMP-13: evidence records a student chose to share with the employer of one application. Read by the employer only through the live applicant-access grant and only while unrevoked; never a score, stage or count (ADR-043).';

-- The dark launch: off, and switching it on needs a second person. Inserted only if absent, so a replay
-- never changes a live switch; the high-risk marking is re-asserted.
INSERT INTO feature_flags (key, description, enabled, high_risk_direction)
VALUES ('employer.skill-evidence',
        'Let students share verified per-skill evidence with an employer for one application, and let that employer read it (ADR-043, hard gate HG-4). Off: nothing is offered or shown.',
        false, 'ENABLE')
ON CONFLICT (key) DO NOTHING;
UPDATE feature_flags SET high_risk_direction = 'ENABLE'
WHERE key = 'employer.skill-evidence' AND high_risk_direction IS DISTINCT FROM 'ENABLE';
