# Tutor Rollout — Per-College Enablement, Tutor / No-Tutor Groups and Pilot Metrics (ENG-25)

**Status:** Adopted (ENG-25). Recommended options taken per CLAUDE.md ("ask once, recommend, carry on");
every decision records what was rejected. The decision that is a real architectural choice is ADR-051.
**Date:** 2026-10-10
**Migration:** `0116_tutor_rollout.sql` (0111 and 0112 are claimed by other branches; 0113–0115 are used)
**Rule:** Written before the migration, per the migrations rule in CLAUDE.md. Two of the three tables
decide which real students may be shown model output, and record a randomisation a person's learning
record depends on — tables with consequences.

## Why this exists

ENG-22 built the tutor and kept it to the demo sandbox (`ONE_AI_TUTOR_AUDIENCE=sandbox`). The plan's
ENG-25: "Per-college enablement through OPS-12, tutor and no-tutor groups assigned at random within
consenting students, metrics recorded for the pilot evaluation. Acceptance: group assignment is
reproducible and recorded; AI-off students complete every journey (X2)." X2 in the plan: "with every
AI flag off, the student, faculty and TPO journeys still complete."

The pilot question (ENG-28, `docs/uat/ONE_PILOT_EVALUATION_TEMPLATE.md`, Measure 1) is whether students
who used the tutor learned more than comparable students who did not. Without a recorded random split
the answer cannot be separated from the college, the season or self-selection. So ENG-25 is three
things: a per-college switch, a reproducible random split of the consenting students of a switched-on
college, and counts per group.

## What already existed (and is reused unchanged)

| Piece | Where | Used as |
|---|---|---|
| `tutor.hint` feature switch, cap, kill switch | 0033, 0089 (OPS-12) | Still required: a college switch never overrides them |
| Evaluation gate (`ai_evaluation_passes`) | 0089 | Repeated for a college: a college is switched on only with a PASS for the served model and prompt |
| OPS-02 dual control | 0038 / 0051 / `operation-approvals.ts` | A new extended action, `AI_TUTOR_COLLEGE_ENABLE` |
| `ai-tutoring` consent purpose | ENG-01 `consent-purposes.ts` | Required to enter either group; read on every request |
| The tutor policy and job | `packages/tutoring`, `tutor-hints.ts`, `tutor-hint-worker.ts` (ENG-22) | Gains the pilot audience; the worker re-checks it |
| Small-group suppression (5) | `aggregateSuppressionThreshold` | Every per-group figure on the console |

**What stays blocked, on purpose.** `ai-tutoring` has no published definition for real students until
HG-6 approves its wording (`docs/legal/engine-consent-notice-DRAFT-for-legal-review.md`). This step builds
against the existing purpose key `ai-tutoring`; with no live definition, no real student holds it, so no
one can be assigned and the tutor stays off for everyone. ENG-21's `tutor.hint` evaluation has passed
its automatic checks but its human review is pending, so no PASS record exists: neither the feature nor
any college can be switched on. Both gates are left exactly as they are.

## Decision 1 — The deployment audience gains `pilot`

`ONE_AI_TUTOR_AUDIENCE` today is `sandbox` or unset. ENG-25 adds `pilot`. In order, the tutor serves a
student only when:

1. the question is practice (not a placement test, readiness check or exam) — unchanged;
2. the deployment's audience is `sandbox` (ENG-22's lock) or `pilot`, the `tutor.hint` feature is on and
   the kill switch is released — unchanged, plus the new value;
3. **(pilot)** the student's college — the `institution_id` the step's decision recorded — has the tutor
   switched on (`tutor_college_rollouts.enabled`);
4. the student holds `ai-tutoring` — unchanged;
5. **(pilot)** the student's recorded group in that college is `TUTOR`;
6. language, ladder, level, pending and the per-student daily cap — unchanged.

The API checks this on every step read and every request; the outbox worker re-checks 2–5 before any
model call (a college switched off, or a withdrawn consent, between request and job closes the request
as `AI_UNAVAILABLE` without a call).

**The sandbox keeps ENG-22's behaviour** (steps 3 and 5 do not apply there). The sandbox is fictional
people on a demo site; a split would hide the tutor from half of the presenter's accounts and measures
nothing. Its own lock — `ONE_SANDBOX=true`, not production, a `_sandbox` database — is unchanged. *Rejected:
the college gate in the sandbox too* — it adds a dual-control approval to every demo reset and protects
no one.

