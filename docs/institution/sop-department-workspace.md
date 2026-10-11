# SOP — The department head's workspace and the lecturer's class reports

> What this is: the procedure a department head follows to see their department in ONE, and a
> lecturer follows to read their class reports and one assessment's results. Why it exists:
> Appendix 3 INST-19 (every shipped module has an SOP); journey J6. Built by INST-07, with later
> sections added by INST-08 (exports), INST-09 and INST-12 (placement), INST-17 (readiness by
> role). Written 2026-10-01 against base `719eb34`.

## Who sees what

| Role | Sees |
|---|---|
| Department head | Only the department on their staff membership — its programmes, batches and sections |
| Faculty | Only the sections and batches of their active teaching assignments (before the college records any assignment: the department and batch on their membership) |
| Owner, administrator | The same screens' figures for any department, through their own pages |

A head whose membership has **no department** cannot run anything that writes or exports
(`SCOPE_REQUIRED`); ask an administrator to set the department under **Staff**.

## Department head — where each thing is

| Item | What it shows |
|---|---|
| **Department Overview** | Students on the roster and activated, assessments in progress, last month's readiness bands, open interventions and tasks, batches, the shared-application pipeline, the verification queue waiting |
| **Students** | The department's roster (read-only), each student's placement status, shared applications on request, then the verification queue and the results upload |
| **Readiness** | Last month's bands, the month-by-month report, and readiness by career role with preparation sprints ([sprints SOP](sop-readiness-by-role-and-sprints.md)) |
| **Faculty and Staff** | Staff scoped to the department, who is teaching now, and teaching assignments ([staff SOP](sop-staff-scope-and-teaching.md)) |
| **Placement Pipeline** | Shared applications by stage, offers by response, students by placement status, season statistics by batch ([register SOP](sop-placement-register.md)) |
| **Opportunities and Offers** | Each shared application: employer, opportunity, stage, whether an offer was made and the answer |
| **Batches** | The department's batches with roster, enrolled and activated counts (the structure itself is changed by an administrator) |
| **Reports and Analytics** | Department summary, applications by stage, the readiness report, and the Exports panel ([exports SOP](sop-analytics-and-exports.md)) |

## Department head — steps

1. Start each week on **Department Overview**. Follow the links (**View Students**, **View Batches**,
   **Open pipeline**, **Review Queue**) to act.
2. On **Students**, open **View applications** only when you need one student's shared applications.
   Every such read is recorded.
3. On **Opportunities and Offers**, use **Load more applications** to page; the list is recorded as
   read each time it loads.
4. To compare with the college view, ask an administrator to open the same page filtered to your
   department — the figures are the same query and must match.

## Lecturer — class reports and assessment detail

1. **Reports** lists each section or batch you teach, with each assessment's assigned and completed
   counts and the class average. The average is shown only once at least five students have a result.
2. **Assessment Detail**: choose an assessment to see your students' results (score, percentage, time
   taken) and who has **Not attempted yet**.
3. If the page says *You have no active teaching assignment right now*, ask an administrator or your
   head to assign your classes.

## What the screens will never show

- A numeric readiness score — readiness is shown only as bands, never as a number.
- Offer pay or terms, alone or in a total.
- A group of fewer than five in any readiness, stage or offer count — it reads `<5`, and a total that
  would reveal it is withheld.
- An application the student did not share with the college.

## Never do

- Never copy names from the shared-applications list into an email to an employer.
- Never ask a student to share an application so that a figure "adds up".

## Gaps

- **No Messages item for department heads (HG-3):** the API lets a head announce to their department,
  but the screen is only on the faculty portal.
- Opportunities and Offers is web only (an audited read of application records).
- Android: the institution home shows the department overview, cohort readiness, the suppressed
  pipeline and "My classes", read-only.

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — J6.
