<!--
ONE · Stream B — Hiring
Owner: Manisha · Created: 2026-09-08
Agent-assisted: yes (Codex) · Reviewed: pending
-->

# Hiring workflow handoff

Recruiter Interviews and Offers retain integration's stage-filtered applicant entry view. Their “Scheduled interviews” and “Sent offers” switches open the dedicated record screens; Reports contains employer-scoped aggregates. Applicants provides interview scheduling and offer forms. Interview actions support completion, cancellation, no-show, rescheduling with new timestamps, and outcome submission. Offer withdrawal requires confirmation.

## Privacy review required before shipping

The institution-visibility checkbox and adjacent explanation in `apps/web/src/hiringPages.tsx` are **draft copy, not privacy-approved wording**. Obtain privacy review of both before shipping. Review should confirm the recipient institution, active relationship requirement, disclosed fields, excluded compensation/documents/readiness, optionality, and how to revoke consent. No privacy approval has been inferred from implementation authorization.

Per Divakar's handoff, route this review through the DPDP counsel engagement. This is privacy review under ADR-019, not copy review. Pushing the stream branch for review does not approve B4 for shipment.

The checkbox defaults off and resets when an opportunity is opened. Submission passes `institutionVisibilityGranted` as a strict boolean, independently of employer consent. Application submission, consent, history, audits and the submission outbox event commit atomically.

`POST /api/v1/students/me/applications/:applicationId/institution-visibility/revoke` revokes only the authenticated student's institution visibility. It also works after the application closes. Repeated requests preserve the original revocation timestamp. It does not withdraw the application or revoke employer consent.

Migration 0017 adds nullable `institution_visibility_granted_at` and `institution_visibility_revoked_at`, with the ADR-019 timestamp ordering check. Both null is valid. The student application list exposes the two timestamps. Stream C owns the institution read path and must enforce both current consent and active relationship checks on every read, without compensation disclosure.

## Operations handoff — Divakar

Operations routing, UI and review decisions are deferred by the agreed scope. No Operations route was changed.

Migration 0018 stores `opportunity_review_signals`, keyed uniquely by opportunity version, signal code and detector version. Signals start `PENDING`; first and latest detection times are preserved. Create and publish both run the detector. Repeated checks update the existing evidence row; each flagged check records an `opportunity.review_requested` audit with opportunity scope, version ID, detector version and signal codes. No candidate identity or compensation values are included in this audit.

Core should connect an authorized Operations read/review path to this table and audit. The existing Trust and Safety placeholder in `apps/web/src/rolePortalPages.tsx` is the routing handoff. Employer endpoints do not return cross-employer matches or rival identities. No Operations consumer or notification delivery is claimed by this change. A future outbox notification needs a registered event schema in the Core-owned events package; this change does not enqueue an unsupported event.

Divakar's `GET /api/v1/operations/audit-events` read side can identify these audits by action `opportunity.review_requested`. The persisted contract is:

| Signal table field | Type and meaning |
| --- | --- |
| `id` | UUID primary key for the evidence row |
| `opportunity_id` | UUID of the flagged opportunity |
| `employer_id` | UUID of its owning employer |
| `opportunity_version_id` | UUID of the evaluated opportunity version |
| `signal_code` | One of the four codes below |
| `detector_version` | Text; currently `rules-1` |
| `review_state` | `PENDING` initially; schema also permits `REVIEWED` for the Core read/review workflow |
| `first_detected_at` | Timestamp with timezone; preserved on repeated detection |
| `last_detected_at` | Timestamp with timezone; refreshed on repeated detection |

The unique key is `(opportunity_version_id, signal_code, detector_version)`. Composite foreign keys bind the opportunity to its employer and the version to that opportunity. The pending index is on `first_detected_at WHERE review_state = 'PENDING'`.

Each create/publish check that finds signals also writes an audit in the same transaction as the signal upserts:

| Audit field | Value |
| --- | --- |
| `action` | `opportunity.review_requested` |
| `resource_type` | `opportunity` |
| `resource_id` | Opportunity UUID |
| `organization_id` | Employer UUID |
| `actor_user_id` | Authenticated employer actor UUID |
| `outcome` | `SUCCESS` (evidence recorded, not a moderation verdict) |
| `correlation_id` | Request correlation ID |
| `context` | JSON object `{ versionId: UUID, signals: SignalCode[], detectorVersion: "rules-1" }` |

`SignalCode` is `APPLICANT_PAYMENT_DEMAND`, `CROSS_EMPLOYER_DUPLICATE`, `MISSING_COMPENSATION`, or `IMPLAUSIBLE_COMPENSATION`. The audit contains codes, not matched job text, rival employer IDs, compensation amounts or candidate data. A repeated flagged check produces another audit but keeps the same deduplicated evidence rows; Operations should use the table for its queue count and audits for chronology. The detector does not change `review_state` on conflict and does not implement a review decision endpoint.

Detector `rules-1` flags:

- Applicant payment demands using English text patterns, with basic negation and employer-payment exclusions.
- Cross-employer duplicates with the same title and nonempty description, after case and whitespace normalization.
- Missing compensation amount, currency or period.
- Nonpositive compensation, an inverted range, or a range of at least 100:1. These are structural review heuristics, not market salary estimates.

These heuristics can miss paraphrases and non-English demands and can produce false positives. They **never reject publication or penalize an employer**. Matching rows are evidence for human review, not a scam determination. Semantically similar postings and market-based pay plausibility are outside these deterministic rules.

## Analytics definitions

`GET /api/v1/employers/:employerId/hiring-analytics` requires an active employer management membership, matching both organization and employer scopes. SQL groups the employer's complete submitted application set before returning aggregates; list endpoint limits do not cap the report. Draft applications are excluded. Opportunities without applications remain present with zero counts.

