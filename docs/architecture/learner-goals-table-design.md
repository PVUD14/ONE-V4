# Learner Goals and Onboarding — Table Design

**Status:** Adopted (ENG-19), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0068_learner_goals.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md` and D.2 of the program
**Builds on:** `career-catalogue-table-design.md` (OPS-08: `career_roles`, synonyms, the
`career-catalogue.selectable-roles` flag), 0011 (`student_career_targets`, career gaps),
`learning-decisions-table-design.md` (ENG-08 planner input), `engine-consent-purposes-design.md` (ENG-01),
`placement-tests-table-design.md` (ENG-14), ADR-020 (readiness is a band), ADR-035 (migrations apply once)

## Why this exists

A student today can hold one career target (0011) and nothing else. People come to ONE with other aims too:
"teach me SQL", "clear the bank exams", "get through IT-services recruitment tests", or "I don't know yet".
Appendix 4 §G lists thirteen goals that are not job roles, and the catalogue seed (OPS-08) transcribed them
but stored none, because no goal model existed: "Goals are recorded but not stored until the engine plan's goal
model exists." This is that model, and the first-run question that fills it: **"What job do you want?"**

A goal is consequential. It decides which gaps a student is shown, what the planner (ENG-08) works on, and
what demand the catalogue promotion rule counts (200 students / 3 colleges). So the rules below are enforced by
the database, not only the API.

**ONE serves people who already left college.** Nothing here reads an enrolment: `institution_id` is recorded
where the student is actively rostered and is NULL otherwise; the survey asks the branch rather than reading
it from a roster; every route works for an independent graduate.

## Decision: one `learner_goals` table; role goals stay in `student_career_targets`

**Chosen.** `learner_goals` holds every goal of every type. A **ROLE** goal does not re-store the role: it points
at the `student_career_targets` row (0011) that already drives the gap engine, the planner and role demand.
The database keeps the two in step with triggers on `student_career_targets`:

- a target inserted ⇒ its ROLE goal is inserted, with the same priority;
- a target cleared ⇒ its ROLE goal ends (`WITHDRAWN`, `ended_at` = the target's `cleared_at`);
- a ROLE goal cannot be inserted any other way (a BEFORE INSERT guard refuses a ROLE row unless it comes from
  the sync trigger, `pg_trigger_depth() > 1`).

So the existing career-target routes, the gap engine (`career-gap-v1`), role demand (OPS-11) and the planner's
"PRIMARY live target" read are untouched and cannot drift from the goals view. Live targets that exist before
0068 get their ROLE goal backfilled by the migration (from their own rows; nothing invented).

**Rejected: moving roles into `learner_goals` and retiring `student_career_targets`.** Five readers (gaps,
planner, role demand, catalogue counts, Android) would move at once for no student benefit, and the goal text
says role goals keep using `student_career_targets`.

**Rejected: no ROLE rows at all (roles read from targets, other goals from the table).** Every goals read would
be a union with two status vocabularies, and "one primary goal" would be a rule split across two tables.

**Rejected: syncing in application code only.** `career-targets.ts` is the only writer today, but a trigger
keeps the invariant for any future writer, and costs nothing on read.

### `learner_goals`

| Column | Notes |
| --- | --- |
| `id` | uuid PK |
| `student_user_id` | uuid NOT NULL → `users(id)` |
| `institution_id` | uuid NULL → `organizations(id)` — the institution the student is actively rostered at when the goal is set (D.1 data rule), set in SQL; NULL for an independent learner or a graduate. Never required. |
| `goal_type` | `ROLE`, `TOPIC`, `EXAM`, `COMPANY`, `DISCOVERY` |
| `career_target_id` | uuid NULL → `student_career_targets(id)`; set **exactly** for ROLE |
| `topic_id` | uuid NULL → `taxonomy_nodes(id)`; set exactly for TOPIC |
| `catalogue_goal_code` | text NULL → `career_catalogue_goals(code)`; set exactly for EXAM and COMPANY. A DISCOVERY goal *is* G13 by type and carries no reference, so "Not sure yet" works whether or not the catalogue has been seeded |
| `priority` | `PRIMARY` or `SECONDARY`; **PRIMARY only for ROLE** (CHECK) |
| `status` | `ACTIVE`, `ACHIEVED`, `WITHDRAWN` |
| `origin` | `ONBOARDING`, `GOALS`, `DISCOVERY_SUGGESTION`, `CAREER_TARGET` (a target set through the existing career-target routes) |
| `discovery_interests` | text[] NULL — DISCOVERY only: 1–3 interest codes from the survey vocabulary (CHECK) |
| `discovery_strengths` | text[] NULL — DISCOVERY only: 0–3 strength codes (CHECK) |
| `discovery_branch` | text NULL — DISCOVERY only: the branch as the student chose it from the catalogue's branch list, or `NOT_LISTED`; 1–60 chars |
| `created_at` | timestamptz NOT NULL DEFAULT now() |
| `ended_at` | timestamptz NULL; NULL exactly while `ACTIVE`, `>= created_at` |

Indexes (partial, live rows = `status = 'ACTIVE'`):

- one live PRIMARY per student — **one primary role goal**;
- one goal per `career_target_id`; one live goal per `(student, topic_id)` and per `(student, catalogue_goal_code)` —
  no duplicate goals; one live DISCOVERY goal per student;
- `(student_user_id, created_at DESC)` for the goals read; `(institution_id, created_at)` for scoped reads later.

Any number of TOPIC, EXAM and COMPANY goals may be live beside the primary role goal ("one primary role goal plus
any number of topic goals"). SECONDARY role goals are the existing SECONDARY targets.

**Transitions.** Only `ACTIVE → ACHIEVED | WITHDRAWN`, once; an ended goal is never reopened (setting the same
goal again makes a new row, so history stays readable). A trigger refuses any other UPDATE and every DELETE
except the privacy-deletion transaction for the same subject (`one.privacy_erase_subject`, as 0047/0052/0053).
A ROLE goal ends only through its target (the sync trigger); the student ends it by clearing the target.
When a PRIMARY target is inserted, a live DISCOVERY goal ends as `ACHIEVED` (the student is no longer "not sure").

### `career_catalogue_goals`

The thirteen Appendix 4 §G rows, stored at last, by a new idempotent `seedCareerCatalogueGoals` beside the role seed
(`db:seed:career-catalogue` runs both; `seedCareerCatalogue` itself is unchanged).

| Column | Notes |
| --- | --- |
| `code` | text PK, `^G[0-9]{2}$` |
| `title`, `source_goal_type`, `links_to_roles`, `main_evidence`, `release` | the source cells, verbatim, length-checked |
| `learner_goal_type` | `EXAM`, `COMPANY`, `TOPIC`, `DISCOVERY` or NULL (not a V1 goal type) |
| `selectable` | boolean — whether a student can hold it as an EXAM or COMPANY goal |
| `catalogue_version`, `updated_at` | which file wrote it |

Mapping (decided; source wording kept in `source_goal_type`):

| Source type | Goals | `learner_goal_type` | Selectable |
| --- | --- | --- | --- |
| Exam | G01–G05 | EXAM | yes |
| Certification | G09 | EXAM (a certification is sat as an exam) | yes |
| Company preparation | G06, G07 | COMPANY | yes |
| Company preparation | G08 "Employer-defined drive preparation" | COMPANY | **no** — its target is "the employer's own career target"; nothing a student could name exists until an employer drive links one |
| Topic | G11 "Any single topic" | TOPIC | no — a topic goal names a real topic (`topic_id`), not G11 |
| Topic | G10 "Communication and interview skills" | TOPIC | no — no single topic node is that goal; a student picks the published topics instead |
| Explore | G12 | NULL | no — "Explore" is not a V1 goal type |
| Career discovery | G13 "Not sure yet" | DISCOVERY | no — held as a DISCOVERY goal through the survey, without a reference |

EXAM and COMPANY goals are catalogue content that has no track yet, exactly like the 103 catalogue roles, so they
are offered to a student **only while `career-catalogue.selectable-roles` is on for them** (the OPS-08 rule), always
labelled "Not yet verified". With the flag off (the default), onboarding offers the starter roles, published topics
and "Not sure yet". The server checks the same rule on write.

## Onboarding

There is no onboarding state column: a student with **no live goal** is onboarding. The first-run question lives
in the existing **My Career** screen on web and the existing **Career target** screen on Android (no navigation
item is added, removed, renamed or reordered — HG-3):

1. **"What job do you want?"** — search over the roles offered to this student by title, catalogue title and live
   synonyms (`career_role_synonyms.normalized`); picking one sets the PRIMARY target (origin `ONBOARDING`).
2. **"Not sure yet"** — a short survey, then 3–5 suggested roles, each with the reasons it was suggested. Picking
   one sets the PRIMARY target (origin `DISCOVERY_SUGGESTION`) and ends the DISCOVERY goal as ACHIEVED.
3. Afterwards, any number of **topic goals** (published topics only: active `TOPIC` taxonomy nodes, latest version)
   and, where the catalogue is open, EXAM / COMPANY goals.

## "Not sure yet": `career-discovery-v1` (pure, `packages/career-readiness`)

**Survey** (the vocabulary is the product's own copy, versioned with the algorithm):

- *What kind of work interests you?* — 1 to 3 of: building software (catalogue codes `S`), finding answers in data
  (`D`), protecting systems (`C`), electronics, circuits and power (`E`, `L`), machines, manufacturing and plants
  (`M`, `P`), buildings and infrastructure (`V`), business, customers and operations (`B`).
- *What are you good at?* — 0 to 3 of: numbers, programming, communication, problem solving, hands-on / design work.
  Each maps to a fixed keyword list matched against the role's own catalogue text (`core_skill_areas`,
  `main_evidence`, `summary`).
- *Which branch or degree did you study?* — the catalogue's own branch list (`listCatalogueBranches`) or "Not listed".

**Signals per offered role** (only roles this student could select — the flag rule — so a suggestion is always
selectable): interest match on the catalogue code prefix; strength keyword matches in the role's text; branch
eligibility (named branch, or "All branches"/"Any"); and, **only with adaptive-learning consent**, skills the
student has shown (`learner_skill_state` band PROGRESSING or DEMONSTRATED — where placement results land, ENG-14)
that the role's live requirements include. A role is suggested only with at least one interest or strength match;
if fewer than three do, the list is filled with roles open to the student's branch, in plan order (planned release
V1, V2, V3, then selectable; then code), each saying so. The result is at most 5, at least 3 when at least 3 roles
are offered, and fewer — said plainly — when the catalogue offers fewer. Scores are internal ordering only and are
never returned; the student sees reasons (`INTEREST_MATCH`, `STRENGTH_MATCH`, `BRANCH_MATCH`, `SHOWN_SKILLS`,
`OPEN_TO_YOUR_BRANCH`). Deterministic for identical inputs; ties by catalogue code, then id.

**Real catalogue data only.** Every suggestion is a `career_roles` row offered to the student; every reason cites
catalogue fields or the student's own answers. An empty catalogue gives no suggestions and an explicit empty state.

**Consent.** Goals and the survey are the student's own statements, like the 0011 target, and need no engine
purpose. Using attempt history to suggest roles *is* personalisation, so it needs `adaptive-learning`
(`hasConsentPurpose`, fail closed — today it is unpublished, HG-6, so no one's history is used). The response says
whether history was used. Onboarding works end to end without the purpose.

## Shared skills count once: `learner-goal-skills-v1`

`mergeGoalSkills` (pure) takes each live goal's skills — a ROLE goal's live requirements (`career_role_requirements`,
the same rows the gap engine reads), a TOPIC goal's topic — and returns each skill **once**, with every goal that
needs it and, per role goal, that role's gap status for the skill. Evidence is recorded per topic
(`evidence_records.topic_id`) and every role's gap is computed from the same evidence, so **a topic goal's evidence
counts toward every role needing that skill** by construction; the goals read shows it, and a test pins it.
EXAM, COMPANY and DISCOVERY goals contribute no skills until their tracks exist (said plainly, never invented).

## Planner (ENG-08)

Unchanged. `learning-orchestrator-v1` reads the PRIMARY live target's gap, and the primary role goal *is* that
target, so the planner already plans the primary role goal. Feeding topic goals into the plan changes the planner's
inputs, which is a new policy version (`learning-orchestrator-v2`), and ENG-18 owns the screen that would show it;
`mergeGoalSkills` is the input it will use.

## Readiness

Nothing here reads or writes `readiness_snapshots` or produces a number about a student. The goals read carries
gap statuses (MET / PARTIAL / MISSING / UNKNOWN) and counts of requirements, never a score. Discovery scores are
never returned.

## Privacy deletion

Goals, including survey answers, are about the person: the `STUDENT_PROFILE` step erases them (inside the
transaction that sets `one.privacy_erase_subject`, so the append-only guard permits it). The career targets they
point at are handled as today.

## Migration

`0068_learner_goals.sql`: `CREATE TABLE IF NOT EXISTS`; CHECKs dropped `IF EXISTS` and re-added; `CREATE OR REPLACE
FUNCTION`; `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`; indexes `IF NOT EXISTS`; the backfill is
`INSERT … WHERE NOT EXISTS` and runs before the guard trigger is recreated. References only tables created before
it (`users`, `organizations`, `taxonomy_nodes`, `student_career_targets`, `institution_student_profiles`).

## Open points (decisions for Divakar)

1. **EXAM/COMPANY goals behind the catalogue flag** (recommended) vs always offered with "Not yet verified".
2. **G08, G10, G12 not selectable in V1** (recommended; reasons above).
3. **Certification (G09) as EXAM** (recommended) vs a sixth goal type.
4. **Discovery uses attempt history only with adaptive-learning consent** (recommended; the fail-closed rule).
5. **Topic goals enter the planner in a v2 policy under ENG-18** (recommended) vs changing v1's inputs now.
