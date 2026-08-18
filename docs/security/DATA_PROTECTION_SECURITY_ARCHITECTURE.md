# PlanThePath Data Protection & Security Architecture

**Status:** Authoritative V1 security architecture proposal
**Applies to:** Student, Institution, Employer, Platform Operations, Core API, AI services, persistence, documents, analytics, integrations, backups, CI/CD and AWS infrastructure
**Authority:** Approved application architecture, Phase 0 security controls, ADR-016 persistence, ADR-017 identity

## 1. Security objective

PlanThePath must protect confidentiality, integrity, availability and privacy of student, institution, employer and platform data. A compromise of one account, organization, application component, session, storage object or integration must not automatically expose the broader PlanThePath dataset.

Security controls use defense in depth: classification, minimization, authentication, server-side authorization, scoped persistence, encryption, isolation, secure document handling, logging/redaction, monitoring, retention, backup/recovery and incident response.

## 2. Data classification

| Classification | Examples | Required treatment |
|---|---|---|
| Public | Published opportunities, public employer profile data | Integrity controls, normal logging |
| Internal | Non-sensitive platform configuration and aggregate operational metrics | Authenticated staff access, encrypted storage |
| Confidential | Student profile, academic/verification records, readiness, skills, applications, interview records, institution analytics | Encryption, scoped authorization, audit logging, export controls |
| Highly Restricted | Identity/security data, private AI conversations, uploaded evidence, trust/safety cases, privileged audit data, sensitive exports | Strongest authorization, strict logging redaction, least privilege, exceptional-access controls |

Data classification must be represented in architecture and operational procedures. New domains must identify their classification before production release.

## 3. Data minimization

V1 must not collect high-risk identity or financial data without a documented business need. In particular, Aadhaar, passport numbers, bank details, family records and government identifiers are out of scope unless separately approved through security/privacy review.

Only attributes necessary for career readiness, education verification, recruitment, billing, security, support or legal obligations may be collected.

## 4. Encryption at rest

### PostgreSQL

Production PostgreSQL must run on encrypted AWS-managed storage using AWS KMS. Database snapshots, automated backups and replicas must remain encrypted.

The database must not be publicly reachable.

### S3/object storage

All private documents and generated exports must use private S3 buckets with:

- S3 Block Public Access enabled;
- SSE-KMS encryption;
- bucket policies denying unintended public access and insecure transport;
- versioning where recovery/integrity needs justify it;
- lifecycle rules;
- access logging/auditing as required;
- signed, time-limited access after application authorization.

### Key management

Use customer-managed KMS keys for security-sensitive production domains where operationally justified. V1 does not require one key per institution. Key policies must follow least privilege and production/non-production separation.

Candidate key domains:

- transactional database;
- private documents;
- audit/security archives;
- sensitive export artifacts.

Key rotation and access changes are audited.

## 5. Encryption in transit

TLS is mandatory for all browser-to-platform and service-to-service traffic containing sensitive data.

Required path:

```text
Browser -> HTTPS -> Edge/WAF/Load Balancer -> API/services -> TLS -> PostgreSQL/S3/managed integrations
```

Plaintext HTTP service callbacks, plaintext database connections and unencrypted transfer of private documents are prohibited in production.

## 6. Authentication and session security

Amazon Cognito User Pools is the V1 managed IdP under ADR-017. Authentication establishes identity only; it never supplies sufficient business authorization.

Requirements:

- verified email for normal accounts;
- stronger MFA policy for Institution privileged staff, Employer privileged staff and Platform Operations;
- mandatory MFA for Platform privileged roles;
- token verification using issuer, audience/client, token use, signature and time claims;
- JWKS caching/rotation through approved verification library;
- internal immutable user ID mapped to external subject;
- server-side current account-state lookup;
- suspended/deleted accounts denied even with cryptographically valid tokens;
- short-lived access-token strategy;
- hardened refresh/session handling;
- logout/global sign-out supported but not relied upon as the only revocation control;
- avoid browser localStorage for sensitive bearer-token persistence;
- step-up authentication for selected high-risk administrative actions when implemented.

## 7. Authorization and tenant isolation

All protected actions are authorized server-side using application-owned RBAC plus scoped/temporal ABAC.

Minimum decision chain:

```text
Authenticate
-> resolve internal user
-> verify current account state
-> resolve organization context
-> resolve current memberships/roles
-> resolve resource scope
-> validate active institution relationship / employer grant / consent
-> authorize action
-> execute scope-constrained repository query
```

Frontend hiding never grants authority.

### Institution temporal access

An institution may only access student data allowed by an active/authorized institutional relationship and the staff member's current organizational scope. When a relationship ends, the former institution receives no access to subsequent student activity.

Historical retention, where legitimate, is distinct from current-activity visibility.

### Employer applicant access

Employers do not receive a generic student directory in V1. Candidate data is available only through an employer-owned opportunity and a valid applicant/consent grant. Access must be constrained by employer, opportunity, student and grant status.

