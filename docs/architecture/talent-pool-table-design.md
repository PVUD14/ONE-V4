# Consented Talent Pool (Employer Discovery) — Table Design

**Status:** Adopted for build (EMP-14), recommended options taken per AGENTS.md ("ask once, recommend, carry on").
**Built dark:** everything sits behind the feature flag `employer.talent-pool`, **default off, turning it on
needs a second person**, because the program's hard gate HG-4 (employers seeing per-skill evidence, including
through discovery) is still PENDING. See ADR-044.
**Date:** 2026-10-01
**Migration:** `0098_talent_pool.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`
**Builds on:** ADR-043 and `application-evidence-shares-table-design.md` (EMP-13: the qualifying-evidence rule,
the "no totals, no ranking, no readiness, no identifiers" contract), `consent-registry-table-design.md` (0028:
`employer-discovery` was anticipated there as the first OPTIONAL key), EMP-03 (`requireActiveEmployer`,
`employerInGoodStandingSql`), EMP-SR-01 (accounts in deletion are withheld from employers), INST-14 (a
nomination that reveals nothing until the student applies).

## Why this exists

Employers want to find students before a job closes; students must decide whether they can be found at all,
and what a finder sees. Today an employer sees a student only after that student applies. `student_profiles`
has carried `visibility_state = 'EMPLOYER_DISCOVERY'` and `employer_discovery_enabled` since 0006, but nothing
reads them, and the consent registry was built (0028) so that discovery could be gated by a distinct,
revocable consent. Talent Pool in the employer portal says honestly that it is not available (EMP-07).

Discovery is a statement about a person, made to strangers, before they chose any particular employer. So
it needs more care than EMP-13's per-application sharing, not less: the student opts in explicitly, chooses
every field a finder sees, can block particular employers, and can leave at any time with effect on the next
request; the employer never learns who the student is until the student applies.

## Who appears (all of these, checked in SQL on every request — nothing is cached)

| Condition | Why |
|---|---|
| the flag `employer.talent-pool` is on | HG-4 dark launch |
| the student has a **live listing** (`talent_pool_listings.ended_at IS NULL`) | what to show is the student's own choice |
| their latest `employer-discovery` consent row is `GRANTED` **at the current version** | the plan's "consent"; a withdrawal, or a newer notice not yet agreed to, removes them (fails closed) |
| `student_profiles.visibility_state = 'EMPLOYER_DISCOVERY'` | the plan's "profile visibility"; setting Profile → Visibility to anything else removes them |
| `users.state = 'ACTIVE'`, not anonymised, no open deletion request | same rule as the EMP-SR-01 grant predicate |
| no live block of this employer by the student | "students can block an employer" |
| the employer is verified and active, and the reader an active owner/admin/recruiter | EMP-03 `requireActiveEmployer(…, 'candidates')` |

Opting in sets all three student-side conditions in one transaction; opting out ends the listing, records a
`WITHDRAWN` consent row and moves visibility from `EMPLOYER_DISCOVERY` to `INSTITUTION_VISIBLE` (never
widening anything). Any one of them failing removes the student from the very next search, card view and
invitation attempt.

## What a finder sees (the card)

Only what the student ticked, and only this:

- **Skills with verified evidence**: for each catalogue skill (taxonomy topic) the student chose to show, the
  skill's name; on the card's detail view, each chosen item's type, source, date and whether it was unaided —
  exactly EMP-13's fields. Only evidence passing EMP-13's `qualifyingEvidence` rule (graded, DEMONSTRATED or
  TRANSFERRED at capture, something correct, not superseded, never a lesson) can be chosen, and it is re-checked
  on every read, so a correction withdraws the old item.
