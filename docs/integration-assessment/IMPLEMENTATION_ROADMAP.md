# Implementation Roadmap

This roadmap sequences the V4 and n8n integration as a controlled, documentation-first program. It does not authorize schema changes, imports, workflow deployment, or production runtime changes.

## Roadmap Principles

- Keep PlanThePath's current Postgres, Drizzle, Cognito, RBAC, scoped access, audit, and outbox foundations as the system of record.
- Treat V4 as domain reference material and candidate content, not as a runtime to transplant.
- Treat n8n as an external automation worker for non-authoritative side effects, not as an owner of product decisions, eligibility, access, or readiness.
- Require provenance, licensing, test evidence, idempotency, replay behavior, observability, and rollback at every phase.
- Prefer narrow vertical slices over broad migrations.

## Phase A: Governance And Evidence Freeze

Goal: Turn this assessment into an approved integration program with clear owners and decision gates.

Outputs:

- Approved decision log covering licensing, content ownership, scoring policy, external channels, CRM/calendar vendors, AI boundaries, and retention.
- Frozen source package for V4 evidence, including commit, registry snapshot, build status, and known count discrepancies.
- Frozen source package for n8n evidence, including commit, parsed workflow inventory, malformed file list, and node-risk summary.
- Program risk register with accountable owners.

Dependencies:

- Product owner for target learner and institution scope.
- Legal/privacy owner for content rights and external communications.
- Security owner for automation and AI boundaries.

Exit gates:

- No V4 content is staged without a licensing decision.
- No n8n workflow is piloted without security owner approval.
- All source evidence is reproducible from immutable references.

Rollback:

- No runtime rollback required; this phase is documentation and governance only.

## Phase B: Authorization Consistency And Event Foundations

Goal: Make the current PlanThePath core internally consistent before any integration is layered on top.

Outputs:

- Decision and fix plan for the `TRANSFERRED` membership inconsistency between persistence and helper/in-memory behavior.
- Canonical event envelope for all future integration events.
- Outbox dispatcher design covering locking, retry, dead-letter, idempotency, trace IDs, and payload minimization.
- Event consumer contract for native workers and external n8n callbacks.
- Test plan for event creation, replay, duplicate handling, authorization, and audit.

Dependencies:

- Existing outbox table and audit event model.
- Security-context and scoped-access services.

Exit gates:

- Membership status behavior is resolved and regression tested.
- Outbox events are reliably dispatched to a queue or bus in a non-production environment.
- All integration events carry actor, organization, scope, subject, consent basis where applicable, schema version, and idempotency key.

Rollback:

- Disable dispatcher and leave outbox rows as durable internal records.
- Reprocess only after idempotency and payload compatibility are verified.

## Phase C: Content Provenance And Staging

Goal: Create a safe path for V4 occupational, academic, question, blueprint, and readiness content to enter review without becoming production truth.

Outputs:

- Content staging schema design for source registry records, taxonomy mappings, question banks, blueprint sections, and provenance metadata.
- Import package format with source commit, source path, license label, source hash, transform version, validation report, and reviewer status.
- Content review workflow for SME approval, rejection, revision, archival, and release notes.
- Reconciled count report explaining V4 tracked claims versus independent rebuild observations.

Dependencies:

- Decisions on license rights and initial content slice.
- SME review capacity.

Exit gates:

- Every staged record has source provenance, license status, reviewer status, and deterministic ID mapping.
- No `READY_FOR_SME_REVIEW` item is exposed as production content.
- Count reconciliation is complete or explicitly accepted as a blocker with a release exclusion.

Rollback:

- Remove staged packages by package ID before release.
- Deprecate released content through versioned release records rather than destructive deletion.

## Phase D: Learning And Assessment Native Modules

Goal: Rebuild the strongest V4 learning and assessment ideas inside PlanThePath's architecture.

Outputs:

- Native domain model for learning modules, lessons, questions, attempts, evidence, mastery signals, and assessment blueprints.
- Deterministic assessment scoring and attempt history with auditability.
- Question randomization strategy that avoids nondeterministic `Math.random` shuffle behavior.
- SME-approved pilot content from Phase C.

