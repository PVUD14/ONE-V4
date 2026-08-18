# PlanThePath Data Protection Engineering Requirements

**Status:** Mandatory V1 engineering controls
**Companion:** `DATA_PROTECTION_SECURITY_ARCHITECTURE.md`

These requirements are normative for implementation and review. `MUST` means required for production release. `SHOULD` means expected unless an ADR/security review records a justified exception.

## DP-001 Data classification

Every new persistent field/domain MUST be assigned a data classification and retention owner before production use.

## DP-002 Minimal collection

The application MUST NOT collect Aadhaar, passport, bank or unrelated government/family data in V1 unless separately approved by product, security and privacy review.

## DP-003 Database encryption

Production PostgreSQL MUST use encrypted storage/backups with AWS KMS and MUST NOT expose a public database endpoint.

## DP-004 Object encryption

Private S3 objects MUST be stored in non-public buckets using SSE-KMS. S3 Block Public Access MUST remain enabled unless a documented architecture change explicitly creates a public-content bucket.

## DP-005 TLS

Sensitive traffic MUST use TLS. Database connections in production MUST require encrypted transport.

## DP-006 Secrets

Production secrets MUST be stored in an approved secret manager and MUST NOT be present in source, Git history, frontend bundles, container layers or application logs.

## DP-007 Identity boundary

Cognito claims MAY establish authenticated identity. They MUST NOT be treated as sufficient authorization for business resources.

## DP-008 Account-state enforcement

Every protected request MUST use current internal account status. `SUSPENDED`, `DELETION_PENDING` where policy denies use, and `DELETED` identities MUST fail closed even if an IdP token remains cryptographically valid.

## DP-009 Server authorization

Every protected read/write MUST be authorized server-side. Frontend navigation/action visibility MUST NOT be relied upon as a security control.

## DP-010 Institution temporal scope

Institution access to student activity MUST enforce active/effective relationship time windows and staff organizational scope. Former institutions MUST NOT see post-relationship activity.

## DP-011 Employer scope

Employer candidate access MUST require employer ownership/context, opportunity scope, student/applicant identity and an unexpired/unrevoked access/consent grant.

## DP-012 Identifier guessing

Repository/service operations MUST enforce scope predicates in addition to resource IDs. Cross-tenant guessed identifiers MUST NOT disclose protected records or metadata.

## DP-013 DB access

Runtime database identities MUST use least privilege. Migration credentials SHOULD be separate from runtime credentials. Routine developer direct production DB access is prohibited.

## DP-014 Documents

Private uploads MUST be quarantined until required validation/scanning completes. File authorization MUST be independent from object URL/key knowledge.

## DP-015 File validation

Uploads MUST enforce configured size limits, normalized filenames, permitted types and MIME/signature validation. Executable/active content is prohibited unless a future feature explicitly requires and securely isolates it.

## DP-016 Malware handling

Untrusted uploaded documents MUST pass an approved malware scanning pipeline before normal access. Scan failure/unavailability MUST fail closed for risky content.

## DP-017 Signed object access

Private object downloads/uploads MUST use short-lived authorization/presigned mechanisms after application authorization. URLs MUST expire.

## DP-018 Log redaction

Structured logs and error telemetry MUST redact passwords, authentication tokens, secrets, private keys and classified payload content. Full private AI conversations MUST NOT appear in normal logs.

## DP-019 Auditability

Privileged/security-significant actions MUST generate durable audit events with actor, action, scoped resource identifier, organization/context, outcome, timestamp and correlation identifier.

## DP-020 Audit immutability

Normal application users MUST NOT be able to edit/delete historical audit events. Audit-store write permissions MUST be narrower than ordinary application data permissions.

## DP-021 Exports

Export permission MUST be separate from view permission. Sensitive export generation/download MUST be audited, scope-limited and time-limited.

## DP-022 AI privacy

Raw private student AI conversations MUST be accessible only to the student owner by default. Institution, employer, support and ordinary platform staff access is denied by default.

## DP-023 AI authorization

AI context retrieval MUST use the same or stricter authorization semantics as ordinary application APIs. AI systems MUST NOT have generic unrestricted SQL/database access.

## DP-024 AI minimization

Only context required for the current AI task MAY be sent to a model/provider. Highly Restricted data requires an explicitly approved provider/data-processing path.

