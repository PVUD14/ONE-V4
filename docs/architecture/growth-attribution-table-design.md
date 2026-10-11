# Growth Attribution, Disputes, Reassignment and Leavers — Table Design

**Status:** Adopted (GROWTH-07), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-02
**Migration:** `0110_growth_attribution.sql` (new; no existing migration is edited; no function an earlier migration
defined is redefined — every rule is a new function on a new trigger, including the self-dealing guard on
`organization_verification_events`; no capability CHECK, grant trigger, scope trigger or OPS-02 action vocabulary is
touched)
**Parent design:** `growth-portal-design.md` §8 (attribution, disputes, reassignment, leavers, the self-dealing guard),
§10.2 and §10.5 (what the ledger will read from this), §10.10 (employer commission on hold, D11), §15;
`growth-college-pipeline-table-design.md` (GROWTH-04: the owner at link); `growth-employer-pipeline-table-design.md`
(GROWTH-05: the onboarding record and its §8.3 candidate); ADR-040 "Separation of duties"
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Attribution decides who is paid for a college for 24 months (§8.5, D14), and who brought an employer in for whenever
employer commission is decided (D11). It is the one input to the ledger that a person can argue about, and the one a
person with the wrong access could quietly change in their own favour. Four things make it consequential:

1. **It must be written when it happens.** The owner at link (GROWTH-04) and the referral and lead owner at onboarding
   (GROWTH-05) are recorded; GROWTH-07 turns them into credit in the same transaction, and never infers credit later.
2. **It changes who gets paid.** A dispute or a reassignment moves future money from one person to another. Every
   change must be an end plus a new row (so "who was credited on 12 March" is answerable), made by someone who is not a
   party, with a reason, an audit row and an event.
3. **People leave.** A leaver keeps credit for what they earned; what they would earn after leaving goes to nobody until
   a growth admin reassigns it. The ledger (GROWTH-11) needs the leave date, and nothing in ONE records it today.
4. **Self-dealing.** An operator may also be a growth person (a user may hold an operations and a growth membership). No
   one may verify an organisation credited to them, link a handoff or onboard an employer that would credit them,
   decide their own dispute, or move credit to or from themselves. Checked on the user, across memberships, in the
   route and in the database.

No amount appears anywhere in this goal. Rates are GROWTH-09; the ledger is GROWTH-11.

## 1. `growth_attributions` (design §8.1)

| Column | Rule |
|---|---|
| `id` | uuid |
| `organization_id` | → `organizations`; **one live row per organisation** (partial unique index on `ended_at IS NULL`) |
| `organization_kind` | `INSTITUTION` or `EMPLOYER`, equal to `organizations.kind` (trigger) |
| `beneficiary_user_id` | → `users`: the person credited (a user, not a membership, so a role change keeps credit). Must hold or have held a growth membership (trigger) |
| `basis` | `LEAD_OWNER_AT_HANDOFF`, `REFERRAL_LINK`, `DISPUTE_DECISION`, `MANUAL_CORRECTION` |
| `reason_code` | fixed per basis (CHECK): `COLLEGE_HANDOFF_LINKED` or `EMPLOYER_ONBOARDED` for the two handoff bases; `DISPUTE_DECIDED` for a dispute; `BENEFICIARY_LEFT`, `WRONG_PERSON_CREDITED`, `TEAM_CHANGE`, `CORRECTION` for a manual correction |
| `lead_id` | → `growth_leads`, the lead it came from, when there is one |
| `source_handoff_request_id` | → `growth_handoff_requests`: the college handoff it was written from |
| `source_access_request_id` | → `growth_employer_onboardings`: the employer onboarding it was written from |
| `dispute_id` | → `growth_attribution_disputes`: the dispute whose decision wrote it |
| `supersedes_id` | → `growth_attributions`: the row it replaced (a reassignment or an upheld dispute) |
| `effective_from` | `now()` at creation, except `DISPUTE_DECISION`: the date of the attribution or handoff it corrects (§8.4) |
| `ended_at`, `ended_reason_code`, `ended_by_user_id` | set together, once; `REASSIGNED`, `DISPUTE_DECISION`, `CORRECTION`, `ORGANIZATION_EXITED` |
| `created_by_user_id`, `correlation_id`, `created_at` | the operator who linked or onboarded, or the growth admin who decided or corrected |

