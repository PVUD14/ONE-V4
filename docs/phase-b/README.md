# Phase B Event Foundation

Phase B implements the foundation required before V4 migration or any n8n workflow activation.

## Implemented Scope

- Canonical temporal institution relationship policy.
- Shared authorization helper used by application/in-memory behavior.
- Persistence query alignment for transferred historical access.
- Additive PostgreSQL migration for outbox leasing, retry metadata, expiry, replay support, and consumer receipts.
- Small typed event envelope package with explicit version validation for current identity events.
- Native outbox dispatcher helpers with `FOR UPDATE SKIP LOCKED` claiming, lease ownership, retry, terminal failure, expiry marking, replay reset, and fake publisher for tests.
- Consumer idempotency helper keyed by `(consumer_name, event_id)`.

## Not Implemented In Phase B

- No V4 content, data, runtime, auth, payment, questions, readiness values, or learner history import.
- No n8n install, workflow import, webhook, credentials, or workflow deployment.
- No AWS EventBridge/SQS resources or production infrastructure changes.
- No public/admin replay HTTP route.

## Review Map

- Relationship policy: `TEMPORAL_RELATIONSHIP_POLICY.md`
- Event envelope: `EVENT_ENVELOPE.md`
- Dispatcher, retry, leases, receipts and replay: `OUTBOX_DISPATCHER.md`

## Validation Focus

Required validation is split into two layers:

- Unit/type validation for the shared authorization, event envelope, API in-memory behavior, and TypeScript contracts.
- PostgreSQL-backed integration validation for migrations, constraints, outbox claiming, concurrency, receipts, and replay when a disposable `DATABASE_URL` is available.
