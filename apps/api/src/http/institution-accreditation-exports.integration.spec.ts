/**
 * Accreditation-ready outcome exports and the graduate self-report behind them (INST-13).
 *
 * Acceptance: the Placed counts reconcile with INST-12's placement statistics, and self-reported
 * fields are labelled as self-reported. Plus Appendix 3 §6.3: scope (a department head exports only
 * their department), relationship (only recorded graduates; transferred students and graduations
 * after the period are not counted), consent (a revoked share or a withdrawn self-report drops out on
 * the next export), contract (no pay, no readiness, no internal identifier; salary is NA), aggregates
 * (<5 and the totals that would give one back withheld), API (401, 403 without the capability for
 * every role, 400, audit rows) — and the student routes that record the self-report.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { InstitutionExportsController } from './institution-exports.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for accreditation export tests');
const schemaName = 'inst_accred_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let mechanical: string; let civil: string; let mechProgramme: string; let civilProgramme: string;
let gradBatch: string; let currentBatch: string; let civilBatch: string;
let owner: Staff; let admin: Staff; let placementAdmin: Staff; let headA: Staff; let headNoGrant: Staff; let unscopedHead: Staff; let faculty: Staff; let otherAdmin: Staff;

interface Staff { id: string; membershipId: string }
interface Student { userId: string }

const GRADUATED_2025 = "'2025-06-15T00:00:00Z'";
const GRADUATED_2024 = "'2024-06-15T00:00:00Z'";
const OFFER_2025 = "'2025-03-01T00:00:00Z'";
const OFFER_2024 = "'2024-03-01T00:00:00Z'";
const DECLARED = "'2025-08-01T00:00:00Z'";

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      verifier: { async verifyAccessToken(token: string) {
        if (!tokens.has(token)) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
      } },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    controllers: [InstitutionExportsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
}, 120_000);
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  mechanical = randomUUID(); civil = randomUUID(); mechProgramme = randomUUID(); civilProgramme = randomUUID();
  gradBatch = randomUUID(); currentBatch = randomUUID(); civilBatch = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute','VERIFIED',true), ($2,'INSTITUTION','Other Institute','VERIFIED',true)", [institutionId, otherInstitutionId]);
  await unit(mechanical, 'DEPARTMENT', 'Mechanical', null);
  await unit(civil, 'DEPARTMENT', 'Civil', null);
  await unit(mechProgramme, 'PROGRAM', 'B.Tech Mechanical', mechanical);
  await unit(civilProgramme, 'PROGRAM', 'B.Tech Civil', civil);
  await unit(gradBatch, 'BATCH', 'Mechanical 2021', mechanical);
  await unit(currentBatch, 'BATCH', 'Mechanical 2024', mechanical);
  await unit(civilBatch, 'BATCH', 'Civil 2020', civil);
  owner = await staff('INSTITUTION_OWNER');
  admin = await staff('INSTITUTION_ADMIN');
  placementAdmin = await staff('PLACEMENT_ADMIN');
  headA = await staff('DEPARTMENT_HEAD', mechanical);
  headNoGrant = await staff('DEPARTMENT_HEAD', civil);
  unscopedHead = await staff('DEPARTMENT_HEAD');
  faculty = await staff('FACULTY_LECTURER', mechanical);
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
  await grant(admin); await grant(headA); await grant(unscopedHead);
  await grant(otherAdmin, await staff('INSTITUTION_OWNER', null, otherInstitutionId));
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function staff(role: string, department: string | null = null, organization = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, department]);
  return { id, membershipId };
}
async function grant(member: Staff, grantor: Staff = owner) {
  await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'INSTITUTION_ANALYTICS',$3,'ACCREDITATION_LEAD')", [randomUUID(), member.membershipId, grantor.id]);
}
let roll = 0;
/** A rostered student who can sign in. `graduatedAt` records a graduation; `state` another relationship. */
async function student(department: string, programme: string, batch: string, relationship: { graduatedAt?: string; state?: string; endedAt?: string } = {}): Promise<Student> {
  const userId = randomUUID(); roll += 1;
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, 'student-' + roll + '@example.test']);
  const state = relationship.graduatedAt ? 'GRADUATED' : relationship.state ?? 'ACTIVE';
  const end = relationship.graduatedAt ?? relationship.endedAt ?? 'NULL';
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,program_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), institutionId, userId, 'R-' + roll, 'Student ' + roll, state, department, programme, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,'2020-07-01T00:00:00Z',${end})`, [randomUUID(), institutionId, userId, state]);
  return { userId };
}
const graduate2025 = () => student(mechanical, mechProgramme, gradBatch, { graduatedAt: GRADUATED_2025 });
const graduate2024 = () => student(civil, civilProgramme, civilBatch, { graduatedAt: GRADUATED_2024 });
async function employer(): Promise<{ id: string; opportunityId: string; versionId: string }> {
  const id = randomUUID(); const opportunityId = randomUUID(); const versionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER',$2,'VERIFIED',true)", [id, 'Employer ' + id.slice(0, 6)]);
  await pool.query('INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)', [opportunityId, id, admin.id, 'LOCAL-' + opportunityId.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Graduate engineer','FULL_TIME','REMOTE',$3,$4)", [versionId, opportunityId, '0'.repeat(64), admin.id]);
  await pool.query('UPDATE opportunities SET current_version_id=$2 WHERE id=$1', [opportunityId, versionId]);
  return { id, opportunityId, versionId };
}
/** An application with an accepted offer (pay recorded, as every offer has) dated `at`; shared unless told otherwise. */
async function placed(subject: Student, at: string, shared = true): Promise<string> {
  const target = await employer();
  const id = randomUUID();
  await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,created_at,updated_at,institution_visibility_granted_at)
    VALUES ($1,$2,$3,$4,$5,'OFFER',${at},${at},${at},${at},${shared ? at : 'NULL'})`, [id, target.opportunityId, target.id, target.versionId, subject.userId]);
  await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,responded_at,created_by_user_id,created_at,updated_at)
    VALUES ($1,$2,$3,'ACCEPTED','INR',900000,'YEAR',(${at})::timestamptz + interval '60 days',${at},${at},$4,${at},${at})`, [randomUUID(), id, target.id, admin.id]);
  return id;
}
/** A self-report as the table stores it, dated in the past so the month-end export counts it. */
async function declared(subject: Student, outcome: 'HIGHER_STUDIES' | 'ENTREPRENEURSHIP', at = DECLARED, withdrawn = false): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO student_outcome_declarations (id,student_user_id,institution_id,outcome,declared_at,created_at) VALUES ($1,$2,$3,$4,${at},${at})`, [id, subject.userId, institutionId, outcome]);
  if (withdrawn) await pool.query('UPDATE student_outcome_declarations SET withdrawn_at = now() WHERE id=$1', [id]);
  return id;
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const exportPath = (institution = institutionId) => base(institution) + '/exports/accreditation-outcomes';
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const audits = async (action: string) => (await pool.query('SELECT actor_user_id, organization_id, outcome, context FROM audit_events WHERE action=$1 ORDER BY occurred_at', [action])).rows;
function parseCsv(text: string): string[][] {
  expect(text.startsWith('﻿')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  const body = text.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; } else if (char === '\r' && body[index + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index += 1; } else cell += char;
  }
  return rows;
}
async function exportAs(actor: Staff): Promise<{ text: string; rows: string[][]; filename: string }> {
  const response = await api().post(exportPath()).set(auth(actor.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION' }).buffer(true).parse((res, done) => {
    let data = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { data += chunk; }); res.on('end', () => done(null, data));
  }).expect(200);
  const text = response.body as string;
  const filename = /filename="([^"]+)"/.exec(String(response.headers['content-disposition']))?.[1] ?? '';
  return { text, rows: parseCsv(text), filename };
}
const groupRow = (rows: string[][], department: string) => rows.find((row) => row[0] === 'Group' && row[1] === department);
const totalRow = (rows: string[][]) => rows.find((row) => row[0] === 'All graduates in scope');

