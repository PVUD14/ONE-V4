# Growth College Pipeline and the Operations Handoff — Table Design

**Status:** Adopted (GROWTH-04), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** `0104_growth_college_pipeline.sql` (new; no existing migration is edited; no function an earlier
migration defined is redefined — the pipeline rules are a second trigger on `growth_leads` beside GROWTH-03's guard,
and no capability CHECK, grant trigger or scope trigger is touched)
**Parent design:** `growth-portal-design.md` §6 (college pipeline, the agreement, the handoff), §13.4 (contacts at
handoff), §18 GROWTH-04; `growth-leads-table-design.md` (GROWTH-03: leads, stage history, contacts);
`institution-accounts-table-design.md` (OPS-14: account fields and contacts); `institution-contract-lifecycle-design.md`
(INST-18: data terms and the college exit, merged)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

The handoff is the moment a salesperson's lead becomes AI8HT's customer. Three things make it consequential:

1. **Nothing in growth may create, verify or onboard an organisation** (design §15). The handoff must therefore be a
   *request* that an operator completes with the unchanged Operations routes, and the database must refuse any lead
   that claims an organisation without that completed request.
2. **Credit is decided here.** Attribution (GROWTH-07) credits the lead's owner *at the moment operations links the
   handoff* (§8.2). That owner must be recorded at link time, in the same transaction, or it cannot be reconstructed.
3. **Personal data moves.** The contacts the owner marks for handover become the college's account contacts (OPS-14),
   and the lead's copies must go, so the same person is not held twice (§6.3 step 4, §13.4).

## 1. Stages a growth person sets (design §6.1)

`IDENTIFIED → CONTACTED → MEETING_SCHEDULED → MET → PROPOSAL_SHARED → NEGOTIATION → AGREEMENT_SIGNED_REPORTED →
HANDOFF_REQUESTED`, plus `ON_HOLD` and `LOST`. The stage column and its per-kind CHECK already exist (0100); every move
writes `growth_lead_stage_history` (0100, append-only).

| Move | Rule |
|---|---|
| Forward among the working stages, skipping allowed | Free (a first meeting may go straight to `MET`) |
| Backward among the working stages | Needs a reason: `MEETING_CANCELLED`, `PROPOSAL_REVISED`, `CORRECTION` |
| To `AGREEMENT_SIGNED_REPORTED` | From `NEGOTIATION` or earlier working stage; the person *reports*, operations confirms (§6.2) |
| To `HANDOFF_REQUESTED` | Only through the handoff request route, from `AGREEMENT_SIGNED_REPORTED` (§3) |
| Out of `HANDOFF_REQUESTED` | Only by an operator's decline (back to `NEGOTIATION`); a linked lead stays there for ever |
| To `ON_HOLD` | From any working stage, reason `ORGANISATION_PAUSED`, `BUDGET_CYCLE`, `LEADERSHIP_CHANGE`, `OTHER` |
| Resume from `ON_HOLD` | Back to the stage it held before (read from the stage history, not stored twice) |
| To `LOST` | From any working stage or `ON_HOLD`, with a lost reason (`NO_BUDGET`, `CHOSE_COMPETITOR`, `NOT_DECISION_MAKER`, `NO_RESPONSE`, `NOT_ELIGIBLE`, `DUPLICATE`, `OTHER`, already CHECKed by 0100). Terminal |