*Rejected: no environment audience at all, only the database switches.* The variable is a second key on
a different door: a deployment that has not been told it serves the pilot (staging, a developer's
machine pointed at a copy) never serves the tutor, whatever its database says.

## Decision 2 — Per-college enablement: one row per college, switched on by dual control

`tutor_college_rollouts` has one row per college that has ever had the tutor switched on. The row is
created by the first switch-on and never deleted; later switch-ons and switch-offs update `enabled`.

**Switching a college on** is an OPS-02 high-risk action, `AI_TUTOR_COLLEGE_ENABLE` (capability
`AI_OPS_CONFIGURE`, a second person approves). The approval is bound to the college, the feature, and
the model, prompt and PASS evaluation current when it was requested — the same binding
`AI_FEATURE_ENABLE` uses, so a later FAIL or a model change breaks it. Requesting and executing both
refuse while the kill switch is engaged, while `tutor.hint` declares no prompt, or while no passing
evaluation exists for its current model and prompt. The global feature need **not** be on: colleges can
be prepared before the feature is switched on, and nothing reaches a student until both are.

The 0116 trigger repeats these rules for any writer: a row is born enabled, and any switch to enabled
needs a kill switch released, a passing evaluation for the policy's current model and prompt (the
`enabled_*` columns must name them), the college to be an `INSTITUTION`, and an `EXECUTED`
`AI_TUTOR_COLLEGE_ENABLE` approval for this college that no earlier switch-on used.

**Switching a college off** is immediate, needs only a reason, and is open to anyone who may stop AI
(`canStopAi`). Its students see no tutor on their next read; a pending request is closed by the worker.

*Rejected: a generic per-college switch for every AI feature.* Only the tutor reaches students today;
the content factory and the assistant do not run per student of a college. The day a second feature
needs it, the shape here is the one to copy, with its own evaluation.

*Rejected: reusing `AI_FEATURE_ENABLE` with a college in the payload.* That action's target is the
feature policy, and its approvals list, audit and executing endpoint would all have to learn a second
meaning. A separate action is one more case in each place, and each reads plainly.

**The cap.** `tutor.hint` keeps its own global cap (500 a day, OPS-12) and the per-student daily cap of 20
(ENG-22). A per-college cap is not added in this step (open point 2).

## Decision 3 — Group assignment: a recorded seed, a keyed hash, a recorded row (ADR-051)

When a college is first switched on, its row records an **experiment**: the row's own `id` (the
experiment id), `assignment_method = 'sha256-bucket-v1'`, a 128-bit random `assignment_seed` generated by
the server, and `tutor_share_basis_points = 5000` (an even split). None of these ever change.

A student's group is

    bucket = uint32_be( sha256( seed ":" experiment_id ":" student_id )[0..4] ) mod 10000
    group  = TUTOR    if bucket < tutor_share_basis_points
             NO_TUTOR otherwise

with the UUIDs in lower-case text. It depends on nothing else — not the time, not the order students
arrive, not which server computed it — so anyone with the experiment row and a student's id gets the same
group, and the database recomputes it: the 0116 insert trigger refuses a row whose bucket or group is not
what the formula gives. A test proves the TypeScript and the SQL agree.

**The assignment is recorded** in `tutor_group_assignments` (one row per experiment and student, unique)
the first time the student is *eligible*: their college has the tutor switched on and they hold
`ai-tutoring`. "First time" is the first step read or tutor request after that is true. The row records
the group, the bucket, the method, the consent version they held, and when. It is immutable (the trigger
refuses an update) and removed only by the student's privacy deletion.

Only consenting students are assigned: the trigger checks that the student's latest `ai-tutoring` action is
a GRANT of the live definition's version (the ENG-01 rule, `consentPurposeHeldSql`) and that the student is
a current student of the college. A student who never consents is in neither group and is not counted.

*Rejected: `Math.random()` at assignment time, recorded.* Recorded, but not reproducible: an audit could
not show the split was not chosen. *Rejected: blocked randomisation (alternate students as they arrive).*
Balanced by construction, but the group then depends on arrival order — a re-run, or a student arriving
during a deployment, could change it; and it is predictable by students who compare notes. *Rejected:
hashing the student id without a seed.* Reproducible, but the same student lands in the same group in
every college and every later experiment; a per-experiment seed makes experiments independent.
*Rejected: assigning every consenting student at switch-on, in bulk.* Students who consent later still
need assigning, so the lazy path is needed anyway, and a bulk job would assign students who never open
practice.

