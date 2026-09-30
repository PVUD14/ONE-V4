# ADR-040 — Growth (Marketing and Partnerships) Is Its Own Portal Inside ONE

> What this is: the decision record for a portal Divakar approved on 2026-09-30, outside the
> 88-step program plan. Why it exists: the portal adds a new role family, new navigation (HG-3),
> money-bearing records and a new kind of personal data (leads), and each of those needs its
> reasoning written down before anything is built. The full design is
> `docs/architecture/growth-portal-design.md`.

**Status:** Accepted (Divakar, 2026-09-30). Rates, thresholds and the items listed under "Open
decisions" are not decided; see the design document §17.
**Decision date:** 2026-09-30
**Scope:** How AI8HT's college-partnerships and employer-partnerships field teams work inside ONE,
how they are credited, and how their commission is recorded
**Builds on:** ADR-018 (role model), ADR-022 (billing deferred), ADR-025 (staff pool, MFA),
ADR-032 (internal capabilities), OPS-02 dual control (`high-risk-approvals-table-design.md`),
OPS-14 (`institution-accounts-table-design.md`), OPS-15 (`access-review-campaigns-table-design.md`)
**Does not supersede** any ADR. It narrows one line of the OPS-14 design; see "Consequences".

## Context

ONE gets colleges and employers onto the platform in one way today: an operator creates the
organisation (`POST /operations/organizations`,
`apps/api/src/http/operations-institution-onboarding.controller.ts`), verifies it
(`OPS_VERIFY`, `organization_verification_events`, 0005) and invites its first administrator.
Employers can also raise their hand through the public access-request form (EMP-04,
`employer_access_requests`, 0041). Everything before that point — finding the college, meeting its
management, getting the agreement signed, persuading a company to register and post jobs — happens
outside ONE, in phones, notebooks and spreadsheets, and leaves no record.

