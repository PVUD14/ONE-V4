# College Payments Received — Table Design

**Status:** Adopted (GROWTH-10), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-02
**Migration:** `0111_institution_payments.sql` (new; no existing migration is edited). It redefines one function an
earlier migration defined — `operation_approval_extended_target_type()` (0051, last redefined by 0089) — repeating every
earlier extended key and adding one. No capability CHECK, grant trigger or scope trigger is touched.
**Parent design:** `growth-portal-design.md` §6.1 (`FIRST_PAYMENT_CLEARED`), §8.6 (self-dealing), §11 (college payments),
§15 (dual control), §18 GROWTH-10; `ADR-040-growth-portal.md` ("Decisions taken 2026-09-30", D9, D10);
`institution-accounts-table-design.md` (OPS-14); `high-risk-approvals-table-design.md` (OPS-02);
`ADR-022-billing-deferred-until-after-the-pilot.md`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Divakar decided on 2026-09-30 that an "active student" is one the college's management has paid for (D9), and that
"every commission will start only after the college payment cheque is cleared" (D10). Nothing in ONE records a college
payment today: billing is deferred (ADR-022), pilot colleges are invoiced outside the product, and OPS-14 deliberately
stores no amount anywhere. Commission (GROWTH-08, -11) therefore has no honest trigger until finance can write down
that a college paid, how much, for how many students and when the money cleared.

Three things make the record consequential:

1. **It starts money moving.** Clearance is the event every later commission accrues from. A clearance typed by one
   person, or by the person who earns from it, is the cheapest fraud in the whole portal. Clearance is therefore
   dual-controlled (OPS-02) and refused to anyone credited with the college.
2. **It must never be rewritten.** A commission dispute months later is answered from this table. A row that can be
   edited cannot answer it. Every row is append-only; the only changes are the listed state transitions, each with its
   own date, actor and reason, set once. A mistake is corrected by voiding the row and recording a new one that names
   the row it replaces.
3. **It is commercial data that must not leak.** Amounts, cheque numbers and student counts belong to AI8HT's finance
   and account staff. No college, employer, student or growth route returns them; growth sees only whether a first
   payment has cleared.

ONE records payments; it does not take, make or reconcile them. It connects to no bank and no payment service.

## Decision: one `institution_payments` table with state columns set once

**Chosen.** One row per payment received, named for what it records (finance may later need it for other purposes; it
is still not billing). The row carries its whole life: received, then cleared or bounced, then (if cleared) refunded,
or voided from any live state. Each transition's columns are NULL until it happens and are set together, once.

**Rejected: a separate append-only events table with the state as its latest row.** The ledger (GROWTH-11) needs an
events table because an accrual moves many times. A payment moves at most twice, each transition has different facts
(a cleared date and an approval; a bounce reason; a refund date), and a fixed set of set-once columns is checked by a
CHECK constraint, which an events table could only check by trigger. The audit trail is still complete: every
transition writes its own `audit_events` row and outbox event.

**Rejected: columns on `institution_accounts`.** Forbidden by the goal ("do not put an amount on `institution_accounts`")
and by ADR-040: OPS-14's account row is read with `ACCOUNT_MANAGE` for renewal work and its design promises "no amount".
A college pays many times; a payment is not an attribute of the account.

**Rejected: storing a list of the students a payment covers.** Which students a payment covers is GROWTH-08's
allocation (design §11.3, O-26), by a fixed rule over the roster, recorded in its own table. This table holds only the
count the college's payment letter states. Finance never types or uploads a student list.

