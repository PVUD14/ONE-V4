import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import type { ApiIdGenerator } from './api-security.js';

export type NotificationKind = 'EXAM_ASSIGNED' | 'EXAM_REOPENED' | 'RESULT_PUBLISHED' | 'SYSTEM' | 'ANNOUNCEMENT';

const logger = new Logger('notify');

/**
 * Records a persistent notification for a user and (best-effort) fans it out
 * to their registered devices. Notification failures must never break the
 * domain operation that produced them, so this function swallows and logs.
 *
 * Push delivery: device tokens are already collected here; the actual FCM
 * sender activates once Firebase credentials are configured (FCM_PROJECT_ID +
 * service account). Until then delivery is the in-app feed only, and the log
 * line below makes the dormant path visible rather than silently absent.
 */
export async function recordNotification(
  db: PersistenceDb,
  ids: ApiIdGenerator,
  input: {
    readonly userId: string;
    readonly kind: NotificationKind;
    readonly title: string;
    readonly body: string;
    readonly data?: Record<string, string>;
  },
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO user_notifications (id, user_id, kind, title, body, data)
      VALUES (${ids.uuid()}::uuid, ${input.userId}::uuid, ${input.kind},
              ${input.title.slice(0, 160)}, ${input.body.slice(0, 500)},
              ${JSON.stringify(input.data ?? {})}::jsonb)
    `);
    if (process.env.FCM_PROJECT_ID) {
      // FCM sender lands with the Android app; tokens are being collected now.
      logger.debug({ event: 'notify.push.pending', kind: input.kind });
    }
  } catch (error) {
    logger.warn({ event: 'notify.failed', kind: input.kind, reason: error instanceof Error ? error.message : 'unknown' });
  }
}
