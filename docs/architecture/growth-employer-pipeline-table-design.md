# Growth Employer Pipeline, Referral Links and the EMP-04 Handoff — Table Design

**Status:** Adopted (GROWTH-05), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-10-02
**Migration:** `0109_growth_employer_pipeline.sql` (new; no existing migration is edited; no function an earlier
migration defined is redefined — every rule here is a new function on a new trigger, and no capability CHECK, grant
trigger or scope trigger is touched)
**Parent design:** `growth-portal-design.md` §7 (employer pipeline, referral links, the handoff), §8.3 (who an employer
is credited to), §10.10 (employer commission on hold, D11); `growth-leads-table-design.md` (GROWTH-03);
`growth-college-pipeline-table-design.md` (GROWTH-04, the stage machine this goal reuses);
`employer-access-requests-table-design.md` (EMP-04, the public form and its queue);
`employer-terms-and-trust-participation-design.md` (EMP-16); `campus-drives-table-design.md` (EMP-11)
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Employers already have a public door into ONE: the EMP-04 "Request employer access" form, the one place an anonymous
visitor can write. GROWTH-05 lets a growth person's work show up at that door — a referral link they share, and the
lead they have been working — without changing what the door discloses, and records, at the moment operations
onboards the employer, who brought it in. Four things make it consequential:

1. **The form is public.** Anything the referral adds must not let a visitor learn whether a code is valid, whether a
   company is known, or who works at AI8HT. The answer must stay `202 { received: true }`, byte for byte, with EMP-04's
   rate limits exactly as they were.
2. **The code goes into the wild.** A referral link is pasted into emails and chat. It must carry no personal data, must
   stop working when its owner leaves, and must not be farmable.
3. **Credit is decided at onboarding.** Attribution (GROWTH-07, §8.3) credits the referral's owner first, else the
   lead's owner, and opens a dispute when they differ. Both facts must be recorded in the same transaction as the
   onboarding, or they cannot be reconstructed honestly later (ownership and codes change).
4. **Nothing in growth may onboard or verify** (design §15). The lead names its employer only because operations
   onboarded a request linked to it; the database refuses any other path.

Employer commission is **on hold** (D11). This goal records the facts attribution needs; it computes nothing that could
be read as money owed.

## 1. Stages a growth person sets (design §7.1)

`IDENTIFIED → CONTACTED → MEETING_SCHEDULED → MET → INTERESTED → ACCESS_REQUEST_INVITED`, plus `ON_HOLD` and `LOST`. The
stage CHECK exists (0100) and the move route, its reasons, resume-from-hold, the stale-move refusal and the offline
`Idempotency-Key` are GROWTH-04's, already serving employer leads. Nothing is added to the machine. There is no
"handoff request" for employers: the employer's own access request is the handoff (§7.3). Once an employer lead names
its organisation (§6), 0104's pipeline trigger already freezes its stage.

## 2. Derived milestones (design §7.1) — computed on read, never stored

Shown on every employer lead. Each is read from the source table that already holds it. Growth sees whether and when,
and counts of jobs and drives — never a job's content, an applicant, a candidate or a drive's college.

| Milestone | Read from | Shown |
|---|---|---|
| `ACCESS_REQUESTED` | `employer_access_request_leads` (§5) → `employer_access_requests` (0041) | reached, the first request's time |
| `ONBOARDED` | `growth_employer_onboardings` (§6) for this lead | reached, the onboarding time |
| `VERIFIED` | the first `organization_verification_events` row to `VERIFIED` (0005) | reached (ever verified), that time |
| `TERMS_ACCEPTED` | EMP-16's terms status (0084): `ACCEPTED`, `ACCEPTANCE_REQUIRED`, or **NA** when no employer terms are published | reached or not, the latest acceptance time |
| `FIRST_JOB_PUBLISHED` | `opportunities.published_at` (0007; a job leaves DRAFT/PENDING_REVIEW only by publishing) | reached, the first publish time; the count **published now** |
| `CAMPUS_DRIVE` | `campus_drives` (0069) | reached when any drive exists; the count per drive state |
| `SUSPENDED` | `organizations.verification_state = 'SUSPENDED'` | reached or not |

Before the lead names its employer, every milestone but `ACCESS_REQUESTED` reads "not yet" — there is no employer to read.
Job and drive counts are counts of the employer's own records, not of people, so no suppression applies; no title,
description, college, applicant or candidate is selected by the query.

