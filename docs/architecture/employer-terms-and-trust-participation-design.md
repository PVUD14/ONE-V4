# Employer Terms, Grant Expiry and Trust-Case Participation — Table Design

**Status:** Adopted (EMP-16), recommended options taken per AGENTS.md ("ask once, recommend, carry on")
**Date:** 2026-09-29
**Migration:** `0084_employer_terms_and_trust_participation.sql`
**Rule:** Written before the migration, per the migrations rule in `AGENTS.md`

## Why this exists

Employers become holders of candidate data the moment a student applies. Appendix 2 (EMP-16) asks for
three things that carry consequences for real people and organisations:

1. **Versioned employer terms** — data use limited to the hiring process, retention, no onward sharing,
   no payment demands, fair-hiring rules — accepted by an owner before the employer can publish, and
   re-accepted when the terms change materially.
2. **Grant expiry** (decision 10.2 #7) and deletion propagation: an employer's access to a candidate ends
   when it should, on the database clock, without a request handler having to notice.
3. **Employer participation in trust cases** (spec §38, §118): when a case is about them, an employer can
   see what they are accused of, respond, and appeal a decision. Operators decide. The reporter is never
   identified to the employer.

Each of these writes a record a person or an organisation may later rely on — "we accepted version X on
this date", "we answered this allegation", "we appealed" — so the tables are designed here first.

## Decision 1: dedicated terms tables, not the consent registry

**Chosen.** Two new tables: `employer_terms_versions` (what the terms said, immutable) and
`employer_terms_acceptances` (which employer organisation accepted which version, who did it and when,
append-only).

**Rejected: reuse `consent_definitions` / `user_consents` (0028).** A consent is a person's; employer
terms are accepted by an organisation, through one of its owners, on the organisation's behalf. Keying the
acceptance to a user would make "has this employer accepted?" depend on which owners are still members —
an owner leaving would silently un-accept the terms. `consent_definitions` also has no place for the text
itself or for its legal-review state, and it is the student consent vocabulary; putting employer contract
terms into it would blur what the consent gate means.

**Rejected: a column on `organizations`** (`terms_version_accepted`). It keeps only the latest answer, so
the history — which version was in force when a job was published — is lost, and it would be an UPDATE on
the most-read row in the schema.

### `employer_terms_versions`

| Column | Type | Rule |
| --- | --- | --- |
| `version` | text PK | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, chosen by the operator (for example `2026-10-draft-1`) |
| `title` | text | 1–200 characters |
| `body` | text | 1–60,000 characters — the exact text shown to the employer |
| `body_sha256` | text | 64 hex characters, computed in SQL from `body` at insert; lets anyone check the text was not altered |
| `legal_review_state` | text | `DRAFT_FOR_LEGAL_REVIEW` or `LEGAL_APPROVED` |
| `legal_review_reference` | text | required when `LEGAL_APPROVED` (who approved it and where it is recorded, ≤ 200), null otherwise |
| `requires_reacceptance` | boolean | a material change: every employer must accept this version (or a later one) before publishing again |
| `change_summary` | text | optional, ≤ 2,000 — what changed, shown next to the text |
| `published_at` | timestamptz | `now()` — the database clock decides the order |
| `published_by_user_id` | uuid → users | the operator who published it |
| `reason_code` | text | `^[A-Z0-9_:-]{3,64}$` |
| `correlation_id` | text | |

- **Immutable.** A trigger refuses UPDATE and DELETE. A correction is a new version.
- **The first version is always material.** A trigger refuses an insert with `requires_reacceptance =
  false` when no version exists yet, so "the version an employer must have accepted" always has an answer
  once any terms exist.
- **Nothing is seeded.** Publishing terms that every employer must accept is a deliberate operator act
  against a text a lawyer has seen, not something a migration decides — the same position 0028 took for
  the privacy notice. Until a version is published, publishing jobs behaves exactly as it does today.
- **Legal text is never presented as final unless it is.** The only text in the repository is
  `docs/legal/employer-terms-DRAFT-for-legal-review.md`, marked DRAFT throughout. A version published as
  `DRAFT_FOR_LEGAL_REVIEW` is labelled "Draft — pending legal review" on every screen that shows it, on web
  and Android. `LEGAL_APPROVED` needs a reference, so an approval cannot be claimed without saying whose.

### `employer_terms_acceptances`

| Column | Type | Rule |
| --- | --- | --- |
| `id` | uuid PK | |
| `employer_id` | uuid → organizations | must be an `EMPLOYER` organisation (trigger) |
| `terms_version` | text → employer_terms_versions | |
| `accepted_by_user_id` | uuid → users | |
| `accepted_role` | text | `EMPLOYER_OWNER` only |
| `accepted_at` | timestamptz | `now()` |
| `correlation_id` | text | |

- `UNIQUE (employer_id, terms_version)`: one acceptance per version per employer; a second click is a
  no-op answered with the existing record.
- Append-only (trigger). An acceptance is never withdrawn by editing it; an employer that no longer
  accepts the terms stops using ONE, and operations suspend it.

### The rule: who must have accepted what, and when it bites

- **Required version** = the most recently published version with `requires_reacceptance = true`.
- An employer **has accepted current terms** when it accepted the required version or any version
  published after it. A non-material version (a typo fix) does not ask anyone to accept again.
- **Only owners accept** (the goal: "acceptance by an owner"). Admins and recruiters read the terms and
  the status. Accepting is `organisation.manage` in the §5.1 matrix, so a PENDING or UNDER_REVIEW employer
  can accept before verification, and a SUSPENDED or REJECTED one cannot.
- **What it gates:** the acts that put a job in front of students anew — publish (from DRAFT or PAUSED),
  reopen, and requesting or resubmitting a campus drive. The check is in the guarded publish UPDATE itself
  (and re-read under the organisation lock on the other routes), so an acceptance and a publish cannot race.
  Refusal: 403 `EMPLOYER_TERMS_NOT_ACCEPTED`.
- **Never retroactive.** Publishing a new material version pulls nothing: jobs already live stay live,
  applications continue, candidate access is unchanged, and editing a live job (which saves a new version
  of a job that is already published) is not gated. Only the next publish waits for the owner.

**Rejected: gate every employer write.** Refusing interviews and offers to an employer mid-process
because the terms moved would hurt the candidates in that process more than the employer. The goal names
publishing; that is where the gate goes.

**Rejected: a grace period after a material change.** It is a reasonable product choice but a guess
about a legal need; it can be added as a column later without changing the rule above.

## Decision 2: grant expiry runs in the daily retention worker

`employer_applicant_access_grants.expires_at` (0001) exists and the shared live-grant predicate
(EMP-SR-01) already treats an expired grant as no grant on every request, so an employer with an expired
grant already loses the candidate, the résumé download and the messages at once. What was missing is the
job that makes expiry durable and visible: without it an expired grant still reads as unrevoked in the
table, in operator tooling and in anything later built on `revoked_at` alone (exports, EMP-17).

- `revokeExpiredApplicantGrants` stamps `revoked_at = now()` on every grant whose `expires_at` has passed
  and which is not yet revoked, in bounded batches, and writes one `employer_applicant_access.expired`
  outbox event per grant (no actor: it is the system, and `audit_events` requires a person). The
  database clock decides; nothing is computed in Node.
- It runs in `run-privacy-worker.ts`, the daily one-shot retention job that already executes deletions and
  erases expired message text — never in a request handler.
- **Decision 10.2 #7 (180 days after close) is kept stricter.** Today every application close (hire,
  reject, withdraw, decline new terms, deletion) revokes the grant at once. A 180-day tail would *widen*
  employer access, so it is not introduced; the sweep only acts on grants that do carry an `expires_at`.
