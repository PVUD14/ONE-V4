# Current PlanThePath capability inventory

## Inventory method

This inventory distinguishes approved architecture, implemented runtime behavior, preview-only UI, and gaps. It is based on the architecture, security, phase-0/phase-1, and UX documents plus the API, web, persistence, identity, and authorization packages at baseline commit `c39786b7e57207a7c08fb066848646d0d2741516`.

The terms below are deliberate:

- **Implemented** — backed by executable service, persistence, authorization, and tests.
- **Partial** — a real foundation exists, but the full operational path does not.
- **Specified** — authoritative documents define the intended behavior; runtime is absent.
- **Preview** — the web UI demonstrates a flow with local/demo state, not a connected product capability.
- **Gap** — neither an implemented feature nor a sufficiently complete specification was found.

## Capability map

| Domain | Approved architecture | Runtime/API | Persistence | Web experience | Maturity and integration consequence |
| --- | --- | --- | --- | --- | --- |
| Identity authentication | Cognito access tokens; internal account resolution | Implemented token verification and current-account lookup | `users` with Cognito subject and lifecycle fields | Preview shell | **Implemented foundation.** Keep authoritative; reject V4 local auth. |
| Organization and membership | Institution/employer organizations, scoped memberships | Implemented membership resolution and representative checks | Organizations, units, memberships, membership scopes | Role-based preview navigation | **Implemented narrow slice.** Extend rather than replace. |
| Invitations | Hashed single-use token, verified email, idempotent acceptance | Implemented acceptance command | Invitation digest, status, expiry, redemption metadata | Not connected | **Implemented.** Suitable pattern for secure asynchronous commands. |
| Institution relationships | Temporal and revocable student access | Implemented representative access query | `institution_relationships` | Preview only | **Implemented with a semantic inconsistency to resolve.** |
| Employer applicant access | Opportunity plus explicit time-bound consent/grant | Implemented representative grant query | `employer_applicant_access_grants` | Preview only | **Implemented foundation.** No V4 equivalent should bypass it. |
| Authorization | RBAC plus scoped/temporal ABAC and deny-by-default | Implemented for the Phase 1 endpoints | Roles and scope constraints | UI role filtering is not authority | **Partial.** Enforcement is real but covers few domain commands. |
| Audit | Append-only security/domain audit intent | Implemented writes for selected identity mutations | `audit_events` | None | **Partial.** Expand to every migration, automation, and AI action. |
| Transactional events | Outbox in same transaction as mutation | Implemented durable outbox rows | `outbox_events` | None | **Partial.** No dispatcher, broker adapter, retry/DLQ, or consumer registry. |
| Idempotency | Required for retried commands | Implemented for invitation acceptance | `idempotency_records` | None | **Partial.** Standardize for commands, callbacks, and consumers. |
| Student profile | Canonical profile with controlled disclosures | Specified | Not implemented | Preview | **Specified/preview.** V4 profile data needs a new canonical schema. |
| Academics | Academic facts and institution attestations | Specified | Not implemented | Preview | **Specified/preview.** Treat as restricted education data. |
| Skills and evidence | Evidence-backed skills and provenance | Specified | Not implemented | Preview | **Specified/preview.** Build before importing derived scores. |
| Content/learning | Versioned curricula, lessons, prerequisites | Specified | Not implemented | Preview | **Specified/preview.** Candidate for curated V4 taxonomy/content migration. |
| Assessments | Versioned blueprints, attempts, immutable evidence | Specified | Not implemented | Preview | **Specified/preview.** Reimplement; do not deploy V4 assessment runtime. |
| Readiness | Deterministic, explainable, versioned model; AI non-authoritative | Specified | Not implemented | Preview | **Specified/preview.** V4 fixed scores are not authoritative inputs. |
| Roadmap | Explainable next actions driven by evidence/readiness | Specified | Not implemented | Preview | **Specified/preview.** Adapt V4 rule ideas behind versioned policies. |
| Documents and resume | Private objects, controlled AI analysis | Specified | Not implemented | Preview | **Specified/preview.** Secure object ingestion is a prerequisite. |
| Opportunities | Employer-authored opportunities and eligibility | Specified | No opportunity model; generic access grants only | Preview | **Specified/preview.** Required before employer automation. |
| Applications | Audited lifecycle and applicant control | Specified | Not implemented | Preview | **Specified/preview.** All state changes must stay native. |
| Interviews | Scheduling, feedback, and constrained access | Specified | Not implemented | Preview | **Specified/preview.** Calendar/meeting adapters are phase 2. |
| Institution interventions | Cohort insight, referrals, scoped case actions | Specified | Not implemented | Preview | **Specified/preview.** Aggregation and authorization must be native. |
| Notifications | Consent-aware templates, delivery and preference handling | Specified | Not implemented | Preview | **Specified/preview.** First automation dependency. |
| Analytics and reporting | Scoped operational/aggregate views | Specified | Not implemented | Preview dashboards | **Specified/preview.** Never aggregate multi-tenant data in n8n. |
| Billing/subscriptions | Commercial boundary and entitlements | Specified at high level | Not implemented | Preview | **Specified/preview.** Provider and product decisions remain. |
| Trust, consent, privacy | Purpose limitation, minimization, retention, export/deletion | Strongly specified | Only selected identity/access records | Preview | **Partial.** Migration and automation need the missing operational controls. |
| AI assistance | Private conversations and advisory outputs behind an AI gateway | Specified | Not implemented | Preview | **Specified/preview.** No generic n8n model calls with student/applicant data. |

