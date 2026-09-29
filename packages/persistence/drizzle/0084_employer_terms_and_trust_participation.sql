-- EMP-16: employer terms and an employer's part in trust cases about it.
--
-- Design: docs/architecture/employer-terms-and-trust-participation-design.md (written first).
--
-- Three tables, all append-only, each holding a record someone may later rely on:
--   employer_terms_versions         what the terms said, immutable; the first version is material
--   employer_terms_acceptances      which employer accepted which version, who and when
--   trust_case_employer_statements  what operations shared with a subject employer, and what the
--                                   employer answered or appealed
--
-- Nothing is seeded: publishing terms every employer must accept is an operator's act against a
-- reviewed text, not a migration's (the 0028 position). Until a version exists, publishing jobs
-- behaves exactly as before.
--
-- Idempotent: every statement is guarded, and replaying the file changes nothing.

CREATE TABLE IF NOT EXISTS employer_terms_versions (
  version text PRIMARY KEY,
  -- The events and audit layer address records by uuid; the version string stays the human key.
  id uuid NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  body_sha256 text NOT NULL,
  legal_review_state text NOT NULL,
  legal_review_reference text,
  requires_reacceptance boolean NOT NULL,
  change_summary text,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  correlation_id text NOT NULL,
  CONSTRAINT employer_terms_version_ck CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT employer_terms_title_ck CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT employer_terms_body_ck CHECK (length(body) BETWEEN 1 AND 60000),
  CONSTRAINT employer_terms_digest_ck CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT employer_terms_legal_state_ck CHECK (legal_review_state IN ('DRAFT_FOR_LEGAL_REVIEW', 'LEGAL_APPROVED')),
  -- An approval names who approved it; a draft claims no approval.
  CONSTRAINT employer_terms_legal_reference_ck CHECK (
    (legal_review_state = 'LEGAL_APPROVED') = (legal_review_reference IS NOT NULL)
    AND (legal_review_reference IS NULL OR length(legal_review_reference) BETWEEN 3 AND 200)),
  CONSTRAINT employer_terms_change_summary_ck CHECK (change_summary IS NULL OR length(change_summary) BETWEEN 1 AND 2000),
  CONSTRAINT employer_terms_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT employer_terms_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS employer_terms_published_idx ON employer_terms_versions (published_at DESC, version);
CREATE INDEX IF NOT EXISTS employer_terms_material_idx ON employer_terms_versions (published_at DESC) WHERE requires_reacceptance;

CREATE TABLE IF NOT EXISTS employer_terms_acceptances (
  id uuid PRIMARY KEY,
  employer_id uuid NOT NULL REFERENCES organizations(id),
  terms_version text NOT NULL REFERENCES employer_terms_versions(version),
  accepted_by_user_id uuid NOT NULL REFERENCES users(id),
  accepted_role text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  CONSTRAINT employer_terms_acceptance_role_ck CHECK (accepted_role = 'EMPLOYER_OWNER'),
  CONSTRAINT employer_terms_acceptance_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128),
  CONSTRAINT employer_terms_acceptance_once_uq UNIQUE (employer_id, terms_version)
);
CREATE INDEX IF NOT EXISTS employer_terms_acceptance_employer_idx ON employer_terms_acceptances (employer_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS trust_case_employer_statements (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES trust_cases(id),
  employer_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  author_side text NOT NULL,
  body text NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  CONSTRAINT trust_case_statement_kind_ck CHECK (kind IN ('ALLEGATION_SUMMARY', 'DECISION_SUMMARY', 'EMPLOYER_RESPONSE', 'EMPLOYER_APPEAL')),
  -- Operations write the summaries; the employer writes its response and appeal. Never the other way.
  CONSTRAINT trust_case_statement_side_ck CHECK (
    (kind IN ('ALLEGATION_SUMMARY', 'DECISION_SUMMARY') AND author_side = 'OPERATIONS')
    OR (kind IN ('EMPLOYER_RESPONSE', 'EMPLOYER_APPEAL') AND author_side = 'EMPLOYER')),
  CONSTRAINT trust_case_statement_body_ck CHECK (length(body) BETWEEN 1 AND 4000),
  CONSTRAINT trust_case_statement_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS trust_case_statement_case_idx ON trust_case_employer_statements (case_id, created_at);
CREATE INDEX IF NOT EXISTS trust_case_statement_employer_idx ON trust_case_employer_statements (employer_id, created_at DESC);
-- One appeal per case: an employer appeals a decision once, and operations decide it.
CREATE UNIQUE INDEX IF NOT EXISTS trust_case_statement_one_appeal_uq ON trust_case_employer_statements (case_id) WHERE kind = 'EMPLOYER_APPEAL';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- The history is the proof: no row in these three tables is ever changed or removed.
CREATE OR REPLACE FUNCTION employer_terms_trust_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employer_terms_versions_append_only ON employer_terms_versions;
CREATE TRIGGER employer_terms_versions_append_only BEFORE UPDATE OR DELETE ON employer_terms_versions
  FOR EACH ROW EXECUTE FUNCTION employer_terms_trust_append_only();
DROP TRIGGER IF EXISTS employer_terms_acceptances_append_only ON employer_terms_acceptances;
CREATE TRIGGER employer_terms_acceptances_append_only BEFORE UPDATE OR DELETE ON employer_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION employer_terms_trust_append_only();
DROP TRIGGER IF EXISTS trust_case_employer_statements_append_only ON trust_case_employer_statements;
CREATE TRIGGER trust_case_employer_statements_append_only BEFORE UPDATE OR DELETE ON trust_case_employer_statements
  FOR EACH ROW EXECUTE FUNCTION employer_terms_trust_append_only();

-- The first version is material, so "the version an employer must have accepted" always has an
-- answer once any terms exist. The digest is computed here, from the text actually stored.
CREATE OR REPLACE FUNCTION employer_terms_version_guard() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('employer_terms_versions'));
  IF NOT NEW.requires_reacceptance AND NOT EXISTS (SELECT 1 FROM employer_terms_versions) THEN
    RAISE EXCEPTION 'the first employer terms version must require acceptance';
  END IF;
  NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employer_terms_version_guard ON employer_terms_versions;
CREATE TRIGGER employer_terms_version_guard BEFORE INSERT ON employer_terms_versions
  FOR EACH ROW EXECUTE FUNCTION employer_terms_version_guard();

-- Terms are accepted by, and trust statements concern, employer organisations only.
CREATE OR REPLACE FUNCTION employer_terms_trust_employer_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.employer_id AND kind = 'EMPLOYER') THEN
    RAISE EXCEPTION 'employer_id must reference an employer organisation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employer_terms_acceptances_employer_guard ON employer_terms_acceptances;
CREATE TRIGGER employer_terms_acceptances_employer_guard BEFORE INSERT ON employer_terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION employer_terms_trust_employer_guard();
DROP TRIGGER IF EXISTS trust_case_employer_statements_employer_guard ON trust_case_employer_statements;
CREATE TRIGGER trust_case_employer_statements_employer_guard BEFORE INSERT ON trust_case_employer_statements
  FOR EACH ROW EXECUTE FUNCTION employer_terms_trust_employer_guard();

COMMENT ON TABLE employer_terms_versions IS
  'Employer terms, one immutable row per version. DRAFT_FOR_LEGAL_REVIEW text is always labelled as a draft.';
COMMENT ON TABLE employer_terms_acceptances IS
  'Which employer accepted which terms version, by which owner and when. Append-only.';
COMMENT ON TABLE trust_case_employer_statements IS
  'What operations shared with the subject employer of a trust case, and the employer''s response and appeal. Never names the reporter.';
