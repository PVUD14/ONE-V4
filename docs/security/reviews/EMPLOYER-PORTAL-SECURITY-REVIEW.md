# Employer Portal Security Review (EMP-18, full)

> This is the EMP-18 security review of every employer module shipped so far (EMP-01 to EMP-17,
> with EMP-13 and EMP-14 built behind flags that are off). It maps each EMP-18 threat to the
> controls in code and the tests that prove them, re-checks every finding from the first (EM1)
> version of this review, opens new findings, and records what is knowingly left in place as a
> documented residual risk. It exists because EMP-18 acceptance requires every threat to map to a
> test or a documented residual risk. The first version (2026-09-26, base `6864332`) covered
> EMP-01 to EMP-04 only and recorded no residual risks; this version supersedes it.

| | |
|---|---|
| Review target | `719eb34` (branch `docs/doc-2`, base `onev4/feat/plan-phases-0-to-2`) |
| Date | 2026-10-01 |
| Scope | EMP-01 workspace, EMP-02 team, EMP-03 organisation state, EMP-04 company profile and access request, EMP-SR-01/02 grant fix, EMP-05 job lifecycle, EMP-06 eligibility and stages, EMP-07 snapshot, candidate view and résumé, EMP-08 notifications, EMP-09 interviews and scorecards, EMP-10 messages, EMP-11 campus drives (employer and college sides), EMP-12 assessments, EMP-13 skill evidence (flag `employer.skill-evidence`, off), EMP-14 talent pool (flag `employer.talent-pool`, off), EMP-15 dashboard and reports, EMP-16 terms, settings and trust cases, EMP-17 exports. Student-side routes are included where they decide what an employer can see. |
| Out of scope | Operations-console internals (reviewed in `OPERATIONS-CONSOLE-SECURITY-REVIEW.md`), the institution portal beyond campus drives (`INSTITUTION-PORTAL-SECURITY-REVIEW.md`), infrastructure and production configuration (production is `https://oneby8.com` on AWS, ADR-041; only Divakar touches it). |
| Method | Code reading at the review target. Controls are cited as `path:line`. Tests are cited as `spec › test name`, found by searching the spec files; where no test exists the document says so. The progress log (`docs/employer/EMPLOYER_PROGRESS.md`), design notes and ADRs were used to find code; every claim was checked against the code, and where they disagree the code wins (§12). No code or test was run for this review. |
| Normative source | ONE Program Goal, Appendix 2 §5 (§5.1 authorisation, §5.2 candidate data, §5.3 evidence not readiness, §5.4 fairness, §5.7 audit, §5.8 fraud, §5.9 errors), §6.3 minimum tests, §10.1 risks, EMP-18. |

Paths are under `apps/api/src/http/` unless they start with `apps/`, `packages/` or `docs/`.

## 1. What this means for Divakar

- The serious problem from the first review is fixed. An employer now sees a candidate only while
  the student's sharing (the applicant-access grant) is live; withdrawing, being rejected or
  hired, or asking for deletion stops the next request on every screen, the résumé link,
  messages, scorecards, assessment results and exports.
- No employer screen or file shows readiness. Several modules now have tests that walk every
  field of their responses to prove it, but there is still no single test across all employer
  screens.
- Four new problems are open. Two matter most: a job that asks students to pay a fee is only
  flagged, not refused, when it is first published; and a job aimed directly at a college
  reaches its students without the placement office approving a campus drive.
- Several earlier problems are still open, mostly small. The one most likely to cause confusion
  is that a person who belongs to two employers works in the first one on most web screens even
  after choosing the second.
- Thirteen risks are recorded as accepted-but-unfixed (§10), each with you as the owner and a
  decision pending unless one was already taken.

## 2. Conclusion

The employer portal is sound on its core promises: every employer route goes through the §5.1
helper; candidate data flows only through the live grant predicate
(`packages/persistence/src/employer-authentication.ts:18-44`); nothing an employer reads carries
readiness; exports neutralise formulas and contain only live-grant candidates; the talent pool
and skill evidence stay dark behind their flags.

| Severity | Open | Fixed since the EM1 review | Opened in this review |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 1 (EMP-SR-01) | 0 |
| Medium | 8 | 1 (EMP-SR-02) | 2 (EMP-SR-21, EMP-SR-22) |
| Low | 8 | 5 (EMP-SR-14, 16, 17, 18, 19) | 2 (EMP-SR-20, EMP-SR-23) |
| **Total** | **16** | **7** | **4** |

EMP-SR-08 (Medium) and EMP-SR-15 (Low) are counted as open but are partly fixed: what remains is
confined to the pre-existing pipeline-move, offer, feedback and audience routes.

## 3. Files reviewed

API controllers and helpers: `employer-organisation-state.ts`, `employer-hiring.controller.ts`,
`employer-job-lifecycle.controller.ts`, `opportunity-requirements.ts`,
`employer-skill-catalogue.controller.ts`, `employer-candidate-view.controller.ts`,
`interview-scheduling.ts`, `employer-scorecard-templates.controller.ts`,
`application-messages.controller.ts`, `campus-drives.controller.ts`, `campus-drives.ts`,
`campus-drive-nominations.controller.ts`, `employer-assessments.controller.ts`,
`skill-evidence.ts`, `skill-evidence.controller.ts`, `talent-pool.ts`, `talent-pool.controller.ts`,
`employer-reports.ts`, `employer-reports.controller.ts`, `employer-settings.controller.ts`,
`employer-trust-cases.controller.ts`, `operations-employer-terms.controller.ts`,
`employer-terms-gate.ts`, `trust-safety.controller.ts`, `employer-applicant-export.ts`,
`employer-applicant-export.controller.ts`, `institution-export-csv.ts`, `student-hiring.controller.ts`,
`privacy-deletion.ts`, `employer-team.controller.ts`, `employer-company-profile.controller.ts`,
`employer-access-requests.controller.ts`, `operations-institution-onboarding.controller.ts`,
`apps/api/src/run-privacy-worker.ts`, `apps/api/src/assistant/help-articles.ts`.

Packages: `packages/persistence/src/employer-authentication.ts`, `repositories.ts`,
`hiring-notifications.ts`, `application-messages.ts`, `employer-terms.ts`; `packages/hiring/src/`
(`eligibility.ts`, `opportunity-requirements.ts`, `interview-scheduling.ts`,
`application-messages.ts`, `campus-drives.ts`, `review-signals.ts`).

Web: `apps/web/src/rolePortal/employer.tsx`, `rolePortalPages.tsx`, `rolePortalConfig.ts`,
`staffDashboardsV3.tsx`, `hiringPages.tsx`, `helpFaqPanel.tsx`, and the employer pages for each
module. Android: read only to confirm that employer screens are keyed by the chosen workspace and
carry no readiness.

