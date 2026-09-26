# Employer Portal Security Review (EMP-18, EM1 slice)

> This is the EMP-18 security review of what Wave 1 built for employers: the owner/admin
> workspace (EMP-01), organisation-state enforcement (EMP-03), team management (EMP-02), and the
> company profile and public access request (EMP-04). It maps each EMP-18 threat to the controls
> in code and the tests that prove them, and lists every problem found as an open finding to be
> fixed. It exists because EMP-18 acceptance requires every threat to map to a test or a
> documented residual risk. Programme rule B.2 says a residual risk is recorded only after its fix
> has merged, so this document records none.

| | |
|---|---|
| Review target | `6864332` (branch `docs/wave1-sops-uat-security`, the programme base for Wave 1 documents) |
| Date | 2026-09-26 |
| Scope | EM1 slice: EMP-01, EMP-02, EMP-03 and EMP-04 as merged. Because every employer route now goes through the §5.1 helper, all existing employer hiring and assessment routes are included **for the organisation-state and tenant checks only**. |
| Out of scope (later goals) | Job edit, pause and close lifecycle (EMP-05); eligibility, skills and stages (EMP-06); application snapshot, candidate view and résumé download (EMP-07); pipeline reason codes (EMP-08); interview invitations (EMP-09); offers rework (EMP-10); placement-office policies and drives (EMP-11); screening-assessment gap filling (EMP-12); evidence sharing (EMP-13); talent discovery and search (EMP-14); messaging (EMP-15); trust cases and settings (EMP-16); exports and reports (EMP-17); the EM3 full review (EMP-18). |
| Method | Code reading of the files listed in §3. Every control is cited as `path:line` at the review target. Tests were found by searching the spec files and are cited as `spec › test name`; where no test exists the document says so. The progress log, baseline and design note were used only to find code; each claim was checked against the code. No code was run for this review. |
| Normative source | ONE Program Goal, Appendix 2 §5 (§5.1 authorisation, §5.2 candidate data, §5.3 evidence not readiness, §5.4 fairness, §5.7 audit, §5.8 fraud, §5.9 errors), §6.1 API conventions, §6.3 minimum tests, EMP-18. |

## 2. Conclusion

The EM1 slice is broadly sound. The §5.1 helper is applied to every employer route. REJECTED is
refused even though it keeps `active = true`. Team and profile writes run in one transaction with
their audit row, re-read the organisation's state under a row lock, and use reason codes from
fixed lists. The public access request creates nothing and cannot be used to enumerate employers.

The largest problem pre-dates the slice, but it sits in the path of the EMP-18 threat model. The
applicant-access grant is never consulted when an employer reads or acts on candidate data. It is
checked only by one standalone probe route, so revoking a grant stops nothing. Three problems are
new in this slice: the web employer page acts on the first employer membership rather than the
chosen workspace, pending team invitations outlive the person who sent them, and team invitations
have no rate limits.

| Severity | Open findings |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 7 |
| Low | 11 |
| **Total** | **19** |

## 3. Files reviewed

API and persistence
- `apps/api/src/http/employer-organisation-state.ts`
- `apps/api/src/http/employer-hiring.controller.ts`
- `apps/api/src/http/employer-assessments.controller.ts`
- `apps/api/src/http/student-hiring.controller.ts`
- `apps/api/src/http/calendar.controller.ts`
- `apps/api/src/http/employer-team.controller.ts`
- `apps/api/src/http/employer-company-profile.controller.ts`
- `apps/api/src/http/employer-access-requests.controller.ts`
- `apps/api/src/http/operations-institution-onboarding.controller.ts` (verification, suspension pause, initial invitation, URL normaliser)
- `apps/api/src/http/api-security.ts`, `apps/api/src/http/phase1-security.controller.ts` (applicant-access probe, security context)
- `apps/api/src/application/identity-organization/services.ts` (`canAssignRole`)
- `packages/persistence/src/employer-authentication.ts`
- `packages/persistence/src/identity-authentication.ts` (membership loading, invitation acceptance)
- `packages/persistence/src/repositories.ts` (`assertActiveEmployerGrantForMutation`)
- `packages/persistence/drizzle/0041_employer_company_profile_and_access_requests.sql`
- `packages/hiring/src/review-signals.ts` (payment-demand detector)

Web
- `apps/web/src/App.tsx` (`workspaceForMembership`)
- `apps/web/src/rolePortalPages.tsx`
- `apps/web/src/rolePortal/employer.tsx`, `employerTeam.tsx`, `employerCompanyProfile.tsx`, `employerOrganisationState.tsx`, `operationsEmployerAccessRequests.tsx`
- `apps/web/src/publicEmployerAccessPage.tsx`, `apps/web/src/hiringPages.tsx`, `apps/web/src/api/hiring.ts`

Android (only to confirm that they show server data and no readiness)
- `apps/android/app/src/main/java/pro/ai8ht/one/EmployerTeam.kt`, `EmployerCompanyProfile.kt`, `EmployerOrganisationState.kt`, `StudentHiring.kt` (company block), `StaffDashboards.kt` (workspace mapping)

Tests searched
- `apps/api/src/http/employer-organisation-state.integration.spec.ts`, `employer-team.integration.spec.ts`, `employer-company-profile.integration.spec.ts`, `hiring.integration.spec.ts`, `employer-assessments.integration.spec.ts`, `api-security.integration.spec.ts`, `employer-hiring.controller.test.ts`
- `packages/persistence/test/employer-authentication.integration.test.ts`
- `apps/web/src/employerWorkspace.test.tsx`, `employerOrganisationState.test.tsx`, `publicEmployerAccessPage.test.tsx`, `hiringPages.test.tsx`, `rolePortal/employerTeam.test.tsx`, `rolePortal/employerCompanyProfile.test.tsx`

Documents used to locate code: `docs/employer/EMPLOYER_PROGRESS.md`, `docs/employer/EMPLOYER_BASELINE.md`, `docs/architecture/employer-access-requests-table-design.md`.

## 4. Threats

### 4.1 Cross-employer data access

**Verified controls**
- The helper `requireActiveEmployer` is §5.1 in order. Step 1 is an ACTIVE membership whose organisation and employer scope both equal the path's `employerId`, in a role the route allows (`apps/api/src/http/employer-organisation-state.ts:85-97`). Steps 2 and 3 are the organisation's `active` flag and its verification state (`:100-105`, `:53-59`). A malformed id gets 403, not 400 (`:87`).
- Memberships are loaded from the database with `state = 'ACTIVE'` on every request (`packages/persistence/src/identity-authentication.ts:46-82`), so an ended membership loses access on the next request.
- Every lookup of a resource also filters on the employer: opportunity `employer-hiring.controller.ts:819-827`; application `:829-841`; interview `:595`, `:628`; offer `:720`; assessments `employer-assessments.controller.ts:243`, `:271`, `:328`; team invitation `employer-team.controller.ts:347-352`; team membership `:297-302`.
- Interview participants must be ACTIVE members of the same employer, locked while the interview is written (`employer-hiring.controller.ts:540-548`).
- Team and profile routes use `requireEmployerMembership` + `assertEmployerState`, which are the two halves of the same helper (`employer-team.controller.ts:319-328`, `:105`; `employer-company-profile.controller.ts:91-92`, `:101-104`).
- On Android, each employer screen is keyed by the chosen workspace's `organizationId` (`StaffDashboards.kt:69-85`).