Revocation/expiry must deny subsequent access.

### Identifier guessing

Resource identifiers are not authorization tokens. Cross-tenant identifier guessing must return safe denial/not-found behavior without leaking protected metadata.

## 8. Database security

Production database controls:

- private subnet/no public endpoint;
- security groups restricted to authorized application workloads and controlled administrative paths;
- TLS required;
- credentials stored in AWS Secrets Manager or equivalent approved secret store;
- least-privilege DB roles;
- separate migration/deployment permissions from runtime permissions where practical;
- no routine developer direct access to production;
- audited emergency access;
- explicit migrations and schema review;
- database constraints for important integrity rules;
- transactional outbox for reliable state/event changes;
- query/repository interfaces must carry tenant/scope predicates.

## 9. Secrets management

Secrets, tokens, private keys and production credentials must never be committed to GitHub, frontend bundles, Docker images or normal logs.

Use:

- AWS Secrets Manager for application/runtime secrets;
- IAM roles/workload identity instead of static AWS access keys;
- SSM Parameter Store for non-secret environment configuration where appropriate;
- GitHub OIDC or equivalent short-lived CI cloud credentials rather than long-lived cloud keys;
- automated/controlled secret rotation where feasible.

Secret access is least privilege and audited.

## 10. Document and file security

Student resumes, certificates, transcripts, employer evidence and trust/safety attachments are private objects.

Upload pipeline:

```text
Authorized upload request
-> short-lived signed upload
-> quarantine/private object location
-> file-size validation
-> filename normalization
-> MIME + extension + magic-byte validation
-> malware scan
-> archive/decompression limits where applicable
-> safe final storage
-> metadata/provenance record
```

Controls:

- executable content prohibited unless explicitly required by a future domain;
- active HTML/script content must not execute in trusted PlanThePath origin;
- direct object paths do not imply access;
- downloads require application authorization and time-limited URLs;
- object keys must not expose unnecessary personal information;
- malicious or unscanned files remain quarantined;
- file previews must use safe rendering patterns.

## 11. Logging and sensitive-data redaction

Logs must record operational/security facts, not copies of sensitive payloads.

Audit-worthy fields may include:

- actor/internal user ID;
- organization/context;
- action;
- resource type and opaque ID;
- authorization result;
- reason/policy result where safe;
- timestamp;
- request/correlation ID;
- source/risk metadata where approved.

Never log:

- passwords;
- raw access/ID/refresh tokens;
- secrets/private keys;
- full resumes/certificates;
- full private AI conversations;
- payment credentials;
- unnecessary personal profile payloads.

A centralized redaction utility/policy must be applied to structured logs and error reporting.

## 12. Audit logging

Security-relevant and privileged actions require durable audit events, including:

- authentication/security events;
- role/membership changes;
- institution relationship changes;
- employer verification;
- academic/skill verification changes;
- readiness-model/configuration changes;
- assessment overrides;
- candidate/profile exports;
- sensitive document access;
- account suspension/deletion actions;
- trust/safety case decisions;
- billing/entitlement changes;
- AI model/prompt/policy changes;
- privileged support/operations actions.

Audit data receives stricter mutation permissions than ordinary business records. Application users cannot edit historical audit events.

## 13. Export protection

Data export is a separate privilege from on-screen viewing.

Controls:

- distinct export permission;
- mandatory scope filters;
- large/high-sensitivity export audit event;
- reason capture for selected privileged exports;
- asynchronous generation when appropriate;
- encrypted private storage;
- short-lived download link;
- automatic artifact expiry;
- rate/volume controls;
- future approval workflow for unusually large or sensitive exports.

## 14. Private AI conversation protection

Private student AI conversation content is Highly Restricted.

Default visibility:

| Actor | Raw private AI conversation |
|---|---|
| Student owner | Allowed |
| Institution staff | Denied |
| Employer | Denied |
| Normal Support | Denied |
| Platform Operations | Denied by default |

Any future exceptional investigation access requires explicit security/privacy design, narrow permission, case/reference, reason, time-limited access and immutable audit logging.

Raw private conversation content must not be written into ordinary application logs or analytics events.

## 15. AI data boundary

AI services may receive only the minimum context that the requesting principal is authorized to access.

Required flow:

```text
Request
-> application authorization
-> context builder
-> data minimization/classification filtering
-> AI gateway
-> model/provider
-> output safety/validation
```

The AI layer must never bypass application authorization or query unrestricted production data.

AI tools must expose bounded business operations, not generic database/SQL access.

Retrieved documents, opportunity text and external content are untrusted data, not trusted system instructions. Prompt injection from retrieved content must not grant new capabilities or alter authorization.

Provider routing must respect approved data-processing/privacy requirements. Highly Restricted data must not be sent to a provider/workload unless that use is explicitly approved.

## 16. Environment separation

At minimum:

- Development
- Staging
- Production

Production data must not be copied casually into non-production environments. Development and automated testing use synthetic data or appropriately anonymized datasets.

