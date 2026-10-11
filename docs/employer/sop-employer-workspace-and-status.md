# SOP — Employer workspace and organisation status

> What this is: employer-facing help for signing in to the employer workspace and understanding
> the organisation's verification status, with the matching operator steps. Why it exists:
> Appendix 2 EMP-18 (EM1 slice) requires an SOP per shipped module. Covers EMP-01 (owners and
> admins land in the employer portal) and EMP-03 (organisation state enforced everywhere).
> Written 2026-09-26 against base `6864332`; updated 2026-10-01 against base `719eb34`.

## For employers

### Who

Anyone with an ACTIVE employer membership: **Owner**, **Admin** or **Recruiter**. The first
person Operations invites for a new employer is its **Owner**.

### Signing in

1. Open ONE and sign in with the work email your invitation was sent to.
2. You land in the **Employer Portal** (`/employer/recruiter`). If you also hold another
   workspace (for example a college role), choose the employer entry; it is labelled with your
   broadest employer role (owner, then admin, then recruiter).

### What your organisation's status allows

| Status | You can | You cannot |
|---|---|---|
| Awaiting verification (PENDING, UNDER_REVIEW) | Set up the company profile, your team and draft jobs | Publish jobs, see applicants or any candidate data |
| Verified | Everything your role allows | — |
| Suspended or Rejected | Read your organisation's status, and read and answer trust cases about it | Everything else, including reading your team or profile |

- While awaiting verification the portal shows **"Available once your organisation is
  verified"** on candidate screens.
- If your organisation is **suspended**, your published jobs are **paused** at once and students
  stop seeing them. If Operations later reinstates you, the jobs **stay paused** — republish
  each one you still want.
- A refused action says why (`EMPLOYER_ORGANISATION_UNVERIFIED` or
  `EMPLOYER_ORGANISATION_INACTIVE`) with a reference; quote the reference if you contact us.

### Getting help

Contact ONE support with the reference shown. If ONE Operations has asked you to respond to a
trust case, the status page lists it; owners and admins answer it from **Settings**, which stays
open to trust cases even while you are suspended
([sop-employer-terms-and-trust.md](sop-employer-terms-and-trust.md)).

### Everything else in the portal

| Module | SOP |
|---|---|
| Team and interviewers | [sop-employer-team.md](sop-employer-team.md) |
| Company profile, access requests | [sop-employer-company-profile.md](sop-employer-company-profile.md) |
| Jobs: publish, edit, pause, close | [sop-employer-job-lifecycle.md](sop-employer-job-lifecycle.md) |
| Eligibility, skills, stages | [sop-employer-eligibility-and-stages.md](sop-employer-eligibility-and-stages.md) |
| Applicants, Candidate Detail, offers | [sop-employer-candidates-and-offers.md](sop-employer-candidates-and-offers.md) |
| What students are told | [sop-employer-hiring-notifications.md](sop-employer-hiring-notifications.md) |
| Interviews and scorecards | [sop-employer-interviews.md](sop-employer-interviews.md) |
| Messages | [sop-employer-messages.md](sop-employer-messages.md) |
| Campus drives | [sop-employer-campus-drives.md](sop-employer-campus-drives.md) |
| Screening tests | [sop-employer-assessments.md](sop-employer-assessments.md) |
| Skill evidence (switched off) | [sop-employer-skill-evidence.md](sop-employer-skill-evidence.md) |
| Talent pool (switched off) | [sop-employer-talent-pool.md](sop-employer-talent-pool.md) |
| Dashboard and Reports | [sop-employer-dashboard-and-reports.md](sop-employer-dashboard-and-reports.md) |
| Settings, terms, trust cases | [sop-employer-terms-and-trust.md](sop-employer-terms-and-trust.md) |
| Exports | [sop-employer-exports.md](sop-employer-exports.md) |

## Matching operator steps

| Employer need | Operator procedure |
|---|---|
| Verify a new employer, invite its owner | [../ops/sop-organizations.md](../ops/sop-organizations.md) §A |
| Suspend (dual control) or reinstate | [../ops/sop-organizations.md](../ops/sop-organizations.md) §B |
| An employer "cannot sign in" | [../ops/sop-support.md](../ops/sop-support.md) — look the person up; check the invitation and membership state |

## Never do (operators)

- Never verify an employer so that it can "see candidates for a demo".
- Never tell an employer that republishing is automatic after reinstatement; it is not.

## Gaps

- **Email:** the email sender is built but not switched on in production, and the sender
  mailbox is still to be set up, so the owner's invitation is recorded as not emailed there.
- The employer web pages (and the Dashboard) resolve the caller's membership as the first
  employer membership in the session, not the workspace they chose (EMP-SR-03, open). A person in
  two employers who picks the second still reads and writes the first on those screens, under the
  second one's status gate; a person who is both recruiter and owner of one employer may see the
  recruiter view on owner-only screens. Only the Assessments screen uses the chosen workspace.
- Fixed since the first version of this SOP: a suspended employer's screening tests now close to
  students (EMP-12, `ASSESSMENT_UNAVAILABLE`).

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J1, J2, E-S.
