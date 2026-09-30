# Growth Portal — Design and Goal Breakdown

> What this is: the design for ONE's Growth (marketing and partnerships) portal, approved by Divakar
> on 2026-09-30 outside the 88-step program plan, and the goal list (GROWTH-01 to GROWTH-16) that
> builds it. Why it exists: the portal adds a role family, territories, a record of personal data
> about people who are not ONE users, and a commission ledger that moves money, and every one of those
> must be designed before a migration is written. The decision and the rejected options are in
> `ADR-040-growth-portal.md`.

**Status:** Design, no code. Adopted structure. The values Divakar has not decided are marked
**[Divakar]** and listed in §17 with a recommendation each.
**Date:** 2026-09-30
**Base read:** `onev4/feat/plan-phases-0-to-2` at `c4c2ae1`, plus `onev4/feat/inst-contract-lifecycle`
(INST-18, `3f66bdf`, in validation)
**Migrations:** none in this goal. Each GROWTH goal marked "Migration: yes" gets its number from the
coordinator. `0071`+ are in use up to `0090` across open branches.
**Rule:** Goals that create a table carrying consequences (attribution, rates, payments, the ledger)
write their own `<name>-table-design.md` first, per the migrations rule, and treat this document as
the parent design. Where a table design here and a later table design disagree, the later one must
say why.

---

## 1. Scope

**In scope.** Two field teams working Indian territories: **college partnerships** (meet college
management, get the agreement signed, hand the college to operations so students can be onboarded)
and **employer partnerships** (meet companies so they register, get verified and post jobs). Their
leads, visits and follow-ups, on web and on the Android app. Who is credited for which college or
employer. Targets. A commission ledger paid per active student and per verified employer, valued only
by rates operations set, payable only after the conditions Divakar set. A record of college payments
received.

**Out of scope.** Billing, invoicing, pricing, plans and entitlements (ADR-022 stands). Moving money:
ONE records payments and payouts, it never makes or takes them. Tax computation (TDS or GST) on
commission. Marketing campaigns, email sequences and ads. Any model-based feature (ADR-030 hold).
Public self-signup for colleges (§17, open decision O-15).

**Principles, from AGENTS.md and the standing rules.**

- Never invent data. A figure with no source shows **NA** (or 0 where zero is the true answer) in the
  same slot. A commission with no rate shows **"Rate not set"**. No sample leads, no demo commission.
- Growth staff never see student personal data. Counts of people go through
  `packages/authorization/src/aggregate-suppression.ts` (`suppressSmallCount`, below 5 → `<5`).
- Every write is one transaction with its `audit_events` row and, where something downstream may care,
  an outbox event registered in `packages/events/src/index.ts`.
- The database clock decides time (`now()` in SQL), never Node (AGENT_BRIEF: the DB clock runs ahead).
- The Android app carries every field-facing feature (Android parity rule). Desk-only operator and
  finance screens are web-only, stated per goal.
- The pilot design system and the AI8HT wordmark apply to every Growth screen on both clients.

---

## 2. Decisions recorded (Divakar, 2026-09-30, verbatim)

| # | Decision |
|---|---|
| D1 | Option B: a "Growth" (marketing/partnerships) portal inside ONE — its own role family, login area and navigation. HG-3 (new navigation items) is APPROVED for this portal. |
| D2 | Two teams: (1) college partnerships — connect with college management and get the agreement signed so students can be onboarded; (2) employer partnerships — meet companies so they register and post job openings. |
| D3 | Teams work BY REGION / geo-locations in India (territories). |
| D4 | Track BOTH targets and commissions. |
| D5 | Field work is done on PHONES → the Android app must support field staff (Android parity rule). |
| D6 | Commission basis: per ACTIVE STUDENT (from colleges the person brought in) and per EMPLOYER VERIFIED (employers the person brought in). |
| D7 | Rates: NOT decided yet — operations must be able to set and change rates at any time; EVERY change must be recorded and logged (who, when, old→new, reason). Until a rate is set, commission shows "rate not set" (NA) — never an invented number. |
| D8 | Commission becomes payable only when (a) the student has been ACTIVE for 30 days, and (b) the college's payment (cheque) to AI8HT has CLEARED — recorded by operations/finance in ONE. |

---

## 3. Roles and capabilities

### 3.1 Who is who

| Person | How ONE represents them | Portal |
|---|---|---|
| **Growth executive** — field staff on a phone | `GROWTH_EXECUTIVE` membership of the platform organisation, plus a `growth_team_members` row naming the team(s) | Growth (web and Android) |
| **Regional manager** — runs a team in one or more regions; a national head is a manager whose regions cover India | `GROWTH_MANAGER` membership, plus team row(s) and region assignments | Growth (web and Android) |
| **Growth admin** — sets up regions, assigns territories and teams, sets targets, decides attribution disputes | An operator (`OPERATIONS_ADMIN`) holding the new internal capability `GROWTH_ADMIN` | Operations (sections of existing screens) |
| **Growth finance** — records college payments, proposes rate changes, prepares and marks payouts | An operator holding the new internal capability `GROWTH_FINANCE` | Operations (sections of existing screens) |
| **Approver** — the second person on money moves | An operator holding `APPROVE_HIGH_RISK` (OPS-02), never the requester | Operations → Settings → Approvals |

Why two login roles and two capabilities, and not one or the other, is ADR-040's subject. In short:
field staff must start from *no* authority (a growth role holds no internal capability, and
`isInternalCapabilityGrantableToRole` refuses to give it one), while the operator side is ordinary
operations work that ADR-032's capability model already expresses.

### 3.2 The roles in the schema

- The membership scope trigger function (`enforce_organization_membership_scope`, defined only in 0001)
  gains `GROWTH_EXECUTIVE` and `GROWTH_MANAGER` in the **platform branch**: organisation kind
  `PLATFORM`, no institution, unit or employer scope. The new migration redefines the function with
  `CREATE OR REPLACE` and repeats every existing branch byte-for-byte, as 0037 did for
  `enforce_invitation_scope`. (ADR-018 planned the same for `INTERVIEWER` in 0016; that migration was
  never written, so the trigger still lists exactly the eleven roles ADR-018 quotes.)
- `enforce_invitation_scope` (0001, redefined by 0037) admits the two roles for platform invitations,
  so a growth person joins by an ordinary staff invitation that a `GROWTH_ADMIN` holder sends.
- The names start with `GROWTH_` on purpose. The Android workspace classifier
  (`StaffDashboards.kt`, `classifyWorkspaces`) routes by prefix (`INSTITUTION…`, `EMPLOYER…`); a growth
  role must not match either.
- `packages/identity/src/staff-pool.ts` policy: the two roles join the staff-only roles passed in
  `apps/api/src/runtime-auth.ts`, so they count only from the MFA-required staff pool once that pool
  exists (ADR-025; HG-1 and HG-7 for the pool itself).

### 3.3 Team membership

`growth_team_members (membership_id, team, joined_at, left_at, reason_code, …)` with `team` in
`COLLEGE_PARTNERSHIPS`, `EMPLOYER_PARTNERSHIPS`. A person may be on both. The team decides which lead
kinds a person may own (a college lead needs a college-team owner). A manager's `manager_membership_id`
is on the team row, so a team has one line of reporting per person. Append-only history: a move is an
end plus a new row.

### 3.4 What each role may do

| Act | Executive | Manager | GROWTH_ADMIN | GROWTH_FINANCE |
|---|---|---|---|---|
| See own leads, visits, follow-ups, targets, commission statement | yes | yes | — | — |
| See unowned leads in own territory; claim one | yes | yes | yes | — |
| See every lead in the regions they manage, and their team's statements | — | yes | all regions | — |
| Create a lead; log a visit; add a follow-up | yes | yes | — | — |
| Reassign a lead | — | within their regions, reason-coded | anywhere, reason-coded | — |
| Request a handoff to operations | yes (own lead) | yes | — | — |
| Regions, territory assignments, teams, targets | — | propose targets for their team | yes | — |
| Decide an attribution dispute | — | — | yes (not their own) | — |
| Record a college payment received / cleared / bounced | — | — | — | yes |
| Propose a commission rate | — | — | — | yes |
| Approve a rate, a clearance or a payout | — | — | — | — (a different `APPROVE_HIGH_RISK` holder) |
| Create, verify, suspend an organisation; accept terms | never | never | only through the existing Operations routes and capabilities | never |

---

## 4. Territories

### 4.1 Model

India is modelled as **state or union territory → district**, with **city or town** as text on a lead.

| Table | Rows | Source |
|---|---|---|
| `growth_states` | the 28 states and 8 union territories, keyed by ISO 3166-2:IN code (`IN-KA`, `IN-DL`, …), with name | Seeded by the migration. These are public facts, not invented data; the migration cites the ISO list it copied |
| `growth_districts` | districts, keyed by the Local Government Directory (LGD) district code, with name and state | **Not seeded.** A `GROWTH_ADMIN` imports the official LGD district list (CSV) through an audited import, the pattern of the content bulk import. Districts are created and split every year; a migration would go stale |
| `growth_regions` | a named sales region (`South-1`, `NCR`) | Created by a `GROWTH_ADMIN` |
| `growth_region_areas` | which states, or which districts of a state, a region covers | Created by a `GROWTH_ADMIN`. One area belongs to at most one region at a time (partial unique index on live rows) |
| `growth_territory_assignments` | which person works which region, from when to when, as `EXECUTIVE` or `MANAGER` | Created by a `GROWTH_ADMIN`, reason-coded, append-only (end plus new row) |

