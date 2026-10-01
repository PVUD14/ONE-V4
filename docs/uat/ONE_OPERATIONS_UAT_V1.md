# ONE Operations Console — UAT scripts V1 (OPS-17 full)

> What this is: executable acceptance scripts for every Operations console journey in Appendix 1
> §9 (J1–J12), plus supplementary scripts so that every shipped operations module has at least
> one. Why it exists: OPS-17 requires every shipped module to have an SOP and a UAT script.
> Milestone exits are "J1–J7 pass" (M1), "J8–J12 pass" (M3, with a first access review completed
> and an incident drill run). The M1 slice was written 2026-09-26 against base `6864332`. This
> full version was written 2026-10-01 against base `719eb34`.
>
> A journey whose feature is not built, is built but switched off by a flag, or is blocked by a
> hard gate stays in this document with an honest status, so the numbering stays Appendix 1's.
> The result tables are empty: nothing here has been run yet.

## Rules for running these scripts

- **Synthetic data only.** Every person is a `@uat.example.test` account and every organisation
  is named `UAT …`. Never use a real person, a real college or production data.
- **Environment.** A local stack (`corepack pnpm api:dev`, `web:dev`, a freshly migrated
  database) or a staging environment, signed in through a **non-production** Cognito pool.
  Journeys that create, suspend or delete must not be run against production. The sanctioned
  `@uat.example.test` accounts on the live host are for read-only screen checks only.
- **Production** is `https://oneby8.com` on AWS (ADR-041); `one.ai8ht.pro` forwards to it. Only
  Divakar releases to it or changes it. No script here creates, changes or deletes anything on it.
- **Email.** The SMTP sender is built (ADR-042, migration 0094) but **not switched on in
  production**, and the sender mailbox is still to be set up.
  - Locally, enable the loopback Mailpit sink (`PTP_LOCAL_INVITATION_MAILPIT_ENABLED=true`) to
    receive invitation emails. Otherwise the screen correctly says "not sent".
  - Student invitations, announcements and status notices are sent by the **automation worker**,
    which is not deployed on AWS yet. Run it locally (the ADR-028 local publisher) for J12.
- **AI is held** (ADR-030). No model runs anywhere, every AI flag is off, and the in-app assistant
  is off by default. Nothing in these scripts switches a model on.
- **File uploads are off on AWS** until a virus scanner exists. Content bulk import (O-11) sends
  file *text* in the request and stores no file, so it is not affected.
- **Credentials** are never in Git. Keep them in the operator's local credentials file.
- Record each step as Pass / Fail with the time, and for a failure the on-screen reference.

## Personas

| Persona | Account | Membership |
|---|---|---|
| Super admin (approver) | `ops.super@uat.example.test` | PLATFORM_SUPER_ADMIN, ACTIVE |
| Operator | `operations.admin@uat.example.test` | OPERATIONS_ADMIN, ACTIVE |
| Security operator | `security.admin@uat.example.test` | SECURITY_ADMIN, ACTIVE |
| New staff member | `ops.newstaff@uat.example.test` | OPERATIONS_ADMIN, ACTIVE, no explicit grants |
| College administrator | `college.admin@uat.example.test` | invited during J1 |
| Student | `student.one@uat.example.test` | rostered in `UAT Engineering College` |
| Institution admin (control) | `institution.admin@uat.example.test` | INSTITUTION_ADMIN of another UAT college |

Personas added for the full OPS-17 scripts:

| Persona | Account | Membership and grants |
|---|---|---|
| Content author | `content.author@uat.example.test` | OPERATIONS_ADMIN, granted `CONTENT_EDIT` and `CATALOGUE_MANAGE` |
| Content reviewer | `content.reviewer@uat.example.test` | OPERATIONS_ADMIN, granted `CONTENT_REVIEW` |
| Content publisher | `content.publisher@uat.example.test` | OPERATIONS_ADMIN, granted `CONTENT_PUBLISH` (high-risk grant, via approval) |
| AI configurer | `ai.config@uat.example.test` | OPERATIONS_ADMIN, granted `AI_OPS_CONFIGURE` (high-risk grant, via approval) |
| Faculty reviewer | `faculty.reviewer@uat.example.test` | FACULTY_LECTURER of `UAT Engineering College` |
| Second faculty (control) | `faculty.other@uat.example.test` | FACULTY_LECTURER of `UAT Second College` |
| Employer admin | `employer.admin@uat.example.test` | EMPLOYER_OWNER of `UAT Logistics Pvt` |
| Growth executive | `growth.exec@uat.example.test` | invited during O-17 |

**Setup gap (engineering):** platform staff memberships cannot be created from any screen (see
[sop-staff-capabilities.md](../ops/sop-staff-capabilities.md) G1), and no UAT seed for them exists
in the repository. The platform personas are created once by engineering in the UAT environment.
Their grants are then made through Settings, as J7 does.

**Content needs two people.** An author is never the reviewer, and review has no solo path. J8, J9
and O-8 to O-12 therefore cannot pass with one person.

## Summary