**Balance.** Hashing gives a fair coin per student, not an exact half. On 2,000 synthetic students the test
requires each group's share within 0.45–0.55 and runs a chi-square test on 10 bucket deciles; with real
colleges of a few hundred consenting students, the expected imbalance is a few percentage points, which
the evaluation reports as it is.

## Decision 4 — Withdrawing consent, re-consenting, moving college, joining late

- **Withdrawing `ai-tutoring`:** the tutor stops on the next read (consent is read every time) and the
  worker closes a pending request without a call. The assignment row **stays**: it is the record that the
  randomisation happened, and the consent log already records when they withdrew. No pilot metric is
  counted for them while they do not hold the consent.
- **Re-consenting:** the same row applies, so the same group — a student cannot re-roll their group.
- **Joining later** (a new student, or a student who consents weeks in): assigned on their first eligible
  read, by the same formula. Arrival time never affects the group.
- **Moving college:** a new college is a new experiment (its own row, its own seed); the student is
  assigned there independently when eligible there. The old row stays with the old experiment.
- **A college switched off and on again:** the same experiment, seed and rows; nobody is reassigned.
- **Privacy deletion:** the student's assignment rows are deleted with their learning records (the 0072
  pattern, `one.privacy_erase_subject`). Counts already added to the daily metrics stay: they carry no
  identifier and cannot be attributed (Decision 5).
- **College exit purge (INST-18):** assignments are the student's own learning record and are kept with
  it; the rollout row is AI8HT's operations record. Both are listed in `institutionPurgeOutOfScope`.

## Decision 5 — Pilot metrics: counts per experiment, group and day

`tutor_pilot_daily_metrics` holds one counter per (experiment, group, day, metric):

| Metric | Counted when |
|---|---|
| `STEPS_STARTED` | a learning step starts with a practice question |
| `QUESTIONS_ANSWERED` / `QUESTIONS_CORRECT` / `ANSWERS_ASSISTED` | a practice answer is recorded (assisted: after hint 3 or 4, 0047) |
| `STEPS_COMPLETED` | the answer that finishes a step's practice |
| `WRITTEN_HINTS_SHOWN` | "Show hint" releases a level |
| `TUTOR_HINTS_REQUESTED` | an AI hint is requested |
| `TUTOR_HINTS_SHOWN` / `TUTOR_HINTS_FALLBACK` | the job shows the AI hint / the written hint instead |

A counter is incremented in the same transaction as the act, only for a student who has an assignment in
an enabled experiment of the step's college and holds `ai-tutoring` now. The row has no student, no name,
no question and no readiness: there is **no readiness number anywhere in it** and none is derived from it.
The trigger lets a count only grow and refuses deletion.

These are the operational comparison — is the no-tutor group practising as much, are tutor hints
replacing written ones. The pilot's main outcome (learning gain on an unaided delayed test, ENG-28
Measure 1) is computed at the end, on production, by Divakar, from `tutor_group_assignments` joined to the
attempt and placement records that already exist; the template's placeholder view now reads this table.

The console shows, per college, the two groups' assigned counts and their last-30-days counters, with
any group of fewer than five assigned students shown as `<5` and its counters withheld.

*Rejected: one event row per student act.* It would duplicate `learning_attempt_events` with a group
label, add personal data, and need its own export and deletion. *Rejected: no counters, only the end
query.* The pilot needs to see during the term whether the comparison is still meaningful (for example,
whether tutor requests are being refused).

## Decision 6 — The no-tutor group's experience is identical except for the tutor

The step view the API returns is the same object for both groups. A student who is not offered the
tutor for a pilot reason (college off, no-tutor group) gets `tutor: {available: false, reason: 'OFF',
remainingToday: null}` — byte-for-byte what an AI-off student gets — so web and Android show no AI
control, no AI count, no empty widget and no hint that a group exists. The written hint ladder, the
lessons, the path, the next step and the answer feedback are unchanged. A request from such a student is
refused as `TUTOR_OFF`, as for any AI-off student. The refusal reasons the policy uses internally
(`COLLEGE_OFF`, `NO_TUTOR_GROUP`) never leave the server.

## Decision 7 — X2: AI-off students complete every journey

The acceptance is proven by tests, not by assertion:

