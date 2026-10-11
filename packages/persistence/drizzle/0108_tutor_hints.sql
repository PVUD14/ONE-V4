-- 0108 — tutor_hints (ENG-22): one row per AI hint a student asked for on a practice question, with the
-- provenance of what the model wrote, what ONE's guard found, what the student was shown, and a staff
-- review state. Design: docs/architecture/tutor-hints-table-design.md.
--
-- Why: CLAUDE.md requires every model output to be stored with source, generator_version, prompt_version,
-- review_state and generated_at, landing as DRAFT. A tutor hint is shown live after a code guard and
-- reviewed by staff sampling afterwards (Decision 1), so its row is the audit trail of what a model said
-- to a student. A request raises the step item's hint level in the same transaction (an AI hint is a
-- ladder level, Decision 2), so the 0047 assisted rule applies unchanged.
--
-- Numbered 0108 by the coordinator: 0105 is ENG-20's, 0106 ENG-23's, 0107 fix/document-verification's.
-- Applied once by the ledger runner (ADR-035); written idempotently all the same.

CREATE TABLE IF NOT EXISTS tutor_hints (
  id uuid PRIMARY KEY,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  institution_id uuid REFERENCES organizations(id),
  decision_id uuid NOT NULL REFERENCES learning_decisions(id),
  item_id uuid NOT NULL REFERENCES question_versions(id),
  hint_level smallint NOT NULL,
  language text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  fallback_reason text,
  guard_findings text[] NOT NULL DEFAULT '{}',
  guard_repairs text[] NOT NULL DEFAULT '{}',
  generated_text text,
  source text NOT NULL DEFAULT 'AI_GENERATED',
  generator_version text,
  prompt_version text NOT NULL,
  prompt_fingerprint text,
  model text,
  policy_version text NOT NULL,
  guard_version text,
  review_state text NOT NULL DEFAULT 'DRAFT',
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_reason_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz,
  completed_at timestamptz,
  correlation_id text NOT NULL,
  CONSTRAINT tutor_hints_level_ck CHECK (hint_level BETWEEN 1 AND 4),
  CONSTRAINT tutor_hints_language_ck CHECK (language IN ('en','te','hi')),
  CONSTRAINT tutor_hints_status_ck CHECK (status IN ('PENDING','GENERATING','SHOWN','FALLBACK')),
  CONSTRAINT tutor_hints_fallback_reason_ck CHECK (fallback_reason IS NULL
    OR fallback_reason IN ('GUARD_REFUSED','REDIRECTED','GENERATION_FAILED','AI_UNAVAILABLE','EXPIRED','WITHDRAWN')),
  CONSTRAINT tutor_hints_findings_ck CHECK (guard_findings <@ ARRAY['FORMAT','ANSWER_LEAK','PERSONAL_DATA','PROMISE','WRONG_LANGUAGE',
    'READINESS_OR_PLACEMENT','ARITHMETIC_ERROR','CODE_UNVERIFIED']::text[]),
  CONSTRAINT tutor_hints_repairs_ck CHECK (guard_repairs <@ ARRAY['TRIMMED','COLLAPSED_SPACES']::text[]),
  CONSTRAINT tutor_hints_text_ck CHECK (generated_text IS NULL OR length(generated_text) BETWEEN 1 AND 4000),
  CONSTRAINT tutor_hints_source_ck CHECK (source = 'AI_GENERATED'),
  CONSTRAINT tutor_hints_prompt_ck CHECK (prompt_version ~ '^[a-z0-9][a-z0-9._-]{1,63}@[1-9][0-9]{0,5}$'),
  CONSTRAINT tutor_hints_versions_ck CHECK (length(policy_version) BETWEEN 1 AND 64
    AND (guard_version IS NULL OR length(guard_version) BETWEEN 1 AND 64)
    AND (generator_version IS NULL OR length(generator_version) BETWEEN 1 AND 200)
    AND (model IS NULL OR length(model) BETWEEN 1 AND 200)
    AND (prompt_fingerprint IS NULL OR prompt_fingerprint ~ '^[0-9a-f]{8,64}$')),
  CONSTRAINT tutor_hints_correlation_ck CHECK (length(correlation_id) BETWEEN 1 AND 200),
  -- Generated text arrives with its provenance, all at once.
  CONSTRAINT tutor_hints_generation_ck CHECK ((generated_text IS NULL) = (generated_at IS NULL)
    AND (generated_text IS NULL OR (generator_version IS NOT NULL AND model IS NOT NULL AND prompt_fingerprint IS NOT NULL))),
  -- Open requests carry no outcome; a shown hint passed the guard; a fallback says why.
  CONSTRAINT tutor_hints_outcome_ck CHECK (
    (status IN ('PENDING','GENERATING') AND fallback_reason IS NULL AND completed_at IS NULL AND cardinality(guard_findings) = 0)
    OR (status = 'SHOWN' AND fallback_reason IS NULL AND completed_at IS NOT NULL AND generated_text IS NOT NULL
        AND guard_version IS NOT NULL AND cardinality(guard_findings) = 0)
    OR (status = 'FALLBACK' AND fallback_reason IS NOT NULL AND completed_at IS NOT NULL
        AND (fallback_reason <> 'GUARD_REFUSED' OR (cardinality(guard_findings) > 0 AND guard_version IS NOT NULL)))),
  CONSTRAINT tutor_hints_review_state_ck CHECK (review_state IN ('DRAFT','PUBLISHED','REJECTED')),
  -- A staff review is all or nothing, and only of a completed hint with text to read.
  CONSTRAINT tutor_hints_review_ck CHECK (
    (review_state = 'DRAFT' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason_code IS NULL)
    OR (review_state <> 'DRAFT' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
        AND review_reason_code ~ '^[A-Z][A-Z_]{2,63}$' AND generated_text IS NOT NULL AND status IN ('SHOWN','FALLBACK')))
);