| # | Journey (Appendix 1 §9) | Status on base `719eb34` | SOP |
|---|---|---|---|
| O-0 | Overview triage (supplementary) | Built | [sop-overview](../ops/sop-overview.md) |
| J1 | Onboard a new college | Built (email needs the local sink) | [sop-organizations](../ops/sop-organizations.md) |
| J2 | A TPO phones about a student who cannot sign in | Built | [sop-support](../ops/sop-support.md) |
| J3 | A background event fails overnight | Built (failure seeded; alert email not sent until the sender and the `ops-failure` workflow are on) | [sop-system-health](../ops/sop-system-health.md) |
| J4 | A student submits a data-deletion request | Built (statutory due date NA) | [sop-privacy](../ops/sop-privacy.md) |
| J5 | An employer is reported for misuse | **Partly built.** The case, response request, timeline and shared decision are built. Enforcement with approval is **not usable**: there is no screen, and an action has no effect and needs no approval (OPS-SR-28). Suspension goes through Organizations | [sop-trust-safety](../ops/sop-trust-safety.md) |
| J6 | Enable a feature for one pilot college only | **Not built.** There is no organisation-override API | [sop-feature-flags](../ops/sop-feature-flags.md) |
| J7 | Grant a new staff member the support capability | Built | [sop-staff-capabilities](../ops/sop-staff-capabilities.md), [sop-approvals](../ops/sop-approvals.md) |
| J8 | Publish a new version of a role's requirements | Built (OPS-08). Needs two people plus an approver | [sop-role-catalogue](../ops/sop-role-catalogue.md) |
| J9 | Faculty reviewer approves AI-drafted questions | Built (OPS-10). **AI held**, so the drafts are written by a person (or imported as drafts). The AI-drafting half is not available | [sop-external-reviewers](../ops/sop-external-reviewers.md) |
| J10 | Turn off all AI features in an incident | Built (OPS-12). Engaging needs no approval, by design; releasing needs one | [sop-ai-operations](../ops/sop-ai-operations.md), [runbook-ai-kill-switch](../ops/runbook-ai-kill-switch.md) |
| J11 | Quarterly access review | Built (OPS-15) | [sop-access-reviews](../ops/sop-access-reviews.md) |
| J12 | Personal-data breach drill | Built (OPS-16). Notices are delivered only with the local worker and mail sink. The 72-hour period is pending legal confirmation | [sop-incidents-and-status-notices](../ops/sop-incidents-and-status-notices.md), [runbook-breach-response](../ops/runbook-breach-response.md) |
| O-2 | Employer access request decided (supplementary) | Built | [sop-organizations](../ops/sop-organizations.md) |
| O-3 | Solo-operator safeguard (supplementary) | Built | [sop-approvals](../ops/sop-approvals.md) |
| O-4 | Legal hold placed and released (supplementary) | Built | [sop-privacy](../ops/sop-privacy.md) |
| O-6 | Ordinary and high-risk flag change (supplementary) | Built (ordinary change; the high-risk direction is in O-19 and J10) | [sop-feature-flags](../ops/sop-feature-flags.md) |
| O-7 | Staff-pool enforcement, local check (supplementary) | Local only | [sop-staff-access](../ops/sop-staff-access.md) |
| O-8 | Skill drafted, reviewed and published (supplementary) | Built (OPS-09a) | [sop-content-authoring](../ops/sop-content-authoring.md) |
| O-9 | Question published; answer key never reaches a learner (supplementary) | Built (OPS-09b) | [sop-content-authoring](../ops/sop-content-authoring.md) |
| O-10 | Telugu lesson variant with native-speaker review (supplementary) | Built (OPS-09c, ENG-16) | [sop-content-authoring](../ops/sop-content-authoring.md) |
| O-11 | Content bulk import as drafts (supplementary) | Built (OPS-09d) | [sop-content-bulk-import](../ops/sop-content-bulk-import.md) |
| O-12 | Archive live content (supplementary) | Built (OPS-GAPS) | [sop-content-authoring](../ops/sop-content-authoring.md) |
| O-13 | Role demand with suppression (supplementary) | Built (OPS-11) | [sop-analytics](../ops/sop-analytics.md) |
| O-14 | College health and account contacts (supplementary) | Built (OPS-14) | [sop-analytics](../ops/sop-analytics.md), [sop-college-accounts](../ops/sop-college-accounts.md) |
| O-15 | Learning-engine health panels (supplementary) | Built (OPS-13) | [sop-ai-operations](../ops/sop-ai-operations.md), [sop-system-health](../ops/sop-system-health.md) |
| O-16 | Audit log search (supplementary) | Built | [sop-audit-logs](../ops/sop-audit-logs.md) |
| O-17 | Growth team: invite, team, end (supplementary) | Built (GROWTH-01) | [sop-growth-team](../ops/sop-growth-team.md) |
| O-18 | Employer terms version published (supplementary) | Built (EMP-16). Legal text is a draft (HG-6) | [sop-organizations](../ops/sop-organizations.md) §E |
| O-19 | Employer evidence flag switched on with approval (supplementary) | Built (EMP-13/14), flag off by default. HG-4 approved. For the talent pool, HG-6 wording first | [sop-feature-flags](../ops/sop-feature-flags.md) |

College exits (data terms, exit export, end, cancel and the dual-controlled purge) are scripted in
[ONE_INSTITUTION_UAT_V1.md](ONE_INSTITUTION_UAT_V1.md) J12, following
[sop-college-exit](../institution/sop-college-exit.md).