- **Branch** (the department of the student's college roster record), only if the student ticks it.
- **Graduation year** (from the roster's expected graduation date), only if the student ticks it.
- **Preferred cities** (up to five, typed by the student), only those.

**Never:** a name, email, phone, photo, college name, roll number, any identifier (user, listing, evidence,
topic), a readiness band or score, a gap status, a mastery value, the stage, marks, a count or total of
evidence, a percentage, a rank, a sort by evidence, or any "fit" number.

A card is addressed by a **card reference**: `md5(listing id ':' employer id)`. It differs per employer (two
employers cannot correlate their notes about one student), and a new opt-in creates a new listing and so new
references (leaving and rejoining severs any link an employer kept).

## Searching

Filters only — never a score, never a rank:

- `skill` (repeatable, at most 5): catalogue topic ids from the employer's skill catalogue; a card matches only
  if it shows qualifying evidence for **every** chosen skill;
- `branch`: text, matched case-insensitively against the shown branch;
- `graduationYear`: a year, matched against the shown year;
- `city`: text, matched case-insensitively against the shown cities.

At least one filter is required. Any other query parameter is refused with `400 UNKNOWN_FILTER`, so a
protected attribute (gender, religion, caste, age, disability, college, …) can never become a filter by
accident. Results: 25 per page, at most 8 pages, no total, only `hasMore`. Order: `md5(card reference)` —
stable for one employer, unrelated to evidence, recency or anything about the student. Filters that the
student did not choose to show never match (a hidden branch matches no branch filter).

## Contacting a student: invitation to apply

The only path. The employer invites a card to one of its own **published** jobs that has an `INVITE_ONLY`
audience and an open deadline. The student gets an in-app notice (kind `SYSTEM`, written after the commit,
like INST-14 nominations — never email, never the student's address to the employer). The invited job becomes
visible to that student only (the student-side `visibleToStudent` gains "an INVITE_ONLY audience and a live
invitation to you"), and applying runs the normal apply — eligibility, placement policy, consented snapshot,
grant — in the same transaction that marks the invitation `APPLIED`. **Identity and snapshot reach the
employer only through that application.** Declining, letting it expire, or blocking the employer reveals
nothing.

The employer sees its own invitations as `PENDING`, `APPLIED` or `CLOSED`. A decline shows as `PENDING` until
the invitation expires and then `CLOSED`, the same as no answer (INST-14's rule for nominations), so declining
carries no signal.

## Decision 1: four tables

### `talent_pool_listings` — one row per opt-in

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | never leaves the server; card references are derived from it |
| `student_user_id` | uuid → `users(id)` | |
| `show_branch` | boolean, default false | |
| `show_graduation_year` | boolean, default false | |
| `preferred_cities` | text[], default `{}` | at most 5; each 2–60 letters/spaces/hyphens/dots (API), total ≤ 400 chars (CHECK) |
| `consent_version` | text | the `employer-discovery` version agreed to at this opt-in |
| `opted_in_at` | timestamptz, default `now()` | |
| `updated_at` | timestamptz, default `now()` | |
| `ended_at` | timestamptz, nullable | set once |
| `end_reason` | text, CHECK `STUDENT_OPTED_OUT` / `ACCOUNT_DELETION` | paired with `ended_at` |

Partial unique index `(student_user_id) WHERE ended_at IS NULL`: one live listing. A trigger keeps `id`,
`student_user_id`, `consent_version` and `opted_in_at` fixed, refuses any change to an ended listing, and
refuses `DELETE` except inside the privacy-erase transaction for that subject (`one.privacy_erase_subject`,
the 0068 pattern).

### `talent_pool_listing_evidence` — the evidence items a listing shows

`id`, `listing_id` → listings, `student_user_id`, `evidence_record_id` → `evidence_records`, `shown_at`,
`removed_at`, `removed_reason` (`STUDENT_REMOVED` / `LISTING_ENDED`). Partial unique `(listing_id,
evidence_record_id) WHERE removed_at IS NULL`. The trigger requires the listing's student, the row's student
and the evidence's subject to be the same person and the listing to be live (nobody can show another person's
evidence); allows only a single removal; refuses `DELETE` outside the erase transaction. Cap: 40 live items.

**Rejected: reusing `application_evidence_shares`.** A share is bound to one application and one employer's
grant; discovery has neither. Mixing them would make "revoked from this employer" and "removed from the pool"
one column with two meanings.

### `talent_pool_blocks` — employers a student has blocked

`id`, `student_user_id`, `employer_id` → `organizations` (trigger: must be `kind = 'EMPLOYER'`), `blocked_at`,
`unblocked_at`. Partial unique `(student_user_id, employer_id) WHERE unblocked_at IS NULL`. Only `unblocked_at`
may change, once; `DELETE` only in the erase transaction. A block works whether or not the student is opted in
(it is remembered for the next opt-in), and blocking cancels that employer's unanswered invitations.

### `talent_pool_invitations` — invitations to apply

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `employer_id` | uuid → organizations | |
| `opportunity_id` | uuid → opportunities | must be the employer's (trigger) |
| `listing_id` | uuid → listings | the card that was invited |
| `student_user_id` | uuid → users | must be the listing's student (trigger) |
| `invited_by_user_id` | uuid → users | the recruiter |
| `state` | text, CHECK `SENT` / `APPLIED` / `DECLINED` / `CANCELLED` | expiry is computed (`SENT` and `expires_at <= now()`) |
| `created_at` | timestamptz, default `now()` | |
| `expires_at` | timestamptz | 14 days, or the job's deadline if sooner |
| `responded_at` | timestamptz, nullable | |
| `application_id` | uuid → applications, nullable | exactly when `APPLIED` |
| `cancel_reason` | text, CHECK `STUDENT_BLOCKED` | exactly when `CANCELLED` |

Unique `(opportunity_id, listing_id)`: one invitation per card per job, ever (no pestering). It is per *card*,
not per student: a student who left and rejoined is a new card, and refusing an invitation to the new card
because of the old one would tell the employer the two cards are the same person. A trigger allows only
`SENT → APPLIED | DECLINED | CANCELLED`, once, with every other column fixed; `DELETE` only in the erase
transaction. Limit: **20 invitations per employer per rolling 24 hours**, counted in SQL under a
transaction-scoped advisory lock on the employer, so two recruiters cannot race past it.

## Decision 2: the consent definition and the flag

0098 inserts `employer-discovery` version `2026-10-draft`, `OPTIONAL`, withdrawable, `document_ref` pointing at
`docs/legal/employer-discovery-consent-DRAFT-for-legal-review.md`, `ON CONFLICT DO NOTHING`. The consent
registry API hides it and refuses to grant it while the flag is off, so the definition existing offers nobody
anything. **Turning the flag on therefore needs both HG-4 (this feature) and HG-6 (the wording, which is a
draft for legal review).** If legal changes the wording, a later migration adds the approved version and
retires the draft; students who agreed to the draft drop out until they agree again (the registry's re-prompt
rule).

0098 also inserts the flag `employer.talent-pool`, off, `high_risk_direction = 'ENABLE'`, `ON CONFLICT DO
NOTHING` (a replay never changes a live switch), and re-asserts the high-risk marking — the same as 0093.

**Rejected: re-using `employer.skill-evidence`.** Approving per-application sharing must not silently switch on
discovery, which reaches employers the student never chose.

## Decision 3: while the flag is off

- Student: `available: false`; opting in and editing a listing are refused (`TALENT_POOL_UNAVAILABLE`); a live
  listing made while it was on can still be ended (leaving is always allowed); invitations are not listed and
  invited jobs are not visible.
- Consent registry: `employer-discovery` is not listed and cannot be granted; withdrawal stays possible.
- Employer: every talent-pool route returns `available: false` (or refuses an invitation) **without reading
  any student data**, so nothing is audited and nothing leaks.

## Decision 4: audit

In the same transaction as the act: `talent_pool.searched` (the filters and the number of cards returned, on
the employer organisation), `talent_pool.card_viewed` (resource: the listing — operators can see whose card
was opened; the employer never can), `talent_pool.invitation_sent`, and on the student side
`talent_pool.opted_in`, `talent_pool.listing_updated`, `talent_pool.opted_out`,
`talent_pool.employer_blocked`, `talent_pool.employer_unblocked`, `talent_pool.invitation_declined`.

## Retention and deletion

Under the existing categories (no new category, so no CHECK list is redeclared):

- **STUDENT_PROFILE (ERASED):** listings, their evidence rows and blocks are deleted. Before that, the live
  listing is ended with `ACCOUNT_DELETION` in the step that revokes grants, so discovery ends first even if a
  later step fails.
- **APPLICATIONS (ANONYMISED):** invitations that produced an application stay with that application; every
  other invitation is deleted.
- **CONSENT_RECORDS (RETAINED):** the `employer-discovery` grant and withdrawal rows stay as proof.

While a deletion request is open the student is already excluded (the "who appears" rule).
The student's data export gains `talentPool`: every listing (opted in/out, what it showed, cities, the evidence
items with skill, type, source, date, unaided, shown and removed), blocks (employer name, dates), invitations
received (employer, job, sent, expires, state, answered) and the employers who opened their card (employer
name, when — from the audit rows).

## Migration

`0098_talent_pool.sql`: `CREATE TABLE IF NOT EXISTS`, constraints dropped and re-added by name, `CREATE OR
REPLACE` functions, triggers dropped and re-created, the consent definition and the flag inserted `ON CONFLICT
DO NOTHING`. References only `users`, `organizations`, `opportunities`, `applications` (0001–0007),
`evidence_records` (0004), `consent_definitions` (0028) and `feature_flags` (0029/0038), so it is safe on a
fresh database and on every replay.

## Readiness

Nothing here reads or writes `readiness_snapshots`, `readiness_factors`, `mastery_projections`, `career_gap_*`
or `learner_skill_state`. `stage_at_capture` is used only inside `qualifyingEvidence` and never leaves the
server. Contract tests walk every employer response for readiness, score, mastery, gap, stage, marks, count,
rank and identifier keys and values.

## Decisions for Divakar (recommended answers taken)

1. **HG-4 for discovery** — recommended: approve as above. Until then the flag stays off.
2. **The consent wording** is a draft for legal review (HG-6). Do not switch the flag on before it is approved.
3. **Card fields**: evidence per skill, branch, graduation year, preferred cities — each only if ticked. No
   college name (with branch and year it narrows a person down too far). Recommended as built.
4. **Limits**: 20 invitations per employer per 24 hours; one invitation per card per job; invitations last 14
   days; 5 skills per search; 25 cards per page, 8 pages. Recommended as built.
5. **A decline looks like no answer** to the employer (as INST-14). Recommended as built.
6. **Leaving keeps received invitations answerable** until they expire — they are the student's, and applying
   is their own act. Blocking an employer cancels that employer's.
7. **Notices are in-app only** (no email) for now, like nominations.
