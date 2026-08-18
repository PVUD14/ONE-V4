import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { N8nAutomationAdapter } from '@planthepath/automation/src/index.js';
import { createEventBridgePublisher, createNotificationEventConsumer, dispatchAutomationOnce, publishOutboxOnce } from './automation-workers.js';

type WorkerMode = 'outbox-publisher' | 'notification-consumer' | 'automation-dispatcher';

async function main(): Promise<void> {
  const mode = requireMode(process.env.AUTOMATION_WORKER_MODE);
  const pool = new Pool({ connectionString: requireValue('DATABASE_URL') });
  const leaseOwner = `${mode}:${process.pid}`;
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    if (mode === 'outbox-publisher') {
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
      const adapter = new N8nAutomationAdapter(requireValue('PTP_N8N_BASE_URL'), requireValue('PTP_N8N_TRANSPORT_CREDENTIAL'));
      const signingSecret = Buffer.from(requireValue('AUTOMATION_SIGNING_SECRET'), 'utf8');
      while (!stopping) {
        log(mode, await dispatchAutomationOnce({ pool, adapter, signingSecret, leaseOwner, now: new Date() }));
        await delay(1_000);
      }
    }
  } finally {
    await pool.end();
  }
}

function requireMode(value: string | undefined): WorkerMode {
  if (value === 'outbox-publisher' || value === 'notification-consumer' || value === 'automation-dispatcher') return value;
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