Tests searched: every `*.spec.ts` and `*.test.ts` under `apps/api/src/http/` whose name starts
with `employer-`, `hiring`, `talent-pool`, `skill-evidence`, `campus-drive`, `application-messages`
or `student-hiring`, plus `packages/persistence/test/employer-authentication.integration.test.ts`
and the web tests named in §4.

## 4. Threats

### 4.1 Cross-employer data access

**Controls**
- §5.1 helper: `requireActiveEmployer` = an ACTIVE membership whose organisation and employer
  scope equal the path id, in an allowed role, then the organisation's state
  (`employer-organisation-state.ts:71-86`, refusal rules `:56-63`). Split form
  `requireEmployerMembership` + `assertEmployerState` (`:88-108`) is used by team, profile,
  settings, trust cases, lifecycle edits and export.
- Every new module's queries filter on the employer: candidate view and résumé
  (`employer-candidate-view.controller.ts:158-162`, `:196-199`), messages
  (`application-messages.controller.ts:74-230`), drives (`campus-drives.controller.ts:396-520`),
  assessments, reports (`employer-reports.controller.ts:78-274`), export
  (`employer-applicant-export.controller.ts:60-110`), talent pool (`talent-pool.controller.ts:361-530`).
- Talent-pool cards are addressed per employer: `md5(listing id : employer id)`
  (`talent-pool.ts:127-130`), so two employers cannot correlate a card.
- Reports count only the caller's applications.

**Tests:** `employer-candidate-view.integration.spec.ts › refuses without a token, for another
employer, an ended membership, a suspended or unverified organisation, and a malformed id`;
`application-messages.integration.spec.ts › keeps each conversation to its own student and its own
employer`; `employer-reports.integration.spec.ts › refuses another employer's recruiter and never
counts another employer's applications`; `employer-applicant-export.integration.spec.ts › refuses a
recruiter, another employer, an ended membership, a missing token and another employer's job`;
`talent-pool.integration.spec.ts › requires a signed-in, active member of a verified, active
employer`; `employer-terms-trust.integration.spec.ts › shows an employer only the cases about
itself, with its own job evidence`; `campus-drives.integration.spec.ts › refuses callers without a
token, from another organisation, and employers not in good standing`;
`employer-assessments-emp12.integration.spec.ts › keeps each bank to its owner at the API and in
the schema`; `employer-interview-scheduling.integration.spec.ts › needs a token, refuses another
employer, and refuses a suspended employer on every route`; plus the EM1 tests
(`employer-team.integration.spec.ts › refuses another employer, an ended membership and a suspended
membership`; `hiring.integration.spec.ts › does not let a rival employer touch the opportunity`).

**Open findings:** EMP-SR-03 (web acts on the first employer membership).

### 4.2 Insecure direct object references on applications and résumés

**Controls**
- Application routes resolve the application by id **and** employer
  (`employer-hiring.controller.ts` `requireOwnedApplication`), then the live grant.
- **Résumés** (EMP-07): a link is issued only under the live grant (share-locked) and only for a
  readable, un-erased snapshot file of this employer's application
  (`employer-candidate-view.controller.ts:148-180`). The token is 32 random bytes, stored only as
  a SHA-256 digest, lives 60 seconds (database clock), and is consumed in one UPDATE that also
  matches the application, the employer and the **issuing user** (`:196-203`). The grant is
  checked again at redemption (`:206`). The file is sent as an attachment with `nosniff` and
  `no-store`, and the filename is reduced to ASCII (`:220-226`, `:252-254`).
- Message threads, assessment results and evidence are read by application id under the caller's
  employer and the grant.

**Tests:** `employer-candidate-view.integration.spec.ts › issues a 60-second link, serves the bytes
once as an attachment to the recruiter who asked, and audits both`, `› refuses an expired link, a
forged token, a link after the grant ends, and a résumé-less application`, and the case in `›
refuses without a token…` that calls the caller's own employer path with another employer's
application id (`:313`); `application-messages.integration.spec.ts:212-213` (same pattern);
`employer-assessments-emp12.integration.spec.ts:458`; `skill-evidence.integration.spec.ts ›
refuses without a token, another employer, an ended membership, an inactive employer, a malformed
id and an expired or deleting grant`.

**Residual risks:** R-04 (résumé token in the URL query string).

### 4.3 Grant bypass (`employer_applicant_access_grants`)

**Controls**
- One predicate, `liveApplicantGrantCondition` (`packages/persistence/src/employer-authentication.ts:18-30`):
  not revoked, not expired, and no open deletion request for the student. Used by
  `applicationHasLiveApplicantGrant` (`:38-44`) in every list, and `assertEmployerApplicationAccess`
  in every write (lock option for mutations).
- Created only in the student's apply transaction (`student-hiring.controller.ts:546`); revoked on
  withdrawal (`:743`), on terms decline, when the employer rejects or hires
  (`employer-hiring.controller.ts:410-417`), and on executed deletion (`privacy-deletion.ts:124`).
- Lists withhold the person per row (`candidateAccess: false`); writes refuse 403. Exempt by
  design: cancelling an interview, withdrawing an offer, releasing feedback to a rejected
  candidate, counts-only reads.
- Every module after EMP-SR-01 reuses the predicate: candidate view and résumé, messages (both
  sides), scorecards, assessment invites and results, evidence panel and filter, export (inside
  the audit transaction, `employer-applicant-export.controller.ts:100`, `:108`).
- Paths that do **not** create a grant: campus drives (a drive gives the employer nothing,
  ADR-038), nominations (the grant appears only when the student accepts and applies), talent
  pool (identity only through apply). Grant expiry sweep: `revokeExpiredApplicantGrants`
  (`packages/persistence/src/employer-terms.ts:229`), run daily by `run-privacy-worker.ts:54`.

**Tests:** `employer-applicant-access.integration.spec.ts › serves the candidate to every route
while the grant is live`, `› withholds the person from every read and refuses every write on the
next request after the grant is revoked`, `› withholds the person once the employer rejects them,
and still lets the employer release feedback`, `› treats an expired grant as no grant`, `›
withholds the person while a deletion request is open, and restores the view if the student
cancels it`, `› revokes every grant when the deletion is executed`;
`employer-terms-trust.integration.spec.ts › removes candidate access the moment a grant expires,
and the daily job makes it durable`; `campus-drive-nominations.integration.spec.ts › nominates
eligible students, shows each who nominated them and what would be shared, and gives the employer
only those who opt in`, `› withdrawing the application withdraws the consent and ends the
employer's access`; `talent-pool.integration.spec.ts › invites through the card to an invite-only
job; the employer learns who it was only when the student applies`;
`application-messages.integration.spec.ts › refuses both sides when the grant is revoked, expired,
or the student asks to be deleted`; persistence `employer-authentication.integration.test.ts ›
denies suspended employer memberships and revoked or expired grants`.

