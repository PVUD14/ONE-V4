import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { executeDueDeletions } from './http/privacy-deletion.js';
import { eraseExpiredApplicationMessages, MESSAGE_RETENTION_DAYS_AFTER_GRANT } from '@planthepath/persistence/src/application-messages.js';
import { revokeExpiredApplicantGrants } from '@planthepath/persistence/src/employer-terms.js';
import { sweepGrowthLeadContactRetention } from '@planthepath/persistence/src/growth-leads.js';
import { sweepGrowthActivityLocations, sweepGrowthFieldText } from '@planthepath/persistence/src/growth-field.js';
import { GROWTH_CONTACT_RETENTION_MONTHS, GROWTH_LOCATION_RETENTION_DAYS } from '@planthepath/authorization/src/index.js';
import { createLocalDiskStorage } from './storage/file-storage.js';
import { survivePoolErrors } from '@planthepath/persistence/src/pool-errors.js';

/**
 * Executes deletions whose 30-day grace period has elapsed, revokes applicant-access grants whose
 * expiry has passed (EMP-16), then erases application messages whose retention after the employer's
 * access ended has run out (EMP-10). Message erasure skips anything an open trust case or an active
 * retention hold still needs. GROWTH-03: erases the contacts of growth leads with no activity for
 * 24 months (D12) — people who are not ONE users and never agreed to be kept. GROWTH-06: erases visit
 * locations 180 days after the visit (O-23), and the visit notes and follow-up titles of the same
 * expired leads as the contacts.
 *
 * Deliberately a one-shot run rather than a loop: a deletion sweep is a daily job,
 * and a long-lived process holding a connection to do nothing most of the time is
 * more to operate and more to go wrong. A systemd timer decides when it runs; this
 * decides what happens when it does.
 *
 * Exits non-zero if any request failed, so a timer surfaces the failure rather than
 * reporting success while people's deletions silently did not happen.
 */
async function main(): Promise<void> {
  const pool = survivePoolErrors(new Pool({ connectionString: requireValue('DATABASE_URL') }), 'privacy-worker');
  const storageRoot = process.env.FILE_STORAGE_ROOT?.trim();
  const db = drizzle(pool, { schema });

  try {
    const summaries = await executeDueDeletions({
      db,
      ids: { uuid: randomUUID },
      ...(storageRoot ? { storage: createLocalDiskStorage(storageRoot) } : {}),
    });

    const completed = summaries.filter((item) => item.outcome === 'COMPLETED').length;
    const held = summaries.filter((item) => item.outcome === 'HELD').length;
    const failed = summaries.filter((item) => item.outcome === 'FAILED');

    console.log(JSON.stringify({
      event: 'privacy.deletion.sweep',
      considered: summaries.length,
      completed,
      held,
      failed: failed.length,
      // Without a storage root the rows are erased but the bytes are not, so say so
      // rather than reporting a clean sweep.
      ...(storageRoot ? {} : { warning: 'FILE_STORAGE_ROOT unset; stored document bytes were not removed' }),
    }));

    // EMP-16: grants whose expires_at has passed are revoked on the database clock. The live-grant
    // predicate already refuses them on every request; this makes the end durable and visible.
    let expiredGrants = 0;
    for (let batch = await revokeExpiredApplicantGrants(db); batch > 0; batch = await revokeExpiredApplicantGrants(db)) expiredGrants += batch;
    console.log(JSON.stringify({ event: 'employer.applicant_access.expiry_sweep', revoked: expiredGrants }));

    // EMP-10: message text is kept 180 days after the employer's access ended, then erased — the
    // same daily sweep, because it is the same kind of promise about how long ONE keeps data.
    const erasedMessages = await eraseExpiredApplicationMessages(db);
    console.log(JSON.stringify({ event: 'application.messages.retention_sweep', retentionDays: MESSAGE_RETENTION_DAYS_AFTER_GRANT, erased: erasedMessages }));

    // GROWTH-03 (D12): lead contacts are kept 24 months after the lead's last activity, then their
    // name, email and phone are erased; the organisation-level lead stays.
    let growthLeads = 0;
    let growthContacts = 0;
    for (let batch = await sweepGrowthLeadContactRetention(db); batch.contacts > 0; batch = await sweepGrowthLeadContactRetention(db)) {
      growthLeads += batch.leads;
      growthContacts += batch.contacts;
    }
    console.log(JSON.stringify({ event: 'growth.lead_contacts.retention_sweep', retentionMonths: GROWTH_CONTACT_RETENTION_MONTHS, leads: growthLeads, erased: growthContacts }));

    // GROWTH-06 (O-23): a visit's location is kept 180 days, then erased; the visit stays. The
    // notes and follow-up titles of leads past the 24-month period go with their contacts (§13.4).
    let locations = 0;
    for (let batch = await sweepGrowthActivityLocations(db); batch > 0; batch = await sweepGrowthActivityLocations(db)) locations += batch;
    console.log(JSON.stringify({ event: 'growth.activity_locations.retention_sweep', retentionDays: GROWTH_LOCATION_RETENTION_DAYS, erased: locations }));
    let notes = 0;
    let titles = 0;
    for (let batch = await sweepGrowthFieldText(db); batch.notes + batch.titles > 0; batch = await sweepGrowthFieldText(db)) {
      notes += batch.notes;
      titles += batch.titles;
    }
    console.log(JSON.stringify({ event: 'growth.field_text.retention_sweep', retentionMonths: GROWTH_CONTACT_RETENTION_MONTHS, notes, followUpTitles: titles }));

    for (const failure of failed) {
      console.error(JSON.stringify({ event: 'privacy.deletion.failed', requestId: failure.requestId, detail: failure.detail }));
    }
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function requireValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: 'privacy.deletion.sweep.failed',
    failureClass: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message.slice(0, 200) : undefined,
  }));
  process.exitCode = 1;
});
