# ONE Employer Portal — UAT scripts V1

> What this is: executable acceptance scripts for the employer journeys in Appendix 2 §9 (J1–J11),
> plus supplementary scripts so that every shipped employer module (EMP-01 to EMP-17) has at least
> one. Why it exists: EMP-18 requires every shipped module to have a UAT script. The first version
> (2026-09-26, base `6864332`) covered the EM1 slice only; this version covers everything shipped
> since. Journeys keep the plan's numbering; each says honestly whether it can be run today.
> Updated 2026-10-01 against base `719eb34`.

## Rules for running these scripts

- **Synthetic data only**: `@uat.example.test` accounts and `UAT …` organisations. No real
  person, company, college or production data. No pilot data exists.
- **Environment**: local stack or staging with a **non-production** Cognito pool. Journeys that
  create, suspend, invite, switch flags or export are never run against production
  (`https://oneby8.com`); only Divakar touches production.
- **Email**: the SMTP sender is built (ADR-042) but **not switched on in production**, and the
  sender mailbox is still to be set up. Locally enable the loopback Mailpit sink to receive
  invitations and notices; otherwise the screen and the delivery rows say "not configured", which
  is correct behaviour.
- **Background worker**: student and employer notices, interview calendar emails and the deadline
  close are delivered by the automation worker after the action commits. Run it locally for J4,
  J5, E-L and E-N. It is not deployed on AWS yet.
- **Uploads**: résumé uploads are off on AWS until a virus scanner exists. Run résumé steps
  locally with file storage configured.
- **Flags**: `employer.skill-evidence` (J10) and `employer.talent-pool` (J11) ship **off**.
  Switch them on only on a non-production environment, through **Operations → Feature Flags**
  with the second-person (or solo cool-off) approval.
- **Readiness**: no step expects to see a readiness band, score, mastery or gap on any employer
  screen. Seeing one anywhere is a **Fail** of that step.
- Record Pass / Fail per step with the on-screen reference for any failure.

## Personas

| Persona | Account | Role |
|---|---|---|
| Operator | `operations.admin@uat.example.test` | OPERATIONS_ADMIN |
| Approver | `ops.super@uat.example.test` | PLATFORM_SUPER_ADMIN (second person for dual control and high-risk flags) |
| Owner | `emp.owner@uat.example.test` | EMPLOYER_OWNER of `UAT Logistics Pvt`, invited in J1 |
| Admin | `emp.admin@uat.example.test` | EMPLOYER_ADMIN, invited in J1 |
| Recruiter 1, 2 | `emp.recruiter1@uat.example.test`, `emp.recruiter2@uat.example.test` | RECRUITER, invited in J1; recruiter 2 is the interviewer |
| Other employer's recruiter | `recruiter@uat.example.test` | RECRUITER of `UAT Other Employer` |
| Placement officer | `placement.officer@uat.example.test` | Placement officer of `UAT College`, institution-wide scope |
| Student A | `student.one@uat.example.test` | Rostered at `UAT College`, CSE, verified CGPA 8.0, no active backlogs |
| Student B | `student.two@uat.example.test` | Rostered at `UAT College`, ECE, self-reported CGPA 7.5, no backlogs |
| Student C | `student.three@uat.example.test` | Rostered at `UAT College`, ME, verified CGPA 6.5, 2 active backlogs |

`UAT Logistics Pvt`'s website on record is `https://uat.example.test`, so its careers page must
be on that host. `example.test` is a reserved domain and never delivers outside the local sink.
The marks above are seeded test fixtures for these synthetic accounts, not real records.

## Summary