**Open findings:** none. EMP-SR-01 and EMP-SR-02 are fixed (§5).
**Residual risks:** R-09 (sends an offer and some reads check the grant without a row lock).

### 4.4 Readiness leakage

**Controls**
- No employer controller selects a readiness, mastery or gap column; the mentions of readiness in
  employer code are comments that say so (`employer-assessments.controller.ts:16-17`,
  `employer-candidate-view.controller.ts:13`, `talent-pool.ts:12`, `skill-evidence.ts:10`).
- Evidence (EMP-13) and talent-pool cards (EMP-14) are lists of items — type, source, date,
  unaided — never a band, score, count, percentage, stage or rank (ADR-043, ADR-044).
- Eligibility shows outcome and basis, never figures. Screening scores are the employer's own
  test and never touch readiness. Exports refuse a header naming a forbidden field
  (`employer-applicant-export.ts:44-53`, `:120`). Reports refuse unknown query parameters
  (`employer-reports.controller.ts:268`).

**Tests:** `skill-evidence.integration.spec.ts › keeps readiness out of every employer response that
now carries evidence (contract)`; `talent-pool.integration.spec.ts › shows a minimal card with no
name, contact, college, identifier, readiness, stage or count; addresses it per employer; audits
search and view`; `employer-applicant-export.integration.spec.ts › writes no readiness, no
identifier, no roll number and no protected attribute`; `employer-applicant-export.test.ts ›
refuses to build a document whose header names a forbidden field`;
`employer-candidate-view.integration.spec.ts › previews what will be shared — name, education,
qualifications without figures, links, the chosen résumé — and nothing readiness-related`;
`employer-job-lifecycle.integration.spec.ts › returns no readiness, score or gap field in the detail
response`; `employer-assessments-emp12.integration.spec.ts › shows one candidate's results with a
per-question breakdown, audited, and nothing about readiness`; `employer-assessments.integration.spec.ts
› shows the employer no readiness band alongside the score`, `› writes nothing to evidence, mastery
or readiness, and moves no application`; `employer-eligibility-stages.integration.spec.ts › uses a
self-reported record where nothing is verified, and flags it to the employer without the figure`;
`campus-drives.integration.spec.ts` (`noReadiness` helper, `:134`); plus the EM1 team and profile
tests.

**Open findings:** EMP-SR-07 (no single all-routes contract test).

### 4.5 Scraping through search or exports (including the talent pool)

**Controls**
- **Exports** (EMP-17): owners and admins only; one job per file; live-grant candidates only;
  snapshot fields only; contact details only from Shortlisted; 5,000 rows; 20 exports per person
  per employer per 24 hours under an advisory lock (`employer-applicant-export.controller.ts:84-104`);
  a fixed reason list; every export audited with the application ids and SHA-256 before the
  bytes leave.
- **Talent pool** (EMP-14, flag off): at least one filter; only the listed filter keys
  (`talent-pool.ts:224-225`); up to 5 skills; 25 a page, 8 pages, no total; a neutral order per
  employer; per-employer pseudonymous cards with no identity; every search and card view audited
  (`talent-pool.controller.ts:432`, `:463`); with the flag off nothing is read
  (`talent-pool.ts:42`).
- **Evidence filter**: narrows the employer's own applicant list, never re-orders, audited
  (`employer-hiring.controller.ts:349`).
- **Reports**: suppressed below 5 (`employer-reports.ts:6-7`), no candidate rows.
- **Lists**: messages inbox keyset-paginated (max 200); hiring lists still fixed `LIMIT 500`.

**Tests:** `employer-applicant-export.integration.spec.ts › allows 20 exports per person per
employer in 24 hours and refuses the next without writing anything`, `› writes the live-grant
candidates exactly as the fixture, and leaves out withdrawn, expired and deleting students`, `›
exports only Shortlisted onward when asked, and an admin may export as well as the owner`;
`talent-pool.integration.spec.ts › keeps one neutral order per employer, unrelated to evidence or
recency, and pages without a total`, `› refuses anything that is not a filter — so no protected
attribute — and a search with no filter`, `› offers nothing, reads nothing and shows nothing while
the flag is off; leaving stays possible`; `skill-evidence.integration.spec.ts › narrows to live
applicants who share qualifying evidence for the skill, in the list's own order, and audits the
use`; `employer-reports.test.ts › withholds a whole group under 5 and never returns a raw small
count`; `application-messages.integration.spec.ts › pages the conversation and the inbox with
bounded, keyset cursors`.

**Open findings:** EMP-SR-20 (unsuppressed `hiring-analytics` still reachable).
**Residual risks:** R-03 (talent-pool search has no rate limit), R-08 (report suppression is per
table), R-13 (hiring lists unpaginated at 500).

### 4.6 Messaging abuse

**Controls**
- Employers start a conversation only from SHORTLISTED while the application is open
  (`packages/hiring/src/application-messages.ts:12-13`); both sides need the live grant.
- Text only, ≤ 2,000 characters, no attachments; links flagged and never rendered as links
  (`application-messages.controller.ts:500`); a "never pay a fee" warning for students.
- Limits (`packages/hiring/src/application-messages.ts:31-39`): 10 per side per thread per hour
  (thread row locked), three employer messages in a row without a reply, 200 per employer per hour,
  50 new threads per employer per day, 60 per student per hour.
- Students mute and report; a report opens or joins one trust case per conversation, HIGH for a
  payment request, with the thread as evidence; the employer is told nothing. Notices never carry
  the text. Retention 180 days after the grant ends, held while a case or hold needs it.
- Append-only messages (trigger), erased on deletion.

**Tests:** `application-messages.integration.spec.ts › lets the team start it from SHORTLISTED
onward…`, `› stops an employer after three unanswered messages and a student after ten in an hour
in one conversation`, `› flags a message that carries a link, for both sides to see`, `› refuses
unknown fields, empty or overlong text and attachments, and writes nothing`, `› opens one case per
conversation, keeps adding to it, and tells the employer nothing`, `› lets a student report after
the employer lost access, and never lets a message be rewritten or deleted`, `› erases text 180 days
after the grant ended, but not while a report on it is open`; `employer-terms-trust.integration.spec.ts
› never erases message text a retention hold still needs`.

**Residual risks:** R-01 (employer messages are not scanned for payment demands), R-05
(per-employer limits counted without a global lock). No test covers the per-employer hourly and
new-thread limits; they are recorded in R-05.

