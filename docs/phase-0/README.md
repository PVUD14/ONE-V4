# Phase 0 Foundation

Status: Draft for review on `agent/phase-0-foundation`.

This directory establishes the controls required before Phase 1 feature development.

## Exit criteria

Phase 0 is complete only when all of the following are approved and enforced where technically possible:

1. Identity and authorization model is defined.
2. Tenant, organization, relationship, and temporal access boundaries are defined.
3. Data classification, provenance, retention, deletion, and non-production handling conventions are defined.
4. Secrets management and environment separation rules are defined.
5. Repository governance and CI/security gates are active.
6. API and domain-event conventions are defined.
7. Observability and audit conventions are defined.
8. Threat model has owners and required mitigations.
9. Initial ADR set is accepted.
10. Infrastructure/IaC implementation may begin only from these conventions; product feature code remains blocked until Phase 0 approval.

## Documents

- `governance.md`
- `authorization-matrix.md`
- `threat-model.md`
- `data-classification-retention.md`
- `environments-secrets.md`
- `api-conventions.md`
- `observability-audit.md`
- `adrs/README.md`
- `adrs/ADR-001-to-015.md`

The approved architecture specification remains authoritative if any Phase 0 document conflicts with it.