The internal operating model already names this work. `INTERNAL_BUSINESS_OPERATING_MODEL_V1.md` §6
describes Sales / Business Development ("Lead → Qualified → Demo → Pilot → Proposal → Negotiation →
Contract → Onboarding → Active → Renewal", "Sales access must not include student academic,
readiness, AI-conversation, application, or applicant data"), and `INTERNAL_ROLE_PRIVILEGE_MATRIX_V1.md`
lists `SALES_ADMIN`, `SALES_REP` and `FINANCE_ADMIN` bundles. None of it is built.

On 2026-09-30 Divakar decided the following. They are recorded verbatim as decisions:

1. **Option B:** a "Growth" (marketing/partnerships) portal inside ONE — its own role family,
   login area and navigation. **HG-3 (new navigation items) is APPROVED for this portal.**
2. **Two teams:** (1) college partnerships — connect with college management and get the agreement
   signed so students can be onboarded; (2) employer partnerships — meet companies so they register
   and post job openings.
3. Teams work **by region / geo-locations in India** (territories).
4. Track **both targets and commissions**.
5. Field work is done on **phones** → the Android app must support field staff (Android parity rule).
6. **Commission basis:** per **ACTIVE STUDENT** (from colleges the person brought in) and per
   **EMPLOYER VERIFIED** (employers the person brought in).
7. **Rates: NOT decided yet** — operations must be able to set and change rates at any time;
   **every change must be recorded and logged** (who, when, old → new, reason). Until a rate is set,
   commission shows **"rate not set" (NA)** — never an invented number.
8. Commission becomes **payable only when** (a) the student has been **ACTIVE for 30 days**, and
   (b) the **college's payment (cheque) to AI8HT has CLEARED** — recorded by operations/finance in ONE.

## Options considered

### Option A — A "Growth" module inside the Operations portal, as capabilities

Growth staff would be `OPERATIONS_ADMIN` memberships with a narrow capability grant (ADR-032's
pattern: "a narrower permission is a capability, not a role"), and leads would be sections of the
existing Organizations and Analytics screens.

Rejected, for three reasons that ADR-032's own reasoning does not cover:

- **An Operations membership is the wrong starting point for field staff.** `OPERATIONS_ADMIN`'s
  baseline bundle (`packages/authorization/src/internal-capabilities.ts`) includes `OPS_VERIFY`,
  `PRIVACY_HOLDS`, `TRUST_SAFETY_ENFORCE`, `SUPPORT_ACCOUNT_LOOKUP` and fifteen others. A growth
  executive would have to be given the role and then have all of that *withheld*, which the
  capability model cannot express: baselines are fixed per role, and grants only add. The person who
  gets a college signed must never be able to verify that college (see "Separation of duties").
- **ADR-032 rejected new roles because each role multiplies portals and screens for bundles that
  share one console.** Growth is the opposite case: a different job, done on a phone, with its own
  screens (pipeline, visits, territory, targets, commission) and none of the Operations screens.
  It is exactly the situation in which ADR-018 says a role *is* warranted.
- **Operations navigation would change** (HG-3), for every operator, to serve people who are not
  operators.

### Option B — A Growth portal with its own role family, login area and navigation (chosen)

Two new login roles in the ONE platform organisation, `GROWTH_EXECUTIVE` and `GROWTH_MANAGER`, a
`/growth` workspace on web and a Growth workspace on Android, with navigation of its own. The roles
carry **no internal capability at all**; everything they may do is decided by growth-specific
rules (own leads, own territory, own team). The Operations and finance side of growth — territories,
rates, college payments, payouts — stays with operators and is expressed as two new internal
capabilities (`GROWTH_ADMIN`, `GROWTH_FINANCE`) on the existing platform roles, exactly as ADR-032
intends.

### Option C — Keep the field work in an external CRM; record only commission in ONE

A SaaS CRM (or a spreadsheet) for leads and visits, with ONE holding only attribution and
commission.

Rejected:

- **Commission must be computed from events ONE already records** — student activation
  (`invitations.accepted_at`, 0037), learning activity (`learner_activity_events`, 0015;
  `learning_attempt_events`, 0047), employer verification (`organization_verification_events`,
  0005) — and the link between "the lead this person worked" and "the organisation that went live"
  would then cross two systems with no shared identifier. That link is the thing a dispute is about.
- **A second system holding personal data** of college principals and company HR contacts, on staff
  phones, with its own access model, its own retention and its own breach surface — outside the
  access reviews (OPS-15), audit trail and privacy tooling ONE already has.
- **It does not remove the Android work.** Divakar's decision 5 and the Android parity rule put field
  staff on the ONE app.

## Decision

**Option B.** Specifically:

1. **Roles.** `GROWTH_EXECUTIVE` (field staff) and `GROWTH_MANAGER` (regional manager; a national
   head is a manager whose regions cover India) join the platform branch of the membership scope
   trigger (`enforce_organization_membership_scope`, 0001) by a new migration that redefines the
   function with every existing rule repeated unchanged — the way 0037 redefined
   `enforce_invitation_scope` for student invitations. The team a person works in (college partnerships,
   employer partnerships, or both) is data on a growth table, not a role.
2. **Growth roles hold no internal capability and cannot be granted one.** `baselineInternalCapabilities`
   returns nothing for them and `isInternalCapabilityGrantableToRole` refuses them, so no route guarded
   by `requireOperations` can ever admit them. The capability trigger (0039) already refuses grants
   to roles outside its platform list; the new migration keeps it that way.
3. **Operator side as capabilities.** `GROWTH_ADMIN` (regions, territory assignments, team
   membership, targets, attribution disputes) and `GROWTH_FINANCE` (college payments, commission
   rates, payouts) are added to the internal vocabulary, baseline for `PLATFORM_SUPER_ADMIN` only and
   grantable to `OPERATIONS_ADMIN`. Where money moves, OPS-02 dual control applies.
4. **Growth work never reaches student data.** Growth staff see organisations, milestones derived
   from existing tables, and suppressed counts. They never see a student's name, email, roll number,
   record, readiness or application, and commission records reference students only through a
   pseudonymous reference that is severed when the student is erased.
5. **Commission is a ledger, not a calculation on read.** Append-only accruals move through
   ACCRUED → ELIGIBLE → PAYABLE → PAID (or LAPSED / reversal), each move a row with who or what caused
   it. Amounts come only from a versioned rate table set by operations; with no rate, the amount is
   NA and nothing can be paid.
6. **College payments are recorded, not processed.** ONE records that a cheque or transfer was
   received, cleared or bounced, by whom and when. It moves no money and connects to no bank or
   payment provider.
7. **Handoffs, not duplicates.** Growth pipelines end where the existing flows begin — operations
   onboarding and verification, OPS-14 account fields, INST-18 data terms, EMP-04 access requests,
   EMP-16 employer terms, EMP-05 job publishing, EMP-11 campus drives. Stages after the handoff are
   read from those tables and cannot be set by a growth person.

## Separation of duties

- A growth person cannot create, verify, suspend or approve an organisation, cannot accept terms on
  a college's or employer's behalf, and cannot set a rate, record a payment or mark a payout.
- An operator acting on an organisation attributed to themselves — verifying it, recording its
  payment, or approving their own commission's rate or payout — is refused. This is checked on the
  person (user id), across memberships, so holding both a growth and an operations membership does
  not help.
- Growth memberships are platform memberships, so OPS-15 access reviews snapshot them with no change
  (`packages/persistence/src/access-reviews.ts` selects every ACTIVE membership of the `PLATFORM`
  organisation).

## Rejected details

- **A new organisation kind (`GROWTH`) for growth staff.** Growth staff are AI8HT employees. A
  separate organisation would drop them from the staff list and the access review, and needs an enum
  value and a second set of scope rules for no gain.
- **Adding growth people as OPS-14 account owners.** `institution_accounts.account_owner_membership_id`
  is restricted by trigger to the three internal roles and means "who looks after this college now".
  Attribution means "who brought it in". They are different facts with different lifetimes and stay
  in different tables.
- **Commission computed on the fly from current state.** It would change when a student is erased,
  a rate is edited or a college leaves, and could not show what was paid and why. Rejected in favour
  of the ledger.
- **Storing a rate "for later" or a default rate.** Decision 7: no rate means NA. No migration seeds a
  rate, and no code has a fallback.
- **Model-based lead scoring or visit summarisation.** The AI hold (ADR-030) applies. Nothing in this
  portal calls a model.
- **Continuous location tracking of field staff.** Location is captured only when the person taps to
  attach it to a visit they are logging, in the foreground, and is never collected in the background.

## Consequences

- **Navigation.** The Growth portal's navigation is new and approved (HG-3, 2026-09-30). The approval
  covers the Growth portal only. Operator-side screens are sections of existing Operations screens.
  An Operations navigation item for growth would need its own HG-3 approval (design §17).
- **Staff identity.** `GROWTH_EXECUTIVE` and `GROWTH_MANAGER` join the staff-only roles of the staff
  pool policy (`apps/api/src/runtime-auth.ts`, which today passes `platformInternalRoles`), so once the
  MFA-required pool exists (ADR-025, HG-1/HG-7) growth staff sign in through it like every operator.
- **Places that treat any platform membership as an operator must be narrowed first.** Approval
  notifications (`packages/persistence/src/operation-approvals.ts`) and job-health alerts
  (`packages/persistence/src/jobs-health.ts`) select *every* ACTIVE membership of the platform
  organisation as recipients. Without a fix, growth staff would receive operator alerts. GROWTH-01
  narrows them to the internal roles before any growth membership can exist.
- **The OPS-14 "no amount anywhere" line is narrowed, not reversed.** `institution-accounts-table-design.md`
  says "No amount, price, seat count or payment term is stored anywhere", as a consequence of ADR-022.
  Decision 8 needs a record of money a college has actually paid (reference, amount, date, cleared or
  bounced). That record lives in its own finance table, never on `institution_accounts`, is never
  served to a college, an employer or a growth person, and holds amounts received — not prices, plans,
  seats, invoices or entitlements. ADR-022 stands: billing, pricing and entitlements are still not
  built, and nothing in ONE is gated on a payment except commission payability. ADR-022's warning
  also stands in reverse: the absence of a payment row does not mean a college has not paid; it means
  nobody recorded it.
- **Lead contacts are new personal data.** They get their own purpose, notice (a draft for legal
  review; publishing it is HG-6), retention and erasure (design §13).
- **Rates, thresholds and several policies are Divakar's to decide.** The design lists each with a
  recommendation. Until he decides, the screens show NA and "not decided", and nothing is paid.