| # | Journey (Appendix 2 §9) | Status | Modules | SOP |
|---|---|---|---|---|
| J1 | Operations onboards an employer; owner invites an admin and two recruiters | Built — ready to run | EMP-01, EMP-02 | [workspace](../employer/sop-employer-workspace-and-status.md), [team](../employer/sop-employer-team.md) |
| J2 | Operations suspends the employer | Built — ready to run | EMP-03, EMP-05 | [workspace](../employer/sop-employer-workspace-and-status.md), [ops organizations](../ops/sop-organizations.md) |
| J3 | Job with CGPA, backlog and department rules and three stages | Built — ready to run | EMP-06, EMP-07 | [eligibility](../employer/sop-employer-eligibility-and-stages.md), [candidates](../employer/sop-employer-candidates-and-offers.md) |
| J4 | Screen, shortlist, interview, scorecard; student notified | Built — ready to run locally with the worker; calendar email needs the production sender | EMP-08, EMP-09 | [interviews](../employer/sop-employer-interviews.md), [notifications](../employer/sop-employer-hiring-notifications.md) |
| J5 | Pay changed after applications | Built — ready to run | EMP-05 | [job lifecycle](../employer/sop-employer-job-lifecycle.md) |
| J6 | Campus drive approved with one-offer-per-student | Built — ready to run. The milestone's "one real drive with a pilot college on staging" cannot be run: no pilot college or pilot data exists | EMP-11 | [campus drives](../employer/sop-employer-campus-drives.md) |
| J7 | Employer assessment at the Assessment stage | Built — ready to run | EMP-12 | [assessments](../employer/sop-employer-assessments.md) |
| J8 | Student withdraws and revokes sharing | Built — ready to run (résumé step locally) | EMP-07, EMP-10, EMP-SR-01 | [candidates](../employer/sop-employer-candidates-and-offers.md), [messages](../employer/sop-employer-messages.md) |
| J9 | Export of shortlisted candidates | Built — ready to run | EMP-17 | [exports](../employer/sop-employer-exports.md) |
| J10 | Evidence shared for two of five skills | Built, flag off by default — enable `employer.skill-evidence` on a non-production environment to run (HG-4 approved) | EMP-13 | [skill evidence](../employer/sop-employer-skill-evidence.md) |
| J11 | Discovery opt-in and invite | Built, flag off by default — enable `employer.talent-pool` on a non-production environment to run. Consent wording is a legal draft (**HG-6 pending**): run only with the draft version, never on production | EMP-14 | [talent pool](../employer/sop-employer-talent-pool.md) |
| E-S | Unverified employer drafts but cannot publish or see candidates | Built — ready to run | EMP-03 | [workspace](../employer/sop-employer-workspace-and-status.md) |
| E-T | Team role rules and last-owner protection | Built — ready to run | EMP-02 | [team](../employer/sop-employer-team.md) |
| E-P | Company profile and verified fields | Built — ready to run | EMP-04 | [company profile](../employer/sop-employer-company-profile.md) |
| E-L | Job pause, close, reopen, withdraw, deadline close | Built — ready to run (deadline step needs the worker) | EMP-05 | [job lifecycle](../employer/sop-employer-job-lifecycle.md) |
| E-C | Candidate Detail, contact details and résumé link | Built — ready to run locally (uploads off on AWS) | EMP-07 | [candidates](../employer/sop-employer-candidates-and-offers.md) |
| E-N | Offer notices, reminder and the employer's answer notice | Built — ready to run locally with the worker | EMP-08 | [notifications](../employer/sop-employer-hiring-notifications.md) |
| E-M | Messages: start, limits, links, report | Built — ready to run | EMP-10 | [messages](../employer/sop-employer-messages.md) |
| E-R | Dashboard and suppressed reports | Built — ready to run | EMP-15 | [dashboard and reports](../employer/sop-employer-dashboard-and-reports.md) |
| E-X | Terms, Settings and trust-case response | Built — ready to run (terms text is a legal draft, HG-6) | EMP-16 | [terms and trust](../employer/sop-employer-terms-and-trust.md) |