---

## O-0 — Overview triage

**Passes when** one request renders the Overview, a tile the persona cannot access shows NA,
and every tile opens its screen.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | Sign in; open **Operations → Overview** | Overview loads; every tile heading is present; no invented numbers |
| 2 | Operator | Read the **Approvals** tile | Shows **NA** (OPERATIONS_ADMIN lacks `APPROVE_HIGH_RISK`) |
| 3 | Operator | Click each other tile in turn | Each opens its screen (Organizations, Verification, Users, Trust and Safety, System Health, Security, Support) |
| 4 | Security operator | Sign in; open Overview | Trust, Jobs, Privacy requests and Legal holds show counts; the other seven show NA |
| 5 | Super admin | Open Overview | Every tile shows a count |
| 6 | Operator | Read **Accounts** | A count under 5 shows **<5**, never a small number |
| 7 | Institution admin (control) | Open `/operations/admin` | Refused; no Operations data shown |

## J1 — Onboard a new college

**Passes when** it is done entirely in the console and every step is audited.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Organizations → Add Organization**: Type Institution, Legal Name `UAT Engineering College`, Country IN, city, submit | Row appears, state **PENDING** |
| 2 | Operator | **Begin review** | State **UNDER_REVIEW** |
| 3 | Operator | **Verify** | State **VERIFIED** |
| 4 | Operator | **Invite admin** → `college.admin@uat.example.test` | Success message; **Users → Invitation tracking** lists the invitation as pending |
| 5 | Operator | Check the invitation's delivery | Locally with Mailpit: delivered and visible in Mailpit. Without a sink: "not sent". Record this as "sender not switched on", not as a failure |
| 6 | College administrator | Open the link, sign in with the invited address | Lands in the Institution admin workspace |
| 7 | Operator | Refresh Organizations and Invitation tracking | *Initial Admin* shows the accepted administrator; invitation accepted |
| 8 | Operator | **Audit Logs**, action prefix `organization` and `identity.invitation`, from today | Rows for create, each verification transition and the invitation, each with actor and correlation ID |
| 9 | Operator | Attempt **Verify** on a PENDING organisation | Refused: "Verification transition was rejected by policy." |

**Suspension variant (dual control):**

| # | Actor | Action | Expected result |
|---|---|---|---|
| S1 | Operator | On the college's row **Suspend…**, reason `CONTRACT_ENDED`, file | "Request filed"; state still **VERIFIED** |
| S2 | Super admin | **Settings → Approvals**, Pending → **Approve…** `VERIFIED_NEED` | State Approved |
| S3 | Operator | **Settings → Approvals** → **Execute** | Organisation **SUSPENDED**; audit shows requester, approver and the approval |
| S4 | College administrator | Reload | Workspace refuses access / shows status |
| S5 | Operator | **Verify** (reinstate) | **VERIFIED**; no approval needed |

**Known gap:** Begin review / Verify / Reject record a fixed reason code, not one the operator
chooses (operations security review).

## J2 — A TPO phones about a student who cannot sign in

**Preconditions:** `student.one@uat.example.test` is rostered in UAT Engineering College and
has **not** activated.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Support → New case**: channel PHONE, category `ACCOUNT_ACCESS`, severity MEDIUM, summary "Student cannot sign in after invitation", save | Case OPEN with an SLA target 72 h ahead; no personal data in the summary |
| 2 | Operator | **Assign** to self, `TAKE_OWNERSHIP` | Assignee shown; history row added |
| 3 | Operator | **Users** → search `student.one` | One result; email masked `s***@uat.example.test`; phone **NA** |
| 4 | Operator | **View account** | State, relationship, student invitation (pending / not delivered) and recent activity shown |
| 5 | Operator | **Reveal contact…** with `IDENTITY_VERIFICATION` | Full email shown; audit `operations.support_account.contact_revealed` |
| 6 | Operator | **Add a note** (`CUSTOMER_CONTACT`): "Asked college to resend invitation" | Note in history |
| 7 | College administrator | **Students** → the student → **Resend invitation**, reason `NOT_RECEIVED` | Invitation re-sent (new link); audit row |
| 8 | Student | Accept the new link and sign in | Lands in the student workspace |
| 9 | Operator | **Move to RESOLVED** `FIXED`, then **CLOSED** `CONFIRMED_WITH_CUSTOMER` | Case CLOSED; timeline shows every step |
| 10 | Operator | **Audit Logs**, prefix `operations.support` | `…searched`, `…viewed`, `…contact_revealed`, case opened / assigned / state changes, each with reason |
| 11 | Operator | Try **Move to IN_PROGRESS** on the closed case | Not offered / refused `SUPPORT_CASE_TRANSITION_NOT_ALLOWED` |

## J3 — A background event fails overnight