Production secrets, KMS keys, databases, storage buckets and Cognito resources must be separated from non-production equivalents. Separate AWS accounts are the preferred mature-state model.

## 17. Network and edge protection

Public endpoints are protected by an edge security layer including AWS WAF or equivalent controls.

Controls should cover:

- rate limiting;
- credential stuffing/authentication abuse;
- common web exploit patterns;
- bot/scraping abuse;
- request-size limits;
- suspicious traffic controls;
- API throttling and quotas where appropriate.

Internal databases and private storage are not exposed directly to the public internet.

## 18. Security monitoring and detection

Monitor for:

- repeated authorization failures;
- cross-tenant access attempts;
- unusual exports;
- mass document downloads;
- privileged-role modifications;
- suspicious authentication/session behavior;
- credential stuffing/account enumeration;
- excessive scraping;
- employer bulk-access anomalies;
- unusual AI usage/data access;
- unexpected database access;
- secrets/security-configuration changes;
- WAF/security-service alerts.

AWS services may include CloudTrail, CloudWatch, GuardDuty, Security Hub, WAF and Macie where justified by maturity/cost/risk.

Security alerts must have ownership, severity, response expectations and evidence retention.

## 19. Backup, recovery and ransomware resilience

Database:

- encrypted automated backups;
- point-in-time recovery;
- defined retention;
- controlled snapshots;
- cross-account/cross-region copies where justified by RPO/RTO;
- scheduled restore tests.

Object storage:

- versioning for critical data classes where appropriate;
- lifecycle and backup policy;
- protected deletion paths for critical evidence/audit artifacts where justified.

Backup success alone is insufficient; restoration must be tested periodically.

## 20. Retention, deletion and lifecycle

Every sensitive data domain must have a documented retention owner and lifecycle.

Lifecycle:

```text
collect -> classify -> use -> share -> retain -> archive -> delete/anonymize
```

Account deletion uses verified request + grace/retention evaluation + deletion/anonymization. A user returning after completed deletion creates a new account; deleted personal records are not silently resurrected.

Employer applicant access must expire according to recruitment/retention policy. Institution exit/transfer must remove future-activity visibility while retaining only legitimately required historical records.

Indian launch retention, notice, consent, rights and deletion handling require final production legal/privacy review against applicable DPDP Act/Rules obligations before go-live.

## 21. Privileged access

Platform privileges are separated across Operations, Security, Support, Billing and Moderation roles. No employee receives blanket super-admin access by default.

Production privileged access requires:

- MFA;
- least privilege;
- business justification;
- audit logging;
- time-bounded elevation where technically practical;
- periodic access review;
- immediate removal on role change/offboarding.

The Operations portal must not expose raw SQL consoles, generic production file browsers, raw secret viewers or unrestricted private-AI browsing.

## 22. Security testing requirements

Before production, security validation includes:

- unit tests for authorization policies;
- integration tests for tenant/temporal isolation;
- IDOR/BOLA negative tests;
- employer grant/consent revocation tests;
- privilege-escalation tests;
- authentication/session tests;
- file-upload abuse/malware path tests;
- log-redaction tests;
- export authorization/expiry tests;
- migration/constraint tests;
- backup restore test;
- SAST/dependency/secret scanning;
- infrastructure/IAM policy review;
- API/web security testing aligned to OWASP ASVS;
- AI prompt-injection/tool-authorization tests for AI-enabled modules;
- penetration test before material production launch.

## 23. Incident response and breach handling

PlanThePath must maintain an incident-response process covering detection, triage, containment, evidence preservation, credential/session revocation, stakeholder/legal assessment, recovery and lessons learned.

Security events must have traceable correlation identifiers and sufficient audit data to determine affected principals, organizations, resources and time windows without logging unnecessary sensitive content.

## 24. Architecture invariants

The following are non-negotiable V1 invariants:

1. Authentication is not authorization.
2. Frontend visibility is not authorization.
3. Resource IDs are not authorization.
4. Institution access is relationship- and time-scoped.
5. Employer candidate access is opportunity- and consent-scoped.
6. Private AI conversations remain private by default.
7. All sensitive persistence and storage are encrypted.
8. Production data stores are not public.
9. Secrets are never committed or exposed client-side.
10. Logs must not contain raw secrets/tokens/private conversational payloads.
11. Sensitive exports are separately authorized and short-lived.
12. AI receives only authorized/minimized context and cannot bypass policy.
13. Production and non-production data/secrets remain separated.
14. Backups are encrypted and restoration is tested.
15. Privileged actions are auditable.
16. Security failures must fail closed for protected data access.

## 25. Definition of Done for any new data-bearing module

A module is not production-ready until it documents and validates:

- data classification;
- data owner/source/provenance;
- authorization scope;
- encryption/storage path;
- logging/redaction rules;
- audit events;
- retention/deletion behavior;
- export/share behavior;
- backup/recovery applicability;
- AI/provider exposure if any;
- threat/abuse cases;
- negative authorization/security tests.
