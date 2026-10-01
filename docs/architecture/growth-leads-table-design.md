# Growth Leads, Contacts and Their History — Table Design

**Status:** Adopted (GROWTH-03), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-01
**Migration:** `0100_growth_leads.sql` (new; no existing migration is edited and no function an earlier migration
defined is redefined)
**Parent design:** `growth-portal-design.md` §5 (leads), §13 (lead personal data under the DPDP Act), §14.1, §16;
`growth-territories-table-design.md` (GROWTH-02: who sees which lead); ADR-040 (D12: lead-contact retention 24 months)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

The lead register is the one place ONE holds personal data about people who are **not its users and never agreed to
anything**: principals, trustees, placement officers and HR managers whose names, emails and phones a salesperson
writes down. It also decides who is credited later (ownership history feeds attribution, GROWTH-07). So every column
below is either about the organisation or is personal data with a stated purpose, a permitted source, a notice, a
retention period, an export path and an erasure path — and the database, not only the code, refuses the shapes that
would break those rules.

## 1. Tables

| Table | What a row is |
|---|---|
| `growth_leads` | one prospective college or employer, as a growth person heard of it |
| `growth_lead_contacts` | one person at that organisation, live or erased |
| `growth_lead_owner_history` | one change of owner (create, claim, reassign, owner left), append-only |
| `growth_lead_stage_history` | one change of stage, append-only (the stage routes themselves are GROWTH-04/05) |

## 2. `growth_leads`

| Column | Rule |
|---|---|
| `id` | uuid |
| `kind` | `COLLEGE` or `EMPLOYER` |
| `name` | 1–180, no `<` or `>`; `name_normalized` (generated: lower case, letters and digits only) for the possible-duplicate flag |
| `state_code` | NULL or → `growth_states(code)` |
| `district_code` | NULL or → `growth_districts(lgd_code)`; needs `state_code`, and must be a district of it (trigger) |
| `city` | NULL or 1–120 text |
| `aishe_code` | colleges only (CHECK): NULL or `^(C|U|S)-[0-9]{1,8}$` |
| `website_domain` | NULL or a lower-case host (`^[a-z0-9.-]+\.[a-z]{2,}$`, ≤ 253); required for an employer **once known** — not required at creation, because a field visit often starts with a name only |
| `owner_membership_id` | NULL (unowned) or an **ACTIVE** growth membership with a **live team row matching `kind`** (trigger: `COLLEGE` → `COLLEGE_PARTNERSHIPS`, `EMPLOYER` → `EMPLOYER_PARTNERSHIPS`) |
| `stage` | the union of the college and employer stages of design §6.1/§7.1, CHECKed per kind; a lead is created `IDENTIFIED`. Moved only by the stage routes (GROWTH-04/05) |
| `lost_reason_code` | NULL unless `stage = 'LOST'` (CHECK) |
| `source` | `FIELD_VISIT`, `REFERRAL_LINK`, `INBOUND_ACCESS_REQUEST`, `EVENT`, `PUBLIC_DIRECTORY`, `INTRODUCTION`, `OTHER` |
| `possible_duplicate` | set at creation when a live lead of the same kind has the same normalised name and district (§4) |
| `do_not_contact_at`, `do_not_contact_reason`, `do_not_contact_by_user_id` | set together, once (trigger) |
| `organization_id` | NULL; set only at handoff by operations (GROWTH-04); unique among leads |
| `created_by_user_id`, `created_at`, `updated_at`, `version` | `version` increments on every update (optimistic concurrency, as OPS-14) |
| `last_activity_at` | `now()` at creation; the API moves it on every write to the lead or its contacts. It is the clock of the 24-month retention rule (§6.3) and of "stale" (90 days, O-10) |

No free-text notes column (design §5.1): notes live on activities (GROWTH-06), each authored and dated.