## `institution_payments`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `institution_id` | uuid → `organizations(id)` | The trigger requires `kind = 'INSTITUTION'` |
| `instrument` | text | `CHEQUE`, `DEMAND_DRAFT`, `BANK_TRANSFER` (NEFT/RTGS/IMPS), `UPI` |
| `instrument_reference` | text | The cheque or DD number, or the UTR: `^[A-Za-z0-9/-]{4,40}$`. The screen says never to type a bank account number |
| `amount_paise` | bigint | `> 0` and `≤ 100 000 000 000` paise (₹100 crore, a sanity bound, not a business rule). Integer paise: no floating point anywhere, in the database, the API or the screen |
| `currency` | text | `'INR'` only (CHECK). There is no foreign-currency college today; another currency would be its own design |
| `students_paid` | integer | `> 0` and `≤ 100 000` — how many students the college is paying for with this payment, as its payment letter states. A count, never a list |
| `received_on` | date | The date AI8HT received it. Not in the future (IST, database clock), not before 2020-01-01 |
| `covers_from`, `covers_to` | date | The period the payment is for (for example an academic year). `covers_to ≥ covers_from`, at most 3 years apart |
| `state` | text | `RECEIVED`, `CLEARED`, `BOUNCED`, `REFUNDED`, `VOIDED` |
| `record_reason_code` | text | `PAYMENT_RECEIVED`, or `CORRECTION` when the row replaces a voided one |
| `replaces_payment_id` | uuid NULL → `institution_payments(id)` | Set exactly when the reason is `CORRECTION`: a `VOIDED` payment of the same college; at most one live replacement per voided row |
| `note` | text NULL | ≤ 500. The screen warns not to put personal data in it |
| `recorded_by_user_id`, `recorded_at` | | The `GROWTH_FINANCE` holder; `now()` |
| `cleared_on`, `cleared_at`, `cleared_recorded_by_user_id`, `clearance_approval_id` | NULL until cleared | Set together, once. `cleared_on ≥ received_on`, not in the future. The approval is an executed `INSTITUTION_PAYMENT_CLEARANCE` for this payment |
| `bounced_on`, `bounced_at`, `bounced_recorded_by_user_id`, `bounce_reason_code` | NULL until bounced | Set together, once. `bounced_on ≥ received_on`, not in the future. Reasons `INSUFFICIENT_FUNDS`, `SIGNATURE_MISMATCH`, `STOPPED`, `STALE`, `OTHER` |
| `refunded_on`, `refunded_at`, `refunded_recorded_by_user_id`, `refund_reason_code` | NULL until refunded | Set together, once; only after clearance. `refunded_on ≥ cleared_on`, not in the future. Reasons `OVERPAYMENT`, `DUPLICATE_PAYMENT`, `COLLEGE_EXITED`, `COMMERCIAL_SETTLEMENT`, `OTHER` |
| `voided_at`, `voided_by_user_id`, `void_reason_code` | NULL until voided | Set together, once. Reasons `ENTERED_IN_ERROR`, `DUPLICATE_ENTRY`, `WRONG_COLLEGE`, `WRONG_DETAILS` |
| `correlation_id` | text | 1–128 |

Every `*_at` and `recorded_at` is stamped by the trigger with `now()`; Node never stamps a time. The business dates
(`received_on`, `cleared_on`, …) are what the bank or the payment letter says, entered by finance, and checked against
the database's own date in India (`(now() AT TIME ZONE 'Asia/Kolkata')::date`).

### State machine

```
RECEIVED ──(dual-controlled clearance)──> CLEARED ──> REFUNDED
    │                                         │            │
    ├──> BOUNCED                              │            │
    └──────────────> VOIDED <─────────────────┴────────────┘   (and BOUNCED ──> VOIDED)
```

| From → to | Who | Control |
|---|---|---|
| (insert) `RECEIVED` | `GROWTH_FINANCE` | Single person, reason-coded; refused to anyone credited with the college |
| `RECEIVED → CLEARED` | `GROWTH_FINANCE` who requested the approval | OPS-02 `INSTITUTION_PAYMENT_CLEARANCE`, approved by an `APPROVE_HIGH_RISK` holder who is not the requester (the existing solo safeguard applies while AI8HT has one approver) and not credited with the college |
| `RECEIVED → BOUNCED` | `GROWTH_FINANCE` | Single person: a bounce only ever takes commission away (§11.2) |
| `CLEARED → REFUNDED` | `GROWTH_FINANCE` | Single person, for the same reason |
| `RECEIVED`, `CLEARED`, `BOUNCED`, `REFUNDED → VOIDED` | `GROWTH_FINANCE` | Single person, for the same reason. "Entered in error": the row never described real money |

Nothing else changes. The trigger refuses every other update, any change to a column outside the transition's own set,
a second change to a set-once column, and `DELETE` and `TRUNCATE`.

**Why a void is allowed from every live state.** A cheque recorded against the wrong college is still the wrong
college after it clears. Refusing the void would leave a false row that commission later reads. The void keeps every
earlier column (a voided row still shows that it was cleared, when and with which approval), so nothing is lost; the
ledger (GROWTH-11) lapses any unpaid accrual of a voided payment, as design §10.5 says.

### Indexes

- `(institution_id, received_on DESC, id DESC)` for the college's list.
- Unique `(institution_id, instrument, upper(instrument_reference))` among `RECEIVED`, `CLEARED` and `REFUNDED` rows:
  the same cheque recorded twice is refused (`409`). A bounced cheque presented again is a new row, so `BOUNCED` and
  `VOIDED` rows are outside the index.
- Unique `replaces_payment_id` where not NULL: one correction per voided row.
- `(institution_id) WHERE state = 'CLEARED'` for the "first payment cleared" read and GROWTH-08's allocation.

