# PlanThePath Application Architecture & Implementation Specification V1

**Status:** Approved — Authoritative V1 Baseline  
**Product Owner approval:** 2026-08-16  
**Repository:** `PVUD14/planthepath`  
**Implementation authorization:** Phase 0 authorized

This file is the canonical index for the approved V1 architecture specification. The specification is intentionally split into reviewable sections under `docs/architecture/spec/`; taken together, the files below constitute the authoritative implementation reference.

## Specification Sections

1. [Product Specification](spec/01-product-specification.md)
2. [Domain Architecture, User Journeys, and Frontend Architecture](spec/02-domain-journeys-frontend.md)
3. [Backend, Data, API, Authentication, Authorization, and RBAC](spec/03-backend-data-api-auth.md)
4. [Career Readiness, Assessments, Opportunities, Employer Accountability, AI, and Background Jobs](spec/04-readiness-assessments-opportunities-ai.md)
5. [Security, Privacy, Billing, Reporting, and Observability](spec/05-security-privacy-billing-reporting-observability.md)
6. [AWS Deployment, Environments, Recovery, Scalability, Technology Stack, Repository, and Testing](spec/06-deployment-stack-repo-testing.md)
7. [Error Handling, Integrations, Admin Capabilities, Module Acceptance Criteria, and Development Phases](spec/07-resilience-integrations-admin-acceptance-phases.md)
8. [Go-Live Gates, ADR Requirements, Deferred Decisions, Success Metrics, and Final Implementation Directive](spec/08-go-live-adrs-deferred-success-directive.md)

## Authority Rule

Codex and developers must follow these documents as the V1 engineering baseline. Material changes to architecture boundaries, authorization semantics, privacy rules, readiness-score semantics, employer accountability, AI safety, or trust/safety behavior require a documented ADR and explicit architecture/product approval.

## Phase 0

Phase 0 may proceed with repository governance, ADRs, threat modeling, data classification/retention, RBAC/ABAC policy definition, CI/security gates, infrastructure baseline, environment structure, design-system baseline, API conventions, and observability conventions.

Product feature implementation must not bypass the Phase 0 exit criteria defined in the specification.
