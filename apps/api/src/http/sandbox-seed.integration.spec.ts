/**
 * The sandbox seed (ADR-046) through the real API: each demo account lands in exactly one
 * workspace and sees only what that role is allowed to see, and the seed never runs over
 * a database holding real accounts.
 *
 * Seeds a throwaway schema of the local Postgres in DATABASE_URL, binds every persona to a
 * stub sign-in subject, and calls the same routes the web app calls. The stub verifier
 * stands in for the sandbox's Cognito pool; everything after the token is the real code.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { DEMO_PERSONAS, seedSandbox, type DemoPersona } from '@planthepath/persistence/src/sandbox-seed.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for sandbox seed tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Sandbox seed tests require local Postgres');
const schemaName = 'sandbox_seed_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const subjects = new Map<DemoPersona, string>(DEMO_PERSONAS.map((persona) => [persona, randomUUID()]));
let app: INestApplication;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  await seedSandbox(pool, { subjects });
  const tokens = new Set(subjects.values());
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      verifier: { async verifyAccessToken(token: string) {
        if (!tokens.has(token)) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
      } },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
}, 600_000);

afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

const api = () => request(app.getHttpServer());
const as = (persona: DemoPersona) => ({ Authorization: 'Bearer ' + subjects.get(persona)! });

interface Context {
  readonly memberships: readonly { readonly organizationId: string; readonly role: string }[];
  readonly studentRelationships: readonly { readonly institutionId: string }[];
  readonly formerStudentRelationships: readonly { readonly institutionId: string }[];
}
async function context(persona: DemoPersona): Promise<Context> {
  return (await api().get('/api/v1/security/context').set(as(persona)).expect(200)).body as Context;
}

describe('sandbox seed: one demo account, one workspace', () => {
  it('gives every staff persona exactly one membership, in the role its story needs', async () => {
    const expected: Partial<Record<DemoPersona, string>> = {
      placement: 'PLACEMENT_ADMIN', 'institution-admin': 'INSTITUTION_ADMIN', lecturer: 'FACULTY_LECTURER',
      'department-head': 'DEPARTMENT_HEAD', employer: 'RECRUITER', 'employer-owner': 'EMPLOYER_OWNER',
      operations: 'OPERATIONS_ADMIN', growth: 'GROWTH_EXECUTIVE',
    };
    for (const [persona, role] of Object.entries(expected) as [DemoPersona, string][]) {
      const found = await context(persona);
      expect(found.memberships.map((membership) => membership.role), persona).toEqual([role]);
      expect(found.studentRelationships, persona).toEqual([]);
      expect(found.formerStudentRelationships, persona).toEqual([]);
    }
  });

  it('makes the student a current student of the sample college and nothing else', async () => {
    const found = await context('student');
    expect(found.memberships).toEqual([]);
    expect(found.studentRelationships).toHaveLength(1);
    const college = (await context('placement')).memberships[0]!.organizationId;
    expect(found.studentRelationships[0]!.institutionId).toBe(college);
    await api().get('/api/v1/students/me').set(as('student')).expect(200);
  });

  it('makes the graduate a former student with no current college', async () => {
    const found = await context('graduate');
    expect(found.memberships).toEqual([]);
    expect(found.studentRelationships).toEqual([]);
    expect(found.formerStudentRelationships.map((relationship) => relationship.institutionId)).toHaveLength(1);
  });

  it('shows the student the jobs aimed at them, their applications and their interview', async () => {
    const jobs = (await api().get('/api/v1/opportunities').set(as('student')).expect(200)).body as { readonly opportunities?: readonly { readonly title?: string }[] };
    const titles = JSON.stringify(jobs);
    expect(titles).toContain('Graduate Software Engineer');
    expect(titles).toContain('Data Analyst Intern');
    // Aimed at the ECE department only; the student is in CSE.
    expect(titles).not.toContain('Embedded Systems Trainee');
    const applications = JSON.stringify((await api().get('/api/v1/students/me/applications').set(as('student')).expect(200)).body);
    expect(applications).toContain('INTERVIEW');
    expect(applications).toContain('APPLIED');
    const interviews = JSON.stringify((await api().get('/api/v1/students/me/interviews').set(as('student')).expect(200)).body);
    expect(interviews).toContain('SCHEDULED');
  });

  it('shows the recruiter the employer\'s jobs and candidates, and nothing of the college', async () => {
    const employerId = (await context('employer')).memberships[0]!.organizationId;
    const collegeId = (await context('placement')).memberships[0]!.organizationId;
    const jobs = JSON.stringify((await api().get(`/api/v1/employers/${employerId}/opportunities`).set(as('employer')).expect(200)).body);
    for (const title of ['Graduate Software Engineer', 'Data Analyst Intern', 'Embedded Systems Trainee']) expect(jobs).toContain(title);
    const listed = (await api().get(`/api/v1/employers/${employerId}/opportunities`).set(as('employer')).expect(200)).body as { readonly opportunities: readonly { readonly id: string; readonly title: string }[] };
    const engineer = listed.opportunities.find((job) => job.title === 'Graduate Software Engineer')!;
    const candidates = JSON.stringify((await api().get(`/api/v1/employers/${employerId}/opportunities/${engineer.id}/applications`).set(as('employer')).expect(200)).body);
    expect(candidates).toContain('Arjun Reddy');
    expect(candidates).toContain('Priya Sharma');
    const offers = JSON.stringify((await api().get(`/api/v1/employers/${employerId}/offers`).set(as('employer')).expect(200)).body);
    expect(offers).toContain('EXTENDED');
    // Readiness is never an employer's to see, in the sandbox as anywhere.
    expect(jobs + candidates + offers).not.toMatch(/READY_FOR_NEXT_STEP|PROGRESSING|DEVELOPING|NOT_ENOUGH_EVIDENCE/);
    expect((await api().get(`/api/v1/institutions/${collegeId}/settings`).set(as('employer'))).status).toBe(403);
  });

  it('shows the placement officer the approved drive and the placement register', async () => {
    const collegeId = (await context('placement')).memberships[0]!.organizationId;
    const drives = JSON.stringify((await api().get(`/api/v1/institutions/${collegeId}/campus-drives`).set(as('placement')).expect(200)).body);
    expect(drives).toContain('APPROVED');
    await api().get(`/api/v1/institutions/${collegeId}/placement-register`).set(as('placement')).expect(200);
  });

  it('opens each college workspace for its own role and keeps the student out of them', async () => {
    const collegeId = (await context('placement')).memberships[0]!.organizationId;
    await api().get(`/api/v1/institutions/${collegeId}/settings`).set(as('institution-admin')).expect(200);
    await api().get(`/api/v1/institutions/${collegeId}/my-students`).set(as('lecturer')).expect(200);
    await api().get(`/api/v1/institutions/${collegeId}/department-overview`).set(as('department-head')).expect(200);
    expect((await api().get(`/api/v1/institutions/${collegeId}/settings`).set(as('student'))).status).toBe(403);
    expect((await api().get(`/api/v1/institutions/${collegeId}/campus-drives`).set(as('graduate'))).status).toBe(403);
  });

  it('opens operations and growth for their own people only', async () => {
    await api().get('/api/v1/operations/overview').set(as('operations')).expect(200);
    const growth = JSON.stringify((await api().get('/api/v1/growth/me').set(as('growth')).expect(200)).body);
    expect(growth).toContain('COLLEGE_PARTNERSHIPS');
    const territory = JSON.stringify((await api().get('/api/v1/growth/territory').set(as('growth')).expect(200)).body);
    expect(territory).toContain('Karnataka');
    const leads = JSON.stringify((await api().get('/api/v1/growth/leads').set(as('growth')).expect(200)).body);
    expect(leads).toContain('Riverbend College of Engineering');
    expect(leads).toContain('Sunvale Polytechnic');
    expect((await api().get('/api/v1/operations/overview').set(as('growth'))).status).toBe(403);
    expect((await api().get('/api/v1/growth/me').set(as('operations'))).status).toBe(403);
  });

  it('computes readiness bands from evidence, as advisory bands only', async () => {
    const bands = await pool.query<{ band: string; advisory: boolean; employer_visible: boolean }>(
      `SELECT DISTINCT ON (subject_user_id) band, advisory, employer_visible FROM readiness_snapshots ORDER BY subject_user_id, generated_at DESC`,
    );
    expect(bands.rows).toHaveLength(30);
    expect(new Set(bands.rows.map((row) => row.band))).toEqual(new Set(['READY_FOR_NEXT_STEP', 'PROGRESSING', 'DEVELOPING', 'NOT_ENOUGH_EVIDENCE']));
    expect(bands.rows.every((row) => row.advisory && !row.employer_visible)).toBe(true);
  });

  it('marks every account it created as a sample account', async () => {
    const emails = await pool.query<{ email: string }>(`SELECT email FROM users`);
    expect(emails.rows.length).toBeGreaterThan(40);
    expect(emails.rows.every((row) => /@demo\.oneby8\.com$|\.example$/.test(row.email))).toBe(true);
  });

  it('is idempotent and rebinds personas on a second run', async () => {
    const before = (await pool.query<{ count: string }>(`SELECT count(*) FROM applications`)).rows[0]!.count;
    const rebound = new Map(subjects);
    const replacement = randomUUID();
    rebound.set('lecturer', replacement);
    expect(await seedSandbox(pool, { subjects: rebound })).toContain('already seeded');
    expect((await pool.query<{ count: string }>(`SELECT count(*) FROM applications`)).rows[0]!.count).toBe(before);
    const lecturer = await pool.query<{ external_subject: string }>(`SELECT external_subject FROM users WHERE email='lecturer@demo.oneby8.com'`);
    expect(lecturer.rows[0]!.external_subject).toBe(replacement);
    await seedSandbox(pool, { subjects });
  }, 120_000);

  it('refuses to seed a database that holds a real account', async () => {
    await pool.query(`INSERT INTO users (id, email, state) VALUES ($1,'someone@gmail.com','ACTIVE')`, [randomUUID()]);
    await expect(seedSandbox(pool, { subjects })).rejects.toThrow(/not sandbox sample accounts/);
  });
});
