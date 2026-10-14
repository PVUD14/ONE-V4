-- Trust & Safety cases.
--
-- Design circulated in docs/architecture/trust-safety-case-table-design.md; the
-- proposals recorded there are adopted here and confirmed at review.
--
-- The product already tells students they may report an employer for misrepresenting a
-- job, and there has been nowhere to put the report. Meanwhile opportunity_review_signals
-- has been writing four fraud detector codes on every publish, behind a partial index
-- that is plainly a queue index, and nothing has ever read it.
--
-- Two rules shape everything below.
--
-- A report is not a penalty (spec 38: "A report creates a case; it does not
-- automatically penalize the employer"). The case record and the enforcement record are
-- therefore separate tables, so deciding and punishing are distinct acts and an appeal
-- can reverse the second without rewriting the first.
--
-- Safety never touches readiness (spec 7.16, 30). No column here references readiness,
-- and nothing in this migration can move a band.
--
-- staff_actions is the closest structural precedent and is deliberately not reused: it
-- is institution-scoped by construction, with composite foreign keys pinning its unit
-- columns to that institution, and a platform case about an employer has no institution.
-- Making that column nullable would weaken constraints that currently make
-- cross-institution leakage impossible.

CREATE TABLE IF NOT EXISTS trust_cases (
  id uuid PRIMARY KEY,
  case_type text NOT NULL,
  subject_kind text NOT NULL,
  -- Four nullable typed columns with exactly one set, rather than one polymorphic
  -- pair: uglier, and the database enforces it.
  subject_organization_id uuid REFERENCES organizations(id),
  subject_user_id uuid REFERENCES users(id),
  subject_opportunity_version_id uuid REFERENCES opportunity_versions(id),
  subject_content_revision_id uuid REFERENCES content_revisions(id),
  -- Nullable: a platform-wide case concerns no single tenant.
  organization_id uuid REFERENCES organizations(id),
  -- Null means detector-originated. It does not mean anonymous.
  reported_by_user_id uuid REFERENCES users(id),
  state text NOT NULL DEFAULT 'REPORTED',
  severity text NOT NULL DEFAULT 'MEDIUM',
  assigned_to_user_id uuid REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT trust_case_type_ck CHECK (case_type IN
    ('EMPLOYER_ACCOUNTABILITY','OPPORTUNITY_MODERATION','USER_SAFETY','CONTENT')),
  CONSTRAINT trust_case_subject_kind_ck CHECK (subject_kind IN
    ('ORGANIZATION','USER','OPPORTUNITY_VERSION','CONTENT_REVISION')),
  CONSTRAINT trust_case_state_ck CHECK (state IN
    ('REPORTED','TRIAGED','AWAITING_RESPONSE','UNDER_INVESTIGATION','DECIDED','ACTIONED','CLOSED','DISMISSED','APPEALED','REOPENED')),
  CONSTRAINT trust_case_severity_ck CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT trust_case_version_ck CHECK (version >= 1),
  -- Exactly one subject, and it must match the declared kind.
  CONSTRAINT trust_case_subject_shape_ck CHECK (
    (subject_kind = 'ORGANIZATION' AND subject_organization_id IS NOT NULL AND subject_user_id IS NULL
      AND subject_opportunity_version_id IS NULL AND subject_content_revision_id IS NULL)
    OR (subject_kind = 'USER' AND subject_user_id IS NOT NULL AND subject_organization_id IS NULL
      AND subject_opportunity_version_id IS NULL AND subject_content_revision_id IS NULL)
    OR (subject_kind = 'OPPORTUNITY_VERSION' AND subject_opportunity_version_id IS NOT NULL AND subject_organization_id IS NULL
      AND subject_user_id IS NULL AND subject_content_revision_id IS NULL)
    OR (subject_kind = 'CONTENT_REVISION' AND subject_content_revision_id IS NOT NULL AND subject_organization_id IS NULL
      AND subject_user_id IS NULL AND subject_opportunity_version_id IS NULL)),
  -- A closed case has a closing time; an open one does not.
  CONSTRAINT trust_case_closed_ck CHECK (
    (state IN ('CLOSED','DISMISSED')) = (closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS trust_case_queue_idx ON trust_cases(state, severity, opened_at)
  WHERE state NOT IN ('CLOSED','DISMISSED');
CREATE INDEX IF NOT EXISTS trust_case_subject_org_idx ON trust_cases(subject_organization_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS trust_case_assignee_idx ON trust_cases(assigned_to_user_id, state);

-- ---------------------------------------------------------------------------
-- Transitions
-- ---------------------------------------------------------------------------
-- Append-only, on the content_review_actions pattern, with the from <> to constraint
-- learner_content_reviews uses.

CREATE TABLE IF NOT EXISTS trust_case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES trust_cases(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason_code text NOT NULL,
  note text,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trust_case_event_change_ck CHECK (from_state <> to_state),
  CONSTRAINT trust_case_event_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$'),
  CONSTRAINT trust_case_event_note_ck CHECK (note IS NULL OR length(note) <= 2000)
);
CREATE INDEX IF NOT EXISTS trust_case_event_case_idx ON trust_case_events(case_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------
-- References, never copies. A REVIEW_SIGNAL row is how opportunity_review_signals
-- finally acquires a reader. The reporter's statement is the one free-text exception
-- and is bounded.

CREATE TABLE IF NOT EXISTS trust_case_evidence (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES trust_cases(id),
  evidence_kind text NOT NULL,
  reference_id text NOT NULL,
  statement text,
  added_by_user_id uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trust_case_evidence_kind_ck CHECK (evidence_kind IN
    ('REVIEW_SIGNAL','OPPORTUNITY_VERSION','DOCUMENT_VERSION','AUDIT_CORRELATION','REPORTER_STATEMENT')),
  CONSTRAINT trust_case_evidence_reference_ck CHECK (length(reference_id) BETWEEN 1 AND 200),
  CONSTRAINT trust_case_evidence_statement_ck CHECK (
    (evidence_kind = 'REPORTER_STATEMENT' AND statement IS NOT NULL AND length(statement) <= 4000)
    OR (evidence_kind <> 'REPORTER_STATEMENT' AND statement IS NULL))
);
CREATE INDEX IF NOT EXISTS trust_case_evidence_case_idx ON trust_case_evidence(case_id, added_at);

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------
-- Separate from the decision, so an appeal reverses an action without deleting it.
-- Actions are spec 38's list.

CREATE TABLE IF NOT EXISTS trust_case_actions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES trust_cases(id),
  action text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  applied_by_user_id uuid NOT NULL REFERENCES users(id),
  applied_at timestamptz NOT NULL DEFAULT now(),
  reversed_by_user_id uuid REFERENCES users(id),
  reversed_at timestamptz,
  reversal_reason_code text,
  CONSTRAINT trust_case_action_ck CHECK (action IN
    ('WARNING','ENHANCED_MODERATION','POSTING_RESTRICTION','TRUST_DOWNGRADE','TEMPORARY_SUSPENSION','PERMANENT_REMOVAL')),
  CONSTRAINT trust_case_action_window_ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- A reversal is a person, a time and a reason, together or not at all.
  CONSTRAINT trust_case_action_reversal_ck CHECK (
    (reversed_by_user_id IS NULL AND reversed_at IS NULL AND reversal_reason_code IS NULL)
    OR (reversed_by_user_id IS NOT NULL AND reversed_at IS NOT NULL AND reversal_reason_code ~ '^[A-Z0-9_:-]{3,64}$')),
  -- A temporary suspension that never ends is a permanent removal under another name.
  CONSTRAINT trust_case_action_temporary_ck CHECK (
    action <> 'TEMPORARY_SUSPENSION' OR effective_to IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trust_case_action_case_idx ON trust_case_actions(case_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS trust_case_action_live_idx ON trust_case_actions(action, effective_from)
  WHERE reversed_at IS NULL;

-- ---------------------------------------------------------------------------
-- No self-review
-- ---------------------------------------------------------------------------
-- The repository already refuses self-approval on content reviews. A person cannot
-- decide or action a case they reported.

CREATE OR REPLACE FUNCTION trust_case_no_self_review() RETURNS trigger AS $$
DECLARE
  reporter uuid;
BEGIN
  SELECT reported_by_user_id INTO reporter FROM trust_cases WHERE id = NEW.case_id;
  IF reporter IS NOT NULL AND reporter = NEW.actor_user_id
     AND NEW.to_state IN ('DECIDED','ACTIONED','DISMISSED','CLOSED') THEN
    RAISE EXCEPTION 'the reporter of a case cannot decide it';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trust_case_self_review_guard ON trust_case_events;
CREATE TRIGGER trust_case_self_review_guard
  BEFORE INSERT ON trust_case_events
  FOR EACH ROW EXECUTE FUNCTION trust_case_no_self_review();

COMMENT ON TABLE trust_cases IS
  'Trust and safety cases. A report is not a penalty: enforcement lives in trust_case_actions.';
COMMENT ON TABLE trust_case_actions IS
  'Enforcement, separate from the decision, so an appeal reverses an action without rewriting history.';
