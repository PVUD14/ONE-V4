/**
 * One-shot background-jobs alert check (OPS-04), run every five minutes by
 * deploy/systemd/planthepath-jobs-alerts.timer.
 *
 * Raises one alert per breach (failed events over threshold, a waiting event past its
 * limit, a configured consumer gone silent) and clears it when the condition recovers.
 * It runs apart from the automation worker so a stopped worker is still reported, and
 * it exits after one pass: no always-on service.
 *
 * Design: docs/architecture/jobs-health-alerts-table-design.md
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { evaluateJobsAlerts, readJobsAlertConfig } from './jobs-health.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString });
  try {
    const config = readJobsAlertConfig(process.env);
    const result = await evaluateJobsAlerts(drizzle(pool, { schema }), config);
    console.log(JSON.stringify({
      event: 'jobs.alert.check',
      raised: result.raised.map((alert) => ({ condition: alert.conditionKey, subject: alert.subject, notice: alert.notice })),
      cleared: result.cleared.map((alert) => ({ condition: alert.conditionKey, subject: alert.subject })),
      open: result.stillOpen,
      ignoredConfig: config.ignored,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'jobs.alert.check.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
