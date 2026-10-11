# SOP — Eligibility rules, required skills and selection stages

> What this is: employer-facing help for saying who can apply to a job, which skills it needs and
> which stages it runs, with the matching operator steps. Why it exists: Appendix 2 EMP-18 asks
> for an SOP per shipped module; this covers EMP-06. Written 2026-10-01 against base `719eb34`.

## For employers

### Who

Owners, admins and recruiters. Changing a **live** job's rules needs a verified organisation.

### Where

**Employer Portal → Opportunity Detail → Eligibility, skills and stages**. Every save is a new
job version ([sop-employer-job-lifecycle.md](sop-employer-job-lifecycle.md)). Android shows the
rules, skills and stages read-only.

### Steps

1. **Who can apply → Add a rule**. Rule types: minimum CGPA (10-point scale), maximum active
   backlogs, graduation year, department, programme, work authorisation, custom. Up to 12 rules,
   at most 5 custom.
2. Mark a rule as **Decides who can apply** (blocking) or leave it as information. Custom and
   work-authorisation rules can never block, because ONE holds no such fact.
3. **Skills → Search the ONE skill catalogue** and **Add skill**, or **Or add a skill in your own
   words** (marked "not in the ONE catalogue"; never matched to evidence). Up to 30 skills.
4. **Catalogue role this job maps to** (optional).
5. **Selection stages, in order → Add a stage**: screening, assessment, interview, group
   discussion, offer. Up to 12, in pipeline order, offer last. An interview or group-discussion
   stage can carry a **Scorecard template** ([sop-employer-interviews.md](sop-employer-interviews.md)).
6. **Save new version**. On a live job, a change to eligibility needs a **Reason for the change**
   from the list, and every open applicant is asked to accept the new terms.

### What the student and you see

- A student who fails a blocking rule cannot apply and is told **which rule**
  (`ELIGIBILITY_NOT_MET`). If ONE has no record to check a blocking rule, the application is
  refused as unknown (`ELIGIBILITY_UNKNOWN`) and the student is told what is missing.
- You see each applicant's eligibility **as it stood when they applied**: the outcome and its
  basis — verified, college record or **Self-reported** — never the marks themselves.
- Applicants shows the job's stages still ahead, named as you named them. Shortlist and Reject
  stay available at any point.

### Rules

- A rule that names a protected attribute or a proxy for one (for example gender, religion,
  caste, age, marital status) is refused (`ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE`).
- ONE never ranks applicants and never uses readiness in any rule.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A student says a rule is unfair or discriminatory | Log a support case ([../ops/sop-support.md](../ops/sop-support.md)); look at the job's current version; if a rule discriminates, open a trust case about the employer |
| A student's eligibility is "unknown" | The student needs an academic record: their college verifies it, or they add a self-reported one (Android: More › Academic record). Operations does not edit academic records |
| A skill is missing from the catalogue | Catalogue changes go through the operations career-catalogue screens, not through the employer |

## Gaps

- The web student app has no academic-records screen; it tells students to ask their college.
- The web editor offers no college (INSTITUTION) rule; existing ones are kept and shown by name.
- Interviews are not tied to a selection stage except through the stage's scorecard template.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J3.
