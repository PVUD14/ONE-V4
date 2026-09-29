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

## EMP-03 — Enforce employer organisation state — 2026-09-25
**Result:** Complete — suspended, rejected and unverified employers are refused per Appendix 2 §5.1 on every employer route, students no longer see or reach them, and suspension pauses published jobs.
**Branch / PR:** fix/emp-organisation-state (stacked on fix/emp-owner-admin-workspace) → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits 2ac773e (reproducing test), c389a48 (fix), 0f0c221 (status read hardening).
**Files created:** apps/api/src/http/employer-organisation-state.ts (requireActiveEmployer, the §5.1 helper; employerInGoodStandingSql for the student side); apps/api/src/http/employer-organisation-state.integration.spec.ts (the EMP-00 D-3 reproduction plus the state × action matrix and pause tests); apps/web/src/rolePortal/employerOrganisationState.tsx (status gate and plain status page, existing pilot/V2 components only); apps/web/src/employerOrganisationState.test.tsx; apps/android/app/src/main/java/pro/ai8ht/one/EmployerOrganisationState.kt.
**Files modified:** employer-hiring.controller.ts (every route through the helper with an action group; participant guard, my-interviews list and the interview-assignment predicate check the organisation; new GET /employers/:employerId/organisation-status; publish re-checks state in the UPDATE under a share lock); employer-assessments.controller.ts (bank/drafts = draft, publish = publish, invitations/results = candidates); student-hiring.controller.ts (listing, detail and apply require a verified, active employer); calendar.controller.ts (interviewer slots only for verified, active employers); operations-institution-onboarding.controller.ts (suspension pauses published jobs in the same transaction, audit + outbox per job; localized to the verification route); packages/persistence/src/employer-authentication.ts (applicant-access grants usable only while the employer is verified and active); packages/events/src/index.ts (opportunity.paused v1 registered); employer-hiring.controller.test.ts (fixture answers the new state read as a verified employer and keeps it out of the recorded queries — assertions unchanged; publish fixture gains the row the guarded UPDATE returns); packages/persistence/test/employer-authentication.integration.test.ts (grant refused in SUSPENDED, REJECTED, PENDING, UNDER_REVIEW); apps/web/src/api/hiring.ts; apps/web/src/rolePortalPages.tsx (employer dashboard, assessments and recruiter pages wrapped in the gate); apps/android/.../StaffDashboards.kt.
**Migrations added:** none (0037 not touched; no number claimed).
**Design docs / ADRs:** none — no new table; the rule is Appendix 2 §5.1 and decision 10.2 #3 as written.
**Validation:** fresh database one_emp_final, `corepack pnpm db:migrate` pass; `corepack pnpm typecheck` pass (13 projects); `corepack pnpm -r --no-bail --workspace-concurrency=1 test` — api 23 files / 382 tests pass, persistence 14 / 167 pass, ai-orchestration 19, assessments 15, authorization 60, career-readiness 17, events 12, hiring 60, identity 25, learner-content 7, privacy 20, automation 7 all pass; web 383 / 384 in that run — the one failure was a 20 s timeout in the pre-existing demo test "resolves every visible navigation item for every new role without disabled nav" (14.2 s alone on this branch, 15.8 s on EMP-01; not touched by this goal); web re-run at the same head `corepack pnpm test` in apps/web: 27 files / 384 tests pass. `corepack pnpm build` pass. D-3 spec on its own commit: 5 fail / 2 pass (as EMP-00 recorded); after the fix 14 / 14 pass. Android: `./gradlew :app:compileDebugKotlin` and `:app:assembleDebug` pass (Android Studio JBR).
**Acceptance criteria:**
- [x] Suspended or rejected organisation → 403 on every employer write and candidate read: `refuses every employer route to a SUSPENDED/REJECTED organisation, and says why` (25 routes, code EMPLOYER_ORGANISATION_INACTIVE), plus the D-3 cases and the grant check in persistence. REJECTED is caught although it keeps active = true.
- [x] Unverified organisation → can draft, cannot publish, cannot read candidates: `lets a PENDING/UNDER_REVIEW organisation draft but not publish or reach candidates` (creates a draft and audience, lists it, publish 403, every candidate route 403 EMPLOYER_ORGANISATION_UNVERIFIED).
- [x] Suspension pauses published jobs and students no longer see them: `pauses on suspension, hides the job and its applicants, and keeps it paused on reinstatement` (PAUSED, drafts untouched, audit + opportunity.paused outbox, student list/apply refused, reinstatement keeps PAUSED, republish restores visibility); `hides and refuses a published job whose employer is rejected, unverified or inactive, even without a pause`.
- [x] All pre-existing employer tests still pass (integration fixtures already seed VERIFIED employers; unit fixture models a verified employer).
- [x] Plain status page for suspended and rejected employers, navigation unchanged (web tests; Android equivalent).
**Decisions for Divakar:** 10.2 #3 taken as recommended. Also decided: (a) a member can always read their own organisation status (new read-only route) — §5.1 allows it in every state; (b) interview participants and the interviewer calendar follow the organisation state like recruiters; (c) refusals carry EMPLOYER_ORGANISATION_INACTIVE / _UNVERIFIED instead of the bare FORBIDDEN so clients can explain — it reveals nothing beyond the caller's own organisation's state; (d) listing own opportunities counts as drafting, so unverified employers can see their drafts, suspended ones cannot.
**Android:** changed — the employer app reads the organisation status; suspended/rejected employers see a status screen on Home and Roles (More, help and sign-out stay reachable), unverified employers see an "Awaiting verification" notice. Workspace role mapping needed no change.
**Limitations / not done:** responding to a trust case from the status page waits for EMP-16 (the page says so). Student-side screening-assessment attempts for a suspended employer's already-issued invitations are not blocked (the employer cannot read results; follow-up). Apply does not lock the organisation row (the job is paused in the suspension transaction and the employer cannot read candidates, so a racing apply is harmless).
**Risks / follow-ups:** the demo navigation test in App.test.tsx runs 14–16 s against a 20 s budget and can time out on a loaded machine — worth splitting.
**Next goal:** EMP-02.