-- One AI request per question level in a step.
CREATE UNIQUE INDEX IF NOT EXISTS tutor_hints_level_uq ON tutor_hints(decision_id, item_id, hint_level);
-- The per-student daily cap.
CREATE INDEX IF NOT EXISTS tutor_hints_subject_idx ON tutor_hints(subject_user_id, requested_at DESC);
-- Staff sampling and the refused list.
CREATE INDEX IF NOT EXISTS tutor_hints_review_idx ON tutor_hints(review_state, requested_at DESC) WHERE status IN ('SHOWN','FALLBACK');

-- A request is born PENDING and DRAFT, for the step item's own student, at the level that step item now
-- records (the request raised it in the same transaction), while the question is unanswered.
CREATE OR REPLACE FUNCTION guard_tutor_hint_insert()
RETURNS trigger AS $$
DECLARE
  item record;
BEGIN
  IF NEW.status <> 'PENDING' OR NEW.review_state <> 'DRAFT' OR NEW.generated_text IS NOT NULL
     OR NEW.reviewed_by_user_id IS NOT NULL OR cardinality(NEW.guard_findings) <> 0 OR cardinality(NEW.guard_repairs) <> 0
     OR NEW.guard_version IS NOT NULL OR NEW.generator_version IS NOT NULL OR NEW.model IS NOT NULL OR NEW.prompt_fingerprint IS NOT NULL THEN
    RAISE EXCEPTION 'a tutor hint is requested as PENDING and DRAFT, with nothing generated';
  END IF;
  SELECT subject_user_id, institution_id, hint_level INTO item
  FROM learning_step_items WHERE decision_id = NEW.decision_id AND item_id = NEW.item_id;
  IF NOT FOUND OR item.subject_user_id IS DISTINCT FROM NEW.subject_user_id
     OR item.institution_id IS DISTINCT FROM NEW.institution_id OR item.hint_level IS DISTINCT FROM NEW.hint_level THEN
    RAISE EXCEPTION 'a tutor hint belongs to its step item, at the level the item records';
  END IF;
  IF EXISTS (
    SELECT 1 FROM learning_attempt_events e
    WHERE e.source_attempt_type = 'learning_step' AND e.source_attempt_id = NEW.decision_id AND e.item_id = NEW.item_id
  ) THEN
    RAISE EXCEPTION 'a tutor hint is requested only on an unanswered question';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tutor_hints_insert_guard ON tutor_hints;
