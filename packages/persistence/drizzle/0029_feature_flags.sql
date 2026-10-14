-- Feature flags: operational control over what is switched on, for whom, and how much
-- of it may run.
--
-- Design circulated in docs/architecture/feature-flags-table-design.md.
--
-- CLAUDE.md already requires this ("every AI feature ships behind its own flag,
-- default off, with its own cap") and nothing implemented it. It is also what lets a
-- surface land dark instead of waiting for its engine, which matters well before any
-- AI work starts.
--
-- A flag is an operational control: a kill switch, a staged rollout, a per-institution
-- pilot enablement, a spend ceiling. A flag is NOT an entitlement. ADR-022 is explicit
-- that capability gating built before billing must not assume a billing source of
-- truth, and nothing here may be used to express what a customer has paid for.
-- Authorization continues to gate on role and membership.

CREATE TABLE IF NOT EXISTS feature_flags (
  key text PRIMARY KEY,
  description text NOT NULL,
  -- Default off as a column default rather than a convention, so a flag inserted
  -- carelessly is still off.
  enabled boolean NOT NULL DEFAULT false,
  cap_kind text,
  cap_value bigint,
  cap_window text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_key_ck CHECK (key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT feature_flag_description_ck CHECK (length(description) BETWEEN 1 AND 500),
  CONSTRAINT feature_flag_cap_kind_ck CHECK (cap_kind IS NULL OR cap_kind IN ('INVOCATIONS','TOKENS','COST_MINOR_UNITS')),
  CONSTRAINT feature_flag_cap_window_ck CHECK (cap_window IS NULL OR cap_window IN ('DAY','MONTH')),
  -- A cap is a kind, a value and a window together, or it is nothing. A ceiling with
  -- no period is not a ceiling.
  CONSTRAINT feature_flag_cap_shape_ck CHECK (
    (cap_kind IS NULL AND cap_value IS NULL AND cap_window IS NULL)
    OR (cap_kind IS NOT NULL AND cap_value IS NOT NULL AND cap_window IS NOT NULL AND cap_value > 0))
);

-- ---------------------------------------------------------------------------
-- Narrow enablement
-- ---------------------------------------------------------------------------
-- One pilot institution, one test user. An override can also force a flag OFF for a
-- single tenant, which is what makes it usable as a targeted kill switch.

CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  id uuid PRIMARY KEY,
  flag_key text NOT NULL REFERENCES feature_flags(key),
  scope_kind text NOT NULL,
  scope_id uuid NOT NULL,
  enabled boolean NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT feature_flag_override_scope_ck CHECK (scope_kind IN ('ORGANIZATION','USER')),
  CONSTRAINT feature_flag_override_revoked_ck CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_override_live_uq
  ON feature_flag_overrides(flag_key, scope_kind, scope_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS feature_flag_override_scope_idx
  ON feature_flag_overrides(scope_kind, scope_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Who changed what, and why
-- ---------------------------------------------------------------------------
-- Append-only. Platform control 103 classes disabling a security control as a
-- high-risk action requiring reason capture and audit; flipping a flag that gates a
-- safety behaviour is in that class, so the reason code is mandatory rather than a
-- nicety. The bounded shape matches rights_reviews and quality_reviews.

CREATE TABLE IF NOT EXISTS feature_flag_events (
  id uuid PRIMARY KEY,
  flag_key text NOT NULL REFERENCES feature_flags(key),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  change_kind text NOT NULL,
  from_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  to_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_code text NOT NULL,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_event_kind_ck CHECK (change_kind IN
    ('CREATED','ENABLED','DISABLED','CAP_CHANGED','OVERRIDE_ADDED','OVERRIDE_REVOKED')),
  CONSTRAINT feature_flag_event_reason_ck CHECK (reason_code ~ '^[A-Z0-9_:-]{3,64}$')
);
CREATE INDEX IF NOT EXISTS feature_flag_event_flag_idx ON feature_flag_events(flag_key, occurred_at DESC);

COMMENT ON TABLE feature_flags IS
  'Operational rollout and kill-switch control. Never an entitlement -- see ADR-022.';
COMMENT ON COLUMN feature_flags.cap_value IS
  'The ceiling. Counting is done by whichever subsystem performs the work, not here.';
