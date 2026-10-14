# SOP — Consented skill evidence on an application

> What this is: employer-facing help for the Evidence panel — verified skill evidence a student
> chose to share with one application — with the matching operator steps for switching it on.
> Why it exists: Appendix 2 EMP-18 asks for an SOP per shipped module; this covers EMP-13
> (ADR-043). Written 2026-10-01 against base `719eb34`.

## Status

**Built, switched off.** Divakar approved hard gate HG-4 on 2026-10-01, so ADR-043 is accepted,
but the feature sits behind the flag `employer.skill-evidence`, which is **off by default**.
Until Operations switches it on, students are offered nothing and employers see nothing.

## For employers

### Who

Owners, admins and recruiters of a verified, active employer, while the candidate's grant is live.

### Where

- **Candidate Detail** and the Applicants candidate panel: *Evidence*.
- **Applicants**: the skill filter (*Has shared verified evidence for*).
- Android: the applicant page shows the evidence section; the skill filter is web only.

### What you see

For each skill on the job, in the job's order: the items the student shared — type (assessment
or demonstration), source, date and whether it was unaided — or **no evidence shared**. Skills
you added in your own words are marked as not matchable.

What you never see: a readiness band or score, a count, a percentage, marks, a ranking or the
stage of learning. The filter narrows the list to applicants who shared evidence for one skill;
it never re-orders it.

Every panel view and filter use is audited.

### What the student controls

The student ticks items at apply and can add or take back items later from their application.
Taking back is always allowed, and you lose the item on your next request. Withdrawal, rejection,
hire or a deletion request end access to everything.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| Switching the feature on | **Operations → Feature Flags**, `employer.skill-evidence`. Enabling is a high-risk change: it needs a second person, or the solo-operator cool-off ([../ops/sop-feature-flags.md](../ops/sop-feature-flags.md), [../ops/sop-approvals.md](../ops/sop-approvals.md)). Only on Divakar's instruction |
| Switching it off in an incident | Disable the flag. Students can still see and take back anything already shared |
| A student says evidence was shown that they did not share | Support case; the audit rows record each share, revocation and view |

## Gaps

- No operator screen for evidence shares beyond audit.
- The nomination-accept screens offer no evidence checklist; the student adds evidence later.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J10.
