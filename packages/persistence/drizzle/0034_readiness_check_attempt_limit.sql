-- Let the readiness check be retaken.
--
-- `assessment_definitions.attempt_limit` has existed since 0004 and was read by nothing.
-- `startAssessmentAttempt` enforced its own rule instead — any prior attempt at all, in
-- any state, blocked a new one — so every definition behaved as a one-shot regardless of
-- what it declared. That is now fixed in code, which makes this column load-bearing for
-- the first time, and the pilot readiness check is sitting on the default of 1.
--
-- One is the wrong number for it. ADR-020 describes readiness as a band that develops as
-- evidence accumulates; a check you may take exactly once can only ever contribute a
-- single, permanent data point, and the plan records that the feature was untestable for
-- this reason. Three leaves room to improve without making retakes free: the pilot bank
-- holds six questions and draws four per attempt, so unlimited retries would let a
-- learner build evidence out of repetition instead of learning.
--
-- Scoped to the readiness check by stable key. Institution exams carry their own
-- attempts_allowed on exam_definitions and are untouched.
UPDATE assessment_definitions
SET attempt_limit = 3
WHERE stable_key = 'career-readiness-fundamentals-check'
  AND attempt_limit = 1;
