# PART XIII — SECURITY ARCHITECTURE

## 52. Security Baseline

Development and verification shall target OWASP ASVS 5.0.0 as the primary web application security verification baseline, supplemented by threat modeling, secure SDLC requirements, supply-chain controls, cloud controls, and LLM-specific verification requirements.

## 53. Trust Boundaries

Primary boundaries:

1. Public internet ↔ CDN/WAF
2. Browser ↔ identity provider
3. Browser ↔ application API
4. Application API ↔ database/cache/queue/object storage
5. Application ↔ AI service/providers
6. Application ↔ payment/email/external opportunity integrations
7. Public portals ↔ Ops privileged surface
8. Tenant/institution/employer boundaries within application
9. Student private data ↔ institution/employer visibility
10. Uploaded documents ↔ trusted processing environment

## 54. Core Threat Scenarios

- broken object-level authorization across institutions/employers
- former institution retaining access after transfer
- employer enumerating student profiles
- recruiter accessing applicants from another employer
- privilege escalation into Ops roles
- invitation-token takeover
- assessment cheating/manipulation
- malicious resume/document upload
- job-scam/phishing posting
- payment webhooks forged/replayed
- prompt injection causing unauthorized AI tool actions
- RAG cross-tenant leakage
- model/provider data leakage
- API scraping and credential stuffing
- mass assignment
- insecure direct object references
- audit log tampering
- secrets exposure through CI/logs
- supply-chain compromise

## 55. Preventive Controls

- deny-by-default authorization
- centralized policy service/module
- strict tenant/resource scoping
- parameterized database access
- schema validation at all boundaries
- output encoding and CSP
- CSRF protections appropriate to session architecture
- secure cookies/token storage design
- MFA for privileged users
- WAF/rate limiting/bot controls
- account lock/risk controls without easy DoS abuse
- encryption in transit and at rest
- private subnets for data services
- IAM least privilege and workload roles
- no long-lived cloud keys in code/CI
- dependency pinning/lockfiles
- SAST/SCA/secret/IaC/container scanning
- signed/controlled build pipeline
- non-root containers and minimal base images

## 56. Audit Logging

Audit events must include:

- immutable event ID
- UTC timestamp
- actor user/service
- actor role and organization
- action
- target type/ID
- result
- reason where required
- correlation/request ID
- source IP/device metadata subject to privacy policy
- before/after security-relevant fields where appropriate and safe

Mandatory audit examples:

- role/permission changes
- institution/employer approval/suspension
- student relationship verification/end
- academic verification
- readiness-model publication
- opportunity moderation/material changes
- applicant data access by privileged roles
- safety case actions
- subscription entitlement changes
- AI configuration/prompt/model policy changes
- data export/deletion
- admin impersonation if ever allowed (prefer avoid)

Do not log passwords, tokens, secret values, full payment card data, or unnecessarily sensitive AI content.

## 57. Security Event Integration

Security-significant logs should be exportable to centralized log analytics/SIEM. Alert categories include authentication anomalies, privilege changes, high-volume access, repeated authorization failures, anomalous applicant/resume downloads, secret/config changes, WAF signals, and infrastructure security events.

---

# PART XIV — DATA PROTECTION AND PRIVACY

## 58. Data Classification

### Restricted

Authentication secrets, security credentials, payment secrets, highly privileged audit/security data.

### Sensitive Personal

Student contact information, academic records, assessments, resumes, applications, interview records, institutional endorsements, AI conversation content, evidence submitted to trust/safety cases.

### Internal

Operational configuration, non-sensitive analytics, internal moderation metadata.

### Public

Approved public company/opportunity information and intentionally published marketing content.

## 59. Privacy Principles

- purpose limitation
- data minimization
- clear notices
- consent/authorization where required
- access correction/export/deletion workflows
- data retention schedules
- processor/provider inventory
- privacy review before new sensitive features
- no secondary use of private AI chat to silently score employability
- former institution access revocation

India privacy requirements must be validated against the DPDP Act/Rules and their applicable enforcement dates before production go-live. International expansion requires jurisdiction-specific review.

## 60. AI Conversation Privacy