Tests: `employer-team.integration.spec.ts › refuses another employer, an ended membership and a suspended membership`; `employer-company-profile.integration.spec.ts › refuses another employer, ended and suspended memberships, and answers 401 without a token`; `hiring.integration.spec.ts › does not let a rival employer touch the opportunity`, `› shows the applicant to the owning employer only`, `› does not let a rival employer list employer interview or offer records`; `employer-hiring.controller.test.ts › scopes the applications, offers and opportunities to the caller employer and returns no identity columns`; `employer-team.integration.spec.ts › ends a membership: access stops on the next request, past actions stay in audit, and the end is audited`.

**Open findings**
- EMP-SR-03 (Medium): the web employer page acts on the first employer membership, not the chosen workspace.

### 4.2 Insecure direct object references on applications and résumés

**Verified controls**
- Every application route resolves the application through `requireOwnedApplication`, which matches `a.id` **and** `a.employer_id` and excludes DRAFT (`employer-hiring.controller.ts:829-841`). The route then writes with `employer_id` in the WHERE clause again (`:295`). Routes covered: transition `:270`, feedback `:349`, schedule interview `:515` (re-locked `:535-539`), extend offer `:683`.
- The applicant list checks that the opportunity belongs to the employer (`:239`) and filters on `a.employer_id` (`:252`).
- Offers and interviews are matched by employer (`:720`, `:595`, `:628`).
- Assessment invitations accept only applications of this employer that are open, consented and live (`employer-assessments.controller.ts:280-289`).
- **Résumés:** no employer route serves a résumé or any stored document today. A search of every employer controller and `apps/api/src/http/*.controller.ts` for résumé routes found none. Signed, grant-bound résumé download is EMP-07 and is not in this slice.

Tests: `hiring.integration.spec.ts › shows the applicant to the owning employer only`, `› does not let a rival employer touch the opportunity`. No test calls an application-id route with another employer's application id under the caller's own `employerId` path.

**Open findings**
- EMP-SR-01 (High): the employer id is enforced, but the applicant-access grant is not (see 4.3).
- EMP-SR-16 (Low): the employer-side interview outcome route skips the consent and closed checks.

### 4.3 Grant bypass (`employer_applicant_access_grants`)

**Verified controls**
- A grant is created in the apply transaction, scoped to employer + student + opportunity (`student-hiring.controller.ts:341-345`).
- It is revoked on withdrawal (`:473-480`, together with `consent_revoked_at` at `:465`) and when the employer closes the application as HIRED or REJECTED (`employer-hiring.controller.ts:302-310`).
- The persistence check `assertEmployerApplicantAccessForAuthenticatedPrincipal` requires all of the following:
  - an ACTIVE membership in an employer role with matching scope (`packages/persistence/src/employer-authentication.ts:25-31`);
  - a VERIFIED and active employer organisation (`:34-38`, EMP-03);
  - `revoked_at IS NULL` and an `expires_at` that is either null or in the future (`:42-43`);
  - a lock option for mutations (`:20`).

Tests: `packages/persistence/test/employer-authentication.integration.test.ts › requires an active employer membership and active applicant grant for the same employer`, `› denies suspended employer memberships and revoked or expired grants`, plus the SUSPENDED/REJECTED/PENDING/UNDER_REVIEW cases from EMP-03 (progress log). Also `hiring.integration.spec.ts › accepts an application with consent and grants scoped employer access`, `› closes employer access once the application is closed`, `› revokes employer access when a student withdraws`.

**Open findings**
- EMP-SR-01 (High): no candidate read or write consults the grant. The only caller of the grant check is the standalone probe `GET /employers/:employerId/applicant-access/...` (`api-security.ts:327-351`, `phase1-security.controller.ts:45`). The tests above for "closes access" check that the grant row was revoked, not that data stops flowing.
- EMP-SR-02 (Medium): the grant lifecycle is incomplete. There is no expiry and no revocation on account deletion.

### 4.4 Readiness leakage

**Verified controls**
- A search of every employer controller for `readiness`, `mastery`, `gap`, `band` and `fit` finds only comments and the company-size band (`employer-company-profile.controller.ts:48`). The mappers that shape employer responses (`employer-hiring.controller.ts:930-1034`, `employer-assessments.controller.ts:334-345`, `employer-team.controller.ts:132-165`, `employer-company-profile.controller.ts:170-192`, `employer-hiring.controller.ts:117-126`) contain no readiness band, readiness score, gap status or mastery field.
- `score`, `maxScore` and `percentage` on assessment results come from the employer's own screening test and never touch readiness (`employer-assessments.controller.ts:14-15`, `:545`).
- Android employer screens render only server DTOs, with no readiness fields (`EmployerTeam.kt:75`, `EmployerCompanyProfile.kt:64`, `EmployerOrganisationState.kt:43`).

Tests: `employer-team.integration.spec.ts › carries no readiness, score or internal error text in any team response`; `employer-company-profile.integration.spec.ts › lets an owner and an admin edit the student-facing fields, audited, and a recruiter only read them` (key regex at `:123`, `:139`); `employer-assessments.integration.spec.ts › shows the employer no readiness band alongside the score`, `› writes nothing to evidence, mastery or readiness, and moves no application`.

**Open findings**
- EMP-SR-07 (Medium): no single contract test covers every employer response (§5.3, §6.3).

### 4.5 Scraping through search or exports

**Verified controls**
- There is no employer-side search over students, no talent pool, and no export route. No employer controller or employer web page contains `csv`, `export` or download code.
- The only search is the student's job search. It is authenticated, parameterised, capped at 80 characters and 100 rows, and limited to verified employers (`student-hiring.controller.ts:175-196`).
- Employer lists are bounded: 200 opportunities (`employer-hiring.controller.ts:173`), 500 applicants, interviews and offers (`:255`, `:505`, `:673`), and a team page of at most 200 (`employer-team.controller.ts:76-77`, `:482-487`).

Not in this slice: talent discovery (EMP-14), exports and keyset pagination of hiring lists (EMP-17).

**Open findings**
- None specific to this slice. The unpaginated 500-row hiring lists are noted in §6.

### 4.6 Messaging abuse

Not built. No messaging route or table serves employers, and the web Messages label shows the unbuilt empty state. Messaging is EMP-15 and not in this slice. The only employer-originated outbound message today is the team invitation email (see 4.9).

**Open findings:** none in this slice.

### 4.7 Fake employers

**Verified controls**

The public access request (`employer-access-requests.controller.ts:106-159`):
- It creates only an attempts row, a PENDING request and an outbox event with no actor. It never reads `organizations` (`:116-157`). Nothing in the table can express "verified" (0041 `:62-95`, state check `:85`, organisation-link checks `:93-94`, `:104-123`).
- It answers every well-formed submission with the same `202 {received:true}` (`:107`, `:158`), including repeats, which only bump a count (`:136-143`).
- Unknown fields are refused (`:311-312`). Lengths and formats are checked in code and again in the database (0041 `:79-84`).
- Rate limits are 5 per address per hour, 10 per email domain per day and 200 per hour overall (`:62`, `:120-131`). They are serialised by an advisory lock (`:118`), and attempts older than 2 days are pruned (`:119`).
- X-Forwarded-For is trusted only when the socket peer is loopback or a private address, and then only the right-most entry is used (`:266-281`).
- Public webmail is refused unless the flag `employer-access.allow-free-mail` is on, and is then flagged (`:112-113`, `:255-258`; 0041 `:141-145`, default off).

Operator decisions:
- Queue and decision need `OPS_ORG_MANAGE` (`:247-253`).
- A decision is locked FOR UPDATE, must come from PENDING, uses fixed reason codes, links only EMPLOYER organisations and is audited in the same transaction (`:209-245`, `:78-82`, `:329-342`).
- ONBOARDED never changes verification state. Verification needs `OPS_VERIFY` (`operations-institution-onboarding.controller.ts:196`). Suspension is dual-controlled (`:201-214`).