Who moves a stage: the owner, or a manager who could reassign the lead (GROWTH-03's rule). A do-not-contact lead may only
be moved to `LOST`. Employer leads use the same route for their own working stages (`INTERESTED`,
`ACCESS_REQUEST_INVITED`, `ON_HOLD`, `LOST`); their derived milestones and handoff are GROWTH-05's.

**Offline safety.** A move carries `fromStage` (the stage the person saw). If the lead has moved since, the server
answers `409 GROWTH_STAGE_CHANGED` instead of applying an out-of-date move — the phone's queue shows that refusal. Moves
accept an `Idempotency-Key` (GROWTH-06's helper) so a resend lands once.

**Database rule (new trigger `growth_lead_pipeline_guard`, BEFORE UPDATE on `growth_leads`):** a `LOST` lead's stage
never changes; a handed-off lead's (organisation set) stage never changes; `HANDOFF_REQUESTED` can be entered only while
an open handoff request exists and left only when none is open; a college lead's organisation can be set only to the
`INSTITUTION` organisation of a `LINKED` handoff request for that lead.

## 2. Derived milestones (design §6.1) — computed on read, never stored

Shown only for a lead with an organisation (after the link). Each is read from the source table that already holds it,
so it cannot disagree with it. Growth sees whether and when, never content.

| Milestone | Read from | Shown |
|---|---|---|
| `HANDED_OFF` | `growth_handoff_requests` `LINKED` | reached, the link time |
| `CONTRACT_RECORDED` | `institution_accounts.contract_reference IS NOT NULL` (0078) | reached or not (the reference itself is not shown to growth) |
| `VERIFIED` | `organizations.verification_state = 'VERIFIED'`; the first `organization_verification_events` row to `VERIFIED` (0005) | reached, first-verified time |
| `ADMIN_JOINED` | the first `invitations` row for the college with role `INSTITUTION_ADMIN`, `ACCEPTED` (0001) | reached, accepted time |
| `DATA_TERMS_ACCEPTED` | INST-18's terms status (0088): `ACCEPTED`, `ACCEPTANCE_REQUIRED`, or `NA` when no terms are published | reached or not, the latest acceptance time; **NA** with no terms |
| `FIRST_ROSTER` | the first `institution_relationships` row of a student the college rostered (an `institution_student_profiles` row exists for that student and college) | reached, time |
| `STUDENTS_ACTIVATING` | count of `invitations` of kind `STUDENT` for the college, `ACCEPTED` (0037), through `suppressSmallCount` | `<5` or the count — never a list, never a name |
| `FIRST_PAYMENT_CLEARED` | `institution_payments` (GROWTH-10) | **NA** until GROWTH-10 exists: no source, no figure |
| `EXITED` | `institution_offboardings` in `ENDED` or `PURGED` (0088) | reached, time |

## 3. `growth_handoff_requests`

| Column | Rule |
|---|---|
| `id` | uuid |
| `lead_id` | → `growth_leads`; a `COLLEGE` lead (trigger) |
| `requested_by_user_id`, `requested_by_membership_id` | the owner (or their manager) who asked |
| `requested_at` | `now()` |
| `contract_reference_reported` | **required**; the reference the college gave the salesperson, the same shape as OPS-14's `contract_reference` (`^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,63}$`). It cannot hold an amount, a name or free text. Operations confirms it by recording it on the account (§6.2); only that confirmation counts |
| `state` | `REQUESTED` → `LINKED` or `DECLINED`, once |
| `decided_by_user_id`, `decided_at` | set together on leaving `REQUESTED` (`now()`) |
| `decline_reason_code` | `DECLINED` only: `NOT_A_REAL_COLLEGE`, `DUPLICATE_OF_EXISTING`, `INCOMPLETE`, `CONTRACT_NOT_CONFIRMED` |
| `organization_id` | `LINKED` only: an `INSTITUTION` organisation; unique among linked requests |
| `owner_membership_id_at_link`, `owner_user_id_at_link` | `LINKED` only: **the lead's owner at the moment of the link** (may be NULL when the lead had no owner). This is the fact GROWTH-07's attribution is written from (`LEAD_OWNER_AT_HANDOFF`, §8.2); GROWTH-04 records it, GROWTH-07 builds the attribution table |
| `contacts_carried`, `contacts_erased` | `LINKED` only: how many contacts went to the account, and how many lead copies were erased |

Partial unique indexes: one `REQUESTED` per lead; one `LINKED` per lead; one `LINKED` per organisation.
Guard trigger: DELETE refused; created `REQUESTED` on an open, contactable college lead with no organisation; only the
`REQUESTED → LINKED | DECLINED` change, once; every other column fixed.

## 4. `growth_handoff_request_contacts`

`(request_id, contact_id)` primary key — the contacts the owner marked for handover. Insert-only, while the request is
`REQUESTED`, for a live contact of the same lead (trigger). No update, no delete. It holds no personal data itself.

## 5. The link and the decline (design §6.3)

**Who:** an operator holding `OPS_ORG_MANAGE` (`POST /api/v1/operations/growth-handoffs/:leadId/link` and `/decline`).
The operator first creates the college through the unchanged `POST /operations/organizations` (state `PENDING`).

**Link, in one transaction:**
1. lock the request and the lead; the request must be `REQUESTED`, the organisation an `INSTITUTION`, not linked to
   another lead;
2. the request becomes `LINKED` with the organisation, the operator, and the lead's current owner;
3. the lead's `organization_id` is set (the pipeline trigger accepts it only now);
4. **contacts:** each marked, still-live contact is copied into OPS-14's `institution_account_contacts` with reason
   `ONBOARDING` (the account row is created empty if missing; role mapped: `PRINCIPAL` and `PLACEMENT_OFFICER` keep
   theirs, every other lead role becomes `OTHER`), up to OPS-14's limit of live contacts; then **every** live lead
   contact is erased with `HANDED_OVER` — marked ones because they now live on the account, unmarked ones because a
   handed-off lead is excluded from the 24-month sweep and would otherwise be kept for ever;
5. audit rows (`operations.growth_handoff.linked`, and OPS-14's `contact_added` per carried contact) and the outbox
   event `growth.lead.handed_off`.

No organisation is created, verified or changed by the link, no account field other than contacts is written, and the
account owner (OPS-14) is untouched: the growth person is the attribution, not the account owner.

**Decline:** the request becomes `DECLINED` with its reason; the lead goes back to `NEGOTIATION` with a stage-history row
carrying the reason; audit and outbox `growth.handoff.declined`. The owner can ask again later.

**Visibility:** the queue shows lead name, area, AISHE code, the reported contract reference, the requester, and the
marked contacts **masked** (role and masked email/phone). Full values never reach the operator through this queue; they
move server-side into the account, where OPS-14's audited reveal applies.

## Rejected

- **Letting growth create the organisation** (a "convert" button). Design §15 forbids any growth route writing
  `organizations`; the request keeps onboarding where it is controlled.
- **Storing derived milestones on the lead.** They would drift from their sources; §6.1 says computed on read.
- **Writing `growth_attributions` here.** It is GROWTH-07's table with its own design; recording the owner at link is
  enough to write it later without guessing.
- **Keeping unmarked contacts on a handed-off lead.** Nothing would ever erase them.
- **A stored "stage before hold" column.** The stage history already says it.

## Decisions taken for Divakar (recommended, built)

- Forward stage moves are free (skips allowed); backward moves need a reason.
- A handoff request needs the stage `AGREEMENT_SIGNED_REPORTED` and a reported contract reference.
- At link every lead contact is erased; only the marked ones are carried, with role mapping to OPS-14's roles and
  OPS-14's live-contact limit (extras are erased, not carried, and the count is reported).
- Carried contacts are recorded with the reason `ONBOARDING`, written only by the link (it is not offered in OPS-14's manual contact form, whose reasons are unchanged).
- `DATA_TERMS_ACCEPTED` reads NA while no terms version is published; `FIRST_PAYMENT_CLEARED` reads NA until GROWTH-10.
- A request cannot be withdrawn by the requester (an operator declines it); a declined lead returns to `NEGOTIATION`.
