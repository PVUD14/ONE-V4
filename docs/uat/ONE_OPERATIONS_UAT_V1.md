# ONE Operations Console — UAT scripts V1 (M1 slice)

> What this is: executable acceptance scripts for the Operations console journeys in
> Appendix 1 §9, written for what Wave 1 actually built (OPS-01 to OPS-07, plus the EMP-04
> access-request queue). Why it exists: OPS-17 requires every shipped module to have at least
> one UAT script, and milestone M1's exit criterion is "operator UAT journeys J1–J7 pass".
> Journeys whose features are not built are marked **Not in this slice** and are kept so the
> numbering stays Appendix 1's. Written 2026-09-26 against base `6864332`.

## Rules for running these scripts

- **Synthetic data only.** Every person is a `@uat.example.test` account and every organisation
  is named `UAT …`. Never use a real person, a real college or production data.
- **Environment.** A local stack (`corepack pnpm api:dev`, `web:dev`, a freshly migrated
  database) or a staging environment, signed in through a **non-production** Cognito pool.
  Journeys that create, suspend or delete must not be run against production. The sanctioned
  `@uat.example.test` accounts on the live host are for read-only screen checks only.
- **Email.** Production has no sender (HG-7). Locally, enable the loopback Mailpit sink
  (`PTP_LOCAL_INVITATION_MAILPIT_ENABLED=true`) to receive invitation emails; otherwise the
  screen correctly says "not sent".
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

**Setup gap (engineering):** platform staff memberships cannot be created from any screen
(see [sop-staff-capabilities.md](../ops/sop-staff-capabilities.md) G1). The four platform
personas are created once by a seed run by engineering in the UAT environment.

## Summary

| # | Journey (Appendix 1 §9) | Status in this slice | SOP |
|---|---|---|---|
| O-0 | Overview triage (supplementary) | In slice | [sop-overview](../ops/sop-overview.md) |
| J1 | Onboard a new college | In slice (email needs the local sink) | [sop-organizations](../ops/sop-organizations.md) |
| J2 | A TPO phones about a student who cannot sign in | In slice | [sop-support](../ops/sop-support.md) |
| J3 | A background event fails overnight | In slice (failure seeded; alert email HG-7) | [sop-system-health](../ops/sop-system-health.md) |
| J4 | A student submits a data-deletion request | In slice (statutory due date NA) | [sop-privacy](../ops/sop-privacy.md) |
| J5 | An employer is reported for misuse | **Not in this slice** — Trust and Safety evidence and enforcement are a later OPS goal; only suspension (J1 variant) exists | — |
| J6 | Enable a feature for one pilot college only | **Not in this slice** — no organisation-override API | [sop-feature-flags](../ops/sop-feature-flags.md) |
| J7 | Grant a new staff member the support capability | In slice | [sop-staff-capabilities](../ops/sop-staff-capabilities.md), [sop-approvals](../ops/sop-approvals.md) |
| J8 | Publish a new version of a role's requirements | **Not in this slice** (OPS-08) | — |
| J9 | Faculty reviewer approves AI-drafted questions | **Not in this slice** (OPS-10; AI hold) | — |
| J10 | Turn off all AI features in an incident | **Not in this slice** (OPS-12) | — |
| J11 | Quarterly access review | Built (OPS-15) | [sop-access-reviews](../ops/sop-access-reviews.md) |
| J12 | Personal-data breach drill | **Not in this slice** (OPS-16); the runbook exists | [runbook-breach-response](../ops/runbook-breach-response.md) |
| O-2 | Employer access request decided (supplementary) | In slice | [sop-organizations](../ops/sop-organizations.md) |
| O-3 | Solo-operator safeguard (supplementary) | In slice | [sop-approvals](../ops/sop-approvals.md) |
| O-4 | Legal hold placed and released (supplementary) | In slice | [sop-privacy](../ops/sop-privacy.md) |
| O-6 | Ordinary and high-risk flag change (supplementary) | Partly (no flag is marked high-risk) | [sop-feature-flags](../ops/sop-feature-flags.md) |
| O-7 | Staff-pool enforcement, local check (supplementary) | In slice, local only | [sop-staff-access](../ops/sop-staff-access.md) |

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
| 5 | Operator | Check the invitation's delivery | Locally with Mailpit: delivered and visible in Mailpit. Without a sink: "not sent" — record as HG-7, not a failure |
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
| 2 | Operator | **System Health** | Alerts lists one row for the breach (not one per event); it says whether it was emailed (today: not emailed, HG-7) |
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
| 3 | Super admin | After 15 minutes, approve | Approved, marked **SOLO**; SOLO notice shown as not delivered (HG-7) |
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

High-risk direction not testable until a flag is marked by migration.

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
| J7 | | | | |
| O-2 | | | | |
| O-3 | | | | |
| O-4 | | | | |
| O-6 | | | | |
| O-7 | | | | |