Tests: `employer-company-profile.integration.spec.ts › records a pending request and creates nothing else — no user, organisation, membership or invitation`, `› answers identically for a repeat and for a company already on ONE, so it cannot be used to enumerate`, `› refuses a public webmail address unless Operations allows it, then flags it`, `› rate-limits by network address and by email domain, without saying anything about records`, `› validates the form and refuses unknown fields`, `› shows requests as pending to Operations only, with possible matches, and records a decision without verifying anything`, `› paginates the queue with a bounded page size and validates the query`; web `publicEmployerAccessPage.test.tsx › links a request to an employer only with a reason, and offers only employers to link`.

Limitations, not defects:
- The requester's email is never confirmed (HG-7; the queue says so at `:390-391`).
- The free-mail list (`:66-72`) is a signal, not a proof: any cheap domain passes.

**Open findings**
- EMP-SR-06 (Medium): the access-request limits can be turned against genuine requesters.
- EMP-SR-11 (Low): `emailMatchesWebsite` accepts a parent domain.
- EMP-SR-12 (Low): the rate-limit digest is an unsalted hash of the address.
- EMP-SR-13 (Low): the Operations "initial" invitation mints an owner for any state, on every call (EMP-01 limitation).

### 4.8 CSV injection

**Verified controls**
- No employer surface imports or exports CSV today.
- Some hiring fields refuse a leading `=`, `+`, `-` or `@` at input (`employer-hiring.controller.ts:37`, `:1066-1070`).

Not in this slice: exports with output neutralisation (EMP-17, whose acceptance requires it).

**Open findings**
- EMP-SR-18 (Low): neutralisation is input-side, partial, and absent from the EM1 fields.

### 4.9 Notification spoofing (team invitation emails)

**Verified controls**
- Who can trigger an invitation: an ACTIVE owner or admin of that employer (`employer-team.controller.ts:64`, `:319-328`), within `canAssignRole` (`:176`; `services.ts:702-719`). The employer must not be SUSPENDED or REJECTED, and this is re-checked under a row lock (`:175`, `:182`, `:336-344`).
- To whom: one validated address with no CR or LF (`:75`, `:466-470`). Current members are refused (`:183-189`). Only one invitation may be pending per address (`:196-199`, plus a unique index mapped at `:446`).
- Content: the subject is a constant (`:80`). The body is plain text built from the Operations-held legal name, a role label from a fixed map, the invitee's own address and the link (`:385-390`). The employer cannot set any free text in the email. The link token is stored only as a digest (`:204`), and a resend replaces it (`:261`).
- Acceptance: the token must match, the recipient's verified email must match, and the invitation must be PENDING, unexpired and unrevoked, all under FOR UPDATE (`identity-authentication.ts:117-126`, consumed at `:177-188`). A different bound identity is refused (`:152-157`). The membership is created with the invitation's scope (`:199-213`).
- Delivery is honest. With no sink the invitation is recorded NOT_CONFIGURED. A failure records FAILED or BOUNCED, and nothing claims a send (`:205`, `:383-422`).

Tests: `employer-team.integration.spec.ts › lets an owner invite an admin and a recruiter, but not another owner`, `› lets an admin invite a recruiter only`, `› refuses a recruiter every team route`, `› refuses acceptance by an identity whose verified email is not the invited one`, `› resends with a new link: the old link stops working, the new one accepts, and it is audited`, `› refuses to invite a current member or a second pending invitation, and replaces an expired one`, `› records NOT_CONFIGURED when no mail sink exists (HG-7) and never claims a send`, `› keeps the invitation and records FAILED when the sink cannot send`, `› refuses a SUSPENDED employer every team route, so it cannot invite anyone` (the it.each covers SUSPENDED and REJECTED).

**Open findings**
- EMP-SR-05 (Medium): invite and resend have no rate limits.
- EMP-SR-04 (Medium): pending invitations survive the removal of the person who sent them.

### 4.10 Role-matrix enforcement

**Verified controls**
- Owner → admin or recruiter; admin → recruiter; recruiter → nothing (`services.ts:712-715`; `employer-team.controller.ts:64`, `:176`). Nobody can invite an owner through the team routes.
- Ending a membership follows `canAssignRole`, and an owner may also end another owner (`:86-88`, `:305`). So an admin cannot end an admin or an owner, and cannot revoke or resend an admin invitation (`:355`). An admin cannot remove themselves (`mayEndMembership('EMPLOYER_ADMIN','EMPLOYER_ADMIN')` is false). An owner can remove themselves only if they are not the last owner.
- Last-owner protection and concurrency: all ACTIVE owners are locked in id order before the target (`:291-302`), and the count excludes the target (`:307`).
- A person holding two roles acts with the broader one (`:321-326`).
- Company profile: owners and admins write, recruiters read (`employer-company-profile.controller.ts:58`, `:91`, `:101`). Hiring routes allow owner, admin and recruiter (`employer-hiring.controller.ts:40`, `employer-assessments.controller.ts:53`), which matches §5.1. The interview-participant guard also requires assignment (`employer-hiring.controller.ts:56-89`).

Tests: `employer-team.integration.spec.ts › does not let an admin end an admin or an owner`, `› does not let an admin revoke or resend an admin invitation`, `› refuses to end the only owner, including by themselves`, `› lets one of two owners end the other, then keeps the remaining owner`, `› never lets two owners end each other at the same time and leave nobody`; web `employerTeam.test.tsx › offers an admin recruiters only`, `› tells a recruiter Team is managed by the owner or admin and never calls the team API`.

**Open findings:** EMP-SR-03 (display role taken from the wrong membership), EMP-SR-04.

### 4.11 Organisation-state enforcement (including REJECTED with active = true)

**Verified controls**
- `employerStateRefusal` refuses everything except `organisation.status` when the organisation is inactive, SUSPENDED or REJECTED. The check keys on the state, not only on `active` (`employer-organisation-state.ts:53-59`). PENDING and UNDER_REVIEW organisations may use `organisation.manage` and `jobs.draft` only.
- The student side uses the same rule as SQL (`:120-124`) on the job list, detail and apply (`student-hiring.controller.ts:193`, `:224`, `:299`, `:599`). It is also applied in the interviewer calendar (`calendar.controller.ts:191-192`), in the participant assignment predicate (`employer-hiring.controller.ts:85-88`) and in the grant check (`employer-authentication.ts:34-38`).
- Suspension sets `active=false` and pauses every published job in the same transaction, with an audit row and outbox event per job (`operations-institution-onboarding.controller.ts:215`, `:222`, `:235-245`). Reinstatement does not republish. REJECTED can only be reached from UNDER_REVIEW (`:996-1003`), so a rejected employer never has published jobs.

Tests: `employer-organisation-state.integration.spec.ts › refuses every employer route to a SUSPENDED organisation, and says why` and the REJECTED case (it.each over `[['SUSPENDED', false], ['REJECTED', true]]`), `› lets a PENDING organisation draft but not publish or reach candidates` and the UNDER_REVIEW case, `› lets every member read their own organisation status in every state`, `› pauses on suspension, hides the job and its applicants, and keeps it paused on reinstatement`, `› hides and refuses a published job whose employer is rejected, unverified or inactive, even without a pause`, `› refuses to publish for a recruiter whose organisation operations suspended`; web `employerOrganisationState.test.tsx › shows a rejected employer the plain status page on the dashboard too`, `› keeps every navigation label for a suspended employer`.

**Open findings**
- EMP-SR-14 (Low): students can still start and submit a suspended employer's screening tests (EMP-03 limitation).
- EMP-SR-19 (Low): the state-matrix test omits four guarded routes.

### 4.12 TOCTOU on publish and invite (row locks)