## EMP-02 — Employer team management and interviewer invitations — 2026-09-25
**Result:** Complete — employer owners and admins can see their team, invite admins and recruiters (interviewers join as recruiters), revoke or resend invitations and end memberships, with every change audited; the web Team label is live and Android has a read-only Team view.
**Branch / PR:** feat/emp-team → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits ea2ce63 (acceptance tests), 9c9f39e (implementation).
**Files created:** apps/api/src/http/employer-team.controller.ts (GET /employers/:employerId/team, POST …/team-invitations, POST …/team-invitations/:invitationId/revoke, POST …/team-invitations/:invitationId/resend, POST …/team/:membershipId/end); apps/api/src/http/employer-team.integration.spec.ts; apps/web/src/rolePortal/employerTeam.tsx; apps/web/src/rolePortal/employerTeam.test.tsx; apps/android/app/src/main/java/pro/ai8ht/one/EmployerTeam.kt.
**Files modified:** apps/api/src/application/identity-organization/services.ts (canAssignRole exported, unchanged); apps/api/src/http/api-security.module.ts (controller registered); packages/events/src/index.ts (identity.invitation.revoked v1, organization_membership.ended v1); apps/web/src/api/hiring.ts (team client); apps/web/src/rolePortal/employer.tsx (only the Team label's branch); apps/web/src/rolePortal/shared.tsx (plain messages for the team error codes); apps/web/src/employerWorkspace.test.tsx (the EMP-01 case that expected "Not built yet" on Team for owners/admins now expects the live screen; the recruiter case is unchanged); apps/android/.../StaffDashboards.kt (Team overlay and Home entry; StatCell made internal); apps/android/.../EmployerWork.kt (EmployerOverlay.Team).
**Migrations added:** none. 0041 not claimed: the invitations table (kind STAFF, delivery_state, send_count, last_sent_at, reason_code from 0037) and organization_memberships (state ENDED) are enough.
**Design docs / ADRs:** none. No new table; the decisions are recorded here and in the controller header.
**Validation:** fresh database one_emp02; `corepack pnpm db:migrate` run twice, pass both times; `corepack pnpm typecheck` pass; `corepack pnpm -r --no-bail --workspace-concurrency=1 test` exit 0: web 31 files / 413 tests, api 26 / 461, persistence 16 / 187, ai-orchestration 19, assessments 15, authorization 93, career-readiness 17, events 12, hiring 60, identity 25, learner-content 7, privacy 20, automation 7, all passing; `corepack pnpm build` pass. The new API spec ran 27/27 three times in a row. Android: `./gradlew --no-daemon -q :app:compileDebugKotlin` pass (Android Studio JBR). The test commit was not run on its own against the base; the routes did not exist there, so it cannot pass.
**Acceptance criteria:**
- [x] Owner can invite an admin and a recruiter; admin can invite a recruiter only; recruiter cannot invite (`lets an owner invite an admin and a recruiter, but not another owner`, `lets an admin invite a recruiter only`, `refuses a recruiter every team route`). canAssignRole is the rule, exported and used unchanged.
- [x] The last active owner cannot be removed (`refuses to end the only owner, including by themselves`, `lets one of two owners end the other, then keeps the remaining owner`, `never lets two owners end each other at the same time and leave nobody`). Owners are locked before the target, so concurrent ends cannot leave the employer without an owner.
- [x] Accepting an invitation creates the right membership and scope, through the existing /invitations/accept path (`turns an accepted recruiter invitation into an ACTIVE employer-scoped RECRUITER…`, `…EMPLOYER_ADMIN who can then invite recruiters`, `refuses acceptance by an identity whose verified email is not the invited one`).
- [x] Every invite, revoke, resend and end is audited with actor, organisation and reason code, plus outbox rows (`audits the invitation and records its delivery`, `revokes a pending invitation…`, `resends with a new link…`, `ends a membership: access stops on the next request, past actions stay in audit…`).
- [x] Ending a membership revokes access immediately (the next request is 403, and the person drops out of interview participant options); their past audit rows remain.
- [x] §6.3 minimum tests: other employer, ended membership and suspended membership → 403; SUSPENDED and REJECTED employers → 403 EMPLOYER_ORGANISATION_INACTIVE on every team route and nothing is sent; 401 without a token; validation 400s (unknown field, email, role, reason, uuid, limit, cursor); keyset pagination; no readiness, score or internal text in responses; web real data, empty, error and forbidden states; navigation labels unchanged.
**Decisions for Divakar:**
1. **Action group.** Team management is `organisation.manage` (Appendix 2 §5.1: "company profile, team"). PENDING and UNDER_REVIEW employers can set up their team before verification. SUSPENDED and REJECTED employers are refused every team route, including reading the team list; they can still read their organisation status. Invite and resend re-read the state under a row lock, so a suspension that lands mid-request sends nothing.
2. **Decision 10.2 #2 adopted.** Interviewers are invited as recruiters. There is no "interviews only" flag, and there will not be one unless Divakar approves it. The Team screen says so, and an accepted recruiter appears in the interview participant options.
3. **Ending and revoking.** Ending a membership follows canAssignRole, plus one addition: an owner may end another owner. An admin cannot end an admin or an owner. An admin cannot revoke or resend an admin invitation. Self-removal is allowed only for an owner who is not the last one.
4. **Duplicates.** You cannot invite someone who already holds any active or suspended role in the employer (409 TEAM_MEMBER_ALREADY_EXISTS). To change someone's role, end their membership and invite them again. A second pending invitation to the same address is refused (409). A pending invitation that has expired is closed as EXPIRED when a new one is issued.
5. **Resend** mints a new link and restarts the 14 days, so the earlier link stops working.
6. **Reason codes** come from fixed lists. Revoke: SENT_IN_ERROR, WRONG_EMAIL, WRONG_ROLE, NO_LONGER_NEEDED. Resend: NOT_RECEIVED, LINK_EXPIRED, LINK_LOST. End: LEFT_ORGANISATION, ROLE_CHANGE, ACCESS_NO_LONGER_NEEDED, SECURITY_CONCERN. An invitation needs no reason; its role is audited.
7. **Email (HG-7).** Team invitations follow the staff-invitation pattern and send in-request through the configured sink. With no sink, the invitation is recorded NOT_CONFIGURED and both the screen and the API say it was not emailed. A sink failure keeps the invitation and records FAILED or BOUNCED, and a resend can retry. Until HG-7 is decided, production has no sink, so a team invitation cannot reach anyone there. This is the same situation staff invitations are in today.
**Android:** changed. The employer Home screen has a Team entry that opens a read-only Team view: members with their roles, open invitations with their delivery state and expiry. A recruiter gets the server's 403 and is told Team is managed by the owner or admin. Changes stay on the web, like posting and publishing roles, because each change needs a confirmation and a reason code.
**Limitations / not done:** pending invitations in the team list are capped at the 200 most recent (a flag says when the list is cut); members are keyset-paginated. The web employer page still resolves the caller's membership as the first employer membership in the security context. A person who is both a recruiter and an owner of one employer could therefore see the recruiter message on Team. The server acts with their broader role, so nothing is wrongly allowed. Ending a membership does not remove the person from interviews already scheduled; they lose access at once because participant access requires an active membership. Changing a role in place is not built: end the membership and invite again.
**Risks / follow-ups:** the demo navigation test in App.test.tsx is still slow (it passed in this run).
**Next goal:** EMP-04.

## EMP-04 — Company profile and employer access request — 2026-09-25
**Result:** Complete — owners and admins keep a student-facing company profile, students see it on every job (web and Android), and a company can ask for employer access through a public form that creates nothing but a pending request in the Operations queue.
**Branch / PR:** feat/emp-company-profile → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits 4abe094 (design), 83f6b2d (acceptance tests), a13bdc2 (implementation).
**Files created:** docs/architecture/employer-access-requests-table-design.md; packages/persistence/drizzle/0041_employer_company_profile_and_access_requests.sql; apps/api/src/http/employer-company-profile.controller.ts (GET/POST /employers/:employerId/company-profile); apps/api/src/http/employer-access-requests.controller.ts (public POST /employer-access-requests; GET /operations/employer-access-requests; POST /operations/employer-access-requests/:requestId/decision); apps/api/src/http/employer-company-profile.integration.spec.ts; apps/web/src/rolePortal/employerCompanyProfile.tsx (+ test); apps/web/src/publicEmployerAccessPage.tsx (+ test, which also covers the Operations queue); apps/web/src/rolePortal/operationsEmployerAccessRequests.tsx; apps/android/.../EmployerCompanyProfile.kt.
**Files modified:** apps/api/src/http/api-security.module.ts (two controllers registered); apps/api/src/http/student-hiring.controller.ts (a `company` block on every opportunity in the listing and the detail); packages/events/src/index.ts (organization.company_profile.updated v1, employer_access_request.submitted v1); apps/web/src/rolePortal/employer.tsx (only the Company Profile label's branch); apps/web/src/App.tsx (public /employer-access route, a "Request employer access" link on sign-in); apps/web/src/rolePortal/operations.tsx (queue section on the Organizations screen); apps/web/src/hiringPages.tsx (About-the-company card on job detail, company name and industry in the list); apps/web/src/api/hiring.ts, api/operations.ts (clients); apps/web/src/rolePortal/shared.tsx (plain messages for the new codes); apps/web/src/App.test.tsx, hiringPages.test.tsx (new tests only); apps/android/.../ApiStudent.kt, StudentHiring.kt (company on job detail), EmployerWork.kt, StaffDashboards.kt (Company profile overlay and Home entry).
**Migrations added:** 0041_employer_company_profile_and_access_requests.sql (number assigned by the coordinator; idempotent, `db:migrate` run twice on a fresh database). Adds four employer-only columns to organization_profiles (about_text, industry, company_size_band, careers_page_url) with a second trigger refusing them on non-employers (the 0005 trigger is untouched); employer_access_requests; employer_access_request_attempts; seeds feature flag `employer-access.allow-free-mail` (off).
**Design docs / ADRs:** docs/architecture/employer-access-requests-table-design.md, written and committed before the migration. No ADR number claimed: parallel goals may be taking ADR-033; the public-write decision and its rejected options are in the design note. If an ADR is wanted, number it at merge.
**Validation:** fresh database one_emp04; `corepack pnpm db:migrate` twice, both pass; `corepack pnpm typecheck` pass; `corepack pnpm -r --no-bail --workspace-concurrency=1 test` exit 0 — web 33 files / 425 tests, api 27 / 481, persistence 16 / 187, ai-orchestration 19, assessments 15, authorization 93, career-readiness 17, events 12, hiring 60, identity 25, learner-content 7, privacy 20, automation 7, all passing. The App-level sign-in → /employer-access test was added after that run started; a web re-run (`corepack pnpm test` in apps/web) passed 33 files / 426 tests. `corepack pnpm build` pass. New API spec 20/20. Android: `./gradlew --no-daemon -q :app:compileDebugKotlin` pass (Android Studio JBR). The test commit was not run on its own against the base; the routes did not exist there, so it cannot pass.
**Acceptance criteria:**
- [x] Students see the company profile on every job: `carries the company block in the listing and the detail of a published job` (API; the Operations contact email is not exposed); web `shows the verified company profile on the job, list and detail` and `says a description is missing instead of inventing one`; Android job detail shows "About <company>".
- [x] A legal-name change is refused from the employer side: `refuses a legal-name change, and every other field Operations verifies, from the employer side` (403 COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED for legalName, displayName, websiteUrl, city, countryCode, primaryContactEmail, addressLine1; stored row unchanged). The web form has no such fields.
- [x] Access requests appear in the Operations Organizations queue as pending: `shows requests as pending to Operations only, with possible matches, and records a decision without verifying anything`; web `shows pending requests with their review signals…`.
- [x] Company Profile screen: owners and admins edit, recruiters view (`lets an owner and an admin edit…, and a recruiter only read them`; web owner and recruiter tests).
- [x] The request creates no account and publishes nothing until Operations verifies: `records a pending request and creates nothing else — no user, organisation, membership or invitation`; ONBOARDED leaves the organisation's verification state untouched.
- [x] Rate-limited; no free-mail unless Operations allows: `rate-limits by network address and by email domain…` (429 after 5 per address per hour and 10 per domain per day; only 64-hex digests stored), `refuses a public webmail address unless Operations allows it, then flags it`.
- [x] No enumeration: `answers identically for a repeat and for a company already on ONE`.
- [x] §6.3 minimums: other employer, ended and suspended membership → 403; SUSPENDED/REJECTED → 403 EMPLOYER_ORGANISATION_INACTIVE on read and write; PENDING/UNDER_REVIEW may edit; 401 without a token; validation 400s; queue pagination bounds (limit 1–200, cursor, state) and 401/403; audit row on every profile write and decision; no readiness or score keys in the profile response; web real data, NA / "Not provided", error and suspended states; navigation labels unchanged (`leaves every other unbuilt label saying so`).
**Decisions for Divakar:**
1. **Action group.** Company-profile read and write are `organisation.manage` (§5.1 "company profile, team"): PENDING/UNDER_REVIEW employers set the profile up before verification; SUSPENDED/REJECTED can neither read nor write it. Owners and admins edit; recruiters read (§5.1 role matrix "view"). The write re-reads organisation state under a row lock.
2. **What the employer may change — by field, not state.** Employer-editable: about, industry (fixed list), size band, careers page. Operations-only: legal name, display name, website, address, country, contact email — the details verification is done against, so a verified record cannot silently change (the display name is exactly what an impersonator would change). Rejected: re-review on edit (would pull every job off students' screens for a typo) and a pending-change approval queue (a second workflow nobody needs yet).
3. **Careers page** must be on the Operations-held website's host or a subdomain; with no website on record it is refused. **About text** goes through the publish-time payment-demand detector (§5.8).
4. **Operations' existing PATCH** keeps writing only its own columns, so an Operations edit does not wipe the employer's description (tested).
5. **Access request safety:** 202 `{received: true}` for every well-formed submission; the route never reads organizations; limits 5 per address per hour, 10 per domain per day, 200 per hour overall; client address = socket peer, or the right-most X-Forwarded-For entry when the peer is loopback or private (our Caddy proxy); webmail refused unless the flag `employer-access.allow-free-mail` is on (then accepted and flagged). Decisions ONBOARDED (linked to an employer the operator created; never creates or verifies), DECLINED, SPAM, each with fixed reason codes; capability OPS_ORG_MANAGE.
6. **Audit for anonymous submissions:** audit_events requires an actor, so a submission is recorded by its row plus an actor-less outbox event; operator decisions are audited.
7. **Queue placement:** a section of the existing Organizations screen; no navigation change.
**Android:** changed — employer Home has a "Company profile" entry opening a read-only view (how students see the company, the verified details, "edit on the web"); a suspended or rejected employer is told it is unavailable. Student job detail shows the company. The public access request is web-only: the app serves signed-in users, a prospective employer has no account, and the form is reachable from any browser.
**Limitations / not done:** logo (needs the file store and scanner configured; no column added until upload exists). No email confirmation of the requester (HG-7 — no production sender); the queue says every request's email is unconfirmed. Retention of declined and spam requests (proposed 180 days) is not yet in the privacy worker. No notifier consumes employer_access_request.submitted yet. The Organizations page's existing Edit prompt sends a partial profile and can null address fields — pre-existing, not changed here.
**Risks / follow-ups:** if a proxy with a public address is ever put in front of the API, the per-address limit collapses to a per-proxy limit (the overall cap still holds) — revisit clientAddress then. Suite runtimes were long in this run (shared local Postgres), not a code issue.
**Next goal:** EMP-18 (EM1 slice), then EMP-05.

## EMP-SR-01 / EMP-SR-02 — Candidate data requires a live applicant-access grant — 2026-09-26
**Result:** Complete — every employer read or write of one candidate's data now checks the student's applicant-access grant at request time through one shared persistence check; revoking, expiring or entering deletion stops the next request. EMP-SR-02 revocation-on-deletion is fixed; expiry after close is recorded as a decision, not built.
**Branch / PR:** fix/emp-applicant-access-grant → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits bb9ddc6 (tests), 170bc70 (fix).
**Files created:** apps/api/src/http/employer-applicant-access.integration.spec.ts.
**Files modified:** packages/persistence/src/employer-authentication.ts (`liveApplicantGrantCondition`, `applicationHasLiveApplicantGrant`, `assertEmployerApplicationAccess`; the probe assertion now uses the shared predicate); packages/persistence/src/repositories.ts (`hasEmployerApplicantAccess` and `assertActiveEmployerGrantForMutation` use the same predicate); apps/api/src/http/employer-hiring.controller.ts; apps/api/src/http/employer-assessments.controller.ts; apps/api/src/http/privacy-deletion.ts; apps/api/src/http/employer-hiring.controller.test.ts (the reschedule fixture row carries the grant it needs; no assertion changed); packages/persistence/test/employer-authentication.integration.test.ts (new deletion case); apps/web/src/api/hiring.ts, hiringPages.tsx (+ test), rolePortal/employer.tsx, employerAssessmentsPage.tsx; apps/android/.../Api.kt, ApiEmployer.kt, EmployerWork.kt, StaffDashboards.kt.
**Migrations added:** none.
**Design docs / ADRs:** none; decisions below.
**Validation:** fresh database one_secemp2 (one_secemp's DROP stalled behind a checkpoint on the shared container, so a new name was used); `corepack pnpm db:migrate` twice, pass both; `corepack pnpm typecheck` pass; `corepack pnpm -r --no-bail --workspace-concurrency=1 test` exit 0 — api 39 files / 692 tests, web 42 / 526, persistence 22 / 266, and every other package passing; `corepack pnpm build` pass. Android `./gradlew --no-daemon -q :app:compileDebugKotlin` pass. The test commit alone: 6 of the 7 new API cases fail against the base (the seventh pins an exemption that already held).
**Routes and what they now do:**
- Grant required, 403 on failure: POST applications/:id/transition (checked and share-locked in the write transaction), POST applications/:id/interviews, POST applications/:id/offers, POST interviews/:id/outcome, POST my-interviews/:id/outcome, POST interviews/:id/state for RESCHEDULED / COMPLETED / NO_SHOW, POST assessments/:id/invitations (the existing 400 APPLICATION_NOT_INVITABLE still comes first for closed or withdrawn applications).
- Person withheld per row when no live grant (id and state kept, `candidateAccess: false`): GET opportunities/:id/applications, GET interviews, GET offers, GET my-interviews, GET my-interviews/:id (brief keeps the slot and role, loses name, email, roll number, location and link; `canRecordOutcome` false). GET assessments/:id/results drops the row entirely, as it already did for revoked consent.
- Exempt, by design: POST interviews/:id/state CANCELLED and POST offers/:id/withdraw (they only stand the employer down and return nothing about the person); POST applications/:id/feedback (only allowed on REJECTED, which is what revokes the grant; it sends information to the candidate, not to the employer); GET hiring-analytics, GET opportunities, GET assessments (counts only, no individual rows); GET interview-participant-options (the employer's own team); GET candidate-feedback-reasons (catalogue). The calendar's employer entries already carry no candidate identity.
**Acceptance criteria:**
- [x] A revoked grant gives 403 on the next write and no person in any read: `withholds the person from every read and refuses every write on the next request after the grant is revoked` (also checks nothing was written).
- [x] An active grant is allowed on every route: `serves the candidate to every route while the grant is live`.
- [x] Expiry and rejection/close behave the same: `treats an expired grant as no grant`, `withholds the person once the employer rejects them, and still lets the employer release feedback`.
- [x] One shared check, no controller SQL variant: all routes use `applicationHasLiveApplicantGrant` / `assertEmployerApplicationAccess`, which both use `liveApplicantGrantCondition`.
- [x] Existing employer specs pass unchanged; the only fixture change adds the grant flag the reschedule unit test needs.
- [x] EMP-SR-02 deletion: `withholds the person while a deletion request is open, and restores the view if the student cancels it`, `revokes every grant when the deletion is executed`, persistence `refuses a live grant during an open deletion request…`.
**Decisions for Divakar:**
1. **Lists withhold, writes refuse.** A list with one ungranted row still loads, with that person withheld (the review's own recommendation, and the existing withdrawn-candidate contract). The participant brief is withheld rather than refused for the same reason: the existing withdrawn-candidate test expects it.
2. **Deletion.** An open DELETION request (RECEIVED / IN_PROGRESS), a DELETION_PENDING or DELETED account, or an anonymised one gives no employer access. The open request is a condition, not a revocation, because the student may cancel in the grace period; executing the deletion revokes every grant first, so a failed run has still closed access.
3. **Expiry after close (decision 10.2 #7, proposed 180 days) — not built.** Closing already revokes the grant at once, which is stricter than 180 days, so an expiry adds nothing today. It becomes needed only if a closed application should keep a time-limited view (EMP-07); that is a product decision.
4. **Order of checks.** State and rule checks keep their existing 400 codes (CONSENT_REVOKED, INVALID_TRANSITION, APPLICATION_NOT_INVITABLE); the grant check follows them and returns the controller's existing safe 403. The assessments controller's 403 body is `{code, correlationId}`, the hiring one adds `message`; neither was changed.
**Android:** changed. Interview, brief and offer DTOs had a non-null `candidateName`, so a withheld (null) name would have failed to decode; they are now nullable with `consentRevoked` / `candidateAccess`, and every candidate name slot uses `candidateLabel` ("Details no longer shared", "Withdrawn — details no longer shared"). 403s on writes were already surfaced as notices.
**Limitations / not done:** the reads that withhold use an unlocked EXISTS; writes outside a transaction (extend offer, employer scorecard) check without a lock, as before for consent. EMP-SR-16 (interviewer outcome route skipping closed checks) is separate and untouched, though the grant now also guards that route.
**Next goal:** coordinator's choice.

## EMP-05 — Job lifecycle: edit, pause, close, reopen — 2026-09-26
**Result:** Complete. Employers can now edit a job, which saves a new immutable version. They can also pause, close, reopen or withdraw it, and a job closes on its own when its deadline passes. When an edit changes the terms someone applied under, that applicant has to accept the new terms before the employer can move them on.
**Branch / PR:** feat/emp-job-lifecycle → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits d0bb65d (acceptance tests) and eeb2897 (implementation), cut from fc700af. A trial merge onto 7804fcd (EMP-SR-01/02) had no conflicts. On that merge, typecheck passed for api and web, and the lifecycle, hiring and student specs passed 65/65.
**Files created:**
- packages/hiring/src/opportunity-lifecycle.ts (lifecycle table, editable states, reason-code lists, term-change classification) and test/opportunity-lifecycle.test.ts.
- packages/persistence/src/opportunity-deadlines.ts: the deadline job, both the scheduler write and the outbox consumer.
- apps/api/src/http/employer-job-lifecycle.controller.ts (EmployerJobLifecycleController and StudentTermsChangeController) and employer-job-lifecycle.integration.spec.ts.
- apps/web/src/rolePortal/employerOpportunityDetail.tsx, with its test.

**Files modified:**
- employer-hiring.controller.ts:
  - Publish now runs in one transaction with its audit and outbox rows. The audit row now carries organisation_id. Publish is refused if the job's state changed or its deadline passed.
  - The version insert and the review-signal recording are exported so the lifecycle controller can reuse them.
  - The applicant list gains termsAcknowledgementPending.
  - Pending-terms checks count only rows where acknowledgement_required is set.
  - An offer is refused while a term change is pending.
  - The opportunity list gains closedAt and versionNumber.
- student-hiring.controller.ts: apply re-reads the job FOR SHARE inside its transaction and re-checks that it is PUBLISHED and before its deadline. The pending-terms count respects acknowledgement_required.
- api-security.module.ts.
- packages/events: opportunity.version.created, opportunity.lifecycle.changed, opportunity.deadline_close.requested, and application.terms_change.recorded / acknowledged / declined, all v1.
- packages/persistence automation-workers.ts: routes the deadline events to their consumer.
- packages/hiring index.ts: one new rule code.
- Web:
  - api/hiring.ts.
  - hiringPages.tsx: a Details button on each Opportunities row, a "new terms pending" tag on Applicants, and the student's "Review new terms" card.
  - rolePortal/employer.tsx: only the Opportunity Detail label's branch.
  - rolePortal/shared.tsx: error messages.
- student-hiring.controller.test.ts: the fixture answers the new locked re-read. No assertions changed.
- Android: Api.kt, ApiStudent.kt, JobsAndMore.kt, StaffDashboards.kt.

**Migrations added:** none. 0055 was not claimed: the 0007 tables already carry everything needed (opportunity_versions, opportunity_term_change_acknowledgements with acknowledgement_required, and the lifecycle CHECK).
**Design docs / ADRs:** none, because no table was added. The decisions are recorded below and in the controller header.
**Validation:** fresh database one_emp05_v.
- `corepack pnpm db:migrate`: the first run applied 47, the second applied 0 (47 already applied).
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: exit 0, every package passing. Web 40 files / 718 tests, api 44 / 547, persistence 25 / 284. The other packages also passed, including hiring 9 / 178, which contains the 22 new lifecycle tests. The new API spec ran 20/20.
- `corepack pnpm build`: passed.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR): passed.

**Acceptance criteria:**
- [x] Editing creates a new version and old versions stay intact. Tests: `inserts version 2, keeps version 1 byte-for-byte, and keeps applicants bound to the version they applied to` and `carries skills, stages and eligibility forward to the new version`. A stale edit gets 409 OPPORTUNITY_VERSION_CONFLICT.
- [x] Applicants are asked to acknowledge material changes and cannot progress until they do.
  - `asks each open applicant to accept a pay change, blocks progress and offers, and lets them through once they accept`. This also covers a stale acknowledgement (409 TERMS_CHANGED_AGAIN), other students getting 403, and rejection still being possible.
  - `withdraws the application when the applicant declines the new terms`: the grant is revoked and the history row records TERMS_DECLINED.
- [x] Closed or paused jobs accept no applications. Tests: `pauses: students stop seeing and applying…`, `closes with a reason code: no new applications…` and `refuses an application that was waiting on a close that then committed`. The student listing and detail already required PUBLISHED; apply now re-checks it under a lock.
- [x] POST …/pause, …/close, …/reopen and …/withdraw follow the lifecycle table, and close and withdraw require a reason code from a fixed list. Tests: `refuses transitions the lifecycle does not allow` and `withdraws only once every applicant is decided…`.
- [x] A scheduled job closes jobs whose deadline passed, idempotently. Test: `queues the close at the deadline and closes once, idempotently; a moved deadline supersedes it`. An early delivery throws and is retried, and a replay does nothing. Publishing or reopening a job whose deadline has passed returns OPPORTUNITY_DEADLINE_PASSED.
- [x] Opportunity Detail shows version history, current state and actions. Web tests are in employerOpportunityDetail.test.tsx. The navigation labels are unchanged: that label's branch now renders the detail instead of the list.
- [x] §6.3 minimums:
  - 401 without a token.
  - 403 for another employer, an ended membership, and another employer's job.
  - A SUSPENDED or REJECTED employer gets 403 EMPLOYER_ORGANISATION_INACTIVE on every lifecycle route.
  - A PENDING employer can edit and withdraw drafts, but gets 403 EMPLOYER_ORGANISATION_UNVERIFIED on pause, close and reopen.
  - An unknown field gets 400.
  - Audit rows carry the organisation and the reason code.
  - The detail response has no readiness, score or gap fields.
- [x] Security findings EMP-SR-15 and EMP-SR-08 are closed for the job lifecycle:
  - Each lifecycle write locks the organisation row FOR SHARE, re-applies the §5.1 rule and locks the job FOR UPDATE.
  - Audit and outbox rows are written in the same transaction as the change, and unknown fields are rejected.
  - Test: `refuses a reopen that was waiting on a suspension that then committed`.
  - Publish is transactional, and its audit row now carries organisation_id.

**Decisions for Divakar:**
1. **What counts as material.** Every material_terms_hash field (employment type, work mode, location, pay fields, duration, joining conditions, deadline) plus the version's eligibility rules. Title, summary and responsibilities are wording: changing them creates a version but asks applicants nothing.
2. **A deadline-only change is recorded without blocking anyone.** Its rows get acknowledgement_required = false. The deadline decides who may still apply, not what an applicant agreed to. This is a deliberate deviation: the plan lists the deadline as needing acknowledgement. A deadline change that comes with any other material change still needs it.
3. **What applicants are compared against.** Each applicant is compared with the terms they last accepted: the version they applied to, or the newest change they acknowledged. Accepting a newer version also settles every older pending change. applications.applied_version_id is never rewritten.
4. **Declining the new terms withdraws the application.** Consent and the grant are revoked, exactly as when the student withdraws.
5. **Lifecycle transitions:**
   - Pause: PUBLISHED→PAUSED.
   - Close: PUBLISHED or PAUSED→CLOSED. Existing applicants carry on.
   - Reopen: PAUSED or CLOSED→PUBLISHED. It needs an audience and a future deadline, and it clears closed_at.
   - Withdraw: from DRAFT, PUBLISHED, PAUSED or CLOSED. It is terminal, and it is refused while any application is still open, because nothing rejects applicants automatically.
   - The existing publish route still resumes a PAUSED job, which is EMP-03's reinstatement path.
6. **Action groups.** Edits and withdraw use `jobs.draft`. Editing a live job (published, paused or closed) also needs `jobs.publish` and runs the payment-demand refusal (OPPORTUNITY_PAYMENT_DEMAND). Pause, close and reopen use `jobs.publish`. Reading one job uses `jobs.draft`, like the list.
7. **Reason codes.**
   - Pause (optional): HIRING_ON_HOLD, REVIEWING_APPLICANTS, UPDATING_DETAILS.
   - Close: POSITION_FILLED, ENOUGH_APPLICANTS, HIRING_ON_HOLD, ROLE_CANCELLED, POSTED_IN_ERROR.
   - Withdraw: POSTED_IN_ERROR, ROLE_CANCELLED, DUPLICATE_POSTING, TERMS_INCORRECT.
   - The deadline job uses DEADLINE_PASSED.
8. **How the deadline job runs.** It is an outbox event whose available_at and occurred_at are the deadline (ADR-028). It is written whenever a version with a deadline becomes current on a published or paused job, and on publish and reopen. audit_events requires an actor, so the audit row records the person who set the deadline.
9. **Consistency with EMP-SR-01 (7804fcd).** The lifecycle routes return no per-candidate data to employers. The detail view gives counts only. The pending-terms flag sits on the applicant list, which EMP-SR-01's grant check already governs. The student terms-change routes are scoped to the student's own application.

**Android:** changed.
- Employer side: Roles and Home show paused, closed, draft and withdrawn states with their own chips, a note on the state, the closed date and the version number, and say that edits happen on the web. Changes stay web-only, like posting and publishing, because each one needs a confirmation and a reason.
- Student side: My applications shows "Terms changed" with a "Review new terms" button. It opens a dialog showing what the student applied under beside what the job says now, with Accept or Decline and withdraw.

**Limitations / not done:**
- No student notification is sent. The application.terms_change.recorded event is written so EMP-08 can deliver it.
- Skills, stages and eligibility are carried forward unchanged; they have no editor until EMP-06. Eligibility changes are already detected, so EMP-06 gets the acknowledgement step without extra work.
- The version history is capped at 200 versions per job.
- Android's terms dialog does not show the eligibility rules. It says they changed and points to the role.
- The pre-existing hiring writes outside the lifecycle (transition, interviews, offers) still have the EMP-SR-08 and EMP-SR-15 gaps. Those belong to EMP-07, EMP-08 and EMP-12.

**Risks / follow-ups:**
- Jobs published before this change have no deadline event. They still drop out of the student listing at the deadline, as before, but stay PUBLISHED until someone edits, publishes or reopens them. A one-off backfill could fix this if wanted.
- Deadline closes happen only while the worker is running.

**Next goal:** EMP-06.

## EMP-06 — Eligibility, required skills and selection stages — 2026-09-26
**Result:** Complete. Employers set eligibility rules, required and preferred skills, ordered stages and a catalogue role on a job, always as a new version. Apply refuses a student who fails a blocking rule and names that rule. The employer sees each applicant's eligibility as it stood at apply: each outcome and whether it rested on a verified, college or self-reported fact, never the figures. The applicant pipeline offers the job's stages in order.
**Branch / PR:** feat/emp-eligibility-stages → feat/plan-phases-0-to-2 (pushed to onev4; merge by review). Commits, in order: eb9f23a (design), e278b06 (tests), 30dbff4 (implementation), 91d814c (Android), then this report. Cut from 4ebcd3b.
**Files created:**
- docs/architecture/application-eligibility-evaluations-table-design.md
- packages/hiring/src/eligibility.ts, which holds the pure evaluator; packages/hiring/src/opportunity-requirements.ts, which holds input rules, the stage→state map and reason codes; and test/eligibility.test.ts
- apps/api/src/http/opportunity-requirements.ts (reads and writes), employer-skill-catalogue.controller.ts and employer-eligibility-stages.integration.spec.ts
- apps/web/src/hiringEligibility.ts (+ .test.tsx), plus rolePortal/employerOpportunityRequirements.tsx (+ .test.tsx)

**Files modified:**
- API: employer-job-lifecycle.controller.ts, employer-hiring.controller.ts, student-hiring.controller.ts and api-security.module.ts. The last one only registers the new controller.
- Web: api/hiring.ts, hiringPages.tsx, rolePortal/employerOpportunityDetail.tsx and rolePortal/shared.tsx. The shared.tsx change adds error messages only.
- Android: Api.kt, ApiStudent.kt, StudentHiring.kt, JobsAndMore.kt, StaffDashboards.kt and EmployerWork.kt.
**Migrations added:** 0054_opportunity_requirements_and_eligibility.sql (number claimed here):
- `application_eligibility_evaluations`. It is written once, and a trigger refuses any UPDATE.
- `opportunity_skill_requirements.taxonomy_topic_id`, nullable.
- `opportunity_versions.career_role_id`, nullable.

It is additive, idempotent and references only files numbered below 0054. Replaying the file twice by hand in psql succeeded.
**Design docs / ADRs:** the design doc above, which gives the reasons and the rejected options. No ADR.
**Validation:** fresh database one_emp06v, with only DATABASE_URL exported.
- `corepack pnpm db:migrate` ×2: the first run applied 48 and the second applied 0, both exit 0.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: exit 0.
  - api: 46 files / 563 tests.
  - web: 42 files / 739 tests.
  - persistence: 26 files / 293 tests.
  - hiring: 10 files / 201 tests, including 42 new evaluator and input tests.
  - Every other package passed too.
  - The new API spec ran 10/10.
- `corepack pnpm build`: passed.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR): passed.

**Acceptance criteria:**
- [x] A student below the CGPA or above the backlog limit cannot apply and is told which rule. Tests: `refuses a student below the CGPA and tells them which rule; nothing is written` (400 ELIGIBILITY_NOT_MET, whose `rules` field names MIN_CGPA) and `refuses a student above the backlog limit…`. A missing record gives ELIGIBILITY_UNKNOWN, and the student is told what is missing.
- [x] Self-reported values are flagged to the employer. Test: `uses a self-reported record where nothing is verified, and flags it to the employer without the figure`. The outcome carries `basis: SELF_REPORTED, flagged: true`, and the figure appears nowhere in the response. The flags are withheld with the person once the grant ends (EMP-SR-01).
- [x] Stages appear in the applicant pipeline in order. The applicant list returns `stages` with `applicationState`. On the web, Applicants offers the stages still ahead, labelled as the employer named them, and Android does the same.
- [x] Every edit goes through the versioning path. The versions route takes `eligibilityRules`, `skills`, `stages`, `careerRoleId` and `reasonCode`, and any field left out is carried forward. Version 1 stays untouched, it runs in EMP-05's locked transaction, and unknown fields get 400.
- [x] Evaluator unit tests cover scales (GPA_4 and PERCENTAGE are normalised at comparison only, while LETTER and PASS_FAIL are unknown), missing records, verified versus self-reported, the rejected-record rule, the current-college qualification and backlog sums.
- [x] §6.3:
  - 401 without a token.
  - 403 for another employer.
  - SUSPENDED gives 403 INACTIVE and PENDING gives 403 UNVERIFIED on a live-job edit.
  - Validation errors give 400.
  - The catalogue route caps `limit` at 200.
  - The audit row carries the organisation, `changedDetails` and the reason code.
  - Responses contain no readiness, mastery or score fields.
  - Web navigation labels are unchanged: the editor sits inside the existing Opportunity Detail page.
  - Pre-existing tests pass unchanged.

**Decisions for Divakar:**
1. **Self-reported values count, flagged.** The later plan (§5.4 and EMP-06 step 2) was followed over the frozen academic-records design, which said self-reported figures never satisfy a rule. Otherwise most students would be locked out until their college verifies. The employer always sees the basis.
2. **Unknown still blocks** a blocking rule, with a distinct code and message. This keeps the existing fail-closed rule.
3. **CGPA** comes from the latest numeric term of the student's qualification at their current college (otherwise their newest qualification). A verified term is preferred over a newer self-reported one. The value is compared as a 10-point equivalent with the same linear rule as `asCgpa10`, and a MIN_CGPA rule is always on the 10-point scale. **Backlogs** are the sum over verified terms, or over self-reported terms if no term is verified.
4. **WORK_AUTHORIZATION can never block**, like CUSTOM, because ONE records no such fact. One rule per type is allowed, except up to 5 CUSTOM rules. Text naming a protected attribute or proxy is refused with ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE, matched on whole words.
5. **The frozen evaluation stores outcome and basis, never figures.** It is re-evaluated only when an applicant accepts a version whose eligibility changed. A blocking failure at that point is a flag, never a rejection.
6. **Stages map to the fixed pipeline states.** GROUP_DISCUSSION maps to ASSESSMENT. The order must follow the pipeline, and an offer comes last. The transition route is not restricted to the stages: Shortlist and Reject stay available.
7. **Catalogue skills** are active taxonomy topics named by an active role's live requirements. The skill's name is the topic name, set by the server. Free-text skills are still allowed, are marked "not in the ONE catalogue", and are never matched by name.
8. **A live job's eligibility change requires a reason code**, from a fixed list of 8. For any other edit the reason code is optional.
9. **The web editor offers no INSTITUTION rule**, because it has no college picker (audiences already target colleges). Existing INSTITUTION rules are kept as they were set and shown by college name.

**Android:** changed. The student job detail could not have decoded jobs with skills or stages: it read them as plain strings and looked for the verdict in the wrong place. The DTOs are fixed. The student now sees each rule marked you meet / you don't, with its basis and what would fix an unknown. An apply refusal names the rule, and the terms dialog shows the eligibility rules before and after the change. On the employer side, Roles shows eligibility, skills and stages read-only (edits stay on the web), and the applicant page shows the eligibility flags and offers stage-labelled moves.

**Limitations / not done:**
- Interviews are not tied to a selection stage (interviews.selection_stage_id is unused).
- The student web app has no academic-records screen, so the web says "ask your college". Android points students to More › Academic record.
- The catalogue keyset cursor pages by name, so two topics whose names are equal ignoring case can be skipped.
- The job creation route does not take requirements; they are set by an edit, which creates version 2.

**Risks / follow-ups:**
- EMP-13 can now join job skills to evidence through taxonomy_topic_id.
- EMP-07's snapshot may want to reference the evaluation row.

**Next goal:** EMP-07.

## EMP-07 — Consented application snapshot and candidate view (2026-09-28)

Written by the coordinator: the goal's agent stopped on a usage limit after its code and tests were
committed but before it wrote this report. Merged in c4bcdb3 with EMP-08 and INST-10.

- **Built.** The student reviews exactly what they share before applying; the snapshot is written once
  at apply, last in the apply transaction, bound to the job version applied under, never edited
  (0058 hardens `application_profile_snapshots`). Employers read it on Candidate Detail, only while
  the live applicant-access grant holds. Résumés leave only through short-lived, single-use, audited
  download links (`application_resume_download_links`), timed on the database clock.
- **Android.** Students review the snapshot before applying; recruiters read what was shared.
- **Tests.** `employer-candidate-view.integration.spec.ts`, `packages/hiring/test/application-snapshot.test.ts`,
  `applicationSnapshotView.test.tsx`, plus hiring and employer workspace web tests.
- **Validation.** Fresh one_stack7: migrate 53 then 0, typecheck, 2,612 tests passed, build, Android.
- **Decision for Divakar.** Grant expiry: the 180-day ceiling is adopted, but every close already revokes
  at once (stricter); keeping a hired candidate visible for up to 180 days is a one-line change left to you.
- Design: `docs/architecture/application-snapshots-table-design.md`.

## EMP-08 — Student hiring notifications and interview view (2026-09-28)

Written by the coordinator for the same reason as EMP-07.

- **Built.** The hiring events employers already wrote to the outbox (stage changes, interviews,
  offers, EMP-05 terms changes) are registered and delivered by the outbox worker, never from a request
  handler, one `hiring_notification_deliveries` row per event and recipient (0059). Students see their
  interviews under Applications; employers see offer answers; one reminder 24 hours before an offer lapses.
- **Android.** Interviews in My applications and the offer deadline.
- **Tests.** `hiring-notifications.integration.spec.ts`, `hiring-notification-templates.test.ts`, web tests.
- **Validation.** As EMP-07.
- **Decisions for Divakar.** (1) Email sender and domain (HG-7): until decided, notices are in-app and every
  email is recorded `NOT_CONFIGURED` — nothing claims an email was sent. (2) Quiet hours and the daily cap
  are not applied to these time-critical notices; the email switch is honoured. (3) One reminder, 24 hours
  before expiry. Design: `docs/architecture/hiring-notification-deliveries-table-design.md`.

## EMP-09 — Interview scheduling essentials — 2026-09-28
**Result:** Complete — reschedules and cancellations carry a reason code and keep an append-only history; the student and every panellist are told once per change with an `.ics` that updates in place; the joining link is shown only to the people on the interview; scorecards follow the stage's template criterion by criterion. Web and Android carry it.
**Branch / PR:** feat/emp-interview-scheduling, cut from onev4/stack/eng13 (4c89cba), pushed to onev4; merge by review. Commits b332541 (design), 04b0537 (acceptance tests), d349863 (implementation), 7584595 (Android), then this report.
**Files created:**
- docs/architecture/interview-scheduling-and-scorecards-table-design.md
- packages/persistence/drizzle/0063_interview_scheduling_and_scorecards.sql
- packages/hiring/src/interview-scheduling.ts (reason codes, joining-link rule, template input, ratings-follow-template) and packages/hiring/src/interview-calendar.ts (RFC 5545 builder); packages/hiring/test/interview-scheduling.test.ts with fixtures interview-rescheduled.ics.txt and interview-cancelled-emailed.ics.txt
- packages/persistence/src/interview-calendar-source.ts (the invite for one revision, shared by the consumer and the downloads)
- apps/api/src/http/interview-scheduling.ts (revision writer, organisation lock, link-visibility SQL, scorecard recorder), apps/api/src/http/employer-scorecard-templates.controller.ts, apps/api/src/http/employer-interview-scheduling.integration.spec.ts
- apps/web/src/interviewScheduling.tsx (+ .test.tsx)
- apps/android/.../InterviewScheduling.kt

**Files modified:**
- API: employer-hiring.controller.ts (schedule, state and outcome routes; history, scorecards and panellist calendar routes; list and brief fields), student-hiring.controller.ts (student calendar route), opportunity-requirements.ts and employer-job-lifecycle.controller.ts (a stage's template is written, carried forward and part of the stage signature), api-security.module.ts (controller registered).
- Packages: hiring opportunity-requirements.ts (stage `scorecardTemplateId`); persistence hiring-notifications.ts (panel notices, `.ics` attachment), invitation-mail.ts (optional attachments, multipart in the loopback sink), package.json and pnpm-lock.yaml (persistence depends on @planthepath/hiring); events (optional `revisionId` on interview.scheduled and interview.state_changed v1).
- Web: api/hiring.ts, hiringPages.tsx, rolePortal/employer.tsx, rolePortal/employerOpportunityRequirements.tsx.
- Android: ApiEmployer.kt, EmployerWork.kt, StaffDashboards.kt, StudentHiring.kt.

**Existing tests touched (no assertion weakened):** five call sites now send the reason code the route requires (employer-applicant-access x3, employer-hiring.controller.integration x1, hiring-notifications x2). The state-route unit test in employer-hiring.controller.test.ts asserts the same UPDATE parameters and audit action, found by statement rather than by index, because the route now locks and writes history first. Two web tests in hiringPages.test.tsx pick a reason in the new form instead of answering window.confirm, and assert that the reason code is posted.
**Migrations added:** 0063_interview_scheduling_and_scorecards.sql (number assigned): interview_schedule_revisions (append-only, reason required for RESCHEDULED and CANCELLED, BASELINE backfill); interview_scorecard_templates and interview_scorecard_criteria (immutable except retiring); `scorecard_template_id` on opportunity_selection_stages, interviews and interview_outcomes; interview_outcome_criterion_ratings. References only tables below 0063; idempotent (replayed twice by hand in psql after the migrator).
**Design docs / ADRs:** the design doc above (reasoning, rejected options, decisions). No ADR.
**Routes:**
- POST …/interviews/:id/state: `reasonCode` now required for RESCHEDULED and CANCELLED; optional `note` (`reason` still accepted); for a reschedule, optional `mode`, `locationDetail`, `joiningLink`. Unknown fields 400; a past start 400 SCHEDULE_IN_PAST on the database clock.
- New: GET …/interviews/:id/history; GET …/interviews/:id/scorecards (live grant, audited `interview.scorecards.viewed`); GET and POST …/scorecard-templates; POST …/scorecard-templates/:id/retire; GET …/my-interviews/:id/calendar; GET /students/me/interviews/:id/calendar.
- POST …/applications/:id/interviews gains `selectionStageId`; both outcome routes gain `criteria`.

**Validation:** fresh database one_emp09, only DATABASE_URL exported.
- `corepack pnpm db:migrate` twice: the first run applied 57 and the second applied 0. 0063 was also replayed twice by hand in psql.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: exit 0. 17 suites and 2,768 tests, all passed (the largest suites had 930, 678 and 355 tests). The new API spec ran 14/14 and the new hiring unit spec 34/34.
- `corepack pnpm build`: passed.
- CI parity: `corepack pnpm audit --prod --audit-level=high` found 2 moderate advisories and no high or critical ones. The optional-chain policy grep printed nothing, and there are no private-key blocks or merge markers.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR): passed.
- The test commit was not run on its own against the base, because its routes and tables do not exist there.
**Acceptance criteria:**
- [x] Reschedules notify everyone once and keep history: `notifies the student and each panellist once per change with an .ics, and a replayed event adds nothing`; `keeps every revision in order with who, when, why and the schedule it produced, and the history cannot be rewritten`.
- [x] Reschedule and cancel with reason codes and student notification: `refuses a reschedule or cancellation without a listed reason code, with an unknown field or into the past, and writes nothing`. The student is told that it moved or was cancelled, never why (the EMP-08 assertion is kept).
- [x] `.ics` files open correctly in common calendars (fixture test): packages/hiring `builds the downloaded invite for a rescheduled interview exactly as the fixture` and `builds the emailed invite for a cancellation…`, plus RFC 5545 checks (CRLF, lines of at most 75 octets folded without splitting a character, escaping, UTC times, one VEVENT, stable UID, SEQUENCE). Over the API: one UID across every email, SEQUENCE 0/1/2, STATUS CANCELLED on the cancellation.
- [x] Video link validated as https and shown only to participants and the student: `shows it to the scheduler and the panel, not to other members, and refuses a link that is not plain https`. Student and panellist downloads carry it; emails never do.
- [x] Scorecards follow the stage template: `binds a template to an interview stage through a new job version, copies it to the interview, and requires every criterion`; `carries a stage template forward…`; `creates, lists and retires templates…`.
- [x] Participants see only their interviews (unchanged): `keeps participants to their own interviews (unchanged rule)` and the existing assignment specs.
- [x] §6.3: 401 without a token; another employer 403; SUSPENDED gets 403 INACTIVE on every new route; PENDING may prepare templates but gets UNVERIFIED on candidate routes; no grant gives 403 on scorecards; audit rows carry the organisation and the reason code; no readiness, score or total fields; web real data, NA, empty and error states; navigation labels unchanged ("Scorecard templates" is a view button inside Interviews, not a navigation item).

**Decisions for Divakar (recommendations taken):**
1. The member who scheduled an interview keeps seeing its link. Other non-participant members see only that a link exists.
2. Emailed invites carry no joining link, location or preparation note (EMP-08's rule); downloads inside ONE carry them. One-tap join from email is one flag in the consumer if wanted.
3. `METHOD:PUBLISH` with `STATUS:CANCELLED`, not REQUEST/CANCEL: those need an organizer mailbox that receives replies, which waits on HG-7. No calendar provider is integrated and none needs credentials, so there is nothing to put behind an interface yet.
4. Reason codes are fixed lists (reschedule 5, cancel 6, retire 3), with no OTHER; the note carries detail.
5. Rescheduling into the past is refused; scheduling a new interview in the past stays allowed, as before.
6. The two outcome routes still ignore unknown fields: an existing test pins that a spoofed `submittedByUserId` is ignored rather than refused. Every other EMP-09 write refuses unknown fields.
7. A stage keeps a retired template when carried forward; retiring only stops it being chosen again.

**Android:** changed.
- Students: "Add to calendar" on an upcoming interview (the phone's calendar app, prefilled with how to join), and a note when it moved or was cancelled.
- Panellists: stage and scorecard template on the brief, criterion-by-criterion ratings (submit waits for every criterion), and add-to-calendar.
- Employers: a new read-only Interviews view from Home: state, stage, last change and reason, full history, per-criterion scorecards. Reschedule, cancel and templates stay on the web.
- Compiled with the Android Studio JBR.

**Limitations / not done:** no two-way calendar sync (EMP-17: none in this plan). The phone adds to its calendar by intent rather than importing the `.ics`, because Android calendar apps do not reliably import files, so a moved interview must be added again there. Participants still cannot be added to or removed from an existing interview. Emails stay NOT_CONFIGURED until HG-7.
**Next goal:** EMP-10.

## EMP-10 — Application-bound messages — 2026-09-29
**Result:** Complete — one conversation per application between the candidate and the employer's team, inside ONE: the employer may start it from SHORTLISTED, reads and writes only while the student's applicant-access grant is live, and a student can reply, mute and report a message into a trust case with the conversation as evidence. Web, Android and the operations Trust and Safety screen carry it.
**Branch / PR:** feat/emp-messages, cut from onev4/feat/plan-phases-0-to-2 (edd5de8), pushed to onev4; merge by review. Commits b59c42b (design), 70491fe (acceptance tests), 50667ee (API, migration, consumer), d40ded0 (web), c7ac74f (Android), c3c360a (operations view), then this report, d85cb58 and 9678b6f (test fixes found by the validation run).
**Files created:**
- docs/architecture/application-messages-table-design.md
- packages/persistence/drizzle/0067_application_messages.sql
- packages/hiring/src/application-messages.ts (+ test/application-messages.test.ts)
- packages/persistence/src/application-messages.ts (deletion erase, 180-day retention sweep, trust-case evidence read)
- apps/api/src/http/application-messages.controller.ts, apps/api/src/http/application-messages.integration.spec.ts
- apps/web/src/applicationMessages.tsx (+ .test.tsx)
- apps/android/.../ApplicationMessages.kt

**Files modified:**
- API: api-security.module.ts (controller registered), student-hiring.controller.ts (`conversationStarted`, `unreadMessages` on My applications), trust-safety.controller.ts (GET …/cases/:caseId/message-threads), privacy-deletion.ts (APPLICATION_MESSAGES erased), privacy-export.ts (`applicationMessages`), run-privacy-worker.ts (retention sweep after deletions).
- Packages: events (`application.message.sent` v1 registered), persistence hiring-notifications.ts (EMPLOYER_MESSAGE / CANDIDATE_MESSAGE through the EMP-08 consumer), privacy (APPLICATION_MESSAGES category, ERASED).
- Web: api/hiring.ts, api/operations.ts, hiringPages.tsx (Messages column in My applications), rolePortal/employer.tsx (the existing Messages label), rolePortal/employerCandidateDetail.tsx, rolePortal/trustSafety.tsx.
- Android: Api.kt, EmployerWork.kt, JobsAndMore.kt.

**Existing tests touched (no assertion weakened):** apps/api/src/http/privacy.integration.spec.ts expects 13 deletion records (was 12) and asserts APPLICATION_MESSAGES is ERASED. packages/privacy/test/index.test.ts counts 13 declared deletion categories (was 12) and lists APPLICATION_MESSAGES among the erased ones. rolePortal/employerCompanyProfile.test.tsx used "Messages" as its example of a label that still says "Not built yet"; Messages is now built, so the same assertion uses "Settings" (EMP-16, still unbuilt). packages/persistence/test/hiring-notification-templates.test.ts gains one case.
**Migrations added:** 0067_application_messages.sql (number assigned by the coordinator): `application_message_threads` (one per application; composite FKs to the application's employer, student and job), `application_messages` (text ≤ 2,000, link flag, read time, report columns, erasure; append-only trigger). Widens `user_notifications_kind_ck` (+CANDIDATE_MESSAGE, 0059's read-and-union pattern), `hiring_notification_deliveries_kind_ck` (+EMPLOYER_MESSAGE, CANDIDATE_MESSAGE), `trust_case_evidence_kind_ck` (+APPLICATION_MESSAGE_THREAD, APPLICATION_MESSAGE) and `privacy_deletion_category_ck` (+APPLICATION_MESSAGES, 0060's full list kept). Every statement guarded; replayed twice by hand in psql after the migrator.
**Design docs / ADRs:** the design doc above (who reads, retention, deletion, export, moderation, what employers cannot see, no attachments, rejected options). No ADR.
**Routes:**
- Employer (requireActiveEmployer `candidates`, then the live grant on every request): GET /employers/:e/message-threads (inbox; live-grant conversations only, keyset cursor, default 50, max 200, withheld ones counted), GET and POST /employers/:e/applications/:a/messages.
- Student: GET and POST /students/me/applications/:a/messages, POST …/messages/mute, POST …/messages/:messageId/report.
- Operations (TRUST_SAFETY_INVESTIGATE): GET /operations/trust-safety/cases/:caseId/message-threads.

**Validation:** fresh database one_emp10, only DATABASE_URL exported.
- `corepack pnpm db:migrate` twice: first run applied 60 (ledger created), second applied 0. 0067 was also replayed twice by hand in psql.
- `corepack pnpm typecheck`: the first run failed on three first-element reads in the new API spec (noUncheckedIndexedAccess); fixed in d85cb58 (assertions unchanged) and re-run: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: 18 suites, 2,972 passed and 1 failed — privacy.integration.spec.ts pinned 12 deletion records, and EMP-10 declares a 13th category. Updated in 9678b6f to 13 with the new record asserted ERASED; that file re-run alone: 13/13 passed. The API suite ran 982 tests (59 files), including application-messages.integration.spec.ts 16/16.
- `corepack pnpm build`: passed.
- CI parity: `corepack pnpm audit --prod --audit-level=high` exit 0 (2 moderate, no high or critical); the optional-chain policy grep printed nothing; no private-key blocks or merge markers in the diff.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR): passed.
**Acceptance criteria:**
- [x] No message can be sent without a live grant: `stops the employer on the next request after a withdrawal, and leaves the student a read-only copy`; `refuses both sides when the grant is revoked, expired, or the student asks to be deleted` (rejection too); nothing is written on a refusal.
- [x] Reported messages create a trust case with the thread as evidence: `opens one case per conversation, keeps adding to it, and tells the employer nothing` (EMPLOYER_ACCOUNTABILITY / ORGANIZATION / REPORTED, evidence APPLICATION_MESSAGE_THREAD + APPLICATION_MESSAGE + REPORTER_STATEMENT, no action taken, operators read it audited, nobody else can).
- [x] Build 1 — table design, text only ≤ 2,000, sender, read state, report flag, retention tied to the grant: design doc; `refuses unknown fields, empty or overlong text and attachments`; `erases text 180 days after the grant ended, but not while a report on it is open`; `never lets a message be rewritten or deleted`.
- [x] Build 2 — employers start only from SHORTLISTED; students reply, mute and report: `lets the team start it from SHORTLISTED onward…`; mute in `tells the members who wrote when the candidate replies… and honours mute`.
- [x] Build 3 — rate limits per employer and per thread; links allowed but flagged; no attachments: `stops an employer after three unanswered messages and a student after ten in an hour`; `flags a message that carries a link`; per-employer hourly and new-thread limits in code.
- [x] Build 4 — Messages screen for employers; message view inside the student's application: the existing Messages label and Candidate Detail; My applications (web and Android).
- [x] Verify — integration and web tests: application-messages.integration.spec.ts (16), applicationMessages.test.tsx (8), hiring unit (9).
- [x] §6.3: 401 without a token; another employer 403; ended membership 403; SUSPENDED 403 INACTIVE; PENDING 403 UNVERIFIED; no grant 403; validation 400s; pagination bounds; audit rows with the organisation; no readiness, mute, report or recruiter identity in any employer or student response; web NA / empty / closed / error states; navigation labels unchanged (asserted).

**Decisions for Divakar (recommendations taken):**
1. "The employer's team on that job" = the employer's active owners, admins and recruiters. ONE has no per-job team; every member already sees every applicant; interviewers are recruiters (10.2 #2).
2. Retention: text erased 180 days after the grant ends (10.2 #7's period), skipped while the thread is evidence on an open trust case. The student keeps a read-only copy until then.
3. Deletion erases both sides' text (the whole conversation is about the student); rows stay without text. Operations keep a reported conversation by placing a retention hold, the existing mechanism.
4. Rate limits: 10 per side per thread per hour; an employer may send 3 in a row without a reply; 200 per employer per hour; 50 new conversations per employer per day; 60 per student per hour.
5. Links are allowed, flagged, never rendered as tappable links; the student sees a "never pay a fee" warning.
6. Notices never carry the message text; one notice per unread run; employer notices go to the members who wrote in the conversation, never naming the candidate, in-app only; student emails are NOT_CONFIGURED until a sink is configured (sender info@ai8ht.pro via mailSender()).
7. Only students report (the plan's scope); a report opens or joins one case per conversation per student; a payment request is HIGH severity.
8. HG-3: no navigation item was added, removed, renamed or reordered. The recruiter portal already had a Messages item ("Not built yet"); it now shows the inbox. Students use My applications — a student Messages item would need HG-3 and is not made.

**Android:** changed. Recruiters see the conversation on the applicant's page (read, start once shortlisted, reply); students open it from My applications with an unread count, reply, mute and report. Plain text only, same link warning. The operations Trust and Safety view is web-only, like the rest of the operations console. Compiled with the Android Studio JBR.
**Limitations / not done:** no employer inbox on Android (the conversation is on the applicant's page; a phone inbox would be a new navigation entry). Per-employer and per-student limits are counted without a global lock (abuse brakes, not quotas). If a later migration re-declares `privacy_deletion_category_ck` or `trust_case_evidence_kind_ck` it must keep these values. Emails stay NOT_CONFIGURED until a mail sink is configured.
**Next goal:** EMP-11.

## EMP-11 — Campus drives with placement-office approval — 2026-09-29
**Result:** Complete. An employer asks a college for a campus drive for one of its jobs, and the job reaches that college's students only once the college's placement office approves it. Where the college has set one offer per student, the policy is enforced at apply for every application that comes through its drive, and the student is told why before they try. Once a drive completes, the college sees suppressed counts, and it sees names only for students who shared that application with it. The employer gains nothing about candidates from a drive: candidate data still flows only through the grant written at apply.
**Branch / PR:** feat/emp-campus-drives, cut from onev4/feat/plan-phases-0-to-2 at d527f88 and pushed to onev4; merge by review. Commits, in order:
- d728ce8: design and ADR
- f95696d: acceptance and unit tests
- 90f3449: migration and API
- 65537fd: web
- 058ae5d: help text
- ca4dab9: Android
- then this report

**Files created:**
- docs/architecture/campus-drives-table-design.md
- docs/architecture/ADR-038-campus-drive-is-an-opportunity-published-through-institution-approval.md
- packages/persistence/drizzle/0069_campus_drives.sql
- packages/hiring/src/campus-drives.ts, which holds the state machine per side, the reason-code lists and the one-offer rule; packages/hiring/test/campus-drives.test.ts
- apps/api/src/http/campus-drives.ts, which holds the student-side SQL shared by the listing, detail, preview and apply, and the audience check used by publish and reopen
- apps/api/src/http/campus-drives.controller.ts, which holds EmployerCampusDrivesController and InstitutionCampusDrivesController
- apps/api/src/http/campus-drives.integration.spec.ts
- Web: apps/web/src/api/campusDrives.ts, apps/web/src/rolePortal/employerCampusDrives.tsx, apps/web/src/rolePortal/institutionCampusDrives.tsx and apps/web/src/rolePortal/campusDrives.test.tsx
- Android: apps/android/.../CampusDrives.kt

**Files modified:**
- API:
  - student-hiring.controller.ts: a live drive at the student's college counts as a route to the job. Listing and detail carry the drives. Apply enforces the policy, re-checks visibility under the drive locks and links the application. The applications list carries `campusDrive`.
  - employer-hiring.controller.ts and employer-job-lifecycle.controller.ts: publish and reopen accept a pending or live drive as the job's audience.
  - api-security.module.ts: registers the two controllers.
  - assistant/help-articles.ts: describes how drives now work.
- Packages:
  - hiring index.ts: one rule code.
  - events: `campus_drive.state_changed` v1 is registered.
- Web:
  - api.ts and api/hiring.ts
  - hiringPages.tsx: the student's campus drive tag and notice, and Apply disabled when the policy stops the student. The employer create form gains "Who can see it: All students / Only colleges that approve a campus drive".
  - rolePortal/employerOpportunityDetail.tsx: the Campus drives section.
  - rolePortalPages.tsx: only the placement-officer Dashboard branch changes.
  - rolePortal/institutionPlacement.tsx: approvals on the admin's Placement page.
  - rolePortal/institutionSettings.tsx: the real placement-policies section replaces the "not built yet" placeholder.
  - rolePortal/shared.tsx: error messages only.
  - staffDashboardsV3.tsx: the "Upcoming Drives" and "Campus Drives" cards show real drives instead of NA.
- Android: Api.kt, ApiStudent.kt, StudentHiring.kt, JobsAndMore.kt and StaffDashboards.kt.

**Existing tests touched (no assertion weakened):**
- student-hiring.controller.test.ts: the apply fixture answers the two new in-transaction reads (no live drive, still visible), as EMP-05 did for its locked re-read. Its assertions are unchanged.
- employerOpportunityDetail.test.tsx and employerOpportunityRequirements.test.tsx: the fetch fixtures answer the new drives read with none.
- institutionSettings.test.tsx: the assertion that "Placement policies — not built yet" is shown is replaced by assertions that the placeholder is gone, the real section says plainly that no policy is in force, and it offers the set-policy form. The fixture answers the policies read.

**Migrations added:** 0069_campus_drives.sql (the number assigned). It adds four tables:
- `campus_drives`. It uses a revision counter and CHECKs on decision, reason, close and schedule. A partial unique index allows one open drive per job and college, and a composite FK to `opportunities(id, employer_id)`.
- `campus_drive_state_history`, append-only, enforced by a trigger.
- `campus_drive_applications`, append-only. Composite FKs prove that the drive and the application belong to the same job.
- `institution_placement_policies`. A trigger allows only ACTIVE→RETIRED, and there is one ACTIVE policy per college and type.

It is additive, references only files below 0069, and every statement is guarded, so the bootstrap replay is a no-op.

**Design docs / ADRs:** the table design above, which gives the reasoning, the rejected options and the open points. ADR-038 records a drive as an opportunity published to one institution through that institution's approval. It rejects a drive as a separate job object, drives without approval, and approval writing an `INSTITUTION` audience row.

**Routes:**
- Employer:
  - `GET /employers/:id/campus-drive-institutions?q=`: verified, active colleges, by name.
  - `GET /employers/:id/campus-drives?opportunityId=`
  - `POST /employers/:id/opportunities/:oid/campus-drives`
  - `POST /employers/:id/campus-drives/:did/{resubmit|cancel|complete}`
  - `GET …/campus-drives/:did/history`
- College:
  - `GET /institutions/:id/campus-drives?state&limit(1–200)&cursor`: keyset-paginated, with `canDecide`.
  - `POST …/campus-drives/:did/{approve|reject|request-changes|schedule|cancel|complete}`
  - `GET …/history`
  - `GET …/results`
  - `GET/POST /institutions/:id/placement-policies`
  - `POST …/placement-policies/:pid/retire`
- Student:
  - `GET /opportunities` and `GET /opportunities/:id` gain `campusDrives`. The detail version carries `placementPolicy` and `blocksYou`.
  - Apply may return 400 `PLACEMENT_POLICY_ONE_OFFER`, with `institutionName`.

Every write:
- names the revision it read (409 `CAMPUS_DRIVE_CHANGED` otherwise);
- locks the drive FOR UPDATE, and on the employer side also locks the organisation row FOR SHARE;
- writes history, an audit row carrying the organisation and reason code, and the outbox event in one transaction;
- refuses unknown fields.

**Validation:** fresh database one_emp11, with only DATABASE_URL exported.
- `corepack pnpm db:migrate` twice: the first run applied 61 and created the ledger; the second applied 0.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: exit 0. 18 suites and 3,011 tests, all passed, none failed. The largest suites had 991, 729 and 392 tests. The new API spec ran 7/7, the new hiring unit spec 8/8, and the new web tests 12/12.
- `corepack pnpm build`: passed.
- CI parity: `corepack pnpm audit --prod --audit-level=high` exited 0, with 2 moderate advisories and no high or critical ones. The optional-chain policy grep printed nothing, and there are no private-key blocks or merge markers.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR): passed.

**Acceptance criteria:**
- [x] A drive cannot go live without placement-office approval. Test: `keeps a published drive-only job from the college's students until the college approves, and from everyone else after`.
  - Before approval the job is published but absent from the listing, and detail and apply return 403.
  - After approval it is listed with the drive, and the student applies and is linked.
  - A student at another college never sees it.
  - When the college withdraws its approval, the job is gone on the next request and existing applications stand.
  - `gives the employer no way to make a drive live, …`: the employer has no approve route (404), and the college's routes return 403 to the employer.
- [x] A student with an accepted offer is blocked from further drive applications where the college set ONE_OFFER_PER_STUDENT, and is told why. Test: `blocks a student with an accepted offer from further drive applications and says why; others apply`.
  - The detail shows the policy and `blocksYou`. Apply returns 400 `PLACEMENT_POLICY_ONE_OFFER` and writes nothing. A hire blocks too.
  - A public job elsewhere stays open to the student (decision 10.2 #11).
  - `applies the policy to a public job that also runs as a drive at the college, and honours a drive exception`: the policy cannot be sidestepped through the public listing, the exception applies only when both the policy and the drive allow it, retiring the policy needs a listed reason, and the row can only be retired.
- [x] Named results respect each student's institution-visibility choice. Test: `shows suppressed counts after completion and named results only for shared applications in scope, audited`.
  - Of 6 applicants, the 2 who shared are named.
  - Counts appear only once the drive is COMPLETED. The count of 6 is shown; the 2 offered and 0 selected read suppressed.
  - A revoke removes the name on the next request.
  - Every read is audited `institution.campus_drive_results.read`, and faculty get 403.
  - No compensation or readiness appears in the response.
- [x] Integration specs for both sides: 7 tests. Policy and state-machine unit tests: 8. Web tests: 9 in campusDrives.test.tsx and 3 in hiringPages.test.tsx.
- [x] §6.3:
  - 401 without a token.
  - 403 for another employer and for another college's staff.
  - A PENDING employer gets 403 UNVERIFIED on a request. A SUSPENDED employer gets 403 INACTIVE on writes, and its drive cannot be approved (409).
  - Department heads and faculty cannot decide. A placement admin narrowed to one department gets 403 `INSTITUTION_WIDE_SCOPE_REQUIRED`.
  - Unknown fields, bad dates, schedule order, venue, reason codes and policy type each give 400.
  - A stale revision gives 409.
  - Paging bounds: `limit` must be 1–200, and an invalid state is refused.
  - Audit rows carry the organisation and the reason code, and outbox rows are written.
  - No readiness appears in employer or college responses.
  - Web: real data, plus the empty, cannot-decide and error states (with a reference). Navigation labels are unchanged for the placement officer and the recruiter (asserted).

**Decisions for Divakar (recommendations taken):**
1. **No Drives navigation item (HG-3).** The plan recommends adding one (10.2 #4), but adding a navigation item is a hard gate, so the plan's fallback was taken:
   - the placement officer decides drives and sets the policy on their Dashboard;
   - the admin decides drives on Placement and sets policies in Settings;
   - the employer requests drives from Opportunity Detail.

   Adding the Drives item later means moving two sections.
2. **Visibility is derived from the drive's state.** Nothing is written to `opportunity_audiences` (ADR-038).
3. **Publish and reopen accept a pending or live drive as the audience.** A drive-only job can be published before the college decides; it reaches nobody until approval, and the employer's screen says so.
4. **A live drive at the student's college governs the application whichever listing the student used.** This closes the sidestep through a public listing.
5. **Any accepted offer in ONE counts** toward the one-offer rule, as does a hire. The rule is checked only at apply and never withdraws an existing application, because that would be an automatic rejection.
6. **`CHANGES_REQUESTED` is added to the plan's state list**, so the employer can tell "waiting on the college" from "waiting on you".
7. **Only colleges decide.** Deciding needs an owner, admin or placement admin with an institution-wide write scope, because a drive reaches the whole college. Department heads read drives; faculty cannot.
8. **Tier exception:** one per-drive flag set by the college, honoured only when the policy allows exceptions. Categories such as Dream, Core and Mass belong to INST-12.
9. **Counts only after completion.** A live count could be differenced to follow one student, so counts appear only once a drive is complete. Names are available after approval, but only for students who shared the application.
10. **Notices:**
    - The requester and the college's placement staff get an in-app SYSTEM notice after commit, best-effort.
    - The outbox event `campus_drive.state_changed` has no consumer yet.
    - No email is sent, so nothing is marked NOT_CONFIGURED.

**Android:** changed and compiled with the Android Studio JBR.
- Students see the "Campus drive · college" chip on jobs and applications. The job page has a campus drive card with the date, venue and the college's policy. Apply is disabled when the policy stops the student, and a refusal is explained.
- The college home gains a read-only Campus drives section: requests awaiting a decision and scheduled drives ahead. It is hidden for faculty.
- The employer's Roles gain a read-only list of each role's drives, with the college's decision and reason.
- Deciding, requesting and setting policies stay on the web, like editing a job, because each needs a reason and a confirmation.

**Limitations / not done:**
- Direct `INSTITUTION` audiences still reach a college without approval. Retiring them for new jobs is the recommended next step (design doc, open point 1).
- Drives cannot target a single department.
- Approving a drive does not message every student; the college can use INST-06 announcements to circulate it.
- The phone decides nothing.
- The one-offer check at apply and a concurrent offer acceptance are not serialised. An acceptance committing during an apply can let that one application through.
- The college's drive list is keyset-paginated, but the dashboards read only the first page (up to 50).

**Risks / follow-ups:**
- INST-12 (register, categories), INST-14 (nominations) and EMP-15 (reports by drive) can build on `campus_drive_applications`.
- The in-app notices use the SYSTEM kind. A dedicated kind needs a widening of the `user_notifications_kind_ck` CHECK in a later migration.

**Next goal:** EMP-12 (or as scheduled by the coordinator).

## EMP-12 — Employer assessments — 2026-09-29
**Result:** Complete. Employer screening tests (which already existed on their own 0036 tables — D-9 corrected) now go only to applicants at the ASSESSMENT stage, in a window and time limit held on the database clock; the candidate reads what they are assessed on and agrees before starting; employers read results per assessment and per candidate only through a live applicant-access grant, audited and never ranked by score; every employer write is locked, audited, reason-coded and refuses unknown fields; a suspended employer's tests close to candidates; students are told of an invitation through the outbox. Web and Android carry it. Grading is deterministic; no model call anywhere.
**Branch / PR:** feat/emp-assessments, cut from onev4/feat/plan-phases-0-to-2 at e97bbad, pushed to onev4; merge by review. Commits, in order: 3fc07c5 (design + ADR), 1a93593 (acceptance tests), f1e5a4b (API, migration, consumer), 1aafaf9 (web + help text), 46fe26d (Android), 30357fc (this report), 65d3e3d (check order fix found by the validation run), then the validation amendment.
**Files created:**
- docs/architecture/ADR-039-employer-assessments-keep-their-own-tables.md
- docs/architecture/employer-assessment-windows-and-notices-design.md
- packages/persistence/drizzle/0074_employer_assessment_notices.sql
- apps/api/src/http/employer-assessments-emp12.integration.spec.ts

**Files modified:**
- API: employer-assessments.controller.ts (rewritten around the same routes; new: POST …/assessments/:id/close, GET …/applications/:applicationId/assessment-results, GET /students/me/screening-assessments/:invitationId), assistant/help-articles.ts (two articles; the app article says screening tests can be taken on the phone).
- Packages: events (`employer_assessment.invited` v1 registered), persistence hiring-notifications.ts (ASSESSMENT_INVITED through the EMP-08 consumer).
- Web: api/assessments.ts, screeningAssessmentsPage.tsx, employerAssessmentsPage.tsx (+ EmployerCandidateAssessmentsPanel), rolePortal/employerCandidateDetail.tsx.
- Android: ApiStudent.kt, ApiEmployer.kt, Screening.kt, EmployerWork.kt.

**Existing tests touched (no assertion weakened):** employer-assessments.integration.spec.ts — its helper now moves the applicant to ASSESSMENT (the new stage rule) and its start calls pass `{ acknowledged: true }`; employer-organisation-state.integration.spec.ts — five routes added to the state matrix (the three assessment writes EMP-SR-19 found missing, plus close and the per-candidate read); screeningAssessmentsPage.test.tsx — the two tests that open the paper now read the brief, tick and begin first; persistence hiring-notification-templates.test.ts gains one case; employer-applicant-access.integration.spec.ts — its fixture passes through the ASSESSMENT stage and sends the screening test there, before the interview (assertions unchanged).
**Migrations added:** 0074_employer_assessment_notices.sql (number assigned): widens `user_notifications_kind_ck` and `hiring_notification_deliveries_kind_ck` by read-and-union to add ASSESSMENT_INVITED. No table added; no existing migration edited; guarded so a replay is a no-op.
**Design docs / ADRs:** ADR-039 (employer tests keep their own tables; the plan's owner-column option rejected, with reasons); the windows-and-notices design doc (stage rule, database-clock windows and deadlines, brief and acknowledgement, per-candidate results, reason codes, fairness, the notice).
**Routes:**
- Employer writes (requireActiveEmployer; then, in one transaction, the organisation FOR SHARE, the row locked, an audit row with organisation and reason code; unknown fields refused): POST assessment-questions; POST assessment-questions/:id/transition (`reasonCode` required for REJECTED — INACCURATE, AMBIGUOUS, NOT_RELEVANT_TO_ROLE, DUPLICATE, UNFAIR_OR_BIASED — and ARCHIVED — OUTDATED, REPLACED, FLAWED, NO_LONGER_USED); POST assessments; POST assessments/:id/publish; **POST assessments/:id/close** (`reasonCode`: ROLE_FILLED, ROLE_CLOSED, SCREENING_COMPLETE, REPLACED_BY_NEW_TEST, CONTENT_FLAWED); POST assessments/:id/invitations (`opensAt` optional, `closesAt`; window checked in SQL; then the existing 400 APPLICATION_NOT_INVITABLE for closed or unconsented applications, the 403 grant check, and 400 APPLICATION_NOT_AT_ASSESSMENT_STAGE; one outbox event per invitation).
- Employer reads: GET assessments/:id/results (invitation order, `limit` 1–200 default 50, keyset `cursor`, `endedBy`, email only from SHORTLISTED, audited `employer.assessment_results.viewed`); **GET applications/:applicationId/assessment-results** (live grant or 403; per-question marks; audited `employer.candidate_assessment_results.viewed`); GET assessment-questions gains `mentionsProtectedAttribute`.
- Student: GET /students/me/screening-assessments (gains `available`, `questionCount`, `totalMarks`, `remainingSeconds`; expired state); **GET /students/me/screening-assessments/:invitationId** (the brief); POST …/start (requires `{ "acknowledged": true }`, audited); POST /students/me/screening-attempts/:id/answers and /submit (deadline on the database clock; 403 ASSESSMENT_UNAVAILABLE when the employer is not in good standing or the application is no longer shared).

**Validation:** fresh database one_emp12, only DATABASE_URL exported.
- `corepack pnpm db:migrate` twice: the first run applied 64 and created the ledger; the second applied 0. Both exit 0.
- `corepack pnpm typecheck`: passed (and again after the fix below).
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: 18 suites, 3,091 passed and 7 failed (web 62 files / 749, api 63 / 1,028, persistence 36 / 404, the rest all passing). All 7 failures were in employer-applicant-access.integration.spec.ts: its fixture sent a screening test to a SHORTLISTED→INTERVIEW candidate, and its revoked-grant case expects the invite to answer 403 FORBIDDEN, while the new stage rule answered 400 first. Fixed in 65d3e3d: the stage check now runs after the grant check (EMP-SR-01's order unchanged) with its own code, APPLICATION_NOT_AT_ASSESSMENT_STAGE, and the fixture passes through ASSESSMENT and sends its test there; no assertion changed. Re-run of that file with both assessment specs: 3 files / 39 tests passed; the web assessment tests 11/11.
- `corepack pnpm build`: passed.
- CI parity: `corepack pnpm audit --prod --audit-level=high` exit 0 (2 moderate, no high or critical); the optional-chain policy grep printed nothing; no private-key blocks or merge markers in the diff.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin` (Android Studio JBR): passed.
- The acceptance-test commit was not run alone against the base: its routes did not exist there.

**Acceptance criteria:**
- [x] Employers cannot see or reuse institution question banks (and the reverse): `keeps each bank to its owner at the API and in the schema` — an employer member gets 403 on an institution bank (including naming their own organisation as the institution); an institution question in an employer test gives 400 QUESTIONS_NOT_APPROVED; institution staff get 403 on the employer bank; an employer question in an institution exam pool gives 400 POOL_REQUIRES_APPROVED_SUBJECT_QUESTIONS; the schema refuses both cross-references (composite foreign keys).
- [x] Results are visible only through a live access grant: `shows one candidate's results with a per-question breakdown, audited, and nothing about readiness` (withdrawal → 403 on the next read, and the row leaves the list); the results list keeps its EMP-SR-01 grant filter.
- [x] Time limits and windows are enforced server-side: `refuses a window that is past, backwards, too long or has unknown fields, and writes nothing`; `opens and closes the window on the server, and expires an untouched invitation`; `enforces the time limit: no answer after the deadline, and what was saved in time is graded` (submitted_at = the deadline, 100% from the answer saved in time, TIME_LIMIT); `cuts the time short at the window's close, and finalises an abandoned attempt when the employer reads`.
- [x] Build 1 — ADR and table design, rejected option recorded: ADR-039 and the design doc (Decisions 1).
- [x] Build 2 — create from own questions, assign at the ASSESSMENT stage, set windows and time limits, see results per candidate: `refuses an application before the assessment stage and accepts it there, audited and announced`; the per-candidate route, the Candidate Detail panel (web) and the applicant page (Android).
- [x] Build 3 — coding types hidden until the sandbox exists: no sandbox exists on the base branch; `offers employers no coding question until a sandbox exists` (CODING, FILL_IN_THE_BLANK, MATCH_THE_FOLLOWING → 400).
- [x] Build 4 — results do not flow into learning evidence unless the student opts in: nothing writes evidence, mastery, readiness or the attempt log (the 0036 spec `writes nothing to evidence, mastery or readiness, and moves no application` still passes). The opt-in is not built (Decisions 3), so results never flow.
- [x] Build 5 — no camera, microphone or screen capture: none exists for employer tests (no focus events either), and the brief tells the student so (`shows the brief without any answer, and will not start without an acknowledgement`).
- [x] Verify — integration specs (ownership isolation both ways) and web tests: new API spec, 16 tests; 6 new employer and 2 new student web tests; 1 persistence case.
- [x] §6.3: 401 without a token; another employer 403; ended (suspended) membership 403; SUSPENDED organisation 403 INACTIVE on every assessment route (state matrix) and on invite after suspension; PENDING 403 UNVERIFIED on publish, close and candidate routes; no grant 403; validation 400s (unknown fields, windows, reasons, ids); pagination bounds (limit 0 and 201, a bad cursor → 400); audit rows with the organisation and reason code; no readiness, band, mastery, gap or fit in any employer response; web real data, NA, empty, forbidden and error states; navigation labels unchanged (no item touched; the per-candidate view sits inside the existing Candidate Detail).
- [x] Security findings closed here: EMP-SR-08 for assessments (audit in the transaction with the organisation, fixed reason codes, unknown fields refused), EMP-SR-14 (a suspended employer's tests closed to candidates), EMP-SR-15 for assessment publish, close and invite (organisation FOR SHARE), EMP-SR-17 (no score order), EMP-SR-19 for the three assessment writes.

**Decisions for Divakar (recommendations taken):**
1. **Ownership (10.2 #6) — departed from the plan's recommendation.** The plan recommended an owner column on the 0012 exam tables, but it was written before D-9 was corrected: employer tests already live on 0036 with a designed tenant wall and no path to readiness. Moving them would relax `institution_id` and every institution query's assumption, re-key live results, and put employer rows next to the readiness-evidence bridge. ADR-039 keeps the stores apart ("one engine" = the shared `@planthepath/assessments` rules) and records the rejected option. Overridable; reversing it costs a data migration.
2. **Invitations only at the ASSESSMENT stage.** Previously any open application could be invited. Sending a test never moves the candidate; a person moves them to Assessment first (web: Applicants; Android now offers "Move to assessment" too).
3. **Learning-evidence opt-in (10.2 #12) not built.** Results stay inside the application. An opt-in would be the first path by which an employer's own questions reach a student's record, and it needs your decision on labelling and weight.
4. **Deadline = the earlier of the duration and the window's close.** Starting late gives less time; the brief shows the minutes actually available before the candidate agrees.
5. **Window limits:** opens no earlier than 5 minutes ago, closes within 30 days, compared on the database clock.
6. **Abandoned attempts are finalised lazily** (by the candidate's next request or the employer's results read), with submitted_at set to the deadline — no worker and no second clock. How an attempt ended is derived (`endedBy`), not stored.
7. **Protected attributes:** grading is structurally blind to the person; a question naming a protected attribute is flagged to its author and reviewer, not refused (the word list has "height", "age" and "men", which appear in honest aptitude questions).
8. **Closing keeps sent invitations open** until their windows end (0036's rule: never discard a candidate's work); it stops new invitations.
9. **Students see their own score after submitting** (unchanged from 0036).
10. **The student's start and submission are audited** (`student.screening_assessment.started` with the acknowledgement; `…submitted` with how it ended).

**Android:** changed and compiled (`./gradlew --no-daemon -q :app:compileDebugKotlin`, Android Studio JBR). Students, who take screening tests on the phone: the brief with formats, marks, the minutes available and the terms; start only after agreeing; the server-kept time shown; time-over and unavailable states explained. Recruiters: the applicant page shows their own tests' results question by question while the candidate shares the application (403 explained otherwise), and "Move to assessment" is offered. Building, publishing, sending and closing tests stay on the web, like editing a job.
**Limitations / not done:**
- The learning-evidence opt-in (Decisions 3); the code sandbox and coding questions (none on the base branch).
- Privacy export and deletion do not yet cover employer screening attempts (a pre-existing gap from 0036); recommended as a follow-up with the privacy worker.
- The invitation email is recorded NOT_CONFIGURED until a mail sink exists (HG-7); the in-app notice is written.
- No employer Assessments list on Android (the read view is on the applicant page; a phone list would be a new navigation entry).
**Risks / follow-ups:** ADR-039 was the next free ADR number on every onev4 branch when written; a parallel goal could collide on 039. A later migration that re-declares either notification-kind CHECK must keep ASSESSMENT_INVITED (read-and-union, as 0059, 0067 and 0074 do, keeps it).
**Next goal:** EMP-13 (or as scheduled by the coordinator).

## EMP-15 — Employer dashboard and reports — 2026-09-29
**Result:** Complete. The employer Dashboard now reads one summary that the server computes in SQL: open jobs, new applicants in the last 7 days, interviews this week, offers awaiting an answer, drives awaiting a college, and the pipeline's current stages. Every number reconciles with the applicant pipeline. Reports cover the funnel and stage drop-off by job, by college and by campus drive, the median time to shortlist, interview, offer and hire, and offer outcomes with an acceptance rate. Every figure about people in a report goes through aggregate-suppression, and no report carries a candidate. Web and Android both carry this.

**Branch / PR:** feat/emp-reports, cut from onev4/feat/plan-phases-0-to-2 at 2887b02 and pushed to onev4; merge by review. Commits:
- 934730c: acceptance tests
- a3e35c6: API
- 5423057: web and help text
- 47840df: Android
- 83ab5f5: typing and help-text fix found by the validation run
- then this report

**Files created:**
- apps/api/src/http/employer-reports.ts: the pure report model. It builds the partition, applies suppression per table and holds the named-college rule, the acceptance-rate guard and the median guard.
- apps/api/src/http/employer-reports.test.ts
- apps/api/src/http/employer-reports.controller.ts
- apps/api/src/http/employer-reports.integration.spec.ts
- apps/web/src/rolePortal/employerReports.tsx
- apps/web/src/rolePortal/employerReports.test.tsx

**Files modified:**
- API:
  - api-security.module.ts registers the controller.
  - campus-drives.controller.ts: drive results count only shared applications.
  - campus-drives.integration.spec.ts
  - assistant/help-articles.ts: the employer article says what the Dashboard and Reports count.
- Web:
  - api/hiring.ts
  - staffDashboardsV3.tsx: only `EmployerDashboardV3`.
  - rolePortal/employer.tsx: only the Reports branch changes.
- Android: ApiEmployer.kt, EmployerWork.kt, StaffDashboards.kt.

**Existing tests touched (no assertion weakened):** campus-drives.integration.spec.ts `shows suppressed counts after completion…`.
- That test had 6 applicants, 2 of them shared, and it pinned `applied: 6`.
- With the alignment below, only the 2 shared applications count, so every count is now withheld, and the assertion says so.
- A new test in the same file pins the positive case: 7 applicants, 5 shared, `applied: 5`.
- This makes the college see less, not more.

**Migrations added:** none. Migration 0076 was not needed: every figure comes from existing tables.

**Design docs / ADRs:** none. The goal adds no table. The reasoning is in the controller and model headers and in the decisions below.

**Routes:**
- `GET /employers/:e/summary` and `GET /employers/:e/reports`:
  - both use `requireActiveEmployer(…, 'candidates')` for owner, admin and recruiter;
  - both refuse unknown query parameters with 400 `UNKNOWN_FIELD`, so no filter such as `?gender=` can be asked for;
  - reports are audited as `employer.reports.viewed` against the employer.
- `GET /institutions/:i/campus-drives/:d/results`: the counts now cover only applications the student shared with the college.

**Validation:** only DATABASE_URL was exported.
- **Database.** The run used one_emp15b. The first attempt's `DROP DATABASE one_emp15` stalled behind a checkpoint on the shared container, as happened during EMP-SR-01. The first `corepack pnpm db:migrate` applied 64 and created the ledger; the second applied 0.
- **`corepack pnpm typecheck`:** passed. The first full run failed it on two things, both fixed in 83ab5f5:
  - the report row types (strict casting);
  - an unescaped apostrophe in the help article.

  Neither changed behaviour or an assertion.
- **`corepack pnpm -r --no-bail --workspace-concurrency=1 test`:** every package passed except web.
  - api: 65 files, 1,035 tests, all passed. This includes employer-reports.integration.spec.ts 5/5, employer-reports.test.ts 9/9 and campus-drives.integration.spec.ts 8/8.
  - web: 1 of 753 failed. `App.test.tsx › resolves every visible navigation item for every new role without disabled nav` hit its 20 s timeout under load.
  - Re-runs: App.test.tsx alone passed 97/97, and the whole web package re-run alone passed 64 files, 753/753.
- **`corepack pnpm build`:** passed.
- **CI parity:**
  - `corepack pnpm audit --prod --audit-level=high` exited 0, with 2 moderate advisories and no high or critical ones;
  - the optional-chain policy grep printed nothing;
  - the diff has no private-key blocks or merge markers;
  - no frozen file and no migration was touched.
- **Android:** `./gradlew --no-daemon -q :app:compileDebugKotlin` with the Android Studio JBR passed.

**Acceptance criteria:**
- [x] Build 1, the summary: open jobs, new applicants in 7 days, interviews this week, offers pending and drives awaiting approval, computed in SQL. It also carries the current stage counts, open applications, hires, changes-requested drives and the week window. Test: `gives the dashboard summary in SQL, matching the applicant, interview, offer and drive lists`.
- [x] Build 2, the reports: the funnel by job, college and drive; time to shortlist, interview, offer and hire; offer acceptance rate; stage drop-off. Only the employer's own data is used. Test: `reports the funnel by job, college and drive, time to each stage and offer acceptance, suppressed and reconciled`.
- [x] Build 3, the Dashboard uses the summary, and missing sources show NA:
  - the web KPI tiles, funnel, pipeline mix, campus-drive chip and banner all read the summary;
  - This Week's Interviews was an NA placeholder. It now shows the server's count and the week's interviews, with the person named only while their grant is live;
  - when the summary fails, every slot reads NA (web test);
  - the Android Home does the same.
- [x] Every number reconciles with the applicant pipeline for a fixture dataset:
  - the summary equals counts over GET opportunities, the per-job applications, interviews in the returned window (not cancelled), live EXTENDED offers and REQUESTED drives;
  - every unsuppressed report cell equals the matching pipeline stage count.
- [x] No other employer's data is reachable. Test: `refuses another employer's recruiter and never counts another employer's applications`. It covers 403 both ways, and the rival's own figures exclude employer E's applications, including the shared college.
- [x] §6.3:
  - 401 without a token;
  - 403 for an ended membership;
  - SUSPENDED gives 403 `EMPLOYER_ORGANISATION_INACTIVE`, and PENDING gives 403 `EMPLOYER_ORGANISATION_UNVERIFIED`;
  - validation returns 400 on unknown parameters;
  - the reports read writes an audit row;
  - neither response carries readiness, a person's name, email or ID, or a protected attribute;
  - web: real data, NA, empty and error states with a reference, and navigation labels unchanged (asserted).
  - Candidate-grant tests do not apply: neither route returns one candidate's data.

**Decisions for Divakar (recommendations taken):**
1. **The summary is exact; the reports are suppressed.** Each summary figure is a count of rows the same employer already sees one by one in its own lists. That is how the acceptance test reconciles them, and withholding "2 offers awaiting an answer" would hide nothing the Offers page shows. The reports break applications down by dimensions the employer does not see side by side (college, drive, durations), so every figure about people there goes through `suppressAggregateTable` / `suppressSmallCount`.
2. **One partition per group.** Each application sits in exactly one cell:
   - its current stage while open;
   - HIRED;
   - or `LEFT_AT_<stage>`, the stage it was rejected or withdrew at.

   That single table is both the funnel and the drop-off. Publishing those as two tables over the same people would let one be subtracted from the other. A cumulative "reached at least" funnel was rejected: with the helper's zero-is-under-five rule, any zero hires would withhold every reached figure.
3. **College** is the name the student put in the application snapshot they chose to share (EMP-07), never ONE's roster. Names are grouped regardless of case and spacing, and each college is shown with the spelling most students used.
   - A college is named only from 5 applications. The rest form one "Other colleges or not stated" row.
   - If that row would hold 1–4, the smallest named college joins it.
   - Named rows are ordered by name, never by size.
   - An erased snapshot counts as "not stated".
4. **Medians are shown only over at least 5 applications.** The acceptance rate is accepted ÷ (accepted + declined + expired), shown only when the accepted and not-accepted groups each hold at least 5, because a rate over smaller groups is a small count in disguise. Offers are counted per application, using its latest non-draft offer.
5. **"This week" is Monday to Sunday in Asia/Kolkata**, computed by the database clock, and returned with the summary so clients list the same window. "Offers pending" means EXTENDED and not yet past expiry; a lapsed offer still marked EXTENDED is not waiting on anyone.
6. **Reports are lifetime-to-date, not a period.** The month-end period rule protects a college's view of students it cannot otherwise see. An employer already sees each of its applications' stage individually, so differencing its own live report over time reveals nothing it does not hold.
7. **Drive results are aligned with INST-12:** the college's counts for a completed drive now include only applications shared with the college, the same consent its named rows need. This was INST-12's recommendation, taken here because the reports touch drive outcomes.
8. **HG-3:** no navigation item was added, removed, renamed or reordered, and this is asserted. Reports stays on the existing label. On Android, the Home card's button that opens the overlay now reads "Reports" instead of "Hiring"; that is a button, not a navigation item.
9. **No export was added.** Exports are EMP-17's and would reuse INST-08's writer.

**Android:** changed and compiled with the Android Studio JBR (`:app:compileDebugKotlin` passed).
- Employer Home reads the same summary: Open Roles, Total Applicants, In Pipeline, Offers awaiting an answer, New in 7 days, Drives awaiting colleges, the funnel, and "N this week" on This Week's Interviews. Each shows NA when the summary cannot be read.
- The Hiring overlay decoded top-level fields the API never sent, so it showed zeros that were not real. It is replaced by a read-only Reports overlay with the same suppressed figures as the web.
- The Roles tab is unchanged; it already lists each role's counts and drives.

**Limitations / not done:**
- `GET /employers/:e/hiring-analytics` (unsuppressed, exempted by EMP-SR-01) and the web's `EmployerHiringAnalyticsPage` still exist, because an existing test covers the page. No screen on the web or the phone reads them any more. Recommended: retire both in a follow-up.
- Job and drive rows are capped at the 200 most recent, with a `…Truncated` flag.
- Suppression is applied per table. The college and job tables are not jointly protected against subtraction from the overall table. Within the threat model, that could reveal only facts the employer was given at apply time (the college in the shared snapshot) or already sees (each application's stage).

**Next goal:** coordinator's choice (EMP-16 or EMP-17).

## EMP-12 privacy fix — Employer screening attempts in export and deletion — 2026-09-29
**Result:** Complete. Closes the gap EMP-12 recorded under "Limitations": a student's employer screening attempts (0036) were in neither their data export nor privacy deletion. Deletion now keeps the attempt and its stored score for the employer, detached from the anonymised person like the application, erases what the candidate selected, and closes a sitting still open as unscored; the export gives the student their own attempts and answers, never the answer key or the per-question marking.
**Branch / PR:** fix/privacy-employer-screening, cut from onev4/feat/plan-phases-0-to-2 at e472cef, pushed to onev4; merge by review. Commits, in order: e923bc4 (design), 683f248 (failing tests), 3a50c62 (implementation and 0077), then this report and its validation amendment.
**Files created:**
- docs/architecture/employer-screening-privacy-design.md
- packages/persistence/drizzle/0077_employer_screening_privacy.sql

**Files modified:**
- API: privacy-deletion.ts (EMPLOYER_SCREENING step), privacy-export.ts (`screeningAssessments`, one more `notIncluded` line).
- Packages: privacy (category `EMPLOYER_SCREENING`, ANONYMISED, with its basis).
- Tests: privacy.integration.spec.ts, packages/privacy/test/index.test.ts.

**Existing tests touched (stronger, none weakened):** the pinned category count moves from 13 to 14 in both the package test and the integration test, which now also asserts the new category by name, disposition, basis and count. The integration spec's `seedApplication` takes the student and returns the application id so a second candidate can be seeded; every earlier assertion is unchanged.
**Migrations added:** 0077_employer_screening_privacy.sql (number assigned): widens `privacy_deletion_category_ck` by read-and-union to add EMPLOYER_SCREENING. No table or column added, no guard relaxed (the 0036 tables have no append-only trigger, so no erase setting is needed), no existing migration edited; a replay is a no-op, and 0067's guard (which tests only for APPLICATION_MESSAGES) leaves the widened constraint alone.

**Dispositions (design doc):**
- `employer_assessment_attempts`: kept with the anonymised user, score, max score and percentage unchanged. An IN_PROGRESS attempt becomes EXPIRED with no score, and its STARTED invitation EXPIRED, so the lazy sweep cannot later grade emptied answers into a stored 0.
- `employer_assessment_answers`: `selected_option_keys` → `{}`, `numeric_response` → NULL; `is_correct` and `marks_awarded` (the employer's grading) kept, so the marks still sum to the stored score.
- `employer_assessment_attempt_questions` and invitations: kept (the employer's material and acts).
- Deletion record: `EMPLOYER_SCREENING`, ANONYMISED, basis "Employers retain the record that they sent you a screening test and the score it produced; your answers are erased.", `record_count` = the person's attempts.
- Export `screeningAssessments`: per invitation on the subject's applications — employer, role, title, invited/opens/closes, state, and the attempt (state, started, submitted, percentage as the student already sees it), with each served question's text, the options in the candidate's own shuffle, and their selections under the keys they saw. Never selected: option `is_correct`, answer `is_correct` / `marks_awarded`, raw score / max score, seed, option map, anything of another candidate.

**Tests added:** `data export > includes the subject's own screening attempts and answers, never the answer key or another candidate`; the deletion-execution test `erases the person and keeps the employer record once the hold is released` gains the screening assertions (attempt and score kept, selections erased, marking kept, open sitting EXPIRED and unscored with its invitation, another candidate's answers and score untouched); `records what it erased, anonymised and retained` asserts 14 records and the EMPLOYER_SCREENING row; the package test `detaches rather than destroys another party record` asserts the new disposition and basis. The test commit was run alone first: 3 failed for the gap (no export section, answers still present, 13 records), 11 passed.

**Validation:** fresh database one_privfix2, only DATABASE_URL exported.
- `corepack pnpm db:migrate` twice: the first run applied 67, the second applied 0 ("67 already applied"). Both exit 0. The live `privacy_deletion_category_ck` lists all 14 categories.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test`: exit 0; 18 suites, 230 files, 3,153 tests, all passed (api 65 files / 1,043, web 64 / 766, persistence 36 / 404, privacy 1 / 22, the rest all passing). No out-of-shared-memory reruns were needed.
- `corepack pnpm build`: passed.
- CI parity: `corepack pnpm audit --prod --audit-level=high` exit 0 (2 moderate, no high or critical); the optional-chain policy grep printed nothing; no private-key blocks or merge markers in the diff.
- Before the fix, the test commit alone: privacy.integration.spec.ts 3 failed / 11 passed (the gap); after it, 14/14, and packages/privacy 22/22.

**Android / web:** no change. Both clients download the export as a file without interpreting its sections (web privacyPanel, Android Api.kt), and neither lists deletion categories. No screen, route, label or navigation item changed.
**Limitations / not done:** `answered_at` on erased answers is kept (NOT NULL, identifies no one once the response and the person are gone; recorded in the design). The export includes the question text the candidate was shown, which is the employer's material; the design records why (an answer is meaningless without its question) and that it discloses no key.
**Next goal:** as scheduled by the coordinator.

## EMP-16 — Employer terms, data retention and trust-case participation — 2026-09-29
**Result:** Complete. Employers now accept versioned terms before publishing, and the terms text is labelled as a draft for legal review. The daily worker revokes expired grants. An employer can now answer a trust case about itself and appeal a decision once; operators see the response and the appeal on the case timeline. Web, operations and Android all carry it.
**Branch / PR:** feat/emp-terms-trust, cut from onev4/feat/plan-phases-0-to-2 @ 9460a62, pushed to onev4; merge by review. Commits: b41b494 (design and draft terms), cb847f6 (acceptance tests), 3ad2671 (migration and API), b28e063 (web), d807aaa (Android), then this report.
**Files created:**
- docs/architecture/employer-terms-and-trust-participation-design.md
- docs/legal/employer-terms-DRAFT-for-legal-review.md
- packages/persistence/drizzle/0084_employer_terms_and_trust_participation.sql
- packages/persistence/src/employer-terms.ts
- apps/api/src/http/employer-settings.controller.ts, employer-trust-cases.controller.ts, operations-employer-terms.controller.ts, employer-terms-gate.ts
- apps/api/src/http/employer-terms-trust.integration.spec.ts
- apps/web/src/api/employerTerms.ts
- apps/web/src/rolePortal/employerSettings.tsx (+ .test.tsx), rolePortal/operationsEmployerTerms.tsx
- apps/android/.../EmployerTermsTrust.kt

**Files modified:**
- Packages:
  - persistence trust-safety.ts: the employer view, respond, appeal, share summary and request response; statements on the operator detail; AWAITING_RESPONSE now needs an allegation summary when the subject is an employer.
  - persistence application-messages.ts: the retention sweep skips a student under an active retention hold.
  - events: four events registered.
- API:
  - employer-hiring.controller.ts: the terms gate is inside the guarded publish UPDATE, and the refusal is explained.
  - employer-job-lifecycle.controller.ts: reopen is gated.
  - campus-drives.controller.ts: a drive request and a resubmit are gated.
  - employer-organisation-state.ts: new `trust.cases` action group, allowed in every state.
  - trust-safety.controller.ts: new routes `POST …/cases/:id/request-response` and `POST …/cases/:id/employer-statements`.
  - run-privacy-worker.ts: grant expiry sweep.
  - api-security.module.ts and app.module.ts: controllers registered.
- Web:
  - rolePortal/employer.tsx: only the Settings label's branch changed.
  - rolePortal/employerOrganisationState.tsx: the status page lists trust cases.
  - rolePortal/trustSafety.tsx: case timeline; "Ask for response" shares a summary first.
  - rolePortal/operations.tsx: collapsed Employer terms section on Organizations.
  - rolePortal/shared.tsx: plain messages for the new codes.
- Android: EmployerWork.kt (the TermsTrust overlay), StaffDashboards.kt (a Home entry, and a link from the suspended/rejected status screen).

**Existing tests touched (none weakened):**
- rolePortal/employerCompanyProfile.test.tsx `leaves every other unbuilt label saying so` used "Settings" as its example of an unbuilt label.
- Every recruiter label now has a screen, so the test now uses a label the dispatcher does not route. It checks the same fallback: "Not built yet" is shown and nothing is fetched.

**Migrations added:** 0084_employer_terms_and_trust_participation.sql (number assigned by the coordinator; it references only 0000–0032 tables: users, organizations, trust_cases). It adds three append-only tables (UPDATE/DELETE refused by trigger):
- `employer_terms_versions`: immutable. The body's sha256 is computed in SQL. It carries the legal-review state and requires a reference when LEGAL_APPROVED. A trigger requires the first version to be material.
- `employer_terms_acceptances`: owner only, one per version per employer, employer-kind trigger.
- `trust_case_employer_statements`: operator summaries and employer response/appeal, side tied to kind by CHECK, one appeal per case by partial unique index.

Nothing is seeded, following 0028's precedent: until operations publish a version, publishing behaves as before. The migration is idempotent: `db:migrate` ran twice and 0084 was replayed by hand in psql.
**Design docs / ADRs:** the design doc above. It covers: why not the consent registry or an organisations column; the gate and non-retroactivity; the expiry job; purges and holds; why a statements table rather than notes or evidence; what an employer sees and never sees; privacy. No ADR.

**Routes:**
- Employer:
  - GET /employers/:e/settings: every employer role; `organisation.manage`.
  - POST /employers/:e/terms/accept {version}: owner only; the latest version only.
  - POST /employers/:e/settings/notification-preferences: the caller's own row.
  - GET /employers/:e/trust-cases and GET …/trust-cases/:caseId: owner and admin; `trust.cases`, any organisation state.
  - POST …/trust-cases/:caseId/response and …/appeal {statement}: owner and admin.
- Operations:
  - GET and POST /operations/employer-terms (OPS_ORG_MANAGE).
  - POST /operations/trust-safety/cases/:caseId/request-response {summary, reasonCode} and …/employer-statements {kind, body} (TRUST_SAFETY_INVESTIGATE).
  - GET …/cases/:caseId now also returns `employerStatements` and `subjectEmployerId`.

**Validation:** fresh database one_emp16, with only DATABASE_URL exported.
- `corepack pnpm db:migrate` twice: the first run applied 71 and created the ledger; the second applied 0. 0084 was also replayed by hand in psql.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` exited 1. Every one of the 3 failures was "error: out of shared memory" in a TRUNCATE setup hook on the shared local Postgres; none touches EMP-16 code:
  - persistence career-catalogue.integration.test.ts (file setup);
  - persistence internal-capabilities.integration.test.ts (one case);
  - api institution-announcements.integration.spec.ts (one case).
- Totals for that run:
  - web 70 files / 826 tests pass; api 71 of 72 files, 1,127 of 1,128 tests pass (employer-terms-trust.integration.spec.ts 9/9); persistence 403 of 404 tests pass.
  - Other packages, all passing: authorization 333, hiring 192, career-readiness 105, learning-model 72, learning-orchestrator 54, identity 41, placement 31, mastery-bkt 29, review-scheduler 23, privacy 22, ai-orchestration 19, assessments 15, events 14, learner-content 7, automation 7.
- The three failing files were re-run alone and all pass: persistence 2 files / 21 tests, api announcements 1 file / 21 tests.
- `corepack pnpm build`: passed.
- CI parity: `corepack pnpm audit --prod --audit-level=high` exits 0 (2 moderate, no high or critical). The optional-chain policy grep prints nothing. There are no private-key blocks or merge markers.
- Android `./gradlew --no-daemon -q :app:compileDebugKotlin`: passed.
- The test commit alone was not run against the base: the routes do not exist there, so it cannot pass.

**Acceptance criteria:**
- [x] *An employer that has not accepted current terms cannot publish.* Tests: `refuses to publish, reopen or request a drive until an owner accepts the current terms` (403 EMPLOYER_TERMS_NOT_ACCEPTED, the job stays DRAFT, no drive row) and `never acts retroactively…`:
  - after a material v2, a live job stays PUBLISHED, students still see it and the process continues;
  - a new publish and a reopen are refused until the owner accepts v2;
  - a non-material version asks nobody to accept again.
  - `publishes exactly as before while no terms have been published`.
- [x] *Expired grants remove candidate access and exports.* Test: `removes candidate access the moment a grant expires, and the daily job makes it durable`.
  - On the next request the person is withheld from the list; the candidate view, the résumé link and transitions answer 403.
  - `revokeExpiredApplicantGrants` revokes only expired grants, once, with an actor-less `employer_applicant_access.expired` event, and leaves the application alone.
  - Exports: ONE has no employer export yet (EMP-17). Any export built on the shared live-grant predicate, or on `revoked_at`, already excludes these grants.
- [x] *Employer responses and appeals appear on the operator case timeline.* Test: `puts the employer response and appeal on the operator case timeline, and never names the reporter`.
  - The operator detail's `employerStatements` holds the summary, response, decision and appeal with author side.
  - `events` holds AWAITING_RESPONSE→UNDER_INVESTIGATION (EMPLOYER_RESPONDED, by the admin) and ACTIONED→APPEALED (EMPLOYER_APPEAL, by the owner).
  - There are audit rows with the organisation and outbox rows without text. The web operator timeline shows both.
- [x] Build 1: versioned terms, owner acceptance, re-acceptance on material change. The terms text is DRAFT for legal review (docs/legal/…, and a "Draft — pending legal review" label on every screen).
- [x] Build 2: the grant expiry job runs in the daily retention worker on the database clock. Deletion propagation was already complete (EMP-SR-02) and was not duplicated.
  - Purges never take what a case or hold needs: `never erases message text a retention hold still needs`. Open-case evidence was already skipped (EMP-10).
- [x] Build 3: the employer sees allegations and evidence summaries that may be shared, responds, and appeals; operators decide.
  - Only cases about itself, once disclosed: `shows an employer only the cases about itself, with its own job evidence`.
  - Evidence is limited to its own job and detector signals; the rest is counted, never described.
  - No reporter id, statement, message text, severity, notes or opening time. A suspended employer can still read its cases.
- [x] Build 4: the Settings screen shows terms status, retention information and notification preferences (web `employerSettings.test.tsx`, 11 tests).
- [x] §6.3:
  - 401 without a token; another employer 403; recruiter 403 on trust routes and on accepting; SUSPENDED 403 INACTIVE on Settings and accept (trust routes deliberately allowed); PENDING can accept.
  - Validation 400s (unknown fields, version pattern, reason codes, empty or overlong statements).
  - Audit rows written; no readiness, score or band in any response.
  - Navigation labels unchanged (asserted).

**Decisions for Divakar (recommendations taken):**
1. **Legal text is a draft.** Nothing is seeded, and operations publish a version deliberately. A version may be published as DRAFT_FOR_LEGAL_REVIEW, and it then shows as a draft everywhere. Recommendation: publish to real employers only after legal review, as LEGAL_APPROVED with the reviewer's reference.
2. **Only owners accept.** This follows the goal text ("acceptance by an owner"), although the §5.1 matrix lists admins for "employer terms". Admins and recruiters read.
3. **Scope of the gate.** It covers what puts a job in front of students anew: publish (from DRAFT or PAUSED), reopen, and a campus-drive request or resubmit. Editing a live job, pause, close, interviews and offers are not gated. It is never retroactive, and there is no grace period.
4. **Decision 10.2 #7 is kept stricter.** Every close already revokes the grant at once. The sweep acts only on grants that carry an `expires_at`, and nothing sets one yet.
5. **Disclosure.** An employer sees a case only once operations asked it to respond or decided the case. Asking needs a summary written by the operator. The operator screen warns that the employer reads the summary verbatim and that it must not identify the reporter.
6. **Who answers.** Owners and admins act for the organisation; recruiters do not. There is one appeal per case with no time window. A response moves the case to UNDER_INVESTIGATION.
7. **Publishing terms** needs OPS_ORG_MANAGE, is audited and needs a reason code. There is no OPS-02 dual control. Recommendation: add it if material versions become frequent.
8. **HG-3:** no navigation item was added, removed, renamed or reordered.
   - Settings was an existing label.
   - Trust cases live inside Settings and on the status page.
   - Terms publishing is a collapsed section of Organizations, and the timeline is inside Trust and Safety.

**Android:** changed. The employer Home screen has a "Terms and trust" entry that opens a read-only overlay. It shows:
- the terms with their DRAFT label and acceptance status;
- what ONE keeps about candidates;
- the disclosed trust cases with shared statements and actions.

A suspended or rejected employer's status screen links to it. Accepting, responding and appealing stay on the web, and the overlay says so. `./gradlew --no-daemon -q :app:compileDebugKotlin` passed (Android Studio JBR).

**Limitations / not done:**
- No in-app notification tells owners that a response is requested or that new terms need accepting. That needs `user_notifications_kind_ck` widened; the outbox events exist for a consumer.
- Operators cannot reverse an enforcement action on appeal (no route existed before; this is operations-plan work).
- Nothing sets `expires_at` today.
- The employer data export (EMP-17) is not built.
- Closed-case retention is still undecided (0032 open point 4).

**Risks / follow-ups:** if a later migration re-declares the trust-case tables' constraints, it must keep 0084's statement table in step. Moving an employer case straight to AWAITING_RESPONSE through the plain transition route now needs a summary; the web uses the combined route.
**Next goal:** EMP-17 or EMP-18, as scheduled by the coordinator.

## EMP-17 — Applicant exports and calendar integration — 2026-09-30
**Result:** Complete. Owners and admins of a verified, active employer can now export one job's applicants as a CSV file. The export works like this:
- It includes only candidates whose applicant-access grant is live at the moment of export.
- It includes only what each student shared, and contact details only from Shortlisted onward.
- Cells that start like a formula are neutralised.
- Row count is capped, each person has a daily limit, and every export is audited with its reason and SHA-256 before the file is sent.

Calendar invites remain EMP-09's. No calendar provider is integrated.

**Branch / PR:** feat/emp-exports, cut from onev4/stack/batch24 (4fab0c6), pushed to onev4; merge by review. Commits: 6f747f7 (design), cd7ed55 (acceptance tests), 034279c (API), ff921c4 (web), then this report.

**Files created:**
- docs/architecture/employer-applicant-exports-design.md
- apps/api/src/http/employer-applicant-export.ts (content rules, header rule, hash)
- apps/api/src/http/employer-applicant-export.controller.ts
- apps/api/src/http/employer-applicant-export.test.ts, with fixture employer-applicant-export.fixture.csv
- apps/api/src/http/employer-applicant-export.integration.spec.ts, with fixture employer-applicant-export.integration.fixture.csv
- apps/web/src/rolePortal/employerApplicantExport.tsx (+ .test.tsx)

**Files modified:**
- apps/api/src/http/institution-export-csv.ts: document assembly moved into a shared `csvDocument`. `toCsv` keeps its compensation-header check and behaves as before; its tests are unchanged.
- apps/api/src/http/api-security.module.ts: the new controller is registered.
- apps/web/src/api/hiring.ts: the export client and the reason list.
- apps/web/src/hiringPages.tsx: optional `canExport` on EmployerApplicantsPage.
- apps/web/src/rolePortal/employer.tsx: only the Applicants branch changed; it now passes the owner/admin flag.

**Existing tests touched:** none.

**Migrations added:** none. 0086 was not claimed: every export is an `audit_events` row, and no file is stored.

**Design docs / ADRs:** the design doc above. It covers who may export, rows and columns, what is never written, caps, limits, audit and hash, the calendar decision, and rejected options. No ADR.

**Route:** `POST /api/v1/employers/:e/opportunities/:o/applicant-export` with body `{reasonCode, scope?}`.
- `reasonCode` is one of: SHORTLIST_REVIEW, INTERVIEW_PLANNING, HIRING_COMMITTEE, OFFER_PREPARATION, RECORD_KEEPING.
- `scope` is ALL_OPEN (the default) or SHORTLISTED_ONWARD.
- The response is `text/csv` with a BOM and CRLF line ends, sent with `attachment`, `no-store`, `nosniff` and `X-Export-Sha256`.
- Refusals:
  - 401 without a token.
  - 403 FORBIDDEN for a recruiter, another employer, an ended membership, another employer's job, or a malformed id.
  - 403 EMPLOYER_ORGANISATION_INACTIVE or EMPLOYER_ORGANISATION_UNVERIFIED.
  - 400 REASON_CODE_REQUIRED, EXPORT_SCOPE_INVALID or UNKNOWN_FIELD.
  - 422 EXPORT_TOO_LARGE above 5,000 rows.
  - 429 EXPORT_RATE_LIMITED after 20 exports per person per employer in 24 hours, counted under an advisory lock.
- Each export writes an audit row, `employer.applicants.exported`, with the reason, scope, job, row count, the number of applications withheld for having no live grant, the exported application ids, and the sha256.

**Validation:** ran on a fresh database, one_emp17, with only DATABASE_URL exported.
- `corepack pnpm db:migrate`, run twice: the first run applied 74 migrations and created the ledger; the second applied 0.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm -r --no-bail --workspace-concurrency=1 test` exited 1, but no test assertion failed.
  - All 9 failing files failed with "error: out of shared memory" during schema setup or teardown on the shared local Postgres:
    - persistence: internal-capabilities;
    - API: assessments, campus-drives, counselling-notes, employer-terms-trust, institution-announcements, institution-department-workspace, institution-settings, operations-career-catalogue.
  - Totals for that run:
    - web: 75 files, 873 tests, all passed;
    - API: 69 of 77 files passed; all 1,219 tests passed;
    - persistence: 35 of 36 files passed; all 404 tests passed;
    - every other package passed: authorization 363, hiring 192, career-readiness 105, learning-model 72, learning-orchestrator 54, identity 41, placement 31, mastery-bkt 29, review-scheduler 23, privacy 22, ai-orchestration 19, assessments 15, events 14, learner-content 7, automation 7.
  - The new files all passed: employer-applicant-export.integration.spec.ts 9/9, employer-applicant-export.test.ts 25/25, employerApplicantExport.test.tsx 8/8.
- The 9 failing files were then re-run one at a time:
  - 8 passed first time: internal-capabilities 15/15, campus-drives 8/8, counselling-notes 22/22, employer-terms-trust 9/9, institution-announcements 21/21, institution-department-workspace 17/17, institution-settings 24/24, operations-career-catalogue 14/14.
  - assessments passed 16/16 but hit shared memory again in teardown. A second re-run passed 16/16 with the file green.
- `corepack pnpm build`: passed.
- CI parity:
  - `corepack pnpm audit --prod --audit-level=high` exits 0 (2 moderate, no high or critical).
  - The optional-chain policy grep prints nothing.
  - The diff has no private-key blocks, merge markers, frozen files or migrations.
- Android was not compiled, because nothing under apps/android changed.
- The test commit was not run on its own against the base, because the route does not exist there.

**Acceptance criteria:**
- [x] *Export contains only candidates with live grants.* Test: `writes the live-grant candidates exactly as the fixture, and leaves out withdrawn, expired and deleting students`.
  - The check is EMP-SR-01's predicate, run inside the audit transaction on the database clock.
  - Left out: a withdrawn student; a grant that expired and was revoked by EMP-16's `revokeExpiredApplicantGrants`; a grant past `expires_at` that the sweep has not reached yet; a student with an open deletion request.
- [x] *Cells beginning with =, +, - or @ are neutralised.*
  - The same fixture test covers a name starting `@`, a headline starting `=HYPERLINK`, a summary `-2+3`, and a phone starting `+`.
  - The unit test checks `=`, `+` and `@` against the committed CSV fixture.
  - INST-08's `csvCell` is reused, not copied.
- [x] *Build 1: owners and admins only (decision 10.2 #10).* Tests: `refuses a recruiter, another employer, an ended membership, a missing token and another employer's job`, and `…an admin may export as well as the owner`.
- [x] *Build 1: snapshot fields and stage only.* An application with no snapshot is written with nothing shared (`…never the live profile`). Contact details appear from Shortlisted onward (`exports only Shortlisted onward…`, plus the fixture rows).
- [x] *Build 1: audited and rate-limited.* Tests: `audits every export before sending…SHA-256 of the bytes sent`, and `allows 20 exports per person per employer in 24 hours and refuses the next without writing anything`.
- [x] *Build 2: calendar invites delivered with EMP-09; no two-way sync.* EMP-09's `.ics` builder, its email attachments, and the student and panellist downloads are unchanged. See decisions.
- [x] §6.3:
  - 401 without a token; 403 for another employer and for an ended membership.
  - A suspended or rejected employer gets INACTIVE; an unverified one gets UNVERIFIED.
  - A candidate without a grant is not in the file.
  - Validation 400s, the row cap, and the audit row are covered.
  - No readiness, identifier, roll number, compensation or protected attribute appears in the file (`writes no readiness, no identifier…`, plus the header word rule in the writer).
  - Web: real data, forbidden and error states, and navigation labels unchanged (asserted).

**Decisions for Divakar (recommendations taken):**
1. **Snapshot only.** Applications made before EMP-07 have no snapshot. They are exported with stage and date only, marked "Not captured". The file never falls back to the roster or the live profile, although the Applicants list still shows a roster name for them.
2. **Limits.** 5,000 rows per file and 20 exports per person per employer in 24 hours. INST-08 used 10,000 and 30; these are tighter because an employer's file carries contact details.
3. **Fixed reason list** rather than free text, so the screen offers a plain choice and the audit stays queryable.
4. **Exported application ids are kept in the audit row**, so ONE can say whose data left in which file. The file itself carries no ids.
5. **A phone number starting with `+` is written as `'+91…`**, the same rule as every other formula-leading cell. Spreadsheets show the apostrophe as a text marker.
6. **No calendar provider (Google or Microsoft).**
   - Plan §4.3 and the goal text rule out two-way sync.
   - A provider would need OAuth client credentials and per-user tokens, which ONE must not hold or invent.
   - No interface was built, because nothing would call it.
   - If sync is wanted later, it starts with a design for the token store and an ADR.
   - Nothing needs credentials today.
7. **HG-3.** The export is a section of the existing Applicants page. No navigation item was added, removed, renamed or reordered.

**Android:** no change.
- Exports are desk tasks: a CSV opens in a spreadsheet on a computer. INST-08 made the same call for every institution export.
- Calendar on Android is EMP-09's existing add-to-calendar intent (InterviewScheduling.kt, StudentHiring.kt, EmployerWork.kt). EMP-17 does not change it.
- Nothing Android changed, so no Gradle compile was needed.

**Limitations / not done:**
- There is no export across all jobs; each export covers one job.
- Assessment results and scorecards are not exported; EMP-12 and EMP-09 keep them inside ONE.
- Nothing is sent by email; the file downloads in the browser only.
- There is no operator screen for exports beyond the existing audit views.

**Next goal:** EMP-18.