**Precondition (engineering, local or staging only):** one synthetic outbox event in state
FAILED, seeded the way `packages/persistence/test/jobs-health.integration.test.ts` does, and the
alert checker run once (`corepack pnpm --filter @planthepath/persistence jobs:alert-check`,
threshold lowered for the run if needed). Producing a failure from the UI alone is not
possible — recorded as a UAT setup gap.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Overview** | Jobs tile shows ≥1 failed event and an open alert where the threshold was crossed |
| 2 | Operator | **System Health** | Alerts lists one row for the breach (not one per event); it says whether it was emailed (today: not emailed — sender not switched on) |
| 3 | Operator | **Failed events** → **Inspect** | Type, attempts, failure-class explanation, reference, receipts. **No payload, error text or recipients** |
| 4 | Operator | **Replay…** → `TRANSIENT_FAILURE_RESOLVED` → confirm | Event leaves the failed list once delivered; audit `outbox.event.replayed` with the reason |
| 5 | Operator | Run the alert checker again (engineering step), refresh | Failed count **0**; alert **cleared** |
| 6 | Security operator | Open System Health | Can see and replay (baseline `OPS_JOBS_REPLAY`) |
| 7 | Institution admin (control) | Call or open System Health | Refused |

## J4 — A student submits a data-deletion request

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | Open a support case for the student (J2 step 1) so a case exists | Case OPEN linked to the student |
| 2 | Student | Account privacy settings → request deletion | Request created; grace period date shown to the student |
| 3 | Operator | **Security → Privacy requests**, view Open | The request is listed with state and scheduled erasure date; statutory due date **NA** |
| 4 | Operator | **View** | Full state history; actor shown as "the person", never an id; audit `operations.privacy_request.viewed` |
| 5 | Operator | Overview | Privacy tile counts the open deletion |
| 6 | (engineering, UAT only) | Advance the schedule and run the privacy worker | Deletion completes |
| 7 | Operator | View the request again | State completed; per-category outcome listed, including `SUPPORT_CASES` anonymised |
| 8 | Operator | Open the support case from step 1 | Subject detached; summary replaced; notes redacted |

**Gap:** step 6 needs engineering in UAT because the grace period is 30 days.

## J5 — An employer is reported for misuse (partly built)

**Status:** steps 1–7 are built. Steps 8–10 are **not usable from the console** and are kept so the
journey reads as Appendix 1 does. Record them as "Not built", not as a failure.

**Precondition:** `UAT Logistics Pvt` is VERIFIED, with one published job. A student has reported a
conversation with it, or a detector signal exists for one of its jobs.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Trust and Safety** | The tiles show counts; the signal is listed under *Detector signals awaiting review* |
| 2 | Operator | **Open case** on the signal | A moderation case opens (CRITICAL for a payment-demand signal), with the signal as evidence |
| 3 | Operator | **Reported conversation** on the employer case | The thread is shown; Audit Logs shows `trust.case.message_evidence_viewed` |
| 4 | Operator | **Triage** | State TRIAGED |
| 5 | Operator | **Timeline** → *Summary of the concern…* (no reporter identity) → **Share and ask for response** | State AWAITING_RESPONSE; the employer can now see the case |
| 6 | Employer admin | **Settings → Trust cases** → respond | The case moves to UNDER_INVESTIGATION; the response appears on the operator timeline; the reporter is never named to the employer |
| 7 | Operator | *Decision summary* → **Share decision** (after the case is DECIDED; see step 8) | The employer sees the decision and can appeal once |
| 8 | Operator | Decide the case and record an enforcement action | **Not built in the console.** The API route exists, but the action changes nothing, needs no approval and is not audited (OPS-SR-28) |
| 9 | Operator | Suspend the employer instead: Organizations → **Suspend…** `POLICY_VIOLATION`, approved, executed (J1 variant S1–S3) | Organisation SUSPENDED; jobs paused; audit shows the approval |
| 10 | Employer admin | Appeal; operator decides the appeal | Appeal shown on the timeline; **deciding or reversing an appeal is not built** |

## J6 — Enable a feature for one pilot college only (not built)

**Status:** **Not built.** There is no API or screen for organisation overrides or caps. Only
`career-catalogue.selectable-roles` reads overrides, and only from the database. Nothing to run.
The journey passes when an override can be set with a reason, other colleges are unaffected, and
audit shows who and why.

## J7 — Grant a new staff member the support capability

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Super admin | **Settings** → find `ops.newstaff` | Row shows role OPERATIONS_ADMIN and its baseline |
| 2 | Security operator | Sign in; try **Support** | *Not permitted* (SECURITY_ADMIN lacks `SUPPORT_CASES`) |
| 3 | Super admin | On the security operator's row grant `SUPPORT_CASES`, reason `NEW_RESPONSIBILITY` | Grant listed; audit row with reason and correlation ID |
| 4 | Security operator | Reload **Support** | Case desk works |
| 5 | Security operator | Open **Settings**, **Organizations** | Settings: not permitted to grant; Organizations: refused (no `OPS_ORG_MANAGE`) — "Support and nothing else" beyond the baseline |
| 6 | Super admin | Grant `PRIVACY_HOLDS` (high-risk) to `ops.newstaff`, `TEMPORARY_COVER` | An approval request is filed instead of a grant |
| 7 | Super admin | Approve it | Refused `APPROVAL_SELF_DECISION_REFUSED` unless the solo safeguard applies (O-3) |
| 8 | Second approver (if seeded) or solo path after 15 min | Approve; requester **Execute** | Grant appears; audit shows requester, approver (or SOLO) and the grant |
| 9 | Super admin | Try to change own capabilities | Refused `CAPABILITY_SELF_CHANGE_REFUSED` |
| 10 | Super admin | **Revoke** `SUPPORT_CASES` from the security operator, `RESPONSIBILITY_ENDED` | Next request to Support is refused |