/**
 * Mechanical, B.Tech Mechanical, graduated June 2025 (22 graduates): 6 placed (one of whom also
 * reported higher studies), 5 higher studies, 5 entrepreneurship, 6 with nothing counted — including
 * an accepted offer they kept private, a withdrawn self-report and a self-report made this month.
 * Also: 5 current students placed (not graduates), a transferred student placed, and a graduation
 * recorded for next week. Civil, B.Tech Civil, graduated June 2024 (10): 3 placed, 7 nothing.
 */
async function fixture(): Promise<{ higherStudies: Student[] }> {
  for (let index = 0; index < 5; index += 1) await placed(await graduate2025(), OFFER_2025);
  const both = await graduate2025();
  await placed(both, OFFER_2025); await declared(both, 'HIGHER_STUDIES');
  const higherStudies: Student[] = [];
  for (let index = 0; index < 5; index += 1) { const person = await graduate2025(); await declared(person, 'HIGHER_STUDIES'); higherStudies.push(person); }
  for (let index = 0; index < 5; index += 1) await declared(await graduate2025(), 'ENTREPRENEURSHIP');
  for (let index = 0; index < 3; index += 1) await graduate2025();
  await placed(await graduate2025(), OFFER_2025, false);
  await declared(await graduate2025(), 'HIGHER_STUDIES', DECLARED, true);
  await declared(await graduate2025(), 'HIGHER_STUDIES', 'now()');
  for (let index = 0; index < 5; index += 1) await placed(await student(mechanical, mechProgramme, currentBatch), OFFER_2025);
  await placed(await student(mechanical, mechProgramme, gradBatch, { state: 'TRANSFERRED', endedAt: "'2025-09-01T00:00:00Z'" }), OFFER_2025);
  await student(mechanical, mechProgramme, gradBatch, { graduatedAt: "now() + interval '7 days'" });
  for (let index = 0; index < 3; index += 1) await placed(await graduate2024(), OFFER_2024);
  for (let index = 0; index < 7; index += 1) await graduate2024();
  return { higherStudies };
}

