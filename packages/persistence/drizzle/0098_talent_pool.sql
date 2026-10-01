-- EMP-14: the consented talent pool — students who opted in to be found by verified employers, what
-- each chose to show, the employers they blocked, and employers' invitations to apply.
--
-- Design: docs/architecture/talent-pool-table-design.md; decision: ADR-044 (Proposed, awaiting HG-4;
-- the consent wording awaits HG-6). Four tables:
--   talent_pool_listings           one row per opt-in; ended (never rewritten) on opt-out or deletion
--   talent_pool_listing_evidence   the verified evidence items a listing shows; removed once
--   talent_pool_blocks             employers a student blocked; unblocked once
--   talent_pool_invitations        an employer's invitation to apply, answered once
-- The triggers make it impossible to show another person's evidence, to invite into another employer's
-- job or onto another person's listing, or to rewrite history. Rows are deleted only by privacy deletion,
-- inside the transaction-local erase setting for that subject (the 0068 pattern).
--
-- The feature ships dark: the flag employer.talent-pool is inserted OFF and switching it ON is a
-- high-risk direction (0038) that needs a second person. The employer-discovery consent definition is
-- seeded at a draft version; the API neither lists nor grants it while the flag is off.
--
-- Idempotent, because the migrator replays every file on every run: IF NOT EXISTS, constraints dropped
-- and re-added by name, CREATE OR REPLACE functions, triggers dropped and re-created, seeds ON CONFLICT
-- DO NOTHING. References only users, organizations (0001), evidence_records (0004), opportunities and
-- applications (0007), consent_definitions (0028) and feature_flags (0029, high_risk_direction 0038).

CREATE TABLE IF NOT EXISTS talent_pool_listings (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  show_branch boolean NOT NULL DEFAULT false,
  show_graduation_year boolean NOT NULL DEFAULT false,
  preferred_cities text[] NOT NULL DEFAULT '{}',
  consent_version text NOT NULL,
  opted_in_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text
);

ALTER TABLE talent_pool_listings DROP CONSTRAINT IF EXISTS talent_pool_listing_cities_ck;
ALTER TABLE talent_pool_listings ADD CONSTRAINT talent_pool_listing_cities_ck
  CHECK (cardinality(preferred_cities) <= 5 AND length(array_to_string(preferred_cities, '|')) <= 400);
ALTER TABLE talent_pool_listings DROP CONSTRAINT IF EXISTS talent_pool_listing_consent_version_ck;
ALTER TABLE talent_pool_listings ADD CONSTRAINT talent_pool_listing_consent_version_ck
  CHECK (length(consent_version) BETWEEN 1 AND 64);
ALTER TABLE talent_pool_listings DROP CONSTRAINT IF EXISTS talent_pool_listing_end_ck;
ALTER TABLE talent_pool_listings ADD CONSTRAINT talent_pool_listing_end_ck
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)
    AND (end_reason IS NULL OR end_reason IN ('STUDENT_OPTED_OUT', 'ACCOUNT_DELETION'))
    AND (ended_at IS NULL OR ended_at >= opted_in_at));

