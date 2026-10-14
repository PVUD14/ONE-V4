/**
 * ONE · Stream D — Learner
 * Owner: Santhosh · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */

CREATE TABLE IF NOT EXISTS learner_content_reviews (
  id uuid PRIMARY KEY,
  content_id uuid NOT NULL REFERENCES learner_content_items(id),
  reviewer_user_id uuid NOT NULL REFERENCES users(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_content_reviews_from_state_ck CHECK (from_state IN (
    'DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'ARCHIVED'
  )),
  CONSTRAINT learner_content_reviews_to_state_ck CHECK (to_state IN (
    'DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'ARCHIVED'
  )),
  CONSTRAINT learner_content_reviews_transition_ck CHECK (from_state <> to_state),
  CONSTRAINT learner_content_reviews_note_ck CHECK (note IS NULL OR length(note) <= 2000)
);

CREATE INDEX IF NOT EXISTS learner_content_reviews_content_idx
  ON learner_content_reviews(content_id, created_at DESC);
