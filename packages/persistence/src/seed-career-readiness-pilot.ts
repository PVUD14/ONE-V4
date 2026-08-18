import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { publishCareerReadinessPilot, stageImportManifest, type PilotFixture } from './career-readiness.js';
import type { ImportPackageManifest } from '@planthepath/career-readiness/src/index.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_CONTENT_SEED !== 'true') {
  throw new Error('Refusing production content publication without ALLOW_PRODUCTION_CONTENT_SEED=true');
}
const authorUserId = requireUuidEnv('CAREER_READINESS_AUTHOR_USER_ID');
const reviewerUserId = requireUuidEnv('CAREER_READINESS_REVIEWER_USER_ID');
const publisherUserId = requireUuidEnv('CAREER_READINESS_PUBLISHER_USER_ID');

const pilotUrl = new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url);
const stagingUrl = new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url);
const [pilotBytes, stagingBytes] = await Promise.all([readFile(pilotUrl), readFile(stagingUrl)]);
const fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
const stagingManifest = JSON.parse(stagingBytes.toString('utf8')) as ImportPackageManifest;
const pool = new Pool({ connectionString: databaseUrl });

try {
  const staged = await stageImportManifest(pool, stagingManifest, authorUserId);
  const published = await publishCareerReadinessPilot(
    pool,
    fixture,
    createHash('sha256').update(pilotBytes).digest('hex'),
    { authorUserId, reviewerUserId, publisherUserId },
  );
  console.log(JSON.stringify({ staged, published }));
} finally {
  await pool.end();
}

function requireUuidEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be an existing internal user UUID`);
  }
  return value;
}
