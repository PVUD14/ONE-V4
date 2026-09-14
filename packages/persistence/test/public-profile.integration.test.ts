/**
 * Public profile share links.
 *
 * This is the only thing in ONE that serves data to somebody who is not signed in, so the
 * tests here are almost entirely about what a stranger with a link cannot reach, and about
 * revocation and expiry meaning exactly what a student would assume they mean.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  DEFAULT_SECTIONS,
  PublicProfileError,
  createShareLink,
  digestShareToken,
  getLiveShareLink,
  resolvePublicProfile,
  revokeShareLink,
  shareTokenMatches,
  updateShareLink,
} from '../src/public-profile.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
let studentId: string;
let institutionId: string;
let reviewerId: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
}, 120_000);

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  studentId = randomUUID();
  institutionId = randomUUID();
  reviewerId = randomUUID();
  for (const id of [studentId, reviewerId]) {
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, `${id}@example.test`]);
  }
  await client.query("INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1, 'INSTITUTION', 'Public Profile College', 'VERIFIED')", [institutionId]);
  await client.query(
    `INSERT INTO student_profiles (user_id, profile_headline, profile_summary, target_career, career_interests, portfolio_url)
     VALUES ($1, 'Security operations', 'A short summary.', 'SOC Analyst', ARRAY['SIEM triage','Python'], 'https://example.test/rahul')`,
    [studentId],
  );
  await client.query(
    `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
     VALUES ($1,$2,$3,'CSE-001','Rahul Kumar','ACTIVE')`,
    [randomUUID(), institutionId, studentId],
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

const photoUrl = (): string => '/photo';

async function publish(overrides: Parameters<typeof createShareLink>[1] extends infer T ? Partial<T> : never = {}) {
  const token = `tok-${randomUUID().replace(/-/g, '')}`;
  const link = await createShareLink(client as never, {
    studentUserId: studentId,
    linkId: randomUUID(),
    tokenDigest: digestShareToken(token),
    ...overrides,
  } as never);
  return { token, link };
}

async function addVerifiedQualification(): Promise<string> {
  const qualification = randomUUID();
  await client.query(
    `INSERT INTO student_qualifications
       (id, student_user_id, institution_id, qualification_type, programme_name, started_on, verification_state)
     VALUES ($1,$2,$3,'BTECH','Computer Science and Engineering','2022-08-01','VERIFIED')`,
    [qualification, studentId, institutionId],
  );
  await client.query(
    `INSERT INTO student_academic_terms
       (id, qualification_id, sequence, label, result_value, result_scale, source, verification_state, verified_at, verified_by_user_id)
     VALUES ($1,$2,6,'Semester 6',8.40,'CGPA_10','STUDENT_DECLARED','VERIFIED', now(), $3)`,
    [randomUUID(), qualification, reviewerId],
  );
  return qualification;
}

describe('a share link is the student\'s to switch off', () => {
  it('serves the page while the link is live', async () => {
    await addVerifiedQualification();
    const { token } = await publish();
    const page = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    expect(page?.name).toBe('Rahul Kumar');
    expect(page?.education[0]?.verified).toBe(true);
  });

  it('stops serving the moment it is revoked, for everyone who had it', async () => {
    const { token } = await publish();
    expect(await resolvePublicProfile(client as never, digestShareToken(token), photoUrl)).not.toBeNull();
    await revokeShareLink(client as never, studentId);
    // The same token that worked a line ago is now simply not a page.
    expect(await resolvePublicProfile(client as never, digestShareToken(token), photoUrl)).toBeNull();
  });

  it('kills the old address when a new link is published', async () => {
    const first = await publish();
    const second = await publish();
    expect(await resolvePublicProfile(client as never, digestShareToken(first.token), photoUrl)).toBeNull();
    expect(await resolvePublicProfile(client as never, digestShareToken(second.token), photoUrl)).not.toBeNull();
    // And only one live link exists, so "revoke" can never leave a second address alive.
    const live = await client.query('SELECT count(*)::int AS count FROM public_profile_links WHERE student_user_id=$1 AND revoked_at IS NULL', [studentId]);
    expect(live.rows[0].count).toBe(1);
  });

  it('stops serving once it expires, without anybody doing anything', async () => {
    const { token } = await publish();
    await client.query("UPDATE public_profile_links SET created_at = now() - interval '100 days', expires_at = now() - interval '1 day' WHERE student_user_id=$1", [studentId]);
    expect(await resolvePublicProfile(client as never, digestShareToken(token), photoUrl)).toBeNull();
  });

  it('cannot tell an unknown token from an expired or revoked one', async () => {
    const { token } = await publish();
    await revokeShareLink(client as never, studentId);
    const revoked = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    const unknown = await resolvePublicProfile(client as never, digestShareToken('never-issued'), photoUrl);
    const malformed = await resolvePublicProfile(client as never, 'not-a-digest', photoUrl);
    expect([revoked, unknown, malformed]).toEqual([null, null, null]);
  });

  it('stores only a digest, so the table leaks no working links', async () => {
    const { token } = await publish();
    const row = await client.query('SELECT token_digest FROM public_profile_links WHERE student_user_id=$1', [studentId]);
    const stored = row.rows[0].token_digest as string;
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(shareTokenMatches(token, stored)).toBe(true);
    expect(shareTokenMatches('some-other-token', stored)).toBe(false);
  });

  it('stops serving when the account itself stops being active', async () => {
    const { token } = await publish();
    await client.query("UPDATE users SET state='SUSPENDED' WHERE id=$1", [studentId]);
    // No separate revocation step needed: a suspended person has no public page.
    expect(await resolvePublicProfile(client as never, digestShareToken(token), photoUrl)).toBeNull();
  });
});

describe('what a stranger can and cannot reach', () => {
  it('publishes neither the readiness band nor anything derived from one', async () => {
    await addVerifiedQualification();
    const { token } = await publish({ sections: { showAssessments: true } } as never);
    const page = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    const serialised = JSON.stringify(page);
    expect(serialised).not.toMatch(/readiness|NOT_ENOUGH_EVIDENCE|DEVELOPING|PROGRESSING|READY_FOR_NEXT_STEP|band/i);
    // And no score about the person: the summary is a count of facts, nothing else.
    expect(page).not.toHaveProperty('strength');
    expect(page).not.toHaveProperty('score');
    expect(typeof page?.verifiedCount).toBe('number');
  });

  it('never publishes the email address', async () => {
    const { token } = await publish();
    const page = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    expect(JSON.stringify(page)).not.toContain('@example.test');
  });

  it('keeps assessment results off until the student switches them on', async () => {
    const { token } = await publish();
    const off = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    expect(off?.assessments).toEqual([]);
    // The default that matters: a percentage attached to a person is a deliberate act.
    expect(DEFAULT_SECTIONS.showAssessments).toBe(false);
    expect(DEFAULT_SECTIONS.showPhoto).toBe(false);
  });

  it('hides a whole section when its flag is off', async () => {
    await addVerifiedQualification();
    const { token } = await publish({ sections: { showEducation: false, showSkills: false, showPortfolio: false } } as never);
    const page = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    expect(page?.education).toEqual([]);
    expect(page?.skills).toEqual([]);
    expect(page?.portfolioUrl).toBeNull();
  });

  it('drops self-reported records when the student asks it to, keeping the verified ones', async () => {
    await addVerifiedQualification();
    const claimed = randomUUID();
    await client.query(
      `INSERT INTO student_qualifications
         (id, student_user_id, institution_name_declared, qualification_type, programme_name, verification_state)
       VALUES ($1,$2,'A college elsewhere','DIPLOMA','Electronics','SELF_REPORTED')`,
      [claimed, studentId],
    );
    const shown = await publish();
    const withBoth = await resolvePublicProfile(client as never, digestShareToken(shown.token), photoUrl);
    expect(withBoth?.education).toHaveLength(2);

    const hidden = await publish({ sections: { showSelfReported: false } } as never);
    const verifiedOnly = await resolvePublicProfile(client as never, digestShareToken(hidden.token), photoUrl);
    expect(verifiedOnly?.education).toHaveLength(1);
    expect(verifiedOnly?.education[0]?.verified).toBe(true);
  });

  it('counts facts rather than rating the person', async () => {
    await addVerifiedQualification();
    const { token } = await publish();
    const page = await resolvePublicProfile(client as never, digestShareToken(token), photoUrl);
    // One qualification plus one term, both confirmed.
    expect(page?.verifiedCount).toBe(2);
    expect(page?.totalClaimCount).toBe(2);
  });
});

describe('changing a live link', () => {
  it('extends from now rather than from the old expiry', async () => {
    await publish({ days: 5 } as never);
    await client.query("UPDATE public_profile_links SET created_at = now() - interval '100 days', expires_at = now() - interval '1 day' WHERE student_user_id=$1", [studentId]);
    const extended = await updateShareLink(client as never, { studentUserId: studentId, extendDays: 90 });
    // A lapsed link and a fresh one behave identically once extended.
    expect(extended.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a cover that is not one of the four', async () => {
    await publish();
    await expect(updateShareLink(client as never, { studentUserId: studentId, coverKey: 'RAINBOW' as never }))
      .rejects.toBeInstanceOf(PublicProfileError);
  });

  it('refuses to change a link that does not exist', async () => {
    await expect(updateShareLink(client as never, { studentUserId: studentId, extendDays: 30 }))
      .rejects.toBeInstanceOf(PublicProfileError);
  });

  it('reports no live link once revoked', async () => {
    await publish();
    await revokeShareLink(client as never, studentId);
    expect(await getLiveShareLink(client as never, studentId)).toBeNull();
  });
});
