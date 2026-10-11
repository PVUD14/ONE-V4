-- Consent registry: which consents exist, at which version, and whether the product
-- may be used without them.
--
-- Design circulated in docs/architecture/consent-registry-table-design.md.
--
-- 0014 made exactly one consent key legal by CHECK constraint, so every additional
-- consent the product needs was a migration and the set of keys was invisible to the
-- application at runtime. Three things were blocked behind that: a withdrawal path
-- the consent gate already promises in its own copy, an AI-processing consent, and
-- the distinct employer-discovery consent a talent pool would require before employer
-- visibility could widen beyond an application.
--
-- The record stays append-only. A version bump adds a definition row, a re-consent
-- adds a user_consents row, a withdrawal adds a user_consents row. Nothing is updated
-- in place, because the history is the proof.

CREATE TABLE IF NOT EXISTS consent_definitions (
  consent_key text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  -- BLOCKING refuses entry to the product; OPTIONAL gates exactly one capability and
  -- nothing else.
  enforcement text NOT NULL,
  -- Present so the answer is explicit rather than assumed. Under DPDP withdrawal must
  -- be as easy as granting, so this is expected to be true for every key.
  withdrawable boolean NOT NULL DEFAULT true,
  document_ref text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  -- A retired version is no longer requestable; grants already made against it stand.
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_definitions_pk PRIMARY KEY (consent_key, version),
  CONSTRAINT consent_definition_key_ck CHECK (consent_key ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  CONSTRAINT consent_definition_version_ck CHECK (length(version) BETWEEN 1 AND 64),
  CONSTRAINT consent_definition_title_ck CHECK (length(title) BETWEEN 1 AND 200),
  CONSTRAINT consent_definition_enforcement_ck CHECK (enforcement IN ('BLOCKING','OPTIONAL')),
  CONSTRAINT consent_definition_document_ref_ck CHECK (document_ref IS NULL OR length(document_ref) <= 500),
  CONSTRAINT consent_definition_retired_ck CHECK (retired_at IS NULL OR retired_at >= effective_from)
);

-- Exactly one current version per key: "the version the user was actually shown" has
-- to be a single answer, or the gate cannot ask for it.
CREATE UNIQUE INDEX IF NOT EXISTS consent_definition_current_uq
  ON consent_definitions(consent_key) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- user_consents: widen the vocabulary, keep the record
-- ---------------------------------------------------------------------------
-- The CHECK is replaced by a foreign key, so a grant can only ever reference a
-- version that actually existed -- a stronger guarantee than the constraint it
-- replaces, not a weaker one.

-- Existing rows are carried forward under the version they were granted at, so the
-- foreign key below has something to point at. Enforcement is BLOCKING because that
-- is what the privacy notice has always been.
--
-- They are seeded RETIRED on purpose. Publishing a current version is a deliberate
-- act by an operator against a lawyer-approved notice, and a migration is not the
-- place to decide that the product now demands consent to a particular text. Until
-- one is published there is no BLOCKING consent to satisfy -- which is today's
-- behaviour, and is a different thing from the gate failing open on an error.
INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from, retired_at)
SELECT c.consent_key, c.version, 'Privacy notice', 'BLOCKING', true, min(c.recorded_at), now()
FROM user_consents c
WHERE c.consent_key = 'privacy-notice'
GROUP BY c.consent_key, c.version
ON CONFLICT (consent_key, version) DO NOTHING;

ALTER TABLE user_consents DROP CONSTRAINT IF EXISTS user_consents_key_ck;
ALTER TABLE user_consents DROP CONSTRAINT IF EXISTS user_consents_definition_fk;
ALTER TABLE user_consents ADD CONSTRAINT user_consents_definition_fk
  FOREIGN KEY (consent_key, version) REFERENCES consent_definitions(consent_key, version);

COMMENT ON TABLE consent_definitions IS
  'The consents that exist and their current version. Adding a key is data, not a migration.';
COMMENT ON COLUMN consent_definitions.enforcement IS
  'BLOCKING refuses entry to the product. OPTIONAL gates one capability and nothing else.';