**Live, for duplicates.** A lead is *live* unless it is `LOST` without do-not-contact. A converted lead (handed off)
stays live; a do-not-contact lead stays live (so the same organisation cannot be re-entered behind the person's back).
Two partial unique indexes enforce §5.3 in the database: `aishe_code` among live college leads, `website_domain` among
live employer leads.

**Open, for the leaver rule.** A lead is *open* while it is not `LOST` and has no `organization_id`.

**Guard trigger.** DELETE refused (a lead is history). `kind`, `created_by_user_id` and `created_at` never change.
Do-not-contact is set once and never cleared. `organization_id` is set once. On a do-not-contact lead the owner cannot
change (no claim, no reassignment for outreach) — except to NULL by the leaver rule — and no contact can be added.

## 3. `growth_lead_contacts`

Follows OPS-14's `institution_account_contacts` exactly where the problem is the same.

| Column | Rule |
|---|---|
| `id`, `lead_id` | uuid; → `growth_leads(id)` |
| `contact_role` | `PRINCIPAL`, `DIRECTOR`, `CHAIRMAN_OR_TRUSTEE`, `PLACEMENT_OFFICER`, `HR`, `TALENT_ACQUISITION`, `FOUNDER`, `OTHER` |
| `full_name` | 1–120 |
| `email` | lower case, ≤ 254, email shape |
| `phone` | `^\+?[0-9 ()-]{6,24}$`; `phone_digits` (generated) holds the digits only, for the privacy lookup |
| `permission_basis` | **required** (NOT NULL + CHECK): `PROVIDED_BY_PERSON`, `PUBLIC_INSTITUTIONAL_LISTING`, `INTRODUCED_BY_COLLEAGUE` (design §13.2, O-21 interim rule) |
| `source` | how it reached us: `BUSINESS_CARD`, `MEETING`, `EMAIL_FROM_PERSON`, `ACCESS_REQUEST_FORM`, `OFFICIAL_WEBSITE`, `COLLEAGUE_INTRODUCTION`; CHECKed to agree with the basis (a website listing is never "provided by the person") |
| `notice_given_at`, `notice_version`, `notice_recorded_by_user_id` | set together, once (§5) |
| `added_by_user_id`, `created_at` | |
| `removed_at`, `removed_by_user_id`, `removed_reason_code` | `OWNER_REMOVED`, `WRONG_DETAILS`, `LEFT_ORGANISATION`, `PRIVACY_REQUEST`, `RETENTION_EXPIRED`, `HANDED_OVER` |

- **State CHECK (acceptance): a removed contact keeps no name, email or phone.** Live: name NOT NULL and (email or
  phone). Removed: `full_name`, `email`, `phone` all NULL, a reason, and an actor — except `RETENTION_EXPIRED`, which
  the sweep writes with no person behind it. The removal statement erases the fields itself; the CHECK refuses any
  removal that does not.
- **Guard trigger:** DELETE refused; a contact is added live, never to a do-not-contact lead; the only updates are
  recording the notice once, and live → removed. A removed contact cannot change.
- At most 10 live contacts per lead (code, as OPS-14).
- **Masking.** Responses mask email and phone (`maskEmail`, `maskPhone`, `packages/authorization/src/support-desk.ts`)
  and show the name, for everyone except the lead's **owner**, who sees their own contacts in full because calling them
  is the job (O-9). A manager or growth admin who needs the full value uses **reveal**, which takes a reason
  (`MANAGER_REVIEW`, `REASSIGNMENT_HANDOVER`, `DATA_CORRECTION`) and writes an `audit_events` row
  (`growth.lead_contact.revealed`) in the same request. A reveal is answered only for a lead the caller can see.

## 4. Duplicates (design §5.3)

- A new lead is refused with `409 GROWTH_LEAD_DUPLICATE` when a live lead of the same kind has the same `aishe_code`
  (colleges) or `website_domain` (employers). The answer names the existing lead's owner **only to a caller whose scope
  includes that lead** (`isVisibleInGrowthScope`); anyone else gets `existing: null` and the words "already registered
  by another team member — ask your manager", so the check cannot be used to browse other pipelines. The unique indexes
  decide a race.
- A do-not-contact lead with the same identifiers refuses the new one with `409 GROWTH_LEAD_DO_NOT_CONTACT`, again
  without naming anyone.
- **Already on ONE:** an employer lead whose `website_domain` is the host of an `EMPLOYER` organisation's
  `organization_profiles.website_url` is refused with `409 GROWTH_ORGANIZATION_ALREADY_ON_ONE`. Colleges carry no AISHE
  code on `organizations`, so for them the same rule works through a converted lead (which stays live and so is a
  duplicate). **Decision taken (recommended):** no fuzzy name match against `organizations` — a false refusal would
  block real new business, and the possible-duplicate flag covers the case.
- **Possible duplicate (flag, not refusal):** same kind, same normalised name and same district as a live lead.
  `possible_duplicate` is set on the new lead and shown to its owner and managers; which lead it resembles is not
  revealed to someone who cannot see it.

## 5. Notice (design §13.3)

At first contact the growth person gives or sends the contact notice: who AI8HT is, why we hold the details, where they
came from, how long we keep them, and how to ask us to stop or delete them. The wording is
`docs/legal/growth-lead-contact-notice-DRAFT-for-legal-review.md`, **DRAFT throughout; publishing it is HG-6**.
The contact row records `notice_given_at`, `notice_version` (the code constant `GROWTH_CONTACT_NOTICE_VERSION`,
currently `draft-2026-10`) and who recorded it. It can be recorded when the contact is added or later, once. The screens
show "Notice not yet given" on every contact without one, and the notice text comes from the API with its DRAFT label,
so a field person never sends words that differ from the record.

## 6. Personal data: purpose, source, retention, export, erasure

### 6.1 Purpose and source
One purpose, shown beside every contact form and in the notice: *to contact this person about their organisation
partnering with AI8HT's ONE platform*. Only the three bases of §3 are accepted (O-21 interim rule). The form says
personal mobile numbers from any other source, purchased lists and scraped data are not allowed.

### 6.2 Who sees what
Contacts are returned only on a lead the caller can see (`growthScopeFor`), unmasked only to the owner. The Android app
caches contacts only for the person's own leads (the API returns masked values for every other lead, so nothing else
can be cached).