Current-stage counts use application state. Reached-stage counts use recorded state history plus submission/current-state evidence. Conversion from A to B is applications that visited both / applications that visited A. Skipped stages are not inferred; a zero denominator produces null (`NA`). These are lifetime figures, not cohort-normalized conversion forecasts. Time-to-offer is the mean elapsed days from submission to first offer extension, excluding missing or reversed timestamps. Each application contributes at most one sample. No candidate identifiers enter the report response.

## B0 and B7 — integration and interviewer handoff

B1–B6 have been rebased onto `origin/integration` at `21adf00`, including migration
`0026_learner_content_reviews.sql`. The rebased work and B7 are on
`stream/b-manisha/interviewer-assignment`; the previously pushed
`stream/b-manisha/interviews-offers-api` history is preserved without a force-push.
This branch includes the existing 0017 and 0018 migrations unchanged. B8 remains
design-only in draft PR #9: 0019 is reserved, but its table design still needs
Divakar's approval. No 0019 migration is included.

The B7 authority is Divakar's restated ADR-026 decision supplied with the task;
the ADR file is not yet present on integration. No membership role or membership
trigger was added. `createInterviewParticipantGuard(db)` injects persistence and
returns the named `requireInterviewParticipant(request, employerId, interviewId)`
function for Core's later extraction. The guard checks trusted ACTIVE employer
scope, then current database membership and a nonremoved assignment on exactly
that employer's interview. Data statements repeat the same assignment predicate.

Core can dispatch `EmployerRecruiterRealityPage` with these exact labels:
`My Interviews`, `Candidate Brief`, and `Scorecards`. They resolve the signed-in
user's employer scopes and call only the participant endpoints below. Core owns
the navigation entries; no shell, sidebar, or authorization package was edited.
Existing recruiter management permissions are not conferred by assignment.

| Endpoint beneath `/api/v1/employers/:employerId` | Contract |
| --- | --- |
| `GET /my-interviews` | `{ interviews: ParticipantInterviewDto[], correlationId }`; at most 200 active assigned interviews in schedule order |
| `GET /my-interviews/:interviewId` | `{ interview: ParticipantInterviewDto, correlationId }`; checks the single-interview guard |
| `POST /my-interviews/:interviewId/outcome` | Same recommendation, optional rating and written feedback fields as the existing outcome form; upserts only the authenticated participant's scorecard, with an atomic audit |
| `GET /interview-participant-options` | Scheduler-only `{ participants: [{ userId, label }], correlationId }`, sourced from ACTIVE employer members; labels are their stored email addresses |

`ParticipantInterviewDto` contains the interview ID for API actions, role title,
round, mode, state, scheduled start/end, the shared candidate fields
(`consentRevoked`, `candidateName`, `candidateEmail`, `institutionStudentId`),
meeting arrangements, role summary/responsibilities, and `canRecordOutcome`.
There are no application/student UUIDs, readiness data, other interviews, or other
interviewers' scorecards in this response. IDs used for API actions are not shown
as interface labels. Candidate identity uses the existing Applicants mapper and
`CandidateIdentity` component: revoked consent renders
“Withdrawn — details no longer shared”. Meeting/contact fields are also masked;
withdrawal disables scoring but retains the redacted assignment until it ends.

Access starts with scheduling/assignment and ends at participant removal,
membership suspension, `COMPLETED`, `CANCELLED`, `NO_SHOW`, or the scheduled end,
whichever applies first. Existing interviews with a null end time expire on their
terminal state/removal. Participant scorecards must be submitted before access
ends; recruiter management retains its existing workflow. Screens refresh on
focus and every 30 seconds, remove expired assignments, and recheck access when
loading a brief or submitting a scorecard. Normal refresh preserves unsaved
scorecard text; revoked/removed access hides the form.

Scheduling accepts optional `participantUserIds` (up to 20 distinct ACTIVE
employer members). Nonempty selections require
`participantVisibilityAcknowledged: true`, with a visible explanation and
unchecked acknowledgement in the scheduling form. Validation, assignment,
`interview.participants_assigned` audit, scheduled audit, and existing scheduled
outbox event commit together. The assignment audit context is
`{ participantUserIds: UUID[], visibilityAcknowledged: true }` on the interview
resource with employer organization scope. The literal `INTERVIEWER` is used
only as the existing `interview_participants.participant_role` value.

## Verification

Run `corepack pnpm typecheck` and `corepack pnpm test` with `DATABASE_URL` configured for disposable local Postgres and synthetic data. No server environment file is needed.

The added controller integration suite verifies migration replay, consent timestamp constraints, owner-scoped revocation after closure, rollback on audit failure, duplicate/payment signal persistence, publication without automatic penalties, and employer-scoped analytics. It refuses non-local database hosts. Existing hiring HTTP integration tests remain unchanged.

B7 adds database-backed checks for own/other interview isolation, cross-employer
denial, nonparticipants, suspended memberships, removed assignments, completed or
expired interviews, consent masking, self-only scorecard upserts, scheduling
acknowledgement, and audit-failure rollback. Screen tests exercise all three exact
route labels, candidate selection, revoked and denied briefs, scorecard writes,
refresh behavior, and the scheduling acknowledgement. Integration's existing
App test retains the stage-filtered recruiter entry views; dedicated record
switches are covered in the owned employer screen test.

The new suite sets `beforeAll` to 60 seconds for cold migration startup. Membership fixtures must respect the database role/kind trigger: platform roles require a `PLATFORM` organization, employer roles require an `EMPLOYER` organization and `scope_employer_id`, and institution roles require an `INSTITUTION` organization and `scope_institution_id`.