## Dual control: `INSTITUTION_PAYMENT_CLEARANCE` (OPS-02 extended key)

- Added to `highRiskActionKeys`, its capability `GROWTH_FINANCE`, its target type `institution_payment`, through 0051's
  extension mechanism (`extended_action_key`); 0111 redefines `operation_approval_extended_target_type()` with every
  earlier key repeated (0051, 0057, 0061, 0065, 0081, 0088, 0089) and the new one added.
- **What the approval is bound to:** `{ paymentId, amountPaise, studentsPaid, clearedOn, reasonCode }`. The request
  names the payment and the cleared date; the server reads the amount and the count from the row, so the approver sees
  and approves exactly what will clear. The payment row cannot change while the approval waits (immutable), and the
  execution rebuilds the same payload from the row and the request, so any difference is `APPROVAL_PAYLOAD_MISMATCH`.
- **Request reasons:** `BANK_STATEMENT_CONFIRMED`, `BANK_ADVICE_RECEIVED`.
- **Request preconditions:** the payment is `RECEIVED`; the cleared date is on or after `received_on` and not in the
  future; the requester is not credited with the college.
- **Approval:** OPS-02's rules unchanged (never the requester, except the sole approver after the cooling-off), plus:
  an approver credited with the college is refused (`APPROVAL_SUBJECT_CONFLICT`).
- **Execution:** `POST /operations/college-payments/:id/clear` by the requester, with `approvalId`, in one transaction
  that locks the payment, consumes the approval and sets the cleared columns. Without an approval: `403
  APPROVAL_REQUIRED`.
- **The trigger repeats the binding:** `CLEARED` is refused unless `clearance_approval_id` is an `EXECUTED`
  `INSTITUTION_PAYMENT_CLEARANCE` approval for this payment, executed by `cleared_recorded_by_user_id`, whose payload
  carries this row's amount, count and cleared date — and unless neither its requester nor its approver is credited with
  the college. A second writer that skips the API cannot clear a payment.
- **Who sees the approval:** the existing approvals queue, which only operators who hold a high-risk capability or
  `APPROVE_HIGH_RISK` can open (and a non-approver sees only their own requests). The approver must see the amount and
  count to approve them; approvers are internal operators, never growth staff, who hold no capability.

## Self-dealing guard (design §8.6)

`institution_payment_credited_user(institution uuid, user uuid) → boolean` is true when the user is credited with the
college:

- the lead's owner at the moment operations linked the college's handoff (`growth_handoff_requests.owner_user_id_at_link`
  of the `LINKED` request, GROWTH-04) — the only credit record on this base;
- and, once GROWTH-07's `growth_attributions` exists, any live attribution of the college whose beneficiary is the user
  (read through `to_regclass` so this migration does not depend on GROWTH-07; if that table exists without the columns
  design §8.1 names, the function **fails closed** — it raises — rather than silently allowing).

It is checked on the user id, across all memberships (a person with both a growth membership and an operations one is
one person). It refuses: recording a payment for the college, requesting its clearance, approving its clearance, and
executing it. The API answers `403 INSTITUTION_PAYMENT_SELF_DEALING` (or `APPROVAL_SUBJECT_CONFLICT` at approval), and the
trigger refuses the insert and the clearance as a backstop. Bounce, refund and void are not guarded: they only take
commission away. GROWTH-07 may redefine the function with `CREATE OR REPLACE` when it settles attribution; it must keep
the handoff rule or replace it with the attribution rule that supersedes it.

## Who sees what

| Who | What |
|---|---|
| Operator with `GROWTH_FINANCE` | Everything on the college's "Payments received" section; may record, bounce, refund, void, request and execute clearance |
| Operator with `ACCOUNT_MANAGE` (customer success) | The same section, read-only: the account owner must know whether a college has paid before a renewal conversation |
| Operator with `APPROVE_HIGH_RISK` | The clearance approval in the approvals queue (amount, count, date, college name) |
| Any other operator | Nothing (403) |
| College staff, employers, students, growth executives and managers | Nothing. No route outside `/api/v1/operations/college-payments` and the approvals queue reads this table, except the growth milestone, which reads only `EXISTS (… state = 'CLEARED')` |
| Growth (design §6.1) | `FIRST_PAYMENT_CLEARED`: reached or not. Never an amount, a reference, a count, a date of receipt or a date of clearance. Not reached reads "Waiting for the college's payment to clear." whether or not a payment has been received, so the milestone cannot reveal a receipt |

`FIRST_PAYMENT_CLEARED` is reached while the college has at least one payment in state `CLEARED` (design §6.1 says
"has at least one CLEARED payment"). A payment later refunded or voided no longer counts: the milestone follows the
money that stands, which is also what commission follows.

