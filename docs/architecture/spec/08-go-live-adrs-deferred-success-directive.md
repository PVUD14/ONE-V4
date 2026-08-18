# PART XXXI — GO-LIVE ACCEPTANCE GATES

## 134. Product Gate

Critical student/institution/employer/ops journeys complete end to end with no Sev-1/Sev-2 product defects.

## 135. Security Gate

- threat model reviewed
- ASVS-targeted verification completed for applicable controls
- authorization/tenant isolation automated suite passes
- critical/high vulnerabilities resolved or formally risk-accepted by authorized owner
- external penetration test completed for production candidate
- secrets/IAM review completed
- privileged Ops controls verified

## 136. Privacy Gate

- privacy notice and consent/notice flows approved
- DPDP applicability/enforcement review completed by qualified legal/privacy counsel
- processor/provider inventory complete
- data retention/deletion map approved
- AI provider data-use terms reviewed
- data-subject request workflow tested

## 137. Reliability Gate

- production backup successful
- restore tested
- RPO/RTO exercise performed
- load tests meet agreed targets
- queue/DLQ recovery tested
- AI/email/payment failure modes tested

## 138. Operational Gate

- dashboards/alerts live
- incident runbooks available
- escalation ownership defined
- support/admin least privilege implemented
- billing reconciliation tested
- AI cost budgets/alerts enabled

---

# PART XXXII — ARCHITECTURAL DECISIONS TO RECORD AS ADRs

1. ADR-001: Modular core vs microservices
2. ADR-002: Four separately deployable web surfaces
3. ADR-003: PostgreSQL as system of record
4. ADR-004: RBAC + scoped/temporal ABAC
5. ADR-005: Student-owned longitudinal career identity
6. ADR-006: Managed identity provider vs custom auth
7. ADR-007: REST + async events
8. ADR-008: SQS/outbox for reliable async work
9. ADR-009: Provider-independent AI Gateway
10. ADR-010: Managed inference first; self-hosting benchmark-gated
11. ADR-011: Private object storage/quarantine document pipeline
12. ADR-012: Versioned deterministic readiness scoring
13. ADR-013: Employer accountability/material-term versioning
14. ADR-014: Student private AI conversations excluded from institutional/employer visibility
15. ADR-015: Single-region Multi-AZ V1 with tested recovery, not active-active multi-region

---

# PART XXXIII — DEFERRED DECISIONS / PILOT VALIDATION

These are intentionally not guessed and must be decided through Phase 0/pilot evidence:

- exact readiness component weights
- exact payment provider
- final Cognito vs alternative managed IdP decision after UX/cost spike
- exact AI model/provider mix and model versions
- precise employer verification evidence requirements
- precise production data retention periods following legal/privacy review
- exact external opportunity-feed providers/licenses
- whether communication assessment uses recorded audio in V1 or post-MVP
- launch price, billing interval, discounts/trials, institution bulk-seat pricing, and future employer commercial plans
- threshold at which self-hosted GPU inference becomes financially beneficial

---

# PART XXXIV — SUCCESS METRICS

Product and business dashboards should eventually measure:

- invitation → registration activation rate
- profile/assessment completion
- readiness improvement over time
- roadmap task completion
- opportunity recommendation → view → application conversion
- interview and offer conversion
- placement rate and time-to-placement
- institution staff engagement/intervention effectiveness
- employer posting → qualified applicant → hire conversion
- employer verification/violation rates
- subscription renewal
- AI active users, useful-response feedback, cost per active student
- support/safety case volume and resolution time

Metrics must not incentivize deceptive score inflation or invasive data collection.

---

# PART XXXV — FINAL IMPLEMENTATION DIRECTIVE

After Product Owner approval, this document becomes the primary architecture reference for implementation in `PVUD14/planthepath`.

Codex/developers shall not silently change architectural boundaries, authorization semantics, privacy rules, score semantics, or trust/safety behavior. Material deviations require an ADR and Product/Architecture approval.

The following principles are non-negotiable unless the specification is formally revised:

1. Student private AI conversations are not visible to institutions/employers by default.
2. Former institutions cannot observe the student's subsequent career activity after relationship termination.
3. Employers cannot arbitrarily browse private student records.
4. Career Readiness is separate from integrity/safety enforcement.
5. Readiness scoring is versioned, explainable, and reproducible.
6. Employer opportunity material terms are versioned and accountability cases are evidence-based.
7. Authorization is enforced server-side at resource and scope level.
8. AI cannot bypass normal domain authorization or directly mutate the database.
9. Production secrets and PII do not enter source control or lower environments.
10. MVP architecture remains modular and extractable without introducing unnecessary microservices.

---

## Appendix A — Current External Baselines (as of August 2026)

- India Digital Personal Data Protection Act and Digital Personal Data Protection Rules, 2025, including current notified enforcement timeline; production counsel review required.
- OWASP Application Security Verification Standard (ASVS) 5.0.0.
- OWASP LLM security/verification guidance for LLM-enabled application controls.
- AWS current architecture guidance for managed/serverless and self-managed generative-AI inference, including right-sizing/self-hosting considerations.
- AWS managed identity, secrets rotation, container, and data-service security guidance applicable to selected implementation services.

## Appendix B — Approval Record

**Product Owner approval:** Approved — 2026-08-16  
**Architecture approval:** Approved — V1 baseline  
**Security approval:** Architecture controls approved; implementation verification pending  
**Implementation authorization:** Phase 0 authorized — 2026-08-16
