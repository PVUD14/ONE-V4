# Outbox Dispatcher

## State Machine

```text
PENDING -> PROCESSING -> PUBLISHED
PENDING -> PROCESSING -> PENDING
PENDING -> PROCESSING -> FAILED
PENDING -> FAILED
PROCESSING -> FAILED
```

`FAILED` is the terminal dead-letter state for Phase B. The original event row and payload are preserved.

## Added Persistence Fields

| Field | Purpose |
| --- | --- |
| `available_at` | Earliest time an event can be claimed |
| `lease_owner` | Dispatcher identity that owns an active lease |
| `lease_expires_at` | Time an abandoned lease becomes reclaimable |
| `last_failure_class` | Bounded reason code, not a raw stack trace |
| `last_failure_message` | Short bounded message for terminal diagnostics |
| `expires_at` | Optional event expiry |
| `updated_at` | Operational timestamp |
| `event_consumer_receipts` | Per-consumer dedupe and outcome table |

## Claiming And Leasing

`claimOutboxBatch` uses `FOR UPDATE SKIP LOCKED` and a bounded batch size. It claims only `PENDING` rows whose `available_at` has passed, whose expiry has not passed, and whose prior lease is absent or expired.

The claim order is deterministic enough for operations:

```text
available_at, occurred_at, id
```

Completion helpers require both `delivery_state = PROCESSING` and the same `lease_owner`. A stale dispatcher cannot mark another worker's lease as published or failed.

## Retry Policy

The default retry policy is:

| Setting | Value |
| --- | ---: |
| Maximum attempts | 5 |
| Maximum event age | 24 hours |
| Base delay | 1 second |
| Maximum delay | 15 minutes |
| Jitter | 20 percent |

Tests can inject deterministic time and random functions. Runtime retry logic does not depend on uncontrolled randomness for correctness.

Retryable publisher failures return the event to `PENDING`, increment attempts through the claim path, set the next `available_at`, and clear the lease. Terminal failures or exhausted attempts mark `FAILED`.

Expired events can be marked failed through `markExpiredOutboxEvents`; claimed events also fail closed if they expire before publication.

## Publisher Contract

The dispatcher publishes through:

```ts
interface IntegrationEventPublisher {
  publish(event: IntegrationEventEnvelope): Promise<void>;
}
```

Phase B includes a deterministic in-memory publisher for tests. EventBridge/SQS remains deferred so this branch does not require AWS access, static credentials, or deployed infrastructure.

## Consumer Idempotency

`event_consumer_receipts` has a uniqueness boundary on `(consumer_name, event_id)`.

`handleEventIdempotently` gives native consumers a small reusable helper:

- first successful delivery runs the effect and records `SUCCEEDED`;
- duplicate delivery for the same consumer returns without running the effect;
- different consumers can process the same event independently;
- failed effects can be retried because a successful receipt is never silently overwritten;
- local database effects can run in the same transaction as the receipt.

## Replay

`replayOutboxEvent` is an operator-safe service operation, not a public API.

Replay:

- keeps the original event ID and payload;
- resets only delivery state;
- requires actor, reason, audit ID, and timestamp;
- writes `outbox.event.replayed` to audit;
- refuses expired events unless a future separately authorized override exists;
- still relies on consumer receipts to prevent duplicate business effects.

## Deferred Attachments

EventBridge/SQS should attach in the next infrastructure slice behind the publisher interface. n8n should attach later through a typed integration adapter that consumes minimum-data events or command references, never direct database access or raw domain payloads.
