DO $$ BEGIN
  CREATE TYPE event_consumer_receipt_status AS ENUM ('STARTED','SUCCEEDED','FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE relationship_state ADD VALUE IF NOT EXISTS 'REVOKED';

ALTER TABLE institution_relationships DROP CONSTRAINT IF EXISTS institution_relationship_transferred_end_ck;
ALTER TABLE institution_relationships ADD CONSTRAINT institution_relationship_transferred_end_ck
  CHECK (state <> 'TRANSFERRED' OR effective_to IS NOT NULL);

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_failure_class text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_failure_message text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE outbox_events
SET available_at = occurred_at
WHERE available_at IS NULL;

ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_lease_pair_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_lease_pair_ck
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL));

ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_published_state_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_published_state_ck
  CHECK ((delivery_state = 'PUBLISHED' AND published_at IS NOT NULL) OR (delivery_state <> 'PUBLISHED'));

DROP INDEX IF EXISTS outbox_unpublished_idx;
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events(delivery_state, available_at, occurred_at);
CREATE INDEX IF NOT EXISTS outbox_lease_expiry_idx ON outbox_events(delivery_state, lease_expires_at);

CREATE TABLE IF NOT EXISTS event_consumer_receipts (
  id uuid PRIMARY KEY,
  consumer_name text NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  status event_consumer_receipt_status NOT NULL DEFAULT 'STARTED',
  attempts integer NOT NULL DEFAULT 0,
  last_failure_class text,
  started_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_consumer_receipts_consumer_event_uq UNIQUE (consumer_name, event_id),
  CONSTRAINT event_consumer_receipts_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT event_consumer_receipts_success_ck CHECK ((status = 'SUCCEEDED' AND succeeded_at IS NOT NULL) OR (status <> 'SUCCEEDED'))
);

CREATE INDEX IF NOT EXISTS event_consumer_receipts_event_idx ON event_consumer_receipts(event_id);
