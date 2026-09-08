<!--
ONE · Stream B — Hiring
Owner: Manisha · Created: 2026-09-08
Agent-assisted: yes (Codex) · Reviewed: pending
-->

# Hiring workflow handoff

Recruiter Interviews and Offers now have dedicated screens; Reports contains employer-scoped aggregates. Applicants provides interview scheduling and offer forms. Interview actions support completion, cancellation, no-show, rescheduling with new timestamps, and outcome submission. Offer withdrawal requires confirmation.

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

## Verification

Run `corepack pnpm typecheck` and `corepack pnpm test` with `DATABASE_URL` configured for disposable local Postgres and synthetic data. No server environment file is needed.

The added controller integration suite verifies migration replay, consent timestamp constraints, owner-scoped revocation after closure, rollback on audit failure, duplicate/payment signal persistence, publication without automatic penalties, and employer-scoped analytics. It refuses non-local database hosts. Existing hiring HTTP integration tests remain unchanged.

The new suite sets `beforeAll` to 60 seconds for cold migration startup. Membership fixtures must respect the database role/kind trigger: platform roles require a `PLATFORM` organization, employer roles require an `EMPLOYER` organization and `scope_employer_id`, and institution roles require an `INSTITUTION` organization and `scope_institution_id`.