Every shipped module has at least one script: EMP-01 J1 · EMP-02 J1, E-T · EMP-03 J2, E-S ·
EMP-04 E-P · EMP-05 J5, E-L · EMP-06 J3 · EMP-07 J3, J8, E-C · EMP-08 J4, E-N · EMP-09 J4 ·
EMP-10 J8, E-M · EMP-11 J6 · EMP-12 J7 · EMP-13 J10 · EMP-14 J11 · EMP-15 E-R · EMP-16 E-X ·
EMP-17 J9.

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
| 1 | Student A | Browse jobs | The published job is listed with "About UAT Logistics Pvt" |
| 2 | Operator | **Suspend…** `POLICY_VIOLATION` | Request filed; still VERIFIED |
| 3 | Approver | **Settings → Approvals → Approve…** | Approved |
| 4 | Operator | **Execute** | SUSPENDED; the published job is **PAUSED**, the draft untouched; audit `opportunity.paused` |
| 5 | Student A | Browse jobs; open the job's direct link | Job not listed; direct link refused |
| 6 | Recruiter 1 | Reload the portal | Status page; every employer screen refused with `EMPLOYER_ORGANISATION_INACTIVE` and a reference |
| 7 | Owner | Open **Team**, **Company Profile** | Refused (only the status, and trust cases, are readable) |
| 8 | Owner | Try to invite, publish, open applicants, export, message (API or screen) | All refused; nothing written, nothing emailed |
| 9 | Student A | Open a screening test this employer sent earlier (if any) | Marked unavailable; start refused `ASSESSMENT_UNAVAILABLE` |
| 10 | Operator | **Verify** (reinstate) | VERIFIED |
| 11 | Recruiter 1 | Reload | Workspace back; the job is still **PAUSED** |
| 12 | Recruiter 1 | Republish the job | Students see it again |

## J3 — Eligibility rules and three stages; eligible students apply with a snapshot

**Passes when** ineligible students see the exact failing rule and eligible students apply with a
snapshot.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Opportunities → Create draft** `UAT Graduate Engineer`, audience All students | Draft |
| 2 | Recruiter 1 | **Opportunity Detail → Eligibility, skills and stages**: blocking rules minimum CGPA 7.0, maximum active backlogs 0, department in CSE, ECE; stages Screening, Interview, Offer → **Save new version** | Version 2; version 1 unchanged in *Version history* |
| 3 | Recruiter 1 | Add a rule naming a protected attribute (for example "female candidates only") | Refused `ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE` |
| 4 | Recruiter 1 | **Publish** | Published |
| 5 | Student C | Open the job; try to apply | Each rule marked; apply refused `ELIGIBILITY_NOT_MET` naming the CGPA, backlog and department rules; nothing written |
| 6 | Student A | Open the job; review what will be shared (name, education, qualifications without marks, links, résumé choice); apply | Applied; snapshot stored |
| 7 | Student B | Apply | Applied (self-reported CGPA counts) |
| 8 | Recruiter 1 | **Applicants** | Both listed; Student A *Meets every rule (college records)*; Student B's CGPA rule marked **Self-reported**; no mark or figure shown anywhere |
| 9 | Recruiter 1 | **Applicants** on Student A | Stages ahead offered as Screening, Interview, Offer in order |
| 10 | Recruiter 1 | **Candidate Detail** for Student A | The snapshot exactly as reviewed in step 6; no email or phone yet (not shortlisted) |

## J4 — Screen, shortlist, interview, scorecard; student notified

**Preconditions:** J3 done; worker running locally; recruiter 2 is a team member.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | Move Student A to Screening, then Shortlisted | Student gets an "Application update" notice each time |
| 2 | Owner | **Interviews → Scorecard templates → New scorecard template** with three criteria | Template listed |
| 3 | Owner | Attach the template to the Interview stage (Eligibility, skills and stages) | New job version; template shown on the stage |
| 4 | Recruiter 1 | Move Student A to Interview; **Schedule interview** with recruiter 2 as participant, joining link `https://meet.uat.example.test/a`, a preparation note | Scheduled; template copied to the interview |
| 5 | Student A | Notifications; **Your interviews** | "Interview scheduled" in their time zone; **Add to calendar** downloads an `.ics` with the link |
| 6 | Recruiter 2 | Open their interviews | Sees this interview only; downloads the `.ics` |
| 7 | Admin | Open the same interview | Sees that a link exists, not the link itself |
| 8 | Recruiter 1 | **Reschedule** with `SCHEDULING_CONFLICT` | Student and recruiter 2 each told once; the `.ics` has the same UID and a higher SEQUENCE; history shows who, when, why |
| 9 | Recruiter 1 | Try to reschedule into the past, or without a reason | Refused; nothing written |
| 10 | Recruiter 2 | **Record outcome** missing one criterion | Refused; then with all three criteria — saved |
| 11 | Recruiter 1 | **Scorecards** | Recruiter 2's scorecard per criterion; no total or score |
| 12 | Operator | Delivery rows for the emails | `NOT_CONFIGURED` when no sink is set up; in-app notices present |