### 6.3 Retention: 24 months (D12)
A **daily sweep in the privacy worker** (`run-privacy-worker.ts`, beside the deletion run) erases every live contact of
every lead whose `last_activity_at` is more than 24 months ago and which has not been handed off — which covers both
"`LOST`" and "no activity" in design §13.4, because losing a lead is its last activity. The sweep removes with
`RETENTION_EXPIRED` (fields erased by the same statement), writes one `audit_events` row per lead it touched
(`growth.lead_contacts.retention_erased`, counts only), is bounded per run and idempotent (a second run finds nothing).
The organisation-level lead stays. Handed-off leads are excluded because operations erases their copies at handoff
(`HANDED_OVER`, GROWTH-04).

### 6.4 Rights requests: export and erasure
A contact is not a ONE user, so their requests reach AI8HT by email and land in the **Operations → Privacy** console
(OPS-06), which gains a "Growth lead contacts" section for `PRIVACY_REQUESTS` holders:
- **Lookup (the export answer):** by email (exact, lower case) or phone (digits only). Returns, per matching contact,
  the organisation, the role, which fields we hold (the values themselves, since this *is* the answer to the person),
  the permission basis and source, whether and when the notice was given, when it was added, and whether it is live.
  Audited (`operations.growth_contacts.looked_up`) with the request reference — never the email or phone itself in
  the audit context, only a hash.
- **Erasure:** removes every live matching contact with `PRIVACY_REQUEST` in one transaction, and, when the person
  asked not to be contacted at all, sets do-not-contact on each of their leads (`PERSON_REQUEST`). Audited per lead.
  After that, the same email or phone cannot be added again to a do-not-contact lead (the trigger), and a new lead for
  the same identifiers is refused (§4).

### 6.5 The growth person's own data (design §13.5)
A growth staff member is a data principal too. Their privacy export gains a `growthWork` section: their territory
assignments (region, role, dates), team rows, staff type, and the leads they created or own (organisation name, kind,
stage, dates) — **never the contacts' personal data**, which is not theirs. When a staff user is erased, the `users` row
is anonymised by the existing path; their leads and contact rows stay, because they describe organisations and third
parties, and the reference to the user then names nobody. Recorded in `privacy-export-coverage.md`.

