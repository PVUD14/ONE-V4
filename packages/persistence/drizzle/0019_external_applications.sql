/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
-- Approved B8 design: declarations are never verified hires or conversion inputs.
-- Physical deletion intentionally removes the declaration from subsequent reports.
CREATE TABLE IF NOT EXISTS external_applications (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id),
  company_name text NOT NULL CHECK (company_name = btrim(company_name) AND length(company_name) BETWEEN 1 AND 200 AND company_name !~ '^[=+@-]'),
  role_title text NOT NULL CHECK (role_title = btrim(role_title) AND length(role_title) BETWEEN 1 AND 200 AND role_title !~ '^[=+@-]'),
  source_kind text NOT NULL CHECK (source_kind IN ('JOB_BOARD', 'COMPANY_SITE', 'REFERRAL')),
  applied_on date NOT NULL,
  application_url text CHECK (application_url IS NULL OR (length(application_url) <= 2048 AND application_url ~* '^https://[^[:space:]/?#@]+[^[:space:]]*$' AND application_url !~* '^https://[^/?#]*@')),
  stage text NOT NULL DEFAULT 'APPLIED' CHECK (stage IN ('APPLIED', 'SCREENING', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
  source text NOT NULL DEFAULT 'STUDENT_DECLARED' CHECK (source = 'STUDENT_DECLARED'),
  verification_state text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state = 'UNVERIFIED'),
  institution_visibility_granted_at timestamptz,
  institution_visibility_revoked_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_application_consent_order_ck CHECK (
    institution_visibility_revoked_at IS NULL OR
    (institution_visibility_granted_at IS NOT NULL AND institution_visibility_revoked_at >= institution_visibility_granted_at)
  )
);
CREATE INDEX IF NOT EXISTS external_application_student_timeline_idx
  ON external_applications(student_user_id, applied_on DESC, id);
CREATE INDEX IF NOT EXISTS external_application_institution_visibility_idx
  ON external_applications(student_user_id, applied_on, id)
  WHERE institution_visibility_granted_at IS NOT NULL AND institution_visibility_revoked_at IS NULL;