## J8 — Publish a new version of a role's requirements

**Passes when** a draft is reviewed by a different person, approved, and published, and the old
version is retained.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content author | **Content Management → Job-role catalogue**, search `C01`, **Open C01** | Role shown; *Students targeting it* shows a number from 5 up or **<5**; no student listed |
| 2 | Content author | **Start a new draft…** `REVISION`; add or change an item; **Save draft** | Draft saved |
| 3 | Content author | **Submit for review…** `READY_FOR_REVIEW` | IN_REVIEW; items frozen |
| 4 | Content author | Try to pass the review yourself (if you also hold `CONTENT_REVIEW`) | Not offered; the API refuses with `CAREER_SET_SELF_REVIEW_REFUSED` |
| 5 | Content reviewer | **Pass review…** `REVIEW_PASSED` | REVIEWED |
| 6 | Content publisher | Choose the label; **Request publish…** `REQUIREMENT_CORRECTION` | An approval request is filed; the set is not live |
| 7 | Content publisher | Try to execute before approval | `APPROVAL_REQUIRED` |
| 8 | Super admin | **Settings → Approvals → Approve…** `VERIFIED_NEED` | Approved (or SOLO after 15 minutes if the publisher is also the only approver) |
| 9 | Content publisher | **Execute** | Set PUBLISHED; the previous version is still listed |
| 10 | Operator | **Audit Logs**, prefix `operations.career` / `operations.approval` | Each step present, with reasons and the approval |

## J9 — Faculty reviewer approves drafted questions

**AI hold:** the drafts are written by the content author (or imported, O-11), not by a model.
Use the assignment reason `AGENT_DRAFT_CHECK` only once ONE AI Orchestration drafts exist.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content author | Draft two questions and **Submit for review…** | Both IN_REVIEW |
| 2 | Super admin | **Content Management → Faculty review**, **Find** `faculty.reviewer@uat.example.test`, **Grant faculty review…** `FACULTY_REVIEWER_AGREED` | Reviewer listed; audit `operations.external_reviewer.granted` |
| 3 | Content author | Try to assign the drafts | Refused `EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED` |
| 4 | Content reviewer | Tick both drafts, reviewer, 14 days, **Assign 2…** `SUBJECT_EXPERT_REVIEW` | Two OPEN assignments |
| 5 | Faculty reviewer | **Learning Resources → Drafts assigned to you** | Exactly the two drafts; prompt, options, difficulty and skill; **no answer key, no hints, no student** |
| 6 | Second faculty (control) | Open the same page; try the first faculty's assignment id in the URL | Nothing assigned; 403 or 404 |
| 7 | Faculty reviewer | **Review…** → Approve `REVIEW_PASSED`; second → Request changes `UNCLEAR_WORDING` with a comment | Decisions recorded; the revisions stay IN_REVIEW |
| 8 | Faculty reviewer | Try any Operations screen or a publish call | Refused |
| 9 | Content reviewer | Read the decisions in **Assignments and faculty decisions**; approve the first question with rights review | APPROVED |
| 10 | Content publisher | **Request publish…**, approved, **Execute** | Published by an internal publisher |
| 11 | Super admin | **Revoke…** the faculty grant `REVIEW_PROGRAMME_ENDED` | Remaining open assignments close; the faculty queue is empty |

## J10 — Turn off all AI features in an incident

**Today no AI feature is registered (AI hold), so step 2 shows the empty state.** On a UAT database,
engineering may register a synthetic feature policy for the run (never enabled against a provider).

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **AI Operations** | Kill switch *not engaged*; assistant off; features table (empty or the UAT feature); cost NA |
| 2 | Operator | **Engage kill switch…** `INCIDENT_MITIGATION` → **Engage kill switch** | Engaged at once, no approval; every enabled feature and the assistant switched off; one audit row per change |
| 3 | Operator | Reload | All features show disabled; **Switch on…** is not offered |
| 4 | Operator | **Release kill switch…** `INCIDENT_MITIGATION` | An approval request is filed; still engaged |
| 5 | Super admin | Approve; operator **Execute** | Released; **no feature comes back on** |
| 6 | AI configurer | **Switch on…** a feature with no passing evaluation | Not offered / `AI_EVALUATION_REQUIRED` |
| 7 | Institution admin (control) | Call `/api/v1/operations/ai/summary` | 403 |
| 8 | Operator | **Audit Logs**, prefix `operations.ai` | Engage, each switch-off and the release, with reasons |

Do **not** engage the kill switch from Feature Flags in this script. That path sets only the flag
(OPS-SR-31). It belongs in a separate negative test, once the fix lands.

## J11 — Quarterly access review