Dependencies:

- Content staging and review gates.
- Product decision on first taxonomy slice.

Exit gates:

- Assessment attempts are scoped to authorized learners and institutions.
- Scoring is deterministic, versioned, explainable, and covered by tests.
- Content release and attempt records remain immutable after publication.

Rollback:

- Feature-flag assessment surfaces.
- Keep attempt data but hide unreleased content versions from new sessions.

## Phase E: Readiness And Roadmap

Goal: Add versioned readiness and learner roadmap features without importing uncalibrated V4 scoring as authority.

Outputs:

- Readiness model using approved factors, weights, eligibility boundaries, and explanation requirements.
- Roadmap recommendation service that produces advisory next steps, not admissions or hiring decisions.
- Versioned readiness evidence pack for each computed result.
- Product analytics events for readiness calculation, recalculation, explanation viewed, and roadmap action.

Dependencies:

- Decision on readiness outcome definitions and weighting policy.
- Learning and assessment evidence from Phase D.

Exit gates:

- Readiness output is marked advisory unless a future governance decision says otherwise.
- Tests prove version stability, authorization, and handling of missing data.
- AI is not used for ranking, eligibility, or hidden scoring.

Rollback:

- Disable readiness publication by version.
- Continue preserving underlying learning evidence.

## Phase F: Native Notifications And First Automation

Goal: Deliver the first low-risk automation class natively before introducing n8n execution.

Outputs:

- Native notification preference model for email first, with SMS or WhatsApp deferred until approved.
- Native templates for invitation accepted, assessment assigned, assessment completed, roadmap updated, and access grant expiring.
- Outbox-driven notification worker with retry, bounce handling, unsubscribe or preference honoring, and audit references.
- End-to-end test for one invitation-to-notification flow.

Dependencies:

- Event dispatcher from Phase B.
- Channel preference decision.

Exit gates:

- No notification sends without consent or legitimate basis policy.
- Message payloads exclude unnecessary sensitive content.
- Duplicate events do not create duplicate sends.

Rollback:

- Disable notification worker per event type.
- Preserve outbox and audit records for replay after correction.

## Phase G: Hardened n8n Platform And Controlled Pilots

Goal: Introduce n8n only as a constrained external worker for approved non-authoritative use cases.

Outputs:

- Dedicated n8n environment with pinned images, restricted egress, encrypted credentials, no direct production database access, no local filesystem secrets, and no shell execution.
- Approved node allowlist and denied-node policy.
- Webhook callback contract with signatures, idempotency, correlation IDs, and least-privilege service identity.
- Pilot automations for non-sensitive operational use cases, such as internal task creation or CRM synchronization after explicit vendor approval.

Dependencies:

- Security sign-off on threat assessment controls.
- Vendor and data field decisions.

Exit gates:

- n8n cannot read or write PlanThePath databases directly.
- n8n cannot make authoritative product decisions.
- Every workflow has owner, runbook, retry policy, failure alert, and test evidence.

Rollback:

- Disable event subscription for a workflow.
- Revoke workflow credentials.
- Replay events through a native worker if needed.

## Phase H: Opportunity, Application, And Interview Integrations

Goal: Add higher-value integrations after the content, readiness, event, and automation foundations are proven.

Outputs:

- Approved external opportunity source ingestion design.
- Native opportunity normalization, provenance, moderation, and publication flow.
- Interview scheduling integration only after calendar vendor and consent decisions.
- Optional n8n workflow for non-authoritative scheduling side effects, with native state retained as source of truth.

Dependencies:

- External source decisions.
- Calendar/meeting vendor decisions.
- Phase G controls.

Exit gates:

- Opportunity records retain source, retrieval time, license or terms status, and freshness.
- Interview scheduling never bypasses learner/institution consent and access grants.
- Failed external calls are recoverable through event replay.

Rollback:

- Disable source-specific ingestion.
- Hide affected opportunity feed versions.
- Preserve native interview request records.

## Phase I: Secure Documents And AI-Assisted Drafting

Goal: Introduce resume and communication assistance with strict privacy, provenance, and human control.

Outputs:

