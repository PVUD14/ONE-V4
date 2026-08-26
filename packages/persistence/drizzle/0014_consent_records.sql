-- DPDP consent records: who accepted which version of which notice, when.
-- Append-only by design — a re-consent to a newer version adds a row, and
-- withdrawal is recorded as its own row, so the history itself is the proof.

CREATE TABLE IF NOT EXISTS user_consents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  consent_key text NOT NULL,
  version text NOT NULL,
  action text NOT NULL DEFAULT 'GRANTED',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  CONSTRAINT user_consents_key_ck CHECK (consent_key IN ('privacy-notice')),
  CONSTRAINT user_consents_action_ck CHECK (action IN ('GRANTED','WITHDRAWN')),
  CONSTRAINT user_consents_version_len_ck CHECK (length(version) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS user_consents_user_idx
  ON user_consents(user_id, consent_key, recorded_at DESC);