## DP-025 Prompt injection

Retrieved/user/external text MUST be treated as untrusted data. It MUST NOT be allowed to modify system authorization, tool permissions or tenant scope.

## DP-026 Environment separation

Production secrets, databases, Cognito resources, object storage and KMS keys MUST be isolated from development/staging equivalents. Production personal data MUST NOT be copied into development by default.

## DP-027 Test data

Automated tests and developer environments SHOULD use synthetic data. Any production-derived dataset requires irreversible anonymization and explicit approval.

## DP-028 WAF/abuse controls

Production public endpoints MUST have rate limiting/abuse controls. Authentication and high-cost endpoints SHOULD receive stricter throttling and bot/credential-abuse protections.

## DP-029 Monitoring

Security monitoring MUST detect or surface repeated authorization failures, suspicious authentication, cross-tenant attempts, high-volume exports/downloads, privileged-role changes and other defined critical events.

## DP-030 Backups

Critical production data MUST have encrypted backups and point-in-time recovery where supported. Backup access MUST follow least privilege.

## DP-031 Restore testing

A production readiness/recovery process MUST demonstrate successful restore testing. Backup existence alone is not sufficient evidence of recoverability.

## DP-032 Deletion lifecycle

Account/data deletion MUST follow verified request, retention/legal evaluation, deletion/anonymization and auditable completion. Completed deletion MUST NOT silently resurrect historical personal data if a user re-registers.

## DP-033 Relationship exit

Student transfer/institution exit MUST terminate future institution visibility at the relationship boundary while preserving only legitimate historical records under retention policy.

## DP-034 Employer retention

Closed recruitment access MUST expire according to configured retention policy. Expired candidate access MUST fail closed.

## DP-035 Privileged MFA

Platform privileged roles MUST use MFA. Institution/employer privileged administrators MUST use strengthened authentication policy defined by the identity configuration.

## DP-036 Privileged access review

Platform privileged access MUST be role-separated, audited and periodically reviewed. Generic shared admin accounts are prohibited.

## DP-037 No dangerous admin consoles

The production Operations portal MUST NOT expose unrestricted SQL consoles, raw secret viewers, generic filesystem/S3 browsers or blanket AI-conversation browsing.

## DP-038 Authorization tests

Every data-bearing module MUST include negative authorization tests for cross-user/cross-organization access relevant to its domain.

## DP-039 IDOR/BOLA tests

APIs exposing resource identifiers MUST include IDOR/BOLA tests that prove identifier substitution does not bypass scope checks.

## DP-040 Revocation tests

Relationship, membership, consent/grant and account suspension/revocation MUST have tests proving access is denied after revocation/effective end.

## DP-041 Redaction tests

Logging/error paths that process authentication or Highly Restricted data MUST have automated tests or structured verification demonstrating required redaction.

## DP-042 Infrastructure review

Production infrastructure changes affecting IAM, network exposure, encryption, S3 policies, Cognito or database access MUST receive security-relevant review and infrastructure-as-code validation.

## DP-043 Dependency/secret scanning

CI MUST include dependency/vulnerability and secret scanning before production release. Critical/high-risk findings require remediation or documented security acceptance.

## DP-044 Security baseline

Web/API controls SHOULD be validated against OWASP ASVS 5.0 requirements appropriate to the application's risk profile. AI-enabled functionality additionally requires AI-specific abuse and tool-authorization tests.

## DP-045 Incident response readiness

Before production launch, PlanThePath MUST have an incident-response process, contacts/ownership, evidence-preservation approach and credential/session containment procedures.

## Pull request checklist for data-bearing changes

A PR adding or materially changing persistent/sensitive data MUST answer:

- [ ] What classification is the data?
- [ ] Who owns/source-verifies it?
- [ ] Who may read/write it?
- [ ] What tenant/relationship/consent scope applies?
- [ ] Where is it stored and how is it encrypted?
- [ ] What is logged, and what is explicitly redacted?
- [ ] Which audit events are generated?
- [ ] How long is it retained and how is it deleted/anonymized?
- [ ] Can it be exported/shared? Under which permission?
- [ ] Does AI/model/provider processing touch it?
- [ ] What negative authorization/abuse tests were added?
- [ ] Does backup/recovery apply?
