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
import { sql, type SQL } from 'drizzle-orm';
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
  const result = await db.execute(sql`SELECT ${consentPurposeHeldSql(purpose, sql`${userId}::uuid`)} AS held`) as unknown as { rows: { held: boolean }[] };
  return result.rows[0]?.held === true;
}

/**
 * The one rule for "this user holds the purpose", as a SQL boolean over a user-id expression, so a
 * read over many students (the faculty cohort view, INST-15) applies exactly the rule
 * `hasConsentPurpose` applies: the latest recorded action for the live definition's key is a GRANT
 * of that definition's version. No live definition means false for everyone (fails closed).
 */
export function consentPurposeHeldSql(purpose: EngineConsentPurpose, userId: SQL): SQL {
  if (!(engineConsentPurposes as readonly string[]).includes(purpose)) return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1
    FROM consent_definitions d
    JOIN LATERAL (
      SELECT c.version, c.action FROM user_consents c
      WHERE c.user_id = ${userId} AND c.consent_key = d.consent_key
      ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
    ) latest ON latest.version = d.version AND latest.action = 'GRANTED'
    WHERE d.consent_key = ${purpose} AND d.retired_at IS NULL AND d.effective_from <= now()
  )`;
}

/** True when a live definition of the purpose exists — whether students have been asked at all. */
export async function consentPurposeOffered(db: PersistenceDb, purpose: EngineConsentPurpose): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM consent_definitions d
      WHERE d.consent_key = ${purpose} AND d.retired_at IS NULL AND d.effective_from <= now()) AS offered
  `) as unknown as { rows: { offered: boolean }[] };
  return result.rows[0]?.offered === true;
}

/** Of the given students, those whose attempts may enter a model-improvement export. */
export async function studentsConsentingToModelImprovement(db: PersistenceDb, userIds: readonly string[]): Promise<readonly string[]> {
  const allowed: string[] = [];
  for (const userId of userIds) {
    if (await hasConsentPurpose(db, userId, 'model-improvement')) allowed.push(userId);
  }
  return allowed;
}