### 4.7 Fake employers

**Controls**
- Verification before reach: unverified employers draft only; suspended and rejected do nothing
  but read status and trust cases (`employer-organisation-state.ts:56-63`). Students see only jobs
  of employers in good standing (`student-hiring.controller.ts:909`); suspension pauses every
  published job. Public access request creates nothing and cannot enumerate (EM1, unchanged).
- Payment demand: recorded as a review signal on create and publish
  (`employer-hiring.controller.ts:177`, `:237`, `:1164-1188`); **refused** on an edit to a live job
  (`employer-job-lifecycle.controller.ts:249`, `:718`) and in company "About" text
  (`employer-company-profile.controller.ts:219-223`).
- Terms gate (EMP-16): publish, reopen and drive request/resubmit refused until an owner accepts
  the current terms, once terms are published (`employer-terms-gate.ts:20-21`;
  `employer-job-lifecycle.controller.ts:413`; `campus-drives.controller.ts:443`, `:514`).
- Drives need the college's approval; only institution-wide placement staff decide
  (`campus-drives.controller.ts:777`). Talent-pool invitations only from a verified employer, to its
  own invite-only job, 20 a day (`talent-pool.controller.ts:491-516`); students can block.
- Trust cases: students report messages; employers respond and appeal once; operators decide.

**Tests:** `employer-hiring.controller.integration.spec.ts › records payment and cross-employer
duplicate signals before publishing, with no penalty`; `employer-job-lifecycle.integration.spec.ts
› refuses stale, malformed, past-dated and payment-demanding edits, and edits to a withdrawn job`;
`employer-terms-trust.integration.spec.ts › refuses to publish, reopen or request a drive until an
owner accepts the current terms`, `› puts the employer response and appeal on the operator case
timeline, and never names the reporter`; `campus-drives.integration.spec.ts › gives the employer no
way to make a drive live, and lets the college reject or ask for changes with a reason`;
`talent-pool.integration.spec.ts › allows at most 20 invitations per employer in any 24 hours`, `› a
blocked employer neither finds nor invites the student…`; EM1 access-request tests (unchanged).

**Open findings:** EMP-SR-22 (payment demand flagged, not refused, at create and publish),
EMP-SR-21 (direct college audience bypasses approval), EMP-SR-06, EMP-SR-09, EMP-SR-10,
EMP-SR-11, EMP-SR-12, EMP-SR-13.
**Residual risks:** R-06 (terms are a legal draft; no dual control on publishing them), R-12
(self-reported eligibility values).

### 4.8 CSV injection

**Controls**
- Output neutralisation: `csvCell` prefixes an apostrophe to any cell starting with `=`, `+`, `-`,
  `@`, tab or CR, and quotes every cell (`institution-export-csv.ts:20-31`); the employer export
  reuses it (`employer-applicant-export.ts`, `csvDocument`). The file is sent with BOM, CRLF,
  `attachment`, `no-store`, `nosniff`.
- Input-side refusal of a leading `=+-@` on some hiring fields remains (harmless).

**Tests:** `employer-applicant-export.test.ts › builds exactly the committed fixture, neutralising
formula-leading cells, with the hash of the exact bytes`;
`employer-applicant-export.integration.spec.ts › writes the live-grant candidates exactly as the
fixture…` (name starting `@`, headline `=HYPERLINK`, summary `-2+3`, phone `+…`);
`hiring-notifications.integration.spec.ts › refuses a preparation note that could run as a
spreadsheet formula`.

**Open findings:** none. EMP-SR-18 is fixed.

### 4.9 Notification spoofing

**Controls**
- Team invitations (EM1, unchanged): constant subject, Operations-held legal name, fixed role
  labels, no employer free text.
- Hiring notices are rendered by one function (`packages/persistence/src/hiring-notifications.ts:127-224`),
  from the verified legal name (`:292`), the job title, stage and, for tests, the test title;
  never the employer's notes, reason codes, joining link or message text; titles truncated to
  160 and bodies to 500 characters. Sent by the outbox consumer after commit, once per event
  (replays write nothing). Talent-pool and drive notices are fixed sentences with the employer's
  verified name and the job title (`talent-pool.controller.ts:531-532`,
  `campus-drives.controller.ts:348-363`).
- Email is recorded `NOT_CONFIGURED` while no sender is configured; nothing claims a send.

**Tests:** `hiring-notifications.integration.spec.ts › writes one in-app notice and one email per
event, and a replayed event writes nothing more`, `› tells a rejected student plainly, without the
private reason code or note`, `› records the email NOT_CONFIGURED when no sender exists, and SKIPPED
when the student turned email off`; `application-messages.integration.spec.ts › tells the student
once per unread run, never with the text…`; `employer-interview-scheduling.integration.spec.ts ›
tells nobody about a completed interview, and records NOT_CONFIGURED for every recipient when no
sender exists`; `employer-assessments-emp12.integration.spec.ts › writes one in-app notice naming
the employer, role and test, with no score or identifier`; EM1 team-invitation tests.

**Open findings:** EMP-SR-05 (no rate limit on team invitations), EMP-SR-04.
**Residual risks:** R-02 (employer-written job and test titles appear in notice titles).

### 4.10 Role matrix, organisation state, locks, mass assignment, audit, surfaces

These EM1 sections still hold as written in the first version, with these changes:
- **Role matrix.** Exports, terms acceptance and trust-case answers are owner/admin or owner only
  (`employer-applicant-export.controller.ts:44`, `employer-settings.controller.ts:33`,
  `employer-trust-cases.controller.ts:34`). The INTERVIEWER and HIRING_MANAGER roles are still not
  provisionable (`employer-hiring.controller.ts:65-69`); panellists are recruiters.
- **Organisation state.** New action group `trust.cases`, allowed in every state
  (`employer-organisation-state.ts:39`, `:57`). The state matrix now covers the assessment routes
  (`employer-organisation-state.integration.spec.ts:230-234`); every newer module tests SUSPENDED
  and PENDING in its own spec.
- **Locks.** Lifecycle, assessments, interviews, scorecard templates and drives lock the
  organisation row FOR SHARE in the write (`interview-scheduling.ts:45`); see EMP-SR-15 for what
  remains.
- **Mass assignment.** Every route added since EM1 refuses unknown fields; the pre-existing
  transition, offer and audience bodies still ignore them (EMP-SR-08).
- **Surfaces.** The web employer pages still pick the first employer membership (EMP-SR-03);
  Android keys each screen by the chosen workspace.

Tests: `employer-job-lifecycle.integration.spec.ts › refuses a reopen that was waiting on a
suspension that then committed`; `employer-organisation-state.integration.spec.ts › refuses every
employer route to a %s organisation, and says why`; the EM1 tests listed in the first version.