CHECKs pair the basis with its source: a handoff basis names exactly one of the two sources (`REFERRAL_LINK` only the
employer one), `DISPUTE_DECISION` names its dispute, `MANUAL_CORRECTION` names the row it supersedes. **Nobody credits
themselves:** `created_by_user_id <> beneficiary_user_id` and `ended_by_user_id <> beneficiary_user_id` are CHECKs, so
an operator who links their own lead, or an admin who moves credit to or from themselves, is refused by the database
whatever the route does.

Guard trigger: DELETE refused; a row starts live, with `created_at = now()` and, except for a dispute decision,
`effective_from = now()`; a dispute decision's row needs its dispute `OPEN`, the same organisation, and a beneficiary
who is a party to it; the only update is the end, once, with `ended_at = now()`; every other column is fixed.

**Where rows come from — the only four places:**

| When | Written by | Row |
|---|---|---|
| Operations link a college handoff (GROWTH-04's link) | the same transaction | `LEAD_OWNER_AT_HANDOFF` to `owner_user_id_at_link`; none when the lead had no owner ("house") |
| Operations onboard an employer access request (GROWTH-05's decision) | the same transaction | `REFERRAL_LINK` to the referrer; `LEAD_OWNER_AT_HANDOFF` to the lead owner; **`CONFLICT`: no row, a dispute opens** (§2); `HOUSE`: none |
| A growth admin decides a dispute | the decision | `DISPUTE_DECISION` (and the disputed row ends `DISPUTE_DECISION`) |
| A growth admin reassigns | the reassignment | `MANUAL_CORRECTION`, effective now (the old row ends `REASSIGNED`) |

**First handoff decides.** Attribution is written only at an organisation's first handoff: an employer onboarded a
second time (another access request onboarded to the same organisation) writes nothing, and nothing is ever written for
an organisation that already has an attribution or dispute history. "Nothing is inferred later" (§8.3).

A growth admin may also **end** a live row without a successor — `CORRECTION` (nobody should have been credited) or
`ORGANIZATION_EXITED` — with no new row. The organisation is then "house" from that moment.

## 2. `growth_attribution_disputes` (design §8.4)

| Column | Rule |
|---|---|
| `id` | uuid |
| `organization_id`, `organization_kind` | as above; **one `OPEN` dispute per organisation** (partial unique index) |
| `origin` | `CLAIM` (a growth person opened it) or `ONBOARDING_CONFLICT` (the onboarding found a referral and a lead owner who are different people, §8.3 step 3) |
| `attribution_id` | the live attribution disputed (a claim against a credited organisation); NULL for a conflict and for a claim on a "house" organisation |
| `claimant_user_id` | the person claiming credit; for a conflict, the referrer (§8.3 puts the referral first) |
| `respondent_user_id` | the person currently credited (a claim), the lead owner (a conflict), or NULL (a claim on a house organisation); never the claimant (CHECK) |
| `source_access_request_id` | a conflict's onboarding |
| `statement` | the claimant's case, 1–2000 characters; required for a claim, absent for a conflict (CHECK) |
| `opened_by_user_id`, `opened_at` | the claimant (a claim) or the onboarding operator (a conflict); `now()` |
| `state` | `OPEN` → `UPHELD` or `REJECTED`, once |
| `decided_by_user_id`, `decided_at`, `decision_reason_code`, `decision_note` | set together on the decision. **The decider is neither party** (CHECK on the user ids, and the route checks `GROWTH_ADMIN`). Reasons: `CLAIMANT_DID_THE_WORK`, `RESPONDENT_DID_THE_WORK`, `INSUFFICIENT_EVIDENCE`, `OUTSIDE_POLICY`, `OTHER`; a note ≤ 1000 characters is required with `OTHER` |
| `resulting_attribution_id` | the row the decision wrote, if any |
| `correlation_id` | |

**Outcomes.**

| Dispute | `UPHELD` | `REJECTED` |
|---|---|---|
| Claim against a credited organisation | the disputed row ends `DISPUTE_DECISION`; a new `DISPUTE_DECISION` row credits the claimant, **effective from the disputed row's `effective_from`**, superseding it | nothing changes |
| Claim on a house organisation | a `DISPUTE_DECISION` row credits the claimant, effective from the handoff | nothing changes (still house) |
| Onboarding conflict | the referrer is credited, effective from the onboarding | the lead owner is credited, effective from the onboarding |

Accruals already earned stay where the ledger put them; GROWTH-11 moves *unpaid* accruals to the new beneficiary
through ledger events when a dispute is upheld, and never moves a paid one (§8.4, O-6). This goal records the decision
the ledger acts on.

**Who may open a claim** (design §8.4): a person with an `ACTIVE` growth membership, for an organisation **they had a
lead or a referral for** — they own or once owned the lead linked to it, they requested its handoff, their referral
code is on an access request for it, or the onboarding record names them as lead owner or referrer — **within 90 days
of the organisation's handoff** (the college link time, or the employer's first onboarding), measured on the database
clock and enforced by the trigger as well as the route. Not for an organisation already credited to them, and not while
another dispute about it is open. The 90 days are from the handoff, which is also the first attribution's
`effective_from`, so a reassignment does not reopen the window.

**Who sees what.** The claimant sees their dispute and its statement; the respondent sees that a dispute about their
credit is open and how it was decided, never the statement; growth admins see everything. A dispute never shows an
amount.

## 3. `growth_leaver_events` (design §8.5)

| Column | Rule |
|---|---|
| `id` | uuid |
| `membership_id`, `user_id` | a growth membership (`GROWTH_EXECUTIVE` or `GROWTH_MANAGER`) and its user |
| `event` | `LEFT` (left `ACTIVE`: suspended or ended) or `RETURNED` (back to `ACTIVE`, e.g. a suspension lifted) |
| `from_state`, `to_state` | the membership states |
| `occurred_at` | `now()` — **the leave date is the database time the membership left `ACTIVE`** (§8.5) |

Written by a new `AFTER UPDATE OF state` trigger on `organization_memberships` for growth roles, beside 0100's and
0109's leaver triggers, in the same statement as the state change. Append-only (update and delete refused). Not
back-filled: a growth membership that left before 0110 has no leave date, and the screens say "leave date not
recorded" rather than guess one (growth is not yet released, so none is expected).

**What leaving does to credit:** nothing to the rows. A leaver keeps credit (§8.5): entries that become payable within
90 days of the leave date are settled, later ones lapse, and accruals earned after the leave date go to nobody unless a
growth admin reassigns the attribution (reason `BENEFICIARY_LEFT`). Those are the ledger's rules (GROWTH-11); this goal
records the date, shows each leaver's attributions on the growth admin's list with the date and "settlement ends
<date + 90 days>", and offers the reassignment. A dispute a leaver opened stays open and is decided like any other.
A referral whose owner has left by the time the employer is onboarded still credits them (the link they shared brought
the employer in); the admin list flags it at once.

## 4. The self-dealing guard (design §8.6)

**Parties to an organisation** = the beneficiary of its live attribution and both parties of its open dispute.

| Act | Refused when | Where |
|---|---|---|
| A verification transition (`OPS_VERIFY`) of an organisation | the operator is a party to it | the route (`403 GROWTH_SELF_DEALING_REFUSED`) and a `BEFORE INSERT` trigger on `organization_verification_events` (the actor is a party) |
| Linking a college handoff (`OPS_ORG_MANAGE`) | the lead's owner is the operator | the route; and the attribution CHECK |
| Onboarding an employer access request | the operator is the request's referrer or its linked lead's owner | the decision route; and the attribution and dispute CHECKs |
| Linking an access request to a growth lead by hand | the lead's owner is the operator | the route |
| Deciding a dispute | the admin is the claimant or the respondent | the route and the dispute CHECK |
| Reassigning or ending an attribution | the admin is the current or the new beneficiary | the route and the attribution CHECKs |

All compared on the user id, so holding a growth and an operations membership does not help. GROWTH-10 (recording a
payment) and GROWTH-09/12 (approving a rate or a payout) add their own checks using the same parties function
(`growth_organization_parties(org)`), which this migration defines. A growth person cannot be an approver of anything:
growth roles hold no capability (GROWTH-01).

## 5. Dual control

The design puts OPS-02 dual control where money moves — a rate, a payment clearance, a payout (§15). Attribution moves
no money by itself, so it is controlled by **separation** instead: a dispute has two people (the claimant and a deciding
admin who is neither party), a reassignment or end is made by an admin who is neither the old nor the new beneficiary,
and every change is an end plus a new row with a reason, an audit row and an event. The money a changed attribution
leads to still passes through the ledger and a dual-controlled payout (GROWTH-12), whose approver sees the
attribution history. **Rejected:** an OPS-02 approval for each reassignment — it needs a new extended action key, which
means redefining `operation_approval_extended_target_type()` while GROWTH-09/10 do the same in parallel (the later
replay would drop one key or the other), and it adds a second approver to a change that cannot move money on its own.

## 6. Routes, audit and events

| Route | Who | Audit / event |
|---|---|---|
| `GET /api/v1/growth/attributions` | an `ACTIVE` growth membership | — (the caller's credit, their disputes, the organisations they may dispute) |
| `POST /api/v1/growth/attribution-disputes` | an eligible claimant (§2) | `growth.attribution_dispute.opened` / same event |
| `GET /api/v1/operations/growth-attribution` (`view` = `LIVE`, `LEFT`, `ENDED`; `q`) | `GROWTH_ADMIN` | — |
| `GET /api/v1/operations/growth-attribution/disputes` (`state` = `OPEN`, `DECIDED`) | `GROWTH_ADMIN` | — |
| `GET /api/v1/operations/growth-attribution/organizations/:id` | `GROWTH_ADMIN` | — (every row and dispute of the organisation) |
| `GET /api/v1/operations/growth-attribution/reassign-options?kind=` | `GROWTH_ADMIN` | — (ACTIVE growth people on the matching team) |
| `POST /api/v1/operations/growth-attribution/disputes/:id/decide` | `GROWTH_ADMIN`, not a party | `growth.attribution_dispute.decided`; `growth.attribution.ended` / `growth.attribution.created` for the rows |
| `POST /api/v1/operations/growth-attribution/:id/reassign` | `GROWTH_ADMIN`, not old or new beneficiary; no open dispute | `growth.attribution.reassigned`; the two row events |
| `POST /api/v1/operations/growth-attribution/:id/end` | `GROWTH_ADMIN`, not the beneficiary; no open dispute | `growth.attribution.ended` |
| Link / onboarding (GROWTH-04, GROWTH-05) | as before | adds `growth.attribution.created` or, on a conflict, `growth.attribution_dispute.opened` |
| Verification transition | as before | refused for a party, nothing written |

Events carry identifiers, enums and reason codes only — never a statement, a name or an email.

## 7. Surfaces

- **Growth → Commission (web).** "Credited to you": each organisation credited, its kind, basis, since when, whether a
  dispute is open, and — instead of any amount — "Commission amounts are not built yet; no rate has been set" for
  colleges and "Employer commission on hold — not decided" for employers. "Your disputes" and "Dispute a credit" (the
  organisations the person may dispute, with the window's end). The commission figure on Home stays NA.
- **Android (read-only, design §18).** A "Credited to you" card on the Growth home, with a saved copy for offline, and
  the person's disputes and their states. Opening a dispute is a desk task on the web and the card says so.
- **Operations → Settings → Growth attribution (web, `GROWTH_ADMIN`; a section, no navigation item).** Open disputes
  with the statement, the parties, the evidence pointers (lead, handoff, onboarding candidate) and the decision form;
  attributions by view (live, beneficiary left, ended) with search; an organisation's full history; reassign and end.

## 8. Privacy

- `growthWork.attributions` and `growthWork.attributionDisputes` in a growth person's own export: the organisations
  credited to them (name, kind, basis, dates) and the disputes they opened (with their own statement) or that named them
  (without the other party's statement). `privacy-export-coverage.md` gains the rows.
- `growth_leaver_events` holds staff employment facts (dates), exported in `growthWork.leaverEvents`.
- No student data is read or written. No amount is stored.

## Decisions taken for Divakar (recommended, built)

- Attribution is written only at an organisation's first handoff; a second onboarding of the same employer writes nothing.
- An onboarding conflict opens a dispute with the referrer as claimant and the lead owner as respondent; upheld credits
  the referrer, rejected the lead owner.
- A claim may be made on a "house" organisation (no attribution) by someone who had a lead or referral for it, within
  the 90 days; upheld credits them from the handoff.
- One open dispute per organisation; a second claimant waits for the decision.
- The dispute window runs from the handoff, not from a later reassignment.
- Reassignment and ending are separated (admin not a party) and audited, not OPS-02 dual-controlled (§5).
- A reassignment may be made only to an `ACTIVE` growth person on the team that matches the organisation's kind, and not
  while a dispute about it is open.
- A referral credits its owner at onboarding even if they have left; the admin list flags it.
- The self-dealing guard covers every verification transition (not only `VERIFIED`) and the parties of an open dispute
  as well as the credited person; a refused onboarding or link must be done by another operator.
- Leave dates are recorded from now on and not back-filled.
- Android shows credit and disputes read-only; disputes are opened on the web.
