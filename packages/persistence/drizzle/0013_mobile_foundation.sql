-- Mobile foundation: persistent per-user notifications and device push tokens.
-- Notifications are written by domain events (exam assigned, result published)
-- and consumed by the web bell today and the Android app tomorrow. Device
-- tokens are the FCM registry; the fanout sender activates when Firebase
-- credentials are configured.

CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT user_notifications_kind_ck CHECK (kind IN ('EXAM_ASSIGNED','EXAM_REOPENED','RESULT_PUBLISHED','SYSTEM')),
  CONSTRAINT user_notifications_title_len_ck CHECK (length(title) BETWEEN 1 AND 160),
  CONSTRAINT user_notifications_body_len_ck CHECK (length(body) BETWEEN 1 AND 500),
  CONSTRAINT user_notifications_read_ck CHECK (read_at IS NULL OR read_at >= created_at)
);
CREATE INDEX IF NOT EXISTS user_notifications_user_idx
  ON user_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_notifications_unread_idx
  ON user_notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  platform text NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT device_push_tokens_platform_ck CHECK (platform IN ('ANDROID','IOS','WEB')),
  CONSTRAINT device_push_tokens_token_len_ck CHECK (length(token) BETWEEN 8 AND 4096)
);
CREATE UNIQUE INDEX IF NOT EXISTS device_push_tokens_token_uq ON device_push_tokens(token);
CREATE INDEX IF NOT EXISTS device_push_tokens_user_idx
  ON device_push_tokens(user_id) WHERE revoked_at IS NULL;
