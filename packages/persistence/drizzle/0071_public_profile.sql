-- Public profile share links, and the profile photo they may show.
--
-- Decision in docs/architecture/ADR-031-public-profile-share-links.md. This is the
-- migration that ends ONE's no-unauthenticated-routes property, so the rules are written
-- here as well as there.
--
-- Three things shape everything below.
--
-- Only a digest of the token is stored. The raw token is returned once, to the student who
-- created it, and never again. A disclosure of this table therefore leaks no working
-- profile URLs -- the same reasoning, and the same hashing, as invitation tokens.
--
-- Every section is opt-in, and the two that matter most are opt-in even among those:
-- assessment results and the profile photo both default to false. A percentage attached to
-- a person, and a face attached to a name and a city, are deliberate acts rather than
-- things that happen because somebody pressed publish.
--
-- Nothing here can express the readiness band. There is no column for it, no join to
-- readiness_snapshots, and no flag that could be flipped to reveal one. That table already
-- refuses to hold an employer-visible row; a public page is further out still.

-- ---------------------------------------------------------------------------
-- The profile photo
-- ---------------------------------------------------------------------------
--
-- One per student, replacing the Android app's device-only file, so every client shows the
-- same photo and a reinstall does not lose it. The bytes live in the same encrypted,
-- virus-scanned store as every other upload; this row is the pointer and the provenance.

CREATE TABLE IF NOT EXISTS student_profile_photos (
  student_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  checksum_sha256 text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_profile_photo_type_ck CHECK (content_type IN ('image/png', 'image/jpeg')),
  -- Five megabytes. A profile photo larger than this is a mistake, not a requirement.
  CONSTRAINT student_profile_photo_size_ck CHECK (byte_size > 0 AND byte_size <= 5242880),
  CONSTRAINT student_profile_photo_key_ck CHECK (length(btrim(storage_key)) BETWEEN 1 AND 512),
  CONSTRAINT student_profile_photo_checksum_ck
    CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE student_profile_photos IS
  'One profile photo per student, stored server-side so every client agrees. Bytes live in the encrypted, scanned file store; this row is the pointer.';

-- ---------------------------------------------------------------------------
-- The share link
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public_profile_links (
  id uuid PRIMARY KEY,
  student_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the raw token. The raw token is never stored.
  token_digest text NOT NULL,
  cover_key text NOT NULL DEFAULT 'MIDNIGHT',

  -- What the student chose to publish. Every one of these is the student's own decision,
  -- and the page renders only what is true here.
  show_photo boolean NOT NULL DEFAULT false,
  show_headline boolean NOT NULL DEFAULT true,
  show_city boolean NOT NULL DEFAULT true,
  show_institution boolean NOT NULL DEFAULT true,
  show_education boolean NOT NULL DEFAULT true,
  show_self_reported boolean NOT NULL DEFAULT true,
  show_assessments boolean NOT NULL DEFAULT false,
  show_learning boolean NOT NULL DEFAULT true,
  show_certificates boolean NOT NULL DEFAULT true,
  show_skills boolean NOT NULL DEFAULT true,
  show_portfolio boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_viewed_at timestamptz,

  CONSTRAINT public_profile_token_ck CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  -- A fixed set, because an uploaded cover would need somebody checking every image
  -- before it appeared under the AI8HT wordmark, and nobody is doing that.
  CONSTRAINT public_profile_cover_ck CHECK (cover_key IN ('MIDNIGHT', 'TEAL', 'VIOLET', 'EMBER')),
  CONSTRAINT public_profile_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT public_profile_revoked_ck CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- The digest is the lookup key and must be unique across every link ever issued, live or
-- dead: a revoked token must never be reachable again by being reissued to somebody else.
CREATE UNIQUE INDEX IF NOT EXISTS public_profile_token_uq
  ON public_profile_links(token_digest);

-- One live link per student. Publishing again revokes the old one rather than leaving two
-- addresses alive, so "revoke" means what a student thinks it means.
CREATE UNIQUE INDEX IF NOT EXISTS public_profile_live_uq
  ON public_profile_links(student_user_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS public_profile_student_idx
  ON public_profile_links(student_user_id, created_at DESC);

COMMENT ON TABLE public_profile_links IS
  'A student-published profile reachable without signing in. Only a digest of the token is stored; the raw token is shown once, to its owner. See ADR-031.';
COMMENT ON COLUMN public_profile_links.show_assessments IS
  'Off by default. A percentage attached to a person is a deliberate act, not a side effect of publishing.';
COMMENT ON COLUMN public_profile_links.show_photo IS
  'Off by default. Name, city and institution already identify a person; a face is the student''s call to make.';
