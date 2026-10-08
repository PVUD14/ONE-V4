/**
 * Synthetic month of attempts for rehearsing the monthly recalibration on a LOCAL database (ENG-26):
 *   corepack pnpm --filter @planthepath/persistence engine:recalibration-synthetic-seed --local \
 *     [--learners 300] [--seed 1] [--perturb]
 *
 * Why this exists: the runbook (docs/ops/runbook-monthly-recalibration.md) is rehearsed end to end on
 * a seeded local database before Divakar runs it on pilot data, and a recalibration needs consenting
 * learners with enough attempts. This writes them: synthetic accounts (`@recalibration.example.test`)
 * holding a local model-improvement consent, each answering 8 items on each of the first two or three
 * seeded topics in order, generated from known BKT parameters. `--perturb` makes the first topic much
 * harder to guess and the second much easier to slip on, so a second month shows drift in a report.
 *
 * Synthetic data for a synthetic database only: it refuses unless the database host is this machine,
 * `--local` is given, and NODE_ENV is not production. There is no override.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const args = process.argv.slice(2);
const option = (name: string, fallback: number): number => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 5000) throw new Error(`--${name} must be a whole number 1-5000`);
  return value;
};
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const host = new URL(databaseUrl).hostname;
if (process.env.NODE_ENV === 'production' || !args.includes('--local') || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  throw new Error('Refusing: this writes synthetic learners and a local consent definition. It runs only with --local against a database on this machine.');
}

const LEARNERS = option('learners', 300);
const SEED = option('seed', 1);
const PERTURB = args.includes('--perturb');
const CONSENT_VERSION = 'local-recalibration-rehearsal';
const OPPORTUNITIES = 8;
// (P(L0), P(T), P(G), P(S)) per topic — admissible under mastery-bkt's five conditions.
const TRUTH: [number, number, number, number][] = [[0.36, 0.1, 0.3, 0.05], [0.25, 0.15, 0.2, 0.1], [0.5, 0.05, 0.25, 0.08]];
const PERTURBED: [number, number, number, number][] = [[0.36, 0.1, 0.05, 0.05], [0.25, 0.15, 0.2, 0.25], TRUTH[2]!];

/** mulberry32: a small deterministic generator, so a rehearsal can be repeated exactly. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed item id per (topic, opportunity), so every learner answers the same 8 items per topic. */
function itemId(topicId: string, opportunity: number): string {
  const hex = createHash('sha256').update(`eng26-rehearsal:${topicId}:${opportunity}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const topics = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM taxonomy_nodes WHERE kind = 'TOPIC' AND active ORDER BY stable_key, id LIMIT 3`,
  );
  if (topics.rows.length < 2) throw new Error('Needs at least two active topics: run db:seed:career-readiness first.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const live = await client.query(
      `SELECT version FROM consent_definitions WHERE consent_key = 'model-improvement' AND retired_at IS NULL AND effective_from <= now()`,
    );
    if (live.rows.length === 0) {
      await client.query(
        `INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
         VALUES ('model-improvement', $1, 'Local rehearsal purpose (synthetic)', 'OPTIONAL', true, now() - interval '1 day')
         ON CONFLICT DO NOTHING`, [CONSENT_VERSION],
      );
    }
    const version = live.rows[0]?.version ?? CONSENT_VERSION;
    const random = generator(SEED);
    const truth = PERTURB ? PERTURBED : TRUTH;
    let attempts = 0;
    for (let index = 0; index < LEARNERS; index += 1) {
      const userId = randomUUID();
      await client.query(`INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')`, [userId, `rehearsal-${userId}@recalibration.example.test`]);
      await client.query(
        `INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
         VALUES ($1, $2, 'model-improvement', $3, 'GRANTED', now() - interval '1 hour')`, [randomUUID(), userId, version],
      );
      const session = randomUUID();
      await client.query(
        `INSERT INTO learning_sessions (id, subject_user_id, mode, started_at) VALUES ($1, $2, 'PRACTICE', now() - interval '50 minutes')`, [session, userId],
      );
      for (const [t, topic] of topics.rows.entries()) {
        const [pInit, pLearn, pGuess, pSlip] = truth[t]!;
        let known = random() < pInit;
        for (let opportunity = 0; opportunity < OPPORTUNITIES; opportunity += 1) {
          const correct = known ? random() >= pSlip : random() < pGuess;
          await client.query(
            `INSERT INTO learning_attempt_events
               (id, subject_user_id, session_id, item_source, item_id, item_version, skill_id, context, answered, correct, score,
                highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
             VALUES ($1, $2, $3, 'CAREER_READINESS_QUESTION', $4, 1, $5, 'PRACTICE', true, $6, $7, 0, false, 'recalibration-rehearsal',
                     'assessment_attempt', $8, now() - make_interval(mins => $9))`,
            [randomUUID(), userId, session, itemId(topic.id, opportunity), topic.id, correct, correct ? 1 : 0, randomUUID(), 40 - t * OPPORTUNITIES - opportunity],
          );
          attempts += 1;
          if (!known && random() < pLearn) known = true;
        }
      }
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ event: 'engine.recalibration.synthetic-seeded', learners: LEARNERS, topics: topics.rows.length, attempts, perturbed: PERTURB }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
