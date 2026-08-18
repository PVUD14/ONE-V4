# Identity and Organization Persistence Enforcement

Status: Draft PR 9 implementation note
Scope: Phase 1 identity and organization persistence only

## Purpose

This slice converts the Phase 1 identity/organization application-service invariants into PostgreSQL-backed persistence guarantees. It does not add frontend behavior, authentication-provider integration, API routes, jobs/opportunities, AI, billing, reporting, or readiness features.

## Persistence strategy

- PostgreSQL remains the system of record.
- Drizzle schema definitions are kept in `packages/persistence/src/schema.ts`.
- Explicit SQL migrations remain authoritative for review and deployment.
- Specialized PostgreSQL behavior, including conditional invitation consumption and row locks, is implemented behind repository functions in `packages/persistence/src/repositories.ts`.
- Domain/API DTOs are not exposed as persistence entities.

## Database-enforced invariants

- External identity subject uniqueness is enforced by a unique partial index on `users.external_subject` while allowing invited users without an external subject.
- Membership uniqueness is enforced by a scoped unique index across organization, user, role, and concrete scope fields while the membership is not ended.
- Organization membership role/scope shape is enforced by a PostgreSQL trigger that verifies platform, institution, and employer role families against organization kind and scope columns.
- Institution unit parentage is enforced by a composite same-institution foreign key.
- Institution-only relationship rows are enforced by a trigger on `institution_relationships`.
- Employer applicant grants must reference employer organizations and are unique while active.
- Invitation token hashes are unique; raw invitation tokens must not be persisted.
- Invitation role/scope shape is enforced by check constraints and a trigger.
- Audit and outbox writes are committed in the same repository transaction as the associated domain mutation.
- Idempotency records are unique by `(scope, key)` and reject conflicting request hashes.

## Concurrency strategy

- Invitation acceptance uses an idempotency record plus a row-level `FOR UPDATE` lock on the pending invitation, followed by a conditional state transition to `ACCEPTED`. Only one concurrent consumer can commit.
- Membership-sensitive mutations can lock the active membership row with `FOR UPDATE` immediately before mutation.
- Employer-applicant-grant-sensitive mutations can lock the active unrevoked/unexpired grant row with `FOR UPDATE` immediately before mutation.
- Duplicate role assignment races are constrained by the membership scoped unique index.
- Duplicate active employer grant races are constrained by a partial unique index on active grants.

## Audit and outbox handling

Audit records capture actor, action, resource type/id, optional organization scope, outcome, correlation ID, timestamp, and bounded context JSON. Repository functions do not persist secrets, tokens, raw invitation values, credentials, resumes, documents, or private AI content in audit records.

Outbox records capture event ID, aggregate type/id, event type, event version, payload, actor, organization scope, correlation ID, created timestamp, delivery state, and retry count. PR 9 persists durable events only; delivery workers remain out of scope.

## Deferred enforcement

- Full API-route integration remains a later Phase 1 slice.
- Cognito-specific provisioning and token/session revocation integration remains governed by ADR-017 and is not implemented here.
- Employer opportunity/application tables and consent snapshots remain out of scope; this slice enforces the grant table itself.
- Production migration rollout sequencing, runtime DB roles, backups, and encryption are governed by the data-protection architecture and infrastructure workstreams.