- **Deletion propagation** is already complete (EMP-SR-02): an open deletion request withholds the person
  from every employer read, and executing the deletion revokes every grant first. EMP-16 adds no second
  path.

## Decision 3: purges never take what a case or a hold needs

The one retention purge that touches hiring data, the EMP-10 message-text erasure, already skips a
conversation that is evidence on an open trust case. EMP-16 adds the other half of the rule: it also
skips any conversation whose student is under an active `data_retention_holds` row (legal obligation,
safety investigation, employer accountability case, dispute, regulatory request). Deletion execution
already refuses to run while a hold is active. Grant expiry is not a purge — it ends access and deletes
nothing.

## Decision 4: trust-case participation — one statements table, state moves on the existing timeline

**Chosen.** One new append-only table, `trust_case_employer_statements`, holds what passes between
operations and the employer that is the subject of a case:

| Column | Type | Rule |
| --- | --- | --- |
| `id` | uuid PK | |
| `case_id` | uuid → trust_cases | |
| `employer_id` | uuid → organizations | the subject employer; must be an `EMPLOYER` organisation (trigger) |
| `kind` | text | `ALLEGATION_SUMMARY`, `DECISION_SUMMARY` (written by operations) or `EMPLOYER_RESPONSE`, `EMPLOYER_APPEAL` (written by the employer) |
| `author_side` | text | `OPERATIONS` or `EMPLOYER`; a CHECK ties it to the kind |
| `body` | text | 1–4,000 characters |
| `author_user_id` | uuid → users | |
| `created_at` | timestamptz | `now()` |
| `correlation_id` | text | |

- One `EMPLOYER_APPEAL` per case (partial unique index): an employer appeals a decision once; operators
  decide it (APPEALED → REOPENED or CLOSED), as the 0032 state machine already says.
- Append-only (trigger): a response or an allegation is never rewritten after the other side has read it.