- Native document metadata model for uploads, parsed artifacts, redaction status, and retention.
- AI extraction and drafting pipeline with no autonomous ranking, eligibility, or final submission.
- Human review checkpoints before external sends.
- Prompt, model, input, output, and policy-version audit references where permitted.

Dependencies:

- AI scope decision.
- Retention and deletion policy.
- Data classification for resumes and communications.

Exit gates:

- AI output is advisory and visibly reviewable.
- Sensitive personal data is minimized and redacted where possible.
- Tests cover authorization, deletion, retention, and refusal of unsupported uses.

Rollback:

- Disable AI drafting and keep manual document workflows.
- Revoke model/provider credentials and purge temporary processing artifacts according to policy.

## Phase J: Scale, Cutover, And Operational Readiness

Goal: Move from pilots to durable operation only after governance and reliability are proven.

Outputs:

- Production readiness checklist for native modules, n8n workflows, monitoring, incident response, and audit reporting.
- Load and replay test evidence for event flows.
- Disaster recovery and credential rotation runbooks.
- Operational dashboard for outbox lag, workflow failures, duplicate suppression, notification delivery, and content release status.
- Release plan with feature flags, phased audiences, rollback instructions, and support playbooks.

Dependencies:

- Completed pilot phases.
- Business sign-off on launch scope.

Exit gates:

- All critical workflows have tested rollback.
- SLOs and alert thresholds are approved.
- Support, privacy, and security owners accept runbooks.

Rollback:

- Use feature flags to withdraw newly exposed modules.
- Pause individual event types or n8n subscriptions.
- Restore prior content release version where applicable.

## Critical Path

1. Resolve governance decisions and source evidence freeze.
2. Fix or explicitly resolve current authorization inconsistency.
3. Implement event dispatcher and idempotent consumer contract.
4. Establish content staging and SME release gates.
5. Rebuild learning, assessment, readiness, and roadmap natively.
6. Launch native notifications.
7. Pilot n8n only after platform hardening and workflow-level approval.

## Parallel Work Streams

- Product and legal can decide content rights, learner history migration, readiness semantics, external communication channels, and retention while engineering designs event and staging foundations.
- Security can turn the threat assessment into platform controls while content SMEs review the first V4 slice.
- Design and frontend can prepare feature-flagged learner and institution surfaces while backend contracts stabilize.
- Data/analytics can define release metrics, readiness quality checks, and operational dashboards once event names and content versions are stable.

## Suggested Validation By Phase

| Phase | Required validation |
| --- | --- |
| A | Decision log approved; source evidence checksums captured; no unresolved owner for critical decisions |
| B | Unit and integration tests for authorization, event creation, dispatcher retry, duplicate suppression, and audit |
| C | Import dry run, schema validation, license/provenance completeness, count reconciliation, SME review sample |
| D | Assessment scoring tests, attempt immutability tests, randomization tests, access-scope tests |
| E | Readiness version tests, explanation tests, missing-data tests, non-authoritative AI boundary tests |
| F | Notification preference tests, template rendering tests, duplicate event tests, bounce/failure tests |
| G | n8n hardening review, node allowlist tests, webhook signature tests, credential rotation drill |
| H | Source provenance tests, moderation tests, calendar callback tests, replay tests |
| I | Document authorization tests, retention/deletion tests, AI audit tests, human review tests |
| J | Load tests, replay tests, rollback drills, incident runbook exercises, monitoring acceptance |

## Success Metrics

- Zero direct database access from n8n workflows.
- One hundred percent of migrated content records carry provenance, license status, source hash, and reviewer state.
- Duplicate event delivery produces one business effect.
- Readiness calculations are versioned and reproducible.
- No AI output is used for hidden ranking, eligibility, or final submission.
- Every production workflow has an owner, runbook, alert, rollback path, and test evidence.

## Recommended First Engineering Goal

Implement Phase B as a narrow foundation project: resolve the `TRANSFERRED` membership status inconsistency, add the outbox dispatcher contract, and prove idempotent event delivery in tests. That work unlocks content staging, notifications, and n8n pilots without forcing premature product decisions.
