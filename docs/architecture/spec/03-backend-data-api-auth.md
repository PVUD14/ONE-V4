# PART V — BACKEND AND DATA ARCHITECTURE

## 19. Recommended Backend Shape

### 19.1 Core API

A modular transactional API shall own the ordinary business domains listed above. It will be stateless at runtime and horizontally scalable.

### 19.2 AI Service

A separately deployable AI orchestration service shall handle model-provider calls, retrieval, context building, policy checks, prompt versions, model routing, usage/cost metering, and structured AI actions.

### 19.3 Worker Service

A separately deployable worker pool shall process asynchronous workloads such as email, document parsing, malware-scan callbacks, assessment result aggregation, matching, analytics projections, deletion workflows, report generation, and AI batch operations.

### 19.4 Scheduler

Scheduled jobs should enqueue work rather than execute heavyweight logic inside scheduler runtime.

### 19.5 Analytics

V1 may use operational PostgreSQL read replicas/materialized views plus derived reporting tables for bounded reporting. A dedicated warehouse is deferred until data volume/query contention justifies it.

---

## 20. Database Architecture

### 20.1 Primary database

Use relational storage as the system of record. Recommended: PostgreSQL-compatible managed database.

Why relational:

- heavy referential relationships
- transactional application states
- strong constraints
- tenant/organization relationships
- auditability
- reporting flexibility
- JSON support for carefully bounded extensibility

### 20.2 Data partitioning

V1 uses one logical database cluster with strong logical tenant/organization scoping. Do not create a database per college at this scale.

All organization-scoped records must carry an explicit organization/tenant scope where applicable. Student-owned data that survives institution changes shall be keyed to student identity rather than current institution.

### 20.3 Row-level security

Database RLS may be used as defense in depth for selected high-risk multi-tenant tables, but application authorization remains mandatory. RLS must not be the only authorization mechanism because some queries require temporal and cross-organization business policy.

### 20.4 Core entity families

- users, identities, account_states
- organizations, institution_profiles, employer_profiles
- organization_memberships, roles, role_scopes
- institution_hierarchy_nodes
- student_profiles
- student_institution_relationships
- academic_records, academic_verifications
- skill_taxonomy, student_skills, competency_evidence, endorsements
- assessment_definitions, questions, versions, attempts, responses, results, integrity_events
- career_roles, career_requirements, recommendations
- career_goals, roadmap_items, tasks, milestones
- readiness_models, readiness_model_components, readiness_snapshots
- documents, document_versions, resumes, resume_versions
- opportunities, opportunity_versions, eligibility_rules
- applications, application_profile_snapshots, application_state_history
- interviews, interview_stages, interview_outcomes
- interventions
- employer_verifications, employer_trust_events
- reports, safety_cases, case_evidence, case_actions, appeals
- conversations, conversation_messages or structured AI interaction records according to retention policy
- AI runs, model_usage, prompt_versions, action_proposals
- notifications, preferences, deliveries
- plans, subscriptions, entitlements, payment_references
- audit_events
- outbox_events, idempotency_keys

### 20.5 Provenance

Important records shall include source/provenance fields. Minimum model:

- subject
- source type
- source actor/organization
- created_at
- verification state
- verified_by
- verified_at
- evidence reference if applicable
- model/system version if derived

Verification states: `SELF_DECLARED`, `EVIDENCED`, `VERIFIED`, `REJECTED`, `REVOKED`.

### 20.6 Soft delete

Soft delete may support operational recovery but shall not be misrepresented as privacy deletion. User deletion workflows must ultimately delete or irreversibly anonymize personal data according to the approved retention map.

---

## 21. File and Document Handling

Files shall not be stored as database blobs.

### 21.1 Storage

Use private object storage with encryption, versioning where appropriate, lifecycle rules, and blocked public access.

### 21.2 Upload flow

1. Client requests upload authorization.
2. Backend validates file intent/type/size and creates pending document record.
3. Client uploads through time-limited signed upload mechanism.
4. File enters quarantine state.
5. Malware scanning and content validation occur asynchronously.
6. Safe document becomes available according to authorization policy.
7. Parsing/extraction is performed asynchronously when needed.