**Passes when** a review is opened, every item is decided, revocations take effect, and the CSV is
exported. Run it with two reviewers (security operator and super admin), then once with one.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Security operator | **Security → Access reviews** | Status tile shows *Never reviewed* (or the real state) |
| 2 | Security operator | **Open access review…** `QUARTERLY_REVIEW` | One open review; items for every ACTIVE platform role, live grant and faculty grant; period label = UTC quarter of today |
| 3 | Security operator | Open again | `ACCESS_REVIEW_ALREADY_OPEN` |
| 4 | Security operator | **Keep…** an item of your own | Refused `ACCESS_REVIEW_OWN_ACCESS` |
| 5 | Security operator | **Keep…** others' items `STILL_REQUIRED`; **Revoke…** the content author's `CONTENT_EDIT` grant `NO_LONGER_REQUIRED` | Decided; the content author's next Content Management request is refused |
| 6 | Super admin | Decide the security operator's items | Decided (DUAL) |
| 7 | Security operator | **Close review…** `REVIEW_COMPLETE` | Closed; Close was disabled until every item was decided |
| 8 | Security operator | **Export CSV…** `AUDIT_EVIDENCE` → **Download CSV** | One row per item; staff and faculty emails, no student data; Audit Logs shows `operations.access_review.exported` with the file's SHA-256 |
| 9 | (solo variant) | With one reviewer only: keep your own item before 15 minutes, then after | `ACCESS_REVIEW_SOLO_COOLING_OFF`, then accepted and marked **SOLO** |
| 10 | Operations admin without the grant | Open Access reviews | Not permitted |

## J12 — Personal-data breach drill

**Run locally or on staging** with the local automation worker and the Mailpit sink, so that notices
are delivered. Set up a published template first (step 1). The 72-hour period is the plan's,
pending legal confirmation.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator + super admin | **Settings → Status communications**: draft a template (`NEW_TEMPLATE`), **Ask for approval…**, approve, **Publish…** | Template PUBLISHED; approver recorded |
| 2 | Security operator | **Security → Incident register → Declare incident**, category `PERSONAL_DATA_BREACH`, *Detected at* 2 hours ago, `SUSPECTED_BREACH`; title without contact details | Incident OPEN; **Board reporting clock** shows *Clock running* with about 70 hours left |
| 3 | Security operator | Put an email address in the summary of a second attempt | Refused `INCIDENT_TEXT_PERSONAL_DATA` |
| 4 | Security operator | **Add an affected organisation…** `UAT Engineering College` (`SCOPE_ASSESSED`) | Listed; count 1 |
| 5 | Operator | **Draft a notice** for the incident from the published template, `INITIAL_NOTICE` | DRAFT; no free-text field offered |
| 6 | Operator | **Approve for sending…** your own notice | Refused `STATUS_NOTICE_SELF_APPROVAL_REFUSED` (or `…SOLO_COOLING_OFF` if you are the only holder) |
| 7 | Second `COMMS_TEMPLATES` holder (or solo after 15 min) | **Approve for sending…** `APPROVED_FOR_SEND` | Sent through the worker to the college's owners and admins only; no student receives it; the incident shows who approved, when sent, admins reached, email outcomes |
| 8 | Operator | Draft and approve a second notice within 15 minutes | 429 `STATUS_NOTICE_RATE_LIMITED` |
| 9 | Security operator | **Move to Closed…** | Refused `INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING` |
| 10 | Security operator | **Record Board report…** and **Record affected people told…** (times after Detected at) | Clock shows *Board notified in time*; who recorded each and when |
| 11 | Security operator | **Move to Contained…**, **Resolved…**, **Closed…** `POST_INCIDENT_REVIEW_DONE` | Closed; the timeline lists every step with actor, time and reason |
| 12 | Institution admin (control) | Call `/api/v1/operations/incidents` | 403 |

## O-2 — Employer access request decided

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Anonymous | Sign-in page → **Request employer access**; submit `UAT Logistics Pvt` with a work email on a UAT domain | "Received" message; the same message for a repeat submission |
| 2 | Anonymous | Submit with a public webmail address | Refused (flag `employer-access.allow-free-mail` is off) |
| 3 | Operator | **Organizations → Employer access requests** | Request **PENDING**, email marked unconfirmed, review signals shown |
| 4 | Operator | Create `UAT Logistics Pvt` (J1 steps 1–3 with Type Employer), then **Mark onboarded** `ORGANISATION_CREATED` linked to it | Request ONBOARDED; organisation's verification state unchanged |
| 5 | Operator | **Spam** another request, `FAKE_DETAILS` | Request SPAM; audited |
| 6 | Operator | Confirm nothing was created by the submission itself | No user, membership or invitation exists for the requester |

## O-3 — Solo-operator safeguard

**Precondition:** exactly one ACTIVE holder of `APPROVE_HIGH_RISK` (the super admin).

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Super admin | File any high-risk request (e.g. O-4 release) | Pending |
| 2 | Super admin | Approve immediately | Refused `APPROVAL_SOLO_COOLING_OFF` |
| 3 | Super admin | After 15 minutes, approve | Approved, marked **SOLO**; SOLO notice shown as not delivered (sender and `security-notification` workflow not on) |
| 4 | Super admin | Execute | Action runs; audit mode SOLO |
| 5 | (setup) | Grant a second person `APPROVE_HIGH_RISK` | Self-approval is refused from then on |
| 6 | Super admin | Execute an approval more than 24 h old (UAT clock) | Refused `APPROVAL_EXPIRED` |

