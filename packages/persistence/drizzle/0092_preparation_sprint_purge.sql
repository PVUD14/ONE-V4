-- 0092: a college's exit purge (INST-18, 0088) reaches its preparation sprints (INST-17, 0085).
--
-- 0085 made a sprint undeletable, and 0088 gave the dual-controlled purge its one exception to the
-- 0082 delete guards without knowing sprints existed: the two were built side by side. A sprint is
-- the college's own time-box over one of its learning assignments (assignment_id is NOT NULL and
-- references learning_assignments), so a college that ever ran a sprint could not be purged at all:
-- the assignment delete would fail on the sprint's foreign key, and the sprint delete on its guard.
--
-- The fix mirrors 0088 exactly: the INSERT/UPDATE guard is unchanged, and DELETE is refused unless
-- the transaction-local one.institution_purge names the sprint's college. Everyone else, including
-- the college itself, still cannot delete a sprint.
-- Design: docs/architecture/institution-contract-lifecycle-design.md ("What belongs to whom").
--
-- Idempotent: DROP TRIGGER IF EXISTS before each CREATE TRIGGER. Survives a replay of 0085 and 0088.

DROP TRIGGER IF EXISTS preparation_sprints_guard ON preparation_sprints;
CREATE TRIGGER preparation_sprints_guard BEFORE INSERT OR UPDATE ON preparation_sprints
  FOR EACH ROW EXECUTE FUNCTION guard_preparation_sprint();

DROP TRIGGER IF EXISTS preparation_sprints_delete_guard ON preparation_sprints;
CREATE TRIGGER preparation_sprints_delete_guard BEFORE DELETE ON preparation_sprints
  FOR EACH ROW WHEN (NOT institution_purge_covers(OLD.institution_id)) EXECUTE FUNCTION guard_preparation_sprint();
