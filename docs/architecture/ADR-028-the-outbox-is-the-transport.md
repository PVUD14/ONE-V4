# ADR-028 — The Outbox Is the Transport; EventBridge and SQS Are Not Deployed

**Status:** Accepted
**Decision date:** 2026-09-12
**Scope:** What carries an integration event from the API to the automation worker, and what happens to `infra/event-boundary.yaml`
**Relates to:** ADR-021 — completes it; ADR-021 chose the architecture, not the transport
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

ADR-021 decided that email leaves the platform through the automation worker and the workflow
service, and that no second sending path is added to the API. It deliberately left the deployment
specifics to Stream A. One specific it left open turns out to be load-bearing: **what moves the
event between the two processes.**

The code answers that question twice, and the two answers disagree with the deployment.

`publishOutboxOnce` takes a generic `IntegrationEventPublisher`
(`packages/persistence/src/automation-workers.ts:29-31`). The only implementation wired into the
worker entry point is `createEventBridgePublisher`, which requires `PTP_EVENT_BUS_NAME`
(`run-automation-worker.ts:20`). The notification consumer is `SqsIntegrationEventConsumer` and
requires `PTP_AUTOMATION_QUEUE_URL` (`automation-workers.ts:47`, `run-automation-worker.ts:26`). So
as wired, running the worker requires an EventBridge bus and an SQS queue.

Neither exists. `infra/` contains exactly one file — `infra/event-boundary.yaml`, an unreferenced
CloudFormation template defining an EventBridge bus, an SQS queue, a dead-letter queue, a KMS key,
two CloudWatch alarms, and an `AutomationWorkerRole` whose trust policy names
`ecs-tasks.amazonaws.com`. There is no ECS in this program: no cluster, no task definition, no VPC,
no ECR, no Terraform, no CDK, and no stack name recorded anywhere. Production is a single VPS at
`one.ai8ht.pro` running release symlinks under systemd, and the only worker pattern with a deployed
unit is the privacy-deletion sweep.

The template therefore describes an architecture nobody is building, next to code that cannot start
without it, in a repository whose deployment does something else entirely. Left alone, it will be
read as a plan.

The third worker mode needs none of this. `automation-dispatcher` polls `automation_commands`
directly from the connection pool and invokes n8n over HTTPS through `N8nAutomationAdapter` with the
signed-token machinery that has already been verified against real containers
(`run-automation-worker.ts:28-34`).

## Decision

**The outbox table is the transport. The worker polls the database on the same host and invokes the
workflow service directly over HTTPS. EventBridge and SQS are not deployed, and
`infra/event-boundary.yaml` is retired.**

Concretely:

- A local `IntegrationEventPublisher` implementation delivers a claimed outbox event in-process to
  the same handler the SQS consumer wraps. `event_consumer_receipts` continues to provide
  idempotency, unchanged.
- The two broker-bound worker modes collapse into one mode that runs `publishOutboxOnce` against the
  local publisher and `dispatchAutomationOnce` against n8n, under a single systemd unit following
  the privacy-sweep pattern.
- `EventBridgeIntegrationEventPublisher` and `SqsIntegrationEventConsumer` stay in
  `packages/automation`. They are tested, and they are the escape hatch named below. **They are not
  deleted.**
- Stream A retires `infra/event-boundary.yaml` — removed, or clearly marked as a superseded
  future-state document. Leaving it as-is is not an option.
- Production preflight requires `PTP_N8N_BASE_URL`, `PTP_N8N_INVOCATION_SECRET` and
  `AUTOMATION_SIGNING_SECRET`. `PTP_EVENT_BUS_NAME` and `PTP_AUTOMATION_QUEUE_URL` stop being
  required.

The email provider underneath the workflow service is an **operational** choice, recorded by Stream A
in the deploy runbook rather than here, because swapping SMTP providers changes no application code.
The architectural constraints on it are fixed: credentials live with the workflow service and never
in the API or in this repository, and the sending domain carries SPF and DKIM before the first
pilot invitation goes out.

## Why not stand up the broker

It is the more conventional answer and it is rejected for now:

- It introduces an AWS account boundary, a KMS key, an IAM execution role and two queues in order to
  move a message between two processes **on the same machine**. Every one of those is a new failure
  mode and a new thing to hold credentials for.
- The role in the template is assumed by a compute service we do not run. Deploying the template as
  written would produce a role nothing can assume; adapting it means designing the ECS migration
  first, which is a much larger decision wearing a small one's clothing.
- The delivery guarantee is already there without it. `claimOutboxBatch` uses
  `FOR UPDATE SKIP LOCKED` with a lease owner and lease token; retry, backoff, jitter, max age and a
  terminal `FAILED` state are implemented and documented in `docs/phase-b/OUTBOX_DISPATCHER.md`;
  `event_consumer_receipts` is unique on `(consumer_name, event_id)`. That is at-least-once delivery
  with idempotent consumption — the same property SQS would supply, minus the network.
- It is the slower path to the thing that actually matters, which is that no invitation the product
  has ever sent has reached a human.

**When this becomes wrong**, and the escape hatch is taken: the worker must run on a different host
from the database; polling no longer sustains the event rate; or a second independent consumer needs
fan-out of the same event. Each is measurable. None is true today, and the publisher interface means
taking the hatch is a wiring change, not a rewrite.

## Consequences

- Outbox rows begin draining the moment the worker starts. **Historical `PENDING` rows must be
  superseded before that happens**, or months of accumulated events are delivered at once to real
  people. This is a prerequisite, not a follow-up.
- There is no broker dead-letter queue, so the terminal `FAILED` state in `outbox_events` **is** the
  dead letter and `replayOutboxEvent` is the redrive. It currently has no caller outside tests; an
  operator path for it is required before the worker is deployed, not after.
- Losing the CloudWatch alarms in the template means worker failure must be caught by the existing
  health monitor instead. Stream A extends it.
- The worker shares a host with the API and the database. Its resource ceiling is now a real
  operational concern rather than someone else's.
- `infra/` becomes empty or near-empty. That is an honest signal about where this platform runs, and
  it should not be repopulated with aspirational templates.
- The AWS-shaped code paths in `packages/automation` are unexercised in production. They keep their
  tests so the hatch stays usable.

## Implementation notes

- Ownership: the publisher implementation and the worker mode are Core (`packages/persistence`,
  `packages/automation`). The systemd unit, preflight, monitor extension and the disposition of
  `infra/event-boundary.yaml` are Stream A.
- This ADR does not address two separate defects on the same path, both tracked as their own work:
  the notification consumer accepts only `stable_key === 'assessment-due'`, and invitations emit
  `identity.invitation.created` rather than `notification.delivery.requested`. Deploying the worker
  without fixing both delivers reminders and still delivers zero invitations.
- The workflow allowlist, hash pinning and the kill switch are unchanged by this decision and remain
  the security control on what the worker may invoke.