-- One live listing per student; a new opt-in after leaving is a new row (and so new card references).
CREATE UNIQUE INDEX IF NOT EXISTS talent_pool_listing_live_uq
  ON talent_pool_listings(student_user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS talent_pool_listing_student_idx ON talent_pool_listings(student_user_id);

CREATE OR REPLACE FUNCTION guard_talent_pool_listing() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a talent pool listing is removed only by privacy deletion';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'a talent pool listing cannot be written already ended';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    -- Privacy deletion may blank what an ended listing showed when an answered invitation keeps the row.
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text
       AND (to_jsonb(NEW) - 'preferred_cities' - 'show_branch' - 'show_graduation_year')
         = (to_jsonb(OLD) - 'preferred_cities' - 'show_branch' - 'show_graduation_year')
       AND cardinality(NEW.preferred_cities) = 0 AND NOT NEW.show_branch AND NOT NEW.show_graduation_year THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'an ended talent pool listing is never changed';
  END IF;
  IF NEW.id <> OLD.id OR NEW.student_user_id <> OLD.student_user_id
     OR NEW.consent_version <> OLD.consent_version OR NEW.opted_in_at <> OLD.opted_in_at THEN
    RAISE EXCEPTION 'a talent pool listing keeps its student, consent version and opt-in time';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS talent_pool_listing_guard ON talent_pool_listings;
CREATE TRIGGER talent_pool_listing_guard BEFORE INSERT OR UPDATE OR DELETE ON talent_pool_listings
  FOR EACH ROW EXECUTE FUNCTION guard_talent_pool_listing();

CREATE TABLE IF NOT EXISTS talent_pool_listing_evidence (
  id uuid PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES talent_pool_listings(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  evidence_record_id uuid NOT NULL REFERENCES evidence_records(id),
  shown_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_reason text
);

ALTER TABLE talent_pool_listing_evidence DROP CONSTRAINT IF EXISTS talent_pool_listing_evidence_removal_ck;
ALTER TABLE talent_pool_listing_evidence ADD CONSTRAINT talent_pool_listing_evidence_removal_ck
  CHECK ((removed_at IS NULL) = (removed_reason IS NULL)
    AND (removed_reason IS NULL OR removed_reason IN ('STUDENT_REMOVED', 'LISTING_ENDED'))
    AND (removed_at IS NULL OR removed_at >= shown_at));

CREATE UNIQUE INDEX IF NOT EXISTS talent_pool_listing_evidence_live_uq
  ON talent_pool_listing_evidence(listing_id, evidence_record_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS talent_pool_listing_evidence_student_idx ON talent_pool_listing_evidence(student_user_id);

CREATE OR REPLACE FUNCTION guard_talent_pool_listing_evidence() RETURNS trigger AS $$
DECLARE
  owner uuid;
  ended timestamptz;
  subject uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a talent pool evidence row is removed only by privacy deletion';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT student_user_id, ended_at INTO owner, ended FROM talent_pool_listings WHERE id = NEW.listing_id;
    SELECT subject_user_id INTO subject FROM evidence_records WHERE id = NEW.evidence_record_id;
    IF owner IS DISTINCT FROM NEW.student_user_id OR subject IS DISTINCT FROM NEW.student_user_id THEN
      RAISE EXCEPTION 'a student shows only their own evidence, on their own listing';
    END IF;
    IF ended IS NOT NULL THEN
      RAISE EXCEPTION 'evidence cannot be added to an ended listing';
    END IF;
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a talent pool evidence row cannot be written already removed';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'removed_at' - 'removed_reason') = (to_jsonb(OLD) - 'removed_at' - 'removed_reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a talent pool evidence row is never rewritten; it is removed once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS talent_pool_listing_evidence_guard ON talent_pool_listing_evidence;
CREATE TRIGGER talent_pool_listing_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON talent_pool_listing_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_talent_pool_listing_evidence();

CREATE TABLE IF NOT EXISTS talent_pool_blocks (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  employer_id uuid NOT NULL REFERENCES organizations(id),
  blocked_at timestamptz NOT NULL DEFAULT now(),
  unblocked_at timestamptz
);

ALTER TABLE talent_pool_blocks DROP CONSTRAINT IF EXISTS talent_pool_block_dates_ck;
ALTER TABLE talent_pool_blocks ADD CONSTRAINT talent_pool_block_dates_ck
  CHECK (unblocked_at IS NULL OR unblocked_at >= blocked_at);
CREATE UNIQUE INDEX IF NOT EXISTS talent_pool_block_live_uq
  ON talent_pool_blocks(student_user_id, employer_id) WHERE unblocked_at IS NULL;
CREATE INDEX IF NOT EXISTS talent_pool_block_employer_idx ON talent_pool_blocks(employer_id) WHERE unblocked_at IS NULL;

CREATE OR REPLACE FUNCTION guard_talent_pool_block() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a talent pool block is removed only by privacy deletion';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.employer_id AND kind = 'EMPLOYER') THEN
      RAISE EXCEPTION 'only an employer can be blocked';
    END IF;
    IF NEW.unblocked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a block cannot be written already lifted';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.unblocked_at IS NULL AND NEW.unblocked_at IS NOT NULL
     AND (to_jsonb(NEW) - 'unblocked_at') = (to_jsonb(OLD) - 'unblocked_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a talent pool block is never rewritten; it is lifted once';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS talent_pool_block_guard ON talent_pool_blocks;
CREATE TRIGGER talent_pool_block_guard BEFORE INSERT OR UPDATE OR DELETE ON talent_pool_blocks
  FOR EACH ROW EXECUTE FUNCTION guard_talent_pool_block();

CREATE TABLE IF NOT EXISTS talent_pool_invitations (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  listing_id uuid NOT NULL REFERENCES talent_pool_listings(id),
  student_user_id uuid NOT NULL REFERENCES users(id),
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'SENT',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  application_id uuid REFERENCES applications(id),
  cancel_reason text
);

ALTER TABLE talent_pool_invitations DROP CONSTRAINT IF EXISTS talent_pool_invitation_state_ck;
ALTER TABLE talent_pool_invitations ADD CONSTRAINT talent_pool_invitation_state_ck
  CHECK (state IN ('SENT', 'APPLIED', 'DECLINED', 'CANCELLED')
    AND (state = 'SENT') = (responded_at IS NULL)
    AND (state = 'APPLIED') = (application_id IS NOT NULL)
    AND (state = 'CANCELLED') = (cancel_reason IS NOT NULL)
    AND (cancel_reason IS NULL OR cancel_reason IN ('STUDENT_BLOCKED'))
    AND expires_at > created_at
    AND (responded_at IS NULL OR responded_at >= created_at));

-- One invitation per card per job, ever: no pestering, and no signal linking a rejoined card to an old one.
CREATE UNIQUE INDEX IF NOT EXISTS talent_pool_invitation_card_job_uq ON talent_pool_invitations(opportunity_id, listing_id);
CREATE INDEX IF NOT EXISTS talent_pool_invitation_employer_idx ON talent_pool_invitations(employer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS talent_pool_invitation_student_idx ON talent_pool_invitations(student_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_talent_pool_invitation() RETURNS trigger AS $$
DECLARE
  listing_owner uuid;
  job_employer uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.student_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a talent pool invitation is removed only by privacy deletion';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT student_user_id INTO listing_owner FROM talent_pool_listings WHERE id = NEW.listing_id;
    SELECT employer_id INTO job_employer FROM opportunities WHERE id = NEW.opportunity_id;
    IF listing_owner IS DISTINCT FROM NEW.student_user_id THEN
      RAISE EXCEPTION 'an invitation goes to the student whose card was invited';
    END IF;
    IF job_employer IS DISTINCT FROM NEW.employer_id THEN
      RAISE EXCEPTION 'an employer invites only to its own job';
    END IF;
    IF NEW.state <> 'SENT' THEN
      RAISE EXCEPTION 'an invitation is written as sent';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'SENT' AND NEW.state IN ('APPLIED', 'DECLINED', 'CANCELLED')
     AND (to_jsonb(NEW) - 'state' - 'responded_at' - 'application_id' - 'cancel_reason')
       = (to_jsonb(OLD) - 'state' - 'responded_at' - 'application_id' - 'cancel_reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a talent pool invitation is answered once and never rewritten';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS talent_pool_invitation_guard ON talent_pool_invitations;
CREATE TRIGGER talent_pool_invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON talent_pool_invitations
  FOR EACH ROW EXECUTE FUNCTION guard_talent_pool_invitation();

COMMENT ON TABLE talent_pool_listings IS
  'EMP-14: a student''s opt-in to be found by verified employers and what their card shows. Discoverable only with the employer-discovery consent at the current version, visibility EMPLOYER_DISCOVERY and the flag on (ADR-044).';
COMMENT ON TABLE talent_pool_invitations IS
  'EMP-14: an employer''s invitation, from a pseudonymous card, to apply to one of its invite-only jobs. Identity reaches the employer only if the student applies (ADR-044).';

-- The consent the plan requires, at a draft version: the wording awaits legal review (HG-6). The API
-- neither lists nor grants it while employer.talent-pool is off, so its existence offers nobody anything.
INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, document_ref)
VALUES ('employer-discovery', '2026-10-draft', 'Let verified employers find me in the talent pool', 'OPTIONAL', true,
        'docs/legal/employer-discovery-consent-DRAFT-for-legal-review.md')
ON CONFLICT (consent_key, version) DO NOTHING;

-- The dark launch: off, and switching it on needs a second person. Inserted only if absent, so a replay
-- never changes a live switch; the high-risk marking is re-asserted.
INSERT INTO feature_flags (key, description, enabled, high_risk_direction)
VALUES ('employer.talent-pool',
        'Let students opt in to be found by verified employers, and let those employers search the talent pool and invite them to apply (ADR-044, hard gate HG-4; consent wording HG-6). Off: nothing is offered or shown.',
        false, 'ENABLE')
ON CONFLICT (key) DO NOTHING;
UPDATE feature_flags SET high_risk_direction = 'ENABLE'
WHERE key = 'employer.talent-pool' AND high_risk_direction IS DISTINCT FROM 'ENABLE';
