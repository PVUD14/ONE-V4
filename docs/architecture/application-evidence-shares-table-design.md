# Consented Skill Evidence per Application — Table Design

**Status:** Adopted for build (EMP-13), recommended options taken per AGENTS.md ("ask once, recommend, carry on").
**Built dark:** the employer read and the student's sharing control sit behind the feature flag
`employer.skill-evidence`, **default off, turning it on needs a second person**, because the program's
hard gate HG-4 (the decision to let employers see per-skill evidence at all) is still PENDING. See ADR-043.
**Date:** 2026-09-30
**Migration:** `0093_application_evidence_shares.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** ADR-020 (readiness is a band and never reaches an employer), ADR-034 (evidence is immutable),
`evidence-stages-table-design.md` (ENG-04: `assisted`, `stage_at_capture`),
`application-eligibility-evaluations-table-design.md` (EMP-06: catalogue skills on a job),
`application-snapshots-table-design.md` (EMP-07: the live applicant-access grant, the candidate view)

## Why this exists

ONE's claim to employers is proof of skill rather than self-description. The pieces exist: every graded
piece of work a student does on ONE leaves an immutable `evidence_records` row that says which skill,
what kind of evidence, when, whether it was aided, and the stage the skill had reached (ENG-04); and a job
can name its skills from the ONE catalogue, so a job skill points at the same topic evidence does
(EMP-06, `opportunity_skill_requirements.taxonomy_topic_id`). Nothing connects them: an employer sees
none of a candidate's evidence, and there is no way for a student to choose to show it.

Evidence is a statement about a person's ability, made by ONE from their work, shown to someone deciding
whether to hire them. So what is shown is chosen by the student, item by item, for one application; it
can be taken back at any time and stops being visible on the next request; and it never becomes a number.

## What counts as shareable ("verified") evidence

A row of `evidence_records` the student may share for a job skill when **all** of these hold:

| Rule | Why |
|---|---|
| `subject_user_id` is the student | Only your own evidence. Enforced again by a trigger (below). |
| `evidence_type` is `ASSESSMENT_OUTCOME` or `TOPIC_DEMONSTRATION` | A lesson completion shows that a lesson was read, not that the skill can be done (ENG-04 already excludes it from stages). |
| `stage_at_capture` is `DEMONSTRATED` or `TRANSFERRED` | "Verified" means the skill had been shown by the learning model's rule — unaided success on two different days — when this evidence was recorded. A single lucky answer never qualifies. |
| `demonstrated > 0` | A graded record in which nothing was answered correctly is not evidence *of* the skill, even after the stage was reached. The figure itself is never shown. |
| no later row supersedes it | A corrected record is replaced by its correction. |
| its topic is a **catalogue** skill of the job version the application is bound to | Only skills the job asks for (Appendix 2 §5.3). A free-text job skill has no topic and is never matched by name. |

Assisted evidence can qualify (a hint used at level 3 or an AI tutor reply) — and is then shown as
**aided**. The plan's panel shows "unaided" as its own field precisely so the employer can tell.

## What is shown, and what is not (ADR-043 states it as the decision)

**Per shared item, to the employer:** the job skill it is shared against (name and REQUIRED/PREFERRED as
the employer wrote it), the evidence type (assessment outcome or topic demonstration), its source (a ONE
skill check or an institution exam), the date it was recorded, and whether it was unaided. For a job skill
with nothing shared: "no evidence shared". For a free-text skill: that evidence cannot be matched to it.

**Never:** a readiness band or score, a gap status (MET / PARTIAL / MISSING / UNKNOWN), a mastery value,
the stage, `demonstrated`/`possible` or any ratio, a count or total of evidence, a percentage, a rank, a
sort by evidence, a "fit" number, an evidence or topic identifier, or anything the student did not tick.
The skills are listed in the job's own order; items within a skill newest first.

**The student sees exactly the same fields** for each item they can choose, so what they tick is what the
employer reads.

## Decision 1: one new table, `application_evidence_shares`

**Chosen.** One row per (application, evidence record) the student chose to share:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `application_id` | uuid → `applications(id)` | the one application this consent is for |
| `student_user_id` | uuid → `users(id)` | the applicant; a trigger requires it to be the application's student **and** the evidence's subject |
| `evidence_record_id` | uuid → `evidence_records(id)` | the item shared |
| `shared_via` | text, CHECK `APPLY` / `APPLICATION` | chosen while applying, or later from the application |
| `shared_at` | timestamptz, default `now()` | database clock |
| `revoked_at` | timestamptz, nullable | set once |
| `revoked_reason` | text, CHECK `STUDENT_REVOKED` / `ACCOUNT_DELETION` | paired with `revoked_at` by CHECK |

A partial unique index on `(application_id, evidence_record_id) WHERE revoked_at IS NULL` allows one live
share per item; re-sharing after a revocation writes a new row, so the history of each consent stays.

**Guards in the database**, not only in the API:

- `INSERT`: the application's `student_user_id` and the evidence's `subject_user_id` must both equal the
  row's `student_user_id`, and the row must arrive unrevoked. Nobody — including a buggy route — can share
  another person's evidence, or share into another person's application.
- `UPDATE`: only `revoked_at` and `revoked_reason`, only from NULL, only once. Everything else is fixed.
- `DELETE`: refused. A consent record is evidence of what the student agreed to and when. Applications
  and evidence are anonymised, never deleted, under the deletion policy, so these rows never block one.

**Rejected: a JSON list on `application_profile_snapshots`.** The snapshot is frozen at apply and
immutable by design (EMP-07); a revocable, changeable choice cannot live in an immutable row, and the
student must be able to add evidence after applying (evidence earned later).

**Rejected: a consent registry key (`employer-evidence-sharing`).** The plan replaced that key with the
per-application choice (Part B.9). A global switch would share every item with every employer the student
applies to, which is exactly the over-sharing the per-application model prevents.

**Rejected: copying the evidence fields into the share row.** Evidence is immutable already (0004
trigger); reading through the foreign key shows what the record says, and a correction (supersession)
correctly withdraws the old one from view.

## Decision 2: access and revocation

Every employer read requires, at the moment of the request, in SQL: the EMP-03 organisation guard; the
application is this employer's; the EMP-SR-01 live applicant-access grant (`liveApplicantGrantCondition`
— revoked, expired or an account in deletion gives 403); the flag on; and `revoked_at IS NULL` on the
share. Nothing is cached, so a revocation (or a withdrawal, a close, a deletion request) takes effect on
the next request. Revoking is always allowed — even with the flag off, even after the application closed —
adding needs the flag, an open application and a live grant.

Every employer read of the panel is audited as `application.evidence_viewed` (with which skills had items,
not the items), every use of the applicant filter as `application.evidence_filter_used`, and every student
change as `application.evidence_shared` / `application.evidence_share_revoked`, in the same transaction.

## Decision 3: the filter (decision 10.2 #5)

`GET …/opportunities/:opportunityId/applications?evidenceSkill=<catalogue topic>` returns only the
applicants who currently share qualifying evidence for that skill **and** whose grant is live (a
withdrawn applicant is never revealed to have shared). The order stays the list's own (most recently
updated first); nothing is sorted, scored or counted by evidence. The list carries the job's catalogue
skills to filter by only when the flag is on.

## Retention and deletion

A share lives with its application. Privacy deletion revokes every live share (`ACCOUNT_DELETION`) in the
same step that revokes the grants, so access ends for good; the rows stay as the record of consent,
pointing at an anonymised application and anonymised evidence. The student's data export gains
`evidenceShares` (job, employer, skill, type, source, date, unaided, shared, revoked).

## Migration

`0093_application_evidence_shares.sql`: `CREATE TABLE IF NOT EXISTS`, constraints dropped and re-added
by name, `CREATE OR REPLACE` functions, triggers dropped and re-created, the flag inserted
`ON CONFLICT DO NOTHING` (a replay never changes a live switch) with its high-risk direction re-asserted.
References only 0001–0007 tables (`users`, `applications`, `evidence_records`) and `feature_flags` (0029,
`high_risk_direction` 0038), so it is safe on a fresh database and on every replay.

## Readiness

Nothing here reads or writes `readiness_snapshots`, `readiness_factors`, `mastery_projections`,
`career_gap_*` or `learner_skill_state`. `stage_at_capture` is used only as a qualifying rule and never
leaves the server. Contract tests assert no band, score, gap status, mastery value or stage in any employer
response.

## Decisions for Divakar

1. **HG-4 itself** — whether employers may see this at all. Recommended: yes, exactly as above (ADR-043).
   Until you approve, the flag stays off and neither side sees anything.
2. **The qualifying rule** (DEMONSTRATED or TRANSFERRED at capture, something correct, not a lesson).
   Recommended as built. Stricter (TRANSFERRED only) would show nothing today, because TRANSFERRED is not
   yet reachable (ENG-04).
3. **Aided evidence is shareable and labelled "aided".** Recommended as built; the alternative (unaided
   only) is a one-line change in the qualifying query.
4. **Cap: 60 live shares per application, 20 choices offered per skill.** Recommended as built.