**Verified controls**
- Opportunity publish re-checks the state inside the UPDATE, under `FOR SHARE` on the organisation row (`employer-hiring.controller.ts:217-224`).
- Team invite and resend lock the organisation `FOR NO KEY UPDATE` and re-check its state (`employer-team.controller.ts:182`, `:257`, `:336-344`). The invitation row is locked (`:346-358`).
- Company-profile write locks the organisation and profile rows and re-checks the state (`employer-company-profile.controller.ts:109-121`).
- Suspension locks the organisation FOR UPDATE (`operations-institution-onboarding.controller.ts:208`).

Tests: `employer-team.integration.spec.ts › never lets two owners end each other at the same time and leave nobody`. No test races a suspension against publish, invite or profile write.

**Open findings**
- EMP-SR-15 (Low): candidate writes and assessment publish have no lock and no in-statement state re-check.

### 4.13 Mass assignment

**Verified controls**
- Team routes reject unknown body and query keys (`employer-team.controller.ts:450-459`, `:102`).
- The company profile refuses Operations-controlled fields by name, with 403 `COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED` (`employer-company-profile.controller.ts:54-57`, `:202-204`). Any other unknown key gets 400 (`:205`). Column names come from a fixed map before `sql.raw` (`:59-61`, `:127`).
- The Operations PATCH writes only its own columns (progress log; test below).
- The access request and the decision reject unknown keys (`employer-access-requests.controller.ts:312`, `:332`, `:171`).

Tests: `employer-company-profile.integration.spec.ts › refuses a legal-name change, and every other field Operations verifies, from the employer side`, `› survives an Operations edit: the employer fields are not wiped by the Operations profile update`; `employer-team.integration.spec.ts › rejects malformed input with 400 before touching anything`.

**Open findings**
- EMP-SR-08 (Medium): the pre-existing hiring routes ignore unknown fields instead of rejecting them, among other gaps.

### 4.14 Audit, reason codes and errors

**Verified controls**

Audit and reason codes in the EM1 slice:
- Team invite, revoke, resend and end each write their audit and outbox rows in the same transaction. Each row carries actor, organisation, correlation id and a reason code from a fixed list (`employer-team.controller.ts:68-72`, `:208-211`, `:236-239`, `:269-270`, `:309-312`, `:477-480`).
- A company-profile write is audited with the changed field names, in its transaction (`employer-company-profile.controller.ts:133-145`).
- An access-request decision is audited in its transaction (`employer-access-requests.controller.ts:234-238`).
- Verification changes and pauses are audited (`operations-institution-onboarding.controller.ts:216-222`, `:242-243`). The reason code must match `^[A-Z0-9_:-]{3,64}$` (`:200`; DB check for access requests, 0041 `:87`).

Errors:
- State refusals return a fixed code, `Access denied` and the correlation id (`employer-organisation-state.ts:104`).
- Team, profile and access-request errors pass through `domainError` / `mapWriteError`, which map database errors to fixed codes and never echo upstream text (`employer-team.controller.ts:430-448`, `employer-company-profile.controller.ts:258-270`, `employer-access-requests.controller.ts:154-157`, `:240-243`).

Tests: `employer-team.integration.spec.ts › audits the invitation and records its delivery`, `› revokes a pending invitation so it can no longer be accepted, once, and audits why`; web `employerTeam.test.tsx › explains a refusal plainly with its reference and never shows upstream text`, `employerCompanyProfile.test.tsx › reports a refused change plainly, with its reference`.

**Open findings**
- EMP-SR-08 (Medium): pre-existing hiring and assessment writes fall short of §5.7 and §6.1.

### 4.15 Web and Android surfaces

**Verified controls**
- Workspace mapping sends owner, admin and recruiter to the employer portal, one entry per organisation, broadest role first (`apps/web/src/App.tsx:579-600`).
- The state gate uses the chosen workspace's organisation (`rolePortalPages.tsx:198`, `:345`, `:347`).
- Company text is rendered as React text, never as HTML: the about text at `hiringPages.tsx:240`, and the list line at `:176`. No `dangerouslySetInnerHTML` appears in any employer, hiring or access-request page. The website and careers links are `https:` only in both API and database, and open with `rel="noopener noreferrer"` (`:241-245`; 0041 `:37`; Operations normaliser `operations-institution-onboarding.controller.ts:1236-1246`).
- The Operations queue renders submitted URLs and emails as plain text, not links (`operationsEmployerAccessRequests.tsx:127-128`).
- Android shows the company about text and links as plain text, not tappable (`StudentHiring.kt:264-267`, `EmployerCompanyProfile.kt:156-159`).

Tests: `employerWorkspace.test.tsx › lands an EMPLOYER_OWNER in the employer workspace` (it.each), `› offers both workspaces to an employer admin who also administers an institution`, `› opens one employer workspace for an owner who is also a recruiter of the same employer`; `hiringPages.test.tsx › shows the verified company profile on the job, list and detail`, `› says a description is missing instead of inventing one`; `employer-company-profile.integration.spec.ts › carries the company block in the listing and the detail of a published job`.

**Open findings**
- EMP-SR-03 (Medium): the page acts on the first employer membership.
- EMP-SR-09 (Low): gaps in the careers-page host check.
- EMP-SR-10 (Low): the about-text payment detector is easily evaded.

## 5. Findings in detail

Each finding is open. None has a proving test yet; the "Proving test" line names the test that
should close it.

