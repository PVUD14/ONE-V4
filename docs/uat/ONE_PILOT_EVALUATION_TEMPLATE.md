# ONE pilot evaluation report — template

> What this is: the report Divakar fills in at the end of the ONE pilot to answer one question —
> did ONE work? It has five measures (learning gain against a comparison group, weekly active
> learners, AI cost per student against ₹10, retention, and whether colleges intend to renew). For
> each one it says what is counted, which tables hold it, the exact query, and an empty slot for the
> result. Why it exists: ENG-28 (part of DOC-2) asks for it, and writing the measures down *before*
> the pilot starts stops anyone choosing the flattering measure afterwards.
>
> Written 2026-10-01 against `feat/plan-phases-0-to-2` at `719eb34`. **No pilot has run. Every result
> slot below is empty on purpose.** Nothing in this file is a pilot result, an estimate or an example
> figure. Every query was run once, on 2026-10-01, against an empty, freshly migrated local database
> (migrations up to 0098), to prove it runs against this schema. It has never been run on real data.

---

## How to use this template (for Divakar)

1. **Before the pilot starts**, fill in Part A (the pilot's facts) and settle the four decisions in
   Part F. Copy this file somewhere outside the repository and name the copy after the pilot, for
   example `ONE pilot evaluation — <college> — <term>.md`. The filled copy holds figures derived from
   production, so it stays out of Git (see "Ground rules").
2. **During the pilot**, nothing needs to be done here, except recording the renewal-intent answer
   (Measure 5) when you ask each college.
3. **At the end**, run each query in Part C on the production database yourself, using a read-only
   connection, and paste the output into the slots. The agent that maintains ONE is not allowed to
   connect to production or read its data (CLAUDE.md), so this step is yours, as with the ENG-26
   recalibration.
4. Write the conclusion in Part E in plain words. If a measure could not be taken, say so in its slot
   and why. **An empty slot is an honest answer; a guessed number is not.**

## Ground rules

- **No invented values.** A slot is filled only from a query result or a written record. If the
  query returns nothing, write "no data" and the reason.
- **Groups of fewer than five people are never reported.** Every query prints `<5` instead of a
  count below five, the same rule ONE applies on every screen (`aggregateSuppressionThreshold = 5`,
  `packages/authorization/src/aggregate-suppression.ts:24`). If a group is too small to compare, the
  comparison is not made.
- **Counts and shares of a group only — never a list of students**, never a name, never a per-student
  figure. Nothing in this report is shown to a student, a college or an employer as a figure about a
  person.
- **No readiness number.** Readiness is a band (ADR-020). None of these measures is readiness, and
  nothing here may be turned into a readiness score or shown beside one. The placement level used in
  Measure 1 is a band of its own (Aware / Guided / Independent / Troubleshoot) and stays a band.
- **The filled report stays out of the repository.** It is derived from production data. Keep it with
  your own documents; the repository keeps only this template.
- **Consent.** Measure 1 uses only students who hold the `adaptive-learning` consent purpose (the
  placement test and review schedule do not run without it). Whether the pilot evaluation itself needs
  a sentence in the student notice — "your college's results, without names, are used to check whether
  ONE works" — is a question for the legal review under HG-6 (see Part F, decision 4). Do not run the
  evaluation on students until that is answered.

---

## Part A — The pilot's facts (fill in before the pilot starts)

| Item | Value | Source |
|---|---|---|
| Pilot name | | |
| Colleges in the pilot (names) | | Operations → Organizations |
| Their organisation ids (for the queries) | | Operations → Organizations (internal; never shown to a college) |
| Pilot start date (first day students use ONE) | | Your record |
| Pilot end date | | Your record |
| Delayed-test date or rule (Part F, decision 2) | | Your decision |
| ONE version running in production at start (commit) | | Release record |
| ONE version running at end (commit) | | Release record |
| AI features switched on during the pilot (list, or "none") | | Operations → AI operations |
| Engine consent purposes published? (date, or "not published") | | HG-6 approval |
| Tutor / no-tutor groups assigned? (date each college's tutor was first switched on, or "no") | | `tutor_college_rollouts.created_at` (ENG-25) |
| Students rostered at start (per college; `<5` if under five) | | Query A1 |
| Students who signed in at least once (per college) | | Query A1 |

### Query A1 — students rostered and signed in, per college

Run once at the start and once at the end. "Signed in" means the account is `ACTIVE`, which is the
same rule as Operations → Analytics (`packages/persistence/src/college-health.ts:147-150`).

```sql
-- psql variables, set once per session:
-- \set institution_ids '{<uuid>,<uuid>}'
-- \set pilot_start '<YYYY-MM-DD>'
-- \set pilot_end '<YYYY-MM-DD>'
WITH counts AS (
  SELECT ir.institution_id,
         count(DISTINCT ir.student_user_id) AS rostered,
         count(DISTINCT ir.student_user_id) FILTER (WHERE u.state = 'ACTIVE') AS signed_in
  FROM institution_relationships ir
  JOIN users u ON u.id = ir.student_user_id
  WHERE ir.institution_id = ANY(:'institution_ids'::uuid[])
    AND ir.state IN ('VERIFIED', 'ACTIVE')
    AND u.state NOT IN ('DELETED', 'DELETION_PENDING') AND u.anonymised_at IS NULL
  GROUP BY ir.institution_id
)
SELECT institution_id,
       CASE WHEN rostered  < 5 THEN '<5' ELSE rostered::text  END AS rostered,
       CASE WHEN signed_in < 5 THEN '<5' ELSE signed_in::text END AS signed_in
FROM counts ORDER BY institution_id;
```

---

## Part B — Is each measure possible yet? (state on 2026-10-01)

Each measure depends on things that have to be true in production before the pilot. This is the
state of the repository today; re-check it on the pilot's start date.

| Precondition | Needed by | State on 2026-10-01 |
|---|---|---|
| Published aptitude questions with hint ladders (enough for a placement test) | 1, 2, 4 | **Not met.** 300 items exist as DRAFT (ENG-10, ENG-15); none is published. Each needs subject-expert review and a second-person approval (OPS-09b). With none published, practice and the placement test say "not open yet". |
| Engine consent purposes published (`adaptive-learning` and the others) | 1 | **Not met — HG-6 pending.** Until published, every student is on the non-adaptive path and the placement test is closed (`CONSENT_REQUIRED`, `packages/persistence/src/placement-tests.ts:153,170`). |
| Random tutor / no-tutor groups recorded (ENG-25) | 1 (the comparison) | **Built (ENG-25, migration 0116), not running.** `tutor_group_assignments` records each consenting student's group once, reproducibly (`docs/architecture/tutor-rollout-design.md`, ADR-051). Nobody can be assigned until `ai-tutoring` is published (HG-6), the tutor's evaluation PASS is recorded (ENG-21 human review) and a college is switched on. |
| A way for a student to sit the placement test a second time | 1 (the delayed test) | **Not built on screen.** The database and the item selection already support a second sitting with unseen questions (`retestPool`, `packages/placement/src/index.ts:276`; `startPlacementTest` starts a new sitting after a completed one, `placement-tests.ts:166-198`), but the web and Android screens show only "Your placement level" after the first sitting (`apps/web/src/studentLearning.tsx:352`). Needs a small code change — reported, not built. |
| A price for AI use (per token, or per hour of the inference server) | 3 | **Not recorded anywhere.** `ai_generations` keeps tokens but no price; `learning_sessions.cost_amount` exists but no code writes it. ENG-21's bake-off is meant to record per-token cost (ADR-033). |
| Students can be invited and sign in on production | all | **Partly.** Production is `https://oneby8.com` on AWS (ADR-041). The automation worker that sends student invitations is not deployed on AWS yet (`docs/ops/runbook-move-to-aws.md`), and outgoing email is built (ADR-042) but not switched on — so invitations are not delivered by email today. |
| Practice activity counted as "active" | 2, 4 | **Partly.** ONE's own activity log (`learner_activity_events`) records only lesson completions and assessment attempts (`apps/api/src/http/career-readiness.controller.ts:101,121,141`; `student-assessment-attempts.controller.ts:208,275`). Practice on a learning step and placement-test answers are recorded only in `learning_attempt_events`. The queries below read both; the Operations → Analytics screen reads only the first, so its "weekly active learners" can be lower than Measure 2. |
| A renewal-intent record | 5 | **No field exists.** The renewal date and a college's notice to leave are recorded (`institution_accounts`, 0078; `institution_offboardings`, 0088); the college's stated intention is recorded by you, in this report. |

---

## Part C — The five measures

Every query below:

- uses the psql variables from Query A1 (`institution_ids`, `pilot_start`, `pilot_end`), plus any
  listed under the measure;
- counts only students of the pilot colleges whose link to the college was live during the pilot, and
  leaves out deleted or anonymised accounts (a student who deleted their account has had their
  learning history erased, ADR-034, so they cannot be counted afterwards — Measure 4 reports how many);
- uses calendar weeks starting Monday in India time (`Asia/Kolkata`). Operations → Analytics uses UTC
  weeks, so its weekly figures can differ by a few hours at the edges;
- prints `<5` for any count under five.

The common first step, used by every query in this part:

```sql
-- pilot_students: one row per (college, student) whose link to the college overlaps the pilot.
CREATE TEMP VIEW pilot_students AS
SELECT DISTINCT ir.institution_id, ir.student_user_id
FROM institution_relationships ir
JOIN users u ON u.id = ir.student_user_id
WHERE ir.institution_id = ANY(:'institution_ids'::uuid[])
  AND ir.state IN ('VERIFIED', 'ACTIVE', 'TRANSFERRED', 'GRADUATED')
  AND ir.effective_from < ((:'pilot_end'::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND (ir.effective_to IS NULL OR ir.effective_to > (:'pilot_start'::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
  AND u.state NOT IN ('DELETED', 'DELETION_PENDING') AND u.anonymised_at IS NULL;

-- pilot_activity: every dated learning action by a pilot student during the pilot.
CREATE TEMP VIEW pilot_activity AS
SELECT ps.institution_id, act.student_user_id, act.occurred_at
FROM (
  SELECT e.user_id AS student_user_id, e.occurred_at FROM learner_activity_events e
  UNION ALL
  SELECT a.subject_user_id, a.occurred_at FROM learning_attempt_events a
) act
JOIN pilot_students ps ON ps.student_user_id = act.student_user_id
WHERE act.occurred_at >= (:'pilot_start'::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND act.occurred_at <  ((:'pilot_end'::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata');
```

---

### Measure 1 — Learning gain on an unaided, delayed test, against a comparison group

**The question.** Do students who used the tutor improve more, on a test taken some weeks later
without any help, than comparable students who did not?

**Why it is measured this way.**

- *Unaided*: a success after hint 3 or higher is "assisted" and never counts as shown skill (ENG
  rules, enforced by `learning_attempt_assisted_ck` in `0047_learning_attempt_log.sql`). The placement
  test has no hints at all, so every answer in it is unaided.
- *Delayed*: what a student can still do weeks later is learning; what they can do straight after
  practice may only be short-term recall.
- *Against a comparison group*: without one, any improvement could be the college's teaching, the
  exam season, or simply taking the test a second time. The plan's comparison is ENG-25: students who
  consent are split at random into a tutor group and a no-tutor group, and the split is recorded.
- *Placement level, not percentage correct*: the placement test adapts — it serves harder questions
  after right answers — so the share of right answers is pushed towards the middle for everyone and
  says little. The level it ends on (Aware, Guided, Independent, Troubleshoot, or "not enough
  evidence") is what it is built to measure.

**Instrument.** The aptitude placement test (`placement_tests`, 0064; algorithm
`placement-2pl-eap-v1`): first sitting at the start of the pilot ("before"), second sitting on the
delayed-test date ("after"), from questions the student has not seen (`retestPool`).

**What is counted.** For each group, the number of students whose level went up, stayed the same, or
went down between the two sittings, plus those with "not enough evidence" at either sitting (reported
separately, never counted as no change).

**Data sources.**

| Table | Columns used | Written by |
|---|---|---|
| `placement_tests` | `subject_user_id`, `state`, `completed_at`, `placement_level` | ENG-14 (`packages/persistence/src/placement-tests.ts`) |
| `tutor_group_assignments` | `subject_user_id`, `institution_id`, `group_name` (`TUTOR` / `NO_TUTOR`), `assigned_at` | ENG-25 (`packages/persistence/src/tutor-rollout.ts`) |
| consent records | `adaptive-learning` held | `consentPurposeHeldSql`, `packages/persistence/src/consent-purposes.ts:36` |

**Extra psql variable:** `\set delay_days <whole number>` — the minimum number of days between the
two sittings (Part F, decision 2).

**Query 1a — level change by group.** The `pilot_groups` view reads ENG-25's assignment table. If no
college had the tutor switched on during the pilot, the view is empty and the slot says "no comparison
group — the tutor was not switched on". A student is in the group they were assigned to, whether or not
they later withdrew `ai-tutoring` (intent to treat); report withdrawals separately from the consent log.

```sql
-- ENG-25: one row per student with their randomly assigned group (TUTOR / NO_TUTOR), in the pilot colleges.
CREATE TEMP VIEW pilot_groups AS
  SELECT DISTINCT a.subject_user_id AS student_user_id, a.group_name AS group_label
  FROM tutor_group_assignments a
  JOIN pilot_students ps ON ps.student_user_id = a.subject_user_id AND ps.institution_id = a.institution_id;

WITH sittings AS (
  SELECT t.subject_user_id, t.completed_at, t.placement_level,
         row_number() OVER (PARTITION BY t.subject_user_id ORDER BY t.completed_at, t.id) AS n
  FROM placement_tests t
  JOIN pilot_students ps ON ps.student_user_id = t.subject_user_id
  WHERE t.state = 'COMPLETED'
    AND t.completed_at >= (:'pilot_start'::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND t.completed_at <  ((:'pilot_end'::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
),
before_after AS (
  SELECT b.subject_user_id, b.placement_level AS before_level,
         (SELECT a.placement_level FROM sittings a
           WHERE a.subject_user_id = b.subject_user_id AND a.n > 1
             AND a.completed_at >= b.completed_at + make_interval(days => :delay_days)
           ORDER BY a.completed_at DESC LIMIT 1) AS after_level
  FROM sittings b WHERE b.n = 1
),
ranked AS (
  SELECT g.group_label,
         CASE
           WHEN ba.after_level IS NULL THEN 'NO_DELAYED_SITTING'
           WHEN 'NOT_ENOUGH_EVIDENCE' IN (ba.before_level, ba.after_level) THEN 'NOT_ENOUGH_EVIDENCE'
           WHEN array_position(ARRAY['AWARE','GUIDED','INDEPENDENT','TROUBLESHOOT'], ba.after_level)
              > array_position(ARRAY['AWARE','GUIDED','INDEPENDENT','TROUBLESHOOT'], ba.before_level) THEN 'UP'
           WHEN ba.after_level = ba.before_level THEN 'SAME'
           ELSE 'DOWN'
         END AS change
  FROM before_after ba
  JOIN pilot_groups g ON g.student_user_id = ba.subject_user_id
),
counted AS (SELECT group_label, change, count(*) AS students FROM ranked GROUP BY 1, 2)
SELECT group_label, change, CASE WHEN students < 5 THEN '<5' ELSE students::text END AS students
FROM counted ORDER BY group_label, change;
```

**Result (fill in).**

| Group | Up | Same | Down | Not enough evidence | No delayed sitting | Students in group |
|---|---|---|---|---|---|---|
| Tutor | | | | | | |
| No tutor (comparison) | | | | | | |

| Item | Value |
|---|---|
| Share moving up, tutor group (up ÷ students with both sittings, excluding "not enough evidence") | |
| Share moving up, comparison group | |
| Difference, with its 95% confidence interval (method: Part F, decision 3) | |
| Students who started but had no delayed sitting, per group (drop-out from the measure) | |
| Conclusion in one sentence | |

**If there is no comparison group** (ENG-25 not built by the pilot): run Query 1a with
`pilot_groups` as a single group (`SELECT student_user_id, 'ALL' AS group_label FROM pilot_students`)
and label the result **"Before and after only — no comparison group. This cannot show that ONE
caused any change."** Do not compare students who chose adaptive learning with those who did not and
call it a control: they chose themselves, so the groups differ in more than ONE.

**Optional second view — unaided reviews of practised skills.** For students in the adaptive path,
ONE schedules reviews of skills they practised. The share of first-try correct answers in `REVIEW`
attempts made at least `delay_days` after the student's last practice on that skill is a second,
skill-level view. It is a share of answers in a group, not a measure of any person, and never
readiness. Run it only with the comparison group in place, because the review schedule itself is
adaptive.

```sql
WITH last_practice AS (
  SELECT a.subject_user_id, a.skill_id, max(a.occurred_at) AS last_at
  FROM learning_attempt_events a
  JOIN pilot_students ps ON ps.student_user_id = a.subject_user_id
  WHERE a.context = 'PRACTICE' AND a.skill_id IS NOT NULL
  GROUP BY 1, 2
),
delayed_reviews AS (
  SELECT r.subject_user_id, r.correct
  FROM learning_attempt_events r
  JOIN last_practice lp ON lp.subject_user_id = r.subject_user_id AND lp.skill_id = r.skill_id
  WHERE r.context = 'REVIEW' AND r.answered AND NOT r.assisted AND r.highest_hint_level = 0
    AND r.occurred_at >= lp.last_at + make_interval(days => :delay_days)
    AND r.occurred_at <  ((:'pilot_end'::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
),
counted AS (
  SELECT g.group_label,
         count(DISTINCT d.subject_user_id) AS students,
         count(*) AS answers,
         count(*) FILTER (WHERE d.correct) AS correct_answers
  FROM delayed_reviews d JOIN pilot_groups g ON g.student_user_id = d.subject_user_id
  GROUP BY g.group_label
)
SELECT group_label,
       CASE WHEN students < 5 THEN '<5' ELSE students::text END AS students,
       CASE WHEN students < 5 THEN NULL ELSE answers END AS answers,
       CASE WHEN students < 5 THEN NULL ELSE correct_answers END AS correct_answers
FROM counted ORDER BY group_label;
```

| Group | Students | Delayed unaided review answers | Of which correct |
|---|---|---|---|
| Tutor | | | |
| No tutor (comparison) | | | |

---

### Measure 2 — Weekly active learners

**The question.** In each week of the pilot, how many students actually learned something on ONE?

**Definition.** A student is active in a week if they did at least one dated learning action that
week: completed a lesson, started or submitted an assessment, answered a practice, review, readiness
check, institution exam or placement-test question. Signing in or opening a page does not count — the
same principle as `learner_activity_events` (0015: "never logins or page views").

**Data sources.** `learner_activity_events` (0015) and `learning_attempt_events` (0047), through the
`pilot_activity` view above. See Part B for why both are read.

**Query 2.**

```sql
WITH weekly AS (
  SELECT institution_id,
         date_trunc('week', occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS week_start,
         count(DISTINCT student_user_id) AS learners
  FROM pilot_activity
  GROUP BY 1, 2
)
SELECT institution_id, week_start,
       CASE WHEN learners < 5 THEN '<5' ELSE learners::text END AS active_learners
FROM weekly ORDER BY institution_id, week_start;
```

**Result (fill in, one row per college per week).**

| College | Week starting | Active learners | Students rostered (A1) |
|---|---|---|---|
| | | | |

| Item | Value |
|---|---|
| Median weekly active learners across the pilot, per college | |
| Weeks in which the count was `<5` | |
| What happened in the low weeks (exams, holidays, outages) — from your notes | |

---

### Measure 3 — AI cost per student, against ₹10

**The question.** What did AI cost per pilot student, and is it within the ₹10 target (ADR-033,
ENG-25)?

**State today.** AI is held (ADR-030). No AI feature is registered in production migrations and every
AI flag is off; the in-app assistant is off by default (`ASSISTANT_ENABLED=false`). If that is still
true at the end of the pilot, write **"AI was off for the whole pilot — no AI cost"** in the slot, and
attach the output of Query 3a as the evidence. That is a result, not an estimate.

**What is counted.** Tokens used by AI features for pilot students, by model and month, turned into
rupees with the price that applied — plus any fixed cost of the inference server shared over the
pilot students.

**Data sources.**

| Source | What it holds | Gap |
|---|---|---|
| `ai_generations` (0033) | One row per AI call through orchestration: feature, student (if any), model, input and output tokens, outcome, time | No price |
| `ai_feature_policies` (0033, 0089) | Which features exist and their caps | — |
| `learning_sessions.cost_amount`, `cost_currency` (0047) | Room for a per-session cost | Nothing writes it today |
| Your price record (per-token price per model, or the inference server's hourly rate and hours) | The price | Not in ONE; record it in Part F, decision 1 |
| Vendor invoice for the in-app assistant, if it was switched on | Its cost | The assistant calls its vendor directly and is **not** recorded in `ai_generations` (`apps/api/src/assistant/assistant.service.ts`); its cost can only come from the invoice |

**Query 3a — tokens by feature, model and month, for pilot students.**

```sql
WITH usage AS (
  SELECT g.feature_key, g.model,
         date_trunc('month', g.occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
         count(*) FILTER (WHERE g.outcome = 'SUCCEEDED') AS calls,
         count(DISTINCT g.subject_user_id) AS students,
         sum(g.input_tokens) AS input_tokens,
         sum(g.output_tokens) AS output_tokens
  FROM ai_generations g
  JOIN pilot_students ps ON ps.student_user_id = g.subject_user_id
  WHERE g.occurred_at >= (:'pilot_start'::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND g.occurred_at <  ((:'pilot_end'::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  GROUP BY 1, 2, 3
)
SELECT feature_key, model, month, calls,
       CASE WHEN students < 5 THEN '<5' ELSE students::text END AS students,
       input_tokens, output_tokens
FROM usage ORDER BY month, feature_key, model;
```

**Query 3b — AI calls not about a student** (for example content drafting, if ENG-23 ran). These are a
shared cost, reported separately and not divided per student without saying so.

```sql
SELECT feature_key, model, count(*) AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens
FROM ai_generations
WHERE subject_user_id IS NULL
  AND occurred_at >= (:'pilot_start'::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND occurred_at <  ((:'pilot_end'::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
GROUP BY 1, 2 ORDER BY 1, 2;
```

**Working (fill in).**

| Line | Value | Source |
|---|---|---|
| Per-student token cost (Σ tokens × price per token, from 3a) | ₹ | 3a + price record |
| Fixed inference cost for the pilot period (server hours × hourly rate), if self-hosted | ₹ | Invoice |
| Assistant cost, if it was on | ₹ | Invoice |
| Shared content-drafting cost (3b) | ₹ | 3b + price record |
| Denominator: pilot students (Part F, decision 1 says which) | | A1 or Measure 2 |
| **AI cost per student, for the period in decision 1** | ₹ | |
| Against the ₹10 target | Within / Over / AI off | |

---

### Measure 4 — Retention

**The question.** Of the students who started using ONE in the pilot's first two weeks, how many were
still using it later?

**Definition.** The starting group is the students active (Measure 2's definition) in pilot weeks 1
and 2. A student is retained at week N if they were active in pilot week N. Week 1 begins on the pilot
start date. Weeks 4, 8 and 12 are reported, and the last full week of the pilot if the pilot is
shorter.

**Data sources.** `pilot_activity` (above); `users` and `institution_relationships` for students who
left.

**Query 4a — retained at weeks 4, 8 and 12.**

```sql
WITH weeks AS (
  SELECT institution_id, student_user_id,
         floor(extract(epoch FROM (occurred_at - (:'pilot_start'::date::timestamp AT TIME ZONE 'Asia/Kolkata'))) / 604800)::int + 1 AS pilot_week
  FROM pilot_activity
),
starters AS (SELECT DISTINCT institution_id, student_user_id FROM weeks WHERE pilot_week IN (1, 2)),
counted AS (
  SELECT s.institution_id, w.n AS pilot_week,
         count(DISTINCT s.student_user_id) AS starters,
         count(DISTINCT s.student_user_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM weeks x WHERE x.student_user_id = s.student_user_id
             AND x.institution_id = s.institution_id AND x.pilot_week = w.n)) AS retained
  FROM starters s CROSS JOIN (VALUES (4), (8), (12)) AS w(n)
  GROUP BY 1, 2
)
SELECT institution_id, pilot_week,
       CASE WHEN starters < 5 THEN '<5' ELSE starters::text END AS starters,
       CASE WHEN starters < 5 OR retained < 5 THEN '<5' ELSE retained::text END AS retained
FROM counted ORDER BY institution_id, pilot_week;
```

**Query 4b — students who deleted their account during the pilot** (they cannot appear in any other
measure, because their learning history was erased).

```sql
SELECT ir.institution_id,
       CASE WHEN count(DISTINCT u.id) < 5 THEN '<5' ELSE count(DISTINCT u.id)::text END AS deleted_accounts
FROM institution_relationships ir
JOIN users u ON u.id = ir.student_user_id
WHERE ir.institution_id = ANY(:'institution_ids'::uuid[])
  AND (u.state IN ('DELETED', 'DELETION_PENDING') OR u.anonymised_at IS NOT NULL)
GROUP BY ir.institution_id ORDER BY ir.institution_id;
```

**Result (fill in).**

| College | Started (weeks 1–2) | Retained week 4 | Retained week 8 | Retained week 12 | Deleted accounts |
|---|---|---|---|---|---|
| | | | | | |

---

### Measure 5 — College renewal intent

**The question.** Does each pilot college intend to keep using ONE after the pilot?

**Why it is recorded by hand.** ONE holds the renewal date and whether a college has given notice to
leave, but not what the college intends. Intent is a conversation, so you record it here.

**How to record it.** At a fixed point — recommended four weeks before the pilot ends — ask each
college's decision-maker the same question: *"Do you intend to continue with ONE after the pilot?"*
Record the answer in one of five categories, with the date and the person's role (not their name).

| College | Asked on | Role of the person answering | Answer: Will renew / Likely / Undecided / Will not / No answer | Main reason given, in their words |
|---|---|---|---|---|
| | | | | |

**Supporting facts from ONE — Query 5.**

```sql
SELECT o.id AS institution_id,
       to_char(a.renewal_date, 'YYYY-MM-DD') AS renewal_date,
       (a.contract_reference IS NOT NULL) AS has_contract_reference,
       (SELECT f.state FROM institution_offboardings f
         WHERE f.institution_id = o.id ORDER BY f.notice_at DESC, f.id DESC LIMIT 1) AS latest_exit_state
FROM organizations o
LEFT JOIN institution_accounts a ON a.institution_id = o.id
WHERE o.id = ANY(:'institution_ids'::uuid[])
ORDER BY o.id;
```

`latest_exit_state` is empty if the college never started leaving; `NOTICE` or `ENDED` means it has
given notice (INST-18, `docs/institution/sop-college-exit.md`); `CANCELLED` means it changed its mind.

| College | Renewal date | Contract reference recorded | Exit state |
|---|---|---|---|
| | | | |

---

## Part D — What this report must not claim

- That ONE improved learning, if Measure 1 had no comparison group.
- A figure about any single student, or any count under five.
- A readiness score, a readiness percentage, or a ranking of students or colleges by readiness.
- AI results from a model that was not benchmarked and recorded first (CLAUDE.md, "benchmark the served
  model … and record the result"; OPS-12 records evaluations in `ai_evaluations`).
- That colleges will renew, from usage figures alone. Measure 5 is what they said.

## Part E — Conclusion (fill in)

| Measure | Result in one line | Confidence (High / Medium / Low) and why |
|---|---|---|
| 1. Learning gain against comparison | | |
| 2. Weekly active learners | | |
| 3. AI cost per student vs ₹10 | | |
| 4. Retention | | |
| 5. Renewal intent | | |
| **Overall: continue, change, or stop — and what changes** | | |

Signed off by Divakar on: ____________

---

## Part F — Decisions to settle before the pilot starts

The plan (ENG-28) names the measures but not these details. Recommended answers are given; record
your choice and the date.

| # | Decision | Recommended | Your choice and date |
|---|---|---|---|
| 1 | The ₹10 target: per student per **month**, or per student for the **whole pilot**? And per **rostered** student or per **active** student? | Per rostered student per month — the number a college pays for, and the stricter test. Report the per-active-student figure beside it. | |
| 2 | How long after the first placement sitting the delayed test is taken (`delay_days`), and when | 28 days minimum, on a fixed date in the last two weeks of the pilot, the same date for both groups | |
| 3 | How the two groups are compared | Difference in the share moving up, with a 95% confidence interval; Fisher's exact test if either group is under 30 students. Decided now, not after seeing the data. | |
| 4 | Whether students must be told (and agree) that their results, without names, are used to evaluate ONE — and whether random assignment to a tutor / no-tutor group needs its own sentence in the notice | Put both to the legal review that HG-6 is waiting on, alongside `docs/legal/engine-consent-notice-DRAFT-for-legal-review.md`. Do not evaluate until answered. | |

## Part G — Code needed before every measure can be taken (reported, not built)

DOC-2 is documentation only, so these are listed here and not built:

1. **A second placement sitting on screen** (web and Android): after a completed sitting, offer "Take
   it again" when the delayed-test date or rule allows. The backend already supports it.
2. ~~**ENG-25 group assignment**~~ — built (migration 0116, `tutor_group_assignments`); it waits only for
   HG-6, ENG-21's human review and a college being switched on.
3. **A price record for AI use** — per model and period, so Measure 3 can be computed inside ONE
   rather than by hand; ENG-21's bake-off is the natural place.
4. **Optional:** have learning-step practice and placement answers write `learner_activity_events`
   too, so Operations → Analytics and Measure 2 agree. Until then, Measure 2 reads both tables.
