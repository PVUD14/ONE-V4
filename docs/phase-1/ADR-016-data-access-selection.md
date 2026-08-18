# ADR-016 — V1 Data Access Selection

**Status:** Accepted for V1
**Decision date:** 2026-08-16
**Scope:** Core transactional persistence

## Decision

Use **Drizzle ORM with node-postgres** as the primary typed persistence layer for PostgreSQL. Keep SQL migrations explicit and reviewable in source control. Allow reviewed parameterized SQL for queries where SQL is clearer or required for PostgreSQL-specific behavior, analytics, search, or performance-sensitive paths.

Domain models and API DTOs remain independent of Drizzle table definitions.

## Evidence

The Phase 1 spike implemented the minimum identity/organization schema and passed PostgreSQL-backed integration tests for:

- institution access bounded by relationship effective timestamps;
- employer + opportunity + student applicant scope;
- access revocation;
- suspended organization memberships;
- database CHECK/unique/FK constraints;
- atomic domain-state + outbox transaction;
- rollback when the domain mutation fails;
- clean migration application against a fresh PostgreSQL database.

CI runs these tests against PostgreSQL 16.

## Candidate assessment

### Drizzle

Accepted because it provides:

- TypeScript schema/query typing without a generated runtime client;
- direct PostgreSQL driver integration;
- SQL-like query composition suitable for explicit scope predicates;
- transaction APIs and savepoint support;
- generated/reviewable SQL migration workflows through Drizzle Kit;
- a parameterized `sql` escape hatch for PostgreSQL-specific queries;
- a low-friction exit path because the database and migration artifacts remain conventional PostgreSQL/SQL.

### Prisma

Prisma remains technically viable. Prisma Migrate produces customizable SQL migrations and Prisma supports transactions and raw SQL. It was not selected because PlanThePath's highest-risk persistence behavior is explicit tenant/temporal/scoped SQL, PostgreSQL constraints, outbox transactions, and future reporting/search query control. Drizzle's SQL-near model fits that constraint set with less abstraction and without generated-client coupling.

### Raw/typed SQL only

Not selected as the default because it would increase repetitive mapping/query boilerplate across ordinary CRUD paths. It remains an approved escape hatch behind repository interfaces where it materially improves clarity or performance.

## Migration policy

- Production schema changes use committed SQL migrations; no production `push`/auto-sync workflow.
- Migrations are reviewed like application code.
- Destructive/locking changes require explicit rollout notes and, when needed, expand/migrate/contract sequencing.
- CI must prove that migrations can build a clean test database from zero.
- Schema drift checks will be added before staging/production deployment automation is enabled.

## Transaction policy

Use a single database transaction for domain state changes that must publish an event. The transactional outbox record is committed in that same transaction. Background workers publish from the outbox asynchronously.

## Security policy

Repository/service APIs must require explicit organization/tenant/opportunity scope inputs. Identifier lookup alone is never authorization. Server-side RBAC + scoped/temporal ABAC remains authoritative.

## Consequences

Positive:

- PostgreSQL remains first-class rather than hidden behind an ORM abstraction.
- Scope predicates are reviewable in code.
- Reduced ORM lock-in.
- Strong TypeScript ergonomics for standard queries.

Costs:

- Engineers must understand SQL/PostgreSQL semantics.
- Complex query result typing may require explicit mapping.
- Migration discipline remains an engineering responsibility rather than being delegated to automatic schema synchronization.