CREATE TRIGGER tutor_hints_insert_guard
  BEFORE INSERT ON tutor_hints
  FOR EACH ROW EXECUTE FUNCTION guard_tutor_hint_insert();

-- The request never changes. Status moves forward only (PENDING → GENERATING → SHOWN | FALLBACK, or
-- PENDING → FALLBACK); generation is written once; a review moves DRAFT to PUBLISHED or REJECTED once.
-- Removed only by privacy deletion for the same subject (the 0072 pattern).
CREATE OR REPLACE FUNCTION guard_tutor_hint_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('one.privacy_erase_subject', true) = OLD.subject_user_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'tutor_hints rows are removed only by privacy deletion';
  END IF;
  IF NEW.id <> OLD.id OR NEW.subject_user_id <> OLD.subject_user_id OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
     OR NEW.decision_id <> OLD.decision_id OR NEW.item_id <> OLD.item_id OR NEW.hint_level <> OLD.hint_level
     OR NEW.language <> OLD.language OR NEW.source <> OLD.source OR NEW.prompt_version <> OLD.prompt_version
     OR NEW.policy_version <> OLD.policy_version OR NEW.requested_at <> OLD.requested_at OR NEW.correlation_id <> OLD.correlation_id THEN
    RAISE EXCEPTION 'tutor_hints: the request is never changed';
  END IF;
  IF OLD.generated_text IS NOT NULL AND (NEW.generated_text IS DISTINCT FROM OLD.generated_text
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
     OR NEW.model IS DISTINCT FROM OLD.model OR NEW.prompt_fingerprint IS DISTINCT FROM OLD.prompt_fingerprint) THEN
    RAISE EXCEPTION 'tutor_hints: a generation is written once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('GENERATING','FALLBACK'))
    OR (OLD.status = 'GENERATING' AND NEW.status IN ('SHOWN','FALLBACK'))) THEN
    RAISE EXCEPTION 'tutor_hints: status moves forward only';
  END IF;
  IF OLD.status IN ('SHOWN','FALLBACK') AND (NEW.fallback_reason IS DISTINCT FROM OLD.fallback_reason
     OR NEW.guard_findings IS DISTINCT FROM OLD.guard_findings OR NEW.guard_repairs IS DISTINCT FROM OLD.guard_repairs
     OR NEW.guard_version IS DISTINCT FROM OLD.guard_version OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.generated_text IS DISTINCT FROM OLD.generated_text) THEN
    RAISE EXCEPTION 'tutor_hints: a completed hint''s outcome is final';
  END IF;
  IF NEW.review_state IS DISTINCT FROM OLD.review_state AND NOT (OLD.review_state = 'DRAFT' AND NEW.review_state IN ('PUBLISHED','REJECTED')) THEN
    RAISE EXCEPTION 'tutor_hints: a review moves a DRAFT to PUBLISHED or REJECTED, once';
  END IF;
  IF OLD.review_state <> 'DRAFT' AND (NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code) THEN
    RAISE EXCEPTION 'tutor_hints: a review is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tutor_hints_change_guard ON tutor_hints;
CREATE TRIGGER tutor_hints_change_guard
  BEFORE UPDATE OR DELETE ON tutor_hints
  FOR EACH ROW EXECUTE FUNCTION guard_tutor_hint_change();

COMMENT ON TABLE tutor_hints IS
  'ENG-22: one AI hint request on a practice question, with provenance, guard outcome and staff review. Shown live only after the code guard; DRAFT until a staff reviewer samples it.';
