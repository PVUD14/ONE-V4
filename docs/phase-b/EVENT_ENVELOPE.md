# Event Envelope

## Purpose

The event envelope is the native contract between domain mutations, the transactional outbox, a dispatcher, a broker, and native consumers or future integration adapters.

It is intentionally small and explicit. It is not a generic event framework.

## Current Registered Events

| Event | Version | Producer | Aggregate | Purpose |
| --- | ---: | --- | --- | --- |
| `identity.invitation.accepted` | 1 | `identity-organization` | `user` | Invitation acceptance |
| `identity.user.provisioned` | 1 | `identity-organization` | `user` | User provisioning |

The serialized integration type may be represented by downstream tooling as `identity.invitation.accepted.v1`, but persistence stores `event_type` and `event_version` separately.

## Envelope Fields

| Field | Requirement |
| --- | --- |
| `eventId` | Opaque UUID; same as the outbox row ID |
| `eventType` | Registered event type |
| `eventVersion` | Explicit positive integer version |
| `occurredAt` | RFC-3339 UTC timestamp |
| `producer` | Registered producer |
| `aggregateType` | Registered aggregate type |
| `aggregateId` | Opaque UUID for current registered events |
| `aggregateVersion` | Optional until versioned aggregates exist |
| `organizationId` | Optional tenant/organization scope |
| `subjectId` | Optional subject scope when applicable |
| `actorId` | Optional actor scope when applicable |
| `correlationId` | Opaque UUID for traceability |
| `causationId` | Optional parent event/command ID |
| `purpose` | Registered purpose |
| `dataClassification` | Registered classification |
| `schemaRef` | Stable schema reference |
| `expiresAt` | Optional RFC-3339 UTC expiry |
| `payload` | Minimum allowlisted opaque IDs/reason codes |

## Security Rules

Events reject unsupported versions and schema mismatches before publication.

Payloads are allowlisted per event and must not contain raw emails, tokens, credentials, resumes, documents, assessment answers, answer keys, AI prompts, conversations, stack traces, or broad snapshots. Sensitive-looking string values are rejected in the current registered events.

Serialization is deterministic for test and audit comparisons.

## Deferred Work

- Add schemas as new domain events are implemented.
- Add generated JSON Schema/OpenAPI artifacts if external adapters need machine-readable contracts.
- Add EventBridge/SQS serialization bindings in the next infrastructure slice.
