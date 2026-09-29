# Employer Screening Attempts in Export and Deletion — Design

**Status:** Adopted (fix found by EMP-12), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0077_employer_screening_privacy.sql` (widens the deletion category CHECK only)
**Rule:** Written before the code, per the migrations rule in `AGENTS.md`

## Why this exists

EMP-12 found that a student's employer screening attempts — the 0036 tables
`employer_assessment_attempts`, `employer_assessment_attempt_questions` and
`employer_assessment_answers`, reached through `employer_assessment_invitations` → `applications` —
are in neither the student's data export (`apps/api/src/http/privacy-export.ts`) nor privacy deletion
(`apps/api/src/http/privacy-deletion.ts`). A person who asks for their data does not get their
screening results, and a person who asks to be deleted leaves their answers behind attached to a
`DELETED` account. Both are gaps in a promise the platform already makes.

The disposition has to be consistent with how deletion already treats the application these attempts
hang off: `APPLICATIONS` is `ANONYMISED` — the employer's lawful record of what it did survives,
detached from the person.

## What each table holds, and whose it is

| Table | Holds | Whose record |
|---|---|---|
| `employer_assessment_invitations` | that the employer sent test X for application Y, its window and state | The employer's (an act it took), like the application |
| `employer_assessment_attempts` | when the sitting started and ended, the seed, the stored score, max score, percentage | The employer's hiring record: the score is stored rather than recomputed precisely because a decision was made on it (0036 comment) |
| `employer_assessment_attempt_questions` | which revision of which employer question was served, in what order, with the option shuffle | The employer's question material; nothing the candidate wrote |
| `employer_assessment_answers` | the options the candidate selected, any numeric response, when, and how each was marked | The **selections** are the candidate's own words; the **marking** is the employer's grading |

None of these tables carries an append-only or immutability trigger (checked 0036 and every later
migration: only 0036 and 0074 mention them, and 0074 touches notification kinds only). No guard has to
be bypassed, so no transaction-local erase setting is needed.

## Decision 1: deletion — the attempt and its score survive, the candidate's answers are erased

**Chosen.** A new deletion category `EMPLOYER_SCREENING`, disposition `ANONYMISED`, basis
*"Employers retain the record that they sent you a screening test and the score it produced; your
answers are erased."* On execution:

1. The candidate's responses are erased: every answer row of every attempt of theirs has
   `selected_option_keys` set to `'{}'` and `numeric_response` to `NULL`. The row stays, with
   `is_correct` and `marks_awarded` — the employer's grading — so the per-question marks still add up
   to the stored score and the hiring record stays internally consistent.
2. An attempt still `IN_PROGRESS` is closed as `EXPIRED`, unscored, and its invitation marked
   `EXPIRED`. Otherwise the next sweep would grade it from the now-empty answers and store a score of 0
   as though the candidate had earned it — a number nobody measured. `EXPIRED` with no score is the
   0036 CHECK's own shape for "ended without a submission".
3. The attempt row, its score, the served paper and the invitation stay, pointing at the anonymised
   user exactly as the application does. The employer's access had already ended: deletion revokes
   every applicant-access grant first, and both employer result views (`/results`,
   `/applications/:id/assessment-results`) require a live grant.

`record_count` is the number of the person's attempts.

**Rejected: `ERASED` — delete the attempts.** The score is the employer's record of a decision it
lawfully made on this application; the application itself survives. Deleting the attempt while
keeping the application would leave the employer's pipeline pointing at a stage with no result, and
treat the screening result differently from the hiring decision it fed.

**Rejected: delete the answer rows.** Simpler, but the employer's per-question marks would vanish and
the breakdown would no longer sum to the stored score. Clearing only the selections removes what the
person wrote and keeps what the employer measured.

**Rejected: fold into `APPLICATIONS`.** The deletion record would say only "applications anonymised"
while also erasing answer content. A separate category tells the subject and operations exactly what
happened to screening data, and makes the count honest.

**Considered and not done: also clear `answered_at`.** It is NOT NULL and is the time a response was
saved; with the response gone and the person anonymised it identifies no one. Left as is.

The CHECK `privacy_deletion_category_ck` (0009, widened by 0067) must allow the new value, so
`0077` widens it by read-and-union: every value the live constraint allows is kept, `EMPLOYER_SCREENING`
is added, and nothing changes on replay. 0067's own guard tests only for `APPLICATION_MESSAGES`, so
replaying 0067 before 0077 does not drop the new value.

## Decision 2: export — the student's own attempts, never the answer key

**Chosen.** The export gains `screeningAssessments`: one entry per invitation sent on one of the
subject's applications, with

- employer name, role title, assessment title, invited / opens / closes times, invitation state;
- the attempt, if any: state, started and submitted times, and the **percentage** — the score as the
  student already sees it on *My applications* (`/students/me/screening-assessments`);
- for each question served, in the candidate's own order: the question text, the options as they were
  shown (display keys and text, in the candidate's shuffle), and the options the candidate chose,
  under their display keys, plus any numeric response.

**Never included:** `is_correct` of any option (the answer key), `is_correct` or `marks_awarded` of an
answer (which reveal the key question by question), the raw score or max score beyond what the
student sees, the seed or the stored-key mapping, and anything about any other candidate. Every query
is scoped by `applications.student_user_id` (invitations) and `candidate_user_id` (attempts).
`notIncluded` says so in words: *"The answer key to employer screening tests, and how each of your
answers was marked."*

**Rejected: omit the question text.** "You chose B" is meaningless without what was asked, and the
candidate was shown the question in full. The option text they did not choose is included for the
same reason; none of it discloses which one was right.

## Clients

No web or Android change. The export is a JSON download both clients already fetch without
interpreting its sections, and neither client lists deletion categories.