describe('the accreditation outcomes export', () => {
  it('reconciles Placed with the placement statistics, counts each graduate once and labels self-reports', async () => {
    await fixture();
    const { rows, filename, text } = await exportAs(admin);
    const header = rows[0]!;
    expect(header).toEqual(['Row', 'Department', 'Programme', 'Year of graduation', 'Graduated', 'Placed (applications shared with the college)',
      'Higher studies (self-reported)', 'Entrepreneurship (self-reported)', 'No outcome shared',
      'Graduated within normal duration', 'Qualified in national or state examinations', 'Median salary or package', 'Note']);
    const notes = rows.filter((row) => row[0] === 'Note').map((row) => row[12]);
    expect(notes.some((note) => /Check every figure against the current official template .* ONE does not claim that this file complies with any format/.test(note!))).toBe(true);
    expect(notes.some((note) => /self-reported by graduates who chose to share them/.test(note!))).toBe(true);
    expect(notes.some((note) => /does not mean unplaced/.test(note!))).toBe(true);

    const mech = groupRow(rows, 'Mechanical')!;
    expect(mech).toEqual(['Group', 'Mechanical', 'B.Tech Mechanical', '2025', '22', '6', '5', '5', '6', 'NA', 'NA', 'NA', '']);
    // Civil: 3 placed and two empty self-report columns are withheld, and so is the row total that would give them back.
    expect(groupRow(rows, 'Civil')).toEqual(['Group', 'Civil', 'B.Tech Civil', '2024', 'Withheld', '<5', '<5', '<5', '7', 'NA', 'NA', 'NA', '']);
    // Placed overall (9) would give Civil's 3 back by subtraction; so would the grand total.
    expect(totalRow(rows)).toEqual(['All graduates in scope', '', '', 'All years', 'Withheld', 'Withheld', '5', '5', '13', 'NA', 'NA', 'NA', '']);
    // Newest year first.
    expect(rows.filter((row) => row[0] === 'Group').map((row) => row[3])).toEqual(['2025', '2024']);
    expect(filename).toMatch(/^one-accreditation-outcomes-\d{4}-\d{2}\.csv$/);

    // The same graduates in the placement statistics (INST-12): Mechanical 2021 batch, placed 6.
    const statistics = (await api().get(base() + '/placement-statistics').set(auth(admin.id)).expect(200)).body as {
      asOf: { month: string }; groups: { department: { name: string } | null; batch: { name: string } | null; placed: { suppressed: boolean; value: number | null } }[];
    };
    const cohort = statistics.groups.find((group) => group.department?.name === 'Mechanical' && group.batch?.name === 'Mechanical 2021')!;
    expect(cohort.placed).toEqual({ suppressed: false, value: 6 });
    expect(Number(mech[5])).toBe(cohort.placed.value);
    const civilCohort = statistics.groups.find((group) => group.department?.name === 'Civil')!;
    expect(civilCohort.placed.suppressed).toBe(true);
    expect(filename).toContain(statistics.asOf.month);
    expect(text).not.toMatch(uuidText);
  });

  it('never carries pay, readiness or an identifier, and writes NA where ONE holds nothing', async () => {
    await fixture();
    const { rows, text } = await exportAs(admin);
    expect(text).not.toMatch(/900000|INR|compensation|readiness|band/i);
    expect(text).not.toMatch(uuidText);
    expect(text).not.toMatch(/Student \d+|R-\d+|@example\.test/);
    for (const row of rows.filter((entry) => entry[0] === 'Group' || entry[0] === 'All graduates in scope')) {
      expect(row.slice(9, 12)).toEqual(['NA', 'NA', 'NA']);
    }
  });

  it('limits a department head to their department', async () => {
    await fixture();
    const { rows, text } = await exportAs(headA);
    expect(rows.filter((row) => row[0] === 'Group').map((row) => row[1])).toEqual(['Mechanical']);
    expect(text).not.toContain('Civil');
    expect(totalRow(rows)).toEqual(['All graduates in scope', '', '', 'All years', '22', '6', '5', '5', '6', 'NA', 'NA', 'NA', '']);
  });

  it('drops a revoked share and a withdrawn self-report on the next export', async () => {
    const { higherStudies } = await fixture();
    const before = groupRow((await exportAs(admin)).rows, 'Mechanical')!;
    expect(before.slice(5, 9)).toEqual(['6', '5', '5', '6']);
    const [first] = (await pool.query('SELECT id FROM student_outcome_declarations WHERE student_user_id=$1', [higherStudies[0]!.userId])).rows;
    await api().post('/api/v1/students/me/outcome-declarations/' + first.id + '/withdraw').set(auth(higherStudies[0]!.userId)).send({}).expect(201);
    // A placed graduate with no self-report stops sharing their application.
    const application = (await pool.query(`SELECT a.id FROM applications a JOIN institution_student_profiles p ON p.student_user_id = a.student_user_id
      WHERE p.batch_unit_id=$1 AND a.institution_visibility_granted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM student_outcome_declarations d WHERE d.student_user_id = a.student_user_id) LIMIT 1`, [gradBatch])).rows[0];
    await pool.query('UPDATE applications SET institution_visibility_revoked_at = now() WHERE id=$1', [application.id]);
    const after = groupRow((await exportAs(admin)).rows, 'Mechanical')!;
    // Placed 6 → 5 and higher studies 5 → 4 (<5), both into "no outcome shared" (6 → 8); the row total
    // would now give the hidden 4 back, so it is withheld.
    expect(after.slice(4, 9)).toEqual(['Withheld', '5', '<5', '5', '8']);
  });

  it('counts only recorded graduates as of the last month end', async () => {
    await graduate2025();
    await student(mechanical, mechProgramme, currentBatch);
    await student(mechanical, mechProgramme, gradBatch, { graduatedAt: "now() + interval '7 days'" });
    await student(mechanical, mechProgramme, gradBatch, { state: 'TRANSFERRED', endedAt: "'2025-09-01T00:00:00Z'" });
    for (let index = 0; index < 4; index += 1) await graduate2025();
    const { rows } = await exportAs(admin);
    // Five graduates, all with nothing shared: the current student, next week's graduate and the transferred student are not there.
    expect(rows.filter((row) => row[0] === 'Group').map((row) => [row[1], row[3], row[8]])).toEqual([['Mechanical', '2025', '5']]);
  });

  it('writes the audit row, with the reason, before sending the file', async () => {
    await exportAs(admin);
    const [row] = await audits('institution.accreditation_outcomes.exported');
    expect(row).toMatchObject({ actor_user_id: admin.id, organization_id: institutionId, outcome: 'SUCCESS' });
    expect(row.context).toMatchObject({ kind: 'ACCREDITATION_OUTCOMES', reasonCode: 'ACCREDITATION_PREPARATION', scope: 'INSTITUTION' });
    expect(typeof row.context.month).toBe('string');
    expect(row.context.rowCount).toBeGreaterThan(0);
  });

  it('is 403 without the capability for every role, 401 without a token, and refuses bad input', async () => {
    await api().post(exportPath()).send({ reasonCode: 'ACCREDITATION_PREPARATION' }).expect(401);
    for (const actor of [owner, placementAdmin, faculty, headNoGrant]) {
      const response = await api().post(exportPath()).set(auth(actor.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION' }).expect(403);
      expect(response.body.error.code).toBe('ANALYTICS_CAPABILITY_REQUIRED');
    }
    expect((await audits('institution.export.denied')).length).toBe(4);
    expect((await api().post(exportPath(otherInstitutionId)).set(auth(admin.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION' }).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await api().post(exportPath()).set(auth(otherAdmin.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION' }).expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await api().post(exportPath()).set(auth(unscopedHead.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION' }).expect(403)).body.error.code).toBe('SCOPE_REQUIRED');
    expect((await api().post(exportPath()).set(auth(admin.id)).send({}).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await api().post(exportPath()).set(auth(admin.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION', month: '2025-01' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await api().post(exportPath()).set(auth(admin.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION', unitId: mechanical }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect(await audits('institution.accreditation_outcomes.exported')).toHaveLength(0);
  });
});

describe('the graduate self-report', () => {
  const route = '/api/v1/students/me/outcome-declarations';

  it('lets a graduate share an outcome with their college, audited, and change or withdraw it', async () => {
    const person = await graduate2025();
    const listed = (await api().get(route).set(auth(person.userId)).expect(200)).body;
    expect(listed.colleges).toEqual([{ institutionId, institutionName: 'Synthetic Institute', relationship: 'GRADUATED', graduatedOn: '2025-06-15', declaration: null }]);

    const shared = (await api().post(route).set(auth(person.userId)).send({ institutionId, outcome: 'HIGHER_STUDIES' }).expect(201)).body;
    expect(shared.colleges[0].declaration).toMatchObject({ outcome: 'HIGHER_STUDIES' });
    await api().post(route).set(auth(person.userId)).send({ institutionId, outcome: 'HIGHER_STUDIES' }).expect(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM student_outcome_declarations WHERE student_user_id=$1', [person.userId])).rows[0].n).toBe(1);

    const changed = (await api().post(route).set(auth(person.userId)).send({ institutionId, outcome: 'ENTREPRENEURSHIP' }).expect(201)).body;
    expect(changed.colleges[0].declaration).toMatchObject({ outcome: 'ENTREPRENEURSHIP' });
    const stored = (await pool.query('SELECT outcome, withdrawn_at FROM student_outcome_declarations WHERE student_user_id=$1 ORDER BY declared_at, withdrawn_at NULLS LAST', [person.userId])).rows;
    expect(stored.map((row) => [row.outcome, row.withdrawn_at !== null])).toEqual([['HIGHER_STUDIES', true], ['ENTREPRENEURSHIP', false]]);

    await api().post(route + '/' + changed.colleges[0].declaration.id + '/withdraw').set(auth(person.userId)).send({}).expect(201);
    await api().post(route + '/' + changed.colleges[0].declaration.id + '/withdraw').set(auth(person.userId)).send({}).expect(201);
    expect((await api().get(route).set(auth(person.userId)).expect(200)).body.colleges[0].declaration).toBeNull();
    expect((await audits('student.outcome_declaration.shared')).map((row) => [row.actor_user_id, row.organization_id, row.context.outcome]))
      .toEqual([[person.userId, institutionId, 'HIGHER_STUDIES'], [person.userId, institutionId, 'ENTREPRENEURSHIP']]);
    expect((await audits('student.outcome_declaration.withdrawn')).map((row) => row.context)).toEqual([
      { outcome: 'HIGHER_STUDIES', replaced: true }, { outcome: 'ENTREPRENEURSHIP', replaced: false },
    ]);
  });

  it('counts a report made this month from next month, as every month-end figure does', async () => {
    const people: Student[] = [];
    for (let index = 0; index < 5; index += 1) people.push(await graduate2025());
    for (let index = 0; index < 5; index += 1) await graduate2025();
    for (const person of people) await api().post(route).set(auth(person.userId)).send({ institutionId, outcome: 'HIGHER_STUDIES' }).expect(201);
    const row = groupRow((await exportAs(admin)).rows, 'Mechanical')!;
    expect(row[6]).toBe('<5');
    expect(row[8]).toBe('10');
  });

  it('refuses a college the person did not study at or left, another person\'s report, and bad input', async () => {
    const person = await graduate2025();
    const moved = await student(mechanical, mechProgramme, gradBatch, { state: 'TRANSFERRED', endedAt: "'2025-09-01T00:00:00Z'" });
    await api().get(route).expect(401);
    expect((await api().post(route).set(auth(person.userId)).send({ institutionId: otherInstitutionId, outcome: 'HIGHER_STUDIES' }).expect(403)).body.error.code).toBe('OUTCOME_COLLEGE_NOT_ELIGIBLE');
    expect((await api().get(route).set(auth(moved.userId)).expect(200)).body.colleges).toEqual([]);
    expect((await api().post(route).set(auth(moved.userId)).send({ institutionId, outcome: 'HIGHER_STUDIES' }).expect(403)).body.error.code).toBe('OUTCOME_COLLEGE_NOT_ELIGIBLE');
    expect((await api().post(route).set(auth(admin.id)).send({ institutionId, outcome: 'HIGHER_STUDIES' }).expect(403)).body.error.code).toBe('OUTCOME_COLLEGE_NOT_ELIGIBLE');
    for (const body of [{ institutionId, outcome: 'PLACED' }, { institutionId, outcome: 'higher_studies' }, { institutionId: 'nope', outcome: 'HIGHER_STUDIES' }, { institutionId, outcome: 'HIGHER_STUDIES', note: 'x' }, []]) {
      await api().post(route).set(auth(person.userId)).send(body).expect(400);
    }
    const id = await declared(person, 'ENTREPRENEURSHIP');
    await api().post(route + '/' + id + '/withdraw').set(auth(moved.userId)).send({}).expect(403);
    await api().post(route + '/' + id + '/withdraw').set(auth(admin.id)).send({}).expect(403);
    await api().post(route + '/' + id + '/withdraw').set(auth(person.userId)).send({ reason: 'x' }).expect(400);
    expect((await pool.query('SELECT withdrawn_at FROM student_outcome_declarations WHERE id=$1', [id])).rows[0].withdrawn_at).toBeNull();
    // A current student may share too; they are counted once a graduation is recorded.
    const current = await student(mechanical, mechProgramme, currentBatch);
    expect((await api().post(route).set(auth(current.userId)).send({ institutionId, outcome: 'ENTREPRENEURSHIP' }).expect(201)).body.colleges[0]).toMatchObject({ relationship: 'CURRENT', graduatedOn: null });
  });

  it('keeps each row fixed except its withdrawal, and deletes only inside the privacy erase', async () => {
    const person = await graduate2025();
    const id = await declared(person, 'HIGHER_STUDIES');
    await expect(pool.query("UPDATE student_outcome_declarations SET outcome = 'ENTREPRENEURSHIP' WHERE id=$1", [id])).rejects.toThrow(/never changes/);
    await expect(pool.query('DELETE FROM student_outcome_declarations WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query("INSERT INTO student_outcome_declarations (id,student_user_id,institution_id,outcome,withdrawn_at) VALUES ($1,$2,$3,'HIGHER_STUDIES',now())", [randomUUID(), person.userId, institutionId])).rejects.toThrow(/starts shared/);
    await expect(pool.query("INSERT INTO student_outcome_declarations (id,student_user_id,institution_id,outcome) VALUES ($1,$2,$3,'HIGHER_STUDIES')", [randomUUID(), person.userId, institutionId])).rejects.toThrow(/duplicate key|live_uq/);
    await pool.query('UPDATE student_outcome_declarations SET withdrawn_at = now() WHERE id=$1', [id]);
    await expect(pool.query("UPDATE student_outcome_declarations SET withdrawn_at = now() + interval '1 day' WHERE id=$1", [id])).rejects.toThrow(/withdrawn declaration never changes/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [person.userId]);
      await client.query('DELETE FROM student_outcome_declarations WHERE student_user_id=$1', [person.userId]);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await pool.query('SELECT count(*)::int AS n FROM student_outcome_declarations WHERE student_user_id=$1', [person.userId])).rows[0].n).toBe(0);
  });
});
