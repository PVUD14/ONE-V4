/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS institution_visibility_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS institution_visibility_revoked_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'applications'::regclass
                   AND conname = 'applications_institution_visibility_order_ck') THEN
    ALTER TABLE applications ADD CONSTRAINT applications_institution_visibility_order_ck
      CHECK (institution_visibility_revoked_at IS NULL OR
        (institution_visibility_granted_at IS NOT NULL AND
         institution_visibility_revoked_at >= institution_visibility_granted_at));
  END IF;
END $$;
