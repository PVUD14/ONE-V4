# SOP — Employer workspace and organisation status

> What this is: employer-facing help for signing in to the employer workspace and understanding
> the organisation's verification status, with the matching operator steps. Why it exists:
> Appendix 2 EMP-18 (EM1 slice) requires an SOP per shipped module. Covers EMP-01 (owners and
> admins land in the employer portal) and EMP-03 (organisation state enforced everywhere).
> Written 2026-09-26 against base `6864332`.

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
| Suspended or Rejected | Read your organisation's status | Everything else, including reading your team or profile |

- While awaiting verification the portal shows **"Available once your organisation is
  verified"** on candidate screens.
- If your organisation is **suspended**, your published jobs are **paused** at once and students
  stop seeing them. If Operations later reinstates you, the jobs **stay paused** — republish
  each one you still want.
- A refused action says why (`EMPLOYER_ORGANISATION_UNVERIFIED` or
  `EMPLOYER_ORGANISATION_INACTIVE`) with a reference; quote the reference if you contact us.

### Getting help

Contact ONE support with the reference shown. Responding to a trust case from the status page
is not built yet (EMP-16) and the page says so.

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

- **HG-7:** no production sender, so the owner's invitation is not emailed in production.
- The employer web page resolves the caller's membership as the first employer membership in the
  session. A person who is both recruiter and owner of one employer may see the recruiter view
  on owner-only screens; the server still acts with the broader role (EMP-02 limitation; see the
  employer security review).
- Students who already hold a screening-assessment invitation from a suspended employer can
  still attempt it; the employer cannot read the results (EMP-03 limitation).

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J1, J2.
