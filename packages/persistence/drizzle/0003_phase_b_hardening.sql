ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_token text;

UPDATE outbox_events
SET lease_token = md5(id::text || lease_owner || lease_expires_at::text)
WHERE delivery_state = 'PROCESSING'
  AND lease_owner IS NOT NULL
  AND lease_expires_at IS NOT NULL
  AND lease_token IS NULL;

ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_lease_pair_ck;
ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_lease_state_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_lease_state_ck
  CHECK (
    (
      delivery_state = 'PROCESSING'
      AND lease_owner IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      delivery_state <> 'PROCESSING'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  );

ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_published_state_ck;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_published_state_ck
  CHECK (
    (delivery_state = 'PUBLISHED' AND published_at IS NOT NULL)
    OR (delivery_state <> 'PUBLISHED' AND published_at IS NULL)
  );

ALTER TABLE institution_relationships DROP CONSTRAINT IF EXISTS institution_relationship_transferred_end_ck;
ALTER TABLE institution_relationships ADD CONSTRAINT institution_relationship_transferred_end_ck
  CHECK (state <> 'TRANSFERRED' OR effective_to IS NOT NULL);

ALTER TABLE institution_relationships DROP CONSTRAINT IF EXISTS institution_relationship_graduated_end_ck;
ALTER TABLE institution_relationships ADD CONSTRAINT institution_relationship_graduated_end_ck
  CHECK (state <> 'GRADUATED' OR effective_to IS NOT NULL);
