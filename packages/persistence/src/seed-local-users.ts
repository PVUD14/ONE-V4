/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-05
 * Agent-assisted: yes (Claude Code) · Reviewed: pending
 *
 * Creates the three local fixture accounts the career-readiness content seed
 * needs, and prints their ids ready to export.
 *
 * The content seed publishes governance-attributed content, so it demands an
 * existing author, an existing reviewer and an existing publisher — all three
 * are `NOT NULL REFERENCES users(id)` in the schema. That is right for an
 * operated environment, where those are real people. On a freshly migrated
 * local database the users table is empty, so there was no id anyone could
 * supply and no script created one: every first-time setup hit a wall.
 *
 * Author and reviewer must be *different* accounts. `enforce_content_review_
 * separation` rejects an approval by the author of the revision, which is
 * separation of duties working as intended — so this creates three distinct
 * accounts rather than reusing one.
 *
 * These are synthetic fixtures for a synthetic database. This script refuses to
 * run against production and has no override flag, because there is no
 * legitimate reason to invent an author for real content.
 */
import { Pool } from 'pg';

interface FixtureUser {
  readonly role: 'AUTHOR' | 'REVIEWER' | 'PUBLISHER';
  readonly id: string;
  readonly externalSubject: string;
  readonly email: string;
}

/**
 * Fixed ids so the script is idempotent and the values can be written down.
 * They satisfy the content seed's UUID check, which requires a version nibble
 * of 1-5 and a variant nibble of 8-b — a hand-typed UUID usually will not.
 */
const FIXTURES: readonly FixtureUser[] = [
  { role: 'AUTHOR', id: '11111111-1111-4111-8111-111111111111', externalSubject: 'local-fixture:content-author', email: 'local.content.author@example.test' },
  { role: 'REVIEWER', id: '22222222-2222-4222-8222-222222222222', externalSubject: 'local-fixture:content-reviewer', email: 'local.content.reviewer@example.test' },
  { role: 'PUBLISHER', id: '33333333-3333-4333-8333-333333333333', externalSubject: 'local-fixture:content-publisher', email: 'local.content.publisher@example.test' },
];

const ENV_VAR: Record<FixtureUser['role'], string> = {
  AUTHOR: 'CAREER_READINESS_AUTHOR_USER_ID',
  REVIEWER: 'CAREER_READINESS_REVIEWER_USER_ID',
  PUBLISHER: 'CAREER_READINESS_PUBLISHER_USER_ID',
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to create fixture accounts in production. These are local development users only.');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    for (const user of FIXTURES) {
      // ON CONFLICT with no target so a re-run is a no-op whichever unique
      // index it collides with — id, external_subject or lower(email).
      await pool.query(
        `INSERT INTO users (id, external_subject, email, state)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT DO NOTHING`,
        [user.id, user.externalSubject, user.email],
      );
    }

    // Inserting without error is not the same as the rows being present: an
    // earlier local experiment may already hold one of these emails under a
    // different id, and ON CONFLICT DO NOTHING would hide that silently.
    const present = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [FIXTURES.map((user) => user.id)],
    );
    const found = new Set(present.rows.map((row) => row.id));
    const missing = FIXTURES.filter((user) => !found.has(user.id));
    if (missing.length > 0) {
      const detail = missing.map((user) => `${user.role} (${user.id}, ${user.email})`).join('; ');
      throw new Error(
        `Could not create ${missing.length} fixture account(s): ${detail}. ` +
        'Another user probably already holds that email or external subject in this database. ' +
        'Inspect the users table, or drop and re-migrate your local database.',
      );
    }

    console.log('Local content-governance fixture accounts are ready.\n');
    console.log('Git Bash / macOS / Linux:');
    for (const user of FIXTURES) console.log(`  export ${ENV_VAR[user.role]}=${user.id}`);
    console.log('\nWindows PowerShell:');
    for (const user of FIXTURES) console.log(`  $env:${ENV_VAR[user.role]} = '${user.id}'`);
    console.log('\nThen: corepack pnpm --filter @planthepath/persistence db:seed:career-readiness');
  } finally {
    await pool.end();
  }
}

await main();
