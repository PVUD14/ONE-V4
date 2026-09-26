# ONE Employer Portal — UAT scripts V1 (EM1 slice)

> What this is: executable acceptance scripts for the employer journeys in Appendix 2 §9,
> written for what Wave 1 built (EMP-01 to EMP-04). Why it exists: EMP-18 requires every shipped
> module to have a UAT script, and milestone EM1 ("access and integrity") needs its journeys
> proven. Journeys whose features belong to later milestones are marked **Not in this slice**.
> Written 2026-09-26 against base `6864332`.

## Rules for running these scripts

- **Synthetic data only**: `@uat.example.test` accounts and `UAT …` organisations. No real
  person, company or production data.
- **Environment**: local stack or staging with a **non-production** Cognito pool. Journeys that
  create, suspend or invite are never run against production.
- **Email**: production has no sender (HG-7). Locally enable the loopback Mailpit sink to
  receive invitations; otherwise the screen says "not sent", which is correct behaviour.
- Record Pass / Fail per step with the on-screen reference for any failure.

## Personas

| Persona | Account | Role |
|---|---|---|
| Operator | `operations.admin@uat.example.test` | OPERATIONS_ADMIN |
| Approver | `ops.super@uat.example.test` | PLATFORM_SUPER_ADMIN |
| Owner | `emp.owner@uat.example.test` | EMPLOYER_OWNER, invited in J1 |
| Admin | `emp.admin@uat.example.test` | EMPLOYER_ADMIN, invited in J1 |
| Recruiter 1, 2 | `emp.recruiter1@uat.example.test`, `emp.recruiter2@uat.example.test` | RECRUITER, invited in J1 |
| Other employer's recruiter | `recruiter@uat.example.test` | RECRUITER of `UAT Other Employer` |
| Student | `student.one@uat.example.test` | rostered student |

`UAT Logistics Pvt`'s website on record is `https://uat.example.test`, so its careers page must
be on that host. `example.test` is a reserved domain and never delivers outside the local sink.

## Summary

| # | Journey (Appendix 2 §9) | Status in this slice | SOP |
|---|---|---|---|
| J1 | Operations onboards an employer; owner invites an admin and two recruiters | In slice | [workspace](../employer/sop-employer-workspace-and-status.md), [team](../employer/sop-employer-team.md) |
| J2 | Operations suspends the employer | In slice | [workspace](../employer/sop-employer-workspace-and-status.md), [ops organizations](../ops/sop-organizations.md) |
| J3 | Job with CGPA, backlog and department rules and three stages | **Not in this slice** — eligibility rules and stages are EMP-06 | — |
| J4 | Screen, shortlist, interview, scorecard, student notified | **Not in this slice** — notifications and calendar invites are EMP-08/EMP-09 | — |
| J5 | Pay changed after applications | **Not in this slice** — EMP-05 | — |
| J6 | Campus drive approved with one-offer-per-student | **Not in this slice** — EMP-11 | — |
| J7 | Employer assessment at the Assessment stage | **Not in this slice** — EMP-12 | — |
| J8 | Student withdraws and revokes sharing | **Not in this slice** — grant revocation journeys are verified in EM2 | — |
| J9 | Export of shortlisted candidates | **Not in this slice** — EMP-17 (no export exists) | — |
| J10 | Evidence shared for two of five skills | **Not in this slice** — EMP-13 | — |
| J11 | Discovery opt-in and invite | **Not in this slice** — EMP-14 | — |
| E-S | Unverified employer drafts but cannot publish or see candidates (supplementary) | In slice | [workspace](../employer/sop-employer-workspace-and-status.md) |
| E-T | Team role rules and last-owner protection (supplementary) | In slice | [team](../employer/sop-employer-team.md) |
| E-P | Company profile and verified fields (supplementary) | In slice | [company profile](../employer/sop-employer-company-profile.md) |

---

## J1 — Operations onboards an employer; the owner builds the team