## 5. Findings in detail

### Fixed since the EM1 review (re-verified on `719eb34`)

**EMP-SR-01 — High — FIXED.** Candidate data served without a live grant. Fixed in `7a3e27d`
(tests) and `715e486` (fix): one predicate (`employer-authentication.ts:18-44`) in every candidate
read and write. Proved by `employer-applicant-access.integration.spec.ts` (7 cases, §4.3).

**EMP-SR-02 — Medium — FIXED.** No expiry, no revocation on deletion. Deletion: an open request
withholds, execution revokes (`privacy-deletion.ts:124`; `› revokes every grant when the deletion
is executed`). Expiry: the predicate honours `expires_at`, the daily sweep revokes
(`employer-terms.ts:229`, `run-privacy-worker.ts:54`; `› removes candidate access the moment a
grant expires…`). Nothing sets `expires_at` today because closing revokes at once — a stricter
choice recorded in EMP-07 and EMP-16.

**EMP-SR-14 — Low — FIXED** in `6cced5b` (EMP-12): every student screening query requires the
employer in good standing (`employer-assessments.controller.ts:101`); `› marks the invitation
unavailable and refuses start, answer and submit`.

**EMP-SR-16 — Low — FIXED.** The employer-side outcome route now locks the organisation and
requires the live grant (`employer-hiring.controller.ts:921-925`), which is revoked on withdrawal
and on close. Proved by `employer-applicant-access.integration.spec.ts › withholds the person from
every read and refuses every write…`, which covers `POST interviews/:id/outcome`.

**EMP-SR-17 — Low — FIXED** in `6cced5b`: results ordered by invitation
(`employer-assessments.controller.ts:493`, `:547`); `› lists results in invitation order, never by
score, a page at a time, and audits each read`.

**EMP-SR-18 — Low — FIXED** in `33b12c2` (EMP-17): output neutralisation (§4.8).

**EMP-SR-19 — Low — FIXED** for the three assessment writes, now in the state matrix
(`employer-organisation-state.integration.spec.ts:230-234`). The fourth route, the standalone
`applicant-access` probe, is tested only at the persistence layer; recorded as R-10.

### Still open from the EM1 review

