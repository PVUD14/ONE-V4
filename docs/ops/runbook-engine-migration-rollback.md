# Runbook — Rollback notes for the learning-engine migrations

> What this is: one rollback note per learning-engine migration — what each adds, who writes and
> reads it, and how to take it out of service without losing data. Why it exists: ENG-17 asks for
> "a rollback note for each engine migration". Migrations in ONE are forward-only (ADR-035), so a
> rollback here is never a down-migration: it is a code rollback, a switch that makes the feature
> inert, and a forward fix. Read against base `4fab0c6`; the checks were run on a local seeded
> database (see [Verified locally](#verified-locally)). Written 2026-09-30.

## The rules every note follows

1. **No down-migrations, no edits.** `db:migrate` applies each file once and records it in
   `schema_migrations` with a SHA-256 checksum; a recorded file whose contents changed is refused
   (`MigrationChecksumMismatch`). Never edit, delete or "revert" an applied migration, and never
   `DROP` or `TRUNCATE` an engine table: most refuse `DELETE` outright (append-only or
   projector-only triggers), and the only sanctioned deletion is the privacy-deletion transaction
   for one subject.
2. **Code rollback first.** Every migration below only adds tables, columns with constant defaults,
   widened CHECKs, functions and triggers. The previous release does not reference the new objects,
   so [runbook-rollback.md](runbook-rollback.md) (symlink flip + `systemctl restart
   planthepath-api.service`) takes a feature out of service while its tables stay, unused, with their
   data. This compatibility is by inspection of each migration, noted per row; it has not been
   exercised against a real previous release. Triggers the migration added **stay in force** after a
   code rollback — each note says what they refuse.
3. **Make it inert.** Where the feature has a switch, use it. The engine has no feature flag; its
   engine-wide switch is consent: every engine reader calls `hasConsentPurpose(…,
   'adaptive-learning')` per request and fails closed, so with no live `adaptive-learning`
   definition every student is on the non-adaptive path and a rebuild leaves no projection rows.
   **No engine consent definition is published today (HG-6)** — the adaptive parts are already
   inert in every pilot database.
4. **Forward fix.** A defect is fixed by a new migration with the next free number, written
   idempotently (ADR-035 still replays everything once on a fresh database), with a design note in
   `docs/architecture/` first when the table carries consequences. Derived data is then rebuilt
   (`engine:rebuild-skill-state`); facts are never rewritten.

Commands below run from the release directory with `DATABASE_URL` from `app.env` (never printed):
`F="corepack pnpm --silent --filter @planthepath/persistence"`. Everything touching a real
database is Divakar's.

## Which migrations are engine migrations

The engine's tables are those listed in Part D.1 of the program plan. Checked against every file
0047–0084:

| Migration | Goal | Engine? |
|---|---|---|
| 0047_learning_attempt_log | ENG-03 | **Yes** — `learning_attempt_events`, `learning_sessions` |
| 0049_misconceptions_and_teaching_strategies | ENG-07 | **Yes** — `misconception_codes`, `question_option_misconceptions`, `teaching_strategies` |
| 0050_evidence_stages_and_required_evidence | ENG-04 | **Yes** — `evidence_records.assisted`/`.stage_at_capture`, `career_role_requirements.required_evidence_types` |
| 0052_learner_skill_state | ENG-05 (+ENG-07 link) | **Yes** — `learner_skill_state` |
| 0053_learning_decisions | ENG-08 | **Yes** — `learning_decisions` |
| 0056_career_target_drafts | ENG-11 | **Yes** — agent-drafted career target provenance |
| 0061_question_bank_editor | OPS-09b | Engine-adjacent — adds `question_hint_ladders`, the hint ladder the engine serves |
| 0062_item_calibrations | ENG-13 | **Yes** — `item_calibration_runs`, `item_calibrations` |
| 0064_placement_tests | ENG-14 | **Yes** — `placement_tests`, `placement_test_items` |
| 0065_lesson_variant_editor | OPS-09c | Engine-adjacent — content-variant metadata (D.1 "content revisions gain variant metadata") |
| 0066_external_review_assignments | OPS-10 | **No** — content-review governance; no engine table. Note kept short below |
| 0068_learner_goals | ENG-19 | **Yes** — `learner_goals`, `career_catalogue_goals` |
| 0072_learning_step_items | ENG-18 | **Yes** — `learning_step_items` |
| 0082_faculty_learning_actions | INST-16 | Engine-adjacent — the planner's faculty constraints |

0048, 0055, 0075 and 0076 do not exist; no other file 0047–0084 touches an engine table.

## 0047 — learning attempt log (ENG-03)

- **Adds:** `learning_attempt_events` and `learning_sessions`, both append-only
  (`learning_attempt_events_append_only`, `learning_sessions_append_only`); privacy-deletion category
  `LEARNING_ACTIVITY` (ERASED).
- **Written by:** career-readiness check submit (`career-readiness.ts`), institution exam attempts
  (`student-assessment-attempts.controller.ts`), the learning step (`learning-experience.ts`) and the
  placement test (`placement-tests.ts`), all through `recordGradedAttemptSession` in the grading
  transaction. **Read by:** the projector, the planner, the calibration export, the faculty cohort.
- **Code rollback:** safe; older code never writes the log. Grading keeps working; attempts simply
  stop being logged.
- **Inert:** recording is not profiling and has no switch; the profiling built on it is switched by
  consent (rule 3).
- **Data:** kept; erased per subject only by privacy deletion.
- **Forward fix:** a wrong row is never corrected in place; a fix changes the writer, and the
  projection is rebuilt (`$F engine:rebuild-skill-state`).
- **Check:** `SELECT count(*) FROM learning_attempt_events;` and
  `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'learning_%append_only';`

## 0049 — misconception codes and teaching strategies (ENG-07)

- **Adds:** three governed-content tables, each tied to a `content_revisions` row;
  `content_revisions.entity_type` widened with `MISCONCEPTION`, `QUESTION_OPTION_MISCONCEPTION`,
  `TEACHING_STRATEGY`; the review-state mirror trigger `content_revisions_engine_state_mirror`.
- **Written by:** `misconceptions.ts` (drafts), `db:import:teaching-strategies-draft`, the aptitude
  bank import and the question bank editor (option tags). **Read by:** the projector (active codes),
  the planner and learning step (published strategies only), the faculty cohort.
- **Code rollback:** safe; the mirror trigger only follows state changes of the three new entity
  types.
- **Inert:** only `PUBLISHED` rows reach a student. A published row is immutable; the lifecycle
  allows `PUBLISHED → ARCHIVED`, but **no route archives engine content** (gap 1) — until one exists,
  archiving is a reviewed database step by Divakar.
- **Data:** kept; nothing is deleted.
- **Forward fix:** a new revision through draft → review (a different person) → publish.
- **Check:** `SELECT review_state, count(*) FROM teaching_strategies GROUP BY 1;`

## 0050 — evidence stages, assisted flag, required evidence types (ENG-04)

- **Adds:** `evidence_records.assisted` (default `false`), `evidence_records.stage_at_capture`
  (default `ESTIMATED`, CHECK `evidence_stage_at_capture_ck`),
  `career_role_requirements.required_evidence_types` (default `{}`). No back-fill; `evidence_records`
  stays immutable.
- **Written by:** evidence writers at insert (`career-readiness.ts`, `exam-evidence-bridge.ts`, via
  `skillStageAtCapture`); requirement sets (`career-catalogue.ts`). **Read by:** the evidence row is
  its own record of what was true at capture; `required_evidence_types` is maintained with the
  requirement sets in `career-catalogue.ts`.
- **Code rollback:** safe; older inserts omit the columns and get the conservative defaults.
- **Inert:** nothing to switch; the columns describe rows at capture and never change.
- **Data:** kept; the columns cannot be updated (0004 immutability trigger).
- **Forward fix:** a new migration may add a column or widen the CHECK; never back-fill
  `stage_at_capture` (it records what was true at the time).
- **Check:** `SELECT stage_at_capture, assisted, count(*) FROM evidence_records GROUP BY 1,2;`

## 0052 — learner skill state (ENG-05, ENG-07 link)

- **Adds:** `learner_skill_state` (projection; `learner_skill_state_projector_only` lets only the
  projector write, and privacy deletion delete), CHECKs including `learner_skill_state_sufficiency_ck`
  (fewer than two attempt days is always `NOT_ENOUGH_EVIDENCE`); two columns on
  `learning_attempt_events` (`selected_option_id`, `misconception_code_ids`, constant defaults).
- **Written by:** the projector only (worker consumer `learner-skill-state-projector`, and
  `engine:rebuild-skill-state`); cleared for a subject on `adaptive-learning` withdrawal. **Read by:**
  the planner, the learning path, due reviews, the faculty cohort, the BKT shadow report.
- **Code rollback:** safe; the table is left as it is.
- **Inert:** consent (rule 3) — retire the live `adaptive-learning` definition, then
  `$F engine:rebuild-skill-state`: every row is deleted (`"deleted"` in the output) because no one
  holds the purpose. Attempts are untouched.
- **Data:** a projection — it is always rebuildable from 0047's facts, so deleting it loses nothing.
- **Forward fix:** fix the projector (a new algorithm id), then rebuild. Never edit a row.
- **Check:** `$F engine:rebuild-skill-state` → `{"event":"learner_skill_state.rebuilt",...}`.

## 0053 — learning decisions (ENG-08)

- **Adds:** `learning_decisions` (append-only: only `outcome_attempt_ids` may grow; trigger
  `learning_decisions_append_only`), with inputs, their hash, policy version, action, reasons.
- **Written by:** `planNextLearningStep` (`POST /api/v1/learning/next-step`). **Read by:** the
  learning path and step, the faculty plan view, `engine:replay-decisions`.
- **Code rollback:** safe; older code never plans.
- **Inert:** without `adaptive-learning` the planner still runs, non-adaptively (reason
  `NON_ADAPTIVE_NO_CONSENT`); it makes no profile. Stopping planning entirely is a code rollback.
- **Data:** kept; erased per subject only by privacy deletion.
- **Forward fix:** a new policy version; old rows keep replaying under their own `policy_version`.
- **Check:** `$F engine:replay-decisions` → exit 0 with `matched = checked`.

## 0056 — agent-drafted career targets (ENG-11)

- **Adds:** provenance columns on `career_requirement_sets` and `taxonomy_nodes`
  (`source` default `AUTHORED`, `generator_version`, `prompt_version`, `generated_at`, `source_basis`)
  and guards: `career_requirement_set_provenance_guard`, `career_requirement_set_live_topic_guard`,
  `career_role_requirement_live_topic_guard`, `taxonomy_node_draft_guard`.
- **Written by:** `db:import:career-target-draft` (DRAFT only). **Read by:** the catalogue and the
  requirement-set publish flow (OPS-08).
- **Code rollback:** safe; existing rows read `AUTHORED`. The guards stay: nothing can go live on a
  topic that is not live, and provenance cannot be rewritten.
- **Inert:** the drafts are `DRAFT` and pending topics are inactive; nothing reaches a student until
  a person publishes the set through OPS-08 (dual control, `CAREER_REQUIREMENT_SET_PUBLISH`).
- **Data:** kept.
- **Forward fix:** a new requirement-set version through OPS-08.
- **Check:** `SELECT source, state, count(*) FROM career_requirement_sets GROUP BY 1,2;`

## 0061 — question bank editor and hint ladders (OPS-09b; engine-adjacent)

- **Adds:** `question_hint_ladders` (one per question revision, reviewed with it;
  `question_hint_ladders_guard`), `question_versions.superseded_at`, the author-never-publishes guard
  `content_review_author_publish_guard`, and the approval key `CONTENT_QUESTION_PUBLISH`.
- **Written by:** the question bank editor. **Read by:** the learning step (hints; a hint at level 3+
  makes an answer assisted).
- **Code rollback:** safe; the guards stay (a question's author still cannot publish it).
- **Inert:** a question with no published ladder serves `NO_HINTS`; there is no ladder switch.
- **Data:** kept; ladders of published revisions are immutable.
- **Forward fix:** a new question version with a new ladder, published with approval.
- **Check:** `SELECT count(*) FROM question_hint_ladders;`

## 0062 — item calibrations (ENG-13)

- **Adds:** `item_calibration_runs`, `item_calibrations` (append-only; `item_calibrations_threshold`
  refuses `CALIBRATED` below the run's minimum responses).
- **Written by:** `engine:calibration-import` only. **Read by:** the placement test (latest
  `CALIBRATED` preferred over newer `PROVISIONAL`).
- **Code rollback:** safe.
- **Inert:** `systemctl disable --now planthepath-calibration.timer` (not installed yet); the
  placement test keeps using the last imported calibrations. An item with no calibration row is left
  out of the placement pool, never given invented parameters.
- **Data:** kept; runs are never rewritten.
- **Forward fix:** a new run (`deploy/scripts/run-calibration.sh`); a bad run is superseded, not
  deleted.
- **Check:** `$F engine:calibration-export --out <file>` prints counts only
  (`{"event":"engine.calibration.exported",...}`); delete the file after.

## 0064 — placement tests (ENG-14)

- **Adds:** `placement_tests`, `placement_test_items` (append-only), and widens the session/attempt
  source vocabularies with `placement_test` and the session mode with `DIAGNOSTIC`.
- **Written by:** `POST /api/v1/learning/placement-test` and `…/<id>/answers`. **Read by:** the
  learning path.
- **Code rollback:** safe; the widened CHECKs still admit every older value.
- **Inert:** no switch; a code rollback removes the route. Sittings already taken stay.
- **Data:** kept; erased per subject only by privacy deletion.
- **Forward fix:** a new algorithm id (`placement_tests_algorithm_ck` would be widened by a new
  migration).
- **Check:** `SELECT state, count(*) FROM placement_tests GROUP BY 1;`

## 0065 — lesson and variant editor (OPS-09c; engine-adjacent)

- **Adds:** `lesson_versions.superseded_at` and `lesson_versions_supersede_guard`, a redefinition of
  `content_review_author_publish_guard`, the approval key `CONTENT_LESSON_PUBLISH`.
- **Written by:** the lesson editor. **Read by:** the catalogue (current versions only) and the
  learning step's lessons.
- **Code rollback:** safe for reads; the guards stay.
- **Inert:** unpublished variants never reach students.
- **Data:** kept.
- **Forward fix:** a new lesson version, published with approval.
- **Check:** `SELECT count(*) FILTER (WHERE superseded_at IS NULL) FROM lesson_versions;`

## 0066 — external review assignments (OPS-10; not an engine table)

Content-review governance: faculty reviewer assignments, advisory only. **Inert:** revoke the
assignment (`ASSIGNED → REVOKED`) or the reviewer's `CONTENT_REVIEW_EXTERNAL` grant (OPS-10); an
assignment also lapses with its 1–30 day window or the grant. Approving and publishing stay with
internal `CONTENT_REVIEW` and `CONTENT_PUBLISH` holders.
**Code rollback:** safe. **Data:** kept (`external_review_assignment_no_delete`).

## 0068 — learner goals (ENG-19)

- **Adds:** `learner_goals`, `career_catalogue_goals`, the trigger
  `student_career_targets_goal_sync` (a role goal mirrors `student_career_targets`), guards, and a
  one-time insert of a ROLE goal for every live career target that existed before 0068.
- **Written by:** the goals routes (`learner-goals.controller.ts`) and the sync trigger. **Read by:**
  the goals screen, career discovery, the planner's gap input.
- **Code rollback:** safe. **The sync trigger stays:** older code that sets a career target still
  creates the matching ROLE goal, which keeps the two tables consistent.
- **Inert:** goals do not profile; career discovery reads attempt history only under
  `adaptive-learning` (fail closed) and works without it.
- **Data:** kept; goals end (`ACHIEVED`/`WITHDRAWN`), never rewritten; erased per subject by privacy
  deletion.
- **Forward fix:** a new migration; never edit goals in place.
- **Check:** `SELECT goal_type, status, count(*) FROM learner_goals GROUP BY 1,2;`

## 0072 — learning step items (ENG-18)

- **Adds:** `learning_step_items` (the questions served for a decision and the highest hint level
  the **server** released, so "assisted" cannot be forged by a client); widens session/attempt
  sources with `learning_step`.
- **Written by:** the learning step routes (`…/steps/<id>/hints`, `…/answers`). **Read by:** the same.
- **Code rollback:** safe.
- **Inert:** no switch; a code rollback removes the Learning page's practice.
- **Data:** kept; erased per subject by privacy deletion.
- **Forward fix:** a new migration.
- **Check:** `SELECT count(*) FROM learning_step_items;`

## 0082 — faculty learning actions (INST-16; engine-adjacent)

- **Adds:** `learning_assignments`, `learning_assignment_students`, `learning_plan_overrides`,
  `staff_action_attendees`, `staff_action_content_links` and their guards (only published, current
  content can be assigned).
- **Written by:** the institution learning-action routes. **Read by:** the planner as constraints
  (an override decides one step and is linked to that decision), and the student's
  `GET /api/v1/students/me/learning-actions`.
- **Code rollback:** safe; the planner of the previous release ignores the constraints.
- **Inert:** withdraw an assignment (`POST /api/v1/institutions/<id>/learning-assignments/<id>/withdraw`)
  or an override (`…/plan-overrides/<id>/withdraw`); a faculty action never writes mastery,
  evidence or readiness.
- **Data:** kept; overrides erased per student by privacy deletion.
- **Forward fix:** a new migration.
- **Check:** `SELECT count(*) FROM learning_plan_overrides;`

## Gaps

1. **No route to archive published engine content** (misconception codes, teaching strategies,
   option tags): the lifecycle allows `PUBLISHED → ARCHIVED`, but `transitionEngineContent` has no
   caller in the API.
2. **No operator switch for the engine as a whole** other than consent-definition retirement, which
   needs a database session or a migration.
3. **Code-rollback compatibility is by inspection only**: there is no CI job that runs the previous
   release against the current schema.

## Verified locally

On a local, fresh `one_eng17` (Docker `planthepath-postgres-dev`; never staging or production):

RESULTS_MIGRATIONS
