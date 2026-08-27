-- Learner activity events: the honest data source behind streaks and weekly
-- progress. Append-only; one row per meaningful learning action. Only real
-- actions are recorded (lesson completions, assessment attempts) - never
-- logins or page views - so a streak always means actual learning activity.

CREATE TABLE IF NOT EXISTS learner_activity_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL,
  occurred_on date NOT NULL DEFAULT CURRENT_DATE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_activity_type_ck CHECK (event_type IN (
    'LESSON_COMPLETED', 'EXAM_ATTEMPT_STARTED', 'EXAM_ATTEMPT_SUBMITTED'
  ))
);

CREATE INDEX IF NOT EXISTS learner_activity_user_day_idx
  ON learner_activity_events(user_id, occurred_on DESC);