A region with a state and no districts covers the whole state. A region with districts covers only
those. A district-level area and a whole-state area of the same state cannot both be live in
different regions (trigger).

### 4.2 Who sees which region

One pure function, `growthScopeFor(caller)`, in a new `packages/authorization/src/growth-scope.ts`, the
way `institution-scope.ts` does it for colleges (INST-02: one scope rule on every read). Every growth
read composes its SQL from it; no controller writes its own predicate.

- **Executive:** leads they own, anywhere; plus unowned leads whose area falls in a region they are
  assigned to today.
- **Manager:** every lead whose area falls in a region they manage today, owned or not, plus leads
  owned by anyone on their team.
- **GROWTH_ADMIN:** everything growth, all regions (from Operations).
- A lead's area is its district (or its state when the district is unknown). A lead with neither is
  visible only to its owner and to growth admins until someone sets its area.

Visibility follows the assignment **today**. A person moved off a region stops seeing its unowned
leads at once; the leads they own stay theirs until reassigned (§5.4).

---

## 5. Leads

### 5.1 One lead table, two kinds

`growth_leads` holds both kinds, because the lifecycle columns (owner, area, stage, source,
do-not-contact, handoff, retention) are the same:

| Column | Rule |
|---|---|
| `id` | uuid |
| `kind` | `COLLEGE` or `EMPLOYER` |
| `name` | 1–180, the organisation's name as the person heard it |
| `state_code`, `district_code`, `city` | area; codes reference §4 tables; city 1–120 text |
| `aishe_code` | colleges only, optional: the AISHE institution code (`C-`, `U-` or `S-` followed by digits), the one national identifier Indian colleges already have. Unique among live college leads |
| `website_domain` | employers: required once known; colleges: optional. Lower-case host. Unique among live employer leads |
| `owner_membership_id` | NULL (unowned) or an ACTIVE growth membership whose team matches `kind` (trigger) |
| `stage` | §6 and §7; moved only through the stage routes |
| `source` | `FIELD_VISIT`, `REFERRAL_LINK`, `INBOUND_ACCESS_REQUEST`, `EVENT`, `PUBLIC_DIRECTORY`, `INTRODUCTION`, `OTHER` |
| `do_not_contact_at`, `do_not_contact_reason` | set once; the lead can no longer be contacted or owned for outreach (§13) |
| `organization_id` | set only at handoff by operations (§6.3, §7.3); unique among leads |
| `created_by_user_id`, `created_at`, `updated_at`, `version` | optimistic concurrency like OPS-14 |

No free-text "notes" column on the lead: notes live on activities (§14), each authored and dated.

### 5.2 Contacts

`growth_lead_contacts` follows `institution_account_contacts` (OPS-14) exactly, because it is the same
problem: people at an organisation, supplied by someone other than themselves.

- Role (`PRINCIPAL`, `DIRECTOR`, `CHAIRMAN_OR_TRUSTEE`, `PLACEMENT_OFFICER`, `HR`, `TALENT_ACQUISITION`,
  `FOUNDER`, `OTHER`), name, email, phone, `permission_basis` (§13.2), `source` and who added it.
- Live or removed; removal erases name, email and phone in the same statement (CHECK plus trigger, as
  0078).
- Responses mask email and phone (`maskEmail`, `maskPhone` from the support desk). The owner of the
  lead sees their own contacts in full on their own device, because calling them is the job; anyone
  else (a manager reviewing, an admin) sees masked values and must use an audited reveal with a reason.
  **[Divakar]** O-9 asks whether the owner should also go through reveal.
- At most 10 live contacts per lead (code, not CHECK, as OPS-14).

### 5.3 Duplicates

A new lead is refused with `409 GROWTH_LEAD_DUPLICATE` when a live lead of the same kind has the same
`aishe_code` (colleges) or `website_domain` (employers), and flagged as a possible duplicate (not
refused) when the normalised name and district match. The 409 names the existing lead's owner only
to someone who may see that lead (§4.2); anyone else is told "already registered by another team
member — ask your manager", so the check cannot be used to browse other people's pipelines.

A lead for an organisation already on ONE (an `organizations` row matches by the same identifiers or
a linked lead exists) is refused with `409 GROWTH_ORGANIZATION_ALREADY_ON_ONE`. Existing customers are
not new business; they are OPS-14's accounts.

### 5.4 Ownership and reassignment

- **Creating** a lead makes the creator its owner, if their team matches.
- **Claiming** an unowned lead in one's territory makes one its owner (first claim wins, under a row
  lock), recorded as `CLAIMED`.
- **Reassigning** is a manager (within their regions) or a growth admin, with a reason code
  (`TERRITORY_CHANGE`, `WORKLOAD`, `OWNER_LEFT`, `DISPUTE_DECISION`, `INACTIVITY`, `CORRECTION`).
- **History:** `growth_lead_owner_history` is append-only (lead, from, to, reason, actor, `now()`).
  Ownership at any past moment is answerable from it, which attribution needs (§8).
- **A person who leaves.** When a growth membership leaves ACTIVE (ended or suspended, including by an
  OPS-15 access-review revocation), the same transaction (a trigger on `organization_memberships`,
  the pattern 0039 uses for role changes) moves every **open** lead they own to unowned with
  `OWNER_LEFT` and opens a manager task. Converted leads are not touched: their credit is attribution's
  question (§8.5).
- **Stale leads.** A lead with no activity for 90 days **[Divakar, O-10]** shows as stale to its
  manager, who may reassign it with `INACTIVITY`. Nothing moves automatically.

---

## 6. College pipeline, and exactly where it hands off

### 6.1 Stages

Stages a growth person sets (with history in `growth_lead_stage_history`, append-only):

`IDENTIFIED → CONTACTED → MEETING_SCHEDULED → MET → PROPOSAL_SHARED → NEGOTIATION → AGREEMENT_SIGNED_REPORTED → HANDOFF_REQUESTED`

plus `ON_HOLD` (from any open stage, back to where it was) and `LOST` (terminal, reason-coded:
`NO_BUDGET`, `CHOSE_COMPETITOR`, `NOT_DECISION_MAKER`, `NO_RESPONSE`, `NOT_ELIGIBLE`, `DUPLICATE`,
`OTHER`).

Stages **nobody in growth can set**, read from existing tables once operations has linked the lead to
an organisation:

