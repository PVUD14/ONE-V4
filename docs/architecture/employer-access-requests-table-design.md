# Employer Company Profile and Access Requests — Table Design

**Status:** Adopted (EMP-04), recommended option taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-25
**Migration:** `0041_employer_company_profile_and_access_requests.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Two gaps, one goal (Appendix 2, EMP-04).

1. **Students cannot tell who is hiring.** A job shows the employer's legal name and nothing
   else. `organization_profiles` (0005) already holds the display name, website, location and a
   contact email, but only Operations writes it (`PATCH /operations/organizations/:id`) and no
   student-facing route reads it. There is nowhere for an employer to say what it does.
2. **An employer cannot ask to join.** Every employer on ONE exists because an operator typed it
   in. There is no way for a company to raise its hand, so the conversation always starts on our
   side, by email, with nothing recorded.

Both touch records that carry consequences. The profile is what students trust when they decide
to share their data with a company; the access request is the first step of verification, and it
is the only write in the product that an anonymous visitor can make.

## Part 1 — the company profile: extend `organization_profiles`

### Decision: four new columns on `organization_profiles`, not a new table

| Column | Notes |
| --- | --- |
| `about_text` | text NULL, 1–2000 characters. What the company does, in its own words. Shown to students. |
| `industry` | text NULL, one of a fixed list (below). A list, not free text, so it can be filtered later and cannot carry a sales pitch. |
| `company_size_band` | text NULL, one of `1-10`, `11-50`, `51-200`, `201-1000`, `1001-5000`, `5001+`. A band, never a head count. |
| `careers_page_url` | text NULL, `https://` only, ≤ 256 characters. |

Industries: `SOFTWARE_AND_IT_SERVICES`, `FINANCIAL_SERVICES`, `MANUFACTURING`,
`ENGINEERING_AND_CONSTRUCTION`, `HEALTHCARE_AND_LIFE_SCIENCES`, `CONSULTING_AND_PROFESSIONAL_SERVICES`,
`RETAIL_AND_CONSUMER`, `EDUCATION`, `MEDIA_AND_COMMUNICATIONS`, `ENERGY_AND_UTILITIES`,
`LOGISTICS_AND_TRANSPORT`, `GOVERNMENT_AND_PUBLIC_SECTOR`, `NON_PROFIT`, `OTHER`.

The four columns are employer-only: a trigger refuses them on an institution's profile row. The
0005 scope trigger is left exactly as it is; the new rule is a second trigger beside it.

**Rejected: an `employer_company_profiles` table.** The display name, website and location already
live in `organization_profiles`; a second table would either duplicate them (two display names that
drift) or split one profile across two tables that every read must join and every writer must keep
in step. One row per organisation, as today.

**Rejected: a logo now.** The plan lists "logo as a stored document reference". Storing an image an
employer uploads needs the file store and scanner to be configured; without them the upload routes
report themselves unavailable (the same rule as student documents and public-profile photos). A
column nobody can fill is not added. It comes with the upload, in its own migration. Until then the
company is shown by name — never by an initials tile or a placeholder logo.

### Who may change what — and why verified details do not move

Operations verifies an employer against the details it holds: the **legal name**, the **display
name** students see, the **website**, the **address** and the **contact email**. If the employer
could change those after verification, a verified record would quietly stop describing the company
that was verified — the display name is exactly what an impersonator would change.

So the rule is by field, not by state:

| Field | Employer owner / admin | Recruiter | Operations |
| --- | --- | --- | --- |
| Legal name, display name, website, country, state, city, postal code, address, contact email | read | read | read and write (unchanged route) |
| About, industry, size band, careers page | read and write | read | read |

An employer request that names an Operations-controlled field — including `legalName` — is refused
with `403 COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED` and changes nothing. The employer screen shows
those fields as read-only with "Managed by AI8HT operations".

**Rejected: let the employer edit everything and drop the organisation back to `UNDER_REVIEW`.**
It would take every published job off students' screens (EMP-03 hides jobs of unverified employers)
for a typo in a description, and it turns a profile edit into a verification event. The fields that
matter to verification simply are not the employer's to edit.

