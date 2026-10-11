# Employer baseline

> EMP-00: the employer portal as it really is on the base branch, and defects D-1…D-9 checked against code, so EMP goals fix what exists.

Date: 2026-09-25 · Base: feat/plan-phases-0-to-2 @ d6687f2 (copied from OPS-00). `ehc` =
apps/api/src/http/employer-hiring.controller.ts; `onb` = operations-institution-onboarding.controller.ts.

## 2.2 Employer API (actual)

Confirmed: opportunities create/list/audiences/publish (ehc:97, 124, 142, 161); applicants list and
transition (:191, :217); 8 interview routes; offers get/create/withdraw (:609, :635, :672);
hiring-analytics (:699–760); student side browse/detail/apply/revoke/withdraw/offers/respond
(student-hiring.controller.ts:169–500).
Corrections / additions: applicant-access check lives in phase1-security.controller.ts:45 (not the
hiring controller); plan omits candidate feedback (ehc:283, :297; 0035), employer assessments
(employer-assessments.controller.ts, 0036), and student `/students/me/applications`, application
feedback and external applications. Apply is one transaction (application, history, grant, audit,
outbox). Student listing/detail never look at the employer organisation's state.

## 2.3 Recruiter navigation (actual; labels match rolePortalConfig.ts:150)

Working: Dashboard (counts computed client-side from the first 4 jobs with applicants — under-counts;
staffDashboardsV3.tsx:173–202), Opportunities, Applicants, **Assessments (working — plan says otherwise)**,
Interviews, Offers (EmployerStageWorkspace), Reports, Help & FAQ. **Opportunity Detail** = the same list
(regex, employer.tsx:47) — no detail page. Candidate Detail and Talent Pool = unfiltered Applicants list
(D-7; App.test.tsx:243 codifies it). Team, Messages, Company Profile, Settings = "Not built yet".
Placement officer has no Drives/Companies item (rolePortalConfig.ts:117).

## 2.4 Defects

| ID | Verdict | Statement | Evidence |
|---|---|---|---|
| D-1 | **Confirmed — reproduced** (see log) · web only | `workspaceForMembership` maps only RECRUITER; EMPLOYER_OWNER/ADMIN → null → "No active ONE workspace", /employer/* denied. Screens already accept all three roles; Android maps EMPLOYER* correctly | App.tsx:559–570 (:565), 521–533; employer.tsx:33; StaffDashboards.kt:76 |
| D-2 | Confirmed | No employer invitation/team route; `canAssignRole` only in the in-memory services.ts | services.ts:199, 599, 698–716; onb:238, 575–578 |
| D-3 | **Confirmed — reproduced** (see log) · broader | Suspension sets `verification_state='SUSPENDED', active=false` but no membership changes; every employer guard checks membership only (hiring, participant guard, assessments, applicant access); students still see/apply to suspended employers' jobs; **REJECTED keeps active=true**; PENDING unrestricted | onb:227; identity-authentication.ts:46–82; ehc:52–78, 349–356, 771–783; employer-assessments.controller.ts:597–607; employer-authentication.ts:22–38; student-hiring.controller.ts:176–193, 288–295 |
| D-4 | Confirmed | application_profile_snapshots created (0007/0008), never referenced | 0008:144–148 |
| D-5 | Confirmed (nuance) | Eligibility/skills/stages tables never written or enforced, but read (empty) on student detail | student-hiring.controller.ts:226–228, 300–307 |
| D-6 | Confirmed | Notification kinds exam-only; interview/offer/application events reach outbox only; no /students/me/interviews on any client | 0013:16; notify.ts:6; ehc:269, 533, 668 |
| D-7 | Confirmed | Applicant rows: name, email, institution student id, state, counts, dates; no résumé/profile | ehc:200–212, 912–929 |
| D-8 | Confirmed | No edit/version/pause/close/reopen; publish accepts PAUSED but nothing sets it | ehc:166–168 |
| D-9 | **Corrected — no longer a defect** | Employer assessments exist on their own tables (0036) with bank, publish, invitations, results, attempts and a web page. EMP-12 becomes gap-filling | 0036:1–40; employer-assessments.controller.ts; rolePortalPages.tsx:306–309 |

## Reproduction

Specs (become the first commits of EMP-01 / EMP-03 with their fixes, never earlier):
`d1-employer-admin-workspace.repro.test.tsx` → apps/web/src/employerWorkspace.test.tsx;
`d3-suspended-org-publish.repro.test.ts` →
apps/api/src/http/employer-organisation-state.integration.spec.ts. Run results are in the progress log.

Manual D-1: create EMPLOYER org (ops), verify, issue initial-admin invitation, accept; sign in → callback
shows "No active ONE workspace"; /employer/recruiter → access denied.
Manual D-3: recruiter of a VERIFIED employer drafts a job + PUBLIC audience; ops suspends
(reason REPRO_D3); DB shows SUSPENDED/active=false; recruiter publish → 201 PUBLISHED (expected 403); new
job + applicants list also succeed; students still list the job; repeat for PENDING and REJECTED.

## Other corrections

- EMP-03 must key on `verification_state`, not only `active` (REJECTED stays active), and cover
  employer-assessments:597, the participant guard (ehc:52–78), my-interviews (:353–355) and
  employer-authentication.ts.
- Initial-admin invitation does not check verification state (onb:238–261).
- `InvitationRole` excludes EMPLOYER_OWNER (onb:22); email subject keyed on EMPLOYER_ADMIN (:645).
- `listApplicants` does not check the access grant (ehc:198–212); create/audience/publish run separate
  statements with audit outside a transaction (ehc:107–183).
- EMP-01 needs no Android change for the role mapping.