The lead's pipeline also lists its linked access requests: received time, state (`PENDING`, `ONBOARDED`, `DECLINED`,
`SPAM`) and whether it came through a referral link — "yours" or "another team member's", never whose. Never the
requester's name, email or what they typed.

## 3. `growth_referral_codes`

| Column | Rule |
|---|---|
| `id` | uuid |
| `code` | 10 characters from the 31-character alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no `0 O 1 I L`), generated server-side from `crypto.randomInt`; `UNIQUE`. About 49.5 bits: guessing a live code is hopeless, and a guess cannot be checked anyway (§4) |
| `membership_id` | the owner's growth membership (`GROWTH_EXECUTIVE` or `GROWTH_MANAGER`), `ACTIVE`, with a live `EMPLOYER_PARTNERSHIPS` team row at creation (trigger) |
| `user_id` | the owner's user, which must be the membership's user (trigger) — kept so credit survives a role change |
| `created_at` | `now()` |
| `revoked_at`, `revoked_reason_code`, `revoked_by_user_id` | set together, once. Reasons: `OWNER_REVOKED` (the owner, with actor), `OWNER_LEFT` (the membership left `ACTIVE`, no actor), `LEFT_EMPLOYER_TEAM` (the owner's employer team row ended, no actor) |

**The code is not a credential.** It grants nothing — no sign-in, no read, no write. It only labels an access request
as "referred by" its owner for operations to see. It is therefore stored as it is (the owner must be able to show it
again), unlike ADR-031's public-profile tokens, which are stored as digests because they open a profile.

**No personal data in the link.** The link is `<site>/employer-access?ref=<code>`: the public form's own path and the
code. Nothing about the owner — name, email, team, region — is in it or derivable from it.

**Abuse limits (trigger, under a per-membership advisory lock so concurrent creations cannot both pass):**

- at most **3 live codes** per membership;
- at most **5 codes created** per membership in any 24 hours (so a person cannot churn codes to dodge the per-code cap
  below, or flood the table).

**Revocation is automatic** when the owner's membership leaves `ACTIVE` (a new `AFTER UPDATE OF state` trigger on
`organization_memberships`, beside 0100's leaver trigger) and when their employer team row ends with no other live
employer team row (a new trigger on `growth_team_members`). The owner may also revoke one by hand. A revoked code is
never reactivated; the person creates a new one.

Guard trigger: DELETE refused; INSERT starts live; the only UPDATE is the revocation, once; every other column fixed.

## 4. `employer_access_request_referrals`

| Column | Rule |
|---|---|
| `access_request_id` | **primary key**, → `employer_access_requests` **`ON DELETE CASCADE`** |
| `referral_code_id` | → `growth_referral_codes` |
| `created_at` | `now()` |

A new table rather than a column on `employer_access_requests` (design §7.2), so EMP-04's CHECKs and its retention are
untouched: **the referral row goes when its request goes.** It holds no personal data.

**How the public form records it.** The form accepts one more optional field, `ref`. In the submission's transaction,
*after* the unchanged rate-limit check and the unchanged request upsert:

1. `ref` is normalised (trimmed, upper-cased). Anything that is not 10 characters of the alphabet is **malformed** and
   ignored. A well-formed value is looked up whatever happens next, so a malformed, unknown, revoked and valid code
   cost the same work.
2. A code is **used** only when it is live, its membership is `ACTIVE`, and it has recorded fewer than **20 referrals in
   the last 24 hours** (the per-code cap; a field person shares a link with a handful of companies a day, a script
   shares it with hundreds). Otherwise it is ignored.
3. The referral is inserted with `ON CONFLICT DO NOTHING` — **the first referral of a request wins**; a repeat
   submission of a pending request with another code changes nothing. The insert runs inside a savepoint, so even a
   database refusal of the referral can never fail the submission.
4. An outbox event `growth.referral.recorded` (request and code ids only, no actor) announces it.

**Nothing about `ref` changes the answer.** Unknown, revoked, malformed (including a non-string, an over-long string,
an empty string) and valid codes all produce the same status, the same headers and the same body, `202
{ received: true, correlationId }`, where the correlation id is random per request whatever the code. `ref` is never
echoed, never logged in the response, and never makes a request a 400: the form's other validation is exactly EMP-04's,
and is applied before `ref` is looked at. **Rate limits are unchanged and count every submission the same way**, with
or without a code: the code is read only after the limit check passes, and a refused (429) submission records nothing.

**Audit.** `audit_events` needs a signed-in actor and the submitter has none, so — as EMP-04 does for the request — the
referral row itself (with its database time) and its outbox event are the record. Code creation and revocation, the
operator's lead links and the onboarding record are ordinary audited acts (§7).

**Rejected.**
- *Answering 400 for a malformed code*, or any different answer for an invalid one: it turns the form into a validity
  oracle (design §7.2).
- *Storing the code on the request row:* it would change EMP-04's table, its CHECKs and its retention.
- *Counting codes in the rate limit:* the limit is about the network address and domain; tying it to a code would let
  anyone exhaust a growth person's code by submitting junk with it.
- *Showing the owner the companies their link brought:* the request is what an anonymous visitor typed (names, emails,
  possibly abuse). The owner sees counts by state; operations sees the rest.
- *A hashed code:* nothing to protect (it opens nothing), and the owner could not see their own link again.

## 5. `employer_access_request_leads`

| Column | Rule |
|---|---|
| `access_request_id` | **primary key** — a request names at most one lead; → `employer_access_requests` **`ON DELETE CASCADE`** |
| `lead_id` | → `growth_leads`, an `EMPLOYER` lead that is not lost, not do-not-contact and names no organisation (trigger) |
| `basis` | `DOMAIN_MATCH` (written by the submission) or `OPERATOR_LINKED` (an `OPS_ORG_MANAGE` operator) |
| `linked_by_user_id` | NULL for `DOMAIN_MATCH`; the operator for `OPERATOR_LINKED` (CHECK) |
| `linked_at` | `now()` |

**Domain match (design §7.2).** In the submission's transaction, the request is linked to the open employer lead whose
`website_domain` equals the request's email domain or its website's host (lower-case, `www.` removed) — only when
exactly one such lead exists and no link exists yet. Lost and do-not-contact leads are never matched. This reads
`growth_leads` inside the public route but changes nothing in the answer.

**By hand.** In the queue an operator sees "Matches growth lead" (the persisted link) and read-time candidates (open
employer leads on the same domain, or with the same normalised name). They may link a request to a lead, move the link
to another lead, or remove it — only while the request is `PENDING`, each audited (`operations.employer_access_request.
growth_lead_linked` / `…_unlinked`) with the old and new lead.

Guard trigger: rows change only while the request is `PENDING`; an update may only move the link to another lead as
`OPERATOR_LINKED` with an actor; a delete is allowed while `PENDING` (unlink) or when the request no longer exists (the
cascade).

## 6. `growth_employer_onboardings` — the EMP-04 handoff record

Written by the unchanged `POST /operations/employer-access-requests/:id/decision` when the decision is `ONBOARDED`, in
the same transaction, and nowhere else.

| Column | Rule |
|---|---|
| `access_request_id` | **primary key**, → `employer_access_requests` (no cascade: an onboarded request is never swept) |
| `organization_id` | → `organizations`, an `EMPLOYER` (trigger) — the request's own organisation |
| `lead_id` | the linked lead, **only when it names this employer after the onboarding** (linked now, or already to the same employer); otherwise NULL |
| `lead_owner_membership_id`, `lead_owner_user_id` | that lead's owner **at this moment** (both NULL or both set) |
| `referral_code_id`, `referrer_membership_id`, `referrer_user_id` | the request's referral and its code's owner (all NULL or all set), whatever the code's state now — it was valid when the company used it |
| `candidate_basis` | §8.3 applied: `REFERRAL_LINK` (a referral; the lead owner, if any, is the same person), `LEAD_OWNER_AT_HANDOFF` (no referral, an owned lead), `CONFLICT` (both, different people — GROWTH-07 writes no attribution and opens a dispute), `HOUSE` (neither) — CHECKed against the columns |
| `recorded_by_user_id`, `recorded_at` | the operator, `now()` |

Insert-only: no update, no delete (trigger).

**Linking the lead.** When the request has a linked lead that names no organisation, and no other lead names this
employer, the same transaction sets `growth_leads.organization_id`. A new trigger on `growth_leads`
(`growth_lead_employer_org_guard`, beside 0100's and 0104's) refuses an employer lead naming an organisation unless a
`growth_employer_onboardings` row for that lead and organisation exists — the employer twin of 0104's college rule.
When the lead cannot be linked (it already names another employer, or another lead names this one), the onboarding
still succeeds and the record carries no lead: the operator's decision is never blocked by growth data.

**This is not attribution.** `growth_attributions` and `growth_attribution_disputes` are GROWTH-07's tables with their own
design; this row is the fact they are written from, exactly as GROWTH-04 records the college owner at link. An
employer attribution earns nothing while D11 holds.

## 7. Routes, audit and events

| Route | Who | Audit / event |
|---|---|---|
| `GET /api/v1/growth/referral-codes` | an `ACTIVE` growth membership | — (own codes; per code the count of referred requests by state: pending, onboarded, closed) |
| `POST /api/v1/growth/referral-codes` (optional `Idempotency-Key`) | on the employer partnerships team | `growth.referral_code.created` / same event |
| `POST /api/v1/growth/referral-codes/:id/revoke` | the code's owner | `growth.referral_code.revoked` / same event |
| `POST /api/v1/employer-access-requests` (`ref` optional) | anyone | no audit (no actor); `growth.referral.recorded` |
| `GET /api/v1/growth/leads/:id/pipeline` | as GROWTH-04 | — (employer milestones and linked requests) |
| `GET /api/v1/operations/employer-access-requests` | `OPS_ORG_MANAGE` | — (adds referral, linked lead and candidates) |
| `POST /api/v1/operations/employer-access-requests/:id/growth-lead` | `OPS_ORG_MANAGE` | `operations.employer_access_request.growth_lead_linked` / `…unlinked`; `growth.employer_lead.linked` / `…unlinked` |
| `GET /api/v1/operations/growth-employer-leads?q=` | `OPS_ORG_MANAGE` | — (open employer leads for the link picker; name, domain, stage, owner's work email) |
| `POST /api/v1/operations/employer-access-requests/:id/decision` (unchanged contract) | `OPS_ORG_MANAGE` | adds `operations.employer.growth_onboarding_recorded` and `growth.employer.onboarded` when `ONBOARDED` |

Events carry identifiers, enums and the candidate basis only — never a code, a name, an email or a domain.

## 8. Retention (EMP-04 decision 4, built here)

EMP-04 proposed deleting `DECLINED` and `SPAM` requests 180 days after the decision "once the privacy worker covers
it", and left it unbuilt. The acceptance criterion "a referral row is deleted with its request under EMP-04 retention"
needs that retention to exist, so this goal builds it as recommended: a daily step of the privacy worker deletes
`DECLINED` and `SPAM` requests decided more than **180 days** ago, in bounded batches, on the database clock. The
`ON DELETE CASCADE` foreign keys take their referral row and lead link with them in the same statement. `PENDING` and
`ONBOARDED` requests are never swept (an onboarded request is part of the employer's onboarding record).

## 9. Who sees what

- **Growth person:** their own codes and per-code counts; on each employer lead they can see, its milestones and linked
  requests (time, state, referral yours / another's). Never a requester's details, a job's content, an applicant, a
  candidate or a drive's college.
- **Operations (`OPS_ORG_MANAGE`):** on each queue row, "Referred by <work email>" (and whether that code is now
  revoked), "Matches growth lead <name> · owner <work email>", and candidates. This is the same audience that already
  sees the request itself.
- **Nobody** sees another growth person's codes.

## 10. Android

The employer pipeline on the phone is GROWTH-04's lead pipeline section, which already sends employer stage moves
through the offline queue; it gains the employer milestones and linked requests, read with a saved copy for offline.
A "My employer referral link" card lists the person's codes from a saved copy and **shares the link through the
Android share sheet even offline** (sharing is local). Creating and revoking a code need a signal and say so: a code is
generated by the server, so queuing a creation would only hand the person a link that does not yet exist.

## Decisions taken for Divakar (recommended, built)

- Code alphabet and length: 10 of 31 unambiguous characters; stored plainly because it opens nothing.
- Abuse limits: 3 live codes and 5 creations per 24 hours per person; a code records at most 20 referrals per 24 hours,
  beyond which further submissions are accepted as normal requests without the referral.
- First referral wins on a repeated pending request.
- Codes are revoked when the owner's membership leaves `ACTIVE` and when they leave the employer team.
- A referral credits its code's owner even if the code was revoked after the company used it (GROWTH-07 decides how a
  leaver's credit is treated, §8.5).
- Domain match only when exactly one open, contactable employer lead matches; operators may link, move or remove the
  link while the request is pending.
- Lost and do-not-contact leads are never linked.
- EMP-04's 180-day retention of declined and spam requests is built now, in the privacy worker.
- The growth person sees counts of referred requests by state, not the companies.
