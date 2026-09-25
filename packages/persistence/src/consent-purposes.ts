/**
 * Server-side consent purposes for the learning engine (ENG-01).
 *
 * Adaptive learning is behavioural profiling, AI tutoring sends a student's work to a model, and
 * model improvement reuses their attempts — each needs its own optional, withdrawable consent,
 * and each gates exactly one capability. Engine code asks `hasConsentPurpose` on every request and
 * takes the non-adaptive path when it answers false. It fails closed: no live definition, a
 * withdrawal, or a grant of an older version all mean "not consented". Nothing is cached, so a
 * withdrawal takes effect on the very next request.
 */
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';

export const engineConsentPurposes = ['adaptive-learning', 'ai-tutoring', 'model-improvement'] as const;
export type EngineConsentPurpose = (typeof engineConsentPurposes)[number];

/** The one capability each purpose gates, recorded next to the purpose so the pairing is reviewable. */
export const engineConsentPurposeGates: Readonly<Record<EngineConsentPurpose, string>> = {
  'adaptive-learning': 'Personalised learning plan and mastery tracking from attempt history',
  'ai-tutoring': 'AI tutor replies to the student',
  'model-improvement': 'Inclusion of de-identified attempts in model-improvement exports',
};

export async function hasConsentPurpose(db: PersistenceDb, userId: string, purpose: EngineConsentPurpose): Promise<boolean> {
  if (!(engineConsentPurposes as readonly string[]).includes(purpose)) return false;
  const result = await db.execute(sql`
    SELECT latest.action
    FROM consent_definitions d
    JOIN LATERAL (
      SELECT c.version, c.action FROM user_consents c
      WHERE c.user_id = ${userId}::uuid AND c.consent_key = d.consent_key
      ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
    ) latest ON latest.version = d.version
    WHERE d.consent_key = ${purpose} AND d.retired_at IS NULL AND d.effective_from <= now()
  `) as unknown as { rows: { action: string }[] };
  return result.rows[0]?.action === 'GRANTED';
}

/** Of the given students, those whose attempts may enter a model-improvement export. */
export async function studentsConsentingToModelImprovement(db: PersistenceDb, userIds: readonly string[]): Promise<readonly string[]> {
  const allowed: string[] = [];
  for (const userId of userIds) {
    if (await hasConsentPurpose(db, userId, 'model-improvement')) allowed.push(userId);
  }
  return allowed;
}