### 21.3 Constraints

Allowlist file types. Apply server-side content/MIME inspection, size limits, filename normalization, archive-bomb limits, malicious macro handling, and malware scanning. Never execute uploaded files. Downloads use short-lived authorized signed URLs or proxied access for especially sensitive files.

### 21.4 Resume access

Employer access to resume/document data is created only when the student applies/consents to the opportunity. The application should retain an applicant-profile snapshot so later student edits do not silently change what was originally submitted.

---

# PART VI — API ARCHITECTURE

## 22. API Style

V1 public/internal application APIs shall use versioned HTTPS JSON REST for transactional workflows. Asynchronous domain integration uses internal events/queues.

GraphQL is not required for V1. The frontend query shapes do not currently justify the additional authorization/query-complexity surface.

## 23. API Standards

- Base prefix: `/api/v1/...`
- OpenAPI contract generated/validated in CI
- UUID/ULID-style opaque identifiers; never expose sequential IDs where enumeration risk matters
- ISO-8601 UTC timestamps
- cursor pagination for large collections
- explicit filter/sort allowlists
- request correlation ID
- structured machine-readable error codes
- idempotency key support for critical create/payment/application/action requests
- optimistic concurrency/version field for contested mutable resources
- rate limits by user, IP, organization, and endpoint risk profile

## 24. API Authorization

Every protected request must pass:

Authentication → account state → entitlement if needed → role permission → resource scope → relationship/time scope → object ownership/consent → policy constraints.

Frontend route guards are convenience only; backend checks are authoritative.

## 25. Error Contract

Example structure:

```json
{
  "error": {
    "code": "APPLICATION_STATE_CONFLICT",
    "message": "The application cannot transition from INTERVIEW to APPLIED.",
    "correlationId": "...",
    "fieldErrors": []
  }
}
```

Do not expose stack traces, SQL errors, internal service hostnames, secrets, policy internals, or raw model-provider errors to end users.

---

# PART VII — AUTHENTICATION, AUTHORIZATION, AND RBAC

## 26. Authentication

Recommended V1 identity architecture: managed OIDC-compatible identity service rather than custom password storage.

### 26.1 Student authentication

- institution invitation token + self-registration
- verified email
- Google/Microsoft federation can be enabled after invitation/relationship validation
- MFA optional initially for ordinary students, encouraged for sensitive account changes
- future passkeys supported by identity choice

### 26.2 Institution/employer authentication

- verified email
- MFA mandatory for owner/admin/placement-admin/employer-admin/recruiter roles with sensitive applicant access

### 26.3 Operations authentication

- MFA mandatory
- passkey/WebAuthn or strong TOTP-backed MFA preferred
- short session duration
- step-up authentication for critical actions
- no shared accounts
- separate app client/security policy

## 27. Authorization Model

Use **RBAC + scoped ABAC/policy authorization**.

Examples:

- Lecturer: `academic.verify` only for students in assigned scope.
- Placement officer: `student.read_career_progress` for current active institution relationships.
- Former institution: denied access to post-relationship activity.
- Recruiter: applicant data only for opportunities belonging to recruiter organization and only after applicant consent/application.
- Interviewer: sees only candidate/interview information required for assigned interview.
- Support: cannot view private AI chat by default.
- Security Admin: may access security metadata without automatically receiving educational/career content.

## 28. High-Level Permission Matrix

| Capability | Student | Institution | Employer | Ops |
|---|---:|---:|---:|---:|
| Edit own career profile | Yes | No | No | exceptional support only |
| Verify academic record | No | scoped roles | No | exceptional |
| View private AI chats | Yes | No | No | no by default |
| View readiness | own | scoped active students | only permitted applicant-derived indicators | policy-based |
| Create assessment | No* | authorized | authorized | PlanThePath content roles |
| Publish opportunity | No | authorized | verified employer | authorized |
| View applicant PII | own | institution-owned workflow only | consented applicants only | support/policy controlled |
| Change global scoring model | No | No | No | restricted admin |
| Resolve safety case | No | No | No | moderation roles |
| Security/audit administration | No | No | No | security/admin only |

`*` Students take assessments; later student-generated practice content is out of V1.

---