## O-4 — Legal hold placed and released

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | From a request's detail **Place a legal hold…** `DISPUTE` | Hold listed with the subject masked |
| 2 | Operator | **Request release…** `CASE_CLOSED` | Hold shows "awaiting approval"; release button not offered again |
| 3 | Super admin | Approve; operator **Execute** | Hold released; audit shows the approval |

## O-6 — Feature flag change

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Feature Flags**, reason `PILOT_ROLLOUT`, **Enable** a non-high-risk flag | State ENABLED; audit with reason |
| 2 | Operator | Clear the reason field | Buttons disabled until a valid code is typed |
| 3 | Operator | **Disable** it again, `ROLLBACK` | State OFF |
| 4 | Operator | **Audit Logs**, prefix `operations.feature_flag` | **Known gap:** no row. Ordinary flag changes are not in the audit log (OPS-SR-33). Record "no row" |

The high-risk direction is covered by O-19 (an employer evidence flag) and J10 (the kill-switch release).

## O-8 — Skill drafted, reviewed and published

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content author | **Skill map → New skill…** `NEW_SKILL`; four levels, licence `AI8HT-Owned`; **Save draft**; **Submit for review…** | IN_REVIEW |
| 2 | Content author | Try to approve it | `SKILL_SELF_REVIEW_REFUSED` |
| 3 | Content reviewer | **Approve, with rights review…** `REVIEW_PASSED` + `OWNERSHIP_VERIFIED` | APPROVED |
| 4 | Content publisher | **Request publish…** `NEW_SKILL` (first publish needs approval); super admin approves; **Execute** | Skill live; audit `operations.content.skill_published` |
| 5 | Content author | Add a prerequisite that creates a cycle, then save | Refused with the cycle problem code |

## O-9 — Question published; the answer key never reaches a learner

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content author | **Question bank → New question…** on the O-8 skill: options a–d, key, difficulty, misconceptions, four hints; submit | IN_REVIEW |
| 2 | Content publisher (no EDIT/REVIEW) | Open the question | Shown **without** the answer key and explanation |
| 3 | Content reviewer | Approve with rights review; publisher **Request publish…**, approved, **Execute** | Published |
| 4 | Student | Start the readiness check that draws this skill | The question appears without any key; the network response holds no `correctOptionId` |
| 5 | Operator | **Settings → Approvals** list | The approval summary carries no answer key |

## O-10 — Telugu lesson variant with native-speaker review

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content author | On a live English lesson, **New variant…** `NEW_LANGUAGE`, language Telugu; fill; submit | Draft carries **Needs native-speaker review** |
| 2 | Content reviewer | **Approve, with rights review…** without a native-speaker code | Refused `LESSON_LANGUAGE_REVIEW_MISSING` |
| 3 | Content reviewer | Approve with `NATIVE_SPEAKER_REVIEWED` | APPROVED |
| 4 | Content reviewer | Try to publish it | Refused `LESSON_APPROVER_PUBLISH_REFUSED` |
| 5 | Content publisher | **Publish…** (variants need no approval) | Published; a student who chose Telugu sees it in Telugu, other lessons in English with a notice |

## O-11 — Content bulk import as drafts

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content author | **Bulk import**, kind questions, CSV with one bad row; **Preview** | Validation report lists the bad row by code; no row text shown |
| 2 | Content author | Try to commit | Not offered / `IMPORT_HAS_INVALID_ROWS`; nothing written |
| 3 | Content author | Fix the file; **Preview**; **Import N as drafts…** `TRACK_BUILD` | All rows DRAFT, authored by you; audit `operations.content.import_committed` |
| 4 | Content author | Change the file after preview and commit | `IMPORT_STALE`; nothing written |
| 5 | Content author | Try to review one of the imported drafts | Refused (contributor) |
| 6 | Content reviewer | Open **Bulk import** | Not permitted (needs `CONTENT_EDIT`) |

## O-12 — Archive live content

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Content publisher | **Archive…** the O-8 skill while the O-9 question is live | Refused `SKILL_ARCHIVE_BLOCKED` with `SKILL_HAS_LIVE_QUESTIONS` |
| 2 | Content publisher | **Archive…** the O-9 question `CONTENT_INACCURATE` | Archived at once, no approval; it is no longer drawn into new readiness checks |
| 3 | Content author | **Start a new revision…** of the archived question | Refused: archived is final |

## O-13 — Role demand with suppression

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Analytics** | Tiles as in the SOP; **Employer demand** NA |
| 2 | Operator | Find a role with 1–4 students | "Fewer than 5 students"; no rank; no **Colleges…** breakdown |
| 3 | Operator | **Colleges…** on a large role | Cells under 5 show **<5**; a cell that would reveal one shows **Withheld** |
| 4 | Security operator (no grant) | Open Analytics | Not permitted |
| 5 | Operator | **Known issue check:** compare the *Demand by release label* total with the shown roles of that label | Record whether the difference reveals a suppressed role (OPS-SR-27); expected today: it can |

