# API Security Integration

Status: Draft PR 11 implementation note
Scope: Phase 1 representative protected API request path only

## Canonical protected request flow

1. Request enters a versioned JSON API route under `/api/v1`.
2. The API resolves or generates a bounded correlation ID from `x-correlation-id`.
3. The authentication guard extracts a credential only from `Authorization: Bearer <token>`.
4. The configured identity verifier cryptographically validates the provider token according to ADR-017.
5. The verified external subject is mapped to the internal PlanThePath user through server-side persistence.
6. The current internal account state is checked; non-`ACTIVE` accounts fail closed.
7. Route, query, or body tenant identifiers are treated only as untrusted candidate context.
8. Current active memberships are reloaded from persistence for the authenticated user.
9. A trusted request authorization context is constructed from verified identity plus current persistence state.
10. Controller methods delegate to application/security route adapters and persistence repositories.
11. Security-sensitive invitation acceptance uses the PR 9 transactional idempotency, row-locking, audit, and outbox path.
12. External responses use generic authentication/authorization failure messages and include only the safe correlation identifier.

## Trust boundary

Cognito or another ADR-017-approved verifier authenticates who presented the token. PlanThePath persistence and application services decide what that user can do.

The API request path does not trust client-supplied user IDs, organization IDs, institution IDs, employer IDs, memberships, roles, scopes, account states, employer grants, or invitation recipient identity as authorization facts.

## Representative routes introduced

| Route | Auth | Tenant context | Authorization/persistence check | Idempotency | Transaction/audit/outbox |
|---|---|---|---|---|---|
| `GET /api/v1/security/context` | Protected bearer token | Optional `organizationId` query candidate | Current active account and active membership reload | No | No mutation |
| `GET /api/v1/institutions/:institutionId/student-activity-access/:studentUserId` | Protected bearer token | `institutionId` path candidate | Active institution membership, scoped role, active temporal institution relationship | No | Read-only representative check |
| `POST /api/v1/invitations/accept` | Verified bearer token | Invitation scope from persisted invitation only | Verified recipient email, token digest lookup, single-use invitation lock | Required `Idempotency-Key` | User/membership creation, audit, and outbox in one DB transaction |
| `GET /api/v1/employers/:employerId/applicant-access/:opportunityId/:studentUserId` | Protected bearer token | `employerId` path candidate | Active employer membership plus active unrevoked/unexpired applicant grant | No | Read-only representative check |

## Error and logging policy

The route layer maps malformed credentials, invalid tokens, unknown subjects, suspended accounts, missing memberships, wrong tenants, invalid invitations, revoked/expired invitations, and invalid employer grants to generic external denial. Internal diagnostics must use correlation IDs and must not log bearer tokens, raw invitation tokens, token hashes, credentials, raw authorization headers, or excessive identity-provider claims.

## Concurrency notes

Invitation acceptance is end-to-end integrated with persistence idempotency and row locking in this slice. Institution and employer representative operations are read-only authorization checks; membership-suspension, employer-grant-revocation, and role-assignment mutation race guarantees still require future mutation routes to explicitly use the PR 9 row-lock primitives inside their transaction.

## Out of scope

This slice does not add frontend UI, full production bootstrap, BFF/session-cookie architecture, Hosted UI, OpenAPI generation, rate limiting, WAF/CORS/security-header infrastructure, opportunity/application domain tables, billing, AI, reporting, or role-management mutation routes.