## J5 — Pay changed after applications

**Preconditions:** J3 done with Students A and B applied.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Opportunity Detail → Edit job**, raise the pay → **Save new version** | New version; version history shows it |
| 2 | Recruiter 1 | **Applicants** | Both marked *Awaiting new-terms acceptance* |
| 3 | Recruiter 1 | Try to move Student B forward or **Send offer** | Refused `TERMS_ACKNOWLEDGEMENT_REQUIRED` (reject still possible) |
| 4 | Student B | **Review new terms** | Shows the terms applied under beside the new ones; **Accept the new terms** |
| 5 | Recruiter 1 | Move Student B forward | Allowed |
| 6 | Student A | **Decline and withdraw** | Application withdrawn; employer access ends (J8 behaviour) |
| 7 | Recruiter 1 | Change only the deadline | New version; nobody asked to accept |
| 8 | Recruiter 1 | Edit from a stale page after someone else saved | Refused `OPPORTUNITY_VERSION_CONFLICT` |

## J6 — Campus drive with placement-office approval and one offer per student

**Preconditions:** `UAT College` verified; placement officer signed in; Student B has an accepted
offer from another UAT job.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | Create `UAT Campus Analyst` with **Who can see it: Only colleges that approve a campus drive**; publish | Published, reaches nobody; the screen says so |
| 2 | Student A | Browse jobs; open the job's direct link | Not listed; refused |
| 3 | Recruiter 1 | **Opportunity Detail → Campus drives → Request a campus drive**, `UAT College` → **Send request** | Drive REQUESTED |
| 4 | Recruiter 1 | Try to approve it (API) | No such route for an employer |
| 5 | Placement officer | **Placement policies → Put this policy in force** (one offer per student) | Policy in force |
| 6 | Placement officer | *Campus drive approvals* → **Approve** | Drive APPROVED |
| 7 | Student A | Browse jobs | Listed with the "Campus drive" tag; applies |
| 8 | Student B | Open the job | Policy shown and that it stops them; Apply disabled; API apply refused `PLACEMENT_POLICY_ONE_OFFER`; nothing written |
| 9 | A student at another college | Browse | Not listed |
| 10 | Placement officer | **Withdraw approval** with a reason | Job gone for UAT College students on the next request; Student A's application stands |
| 11 | Recruiter 1 | **Mark complete** (after re-approval) | The college sees counts only after completion, `<5` for small cells, and names only of students who shared their application with the college |

## J7 — Employer assessment at the Assessment stage

**Preconditions:** a job with an Assessment stage; Student A applied.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Assessments → Write a question** ×3 → **Send for review** | Under review |
| 2 | Recruiter 1 | Approve own question | Refused (author cannot approve) |
| 3 | Recruiter 2 | **Approve** all three | Ready to use |
| 4 | Recruiter 1 | **Build a test** (10 minutes) → **Create test** → **Publish** | Published |
| 5 | Recruiter 1 | **Send to applicants** while Student A is still Applied | Refused `APPLICATION_NOT_AT_ASSESSMENT_STAGE` |
| 6 | Recruiter 1 | Move Student A to Assessment; send with a 1-day window | Sent; Student A told in-app |
| 7 | Student A | Open the test | Brief: formats, marks, minutes actually available, no camera or microphone; will not start without ticking agreement |
| 8 | Student A | Start; answer one question; wait past the time limit; answer another | The late answer refused; the saved answer graded |
| 9 | Recruiter 1 | **Results** | Candidates in invitation order, not by score; audited |
| 10 | Other employer's recruiter | Request the results of this test, and Student A's per-question results | 403 both |
| 11 | Recruiter 1 | **Close test** without a reason, then with `SCREENING_COMPLETE` | Refused, then closed; sent invitations stay open until their window ends |