## Implemented Phase 1 slice

### Data model

The current Drizzle schema and SQL migrations implement:

- users;
- organizations and institution units;
- memberships and membership scopes;
- invitations using token digests rather than recoverable tokens;
- institution relationships with validity windows and lifecycle status;
- employer applicant access grants with opportunity, consent, and validity context;
- audit events;
- transactional outbox events; and
- idempotency records.

These tables are the first production-shaped slice, not a complete product database. V4 tables must not be copied alongside them as a second model.

### API and services

Observed routes and use cases include:

- `/health`;
- `/api/v1/security/context`;
- current Cognito-backed internal account and membership resolution;
- institution representative access to a student's activity;
- employer representative access to an applicant under an active grant;
- invitation acceptance with verified email, token digest, transaction, audit/outbox writes, and idempotency.

The use-case/service boundary is the correct place for future authorization and invariants. Repositories implement tenant/scope/temporal predicates; controllers do not grant access by themselves.

### Security properties already present

- Access tokens are verified against Cognito rather than decoded without verification.
- Internal user and membership state is loaded before protected operations.
- Role checks are combined with representative, organization, and time-window constraints.
- Selected mutations write domain state, audit, and outbox records transactionally.
- Invitation material is stored as a digest and acceptance requires a verified matching email.
- Tests cover token validation, role and scope failures, revocation/expiry, concurrent acceptance, outbox atomicity, and idempotency.

These are architectural invariants for integration work, not optional patterns.

## Current event and automation maturity

The outbox is durable storage only. The repository does not currently implement:

- an outbox lease/claim and dispatch worker;
- EventBridge/SQS publication;
- schema registry and compatibility checks;
- consumer idempotency records per handler;
- bounded retries, poison-message quarantine, or a dead-letter queue;
- delivery reconciliation;
- signed inbound integration callbacks; or
- an n8n adapter.

Consequently, no catalog workflow is safe to enable yet. The event foundation is Phase B in the roadmap.

## Web implementation reality

The React application contains a broad role-based experience for students, placement officers, faculty, counselors, department heads, analysts, recruiters, hiring managers, interviewers, and operations users. These screens are useful product and visual specifications, but their data is predominantly local preview/demo state.

The only observed network call from the web application is the health check. Labels such as “backend enforced” in preview surfaces must not be interpreted as evidence that the represented workflow or authorization exists. Before release, every interactive preview must be mapped to an authorized API command/query or explicitly marked demonstrative.

## Inconsistencies to resolve before expansion

1. **Institution relationship semantics:** the authorization helper and in-memory service exclude `TRANSFERRED`, while the persistence representative query treats `TRANSFERRED` as active when the activity timestamp is within the validity window. A single domain policy and tests must define whether transferred relationships retain historical access.
2. **Role vocabulary:** the domain/frontend role vocabulary is broader than the role allowlists enforced by current persistence constraints and services. Adding a UI role must not silently imply backend authority.
3. **Outbox expectation versus operation:** architecture describes asynchronous delivery, but the implemented system stops at durable rows. Operational documentation must not claim broker delivery until dispatch and reconciliation exist.
4. **Preview claims versus connected behavior:** UI content presents future capabilities as if operational. Acceptance criteria must require backend evidence for security-sensitive labels.

## Reusable platform seams

| Seam | Reuse for integration | Required extension |
| --- | --- | --- |
| NestJS module/use-case boundaries | All authoritative commands and queries | Add content, assessment, readiness, roadmap, document, opportunity, application, interview, notification, and integration modules incrementally |
| Drizzle repositories and explicit migrations | Canonical persistence and constraints | Staging schemas/jobs, versioned reference data, immutable evidence and projections |
| Cognito principal resolution | Human authentication | Service identities and workload authentication for internal adapters |
| Authorization package | Shared deny-by-default primitives | Resource-specific scope, purpose, consent, and temporal policies |
| Audit writer | Security and domain decision evidence | Correlation/causation IDs, migration provenance, AI and automation decision fields |
| Transactional outbox | Domain-event source | Dispatcher, schema compatibility, broker/DLQ, replay and reconciliation |
| Idempotency repository | Retried commands | Consumer and provider-callback idempotency namespaces |
| Configuration validation | Fail-closed runtime configuration | Secret references, integration endpoints, allowlists, kill switches |

## Capability gates for integration

V4 content migration can begin in quarantine after provenance schemas and reviewers exist; it does not need the full student product. Personal history migration cannot begin until identity matching, lawful basis, consent/purpose, data-subject operations, and canonical evidence models exist.

n8n design and static reconstruction can proceed in parallel with event foundations, but activation requires all of the following:

1. a PlanThePath-produced versioned event;
2. a documented minimum-data payload;
3. an approved external destination and data-processing basis;
4. workload authentication and secret-manager references;
5. idempotency and replay behavior;
6. bounded retry, dead-letter, and manual reconciliation;
7. end-to-end audit and metrics; and
8. a per-workflow security and product-owner approval.