## O-14 — College health and account contacts

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Analytics → College health**, sort by renewal | Colleges listed; figures under 5 show <5; readiness as bands only |
| 2 | Operator | **Details…** on UAT Engineering College | Four-week trend, assessments, bands; band movement NA |
| 3 | Operator | **Organization Detail → College account**, pick the college, **Edit account fields…** renewal date, contract reference `UAT/2026/001`, `NEW_CONTRACT` | Saved; audit with before and after |
| 4 | Operator | Try contract reference `Rs 5,00,000` | Refused `CONTRACT_REFERENCE_INVALID` |
| 5 | Operator | **Add contact…** `PLACEMENT_OFFICER` with a UAT email | Shown masked |
| 6 | Operator | **Reveal…** `RENEWAL_OUTREACH` | Full email shown; audit row without the value |
| 7 | Operator | **Remove…** `PRIVACY_REQUEST` | Contact erased (name, email, phone gone) |

## O-15 — Learning-engine health panels

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **AI Operations → Learning engine**, window 14 days | Planner decisions per day (days under 5 students withheld), override rate or NA, shadow panel withheld under 5 consenting students; each panel names its source table |
| 2 | Operator | **System Health → Item calibration job** and **Code sandbox** | Last run and status (or no run); sandbox NA |
| 3 | Institution admin (control) | Call `/api/v1/operations/ai/engine-health` | 403 |

## O-16 — Audit log search

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Audit Logs**, Correlation ID from an error reference seen in another script | The rows of that request |
| 2 | Operator | Action prefix `operations.support`, From = today, To = tomorrow | Today's support rows (setting To = today would exclude today — OPS-SR-36) |
| 3 | Operator | **Next** / **Previous** | Stable pages, no repeats |
| 4 | Institution admin (control) | Open Audit Logs | Refused |

## O-17 — Growth team

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Super admin | **Settings → Growth team**, invite `growth.exec@uat.example.test`, Growth executive, staff type left empty | Refused `GROWTH_STAFF_TYPE_REQUIRED` |
| 2 | Super admin | Invite with Employee | Invitation pending (delivery "not sent" without a sink) |
| 3 | Growth executive | Accept and sign in | Lands in the Growth portal, not Operations |
| 4 | Growth executive | Open `/operations/admin` and call `/api/v1/operations/overview` | Refused (403) |
| 5 | Super admin | **Save team** College partnerships `NEW_MEMBER`; **Save staff type** Contractor `ENGAGEMENT_CHANGED` | Both recorded; old type ended; both audited |
| 6 | Super admin | **End membership** `LEFT_AI8HT` | Ended; team rows ended |
| 7 | Operator without `GROWTH_ADMIN` | Open Settings | No Growth team section |

## O-18 — Employer terms version published

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Organizations → Employer terms → Manage employer terms**, version `2026-10-uat`, the draft text, `DRAFT_FOR_LEGAL_REVIEW`, requires re-acceptance → **Publish version** | Version listed, labelled "Draft — pending legal review" |
| 2 | Employer admin (non-owner) | Try to accept | Refused (owners only) |
| 3 | Employer owner | Publish a draft job | Refused `EMPLOYER_TERMS_NOT_ACCEPTED` until the owner accepts |
| 4 | Operator | Publish the same version again | `EMPLOYER_TERMS_VERSION_EXISTS` |
| 5 | Security operator | Open the section | Refused (needs `OPS_ORG_MANAGE`) |

## O-19 — Employer evidence flag switched on with approval

**Run on a non-production environment only.** In production this is Divakar's decision. For
`employer.talent-pool`, the approved HG-6 consent wording must be published first.

| # | Actor | Action | Expected result |
|---|---|---|---|
| 1 | Operator | **Feature Flags**, `employer.skill-evidence` row | Badge *High-risk to enable*; button **Enable…** |
| 2 | Operator | **Enable…** `PILOT_ROLLOUT` → **Request approval** | Request filed; flag still off |
| 3 | Super admin | Approve; operator **Execute** within 24 h | Flag on; approval in audit |
| 4 | Operator | **Disable** (ordinary) | Off at once, no approval |

## O-7 — Staff-pool enforcement (local only)

Follow [runbook-staff-pool.md](../ops/runbook-staff-pool.md) Part C's local enforcement check.
**Never on production.** Passes when a student-pool token is refused on
`/operations/audit-events` with a body that names no pool or role, and the same person with a
staff-pool token succeeds. Blocked for real use until the staff sign-in entry exists.

## Results

| Script | Date | Environment | Result | Notes / references |
|---|---|---|---|---|
| O-0 | | | | |
| J1 | | | | |
| J2 | | | | |
| J3 | | | | |
| J4 | | | | |
| J5 | | | | Partly built; steps 8 and 10 not built |
| J6 | | | | Not built |
| J7 | | | | |
| J8 | | | | |
| J9 | | | | |
| J10 | | | | |
| J11 | | | | |
| J12 | | | | |
| O-2 | | | | |
| O-3 | | | | |
| O-4 | | | | |
| O-6 | | | | |
| O-7 | | | | |
| O-8 | | | | |
| O-9 | | | | |
| O-10 | | | | |
| O-11 | | | | |
| O-12 | | | | |
| O-13 | | | | |
| O-14 | | | | |
| O-15 | | | | |
| O-16 | | | | |
| O-17 | | | | |
| O-18 | | | | |
| O-19 | | | | |