**The state moves stay in `trust_case_events`,** so "employer responses and appeals appear on the operator
case timeline" is literally true: a response writes the statement *and* the event AWAITING_RESPONSE →
UNDER_INVESTIGATION (reason `EMPLOYER_RESPONDED`, actor the employer's owner or admin); an appeal writes the
statement *and* ACTIONED or CLOSED → APPEALED (reason `EMPLOYER_APPEAL`). The self-review trigger is
untouched; an employer never moves a case to a deciding state. The operator case detail returns the
statements alongside the events, evidence and actions.

**Rejected: put the response in `trust_case_events.note`.** A note is the operator's internal remark
(≤ 2,000) and has no author side; making it employer-visible text would turn every internal note into a
possible disclosure.

**Rejected: `trust_case_evidence` with a new kind.** Evidence is what operators weigh, attached by
operators; it may include the reporter's statement. Mixing the employer's own words into it would make the
employer-facing view a filter over the most sensitive table in the case, instead of a table that holds
only what may be shown.

### What the employer sees — and never sees

A case is **visible to an employer** only when (a) its subject is that employer's organisation, or a
version of one of that employer's jobs, and (b) operations has either asked the employer to respond
(the case has been AWAITING_RESPONSE) or decided it (DECIDED). A case still being triaged is not shown:
disclosing it early would tip off an employer under investigation and tells them nothing they can act on.

The employer's view carries: the case type, an employer-facing status, when they were asked to respond
and when it was decided, the subject (the organisation, or the job's title and version number), the
allegation and decision summaries operations chose to share, the enforcement actions against them (they
are the ones bound by them, so they must know — action, from, to, whether reversed), their own responses
and appeal, and an evidence summary limited to their own material (the detector signal codes on their own
job, their own job version). Every other evidence item is counted, not described.

Never in any employer response: the reporter or anything about them (no reporter id, no reporter
statement, no message text, dates or recipient of a reported conversation), severity, assignee, operator
identities, internal notes, the opening time (which could be matched to a candidate's report), any student
data. Operators write the allegation summary in their own words; the operator screen says it will be
shown to the employer.

**Asking for a response needs something to respond to.** For a case whose subject is an employer, the move
to AWAITING_RESPONSE is refused (`TRUST_CASE_SUMMARY_REQUIRED`) until an allegation summary has been shared.
The operator route that shares a summary and asks for the response does both in one transaction.

**Who acts for the employer:** owners and admins read, respond and appeal; recruiters do not (the
accountable people answer for the organisation). The routes use a new `trust.cases` action group that is
allowed in **every** organisation state — §5.1 says a SUSPENDED or REJECTED employer may "read own
organisation status and respond to trust cases only", and a suspended employer is exactly the one most
likely to need to appeal.

## Settings screen (existing label)

The recruiter portal's **Settings** item (owners and admins; recruiters keep the existing "managed by your
owner or admin" state) shows: the terms status (required version, whether and when it was accepted and by
whom, the text with its DRAFT label, an Accept button for owners), retention information (read from the
constants the code enforces, not written as prose that can drift), the caller's own notification
preferences (the existing per-person `notification_preferences` row, as institution staff already have),
and the employer's trust cases with respond and appeal forms. A suspended or rejected employer's status
page shows the trust cases too, so the only place they can act is not hidden behind the gate.

## Privacy: export and deletion

- `employer_terms_acceptances`, `employer_terms_versions` and `trust_case_employer_statements` are the
  organisation's and operations' records, written by staff acting in their role. They are not a student's
  data and are not in the student data export. When a staff member deletes their account, the `users`
  row is anonymised in place, so these rows keep pointing at an anonymous person and the organisation's
  record stays intact.
- No student data is written to any of the three tables. The one route by which student-derived text could
  enter them is an operator's allegation summary; the operator screen states that it is shown to the
  employer and must not identify the reporter.

## Events

Registered in `packages/events/src/index.ts`: `employer.terms.published`, `employer.terms.accepted`,
`trust.case.employer_statement.recorded`, `employer_applicant_access.expired`. No consumer is added:
the outbox row is the durable record, and in-app notices to employer owners are a follow-up (they need
the notification kind CHECK widened).

## Open points (decisions for Divakar)

1. **Legal text.** The terms in the repository are a DRAFT for legal review. Recommendation: publish a
   version to employers only after legal review, as `LEGAL_APPROVED` with the reviewer's reference. The
   product allows publishing a clearly-labelled draft for a pilot; that is his call.
2. **Only owners accept** (goal text) although the §5.1 matrix lists admins for "employer terms".
   Recommendation: owners only.
3. **180-day tail after close (10.2 #7).** Kept stricter: every close revokes at once.
4. **Appeals:** one per case, no time window. Recommendation: add a window (for example 30 days from the
   decision) only when a policy text sets one.
5. **Publishing terms is single-operator** (`OPS_ORG_MANAGE`, audited, reason-coded). Recommendation: move
   it behind an OPS-02 approval if material versions become frequent.
6. **Closed-case retention** (0032 design, open point 4) is still undecided; these statements follow the
   case.