**EMP-SR-03 — Medium — OPEN, wider than before.** `apps/web/src/rolePortal/employer.tsx:47` and
`apps/web/src/staffDashboardsV3.tsx:287` take the first employer membership in the session, while
the gate uses the chosen workspace (`rolePortalPages.tsx:249`). Every page added since EM1 inherits
it: applicants, export (`canExport` is decided from that membership's role), messages, drives,
reports, talent pool, settings. Only Assessments uses the chosen workspace (`rolePortalPages.tsx:431`).
Fix and proving test as in the first version.

**EMP-SR-04 — Medium — OPEN.** Ending a membership leaves that person's pending invitations
acceptable (`employer-team.controller.ts:279-314`).

**EMP-SR-05 — Medium — OPEN.** No rate limit on team invite and resend
(`employer-team.controller.ts:168-217`, `:244-277`). Must be fixed before production email is
switched on.

**EMP-SR-06 — Medium — OPEN.** Access-request limits can block genuine requesters
(`employer-access-requests.controller.ts:62`, `:114`, `:120-131`).

**EMP-SR-07 — Medium — OPEN, narrowed.** Per-module contract tests now exist (§4.4), but no one
spec calls every employer GET. Fix: one spec over the §6 inventory.

**EMP-SR-08 — Medium — PARTLY FIXED.** Fixed for lifecycle, assessments, interviews, drives,
messages, export and terms. Remaining: the pipeline move writes its audit without the
organisation and takes a free-text rejection reason (`employer-hiring.controller.ts:371`, `:402`,
`:420`); sending an offer is not transactional and its audit has no organisation (`:993-1003`);
offer withdrawal, feedback release, audience and create audits have no organisation (`:1030`,
`:492`, `:216`, `:179`); these bodies ignore unknown fields. Proving test: per route, "audit row
with organisation and reason in the same transaction" and "unknown field → 400".

**EMP-SR-09 — Low — OPEN.** Careers URL host check (`employer-company-profile.controller.ts:231-256`).
**EMP-SR-10 — Low — OPEN.** About-text payment detector evadable; no signal for phone or link
(`:219-223`).
**EMP-SR-11 — Low — OPEN.** `emailMatchesWebsite` parent-domain match
(`employer-access-requests.controller.ts:297`).
**EMP-SR-12 — Low — OPEN.** Unsalted SHA-256 rate-limit digest (`:114`).
**EMP-SR-13 — Low — OPEN.** Operations initial invitation mints an owner in any state, on every call
(`operations-institution-onboarding.controller.ts:248-273`).

**EMP-SR-15 — Low — PARTLY FIXED.** Lifecycle, assessments, interviews, scorecard templates and
drives now lock the organisation in the write. Remaining without the organisation lock: the
pipeline move (grant share-locked, `employer-hiring.controller.ts:396`), sending an offer (no
transaction), offer withdrawal, feedback, audiences.

### Opened in this review

**EMP-SR-20 — Low — The unsuppressed `hiring-analytics` route and page are still reachable.**
- Where: `employer-hiring.controller.ts:1040`; `apps/web/src/hiringPages.tsx:1466`
  (`EmployerHiringAnalyticsPage`). EMP-15 recorded this as a limitation; no screen links to them.
- Why it matters: it returns per-employer counts without suppression, the opposite of EMP-15's
  rule for the same figures, and a route nobody uses is a route nobody watches.
- Fix: retire the route and page. Proving test: the route answers 404.

**EMP-SR-21 — Medium — A direct college audience reaches a college's students without its
placement office.**
- Where: the audience route accepts `INSTITUTION` and `INSTITUTION_UNIT`
  (`employer-hiring.controller.ts:76`, `:201-218`); students see such jobs with no drive
  (`student-hiring.controller.ts:911-930`); the one-offer policy applies only where a live drive
  exists (`:500-510`). Recorded as open point 1 of `docs/architecture/campus-drives-table-design.md`.
- Why it matters: ADR-038 makes the placement office the gate to its students. Any verified
  employer can bypass it and the college's placement policy by naming the college as the
  audience. This is the path a fake or unwelcome employer would use (§10.1).
- Fix: refuse new INSTITUTION and INSTITUTION_UNIT audiences, or treat them as a drive request.
  Proving test: an audience naming a college is refused, or the job stays hidden from that
  college's students until a drive is approved.

**EMP-SR-22 — Medium — A job that demands payment is flagged, not refused, when it is created or
first published.**
- Where: create and publish only record review signals (`employer-hiring.controller.ts:177`,
  `:237`, `:1164-1188`); the same wording is refused on an edit to a live job
  (`employer-job-lifecycle.controller.ts:249`) and in company text.
- Why it matters: §5.8 and the §10.1 mitigation ask for a payment-demand refusal. Today the job
  reaches students as soon as it is published, until an operator acts on the signal. The
  inconsistency also means an employer can avoid the edit-time refusal by publishing a new job.
- Fix: refuse `APPLICANT_PAYMENT_DEMAND` at publish (keep the signal for other codes). Proving
  test: publishing a job with a fee demand returns 400 `OPPORTUNITY_PAYMENT_DEMAND` and the job
  stays DRAFT. Changing `› records payment … signals before publishing, with no penalty` needs
  Divakar's decision, since it pins today's behaviour.

**EMP-SR-23 — Low — The one-offer check at apply is not serialised with a concurrent offer
acceptance.**
- Where: `student-hiring.controller.ts:500-510` locks the drives, not the student's offers.
  Recorded as an EMP-11 limitation.
- Why it matters: an acceptance committing during an apply lets that one application through.
- Fix: take an advisory lock per student in both apply and offer acceptance. Proving test: a
  concurrency test holding an acceptance open.

## 6. Route inventory

O = owner, A = admin, R = recruiter. "Group" is the §5.1 action group. Lines are the route
decorators. Every route is also covered by a 401-without-token test in its module spec.

| Method and path (`/api/v1`) | Group / extra checks | Roles | Code | Proving test (spec) |
|---|---|---|---|---|
| GET `/employers/:e/organisation-status` | organisation.status | O A R | `employer-hiring.controller.ts:132` | organisation-state |
| POST, GET `/employers/:e/opportunities` | jobs.draft | O A R | `:156`, `:183` | organisation-state, hiring |
| POST `…/opportunities/:o/audiences` | jobs.draft (EMP-SR-21) | O A R | `:201` | organisation-state |
| POST `…/opportunities/:o/publish` | jobs.publish, locked, terms gate | O A R | `:220` | terms-trust, lifecycle |
| GET `…/opportunities/:o/applications` | candidates, grant per row, `?evidenceSkill` | O A R | `:290` | applicant-access, skill-evidence |
| POST `…/applications/:a/transition` | candidates, grant locked | O A R | `:365` | applicant-access |
| GET `…/candidate-feedback-reasons`, POST `…/applications/:a/feedback` | candidates; feedback only on REJECTED | O A R | `:436`, `:450` | hiring.controller.integration |
| GET `…/my-interviews`, `…/:i`, `…/:i/calendar`; POST `…/:i/outcome` | participant guard + grant | any ACTIVE member | `:506`, `:514`, `:531`, `:541` | hiring.controller.integration, interview-scheduling |
| GET `…/interview-participant-options`, `…/interviews` | candidates | O A R | `:583`, `:617` | organisation-state |
| POST `…/applications/:a/interviews` | candidates, org lock, grant | O A R | `:650` | interview-scheduling |
| POST `…/interviews/:i/state` | candidates, org lock, reason codes, grant (except cancel) | O A R | `:742` | interview-scheduling, applicant-access |
| GET `…/interviews/:i/history`, `…/scorecards` | candidates; scorecards need grant, audited | O A R | `:835`, `:869` | interview-scheduling |
| POST `…/interviews/:i/outcome` | candidates, org lock, grant | O A R | `:905` | applicant-access |
| GET `…/offers`; POST `…/applications/:a/offers`; POST `…/offers/:id/withdraw` | candidates; grant on extend | O A R | `:940`, `:967`, `:1007` | applicant-access, hiring |
| GET `…/hiring-analytics` | candidates (EMP-SR-20) | O A R | `:1040` | hiring.controller.integration |
| GET `…/opportunities/:o`; POST `…/versions`, `…/pause`, `…/close`, `…/reopen`, `…/withdraw` | jobs.draft / jobs.publish, org lock, reason codes, terms gate on reopen | O A R | `employer-job-lifecycle.controller.ts:136-372` | job-lifecycle |
| GET `…/skill-catalogue` | jobs.draft | O A R | `employer-skill-catalogue.controller.ts:31` | eligibility-stages |
| GET `…/applications/:a`, `…/resume`, `…/resume/file` | candidates, grant, single-use token | O A R | `employer-candidate-view.controller.ts:50`, `:148`, `:184` | candidate-view |
| GET, POST `…/scorecard-templates`; POST `…/:t/retire` | jobs.draft, org lock | O A R | `employer-scorecard-templates.controller.ts:43-88` | interview-scheduling |
| GET `…/message-threads`; GET, POST `…/applications/:a/messages` | candidates, grant, limits | O A R | `application-messages.controller.ts:74`, `:130`, `:182` | application-messages |
| GET `…/campus-drive-institutions`, `…/campus-drives`, `…/:d/history`; POST `…/opportunities/:o/campus-drives`, `…/:d/{resubmit,cancel,complete}` | jobs.draft / jobs.publish, org lock, terms gate | O A R | `campus-drives.controller.ts:396-490` | campus-drives, terms-trust |
| Assessment routes (questions, tests, publish, close, invitations, results, per-candidate results) | jobs.draft / jobs.publish / candidates, org lock, grant | O A R | `employer-assessments.controller.ts:123-526` | assessments-emp12, organisation-state |
| GET `…/summary`, `…/reports` | candidates, unknown params refused, reports audited | O A R | `employer-reports.controller.ts:78`, `:130` | reports |
| GET `…/settings`; POST `…/terms/accept`; POST `…/settings/notification-preferences` | organisation.manage; accept owner only | O A R / O | `employer-settings.controller.ts:57`, `:64`, `:98` | terms-trust |
| GET `…/trust-cases`, `…/:c`; POST `…/:c/response`, `…/:c/appeal` | trust.cases (every state) | O A | `employer-trust-cases.controller.ts:45-65` | terms-trust |
| POST `…/opportunities/:o/applicant-export` | candidates, owner/admin, grant, limits | O A | `employer-applicant-export.controller.ts:60` | applicant-export |
| GET `…/applications/:a/evidence` | candidates, grant, flag | O A R | `skill-evidence.controller.ts:111` | skill-evidence |
| GET `…/talent-pool`, `…/search`, `…/cards/:ref`; POST `…/invitations` | candidates, flag, limits | O A R | `talent-pool.controller.ts:361-476` | talent-pool |
| Team, company profile, access request, applicant-access probe, initial invitation | unchanged from the EM1 inventory | — | `employer-team.controller.ts:98-279`, `employer-company-profile.controller.ts:88-98`, `employer-access-requests.controller.ts:106-209` | team, company-profile |
| Operations: GET, POST `/operations/employer-terms`; POST `/operations/trust-safety/cases/:c/request-response`, `…/employer-statements`; GET `…/message-threads` | OPS_ORG_MANAGE / TRUST_SAFETY_INVESTIGATE | operations | `operations-employer-terms.controller.ts:36-42`, `trust-safety.controller.ts:84`, `:161`, `:185` | terms-trust, application-messages |
| College: drive decisions, results, placement policies | institution-wide write scope for decisions | college staff | `campus-drives.controller.ts:533-709` | campus-drives |

Student routes that decide what an employer may see: apply (grant, snapshot, evidence, drive
policy, invitation), withdraw (`student-hiring.controller.ts:401`, `:708`), terms change
(`employer-job-lifecycle.controller.ts:475-510`), messages (`application-messages.controller.ts:240-364`),
evidence (`skill-evidence.controller.ts:51-66`), talent pool (`talent-pool.controller.ts:93-287`).

## 7. Cross-cutting checklist

| Control | Status | Reference |
|---|---|---|
| §5.1 helper on every employer route | Met | §6 |
| Scope / tenant | Met in the API; not met in the web (first membership) | EMP-SR-03 |
| Consent / grant | **Met** on every candidate read and write | §4.3 |
| Audit in the same transaction, with organisation | Met for every module since EM1; not met for pipeline move, offers, audiences | EMP-SR-08 |
| Reason codes from fixed lists | Met except the pipeline rejection reason | EMP-SR-08 |
| Data minimisation | Snapshot only, contact from Shortlisted, card without identity | §4.2, §4.5 |
| Suppression below 5 | Met for reports and college drive results; `hiring-analytics` unsuppressed | EMP-SR-20 |
| No numeric readiness | Met; per-module contract tests, no all-routes test | EMP-SR-07 |
| Error handling (fixed codes, correlation id, no upstream text) | Met | module specs |
| Unknown fields rejected | Met since EM1 except pre-existing hiring bodies | EMP-SR-08 |
| Keyset pagination | Met for team, access requests, messages, drives, assessments results; hiring lists fixed 500 | R-13 |
| CSV safety | Met | §4.8 |
| Rate limiting | Exports, messages, talent-pool invitations, access requests; not team invitations or talent-pool search | EMP-SR-05, R-03 |
| Flags off by default for EMP-13/14, high-risk to enable | Met | `skill-evidence.integration.spec.ts › ships the flag off and marks switching it on as needing a second person`; `talent-pool.integration.spec.ts › migration 0098 is replay-safe and never flips a live switch` |

## 8. Findings register

| ID | Severity | Status on `719eb34` | Title | Location | Target |
|---|---|---|---|---|---|
| EMP-SR-01 | High | **Fixed** (`715e486`) | Candidate data without a live grant | `packages/persistence/src/employer-authentication.ts:18-44` | — |
| EMP-SR-02 | Medium | **Fixed** (`715e486`, `1cfeebe`) | Grant expiry and deletion revocation | `privacy-deletion.ts:124`; `employer-terms.ts:229` | — |
| EMP-SR-03 | Medium | Open (wider) | Web acts on the first employer membership | `apps/web/src/rolePortal/employer.tsx:47`; `staffDashboardsV3.tsx:287` | EMP-02 follow-up |
| EMP-SR-04 | Medium | Open | Invitations survive the inviter's removal | `employer-team.controller.ts:279-314` | EMP-02 follow-up |
| EMP-SR-05 | Medium | Open | No rate limit on team invite and resend | `employer-team.controller.ts:168-277` | before production email |
| EMP-SR-06 | Medium | Open | Access-request limits abusable | `employer-access-requests.controller.ts:62-131` | EMP-04 follow-up |
| EMP-SR-07 | Medium | Open (narrowed) | No all-routes readiness contract test | API specs | follow-up |
| EMP-SR-08 | Medium | Partly fixed | Pipeline move, offers, audiences: audit without organisation, not transactional, free-text reason, unknown fields ignored | `employer-hiring.controller.ts:179`, `:216`, `:371-420`, `:492`, `:993-1030` | follow-up |
| EMP-SR-09 | Low | Open | Careers URL host check gaps | `employer-company-profile.controller.ts:231-256` | EMP-04 follow-up |
| EMP-SR-10 | Low | Open | About-text detector evadable; no signal | `employer-company-profile.controller.ts:219-223` | EMP-04 / EMP-16 follow-up |
| EMP-SR-11 | Low | Open | `emailMatchesWebsite` parent-domain match | `employer-access-requests.controller.ts:297` | EMP-04 follow-up |
| EMP-SR-12 | Low | Open | Unsalted rate-limit digest | `employer-access-requests.controller.ts:114` | EMP-04 follow-up |
| EMP-SR-13 | Low | Open | Initial invitation mints owners in any state | `operations-institution-onboarding.controller.ts:248-273` | EMP-01 follow-up |
| EMP-SR-14 | Low | **Fixed** (`6cced5b`) | Suspended employer's tests reachable | `employer-assessments.controller.ts:101` | — |
| EMP-SR-15 | Low | Partly fixed | Candidate writes without the organisation lock | `employer-hiring.controller.ts:396`, `:967-1030`, `:201`, `:450` | follow-up |
| EMP-SR-16 | Low | **Fixed** (`715e486`, `27fe7dd`) | Employer outcome skipped consent and close | `employer-hiring.controller.ts:921-925` | — |
| EMP-SR-17 | Low | **Fixed** (`6cced5b`) | Results ranked by score | `employer-assessments.controller.ts:493` | — |
| EMP-SR-18 | Low | **Fixed** (`33b12c2`) | CSV neutralisation | `institution-export-csv.ts:20-31` | — |
| EMP-SR-19 | Low | **Fixed** (`6cced5b`); probe → R-10 | State matrix gaps | `employer-organisation-state.integration.spec.ts:230-234` | — |
| EMP-SR-20 | Low | **New**, open | Unsuppressed `hiring-analytics` still reachable | `employer-hiring.controller.ts:1040`; `apps/web/src/hiringPages.tsx:1466` | EMP-15 follow-up |
| EMP-SR-21 | Medium | **New**, open | Direct college audience bypasses drive approval and policy | `employer-hiring.controller.ts:76`, `:201-218`; `student-hiring.controller.ts:911-930` | EMP-11 follow-up |
| EMP-SR-22 | Medium | **New**, open | Payment demand flagged, not refused, at create and publish | `employer-hiring.controller.ts:177`, `:237`, `:1164-1188` | needs Divakar's decision |
| EMP-SR-23 | Low | **New**, open | One-offer check not serialised with acceptance | `student-hiring.controller.ts:500-510` | EMP-11 follow-up |

## 9. Known open items (not findings)

- **Email and workers.** The SMTP sender is built (ADR-042) but not switched on in production, and
  the sender mailbox is still to be set up; every hiring email is recorded `NOT_CONFIGURED`. The
  automation worker that delivers notices and closes jobs at their deadline is not deployed on
  AWS, and the daily privacy timer has not been adapted to the AWS layout
  (`docs/ops/runbook-move-to-aws.md`, `deploy/systemd`). Request-time checks do not depend on them.
- **Uploads** are off on AWS until a virus scanner exists, so production applications carry no
  résumé.
- **Hard gates.** HG-4 approved 2026-10-01 (ADR-043, ADR-044 accepted); both flags still off.
  HG-6 pending: employer terms and the discovery consent are legal drafts.
- **Help & FAQ (EMP-18 item 4) — not done.** The employer persona has three articles
  (`apps/api/src/assistant/help-articles.ts:138-157`: roles and drives, meeting candidates,
  screening tests) plus the shared ones. Missing: team and invitations, company profile and
  access requests, organisation status and suspension, job edits and versions and new-terms
  acceptance, eligibility and stages, Candidate Detail and résumés, interviews and scorecards,
  messages, offers, terms and Settings and trust cases, exports, skill evidence, talent pool.
  Wrong or stale: *Meeting candidates* (`:145-150`) says employers meet candidates through
  profile links or QR codes the student presents and speaks of "readiness scores"; candidates are
  met through the consented application snapshot under the grant, and readiness is a band never
  shown. *Finding your way around* (`:26-31`) says Messages is "an empty inbox by design … once
  messaging launches"; EMP-10 shipped it. *Notifications* (`:33-38`) says nothing about hiring
  notices. *The ONE mobile app* (`:159-164`) describes employer staff as seeing only "live
  monitoring dashboards". The panel (`apps/web/src/helpFaqPanel.tsx`) has no link from an article
  to its SOP, and the article type has no field for one.

## 10. Residual risks

Each is accepted for now, not fixed. Owner: Divakar. "Decision pending" means nobody has decided
to keep it.

| ID | Threat | Risk left in place | Why it is tolerable today | Status |
|---|---|---|---|---|
| R-01 | Messaging abuse, fake employers | Employer messages are not scanned for payment demands (`docs/architecture/application-messages-table-design.md:102`) | Students see a fee warning, links are flagged, reports open a HIGH case | Documented residual risk, owner Divakar, decision pending |
| R-02 | Notification spoofing | Employer-written job and test titles appear in notice titles | Verified employers only; text only; truncated; employer name is the verified legal name | Documented residual risk, owner Divakar, decision pending |
| R-03 | Scraping (talent pool) | Search has no rate limit; many filter combinations can be paged | Flag off; cards carry no identity and differ per employer; every search and view audited | Documented residual risk, owner Divakar, decision pending (EMP-14 decision 9 taken on his behalf) |
| R-04 | IDOR on résumés | The résumé token travels in the URL query, so it can reach proxy logs | 60 s, single use, bound to the issuing user and the live grant | Documented residual risk, owner Divakar, decision pending |
| R-05 | Messaging abuse | Per-employer and per-student limits are counted without a global lock and have no test | Per-thread limits are exact; the rest are brakes, not quotas | Documented residual risk, owner Divakar, decision pending |
| R-06 | Fake employers | Terms text is a legal draft (HG-6); publishing terms has no dual control | Nothing is seeded; publishing behaves as before until terms exist | Pending HG-6; dual control decision pending |
| R-07 | Grant lifecycle | Nothing sets `expires_at`, so the 180-day ceiling never applies | Closing revokes at once, which is stricter | Decided (EMP-07, EMP-16 recommendations) |
| R-08 | Scraping (reports) | Suppression is per table, not across tables | Only facts the employer already holds could be derived | Documented residual risk, owner Divakar, decision pending |
| R-09 | Grant bypass (race) | Sending an offer and the list reads check the grant without a row lock | A withdrawal racing one request can let that one request through | Documented residual risk, owner Divakar, decision pending |
| R-10 | Organisation state | The applicant-access probe route is not in the API state matrix | Persistence tests cover its state checks | Documented residual risk, owner Divakar, decision pending |
| R-11 | Notification spoofing | Notices are not delivered in production (no worker, no email) | Nothing is sent, so nothing can be spoofed; in-app rows are recorded | Operational; resolves with the AWS worker and email set-up |
| R-12 | Fake or gamed eligibility | Self-reported marks count for eligibility | Flagged to the employer as self-reported; verified records preferred | Decided (EMP-06 decision 1) |
| R-13 | Scraping (lists) | Hiring lists are a fixed `LIMIT 500` with no cursor | Employer's own applicants only, grant-filtered | Documented residual risk, owner Divakar, decision pending |

## 11. Threat-to-proof map

| EMP-18 threat | Proved by tests (§4) | Open findings | Residual risks |
|---|---|---|---|
| Cross-employer data access | §4.1 | EMP-SR-03 | — |
| IDOR on applications and résumés | §4.2 | — | R-04 |
| Grant bypass | §4.3 | — | R-07, R-09 |
| Readiness leakage | §4.4 | EMP-SR-07 | — |
| Scraping through search or exports, including the talent pool | §4.5 | EMP-SR-20 | R-03, R-08, R-13 |
| Messaging abuse | §4.6 | — | R-01, R-05 |
| Fake employers | §4.7 | EMP-SR-06, 09–13, 21, 22 | R-06, R-12 |
| CSV injection | §4.8 | — | — |
| Notification spoofing | §4.9 | EMP-SR-04, EMP-SR-05 | R-02, R-11 |
| Role matrix, state, locks, mass assignment, audit | §4.10 | EMP-SR-08, EMP-SR-15, EMP-SR-23 | R-10 |

## 12. Where the progress log and the code disagree

- Commit hashes in `EMPLOYER_PROGRESS.md` are from the goal branches; on this base the same work
  carries different hashes (for example EMP-SR-01 is `7a3e27d`/`715e486` here, `bb9ddc6`/`170bc70`
  in the log). This review cites the hashes on `719eb34`.
- The EMP-13 entry says HG-4 is pending and ADR-043 Proposed; ADR-043 on this base says Accepted
  (2026-10-01). The later EMP-14 entry is right.
- The EMP-15 entry says the Dashboard reads the summary; it does, but for the first employer
  membership, not the chosen workspace (EMP-SR-03).
- The EMP-05 entry's "payment-demand refusal" applies to edits of a live job only; creating and
  publishing record a signal (EMP-SR-22).