**Audit rows carry no amount and no reference.** The audit log is read by more operators than finance. Each transition's
audit context carries the payment id, the college, the instrument, the state change, the business date, the reason
code, the student count and (on clearance) the approval and its approver — enough to answer "who did what when", with
the amount and the cheque number left on the immutable row, which only finance and account staff can read. Outbox
payloads carry identifiers and enums only.

## A college's access is never gated on a payment

`students_paid` is a fact about money received, not an entitlement (ADR-040 change 2, ADR-022). No college, student,
employer or growth flow reads this table to decide anything; a college whose roster exceeds the count, whose cheque
bounced or who has never paid loses nothing in ONE. A spec proves it: a college admin's and a student's routes answer
the same before any payment, after a bounce and after a void. ADR-022's warning stands in reverse: the absence of a
payment row does not mean a college has not paid; it means nobody recorded it.

## A college that leaves ONE (INST-18)

`institution_payments` is listed in `institutionPurgeOutOfScope`: the exit purge never deletes it. It is AI8HT's
finance record of money received, not the college's data; commission (GROWTH-11) and disputes read it, and design
§10.5 says a college's exit changes nothing about what it has already paid for.

## Routes

All under `/api/v1/operations/college-payments`, all refusing unknown fields, all writes one transaction with the
change, its `audit_events` row and its outbox event.

| Route | Capability | Audit action | Outbox event |
|---|---|---|---|
| `GET /policy` | `GROWTH_FINANCE` or `ACCOUNT_MANAGE` | — | — |
| `GET ?institutionId=` | `GROWTH_FINANCE` or `ACCOUNT_MANAGE` | — (no personal data) | — |
| `POST` (record) | `GROWTH_FINANCE` | `operations.institution_payment.recorded` | `institution_payment.recorded` |
| `POST /:id/clear` | `GROWTH_FINANCE` + approval | `operations.institution_payment.cleared` | `institution_payment.cleared` |
| `POST /:id/bounce` | `GROWTH_FINANCE` | `operations.institution_payment.bounced` | `institution_payment.bounced` |
| `POST /:id/refund` | `GROWTH_FINANCE` | `operations.institution_payment.refunded` | `institution_payment.refunded` |
| `POST /:id/void` | `GROWTH_FINANCE` | `operations.institution_payment.voided` | `institution_payment.voided` |

The list is one college at a time, newest first, at most 200 rows, with counts by state. Amounts travel as integer
paise (JSON numbers, safe below 2^53 under the bound above); the screen converts rupees typed as text ("125000.50") to
paise by string arithmetic, never through a float.

## Rejected

- **Single-person clearance.** Closed by D10 (O-17): clearance starts commission, so it needs a second person.
- **Clearing in the same call as recording.** A cheque is received days before it clears; recording both at once would
  invite clearing on receipt. A transfer that arrives already settled still goes through the two steps, with the same
  date for both.
- **Editing a payment.** A wrong amount or count is voided and recorded again with `CORRECTION`, naming the row it
  replaces; the void and the new row are both audited, and the old row stays.
- **Deleting a voided row.** Never: the ledger may already have accrued from it, and a dispute needs it.
- **Free-text reasons.** Every transition takes a reason code from a fixed list; the optional note is kept on the row
  (record) or in the audit context (transitions), with the warning about personal data.
- **Showing amounts to `ACCOUNT_MANAGE` holders read-write.** They read; only finance writes.
- **Showing the cleared date to growth.** The milestone is reached or not. A date would let a salesperson line clearances
  up against their own commission statement and the college's letter; the statement (GROWTH-11) carries what they need.

## Decisions taken for Divakar (recommended, built)

1. Instruments are the four of design §11.1 (cheque, demand draft, bank transfer, UPI), each through the same two-step
   flow.
2. Amount bound ₹100 crore and student bound 100 000 per payment, as sanity checks; coverage period at most 3 years.
3. Clearance reasons `BANK_STATEMENT_CONFIRMED`, `BANK_ADVICE_RECEIVED`; refund and void reasons as listed above.
4. `ACCOUNT_MANAGE` holders read the payments section; only `GROWTH_FINANCE` writes.
5. The milestone counts only payments currently `CLEARED`; a refunded or voided payment does not.
6. The OPS-02 solo safeguard applies to clearance as to every other high-risk action, while AI8HT has one approver.
7. The self-dealing guard reads the handoff owner at link now and the live attribution once GROWTH-07 exists, failing
   closed if that table does not have the expected shape.
8. Amounts and cheque references are kept out of audit context and outbox payloads.
