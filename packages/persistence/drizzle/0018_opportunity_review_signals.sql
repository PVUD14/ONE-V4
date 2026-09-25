/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
-- Advisory evidence only. Operations owns review decisions and their UI.
CREATE TABLE IF NOT EXISTS opportunity_review_signals (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL,
  employer_id uuid NOT NULL,
  opportunity_version_id uuid NOT NULL,
  signal_code text NOT NULL CHECK (signal_code IN
    ('APPLICANT_PAYMENT_DEMAND', 'CROSS_EMPLOYER_DUPLICATE', 'MISSING_COMPENSATION', 'IMPLAUSIBLE_COMPENSATION')),
  detector_version text NOT NULL,
  review_state text NOT NULL DEFAULT 'PENDING' CHECK (review_state IN ('PENDING', 'REVIEWED')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (opportunity_id, employer_id) REFERENCES opportunities(id, employer_id),
  FOREIGN KEY (opportunity_version_id, opportunity_id) REFERENCES opportunity_versions(id, opportunity_id),
  UNIQUE (opportunity_version_id, signal_code, detector_version)
);
CREATE INDEX IF NOT EXISTS opportunity_review_signals_pending_idx
  ON opportunity_review_signals(first_detected_at) WHERE review_state = 'PENDING';
