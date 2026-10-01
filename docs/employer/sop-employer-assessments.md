# SOP — Screening tests (employer assessments)

> What this is: employer-facing help for writing questions, building a screening test, sending
> it to applicants and reading results, with the matching operator steps. Why it exists:
> Appendix 2 EMP-18 asks for an SOP per shipped module; this covers EMP-12 (ADR-039) and the
> 0036 screening tests it reworked. Written 2026-10-01 against base `719eb34`.

## For employers

### Who

Owners, admins and recruiters. Writing questions and drafting tests is allowed while awaiting
verification; publishing, sending and reading results need a verified, active organisation.

### Where

**Employer Portal → Assessments**: *Question bank*, *Tests*, *Results*. One candidate's results,
question by question, are on **Candidate Detail**. Android: recruiters read a candidate's results
on the applicant page and can **Move to assessment**; building, publishing, sending and closing
tests are on the web. Students take screening tests on the web or the phone.

### Steps

1. **Question bank → Write a question**: choice, multiple-select, true/false, scenario, code
   output or numerical choice questions. Coding and fill-in questions are not offered (no code
   sandbox exists). **Send for review**.
2. **Someone other than the author** approves (**Approve**) or **Reject**s it with a reason
   (`INACCURATE`, `AMBIGUOUS`, `NOT_RELEVANT_TO_ROLE`, `DUPLICATE`, `UNFAIR_OR_BIASED`). A
   question that names a protected attribute is flagged to its author and reviewer.
3. **Tests → Build a test** from approved questions: title, the role, length in minutes →
   **Create test**, then **Publish**.
4. Move each applicant to the **Assessment** stage first (Applicants). Sending a test never moves
   anyone.
5. **Send to applicants**: opens now or at a time you choose, open for up to 30 days →
   **Send test**. The candidate is told in-app.
6. **Results** lists candidates in the order they were sent the test — **never ranked by score**
   — 50 a page. Each read is audited. Email appears only from Shortlisted onward.
7. **Close test** with a reason (`ROLE_FILLED`, `ROLE_CLOSED`, `SCREENING_COMPLETE`,
   `REPLACED_BY_NEW_TEST`, `CONTENT_FLAWED`). Invitations already sent stay open until their
   window ends.

### Time and fairness

- ONE's server keeps the time. A candidate gets the test's full length unless the window closes
  first; the brief tells them how many minutes they really have before they agree to start.
- After the deadline no answer is accepted; what was saved in time is graded.
- No camera, microphone or screen capture is used, and the brief says so.
- Results stay inside the application. They never touch the student's learning record or
  readiness.

### Your bank is yours

You cannot see or use a college's question bank, and no college can see yours.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A student cannot start a test | Support case ([../ops/sop-support.md](../ops/sop-support.md)). Likely: the window has not opened or has closed, the employer is suspended (`ASSESSMENT_UNAVAILABLE`), or the student no longer shares the application |
| A question is offensive or discriminatory | Open a trust case about the employer |
| A student asks for their data | The privacy export includes their own attempts and answers, never the answer key ([../ops/sop-privacy.md](../ops/sop-privacy.md)) |

## Gaps

- Coding questions wait for the code sandbox (ENG-12, open).
- The learning-evidence opt-in for employer results is not built (decision for Divakar).
- No employer Assessments list on Android. The invitation email waits for production email.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J7.
