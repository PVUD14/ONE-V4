# Phase 1 Data Access & Managed Identity Spike

**Status:** Active spike
**Branch:** `agent/phase-1-data-identity-spike`
**Authority:** Approved V1 architecture + Phase 0 controls

## Objective

Select and validate the V1 persistence/data-access approach and managed identity integration without leaking infrastructure concerns into domain contracts.

## Non-negotiable constraints

- PostgreSQL remains the transactional system of record.
- Domain/API DTOs must not become ORM entities.
- Tenant, organization, opportunity, and temporal relationship scope must be enforceable in repositories/services and authorization policy.
- Migrations must be explicit, reviewable, deterministic, reversible/forward-fixable, and safe for production deployment.
- Transactions must support multi-record domain invariants and transactional outbox writes.
- Raw production credentials/secrets must never be committed.
- Identity provider subjects map to internal immutable user IDs; external IdP claims do not become authoritative business authorization.
- RBAC + scoped/temporal ABAC remains server-side and application-owned.
- Privileged roles require stronger authentication/MFA policy than ordinary student accounts.
- Session revocation and account suspension must take effect without relying solely on stale client claims.

## Data-access candidates

Evaluate at minimum:

1. Prisma
2. Drizzle ORM / Drizzle Kit
3. Typed SQL/query-builder fallback where specialized queries justify it

The selected approach may combine a primary typed persistence layer with reviewed raw SQL for analytics/search/reporting hot paths.

## Data-access evaluation matrix

| Criterion | Weight | Evidence required |
|---|---:|---|
| Migration control and production safety | Critical | create/alter/index/constraint migration spike |
| PostgreSQL feature access | Critical | constraints, transactions, JSON, indexes, raw SQL escape hatch |
| Type safety | High | compile-time repository examples |
| Domain isolation | Critical | persistence model kept behind repository interfaces |
| Transaction semantics | Critical | multi-table + outbox transaction test |
| Tenant/scope query ergonomics | Critical | institution/employer scoped repository tests |
| Testability | High | integration-test workflow against PostgreSQL |
| Schema drift handling | High | CI drift/check approach documented |
| Operational complexity | Medium | generation/build/deploy requirements |
| Developer ergonomics | Medium | migration + local reset/seed workflow |
| Lock-in/exit path | Medium | ability to use SQL and migrate away |

## Persistence spike schema

The spike must model only enough of Phase 1 to test architecture:

- users
- organizations
- organization memberships
- institution relationships with effective start/end timestamps
- employer applicant access grants
- audit/outbox records

No career, assessment, opportunity, AI, billing, or reporting domain expansion is permitted in this spike.

## Required persistence tests

1. Former institution cannot query activity outside relationship effective window.
2. Employer A cannot query Employer B applicant grants.
3. Revoked applicant grant denies subsequent access.
4. Suspended membership cannot authorize organization operations.
5. Cross-organization identifier guessing does not return protected records.
6. Domain change + outbox event commit atomically.
7. Unique/foreign-key/check constraints enforce intended invariants.
8. Migration can create a clean database from zero.

## Managed identity candidate

Amazon Cognito is the preferred V1 candidate from the approved architecture, but remains subject to this spike before final ADR acceptance.

## Identity boundary

```text
Managed IdP
  -> authentication + MFA/federation/session tokens
Core API
  -> validate issuer/audience/signature/time
  -> resolve external subject to internal UserIdentity
  -> load current account state + memberships + scopes
  -> run application authorization
```

The API must never treat an IdP group/role claim as sufficient authorization for institution/employer/platform resources.

## Managed identity validation

Validate/document:

- invited self-registration flow
- verified email requirement
- Google/Microsoft federation compatibility path
- privileged MFA enforcement strategy
- access/ID/refresh token handling
- JWT validation/JWKS caching and rotation
- account suspension/revocation behavior
- logout/global sign-out limitations and compensating API-side controls
- user-pool environment separation
- non-production test-user handling
- external-subject-to-internal-user mapping
- future enterprise SSO compatibility

## Deliverables / exit criteria

- ADR-016: data-access selection
- ADR-017: managed identity selection and authorization boundary
- migration/transaction spike proving required persistence invariants
- integration tests against PostgreSQL
- identity-token validation adapter interface and tests
- no product feature expansion beyond Phase 1 foundation

A candidate is not selected because it is popular; it is selected only after satisfying the above constraints.
