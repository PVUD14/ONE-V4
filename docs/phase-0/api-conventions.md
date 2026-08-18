# API and Event Conventions

## API style

V1 uses versioned REST APIs for synchronous application operations and asynchronous domain events for reliable side effects/integration. Public/browser APIs must not expose database entities directly.

## HTTP conventions

- version prefix: `/api/v1`;
- resource-oriented nouns;
- UTC ISO-8601 timestamps;
- opaque identifiers;
- pagination required for collections;
- explicit filtering/sorting allowlists;
- `Idempotency-Key` for retryable consequential creates where applicable;
- correlation/request ID propagated end to end.

## Errors

Return stable machine-readable error codes plus non-sensitive user-safe messages. Authorization failures must avoid resource-existence disclosure where enumeration is a risk. Validation errors identify permitted fields without leaking internals.

## Authorization

Authentication establishes identity only. Every protected handler/service authorizes action + resource + organization/relationship scope server-side. Client role claims are never sufficient by themselves.

## Mutations

Domain state transitions must use owning-domain commands/services. Cross-domain table writes are prohibited. Consequential AI-proposed mutations require the same authorization plus explicit user confirmation when specified by architecture.

## Events

Every domain event includes `eventId`, `eventType`, `eventVersion`, `occurredAt`, `correlationId`, actor/subject when relevant, and tenant/organization scope when relevant. Consumers must be idempotent. External side effects use transactional outbox/reliable queue patterns.

## Compatibility

Breaking API/event changes require a new version or an approved migration strategy. Schemas are additive by default; consumers must tolerate documented additive fields.

## Security

Rate limits, request-size limits, content-type allowlists, schema validation, file-upload isolation, webhook signature verification, and replay controls apply at appropriate endpoints.