## J8 — Student withdraws and revokes sharing

**Preconditions:** Student A shortlisted on a job, with a résumé in the snapshot (local, uploads
on), a conversation started (E-M) and an interview scheduled.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | Candidate Detail; request a résumé link (do not open it) | 60-second link issued |
| 2 | Student A | **My applications → Withdraw** | Withdrawn |
| 3 | Recruiter 1 | Open the résumé link from step 1 | Refused |
| 4 | Recruiter 1 | Reload Applicants, Interviews, Offers | Row kept with stage; person shown as *Details no longer shared* |
| 5 | Recruiter 1 | Candidate Detail; a new résumé link; the conversation; send a message; move stage | All refused 403 |
| 6 | Recruiter 1 | **Cancel interview** with `CANDIDATE_WITHDREW` | Allowed; history withholds the person |
| 7 | Student A | Open the conversation | Read-only copy |
| 8 | Owner | **Export applicants** | Student A not in the file |
| 9 | Operator | Audit Logs for the application | The withdrawal is recorded; no `application.resume_downloaded` row after it |

## J9 — Export of shortlisted candidates

**Preconditions:** a job with one Applied, two Shortlisted (one whose name starts `@`, one whose
headline starts `=`), and one withdrawn applicant; owner has accepted terms if published.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | Look for **Export applicants** | Not shown; API refused 403 |
| 2 | Owner | **Export applicants**, no reason | Refused `REASON_CODE_REQUIRED` |
| 3 | Owner | Reason `SHORTLIST_REVIEW`, all open applicants | File downloads; the Applied row has no email or phone; Shortlisted rows have them; the withdrawn student is absent |
| 4 | Owner | Open the file in a spreadsheet | `@` and `=` cells begin with an apostrophe and show as text; phone `'+91…` |
| 5 | Owner | Export with **Shortlisted onward** | Only the two shortlisted rows |
| 6 | Owner | Check headers | No readiness, identifier, roll number, compensation or protected attribute column |
| 7 | Operator | Audit `employer.applicants.exported` | Actor, reason, scope, row count, withheld count, application ids, SHA-256 matching the `X-Export-Sha256` header |
| 8 | Owner | 21st export within 24 hours (API loop) | Refused `EXPORT_RATE_LIMITED`; nothing written |

## J10 — Evidence shared for two of five skills (flag off by default)

**Preconditions (non-production only):** Approver and Operator switch on `employer.skill-evidence`
(high-risk; second person). A job with five catalogue skills; Student A holds qualifying evidence
for three of them.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Student A | Before the flag: open the job's apply preview | No evidence offered |
| 2 | Operator, Approver | Enable the flag through the approval | Enabled; audited |
| 3 | Student A | Apply, ticking evidence for **two** skills | Applied; only those two shared |
| 4 | Recruiter 1 | **Candidate Detail → Evidence** | Two skills list type, source, date, unaided; three say "no evidence shared"; no score, band, count, percentage or stage anywhere |
| 5 | Recruiter 1 | **Applicants**, filter *Has shared verified evidence for* one shared skill | Student A kept, list order unchanged; filter use audited |
| 6 | Student A | Take back one item | Recruiter's next panel read no longer lists it |
| 7 | Operator | Disable the flag | Employer panel shows nothing; Student A can still see and take back what was shared |

## J11 — Discovery opt-in and invite (flag off by default; HG-6 pending)