**Rejected: queue employer edits of verified fields for Operations approval.** Useful, but it is a
second workflow (pending values, review, diffing) for a need nobody has yet. The employer asks
Operations, who already has the edit route. Revisit if employers ask often.

Two further guards on what the employer writes, because students read it:

- **Careers page on the verified domain.** `careers_page_url` must be on the same host as the
  Operations-held website, or a subdomain of it. Without a website on record there is nothing to
  anchor it to and the careers page is refused. A verified employer cannot point students to an
  arbitrary site.
- **No payment demands.** `about_text` goes through the same payment-demand detector job
  descriptions do at publish (Appendix 2 §5.8, `detectOpportunitySignals`). Text asking students to
  pay a fee or deposit is refused with a plain message.

### State and roles

Company-profile edits are the `organisation.manage` action group of `requireActiveEmployer`
(Appendix 2 §5.1: "company profile, team" is what a PENDING or UNDER_REVIEW employer may set up
before verification). A PENDING or UNDER_REVIEW employer can therefore write its description before
students ever see it; a SUSPENDED or REJECTED employer can neither read nor write it (it can still
read its own organisation status). The write re-reads the organisation's state under a row lock, as
team changes do, so a suspension landing mid-request changes nothing. Every write is one
transaction with an `audit_events` row naming the fields changed, and an
`organization.company_profile.updated` outbox event.

A profile row is created by Operations when the organisation is created. If none exists, the
employer write answers `409 COMPANY_PROFILE_NOT_SET_UP` rather than inventing a country for it.

### What students see

Every job in the student listing and detail carries a `company` block: display name, industry, size
band, city / state / country, website, careers page and about text. Only verified, active employers'
jobs reach students (EMP-03), so this is always a verified company's profile. Nothing is invented: a
field the employer or Operations has not filled is `null`, and the screens say "Not provided".

## Part 2 — `employer_access_requests`

### The shape of the problem

The request form is public: anyone can post to it without an account. That makes it the second kind
of unauthenticated route in ONE (ADR-031 made the first: token-bound public profile reads). The
threats are specific:

- **Spam and flooding** — bots filling the Operations queue.
- **Enumeration** — using the form to learn whether a company, or an email address, is on ONE.
- **Self-verification** — anything that lets a request become an organisation, or a verified one,
  without an operator.
- **Personal data** — a name and a work email of someone who has not agreed to anything else.

### Decision

| Column | Notes |
| --- | --- |
| `id` | uuid PK. |
| `requester_name` | text NOT NULL, 1–120. |
| `company_name` | text NOT NULL, 1–180. What the requester typed; never copied to `organizations` automatically. |
| `work_email` | text NOT NULL, lower-case, ≤ 254. |
| `email_domain` | text NOT NULL, the part after `@`. |
| `website_url` | text NOT NULL, `https://` only, ≤ 256. |
| `email_matches_website` | boolean NOT NULL. The email's domain is the website's host or a parent of it. A signal for the reviewer, not a gate: subsidiaries and agencies legitimately differ. |
| `free_mail` | boolean NOT NULL. The email is on a public webmail domain. |
| `state` | text NOT NULL, `PENDING`, `ONBOARDED`, `DECLINED`, `SPAM`. |
| `organization_id` | uuid NULL → `organizations(id)`. Set only when an operator marks the request `ONBOARDED` against an employer they created through the existing Organizations flow. |
| `decided_by_user_id`, `decided_at`, `decision_reason_code` | Set together when the state leaves `PENDING`; reason `^[A-Z0-9_:-]{3,64}$`. |
| `submission_count`, `last_submitted_at`, `created_at` | A repeat of a pending request bumps the count instead of adding a row. |

Constraints: `state = 'PENDING'` ⇔ no decision columns; `ONBOARDED` ⇒ `organization_id IS NOT NULL`,
other states ⇒ `organization_id IS NULL`. One `PENDING` request per `work_email` (partial unique
index), so a repeated submission cannot multiply queue rows.

