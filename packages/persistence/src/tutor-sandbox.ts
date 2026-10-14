/**
 * The tutor's sandbox set-up (ENG-22): publishes a sandbox-only `ai-tutoring` consent definition and
 * grants it to the sandbox's sample students, so the AI tutor can be shown on demo.oneby8.com.
 *
 * Why this exists: the tutor serves only students who hold `ai-tutoring` (ENG-01), and no definition of
 * that purpose may be published to real students before HG-6 approves its wording — so every real
 * student reads "not consented", which is correct. The sandbox's people are fictional (ADR-046), so the
 * consent a presenter needs there can be put in place by this command, and nowhere else.
 *
 * The lock mirrors the sandbox seed's (sandbox-guard.ts on feat/demo-sandbox, ADR-046) and has no
 * override: ONE_SANDBOX=true, NODE_ENV not production, a database whose name ends in `_sandbox` on the
 * sandbox's own host or this machine, and — checked against the live database before any write — every
 * account a sample account (`@demo.oneby8.com`, or a reserved `.example` / `.test` domain).
 *
 * Design: docs/architecture/tutor-hints-table-design.md ("How it is switched on in the sandbox").
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const TUTOR_SANDBOX_CONSENT_VERSION = 'sandbox-demo-1';
export const TUTOR_SANDBOX_CONSENT_TITLE = 'Let the AI tutor help me with practice (sandbox, sample data)';
const SANDBOX_HOSTS: readonly string[] = ['postgres-demo', 'localhost', '127.0.0.1', '[::1]', '::1'];

export class TutorSandboxRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TutorSandboxRefused';
  }
}

/** Throws naming the first rule that failed (never a password); returns the database name. */
export function assertTutorSandboxTarget(env: Readonly<Record<string, string | undefined>>): { readonly databaseName: string } {
  if (env.ONE_SANDBOX !== 'true') throw new TutorSandboxRefused('Refusing to run: this command only runs against the sandbox, and ONE_SANDBOX=true is not set.');
  if (env.NODE_ENV === 'production') throw new TutorSandboxRefused('Refusing to run: NODE_ENV is production.');
  const raw = env.DATABASE_URL?.trim();
  if (!raw) throw new TutorSandboxRefused('Refusing to run: DATABASE_URL is required.');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new TutorSandboxRefused('Refusing to run: DATABASE_URL is not a valid URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!/^[a-z0-9_]+_sandbox$/u.test(databaseName)) throw new TutorSandboxRefused(`Refusing to run: "${databaseName}" is not a sandbox database (its name must end in "_sandbox").`);
  if (!SANDBOX_HOSTS.includes(parsed.hostname.toLowerCase())) throw new TutorSandboxRefused(`Refusing to run: the database host "${parsed.hostname}" is not the sandbox database.`);
  return { databaseName };
}

/** A sample address: the sandbox's own domain, or a reserved example / test domain. */
export function isSampleAddress(email: string): boolean {
  const value = email.trim().toLowerCase();
  return /@demo\.oneby8\.com$/u.test(value) || /@([a-z0-9-]+\.)*(example|test)$/u.test(value) || /@example\.(com|org|net)$/u.test(value);
}

/**
 * Publishes the sandbox definition (if no live `ai-tutoring` definition exists) and grants it to every
 * sample student who does not hold it. Refuses before any write if a non-sample account exists.
 */
export async function setUpTutorSandboxConsent(pool: Pool, env: Readonly<Record<string, string | undefined>>): Promise<{
  readonly definitionCreated: boolean; readonly granted: number;
}> {
  assertTutorSandboxTarget(env);
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const accounts = await client.query<{ email: string | null }>('SELECT email FROM users');
    if (accounts.rows.some((row) => !row.email || !isSampleAddress(row.email))) {
      throw new TutorSandboxRefused('Refusing to run: this database holds an account that is not a sample account.');
    }
    const live = await client.query<{ version: string }>(
      `SELECT version FROM consent_definitions WHERE consent_key = 'ai-tutoring' AND retired_at IS NULL AND effective_from <= now()
       ORDER BY effective_from DESC LIMIT 1`,
    );
    let version = live.rows[0]?.version;
    const definitionCreated = !version;
    if (!version) {
      version = TUTOR_SANDBOX_CONSENT_VERSION;
      await client.query(
        `INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, document_ref, effective_from)
         VALUES ('ai-tutoring', $1, $2, 'OPTIONAL', true, 'docs/legal/engine-consent-notice-DRAFT-for-legal-review.md', now() - interval '1 second')`,
        [version, TUTOR_SANDBOX_CONSENT_TITLE],
      );
    }
    const students = await client.query<{ user_id: string }>(
      `SELECT p.user_id FROM student_profiles p
       WHERE NOT EXISTS (
         SELECT 1 FROM user_consents c WHERE c.user_id = p.user_id AND c.consent_key = 'ai-tutoring' AND c.version = $1 AND c.action = 'GRANTED'
           AND c.recorded_at = (SELECT max(l.recorded_at) FROM user_consents l WHERE l.user_id = p.user_id AND l.consent_key = 'ai-tutoring'))`,
      [version],
    );
    for (const student of students.rows) {
      await client.query(
        `INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at) VALUES ($1, $2, 'ai-tutoring', $3, 'GRANTED', now())`,
        [randomUUID(), student.user_id, version],
      );
    }
    await client.query('COMMIT');
    return { definitionCreated, granted: students.rows.length };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