**Preconditions (non-production only):** `employer.talent-pool` switched on with the second
person; the seeded **draft** consent version in use. Never run on production while HG-6 is
pending.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Talent Pool** before the flag | *Not available yet*; nothing read |
| 2 | Student B | **Profile → Talent pool**: read the notice, join, tick evidence, branch, year, one city → **Save my card**; check the preview | Joined; consent recorded at the current version; visibility employer discovery |
| 3 | Recruiter 1 | Search with no filter; with `?gender=` (API) | Refused `FILTER_REQUIRED`; refused `UNKNOWN_FILTER` |
| 4 | Recruiter 1 | **Filter** by a skill Student B showed → **Search the talent pool** → **Open card** | Card shows a reference, skills and the chosen fields only; no name, contact, college, identifier, readiness, score or count |
| 5 | Other employer's recruiter | Same search | A different card reference for the same student |
| 6 | Owner | Create an invite-only job; on the card **Invite to apply** → **Send invitation** | Sent; Student B told in-app |
| 7 | Recruiter 1 | **Applicants** of that job | Empty — identity not known yet |
| 8 | Student B | Open the invitation; apply | Applied with a snapshot |
| 9 | Recruiter 1 | **Applicants**; the talent pool's invitations list | Student B listed with their snapshot; the invitation shows Applied |
| 10 | Student B | **Leave the talent pool** | Next search no longer finds them |

## E-S — Unverified employer

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | Create `UAT Startup Pvt`, leave it PENDING; invite its owner | Invitation created |
| 2 | Owner | Sign in | Workspace shows an "awaiting verification" notice |
| 3 | Owner | Create a draft job; edit the company profile; invite a recruiter; write a screening question; create a scorecard template | All allowed |
| 4 | Owner | Publish the draft | Refused `EMPLOYER_ORGANISATION_UNVERIFIED` |
| 5 | Owner | Open Applicants / candidate screens, Reports, Talent Pool, Export | "Available once your organisation is verified" / refused `EMPLOYER_ORGANISATION_UNVERIFIED` |
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
| 5 | Student A | Open a job | "About UAT Logistics Pvt" shows the text; a missing description says so instead of inventing one |
| 6 | Student A (Android) | Open the same job | Same company block |

## E-L — Job lifecycle

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Pause** a published job | Students stop seeing it; apply refused |
| 2 | Recruiter 1 | **Reopen** | Listed again |
| 3 | Recruiter 1 | **Close** without a reason; then `ENOUGH_APPLICANTS` | Refused; then closed — no new applications, existing applicants carry on |
| 4 | Recruiter 1 | **Withdraw** while an application is open | Refused; decide every applicant, then withdraw `ROLE_CANCELLED` — final |
| 5 | Recruiter 1 | Publish a job whose deadline is a few minutes away; wait past it (worker running) | Closed with `DEADLINE_PASSED`, once; reopen refused `OPPORTUNITY_DEADLINE_PASSED` |
| 6 | Recruiter 1 | Edit a live job adding "pay a registration fee" | Refused `OPPORTUNITY_PAYMENT_DEMAND` |
| 7 | Recruiter 1 (Android) | Roles | Each job's state (paused, closed, draft, withdrawn), version and closed date shown read-only |

## E-C — Candidate Detail and résumé

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | Candidate Detail for an Applied candidate | Snapshot; no contact details |
| 2 | Recruiter 1 | Shortlist; reload | Email and phone shown; view audited |
| 3 | Recruiter 1 | Request a résumé link; open it | File downloads as an attachment; link and download audited |
| 4 | Recruiter 1 | Open the same link again; open it after 60 seconds; Recruiter 2 opens Recruiter 1's link | All refused |
| 5 | Other employer's recruiter | Candidate Detail with their own employer id and this application id | 403 |
| 6 | Recruiter 1 | An application made before snapshots | "No snapshot", never the live profile |
| 7 | Recruiter 1 | Reject the candidate; **Share feedback** with two listed reasons | Candidate sees the reasons, never the internal reason or note; employer access to the person ends |

## E-N — Offer notices