## 7. Ownership and its history (design §5.4)

`growth_lead_owner_history (id, lead_id, from_membership_id, to_membership_id, reason_code, actor_user_id, occurred_at)`
— append-only (trigger refuses UPDATE and DELETE). Reasons: `CREATED`, `CLAIMED`, `TERRITORY_CHANGE`, `WORKLOAD`,
`OWNER_LEFT`, `DISPUTE_DECISION`, `INACTIVITY`, `CORRECTION`. `actor_user_id` is NULL only for `OWNER_LEFT`.
Ownership at any past moment is answerable from it.

- **Create:** the creator owns the lead if they have a live team row for its kind; otherwise the create is refused
  (`403 GROWTH_TEAM_MISMATCH`). **Decision taken (recommended):** refuse rather than create an unowned lead the creator
  may then be unable to see.
- **Claim:** an unowned, not-do-not-contact lead in the caller's scope; first claim wins under a row lock (`409
  GROWTH_LEAD_ALREADY_OWNED` to the second).
- **Reassign:** a manager, for a lead in a region they manage or owned by one of their reports, to an ACTIVE growth
  membership whose team matches the kind (or to nobody), reason-coded; a growth admin anywhere, from Operations. Never on
  a do-not-contact lead.
- **The leaver trigger (acceptance):** when a growth membership leaves ACTIVE (ended or suspended — an OPS-15
  revocation suspends), a trigger on `organization_memberships` sets every **open** lead it owns to unowned and writes
  an `OWNER_LEFT` history row, **in the same transaction**. Converted and lost leads keep their owner (credit is
  attribution's question). The "manager task" of design §5.4 is the region manager's *Needs a new owner* list on the
  Leads page: open, unowned leads whose last owner-history row is `OWNER_LEFT` — derived from the rows, so it cannot
  disagree with them. **Rejected:** a separate task table written by the trigger — a second record of the same fact.
- **Stale:** no activity for 90 days (O-10) shows as stale to the owner and manager. Nothing moves automatically.

## 8. Stage history

`growth_lead_stage_history (id, lead_id, from_stage, to_stage, reason_code, actor_user_id, occurred_at)` — append-only.
GROWTH-03 writes the creation row (`NULL → IDENTIFIED`); the stage routes (GROWTH-04, GROWTH-05) write the rest.

## 9. Reads and writes

- Growth (`/api/v1/growth/leads…`): list (keyset-paged, capped at 50, filtered by kind and by mine / unowned / needs a
  new owner, searched by name), detail, create, claim, reassign (managers), add contact, record notice, remove contact,
  reveal (non-owners), do-not-contact. Every read is composed from `growthScopePredicate`; a lead outside scope is 404.
- Operations (`/api/v1/operations/growth-leads…`, `GROWTH_ADMIN`): list and detail across all regions (masked),
  reveal, reassign anywhere, do-not-contact, remove a contact. A section of Settings (no navigation change).
- Operations privacy (`/api/v1/operations/privacy/growth-contacts…`, `PRIVACY_REQUESTS`): lookup and erasure.
- Every write: one transaction, its `audit_events` row, an outbox event (`growth.lead.created`, `.claimed`,
  `.reassigned`, `.do_not_contact_set`, `growth.lead_contact.added`, `.removed`), `version` and `last_activity_at`
  moved.

## Decisions taken for Divakar (recommended, built)

- A create by someone with no matching team is refused, not left unowned (§7).
- No fuzzy name match against existing organisations; only exact identifiers refuse (§4).
- A do-not-contact lead keeps its owner but is frozen for outreach (no claim, reassignment or new contact).
- The 24-month clock is the lead's last activity, which covers both LOST and inactivity (§6.3).
- The "manager task" for a leaver's leads is a derived list, not a task table (§7).
- `notice_version` is `draft-2026-10` until legal review publishes a version (HG-6).