| Derived milestone | Read from | Set by (existing flow) |
|---|---|---|
| `HANDED_OFF` | `growth_leads.organization_id` set | Operations, at handoff (§6.3) |
| `CONTRACT_RECORDED` | `institution_accounts.contract_reference` IS NOT NULL (0078) | Operations, `ACCOUNT_MANAGE`, OPS-14 |
| `VERIFIED` | `organizations.verification_state = 'VERIFIED'`; first `organization_verification_events` row to `VERIFIED` (0005) | Operations, `OPS_VERIFY` |
| `ADMIN_JOINED` | the initial institution admin invitation `ACCEPTED` (`invitations`, 0001) | The college's admin, through `POST …/initial-admin-invitations` |
| `DATA_TERMS_ACCEPTED` | `institution_data_terms_acceptances` has the required version (INST-18, 0088, in validation) — NA until INST-18 merges | The college owner, admin Settings |
| `FIRST_ROSTER` | the first committed roster import or added student (`institution_relationships`, 0000/0001) | The college, INST-01 flows (gated by INST-18's terms) |
| `STUDENTS_ACTIVATING` | count of activated students (`invitations.kind = 'STUDENT'`, `ACCEPTED`, 0037), suppressed `<5` | Students |
| `EXITED` | an `institution_offboardings` row in `ENDED` or `PURGED` (INST-18) | Operations, the college exit runbook |

These are computed on read, never stored on the lead, so they cannot disagree with the source.

### 6.2 What "agreement signed" means, and who confirms it

There are two agreements, and ONE already has a place for each:

1. **The commercial agreement** (paper, signed by the college's management and AI8HT). ONE stores only
   its identifier: `institution_accounts.contract_reference` (OPS-14), which by CHECK cannot hold an
   amount. The growth person *reports* it signed (`AGREEMENT_SIGNED_REPORTED`, with the reference they
   were given); **operations confirms** it by recording the reference on the account. Only the
   confirmation counts for attribution and commission.
2. **The data-processing terms** (INST-18). Accepted in-product by the college's owner, in admin
   Settings. Growth cannot accept them, see their text in a different way, or chase them except by
   seeing the `DATA_TERMS_ACCEPTED` milestone.

### 6.3 The handoff to operations onboarding

Nothing in growth creates an organisation. The handoff is a request:

1. The owner moves the lead to `HANDOFF_REQUESTED`. The request carries the lead's name, area,
   AISHE code, the contract reference reported, and the contacts the owner marks for handover.
2. It appears to operations as a queue section on the existing **Organizations** screen (the EMP-04
   access-request queue is the precedent: no navigation change), needing `OPS_ORG_MANAGE`.
3. The operator creates the organisation through the unchanged `POST /operations/organizations`
   (state `PENDING`) and links the lead: `POST /operations/growth-handoffs/:leadId/link` with the new
   organisation id, in one transaction that sets `growth_leads.organization_id`, writes the
   attribution (§8.2), audits and emits `growth.lead.handed_off`.
4. The operator carries the handed-over contacts into OPS-14's `institution_account_contacts` through
   the existing contact route (with the reason `ONBOARDING`), which is where college contacts live once
   the college is a customer. The lead's copies are then erased (§13.4) so the same person is not held
   twice.
5. Verification, the initial admin invitation, the account fields and the account owner stay exactly
   as they are. The **account owner** (OPS-14) is a customer-success person from the three internal
   roles; the growth person is the **attribution**, not the account owner (ADR-040, "Rejected details").
6. An operator may **decline** a handoff (`NOT_A_REAL_COLLEGE`, `DUPLICATE_OF_EXISTING`,
   `INCOMPLETE`, `CONTRACT_NOT_CONFIRMED`), which returns the lead to `NEGOTIATION` with the reason.

---

## 7. Employer pipeline, and exactly where it hands off

### 7.1 Stages

Set by growth: `IDENTIFIED → CONTACTED → MEETING_SCHEDULED → MET → INTERESTED → ACCESS_REQUEST_INVITED`,
plus `ON_HOLD` and `LOST` as for colleges.

Derived (read-only):

| Derived milestone | Read from | Set by (existing flow) |
|---|---|---|
| `ACCESS_REQUESTED` | an `employer_access_requests` row linked to the lead (§7.2) | The company, on the public form (EMP-04) |
| `ONBOARDED` | that request `ONBOARDED` with `organization_id` (0041) | Operations, `OPS_ORG_MANAGE` |
| `VERIFIED` | first `organization_verification_events` row to `VERIFIED` | Operations, `OPS_VERIFY` (EMP-03 enforces the state everywhere) |
| `TERMS_ACCEPTED` | `employer_terms_acceptances` covers the required version (EMP-16, 0084) | The employer's owner |
| `FIRST_JOB_PUBLISHED` | any `opportunities` row of the employer ever `PUBLISHED` (EMP-05), and the count published now | The employer (EMP-16 gates publishing on terms) |
| `CAMPUS_DRIVE` | any `campus_drives` row of the employer, by state (EMP-11, 0069) | The employer and the college's placement office |
| `SUSPENDED` | `verification_state = 'SUSPENDED'` | Operations, dual-controlled (OPS-02) |

Growth sees counts and states of an employer's jobs and drives, never their content, applicants or
candidates.

### 7.2 Referral links (employers)

Employers already have a public door: the EMP-04 access-request form. Growth adds a referral code to
it, without changing what the form discloses.

- `growth_referral_codes`: one or more codes per growth person — 10 random characters from an
  unambiguous alphabet, never the person's name — with `revoked_at`. A code is revoked automatically
  when its owner's membership leaves ACTIVE.
- The public form accepts an optional `ref`. In the same transaction as the request row, a valid, live
  code writes `employer_access_request_referrals (access_request_id, referral_code_id, created_at)`.
  An unknown, revoked or malformed code is **ignored silently**: the answer stays
  `202 { received: true }`, byte-for-byte as EMP-04 designed it, so a code cannot be tested for
  validity. Rate limits are unchanged.
- A new table rather than a column on `employer_access_requests`, so EMP-04's CHECKs and the privacy
  retention of declined requests (180 days, EMP-04 decision 4) are untouched; the referral row goes
  when its request goes.
- The growth person's lead is linked to the request when the domains match (`email_domain` or the
  website host), or when operations links it by hand in the queue.

### 7.3 The handoff

Operations still decides every request in the EMP-04 queue (Organizations screen). The queue row
shows "Referred by: <growth person>" or "Matches growth lead: <owner>" when either applies. Marking a
request `ONBOARDED` (unchanged route) against the employer the operator created also links the lead
and writes the attribution candidate (§8.3). Verification stays a separate `OPS_VERIFY` act.

---

## 8. Attribution — who is credited

### 8.1 Table

`growth_attributions` is the only source of truth for credit:

| Column | Rule |
|---|---|
| `id` | uuid |
| `organization_id` | the college or employer; `UNIQUE` among live attributions |
| `organization_kind` | `INSTITUTION` or `EMPLOYER`, checked against `organizations.kind` |
| `beneficiary_user_id` | the growth person credited (user, not membership: a person who changes role keeps credit) |
| `basis` | `LEAD_OWNER_AT_HANDOFF`, `REFERRAL_LINK`, `DISPUTE_DECISION`, `MANUAL_CORRECTION` |
| `lead_id` | the lead it came from, when there is one |
| `effective_from` | `now()` at creation |
| `ended_at`, `ended_reason_code`, `ended_by_user_id` | set together, once; `REASSIGNED`, `DISPUTE_DECISION`, `CORRECTION`, `ORGANIZATION_EXITED` |
| `created_by_user_id`, `reason_code`, `correlation_id` | |

Append-only except the end columns, set once (trigger). A change of credit is an end plus a new row,
so "who was credited on 12 March" is always answerable.

### 8.2 Colleges: ownership at signing

A college is credited to **the lead's owner at the moment operations links the handoff** (§6.3 step 3):
basis `LEAD_OWNER_AT_HANDOFF`. That is the moment AI8HT accepts that this person's work produced this
customer; it is after the signing the person reported and before any student exists.

### 8.3 Employers: referral first, then lead ownership, confirmed at verification

When operations marks an access request `ONBOARDED`:

1. a live referral on the request → basis `REFERRAL_LINK`, to the code's owner;
2. otherwise, a linked lead with an owner → `LEAD_OWNER_AT_HANDOFF`;
3. if both exist and name different people, **no attribution is written** and a dispute opens (§8.4).

An employer onboarded with neither is credited to nobody ("house"). Nothing is inferred later.

### 8.4 Disputes

`growth_attribution_disputes` (organisation, claimant, the current beneficiary or none, statement ≤ 2000
characters, state `OPEN → UPHELD | REJECTED`, decided by a `GROWTH_ADMIN` holder who is neither party,
reason-coded). A dispute may be opened by a growth person for an organisation they had a lead or a
referral for, within **90 days** of the attribution **[Divakar, O-8]**. While a dispute is open, the
organisation's accruals keep accruing but none becomes `PAYABLE` (the ledger holds them with
`HELD_DISPUTE`). An upheld dispute ends the attribution and writes a new one with basis
`DISPUTE_DECISION`, effective from the original date, and moves the not-yet-paid accruals to the new
beneficiary through ledger events (never by rewriting rows). Paid entries are not moved; see O-6.

### 8.5 Reassignment and leavers

- **Reassignment** of credit is a `GROWTH_ADMIN` act, reason-coded, and affects only accruals
  **earned after** the new row's `effective_from`. Earlier accruals stay with the person who earned
  them.
- **A person who leaves** (membership no longer ACTIVE) keeps credit for accruals already earned.
  Whether those still become payable after they leave is **[Divakar, O-5]**; the recommendation is:
  ACCRUED and ELIGIBLE entries continue to PAYABLE and are paid in the final settlement for 90 days
  after the leave date, then lapse. Accruals **earned after** the leave date go to nobody unless a
  growth admin reassigns the attribution.
- **Commission tail.** Whether a college keeps earning its growth person commission for every new
  student forever, or only for students activated within N months of the handoff, is
  **[Divakar, O-4]**; recommended 24 months.

### 8.6 Self-dealing guard

- An operator cannot verify (`OPS_VERIFY`), record a payment for, or approve a rate or payout
  affecting an organisation attributed to themselves, or a statement of their own. Checked on the
  user id across all memberships, in the route and in the approval rule (OPS-02 already refuses the
  requester as approver).
- A growth person cannot be the approver of anything (they hold no capability).

---

## 9. What an "active student" is

### 9.1 What ONE records today

- **Activation:** a rostered student becomes a user when they accept their emailed invitation —
  `invitations.kind = 'STUDENT'`, `state = 'ACCEPTED'`, `accepted_at` (0037), and `users.state = 'ACTIVE'`.
- **Learning activity:** `learner_activity_events` (0015: `LESSON_COMPLETED`, `EXAM_ATTEMPT_STARTED`,
  `EXAM_ATTEMPT_SUBMITTED`, with `occurred_at`) and the ENG-03 attempt log `learning_attempt_events`
  (0047, with `occurred_at` on every answered item).
- **Relationship:** `institution_relationships` (`PENDING`, `VERIFIED`, `ACTIVE`, `ENDED`, `TRANSFERRED`,
  `GRADUATED`, `REVOKED`), with `effective_from` / `effective_to`.
- **Not recorded:** sign-ins. OPS-14 already noted that ONE keeps no per-sign-in history for students,
  and this design does not add one. Signing in alone therefore cannot count.

### 9.2 The rule (versioned)

A student **qualifies** for the college attributed to a growth person when all of these hold:

1. **Rostered by the college.** The student's relationship with the college was created by the college
   (a roster add or import, INST-01), is in `VERIFIED` or `ACTIVE`, and began **on or after** the
   attribution's `effective_from`. Alumni who reach the college through an alumni verification request
   do not count **[Divakar, O-3]**.