**EMP-SR-01 — High — Candidate data is served without a live applicant-access grant**
- Where: `apps/api/src/http/employer-hiring.controller.ts:243-256` (applicant list returns name, email and institution student id), `:488-506` (interviews), `:656-674` (offers), `:829-841` (`requireOwnedApplication`, used by transition, feedback, interview and offer writes); `apps/api/src/http/employer-assessments.controller.ts:316-331` (results return email and name). The only caller of the grant check is `api-security.ts:327-351`. The baseline already flagged this (EMPLOYER_BASELINE.md, "Other corrections").
- Why it matters: §5.2 says "No grant, no data". The grant is revoked when an application closes (`employer-hiring.controller.ts:302-310`) and on withdrawal. Withdrawal also masks identity through `consent_revoked_at`, but an application the employer REJECTED or HIRED keeps the candidate's name, email and roll number visible indefinitely. The same applies when a grant is revoked by any future path, such as sharing revocation or account deletion. So revoking a grant has no effect on what the employer sees.
- Fix: in every candidate read, join a live grant (`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, the predicate in `employer-authentication.ts:39-43`). Where there is no live grant, withhold the identity fields exactly as `mapApplicantRow` does for revoked consent (`:946-963`). Keep the application id and state so the pipeline and feedback release (which needs a REJECTED application, `:352`) still work. For candidate writes, use `assertActiveEmployerGrantForMutation` (`packages/persistence/src/repositories.ts:141-160`) in the write transaction, with an explicit exception for feedback release.
- Proving test: a new API spec in which, after REJECTED and after a revoked grant, the applicant, interview, offer and assessment-result responses carry no name, email or institution student id; and a write that needs a grant returns 403.

**EMP-SR-02 — Medium — The grant lifecycle has no expiry and no revocation on account deletion**
- Where: apply inserts the grant without `expires_at` (`student-hiring.controller.ts:341-345`). Nothing else sets it. The column exists from 0001 (`0001_identity_organization_persistence.sql:122`, `:126`). A search of `packages/privacy` found no reference to `employer_applicant_access_grants` or `consent_revoked_at`.
- Why it matters: §5.2 requires expiry after close (proposed 180 days, decision 10.2 #7) and revocation on account deletion. Once EMP-SR-01 is fixed, the grant becomes the control, so it must end when it should.
- Fix (EMP-07): set `expires_at` when an application closes, and revoke grants in the account-deletion path.
- Proving test: persistence or API tests for "closed + 180 days → refused" and "deleted account → refused".

**EMP-SR-03 — Medium — The web employer page acts on the first employer membership, not the chosen workspace**
- Where: `apps/web/src/rolePortal/employer.tsx:41` picks `context.memberships.find(...)` for Opportunities, Applicants, Interviews, Offers, Reports, Team and Company Profile. The gate around it uses `authenticatedWorkspace.organizationId` (`apps/web/src/rolePortalPages.tsx:347`). This is recorded in the progress log as an EMP-02 limitation for the role label only.
- Why it matters: a person who belongs to two employers and selects employer B sees B's state gate, but the page reads and writes employer A. Drafting, publishing, moving applicants, inviting team members and editing the company profile all land in the wrong organisation. The server allows this because the person really is a member of A, so it is an integrity problem rather than an authorisation bypass. The page also shows A's candidate data under B's heading. The label issue the log records (a person who is both recruiter and owner sees the recruiter message) comes from the same line.
- Fix: pass `authenticatedWorkspace.organizationId` into `EmployerRecruiterRealityPage`, and take the role as the broadest ACTIVE employer role **for that organisation**, as `employer-team.controller.ts:321-326` does on the server.
- Proving test: a web test with two employer memberships that selects the second and asserts that every API call uses the second employer's id.

**EMP-SR-04 — Medium — Pending team invitations survive the removal of the person who sent them**
- Where: ending a membership changes only the membership row (`employer-team.controller.ts:287-314`). Acceptance checks the token, the email and the invitation state, not whether the inviter still belongs to the employer (`packages/persistence/src/identity-authentication.ts:117-126`, `:177-188`).
- Why it matters: an admin who is ended with reason `SECURITY_CONCERN` may have invited a second address they control. That invitation stays acceptable for up to 14 days and becomes a fresh ACTIVE membership. The owner can see and revoke it only if they notice it.
- Fix: in the end transaction, revoke the PENDING invitations for this employer whose `invited_by_user_id` is the ended user, with audit, at least when the reason is `SECURITY_CONCERN`. Alternatively, refuse acceptance when the inviter no longer holds an ACTIVE membership that could grant the role.
- Proving test: an admin invites a recruiter, the owner ends the admin, and acceptance of the recruiter invitation is refused.

**EMP-SR-05 — Medium — Team invite and resend have no rate limits**
- Where: `employer-team.controller.ts:168-217` (invite) and `:244-277` (resend, which mints a new link and sends again on every call). There is no count, cooldown or cap per employer, actor or invitation. `send_count` is recorded (`:401`) but never checked.
- Why it matters: any owner or admin, including one from an unverified (PENDING) employer, can make ONE send ONE-branded mail naming their organisation to any number of addresses. They can also resend repeatedly to one address. That damages sender reputation and can be used for harassment. Today the risk is latent because production has no mail sink (HG-7), and it becomes live when HG-7 is decided.
- Fix: cap invitations per employer per day (lower for unverified employers), add a resend cooldown and a maximum `send_count` per invitation, and return a 429 with a fixed code.
- Proving test: an API spec showing that invitations over the cap and a resend inside the cooldown are refused and send nothing.

**EMP-SR-06 — Medium — The access-request limits can be turned against genuine requesters**
- Where: `employer-access-requests.controller.ts:62`, `:114`, `:120-131`, `:266-273`.
- Why it matters:
  - The per-domain limit is keyed on the domain the anonymous submitter types, so ten submissions naming `@company.example` from two addresses block that company's genuine request for a day.
  - The per-address key is the full client address, so one IPv6 host can rotate through its /64 and exhaust the overall cap of 200 per hour, which closes the form for everyone.
  - The response for a blocked request is the same 429 in both cases, so the genuine requester has no recourse.
- Fix: key IPv6 addresses on their /64. Count a domain only for new pending requests, not for repeats or refused ones, or let the domain limit mark requests for review instead of refusing them. Treat the overall cap as an alert rather than a hard refusal, or raise it and add per-/24 and per-/64 limits.
- Proving test: an API spec showing that submissions naming another domain from other addresses do not stop a later genuine submission being recorded (as PENDING, and flagged if needed), and that several addresses in one /64 share one per-address count.

**EMP-SR-07 — Medium — No contract test that every employer response is free of readiness fields**
- Where: only per-feature checks exist, at `employer-team.integration.spec.ts:484-488`, `employer-company-profile.integration.spec.ts:123`, `:139` and `employer-assessments.integration.spec.ts:307-313`. Applicants, interviews, offers, analytics, opportunities, organisation status, participant options and my-interviews are not asserted.
- Why it matters: §5.3 and §6.3 require the absence to be asserted "from every employer response". The code has no such field today (4.4), but nothing catches a future join that adds one.
- Fix: one spec that seeds a verified employer with an applicant who has readiness, mastery and gap data, then calls every GET in the route inventory (§6). It asserts that no key matches `/readiness|band|mastery|gap|fit/i` and that no value contains the readiness band vocabulary. Assessment `score`, `maxScore` and `percentage` are allowlisted explicitly as the employer's own test.
- Proving test: that spec.

**EMP-SR-08 — Medium — Pre-existing hiring and assessment writes fall short of §5.7 audit and §6.1 input rules**
- Where:
  - `writeAudit` omits `organization_id` (`employer-hiring.controller.ts:863-868`).
  - Create, audience, publish, transition, interview state, employer outcome, offer and withdraw use separate statements rather than one transaction with their audit and outbox rows (for example `:143-156`, `:188-193`, `:217-226`, `:289-312`, `:606-612`, `:633-644`, `:702-711`, `:730-734`).
  - The rejection `reasonCode` is free text of up to 64 characters, not from a fixed list, and is optional for REJECTED (`:266`, `:293`).
  - Assessment publish and invitations write no audit at all (`employer-assessments.controller.ts:251-255`, `:292-307`).
  - Hiring bodies ignore unknown fields rather than rejecting them (`employer-hiring.controller.ts:897-928`).
- Why it matters: a failure between statements can leave a state change with no audit row, or an audit row with no change. Audit rows cannot be filtered by organisation, and rejections are not comparable. §5.4 requires every rejection to carry a reason code.
- Fix: EMP-05 (job lifecycle), EMP-07 and EMP-08 (pipeline and reason codes), EMP-12 (assessments). Wrap each write with its audit and outbox rows in one transaction, pass `organization_id`, use fixed reason-code lists and reject unknown fields.
- Proving test: per goal, "audit row written in the same transaction with organisation and reason code", plus "unknown field → 400".

**EMP-SR-09 — Low — Gaps in the careers-page host check**
- Where: `employer-company-profile.controller.ts:122-125`, `:232`, `:237-256`.
- Why it matters:
  - User-info is accepted (`https://jobs@careers.example.com/...`), whereas the Operations normaliser refuses it (`operations-institution-onboarding.controller.ts:1244`).
  - Stripping a leading `www.` widens the match to the whole apex of a shared host, for example every tenant of a hosting provider's domain.
  - The check runs only when the employer edits the careers URL, so if Operations later changes the website, a now off-domain careers link stays live.
  - Students see it as a clickable "Careers page" link (`hiringPages.tsx:244`), which makes it a phishing vector if any of these gaps are used.
- Fix: parse and re-serialise with the Operations normaliser (refuse user-info, credentials and fragments). Match against a registrable-domain (public-suffix) comparison rather than a raw `www.` strip. Re-validate or clear `careers_page_url` whenever Operations changes `website_url`.
- Proving test: API cases for user-info, a shared-host apex, and a website change that invalidates an existing careers URL.

**EMP-SR-10 — Low — The about-text payment detector is easily evaded, and the text can carry off-platform contact**
- Where: `employer-company-profile.controller.ts:219-224`, using `packages/hiring/src/review-signals.ts:19-26`.
- Why it matters: the detector is an English keyword heuristic. Phrasing without its verbs and nouns ("caution money collected at joining"), other languages, and currency symbols with no verb all pass. The about text can also carry URLs, phone numbers or messaging handles that invite students to pay off-platform. Rendering is plain text, so there is no XSS risk (`hiringPages.tsx:240`).
- Fix: record a review signal for profile edits, as job publish does (`employer-hiring.controller.ts:771-812`), so Operations sees them. Add URL and phone detection as signals, not refusals, and let students report the company (EMP-16).
- Proving test: a profile edit containing a phone number or URL records a signal that is visible to Operations.

**EMP-SR-11 — Low — `emailMatchesWebsite` accepts a parent domain without public-suffix awareness**
- Where: `employer-access-requests.controller.ts:293-298` (`base.endsWith('.' + emailDomain)`).
- Why it matters: a requester whose website is a subdomain of a shared host and whose email is at the host's domain is shown to Operations as "email matches website". This is a false trust signal in the queue.
- Fix: compare registrable domains using a public-suffix list, or drop the parent branch.
- Proving test: a unit test on `emailMatchesWebsite` with a shared-host case.

**EMP-SR-12 — Low — The rate-limit digest is an unsalted SHA-256 of the address**
- Where: `employer-access-requests.controller.ts:114`; 0041 `:130`; design note (`employer-access-requests-table-design.md:149`, `:197`).
- Why it matters: the whole IPv4 space can be hashed in minutes, so the stored `client_key` is pseudonymous, not anonymous. The design's privacy claim is overstated for anyone with database access.
- Fix: use an HMAC with a server-held key that rotates at least as often as the 2-day pruning, and amend the design note.
- Proving test: a unit test that the key is not `sha256('employer-access-request:' + address)`.

**EMP-SR-13 — Low — The Operations "initial" invitation mints an owner in any state, on every call**
- Where: `operations-institution-onboarding.controller.ts:247-272`. The organisation read at `:253` fetches only `kind`, and `role` is always `EMPLOYER_OWNER` for employers (`:258`).
- Why it matters: EMP-01 recorded that the invitation does not check verification state. In addition, repeated calls create more owners even when active owners exist, which bypasses the employer's own team control. There is also no reason code. The action needs `OPS_ORG_MANAGE`, so the risk is operator error or misuse, not external attack.
- Fix: refuse for REJECTED and SUSPENDED employers. When an ACTIVE owner exists, refuse, or require a fixed reason code and mark the audit row.
- Proving test: API cases for a REJECTED employer and for an employer that already has an owner.

**EMP-SR-14 — Low — Students can still take a suspended or rejected employer's screening tests**
- Where: `employer-assessments.controller.ts:352-380` (list, which shows the employer's legal name), `:382-452` (start), `:454` (answer), `:488` (submit). None applies `employerInGoodStandingSql`. This is recorded as an EMP-03 limitation.
- Why it matters: a student can spend time on a test from an employer that operations has suspended, and the answers become readable if the employer is reinstated. This contradicts "students no longer see or reach them".
- Fix: add `employerInGoodStandingSql(sql\`v.employer_id\`)` to these four queries, and state plainly on the list that the employer is unavailable.
- Proving test: an API case in which, after suspension, the invitation is absent or marked unavailable and start returns 403.

**EMP-SR-15 — Low — Candidate writes and assessment publish have no lock and no in-statement state re-check**
- Where: the guard runs before the write, and nothing holds the organisation row: transition `employer-hiring.controller.ts:263`→`:289`, extend offer `:681`→`:702`, schedule interview `:513`→`:534`, assessment publish `employer-assessments.controller.ts:239`→`:251`.
- Why it matters: a suspension that commits between the guard and the write lets one candidate write through. For assessment publish, it makes a test live for a just-suspended employer, which the suspension transaction does not reverse because it pauses only opportunities (`operations-institution-onboarding.controller.ts:235-245`).
- Fix: fold the good-standing predicate with `FOR SHARE` into each write, as opportunity publish does (`employer-hiring.controller.ts:217-224`), and have suspension also close published assessments or their open invitations.
- Proving test: a concurrency test that holds the suspension transaction open and asserts the write is refused.

**EMP-SR-16 — Low — The employer-side interview outcome route skips the consent and closed checks**
- Where: `employer-hiring.controller.ts:616-646`. Compare the participant route, which locks and requires `consent_revoked_at IS NULL AND closed_at IS NULL` (`:419-433`).
- Why it matters: a recruiter can record or overwrite a scorecard about a candidate who has withdrawn consent or whose application is closed.
- Fix: apply the same locked predicate to this route.
- Proving test: an outcome write after withdrawal returns 403.

**EMP-SR-17 — Low — Screening results are returned ranked by score**
- Where: `employer-assessments.controller.ts:330` (`ORDER BY t.percentage DESC`).
- Why it matters: §5.4 says ONE never ranks candidates automatically, and a server-imposed score order is a ranking.
- Fix (EMP-12): order by invitation time and leave any sorting to an explicit employer action in the client.
- Proving test: a results-order test.

**EMP-SR-18 — Low — CSV neutralisation is input-side, partial, and missing from the EM1 fields**
- Where: `employer-hiring.controller.ts:37` and `:1066-1070` apply it to some hiring fields only. Summary, responsibilities and joining conditions use `readOptionalText` (`:913-925`). Company about text, team invitation emails and access-request names and company names accept a leading `=`, `+`, `-` or `@`.
- Why it matters: there is no export today, so nothing is exposed. EMP-17 must not rely on input refusal. Refusing at input also rejects legitimate text such as "- bullet" lists.
- Fix (EMP-17): neutralise at output for every export. Consider dropping the input-side refusal once output neutralisation exists.
- Proving test: EMP-17's CSV fixture test covering these fields.

**EMP-SR-19 — Low — The state-matrix test omits four guarded routes**
- Where: `employer-organisation-state.integration.spec.ts:199-231` lacks `POST /assessment-questions`, `POST /assessment-questions/:id/transition`, `POST /assessments` and `GET /applicant-access/...`. The code guards all four (`employer-assessments.controller.ts:101`, `:137`, `:201`; `employer-authentication.ts:34-38`).
- Why it matters: a later edit that drops the guard from one of these routes would go unnoticed.
- Fix: add them to `employerRoutes()`, with `applicant-access` expected to return 403 `FORBIDDEN` for non-verified employers.
- Proving test: the extended it.each.

## 6. Route inventory

Group is the §5.1 action group passed to the helper. "Roles" means O = owner, A = admin, R = recruiter; "+I" adds HIRING_MANAGER and INTERVIEWER, which the membership trigger cannot provision today (`employer-hiring.controller.ts:41-46`). "Matrix test" means the route is in `employerRoutes()` of the state spec.

| Method and path (`/api/v1`) | Guard / action group | Roles | Code | Matrix test |
|---|---|---|---|---|
| GET `/employers/:employerId/organisation-status` | requireActiveEmployer / organisation.status | O A R +I | `employer-hiring.controller.ts:109`, `:114` | separate test |
| POST `/employers/:employerId/opportunities` | requireActiveEmployer / jobs.draft | O A R | `:133`, `:136` | yes |
| GET `/employers/:employerId/opportunities` | requireActiveEmployer / jobs.draft | O A R +I | `:160`, `:163` | yes |
| POST `/employers/:employerId/opportunities/:opportunityId/audiences` | requireActiveEmployer / jobs.draft | O A R | `:178`, `:181` | yes |
| POST `/employers/:employerId/opportunities/:opportunityId/publish` | requireActiveEmployer / jobs.publish + locked re-check `:217-224` | O A R | `:197`, `:200` | yes |
| GET `/employers/:employerId/opportunities/:opportunityId/applications` | requireActiveEmployer / candidates | O A R +I | `:234`, `:237` | yes |
| POST `/employers/:employerId/applications/:applicationId/transition` | requireActiveEmployer / candidates | O A R | `:260`, `:263` | yes |
| GET `/employers/:employerId/candidate-feedback-reasons` | requireActiveEmployer / candidates | O A R | `:326`, `:329` | yes |
| POST `/employers/:employerId/applications/:applicationId/feedback` | requireActiveEmployer / candidates | O A R | `:340`, `:343` | yes |
| GET `/employers/:employerId/my-interviews` | requireActiveEmployer / candidates + assignment predicate | O A R +I | `:392`, `:395` | yes |
| GET `/employers/:employerId/my-interviews/:interviewId` | participant guard (membership + assertEmployerState / candidates + assignment) | any ACTIVE member | `:400`, `:403`; guard `:56-76` | yes |
| POST `/employers/:employerId/my-interviews/:interviewId/outcome` | participant guard + locked predicate `:422-433` | any ACTIVE member | `:409`, `:412` | yes |
| GET `/employers/:employerId/interview-participant-options` | requireActiveEmployer / candidates | O A R | `:453`, `:456` | yes |
| GET `/employers/:employerId/interviews` | requireActiveEmployer / candidates | O A R +I | `:484`, `:487` | yes |
| POST `/employers/:employerId/applications/:applicationId/interviews` | requireActiveEmployer / candidates | O A R | `:510`, `:513` | yes |
| POST `/employers/:employerId/interviews/:interviewId/state` | requireEmployerMembership → input → assertEmployerState / candidates | O A R | `:579`, `:584`, `:592` | yes |
| POST `/employers/:employerId/interviews/:interviewId/outcome` | requireActiveEmployer / candidates | O A R +I | `:616`, `:619` | yes |
| GET `/employers/:employerId/offers` | requireActiveEmployer / candidates | O A R | `:652`, `:655` | yes |
| POST `/employers/:employerId/applications/:applicationId/offers` | requireActiveEmployer / candidates | O A R | `:678`, `:681` | yes |
| POST `/employers/:employerId/offers/:offerId/withdraw` | requireActiveEmployer / candidates | O A R | `:715`, `:718` | yes |
| GET `/employers/:employerId/hiring-analytics` | requireActiveEmployer / candidates | O A R | `:742`, `:745` | yes |
| GET `/employers/:employerId/assessment-questions` | requireActiveEmployer / jobs.draft | O A R | `employer-assessments.controller.ts:75`, `:78` | yes |
| POST `/employers/:employerId/assessment-questions` | requireActiveEmployer / jobs.draft | O A R | `:98`, `:101` | **no** (EMP-SR-19) |
| POST `/employers/:employerId/assessment-questions/:questionId/transition` | requireActiveEmployer / jobs.draft | O A R | `:134`, `:137` | **no** |
| GET `/employers/:employerId/assessments` | requireActiveEmployer / jobs.draft | O A R | `:173`, `:176` | yes |
| POST `/employers/:employerId/assessments` | requireActiveEmployer / jobs.draft | O A R | `:198`, `:201` | **no** |
| POST `/employers/:employerId/assessments/:assessmentId/publish` | requireActiveEmployer / jobs.publish (no lock, EMP-SR-15) | O A R | `:236`, `:239` | yes |
| POST `/employers/:employerId/assessments/:assessmentId/invitations` | requireActiveEmployer / candidates | O A R | `:262`, `:265` | yes |
| GET `/employers/:employerId/assessments/:assessmentId/results` | requireActiveEmployer / candidates | O A R | `:311`, `:314` | yes |
| GET `/employers/:employerId/team` | requireEmployerMembership → input → assertEmployerState / organisation.manage | O A | `employer-team.controller.ts:98`, `:101`, `:105` | team spec |
| POST `/employers/:employerId/team-invitations` | same + locked re-check `:182` | O A (canAssignRole) | `:168`, `:171`, `:175` | team spec |
| POST `/employers/:employerId/team-invitations/:invitationId/revoke` | same (no organisation lock) | O A (canAssignRole on the invitation's role) | `:219`, `:222`, `:226` | team spec |
| POST `/employers/:employerId/team-invitations/:invitationId/resend` | same + locked re-check `:257` | O A (canAssignRole) | `:244`, `:247`, `:251` | team spec |
| POST `/employers/:employerId/team/:membershipId/end` | same + owner locks `:291-302` | O A (mayEndMembership) | `:279`, `:282`, `:286` | team spec |
| GET `/employers/:employerId/company-profile` | requireEmployerMembership + assertEmployerState / organisation.manage | O A R | `employer-company-profile.controller.ts:88`, `:91-92` | profile spec |
| POST `/employers/:employerId/company-profile` | same + locked re-check `:109-115` | O A | `:98`, `:101`, `:104` | profile spec |
| GET `/employers/:employerId/applicant-access/:opportunityId/:studentUserId` | selectedMembership check + grant SQL (membership, VERIFIED+active, live grant) | O A R | `phase1-security.controller.ts:45`; `api-security.ts:327-351`; `employer-authentication.ts:22-45` | **no** (persistence tests only) |
| POST `/employer-access-requests` | public; rate limits; no organisation reads | anonymous | `employer-access-requests.controller.ts:106-159` | profile spec |
| GET `/operations/employer-access-requests` | OPS_ORG_MANAGE | operations | `:165`, `:168` | profile spec |
| POST `/operations/employer-access-requests/:requestId/decision` | OPS_ORG_MANAGE | operations | `:209`, `:212` | profile spec |
| POST `/operations/organizations/:targetOrganizationId/initial-admin-invitations` | OPS_ORG_MANAGE (no state check, EMP-SR-13) | operations | `operations-institution-onboarding.controller.ts:247-272` | `api-security.integration.spec.ts › invites the first user of an employer as its owner and leaves existing admin invitations alone` |

Student-side reads that depend on employer state:

| Path | Good-standing check | Code |
|---|---|---|
| GET `/opportunities`, GET `/opportunities/:id`, POST `/students/me/applications` | `employerInGoodStandingSql` | `student-hiring.controller.ts:193`, `:224`, `:299` |
| GET `/me/calendar` (interviewer entries) | inline VERIFIED + active join | `calendar.controller.ts:191-192` |
| GET `/students/me/screening-assessments`, POST `.../start`, `/screening-attempts/:id/answers`, `.../submit` | **none** (EMP-SR-14) | `employer-assessments.controller.ts:352`, `:382`, `:454`, `:488` |

## 7. Cross-cutting checklist

| Control | Status | Reference |
|---|---|---|
| Authorisation (§5.1 helper on every employer route) | Met | §6 inventory; `employer-organisation-state.ts:68-105` |
| Scope / tenant | Met in the API. Not met in the web page (wrong employer chosen) | 4.1; EMP-SR-03 |
| Consent / grant | **Not met** for candidate reads and writes | EMP-SR-01, EMP-SR-02 |
| Audit in the same transaction | Met for EM1 routes. Not met for pre-existing hiring and assessment writes | 4.14; EMP-SR-08 |
| Reason codes from fixed lists | Met for team, access-request decisions and verification. Not met for application rejection | 4.14; EMP-SR-08 |
| Data minimisation | Partial. The company block omits the Operations contact email (`student-hiring.controller.ts:643-665`) and the access-request queue shows no raw address. Applicant rows expose the institution student id without a student-chosen snapshot (EMP-07) | 4.3; EMP-SR-01 |
| Suppression below 5 | Not applicable. No employer surface shows aggregates about students beyond the employer's own applicants, whom it already sees by name. `hiring-analytics` counts only this employer's applications (`employer-hiring.controller.ts:746-767`). This must be revisited for EMP-17 reports and any cross-employer benchmark | — |
| No numeric readiness; no readiness-driven rules | Met in code (no readiness field or rule on any employer path). No all-routes contract test | 4.4; EMP-SR-07 |
| Compensation | Only what the employer discloses on a job or offer. No rule ranks or filters by it | `employer-hiring.controller.ts:904-908`, `:687-692` |
| Error handling (safe codes, correlation id, no upstream text) | Met | 4.14 |
| Input validation / unknown fields rejected | Met for EM1 routes. Not met for pre-existing hiring bodies | 4.13; EMP-SR-08 |
| Keyset pagination (§5.9, 50/200) | Met for team and access-request queue. Not met for hiring lists (fixed LIMIT 200/500, no cursor) | `employer-team.controller.ts:482-493`; `employer-access-requests.controller.ts:351-374`; `employer-hiring.controller.ts:173`, `:255` |
| CSV safety | No CSV in or out today. Output neutralisation is still needed for EMP-17 | EMP-SR-18 |
| Rate limiting | Public access request limited (but abusable). Team invitations not limited | EMP-SR-05, EMP-SR-06 |

## 8. Open findings register

| ID | Severity | Title | Location | Target goal |
|---|---|---|---|---|
| EMP-SR-01 | High | Candidate data served without a live applicant-access grant | `apps/api/src/http/employer-hiring.controller.ts:243-256`, `:488-506`, `:656-674`, `:829-841`; `employer-assessments.controller.ts:316-331` | EMP-07 (fix before any new candidate surface) |
| EMP-SR-02 | Medium | Grant never expires; no revocation on account deletion | `apps/api/src/http/student-hiring.controller.ts:341-345` | EMP-07 |
| EMP-SR-03 | Medium | Web employer page acts on the first employer membership, not the chosen workspace | `apps/web/src/rolePortal/employer.tsx:41` (vs `rolePortalPages.tsx:347`) | EMP-02 follow-up |
| EMP-SR-04 | Medium | Pending invitations survive the removal of the person who sent them | `apps/api/src/http/employer-team.controller.ts:287-314`; `packages/persistence/src/identity-authentication.ts:117-126` | EMP-02 follow-up |
| EMP-SR-05 | Medium | No rate limits on team invite and resend | `apps/api/src/http/employer-team.controller.ts:168-217`, `:244-277` | EMP-02 follow-up (before HG-7 sink) |
| EMP-SR-06 | Medium | Access-request limits can block genuine requesters (domain keyed on input; full-IPv6 key; global cap) | `apps/api/src/http/employer-access-requests.controller.ts:62`, `:114`, `:120-131`, `:266-273` | EMP-04 follow-up |
| EMP-SR-07 | Medium | No all-routes contract test for readiness absence | `apps/api/src/http/employer-*.integration.spec.ts` (per-feature only) | EMP-18 (this slice) |
| EMP-SR-08 | Medium | Pre-existing hiring and assessment writes: audit not transactional, no organisation id, free-text rejection reason, no audit on assessment publish and invite, unknown fields ignored | `apps/api/src/http/employer-hiring.controller.ts:863-868`, `:266`, `:289-312`, `:897-928`; `employer-assessments.controller.ts:251-255`, `:292-307` | EMP-05, EMP-07, EMP-08, EMP-12 |
| EMP-SR-09 | Low | Careers URL: user-info allowed, `www.` strip widens match, not re-checked on website change | `apps/api/src/http/employer-company-profile.controller.ts:122-125`, `:232`, `:250-256` | EMP-04 follow-up |
| EMP-SR-10 | Low | About-text payment detector easily evaded; off-platform contact not signalled | `apps/api/src/http/employer-company-profile.controller.ts:219-224` | EMP-04 follow-up / EMP-16 |
| EMP-SR-11 | Low | `emailMatchesWebsite` parent-domain match without public-suffix awareness | `apps/api/src/http/employer-access-requests.controller.ts:293-298` | EMP-04 follow-up |
| EMP-SR-12 | Low | Rate-limit digest is an unsalted SHA-256 of the address | `apps/api/src/http/employer-access-requests.controller.ts:114` | EMP-04 follow-up |
| EMP-SR-13 | Low | Operations initial invitation mints an owner in any state and on every call | `apps/api/src/http/operations-institution-onboarding.controller.ts:247-272` | EMP-01 follow-up |
| EMP-SR-14 | Low | Students can still take a suspended or rejected employer's screening tests | `apps/api/src/http/employer-assessments.controller.ts:352-380`, `:382-452`, `:454`, `:488` | EMP-03 follow-up / EMP-12 |
| EMP-SR-15 | Low | Candidate writes and assessment publish not locked against a concurrent suspension | `apps/api/src/http/employer-hiring.controller.ts:263`, `:513`, `:681`; `employer-assessments.controller.ts:239-255` | EMP-05, EMP-07, EMP-12 |
| EMP-SR-16 | Low | Employer-side interview outcome skips the consent and closed checks | `apps/api/src/http/employer-hiring.controller.ts:616-646` | EMP-09 |
| EMP-SR-17 | Low | Screening results ranked by score | `apps/api/src/http/employer-assessments.controller.ts:330` | EMP-12 |
| EMP-SR-18 | Low | CSV neutralisation input-side and partial | `apps/api/src/http/employer-hiring.controller.ts:37`, `:1066-1070`, `:913-925` | EMP-17 |
| EMP-SR-19 | Low | State-matrix test omits four guarded routes | `apps/api/src/http/employer-organisation-state.integration.spec.ts:199-231` | EMP-18 (this slice) |

## 9. Known open items from the progress log

These were recorded in `docs/employer/EMPLOYER_PROGRESS.md` and confirmed against code. They are
limitations of what was built, not findings above.

- **HG-7, no production mail sender.** Team invitations and the first-owner invitation cannot reach anyone in production. Without a sink they are recorded NOT_CONFIGURED, and the screen and API say so (`employer-team.controller.ts:205`, `:384`). Access-request emails are never confirmed (`employer-access-requests.controller.ts:390-391`). EMP-SR-05 must be fixed before a sink is enabled.
- **Company logo** is not built. It needs the file store and malware scanner, so no column exists yet (0041 adds none).
- **Retention of declined and spam access requests** (proposed 180 days) is not in the privacy worker. The design note records the rule (`employer-access-requests-table-design.md:204-218`). Attempts rows are pruned after 2 days (`employer-access-requests.controller.ts:119`).
- **No notifier consumes `employer_access_request.submitted`.** The outbox event is written (`employer-access-requests.controller.ts:145-153`), but Operations learns of new requests only by opening the queue.
- **Help & FAQ employer content** was not updated in this slice (EMP-18 item 4 remains).
- Also recorded:
  - The Operations Organizations Edit prompt sends a partial profile and can null address fields. This is pre-existing and unchanged.
  - Ending a membership does not remove the person from interviews already scheduled. Access still stops at once, because the participant predicate requires an ACTIVE membership (`employer-hiring.controller.ts:85-88`).
  - Changing a role in place is not built.

## 10. Residual risks

None recorded in this slice. Programme rule B.2: a residual risk is recorded only after the fixes
for the open findings above have merged, and only for what those fixes knowingly leave in place.
