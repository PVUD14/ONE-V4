import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { N8nAutomationAdapter } from '@planthepath/automation/src/index.js';
import { createConfiguredInvitationMailSink } from './invitation-mail.js';
import { createEventBridgePublisher, createLocalIntegrationEventPublisher, createNotificationEventConsumer, dispatchAutomationOnce, publishOutboxOnce } from './automation-workers.js';

/**
 * `local-dispatcher` is the mode ADR-028 deploys: it drains the outbox in-process and
 * invokes the workflow service, with no broker between the two. The three
 * broker-shaped modes below it are kept and still work — they are the escape hatch
 * for the day the worker has to run somewhere other than beside the database.
 */
type WorkerMode = 'local-dispatcher' | 'outbox-publisher' | 'notification-consumer' | 'automation-dispatcher';

async function main(): Promise<void> {
  const mode = requireMode(process.env.AUTOMATION_WORKER_MODE);
  const pool = new Pool({ connectionString: requireValue('DATABASE_URL') });
  const leaseOwner = `${mode}:${process.pid}`;
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    if (mode === 'local-dispatcher') {
      const db = drizzle(pool, { schema });
      const invitationMailSink = createConfiguredInvitationMailSink();
      const local = createLocalIntegrationEventPublisher({ pool, db, ...(invitationMailSink ? { invitationMailSink } : {}) });
      const adapter = new N8nAutomationAdapter(requireValue('PTP_N8N_BASE_URL'));
      const invocationSigningSecret = Buffer.from(requireValue('PTP_N8N_INVOCATION_SECRET'), 'utf8');
      const callbackSigningSecret = Buffer.from(requireValue('AUTOMATION_SIGNING_SECRET'), 'utf8');
      while (!stopping) {
        const now = new Date();
        const drained = await publishOutboxOnce({ db, publisher: local.publisher, leaseOwner, now });
        const dispatched = await dispatchAutomationOnce({ pool, adapter, invocationSigningSecret,
          callbackSigningSecret, leaseOwner, now });
        log(mode, { outbox: drained, routing: local.counts(), automation: dispatched });
        // Idle backoff only. A tick that did work loops straight into the next one, so
        // a backlog drains at full speed rather than one batch per second.
        if (!drained.claimed && !dispatched.claimed) await delay(1_000);
      }
    } else if (mode === 'outbox-publisher') {
      const db = drizzle(pool, { schema });
      const publisher = createEventBridgePublisher(requireValue('PTP_EVENT_BUS_NAME'));
      while (!stopping) {
        log(mode, await publishOutboxOnce({ db, publisher, leaseOwner, now: new Date() }));
        await delay(1_000);
      }
    } else if (mode === 'notification-consumer') {
      const consumer = createNotificationEventConsumer({ pool, queueUrl: requireValue('PTP_AUTOMATION_QUEUE_URL') });
      while (!stopping) log(mode, await consumer.pollOnce());
    } else {
      const adapter = new N8nAutomationAdapter(requireValue('PTP_N8N_BASE_URL'));
      const invocationSigningSecret = Buffer.from(requireValue('PTP_N8N_INVOCATION_SECRET'), 'utf8');
      const callbackSigningSecret = Buffer.from(requireValue('AUTOMATION_SIGNING_SECRET'), 'utf8');
      while (!stopping) {
        log(mode, await dispatchAutomationOnce({ pool, adapter, invocationSigningSecret, callbackSigningSecret, leaseOwner, now: new Date() }));
        await delay(1_000);
      }
    }
  } finally {
    await pool.end();
  }
}

function requireMode(value: string | undefined): WorkerMode {
  if (value === 'local-dispatcher' || value === 'outbox-publisher' || value === 'notification-consumer' || value === 'automation-dispatcher') return value;
  throw new Error('AUTOMATION_WORKER_MODE must select a supported worker');
}

function requireValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function log(mode: WorkerMode, counts: object): void {
  console.log(JSON.stringify({ event: 'automation.worker.tick', mode, ...counts }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'automation.worker.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