Raw student AI conversations are private to the student by default. Institution and employer roles do not receive access. Operations/support staff do not receive default content access. Exceptional access, if ever necessary for a user-initiated support or safety workflow, must be policy-defined, least-privilege, reason-gated, and audited.

## 61. Account Deletion

Lifecycle:

request → identity verification → grace period → disable → retention evaluation → deletion/anonymization → completion record.

After completed deletion, returning users create a new account; deleted personal data is not silently resurrected. A recoverable grace period may be defined before irreversible deletion.

## 62. Data Export

Students can request/export their core profile, career goals/roadmap, assessment/result history as permitted, applications/interviews, and other portable personal data in machine-readable form plus human-readable summary where practical.

---

# PART XV — BILLING, SUBSCRIPTIONS, AND ENTITLEMENTS

## 63. Commercial Plans and Pricing

**Pricing is TBD and is not an architectural constant.** V1 shall launch with one or more commercially approved plans configured through platform data/configuration rather than source code.

The subscription model shall support configurable currency, price, billing interval, effective dates, eligibility, trial/promotional terms, and entitlement bundles. The architecture shall support direct student subscriptions and institution-funded/bulk-seat licensing without coupling authorization to payment amount. Future employer plans and additional commercial models must be addable without redesigning identity or RBAC.

Price changes shall create new/versioned commercial terms rather than rewriting historical transaction meaning. Existing subscriptions may be grandfathered where business policy requires. No application logic shall assume a fixed rupee amount or fixed annual billing interval.

## 64. Entitlements

Examples:

- `student.core`
- `student.ai_copilot`
- `student.assessments`
- `student.resume`
- `institution.management`
- `employer.posting`

Institution management entitlement may be activated according to commercial rules separate from individual student subscription payment.

## 65. Payment Security

Use a PCI-capable payment provider; PlanThePath shall not store raw card details. Payment webhooks require signature validation, idempotency, replay protection, and reconciliation. Entitlements change only after authoritative payment/operations events.

---

# PART XVI — REPORTING

## 66. Student Reporting

- readiness trend
- component gaps
- assessment history
- roadmap progress
- applications/interviews/offers
- career activity timeline

## 67. Institution Reporting

- active students/cohorts
- readiness distribution/trend
- students needing intervention
- skill-gap distribution
- assessment completion/performance
- application/interview/offer funnel
- opportunity engagement
- placement outcomes

Reports must obey current relationship and role scope.

## 68. Employer Reporting

- opportunity views/eligible population aggregate where privacy-safe
- application funnel
- assessment/interview funnel
- offer/hire outcomes
- recruitment cycle time

## 69. Platform Reporting

- subscriptions/entitlements
- institution/employer activation
- student activation/engagement
- opportunity supply/fill
- AI requests/cost/error/latency by capability
- moderation/case metrics
- system/operational metrics

---

# PART XVII — OBSERVABILITY AND SLOs

## 70. Observability

All services emit structured logs, metrics, and distributed traces with correlation IDs. Use OpenTelemetry-compatible instrumentation where practical.

### Required dimensions

service, environment, endpoint/job, result, organization scope where safe, user role (not raw personal identity in broad metrics), AI capability/model/provider, queue name, correlation ID.

## 71. Initial SLO Targets

These are engineering targets to validate during load testing:

- Core API availability: 99.9% monthly excluding scheduled maintenance
- Authenticated read API p95: < 500 ms excluding AI/external integrations
- Standard write API p95: < 800 ms excluding external-provider completion
- Web initial core route usability on typical Indian 4G: performance budget defined per route; avoid heavy dashboard bundles
- Interactive AI time-to-first-response target: < 5 seconds under normal conditions where provider allows; full completion is workload dependent
- Background critical notification enqueue: < 30 seconds from triggering transaction
- RPO: ≤ 15 minutes target for primary transactional data
- RTO: ≤ 4 hours V1 target, with critical service restoration prioritized

## 72. Alerts

- elevated 5xx/error rate
- p95/p99 latency regression
- DB connection/storage/replication pressure
- queue backlog/DLQ growth
- failed notification spike
- authentication/authorization anomaly
- AI provider errors/latency/cost threshold
- WAF/security alerts
- backup failure
- certificate/domain expiration

---
