-- 0094: the delivery ledger can say a message went out over authenticated SMTP.
--
-- notification_delivery_attempts.provider_kind (0004) allowed MAILPIT, SES and N8N. ONE now has a
-- real TLS SMTP sender (TlsSmtpMailSink, info@ai8ht.pro via GoDaddy), and without this the API would
-- record every real delivery as MAILPIT — a local capture that never reaches anyone. The CHECK is
-- replaced by one allowing the same values plus SMTP. Nothing that was allowed before is refused,
-- and nothing else is admitted.
-- Design: docs/architecture/ADR-042-outgoing-mail-over-authenticated-smtp.md (decision 5).
--
-- Idempotent: every CHECK on the table that mentions provider_kind (0004's unnamed one, or this
-- file's on a replay) is dropped, then the named constraint is added. 0004's CREATE TABLE IF NOT
-- EXISTS is a no-op on replay, so the widened constraint survives it.

DO $$
DECLARE
  existing record;
BEGIN
  FOR existing IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relname = 'notification_delivery_attempts'
       AND n.nspname = current_schema()
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%provider_kind%'
  LOOP
    EXECUTE format('ALTER TABLE notification_delivery_attempts DROP CONSTRAINT %I', existing.conname);
  END LOOP;
END
$$;

ALTER TABLE notification_delivery_attempts
  ADD CONSTRAINT notification_delivery_attempts_provider_kind_check
  CHECK (provider_kind IN ('MAILPIT', 'SES', 'N8N', 'SMTP'));