2. **Activated.** The student's invitation from that college was accepted; call its IST date `A`.
3. **Window.** The window is the 30 IST calendar days `A+1 … A+30`.
4. **Engaged.** In the window, the student has learning activity on at least **N distinct IST days**,
   where a day counts if it has any `learner_activity_events` row or any `learning_attempt_events` row
   for the student. **N is [Divakar, O-1]; recommended N = 4** (about once a week). `N = 0` would mean
   "stayed activated for 30 days", which a college could satisfy by activating students who never use
   ONE.
5. **Still there at the end.** At the end of day `A+30`: `users.state = 'ACTIVE'` (not `SUSPENDED`,
   `DELETION_PENDING` or `DELETED`), and the relationship is still `VERIFIED` or `ACTIVE`.
6. **Once.** A student qualifies at most once, ever, across all colleges (unique on the pseudonymous
   reference, §10.6). A student who transfers does not earn a second commission.

If the window ends without condition 4 or 5, the accrual **lapses**. Whether a lapsed student gets a
second window (for example, a student activated just before exams) is **[Divakar, O-2]**; the
recommendation is no second window, because one fixed window is the simplest rule to audit and hardest
to game.

### 9.3 Why this shape

- **Auditable.** Every input is a row with a database timestamp. The evaluation writes an immutable
  `growth_student_qualifications` row: the pseudonymous reference, the college, `A`, the window, the
  number of distinct active days found (a count, not the dates), the rule version, the outcome
  (`QUALIFIED` or `LAPSED` with reason) and `evaluated_at`. The rule is re-runnable against the same rows
  while they exist, and the stored count stands as evidence after the student's data is erased.
- **Versioned.** `growth_active_rule_versions (version, min_active_days, window_days = 30, effective_from,
  set_by, reason)`. A student is judged under the version in force on `A`. A change never re-judges past
  windows. The first version is written by an operator, not seeded, and until one exists every accrual
  shows "Active-student rule not set" (NA), exactly as an unset rate does.
- **IST days.** Windows are calendar days in `Asia/Kolkata`, computed in SQL (`occurred_at AT TIME ZONE
  'Asia/Kolkata'`). `learner_activity_events.occurred_on` is a UTC `CURRENT_DATE` default and is not used.
- **Suppression-safe.** The qualification table is read only by the ledger worker and by finance; growth
  staff see counts through §10.8.

---

## 10. Commission ledger

### 10.1 Shape

Two append-only tables, so that what happened and what it was worth are never rewritten:

- **`growth_commission_accruals`** — one row per earning unit, immutable after insert:
  `id`, `basis` (`ACTIVE_STUDENT` or `EMPLOYER_VERIFIED`), `attribution_id`, `beneficiary_user_id`
  (copied from the attribution at accrual), `organization_id`, `student_ref` (ACTIVE_STUDENT only; §10.6),
  `earned_on` (the activation date `A` for a student; the first-verified date for an employer),
  `region_id` (the lead's region at handoff, for regional rates), `created_at`.
  Uniqueness: one accrual per `(basis, student_ref)` for students and one per `(basis, organization_id)`
  for employers — a student or an employer is paid for once.
- **`growth_commission_events`** — every state change, append-only: `accrual_id`, `to_state`,
  `reason_code`, `rate_version_id` and `amount_paise` (when valued), `payment_id` (when made payable by a
  payment), `payout_batch_id` (when paid), `actor_user_id` (NULL for the worker), `approval_id` (when
  dual-controlled), `occurred_at = now()`.
- The accrual's **current state** is its latest event. A `current_state` column on the accrual,
  maintained by the event trigger in the same statement, makes it indexable; the trigger refuses any
  other update to the accrual.

Money is **integer paise** (`bigint`) with `currency = 'INR'`. No floating point anywhere.

### 10.2 States

```
ACCRUED ──(qualified: §9 / employer hold)──> ELIGIBLE ──(conditions met + valued)──> PAYABLE ──(payout marked)──> PAID
   │                                           │   ▲                                     │
   └──(window failed / student erased /        │   └──(payment bounced or refunded, ─────┘
       relationship ended)──> LAPSED            │       dispute opened)  back to ELIGIBLE
                                                └──(dispute open)──> HELD_DISPUTE ──> ELIGIBLE
PAID ──(clawback, only if Divakar decides O-6)──> REVERSED  (a negative entry in the next payout)
```

| State | Meaning | Who moves it |
|---|---|---|
| `ACCRUED` | The earning event happened: a student of an attributed college activated; an attributed employer was verified for the first time | Growth ledger worker |
| `ELIGIBLE` | Students: qualified under §9. Employers: still `VERIFIED` after a hold of **30 days** without suspension or rejection **[Divakar, O-7]** | Worker |
| `PAYABLE` | Students: a **cleared** college payment covers the activation date (§11.3), no dispute is open, and a rate is in force. Employers: no dispute open and a rate in force (employers pay AI8HT nothing, so D8(b) has no employer counterpart — **[Divakar, O-7]**) | Worker |
| `PAID` | Included in a payout batch that finance marked paid, with an approval | Finance + approver |
| `LAPSED` | Will never be paid: window failed, student erased or relationship ended before qualifying, employer rejected or suspended in the hold, commission tail exceeded, or a leaver's settlement period ended | Worker |
| `HELD_DISPUTE` | An attribution dispute is open for the organisation | Dispute routes |
| `REVERSED` | A paid entry is clawed back (only if O-6 is decided yes) | Finance + approver |

### 10.3 Valuation: rates, and "Rate not set"

- An entry is valued **when it becomes payable**, at the rate in force **on its `earned_on` date** for
  its basis and region **[Divakar, O-11: earned date vs payable date]**. The event records the
  `rate_version_id` and `amount_paise` it used, so a later rate change never alters a valued entry.
- **No rate in force → no amount.** The entry stays `ELIGIBLE` with the flag "Rate not set", shown as
  **NA** everywhere an amount would appear. It is never valued at zero and never at a guessed figure.
  When operations later sets a rate whose effective date covers `earned_on`, the next worker run values
  it.

### 10.4 The rate table

`growth_commission_rate_versions` — append-only, immutable rows:

| Column | Rule |
|---|---|
| `id` | uuid |
| `basis` | `ACTIVE_STUDENT` or `EMPLOYER_VERIFIED` |
| `region_id` | NULL = national; otherwise a region. A regional rate beats the national rate for its region |
| `amount_paise` | `bigint`, ≥ 0 — a zero rate is a deliberate decision, not a default |
| `currency` | `INR` |
| `effective_from` | a date; the version in force on a date is the latest `effective_from ≤ date` for the basis and region |
| `supersedes_id` | the version it replaces (NULL for the first of its basis and region) |
| `reason_code` | `INITIAL_RATE`, `RATE_REVISION`, `REGIONAL_RATE`, `CORRECTION`, `PROMOTION_PERIOD` |
| `note` | ≤ 500, kept in the row and the audit context |
| `proposed_by_user_id`, `approval_id`, `created_at` | the proposer (`GROWTH_FINANCE`) and the OPS-02 approval |

- **Every change recorded** (D7): a change is a new row that names the row it supersedes, so old → new,
  who (proposer and approver), when (`created_at`, database clock) and why (reason code and note) are
  all on the row, plus an `audit_events` row and a `growth.commission_rate.set` outbox event.
- **Dual control:** yes, recommended and adopted (money moves). A new OPS-02 extended action key
  `GROWTH_COMMISSION_RATE_SET` (0051's mechanism), requested and executed by a `GROWTH_FINANCE` holder,
  approved by a different `APPROVE_HIGH_RISK` holder, bound to the exact basis, region, amount and
  effective date. The solo safeguard (cooling-off) applies while AI8HT has one approver.
- **Backdating:** an `effective_from` earlier than today is allowed only with the reason `CORRECTION` or
  `INITIAL_RATE`, and never earlier than the first accrual it would value is already `PAID` (it can only
  value unvalued entries). **[Divakar, O-12]**
- **Nothing is seeded.** No migration or fixture writes a rate. The Growth portal says "Rate not set"
  until operations set one.

### 10.5 Reversals

| Event | Before `ELIGIBLE` | `ELIGIBLE` | `PAYABLE` | `PAID` |
|---|---|---|---|---|
| Student erases their account (privacy deletion executes) | `LAPSED` (`STUDENT_ERASED`) | stays; the reference is severed (§10.6) | stays | stays |
| Student's relationship ends in the window | `LAPSED` (`RELATIONSHIP_ENDED`) | no change | no change | no change |
| College payment bounces or is refunded | — | — | back to `ELIGIBLE` (`PAYMENT_BOUNCED` / `PAYMENT_REFUNDED`) | **[Divakar, O-6]**: recommended no clawback |
| College leaves ONE (INST-18 exit) | `LAPSED` (`ORGANIZATION_EXITED`) | no change | no change | no change |
| Employer suspended or rejected in the hold | `LAPSED` | no change | no change | no change |
| Attribution dispute opens | `HELD_DISPUTE` from `ACCRUED`/`ELIGIBLE`/`PAYABLE` | | | no change |

A student who met the rule met it; their later deletion does not undo work already done. That is why
erasure lapses only unqualified entries.

### 10.6 Privacy: students are references, never people

- `growth_student_refs (student_user_id → users, student_ref uuid UNIQUE, created_at)` is the only link
  between a person and the ledger. The ledger, the qualification rows and every statement carry
  `student_ref`, never `student_user_id`.
- **Erasure severs the link.** The privacy deletion path (`apps/api/src/http/privacy-deletion.ts`, which
  already deletes `learner_activity_events` for the subject) deletes the student's `growth_student_refs`
  row in the same transaction and lapses their unqualified accruals. What remains is a random uuid with
  a count and a date, which identifies nobody.
- Only the ledger worker joins `growth_student_refs`. No route returns a `student_ref` to a growth person
  or a manager; finance sees it only in the ledger detail, never beside a name.
- `docs/architecture/privacy-export-coverage.md` gains a row: the mapping is AI8HT's commercial record,
  not the student's learning record; the export states that the student's activation may be counted in
  a partnership record without naming anyone. **[Divakar, O-14]**

### 10.7 The worker

A daily one-shot job, `run-growth-ledger-worker.ts`, beside `run-privacy-worker.ts` and registered with
the OPS-04 jobs console: accrue, evaluate windows, apply holds, value, make payable, lapse. Bounded
batches, database clock, idempotent (re-running a day changes nothing), one transaction per accrual
move, no work in any request handler. Each run writes a summary (counts per transition) for the jobs
console.

### 10.8 What a growth person sees

- **My commission:** by month of `earned_on`, per basis: accruals in each state and the payable and paid
  amounts. Amounts for their own money are exact (they must be able to check their pay).
- **Per organisation:** counts of students per state for each college, through `suppressSmallCount`;
  a college whose count in a state is below 5 is folded into "Other colleges (<5 each)" so the
  row cannot be read per college. The money total per month stays exact. **Residual disclosure:**
  someone with a single attributed college could divide their monthly amount by the rate and learn how
  many of its students qualified that month — a count, never an identity. Accepted and recorded as
  **[Divakar, O-13]**.
- **Why not payable:** each unpaid group says which condition it waits for, in plain words: "Waiting for
  the 30-day window", "Waiting for the college's payment to clear", "Rate not set", "Dispute open".
  Never a student name, never an amount the college paid.
- A manager sees the same for each person on their team; a growth admin for everyone.

### 10.9 Payouts

- `growth_payout_batches (id, period, state DRAFT → APPROVED → PAID | CANCELLED, prepared_by, approval_id,
  paid_recorded_by, payout_reference, paid_on)`. Finance prepares a batch of `PAYABLE` entries with an
  amount (entries with NA cannot enter a batch). A batch shows totals per person.
- **Marking paid is dual-controlled:** OPS-02 extended key `GROWTH_COMMISSION_PAYOUT`, bound to the batch
  id and its total. The approval moves every entry to `PAID` in one transaction.
- **Export for payroll:** a CSV per batch (person, email, entries, total in rupees), through INST-08's
  CSV writer rules, audited before it is sent. No student data is in it.
- ONE records the payout reference (a payroll run or bank batch id) and date. It does not pay anyone,
  and it computes no tax. Whether growth staff are paid as employees (salary incentive) or as contractors
  (commission subject to TDS) is for Divakar and his accountant **[O-16]**.

---

## 11. College payments

### 11.1 Table

`institution_payments` — named for what it records, not for growth, because finance may later need it
for other purposes (it is still not billing; ADR-022):

| Column | Rule |
|---|---|
| `id` | uuid |
| `institution_id` | an `INSTITUTION` organisation (trigger) |
| `instrument` | `CHEQUE`, `DEMAND_DRAFT`, `BANK_TRANSFER` (NEFT/RTGS/IMPS), `UPI` |
| `instrument_reference` | the cheque or DD number, or the UTR; `^[A-Za-z0-9/-]{4,40}$`. Never a bank account number |
| `amount_paise` | `bigint > 0`, `currency = 'INR'` |
| `received_on` | the date AI8HT received it |
| `covers_from`, `covers_to` | the period this payment is for (for example an academic year), `covers_to ≥ covers_from` |
| `state` | `RECEIVED → CLEARED | BOUNCED`; `CLEARED → REFUNDED`; any → `VOIDED` (entered in error) |
| `recorded_by_user_id`, `recorded_at` | the `GROWTH_FINANCE` holder, `now()` |
| `cleared_on`, `cleared_recorded_by_user_id`, `clearance_approval_id` | set together on `CLEARED` |
| `bounced_on`, `bounced_reason_code` | `INSUFFICIENT_FUNDS`, `SIGNATURE_MISMATCH`, `STOPPED`, `STALE`, `OTHER` |
| `refunded_on`, `voided_reason_code`, the actor columns | set together, once |
| `note` | ≤ 500; the screen warns not to put personal data in it |

Immutable except those state transitions (trigger). A correction is `VOIDED` plus a new row. Never
deleted. Audit action per transition (`operations.institution_payment.recorded`, `.cleared`, `.bounced`,
`.refunded`, `.voided`) and an outbox event, which the ledger worker does not need (it reads the table)
but a later notification might.

### 11.2 Who records what

- **Recording receipt, bounce, refund, void:** a `GROWTH_FINANCE` holder, reason-coded, on the college's
  Organization Detail in Operations (a section beside OPS-14's account fields). Bounce, refund and void
  only ever take commission *away* from payable, so a single person may do them.
- **Recording clearance:** dual-controlled — clearance is what makes commission payable. OPS-02 extended
  key `INSTITUTION_PAYMENT_CLEARANCE`, bound to the payment id, amount and cleared date; approved by a
  different `APPROVE_HIGH_RISK` holder. **[Divakar, O-17]** may prefer single-person clearance.
- Nobody may record a payment for a college attributed to themselves (§8.6).
- **Visibility:** operators with `GROWTH_FINANCE` or `ACCOUNT_MANAGE`. Never a college, an employer or a
  growth person. Growth sees only "Waiting for the college's payment to clear" or nothing.

### 11.3 Which students a payment unlocks

A student accrual becomes payable when a `CLEARED` payment of the **same college** has a coverage period
that contains the student's activation date `A`. This matches how colleges pay (per academic year) and
means a payment for 2026–27 does not unlock students activated in 2025–26. Alternatives — any cleared
payment after `A`, or a payment per counted student — are listed in **[Divakar, O-18]**.

A college on a free pilot records no payment, so its accruals never become payable. That is D8(b) as
written; if Divakar wants pilot colleges to pay commission, that is **O-19**.

---

## 12. Targets

- `growth_targets (id, period, scope PERSON | TEAM | REGION, scope_id, metric, target_value, set_by,
  reason, created_at, superseded_by)`. Periods are calendar months or quarters in IST. Append-only: a
  change supersedes the old target, so a mid-quarter change is visible.
- **Metrics, each with a real source:**

| Metric | Counted from |
|---|---|
| `COLLEGE_MEETINGS` | visits logged with outcome `MET` (§14) |
| `COLLEGES_HANDED_OFF` | leads linked by operations in the period |
| `COLLEGES_CONTRACT_RECORDED` | first `contract_reference` recorded on the account in the period (OPS-14 audit) |
| `COLLEGES_LIVE` | attributed colleges whose first student activated in the period |
| `STUDENTS_QUALIFIED` | qualifications `QUALIFIED` in the period, attributed to the scope |
| `EMPLOYER_MEETINGS` | visits with outcome `MET` on employer leads |
| `EMPLOYERS_VERIFIED` | attributed employers first verified in the period |
| `EMPLOYERS_WITH_FIRST_JOB` | attributed employers whose first job was published in the period |

- Progress is computed from those rows on read. A metric with no source yet (for example
  `COLLEGES_CONTRACT_RECORDED` before GROWTH-04) shows NA, not 0.
- Targets are set by a growth admin; a manager may propose targets for their team, which the admin
  accepts. Setting a target moves no money and needs no dual control.
- Targets and commission are independent: missing a target changes no commission, and there is no bonus
  multiplier. **[Divakar, O-20]** if he wants target-linked incentives.

---

## 13. Lead personal data under the DPDP Act

Leads are the one place ONE would hold personal data of people who are not its users and never agreed
to anything: principals, trustees, placement officers, HR managers. The design treats that as the main
privacy risk of the portal. The text below is the design; the notice wording is a draft for legal review
and publishing it is HG-6.

### 13.1 Purpose

One purpose, stated on every contact record and in the notice: **to contact this person about their
organisation partnering with AI8HT's ONE platform**. Contact data is not used for marketing email
campaigns, not shared outside AI8HT, not enriched from data brokers, and not used for anything about
the person themselves.

### 13.2 Where contact data may come from, and the basis for holding it

Each contact records `permission_basis`:

- `PROVIDED_BY_PERSON` — they gave it themselves (business card, a meeting, an email to us, the EMP-04
  form). The recommended default basis.
- `PUBLIC_INSTITUTIONAL_LISTING` — an official contact published by the organisation for exactly this
  kind of enquiry (a college's published principal or placement-office contact). Role addresses
  (`placement@college.edu`) are preferred over personal ones.
- `INTRODUCED_BY_COLLEAGUE` — a colleague at the same organisation passed it on for this purpose.

Personal mobile numbers from any other source, purchased lists and scraped data are not allowed, and
the form says so. Whether each basis is sufficient under the DPDP Act 2023 and its Rules (consent under
section 6, or the "voluntarily provided" legitimate use under section 7(a)) is for legal review
**[Divakar, O-21]**.

### 13.3 What leads are told

At the first contact, the growth person gives (or sends) a short notice: who AI8HT is, why we hold their
contact details, where they came from, how long we keep them, and how to ask us to stop or delete them.
A draft is added to `docs/legal/` as `growth-lead-contact-notice-DRAFT-for-legal-review.md` by GROWTH-03,
labelled DRAFT throughout. The contact record stores `notice_given_at` and the notice version.

### 13.4 Retention and deletion

| Situation | What happens |
|---|---|
| Lead converted and handed off | Contacts marked for handover are carried into OPS-14's contacts by operations; the lead's copies are erased (§6.3) |
| Lead `LOST` or no activity for 12 months **[Divakar, O-22]** | A daily sweep in the privacy worker erases every contact's name, email and phone (the removal rule of §5.2), leaving the organisation-level lead |
| The person asks to be removed | A growth admin removes the contact with `PRIVACY_REQUEST` (erases the fields) and sets `do_not_contact` on the lead when they ask not to be contacted at all |
| Do-not-contact | The lead can no longer be claimed, reassigned for outreach or have visits logged; a new lead for the same identifiers is refused |
| A person's rights request reaches AI8HT through the Privacy console | OPS-06's privacy requests gain a "growth lead contact" lookup by email or phone, returning which leads hold them, so the request can be answered and executed |

Visit notes are organisation-level. The form reminds staff not to write personal details about
individuals (health, family, opinions of the person) into them, and a note is erased with its lead's
contacts when the retention sweep runs **[Divakar, O-22]**.

### 13.5 Growth staff's own data

Growth staff are also data principals. Their visit locations (§14.3), activity logs and commission are
their personal data: they see all of it, the privacy export includes it, and location is kept only as
long as §14.3 says.

---

## 14. Field work on the phone

### 14.1 What the Android app does for field staff

- **Today:** my follow-ups due today and overdue, my visits planned, my pipeline by stage, my targets
  this month, "Rate not set" or my commission this month.
- **Leads:** list (mine, my territory's unowned), search, detail with the derived milestones, create a
  lead, claim, move a stage, add a contact (with its basis and "notice given"), call or email a contact
  through the phone's own dialler and mail app (ONE does not record calls).
- **Visit log** (`growth_activities`, kind `VISIT`, `CALL`, `MEETING`, `NOTE`): organisation, who was met
  (a contact reference, not free text), outcome (`MET`, `NOT_AVAILABLE`, `RESCHEDULED`, `DECLINED`,
  `INTERESTED`), notes ≤ 2000, optional location (§14.3), `occurred_at` as reported by the device and
  `received_at = now()`.
- **Follow-ups** (`growth_follow_ups`): due date, what, done or cancelled; local reminders through the
  phone's notification channel, scheduled on the device (no server push is needed).
- **Referral link:** show and share my employer referral link (Android share sheet).
- **Handoff:** request a handoff from the lead detail.
- **Not on Android:** territory set-up, target setting, rates, payments, payouts, disputes. They are desk
  work for operators, as INST-18 kept terms and exports off the Android staff workspace.

### 14.2 Offline

Field visits happen where the network is poor. The app already keeps a read cache (`data/Store.kt`,
JSON of API responses, cleared on sign-out). Growth adds a **write queue**:

- A visit, note, follow-up, stage move or new lead made offline is stored in an app-private queue file,
  each with a client-generated uuid and an `Idempotency-Key`. The API accepts growth writes through the
  existing idempotency records (`idempotency_records`, 0001; used by `apps/api/src/http/api-security.ts`),
  so a retried send cannot create a duplicate.
- The queue is sent in order when the network returns. A write the server refuses (the lead was
  reassigned meanwhile, the stage moved, do-not-contact was set) is shown to the person with the reason,
  and kept until they dismiss it; nothing is silently dropped.
- `occurred_at` is the device time at capture and is stored as reported, beside the server's
  `received_at`; ordering and every period boundary use `received_at` or database time, and a report
  more than 7 days old or in the future is refused.
- **Sign-out clears the cache and the queue** after warning when unsent items exist, because a shared or
  lost phone must not keep contacts. Contacts are cached only for the person's own leads. The queue is
  stored with Android's app-private storage; encrypting it with a key in the Android Keystore is part of
  GROWTH-06.
- The app keeps no student data at all for growth users, because the API returns none.

### 14.3 Location, optional

- **Only on a tap.** When logging a visit the person may tap "Attach my location". The app asks for
  foreground location permission (`ACCESS_COARSE_LOCATION`, "while using the app") the first time, with
  a plain explanation. It never requests background location and never records location at any other
  time.
- **Purpose:** to show the person and their manager that a visit was logged at or near the lead's area.
  It is never used for attendance, pay or discipline without a separate decision **[Divakar, O-23]**.
- **Precision and retention:** stored rounded to 3 decimal places (about 100 m) with the accuracy the
  phone reported; kept **180 days** then erased by the daily sweep **[Divakar, O-23]**; visible to the
  person and their manager only.
- A visit without location is a complete visit. Declining the permission changes nothing else.
- The app's first-run notice for growth staff states all of this; its text is a draft (HG-6 for
  publishing).

---

## 15. Security

- **Access reviews.** Growth memberships are ACTIVE memberships of the `PLATFORM` organisation, so the
  OPS-15 snapshot (`packages/persistence/src/access-reviews.ts`) includes them with no change; their
  capability snapshot is empty, which is correct. `GROWTH_ADMIN` and `GROWTH_FINANCE` grants are
  capability grants and are reviewed like every other. GROWTH-16 adds a UAT step proving it.
- **Operator isolation first.** Before any growth membership can exist, GROWTH-01 narrows the queries
  that treat every platform membership as an operator: approval notifications
  (`packages/persistence/src/operation-approvals.ts`) and job-health alerts
  (`packages/persistence/src/jobs-health.ts`) select every ACTIVE platform membership as a recipient.
  They are restricted to `platformInternalRoles`. The staff list (`platform-controls.ts`) and support
  assignees (already filtered by `SUPPORT_CASES`) keep showing or excluding growth staff correctly. An
  integration test signs in a growth executive and asserts 403 on every `/api/v1/operations/*` route.
- **No verification or approval by growth.** Growth roles hold no internal capability and cannot be
  granted one (§3.2). Growth routes never write `organizations`, `organization_verification_events`,
  `employer_access_requests` decisions, terms acceptances or `institution_accounts`.
- **Dual control where money moves:** rate set (`GROWTH_COMMISSION_RATE_SET`), payment clearance
  (`INSTITUTION_PAYMENT_CLEARANCE`), payout (`GROWTH_COMMISSION_PAYOUT`), and a clawback if O-6 allows
  one. Each is an extended OPS-02 key, added to `highRiskActionKeys` and to
  `operation_approval_extended_target_type` by migration, like OPS-08 and OPS-16 did.
- **Self-dealing guard** (§8.6).
- **Staff pool.** Growth roles are staff-only roles (§3.2), so MFA is required once the pool exists.
  Until then they sign in like every other staff member today.
- **Bounded reads.** Every list is keyset-paged and capped, like the Operations lists. No endpoint returns
  another person's full contacts.
- **Audit.** Every growth write has an `audit_events` row. Reveals of contacts, exports and every money
  step have distinct audit actions so an access review can find them.

---

## 16. Surfaces

### 16.1 Web — the Growth portal (`/growth`), navigation approved (HG-3, D1)

`workspaceForMembership` (`apps/web/src/App.tsx`) maps the two roles to a new `portalChoices` entry
with path `/growth`, and `/growth` joins the protected portal roots. Navigation, in the pilot design
system (white sidebar, pilot tokens, the AI8HT wordmark through `BrandWordmark`):

| Item | Executive | Manager |
|---|---|---|
| Home | own dashboard | team dashboard |
| Leads (Colleges / Employers tabs, list and board by stage) | yes | yes |
| Field (visits and follow-ups, calendar) | yes | yes, team view |
| Territory | own regions and unowned leads | regions managed, coverage |
| Targets | own | team, propose |
| Commission | own statement | team statements |
| Team | — | members, workload, stale leads |

Every dashboard follows the pilot's composition (greeting hero, KPI cards, progress rings, chips), fed
only by real rows; an empty source renders NA or 0 in the same slot. No invented leads, visits or
amounts appear anywhere, including demos.

### 16.2 Web — Operations (no navigation change)

- **Organizations:** the growth handoff queue (§6.3) beside the EMP-04 access-request queue; referral
  and lead matches on access requests (§7.3); on a college's detail, the attribution and the
  "Payments received" section (§11).
- **Settings:** "Growth set-up" (regions, districts import, territory assignments, teams, active-student
  rule versions) for `GROWTH_ADMIN`; "Commission rates" (versions, proposals) for `GROWTH_FINANCE`.
- **Analytics:** a growth section (pipeline by region, attribution disputes, ledger by state, payouts)
  for `GROWTH_ADMIN` or `GROWTH_FINANCE`.
- **Settings → Approvals:** the three new approval kinds appear in the existing queue.
- A dedicated Operations navigation item for growth would need its own HG-3 approval (**O-24**).

### 16.3 Android

`WorkspaceKind.GROWTH` in `StaffDashboards.kt`'s `classifyWorkspaces`, a Growth home in the app's
dark band and light sheet style with the silver wordmark, and the screens of §14.1. Compiled with the
Android Studio toolchain in every goal that touches it.

---

## 17. Open decisions for Divakar

Each has a recommendation. Until he decides, the recommended behaviour is built where it is safe
(nothing is paid on a guess), and the screens say "not decided" where a value is missing.

| # | Decision | Recommendation |
|---|---|---|
| O-1 | Minimum distinct active days in the 30-day window (N) | **4** (about weekly). N is data, set by operations as the first active-student rule version; until set, "Active-student rule not set" |
| O-2 | A second window for a student who lapses | No second window |
| O-3 | Do alumni verified through an alumni request count as active students | No — only students the college rostered |
| O-4 | Commission tail: students activated how long after handoff still earn commission | 24 months from the attribution |
| O-5 | Leaver: are earned, unpaid accruals still paid | Yes, for accruals that become payable within 90 days of leaving; then lapse |
| O-6 | Claw back paid commission if the cheque bounces or is refunded later | No clawback; a bounce only affects unpaid entries |
| O-7 | Employer commission: hold period before eligible, and any payment condition | 30-day hold without suspension; no payment condition (employers do not pay) |
| O-8 | Dispute window | 90 days from the attribution |
| O-9 | Should a lead's owner also use audited reveal for their own contacts | No — the owner sees their own contacts in full; others use reveal |
| O-10 | When a lead is shown as stale | 90 days without activity |
| O-11 | Value an accrual at the rate on its earned date, or on its payable date | Earned date |
| O-12 | Allow backdated rates | Only with `CORRECTION` or `INITIAL_RATE`, dual-controlled, never affecting a paid entry |
| O-13 | Accept the residual count disclosure in a person's own exact monthly total (§10.8) | Accept |
| O-14 | How the student privacy export describes the growth mapping | A sentence, no figures |
| O-15 | A public "college interest" form like EMP-04 | Not now; colleges come through field work |
| O-16 | Growth staff paid as employees or contractors (TDS) | For Divakar and the accountant; ONE computes no tax |
| O-17 | Payment clearance dual-controlled or single-person | Dual-controlled |
| O-18 | Which students a cleared payment unlocks | Students whose activation date falls inside the payment's coverage period |
| O-19 | Pilot colleges that pay nothing: commission or none | None (D8(b) as written) |
| O-20 | Target-linked incentives | None; targets and commission are independent |
| O-21 | Legal basis for each lead-contact source under the DPDP Act | Legal review; allow only the three bases in §13.2 until then |
| O-22 | Lead contact retention after LOST or inactivity; visit-note retention | 12 months, then erase |
| O-23 | Visit location: retention and permitted uses | 180 days; never for attendance or pay |
| O-24 | An Operations navigation item for growth administration and finance | Not now; sections of existing screens |
| O-25 | Rates themselves (per active student, per verified employer; national or regional) | Not decided (D7). Nothing is paid until set |

---

## 18. Goal breakdown

Conventions as the program appendices: one goal is one agent, one branch, one PR to the base branch;
design first where a table carries consequences; tests before implementation; report appended to
`docs/growth/GROWTH_PROGRESS.md` (created by GROWTH-01). Every goal: the minimum tests of its appendix
(pure-function tests in `packages/authorization`, integration specs for every route including 403 for
each role that must not pass, web tests, Android compile), CI parity per the agent brief, no navigation
change outside the Growth portal.

Milestones: **G1** foundation (01–03), **G2** pipelines and field work (04–07), **G3** money (08–12),
**G4** targets, dashboards and assurance (13–16).

### GROWTH-01 — Growth roles, portal shell and operator isolation
Milestone: G1 · Priority: P0 · Size: M · Depends on: OPS-01, OPS-02, OPS-07, OPS-15 (merged) ·
Branch: `feat/growth-roles-portal` · **Migration: yes** · **Android: yes**
Why. Nothing else can be built until a growth person can exist, sign in, and be proven unable to reach
Operations.
Build.
1. Narrow approval-notification and job-health recipients to `platformInternalRoles` (tests first,
   reproducing that a non-internal platform membership would receive them).
2. Migration: redefine the membership scope trigger and the invitation scope trigger to admit
   `GROWTH_EXECUTIVE` and `GROWTH_MANAGER` in the platform branch, every other rule repeated
   unchanged; `growth_team_members`; add `GROWTH_ADMIN` and `GROWTH_FINANCE` to the capability CHECK.
3. `packages/authorization`: the two roles, no baseline, never grantable; the two capabilities
   (baseline super admin, grantable to `OPERATIONS_ADMIN`); staff-only roles in `runtime-auth.ts`.
4. Operations → Settings "Growth team" section (`GROWTH_ADMIN`): invite a growth person, set their team
   and manager, end their membership.
5. Web `/growth` workspace and the navigation of §16.1, every page the existing empty state saying
   plainly what is not built yet. Android `WorkspaceKind.GROWTH` with the same empty home.
6. Create `docs/growth/GROWTH_PROGRESS.md`.
Do not. Give growth roles any internal capability; add Operations navigation.
Acceptance.
- A growth executive gets 403 on every `/api/v1/operations/*` route (one spec enumerates them).
- A growth membership never receives an approval or job-health notification.
- An OPS-15 campaign opened after a growth person joins lists their membership with an empty
  capability set.
- The Growth portal shows the wordmark, the approved navigation and honest empty states; Android
  compiles and shows the Growth home.

### GROWTH-02 — Territories and regions
Milestone: G1 · Priority: P0 · Size: M · Depends on: GROWTH-01 · Branch: `feat/growth-territories` ·
**Migration: yes** · **Android: yes** (read-only "My territory")
Build. Table design, then migration: `growth_states` (seeded with the 36 ISO 3166-2:IN codes, source
cited), `growth_districts`, `growth_regions`, `growth_region_areas`, `growth_territory_assignments`.
LGD district CSV import (audited, dry run first). `growth-scope.ts` pure function with exhaustive tests.
Operations → Settings "Growth set-up". Growth → Territory page; Android "My territory".
Acceptance. One area in at most one live region; a whole-state and a district area of the same state
cannot be in different regions; visibility follows today's assignment; every assignment change is
audited with its reason.

### GROWTH-03 — Lead register, contacts and the contact notice
Milestone: G1 · Priority: P0 · Size: L · Depends on: GROWTH-02 · Branch: `feat/growth-leads` ·
**Migration: yes** · **Android: yes**
Build. Table design (leads, contacts, owner history, stage history), then migration. Create, claim,
reassign, do-not-contact, duplicate rules (§5.3), masked contacts and audited reveal, the leaver trigger
(§5.4), `docs/legal/growth-lead-contact-notice-DRAFT-for-legal-review.md` (DRAFT, HG-6 to publish).
Growth → Leads (list, detail, create) on web and Android.
Acceptance. A duplicate AISHE code or domain is refused without revealing another team's pipeline; a
removed contact keeps no name, email or phone (CHECK); a leaver's open leads become unowned in the same
transaction; a contact's `permission_basis` is required.

### GROWTH-04 — College pipeline and the operations handoff
Milestone: G2 · Priority: P0 · Size: M · Depends on: GROWTH-03, OPS-14; reads INST-18 when merged ·
Branch: `feat/growth-college-pipeline` · **Migration: yes** (handoff columns and history) ·
**Android: yes**
Build. Stage machine and history (§6.1); derived milestones read from `institution_accounts`,
`organization_verification_events`, `invitations`, `institution_relationships`,
`institution_data_terms_acceptances` (NA until INST-18 merges) and `institution_offboardings`; the
handoff request; Operations → Organizations handoff queue with link and decline; contacts carried into
OPS-14 and erased from the lead.
Do not. Create or verify an organisation from a growth route; store derived milestones.
Acceptance. Only an operator with `OPS_ORG_MANAGE` can link a handoff; derived milestones match their
source tables in a spec that changes each source; the student-activation count is suppressed below 5.

### GROWTH-05 — Employer pipeline, referral links and the EMP-04 handoff
Milestone: G2 · Priority: P0 · Size: M · Depends on: GROWTH-03, EMP-04, EMP-16, EMP-05, EMP-11 ·
Branch: `feat/growth-employer-pipeline` · **Migration: yes** · **Android: yes** (share my link)
Build. Employer stages and derived milestones (§7.1); `growth_referral_codes`,
`employer_access_request_referrals`; the public form accepts `ref` and still answers `202 { received:
true }` identically; the queue shows referral and lead matches.
Acceptance. A valid, revoked, unknown and malformed code produce byte-identical responses and the same
rate-limit behaviour; a referral row is deleted with its request under EMP-04 retention; growth sees job
and drive counts and states, never content or candidates.

### GROWTH-06 — Field work on the phone: visits, follow-ups, location, offline
Milestone: G2 · Priority: P0 · Size: L · Depends on: GROWTH-03 · Branch: `feat/growth-field` ·
**Migration: yes** (`growth_activities`, `growth_follow_ups`) · **Android: yes** (primary client)
Build. Visit, call, meeting and note logging; follow-ups with on-device reminders; optional location on a
tap (§14.3) with its first-run notice (draft); the offline write queue with idempotency keys and
Keystore encryption; refusal handling; sign-out clears cache and queue. Web: Field page.
Do not. Request background location; record location without a tap; drop a refused offline write
silently.
Acceptance. A write retried five times lands once; a report older than 7 days or in the future is
refused; location is stored at 3 decimal places; declining location permission leaves logging intact;
the app compiles and a manual run on a device or emulator logs a visit offline and syncs it.

### GROWTH-07 — Attribution, disputes, reassignment and leavers
Milestone: G2 · Priority: P0 · Size: M · Depends on: GROWTH-04, GROWTH-05 ·
Branch: `feat/growth-attribution` · **Migration: yes** · **Android: yes** (read-only: "Credited to you")
Build. Table design first (`growth_attributions`, `growth_attribution_disputes`); attribution written
at college handoff and at employer onboarding (§8.2–8.3); disputes with the 90-day window; admin
reassignment; the self-dealing guard on `OPS_VERIFY` (§8.6).
Acceptance. One live attribution per organisation (unique index); a conflicting referral and lead owner
writes no attribution and opens a dispute; a disputant cannot decide their own dispute; an operator
attributed to an employer cannot verify it.

### GROWTH-08 — Active-student qualification
Milestone: G3 · Priority: P0 · Size: M · Depends on: GROWTH-07, INST-01, ENG-03 ·
Branch: `feat/growth-active-students` · **Migration: yes** · **Android: no** (server rule; seen through
GROWTH-11's statement)
Build. Table design first (`growth_active_rule_versions`, `growth_student_refs`,
`growth_student_qualifications`); the §9 rule as SQL over `invitations`, `users`,
`institution_relationships`, `learner_activity_events` and `learning_attempt_events` in IST days; the
daily worker's evaluation step; privacy deletion severs `growth_student_refs` in its own transaction;
privacy-export-coverage row.
Acceptance. Specs at the edges: N−1 and N active days, activity on day 0 and day 31 (not counted), a
relationship ended on day 29, a deletion request on day 15, the same student at two colleges; a rule
change does not re-judge a closed window; no rule version → "Active-student rule not set".

### GROWTH-09 — Commission rates with full history and dual control
Milestone: G3 · Priority: P0 · Size: M · Depends on: GROWTH-01, OPS-02 · Branch:
`feat/growth-commission-rates` · **Migration: yes** · **Android: yes** (shows the rate in force for
my basis, or "Rate not set")
Build. Table design first; `growth_commission_rate_versions`; OPS-02 extended key
`GROWTH_COMMISSION_RATE_SET`; Operations → Settings "Commission rates" (history showing old → new, who,
when, why); backdating rule (§10.4).
Do not. Seed a rate; fall back to any default.
Acceptance. A rate is in force only after a different person approves it; every version shows the
version it superseded; with no rate the Growth portal and Android show "Rate not set" in the amount
slots; a backdated rate cannot touch a paid entry.

### GROWTH-10 — College payments received
Milestone: G3 · Priority: P0 · Size: M · Depends on: GROWTH-01, OPS-14, OPS-02 ·
Branch: `feat/institution-payments` · **Migration: yes** · **Android: no** (finance desk work; growth
staff see only "Waiting for the college's payment to clear")
Build. Table design first (`institution_payments`); record, clear (dual-controlled
`INSTITUTION_PAYMENT_CLEARANCE`), bounce, refund, void; the Organization Detail section; the self-dealing
guard.
Do not. Put an amount on `institution_accounts`; show a payment to a college, employer or growth person;
connect to any bank or payment service.
Acceptance. A payment row cannot change except by the listed transitions; clearance needs a second
person; no institution, employer, student or growth route returns an amount (a spec asserts it).

### GROWTH-11 — Commission ledger and statements
Milestone: G3 · Priority: P0 · Size: L · Depends on: GROWTH-08, GROWTH-09, GROWTH-10 ·
Branch: `feat/growth-commission-ledger` · **Migration: yes** · **Android: yes** (My commission)
Build. Table design first (`growth_commission_accruals`, `growth_commission_events`); the daily worker
(`run-growth-ledger-worker.ts`, registered with the OPS-04 jobs console): accrue, qualify, hold, value,
make payable, lapse, reverse (§10.2, §10.5); statements for the person, the manager and finance with
the §10.8 suppression; "why not payable" reasons.
Acceptance. Re-running the worker for a day changes nothing; every state change is an event row and the
accrual row never changes except its projected state; a bounced cheque returns payable entries to
eligible; an entry with no rate never gets an amount; no statement contains a student name, email,
roll number or `student_ref`; per-college counts below 5 are folded.

### GROWTH-12 — Payout batches and payroll export
Milestone: G3 · Priority: P1 · Size: M · Depends on: GROWTH-11 · Branch: `feat/growth-payouts` ·
**Migration: yes** · **Android: yes** (my entries show Paid with the date)
Build. `growth_payout_batches`; prepare, approve (`GROWTH_COMMISSION_PAYOUT`), mark paid with a payout
reference; CSV export through the INST-08 writer rules, audited before send; clawback path only if O-6
is decided yes.
Acceptance. An entry with NA cannot enter a batch; a batch is paid only with a second person's approval;
the CSV reproduces the batch exactly and contains no student data; nobody can approve a batch containing
their own entries.

### GROWTH-13 — Targets and progress
Milestone: G4 · Priority: P1 · Size: M · Depends on: GROWTH-06, GROWTH-07; STUDENTS_QUALIFIED needs
GROWTH-08 · Branch: `feat/growth-targets` · **Migration: yes** · **Android: yes**
Build. `growth_targets`; admin sets, manager proposes; progress from the §12 sources only; NA for a
metric whose source is not built.
Acceptance. A superseded target stays visible in history; progress for every metric is reproduced by a
spec from seeded rows; a metric with no source shows NA, not 0.

### GROWTH-14 — Growth dashboards (executive, manager) and the Operations growth analytics
Milestone: G4 · Priority: P1 · Size: M · Depends on: GROWTH-11, GROWTH-13 ·
Branch: `feat/growth-dashboards` · **Migration: no** · **Android: yes**
Build. Pilot-composition Home for executives and managers (web and Android); Operations → Analytics
growth section; regional roll-ups with the suppression rules of OPS-14 (no totals of people across
organisations that would let a suppressed cell be recovered).
Acceptance. Every widget has a real source or shows NA/0 in its slot; no widget is dropped; person counts
below 5 show `<5`; no invented figure appears in any state, including an empty database.

### GROWTH-15 — Lead privacy: retention, rights requests and location erasure
Milestone: G4 · Priority: P0 · Size: M · Depends on: GROWTH-03, GROWTH-06, OPS-06 ·
Branch: `feat/growth-privacy` · **Migration: maybe** (only if a sweep needs a marker column) ·
**Android: no** (server jobs; the app already clears data on sign-out)
Build. Daily sweeps in the privacy worker: contacts of LOST or inactive leads (§13.4), visit notes by
the same rule, location older than 180 days; the Privacy console lookup of a lead contact by email or
phone; the growth person's own data in their privacy export.
Acceptance. A sweep erases exactly the rows past their period and is idempotent; a contact under a
do-not-contact request cannot be re-added; the lookup is audited and returns leads only to a
`PRIVACY_REQUESTS` holder.

### GROWTH-16 — Growth SOPs, UAT scripts and security review
Milestone: G4 · Priority: P0 · Size: M · Depends on: the goals it documents · Branch:
`docs/growth-sops-uat` · **Migration: no** · **Android: yes** (UAT on a device)
Build. SOPs: growth team set-up, lead handling and the contact notice, handoffs, disputes, payments,
rates, payouts. UAT journeys for executive (phone, offline visit), manager, growth admin, finance and
approver. Security review of the portal against §15, including an OPS-15 campaign with growth staff in
it and the self-dealing guard.
Acceptance. Every journey is run on seeded data only and its result recorded; every finding is fixed or
recorded with an owner (Divakar) and a date.

### Dependency graph

```
GROWTH-01 ─> 02 ─> 03 ─┬─> 04 ─┐
                       ├─> 05 ─┼─> 07 ─> 08 ─┐
                       └─> 06 ─┘             ├─> 11 ─> 12
            01 ─> 09 ────────────────────────┤
            01 ─> 10 ────────────────────────┘
            06, 07 (+08) ─> 13 ─> 14 (+11)
            03, 06 ─> 15
            all ─> 16
```

GROWTH-09 and GROWTH-10 can run in parallel with G2. The first money can move only after GROWTH-12 and
Divakar's rates (O-25).

---

## 19. What this design deliberately does not do

- It does not build billing, invoicing or pricing, and ADR-022 is not reopened.
- It does not pay anyone or connect to a bank, payroll system or payment provider.
- It does not give growth staff any view of students, applications, readiness or college records.
- It does not let growth staff verify, approve, onboard or suspend anything.
- It does not track staff location continuously or in the background.
- It does not seed a rate, a threshold, a region or a lead.
- It does not use any model.