Rate limiting keeps its own table, `employer_access_request_attempts (id, client_key, email_domain,
attempted_at)`, one row per accepted submission. It holds no email and no address: `client_key` is a
SHA-256 digest of the submitter's network address and is used only for counting. Rows older than two
days are deleted on each submission, so the table stays small and nothing outlives its purpose.

### The rules the route enforces

- **Nothing is created but the request.** No user, no organisation, no membership, no invitation.
  An operator reviews the queue, creates the organisation through the existing Organizations flow
  (which starts at `PENDING` verification), and links the request as `ONBOARDED`. Verification stays
  a separate, audited operator action. The request row cannot express "verified".
- **No disclosure.** Every well-formed submission gets the same `202 { received: true }`, whether it
  was new, a repeat of a pending request, or from a company that already exists on ONE. The route
  never reads `organizations`; possible matches are shown to Operations in the queue, at read time.
  Validation errors describe the field that failed, never the state of any record.
- **Rate limits** (checked before anything is written): 5 submissions per network address per hour,
  10 per email domain per day, 200 across the service per hour as a backstop. Past a limit the answer
  is `429 EMPLOYER_ACCESS_REQUEST_RATE_LIMITED`, which says nothing about any record. The network
  address is the socket peer; when the peer is the local reverse proxy (loopback or a private
  address) the right-most `X-Forwarded-For` entry is used, because that entry is the one the proxy
  appended and a client cannot forge it.
- **Work email.** Public webmail addresses are refused (`400 EMPLOYER_ACCESS_REQUEST_WORK_EMAIL_REQUIRED`)
  unless Operations turns on the feature flag `employer-access.allow-free-mail` (default off), in
  which case they are accepted and flagged `free_mail` for the reviewer.
- **Unknown fields are refused**, lengths are bounded, and the body is parsed as data only.
- **Record and audit.** `audit_events` requires a signed-in actor, and the submitter has none, so an
  accepted submission is recorded by the request row itself and an outbox event
  `employer_access_request.submitted` with no actor (so a later notifier can tell Operations; nothing
  consumes it yet). Each operator decision writes an `employer_access_request.decided` audit row with
  the operator as actor, in the same transaction as the state change.

### The email is not confirmed

There is no production email sender (hard gate HG-7), so ONE cannot send the requester a
confirmation link. The queue says so on every request: "Email not confirmed — confirm with the
requester before onboarding." When a sender exists, a confirmation step is a new column
(`email_confirmed_at`) and a token, in a new migration.

### Operations review

`GET /operations/employer-access-requests` and
`POST /operations/employer-access-requests/:id/decision` require the `OPS_ORG_MANAGE` capability,
the same as creating an organisation. The queue appears as a section of the existing
**Organizations** screen — no navigation change. Decisions: `ONBOARDED` (with the employer
organisation the operator created), `DECLINED`, `SPAM`; each needs a reason code from a fixed list.

**Rejected: create a `PENDING` employer organisation automatically on submission.** It would put
anonymous input straight into `organizations`, let a bot create thousands of them, and make the
organisation list the spam queue. The request table is the quarantine.

**Rejected: store the raw IP address for rate limiting.** An address is personal data; a digest is
enough to count, and deleting attempts after two days keeps it that way.

**Rejected: a CAPTCHA.** Every CAPTCHA service is a third-party script and a data transfer that
needs its own review. Rate limits plus a reviewed queue are enough at this volume; revisit if the
SPAM count says otherwise.

## Retention

Declined and spam requests hold a name and an email for no further purpose. They should be deleted
after a fixed period (proposed 180 days after the decision). The privacy worker does not yet cover
this table; that is listed as a follow-up rather than built here.

## Decisions for Divakar

1. **Employer-editable fields.** Adopted: about, industry, size band, careers page. Legal name,
   display name, website, address and contact email stay with Operations. *Recommended.*
2. **Free-mail requests.** Adopted: refused unless the `employer-access.allow-free-mail` flag is on.
   *Recommended.*
3. **Rate limits.** 5 per address per hour, 10 per domain per day, 200 per hour overall. *Recommended;
   tune from the queue.*
4. **Retention** of declined and spam requests: 180 days after the decision, once the privacy worker
   covers it. *Recommended.*