**Preconditions:** worker running locally.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Send offer** expiring in 3 days | Student told "Offer from UAT Logistics Pvt" with the deadline |
| 2 | — | Advance to a day before expiry (worker) | One reminder; never a second |
| 3 | Student | Accept | Recruiter 1 gets an in-app notice naming no candidate and no email |
| 4 | Owner | End recruiter 1's membership; repeat 1–3 with another offer recruiter 1 made earlier | The owners are told instead |
| 5 | Recruiter 1 | **Withdraw offer** on another offer | Student told "Offer withdrawn" |
| 6 | Student | Turn hiring emails off; trigger a notice | In-app notice; email recorded `SKIPPED` |

## E-M — Messages

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | Try to start a conversation with an Applied candidate | Not allowed (`NOT_SHORTLISTED`) |
| 2 | Recruiter 1 | Shortlist; **Send** a message | Sent; student told "Message from UAT Logistics Pvt" without the text |
| 3 | Recruiter 1 | Send two more without a reply; then a fourth | Fourth refused `MESSAGE_AWAITING_REPLY` |
| 4 | Student | Reply; recruiter sends a message containing `https://uat.example.test/x` | Link flagged on both sides, not clickable; "never pay a fee" warning |
| 5 | Recruiter 1 | Send 2,001 characters, or an attachment field (API) | Refused; nothing written |
| 6 | Student | **Report** a message as `SCAM_OR_PAYMENT_REQUEST` | Case opened HIGH with the thread as evidence; employer told nothing |
| 7 | Operator | **Trust and Safety** → the case → **Reported conversation** | Thread visible; read audited |
| 8 | Other employer's recruiter | Read this conversation with their own employer id | 403 |

## E-R — Dashboard and reports

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Recruiter 1 | **Dashboard** | Open jobs, new applicants in 7 days, interviews this week, offers awaiting an answer and drives awaiting a college equal the counts in Opportunities, Applicants, Interviews, Offers and Campus drives |
| 2 | Recruiter 1 | **Reports** | Funnel by job, college and drive; small cells read `<5`; colleges with fewer than 5 applications folded into "Other colleges or not stated"; no candidate names |
| 3 | Recruiter 1 | `GET …/reports?gender=F` (API) | Refused `UNKNOWN_FIELD` |
| 4 | Other employer's recruiter | Reports for UAT Logistics' id | 403 |
| 5 | Operator | Audit | `employer.reports.viewed` row per report read |

## E-X — Terms, Settings and trust cases

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Organizations → Manage employer terms → Publish version** as material, legal review *draft* | Published; labelled "Draft — pending legal review" everywhere |
| 2 | Recruiter 1 | Publish a draft job | Refused `EMPLOYER_TERMS_NOT_ACCEPTED`; a job already live stays live |
| 3 | Admin | **Settings → Employer terms** accept (screen or API) | Not offered / refused 403 (owner only) |
| 4 | Owner | Accept | Accepted; recruiter 1's publish now succeeds |
| 5 | Operator | Open a trust case about UAT Logistics; **Ask for response** with a summary and reason | Case awaiting response |
| 6 | Admin | **Settings → Trust and safety cases → Open** | The operator's summary and own-job evidence only; no reporter |
| 7 | Admin | **Respond to the case** → **Send response** | Case under investigation; operator timeline shows the response |
| 8 | Operator | Decide; Owner **Appeal the decision** once, then tries again | First appeal recorded on the timeline; second refused |
| 9 | Operator | Suspend the employer; Owner opens Settings trust cases | Trust cases still readable and answerable |

## Results

| Script | Date | Environment | Result | Notes / references |
|---|---|---|---|---|
| J1 | | | | |
| J2 | | | | |
| J3 | | | | |
| J4 | | | | |
| J5 | | | | |
| J6 | | | | |
| J7 | | | | |
| J8 | | | | |
| J9 | | | | |
| J10 | | | | |
| J11 | | | | |
| E-S | | | | |
| E-T | | | | |
| E-P | | | | |
| E-L | | | | |
| E-C | | | | |
| E-N | | | | |
| E-M | | | | |
| E-R | | | | |
| E-X | | | | |
