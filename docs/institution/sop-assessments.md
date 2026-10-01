# SOP — Assessments: question bank, assessments, assignment and results

> What this is: the procedure college staff follow to build a question bank, create and publish an
> assessment, assign it to students and read the results. Why it exists: Appendix 3 INST-19 asks for
> an SOP for every shipped module; Assessments shipped before the institution plan (pre-plan) and had
> none. Supplementary UAT script I-T. INST-02 and INST-07 put its student reads and assignment under
> the scope rule. Written 2026-10-01 against base `719eb34`.

## Who can do what

| Step | Who |
|---|---|
| Create subjects, draft questions, create draft assessments | Every institution staff role |
| Approve or reject questions, publish, reopen or extend | Owner, administrator, placement officer, department head — **not faculty** |
| Assign students | Staff with a writing scope: owners and administrators; placement officers (their whole college, or the unit they are narrowed to); a department head with a department; a lecturer with an active teaching assignment |
| Read results | Every staff role, for the students in their scope |

## Steps

1. **Assessments → Subjects**: create a subject if it does not exist.
2. **Add question**: subject, difficulty, type and answer → **Draft question** → **Submit for review**.
3. A reviewer **Approve**s or **Reject**s it. A lecturer's question waits as *Awaiting senior review*.
   **Archive** retires a question.
4. **Create assessment**: subject, title (unit test, mid exam, mock test), window, duration, attempts,
   questions shown per attempt, marks per question → **Create draft assessment**. Only approved
   questions can be used.
5. A reviewer **Publish**es it. Publishing fails if the pool no longer holds the approved questions it
   needs.
6. **Assign students**: only students inside your writing scope are assigned; at most 500 at a time.
   Students are told in the app. *SCOPE_REQUIRED* means your membership has no department or teaching
   assignment yet.
7. **Results**: score, right / wrong / blank, focus losses, auto-submitted. Lecturers also have
   **Assessment Detail** and **Reports** ([department SOP](sop-department-workspace.md)).
8. **Reopen / Extend** (reviewers): extend the window, grant extra attempts or change the duration.

## Never do

- Never publish an assessment built from questions copied from a paid or copyrighted source.
- Never assign students outside your classes by asking an administrator to do it "for you" — ask for
  the teaching assignment instead.

## Gaps

- Before a college records teaching assignments, lecturers cannot assign (they can still create).
- Android: the **Exams** tab lists assessments and results; building and publishing are web only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — I-T.
