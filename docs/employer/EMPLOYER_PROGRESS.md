# Employer portal progress

> Goal reports for the employer plan (docs/employer/EMPLOYER_PORTAL_PLAN.md), newest last, in the plan's Section 0.6 format.

Base branch: **feat/plan-phases-0-to-2** — the most advanced non-main branch; it contains all of
integration plus the plan-phase work. Chosen 2026-09-25 (OPS-00); head c802d3b after PRG-FIX.
Repository: PVUD14/ONE-V4 (private). Goal branches are cut from the base and merged back into it;
main and production are released by Divakar only.

## EMP-00 — Employer baseline and defect reproduction — 2026-09-25
**Result:** Complete. docs/employer/EMPLOYER_BASELINE.md. D-1…D-9 marked (Confirmed D-1–D-8, D-9 Corrected
— employer assessments now exist). Reproduction run on c802d3b, specs copied in temporarily then deleted:
D-1 web — 4 fail as expected (owner/admin land on /auth/callback, not /employer/recruiter; deep link;
chooser), 2 controls pass; one deep-link failure message is a draft-fixture label — tidy when EMP-01
commits the spec. D-3 API — 5 fail as expected (publish after suspension 201 not 403; new job/applicants;
students still see the job; PENDING and REJECTED publish), 2 controls pass.
**Next goal in workstream:** EMP-01.

## EMP-01 — Employer workspace for owners and admins — 2026-09-25
**Result:** Complete — owners and admins land in the employer portal, and operations now invites an employer's first user as its owner.
**Branch / PR:** fix/emp-owner-admin-workspace → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits 22312e8 (reproducing test), ecb1b53 (fix).
**Files created:** apps/web/src/employerWorkspace.test.tsx (the EMP-00 D-1 reproduction, fixture label tidied: the deep-link case now asserts the access decision before the page content).
**Files modified:** apps/web/src/App.tsx (workspaceForMembership maps EMPLOYER_OWNER / EMPLOYER_ADMIN to the employer portal with a role label; one employer entry per organisation, broadest role wins — as Android's classifyWorkspaces already does); apps/web/src/rolePortal/employer.tsx (Team and Settings tell a recruiter they are managed by the owner or admin — display only); apps/api/src/http/operations-institution-onboarding.controller.ts (first employer invitation → EMPLOYER_OWNER; InvitationRole includes EMPLOYER_OWNER; employer email subject for both employer roles); apps/api/src/http/api-security.integration.spec.ts (new invitation test; the test mail sink also records the subject).
**Migrations added:** none.
**Design docs / ADRs:** none needed (no table, no new decision beyond 10.2 #1).
**Validation:** fresh database one_emp, `corepack pnpm db:migrate`; `corepack pnpm typecheck` pass (13 projects); `corepack pnpm -r --no-bail --workspace-concurrency=1 test` pass — web 26 files / 377 tests, api 22 / 368, persistence 14 / 163, ai-orchestration 19, assessments 15, authorization 60, career-readiness 17, events 12, hiring 60, identity 25, learner-content 7, privacy 20, automation 7; `corepack pnpm build` pass. D-1 spec: 4 fail / 2 pass on the base, 10 / 10 pass after the fix.
**Acceptance criteria:**
- [x] Owner, admin and recruiter each land in the employer workspace (`lands an EMPLOYER_ADMIN/EMPLOYER_OWNER…`, `still lands a RECRUITER…`); multi-workspace users still see the chooser (`offers both workspaces to an employer admin who also administers an institution`).
- [x] A user with only an institution role still cannot reach the employer workspace (`keeps an institution-only identity out of the employer workspace`).
- [x] Operations invitations for new employers create EMPLOYER_OWNER (`invites the first user of an employer as its owner and leaves existing admin invitations alone`: invitation row, scope, email subject, acceptance → ACTIVE EMPLOYER_OWNER membership visible in /security/context; a pre-existing EMPLOYER_ADMIN invitation still accepts as EMPLOYER_ADMIN).
- [x] Owner/admin-only screens (Team, Settings) check the role client-side for display only; the server remains the authority (web tests for recruiter vs owner/admin).
**Decisions for Divakar:** 10.2 #1 taken as recommended (first employer user is EMPLOYER_OWNER; existing invitations unaffected). Where one person holds two employer roles in the same organisation, the web chooser shows one employer entry labelled with the broader role (owner > admin > recruiter), matching Android.
**Android:** no change needed — classifyWorkspaces (StaffDashboards.kt) already maps every EMPLOYER* role and RECRUITER to the employer workspace, one entry per organisation; the app has no operations invitation screen.
**Limitations / not done:** Team and Settings remain "Not built yet" for owners and admins (EMP-02, EMP-16). The initial-admin invitation still does not check the organisation's verification state (baseline note; not in EMP-01's scope).
**Risks / follow-ups:** none new.
**Next goal:** EMP-03 (stacked on this branch), then EMP-02.