- `apps/api/src/http/tutor-rollout.integration.spec.ts` walks a student of an enabled college who is in
  the no-tutor group, and a student whose college is off, through the whole practice journey (path, next
  step, written hints, every answer, step complete, next step) with the tutor switched on for others, and
  shows no tutor row, no tutor control and no model call.
- `apps/api/src/http/ai-off-journeys.integration.spec.ts` seeds the sandbox's sample college (ADR-046)
  with every AI flag off and walks the student journey (home, learning path, next step, practice to
  completion), the faculty journey (the lecturer's students, the learning cohort, a student's plan and a
  plan override with a reason) and the TPO journey (cohort readiness by role, campus drives, placement
  register).
- `apps/web/src/studentLearningTutor.test.tsx` walks the web practice screen to completion for a student
  whose tutor is `OFF`, asserting no AI control and no AI text appears.

## Tables

### `tutor_college_rollouts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | The experiment id |
| `institution_id` | uuid → organizations, unique | Must be an `INSTITUTION` |
| `feature_key` | text → ai_feature_policies, `= 'tutor.hint'` | |
| `enabled` | boolean | |
| `assignment_method` | `= 'sha256-bucket-v1'` | Immutable |
| `assignment_seed` | text, 32 hex | Immutable; generated by the server |
| `tutor_share_basis_points` | integer `= 5000` | Immutable |
| `created_at`, `created_by_user_id` | | Immutable |
| `enabled_model`, `enabled_prompt_key`, `enabled_prompt_version`, `enabled_evaluation_id`, `enabled_approval_id`, `enabled_at`, `enabled_by_user_id` | | Written only by a switch-on; the trigger checks them |
| `changed_at`, `changed_by_user_id`, `change_reason_code`, `correlation_id` | | The last change |

### `tutor_group_assignments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `rollout_id` | uuid → tutor_college_rollouts | The experiment |
| `institution_id` | uuid → organizations | Equals the experiment's college |
| `subject_user_id` | uuid → users | The student; unique per experiment |
| `assignment_method` | text | Equals the experiment's |
| `bucket` | integer 0–9999 | Recomputed by the trigger |
| `group_name` | `TUTOR` / `NO_TUTOR` | Recomputed by the trigger |
| `consent_version` | text | The `ai-tutoring` version held at assignment |
| `assigned_at` | timestamptz, database clock | |
| `correlation_id` | text | |

Immutable; deleted only by privacy deletion of the same subject.

### `tutor_pilot_daily_metrics`

| Column | Type | Notes |
|---|---|---|
| `rollout_id`, `group_name`, `metric_date`, `metric_key` | PK | `metric_date` is the database day |
| `count` | integer ≥ 0 | Only grows |
| `updated_at` | timestamptz | |

## Privacy, export, audit

- **Export:** the student's export lists their tutor group assignments (college, group, when, consent
  version) in the learning section. A student may know their group; the screen does not tell them, because
  telling would change behaviour, but nothing is hidden from their own export.
- **Deletion:** removed with the learning records. **Purge:** out of scope, with reasons (Decision 4).
- **Audit:** `operations.ai.tutor_college.enabled` / `.disabled` (actor, college, reason, approval,
  model, prompt, evaluation). Assignment rows are themselves the record of assignment and carry the request's
  correlation id; they are not duplicated into the audit log.

## How a college is switched on (for Divakar)

Nothing here can happen on production today; the steps are listed so the blockers are visible.

1. **HG-6:** the `ai-tutoring` wording is approved and its definition published (with the pilot sentence
   about random tutor / no-tutor groups that the ENG-28 template, Part F decision 4, asks legal to settle).
2. **ENG-21 human review:** the `tutor.hint` bake-off review sheet is completed and the PASS imported
   (`ai:bake-off-import`) for the served model and `tutor-hint@2`.
3. The production API and the outbox worker carry `ONE_AI_TUTOR_AUDIENCE=pilot` (and the worker the
   `ONE_AI_*` endpoint variables, ADR-047). Divakar's release, by hand.
4. In AI Operations: switch `tutor.hint` on (approval), then for each pilot college "Switch the tutor on
   for this college…" (approval), then execute both from Settings → Approvals.
5. Students who agree to `ai-tutoring` are assigned on their next practice; the "Tutor by college" panel
   shows the two groups filling.

## Open points

1. A dedicated tutor worker (ENG-22 open point 3) before more than one or two colleges run.
2. A per-college cap on tutor requests, if the global cap proves too coarse.
3. Retrieval (ENG-24) is not wired into the tutor here; `tutor-hint@3` is the seam.