**Passes when** all four land in the employer workspace with the right powers.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Organizations → Add Organization**, Type Employer, `UAT Logistics Pvt`, website `https://uat.example.test` | PENDING |
| 2 | Operator | **Begin review**, **Verify** | VERIFIED |
| 3 | Operator | **Invite admin** → owner's address | Invitation created; role shown as owner |
| 4 | Owner | Accept, sign in | Lands at `/employer/recruiter`, labelled owner |
| 5 | Owner | **Team → Invite a team member**: admin's address, Role Admin | Invitation listed, 14-day expiry, delivery state shown |
| 6 | Admin | Accept, sign in | Lands in the employer workspace as admin |
| 7 | Admin | Invite recruiter 1 and recruiter 2 as Recruiter | Both listed |
| 8 | Admin | Try to invite an **Admin** | Not offered / refused |
| 9 | Recruiters 1 and 2 | Accept, sign in | Land in the employer workspace |
| 10 | Recruiter 1 | Open **Team** | "Managed by your owner or admin"; no team data |
| 11 | Recruiter 1 | Open **Company Profile** | Read-only view |
| 12 | Owner | **Team** | Owner, admin and two recruiters listed with roles |
| 13 | Operator | **Audit Logs**, prefix `identity.invitation` / `organization_membership` | A row for each invitation and acceptance with actor and organisation |

## J2 — Operations suspends the employer

**Preconditions:** J1 done; the recruiter has one **published** job and one **draft**.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Student | Browse jobs | The published job is listed with "About UAT Logistics Pvt" |
| 2 | Operator | **Suspend…** `POLICY_VIOLATION` | Request filed; still VERIFIED |
| 3 | Approver | **Settings → Approvals → Approve…** | Approved |
| 4 | Operator | **Execute** | SUSPENDED; the published job is **PAUSED**, the draft untouched; audit `opportunity.paused` |
| 5 | Student | Browse jobs; open the job's direct link | Job not listed; direct link refused |
| 6 | Recruiter 1 | Reload the portal | Status page; every employer screen refused with `EMPLOYER_ORGANISATION_INACTIVE` and a reference |
| 7 | Owner | Open **Team**, **Company Profile** | Refused (only the status is readable) |
| 8 | Owner | Try to invite, publish, open applicants (API or screen) | All refused; nothing written, nothing emailed |
| 9 | Operator | **Verify** (reinstate) | VERIFIED |
| 10 | Recruiter 1 | Reload | Workspace back; the job is still **PAUSED** |
| 11 | Recruiter 1 | Republish the job | Students see it again |

## E-S — Unverified employer

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | Create `UAT Startup Pvt`, leave it PENDING; invite its owner | Invitation created |
| 2 | Owner | Sign in | Workspace shows an "awaiting verification" notice |
| 3 | Owner | Create a draft job; edit the company profile; invite a recruiter | All allowed |
| 4 | Owner | Publish the draft | Refused `EMPLOYER_ORGANISATION_UNVERIFIED` |
| 5 | Owner | Open Applicants / candidate screens | "Available once your organisation is verified" |
| 6 | Operator | **Reject** the organisation (via UNDER_REVIEW) | REJECTED |
| 7 | Owner | Reload | Status page only; drafts, team and profile refused |

## E-T — Team rules

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Owner | Invite a second address as **Owner** | Not offered / refused |
| 2 | Owner | Invite the admin's address again | Refused `TEAM_MEMBER_ALREADY_EXISTS` |
| 3 | Owner | **Resend** recruiter 2's pending invitation, `LINK_LOST` | New link; old link refused when used |
| 4 | Admin | **Revoke** an admin invitation | Not allowed |
| 5 | Admin | **End membership** of recruiter 1, `ACCESS_NO_LONGER_NEEDED` | Recruiter 1's next request is refused; past actions remain in audit |
| 6 | Owner | **End membership** of self while the only owner | Refused (the last owner cannot be removed) |
| 7 | Other employer's recruiter | Call UAT Logistics' team route with its id | Refused 403 |
| 8 | Anyone | Accept an invitation signed in as a different verified email | Refused with a generic message |

## E-P — Company profile

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Admin | **Company Profile**: About, Industry, Company size, Careers page on the company website → **Save profile** | Saved; audit row |
| 2 | Admin | Careers page on another domain | Refused |
| 3 | Admin | About text asking students to pay a registration fee | Refused with a clear message |
| 4 | Admin | Try to change the legal or display name (API) | Refused `COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED`; stored values unchanged |
| 5 | Student | Open a job | "About UAT Logistics Pvt" shows the text; a missing description says so instead of inventing one |
| 6 | Student (Android) | Open the same job | Same company block |

## Results

| Script | Date | Environment | Result | Notes / references |
|---|---|---|---|---|
| J1 | | | | |
| J2 | | | | |
| E-S | | | | |
| E-T | | | | |
| E-P | | | | |
