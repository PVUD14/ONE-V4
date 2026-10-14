/**
 * Institution settings, programme grading scales, the academic calendar and staff
 * preferences (INST-05, defect I-6).
 *
 * Only owners and admins change college settings, and every change is audited; the fields
 * Operations verifies an institution against are never writable from the college side; a
 * programme without a grading scale reads as NA (null), never a guessed scale; every
 * institution staff role reads the calendar; staff change only their own preferences.
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
import { loadProgrammeGradingScale } from '@planthepath/persistence/src/institution-grading-scales.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for institution settings tests');
const schemaName = 'inst_settings_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let department: string; let programme: string; let otherProgramme: string; let batch: string; let otherInstitutionProgramme: string;
let owner: Staff; let admin: Staff; let placement: Staff; let head: Staff; let faculty: Staff; let otherAdmin: Staff; let outsider: Staff;

interface Staff { id: string; membershipId: string }

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
});
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  department = randomUUID(); programme = randomUUID(); otherProgramme = randomUUID(); batch = randomUUID(); otherInstitutionProgramme = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local Institute of Technology'), ($2,'INSTITUTION','Other institution')", [institutionId, otherInstitutionId]);
  await pool.query(`INSERT INTO organization_profiles (organization_id, display_name, website_url, country_code, city, primary_contact_email, institution_type)
    VALUES ($1, 'Local Tech', 'https://local.example.test', 'IN', 'Local City', 'office@local.example.test', 'ENGINEERING_COLLEGE')`, [institutionId]);
  await unit(department, 'DEPARTMENT', 'Computer Science', null);
  await unit(programme, 'PROGRAM', 'BTech Computer Science', department);
  await unit(otherProgramme, 'PROGRAM', 'BCom', null);
  await unit(batch, 'BATCH', '2027', programme);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'PROGRAM','Elsewhere')", [otherInstitutionProgramme, otherInstitutionId]);
  owner = await staff('INSTITUTION_OWNER');
  admin = await staff('INSTITUTION_ADMIN');
  placement = await staff('PLACEMENT_ADMIN');
  head = await staff('DEPARTMENT_HEAD', department);
  faculty = await staff('FACULTY_LECTURER');
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
  outsider = await staff('RECRUITER', null, null);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function staff(role: string, departmentUnit: string | null = null, organization: string | null = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  if (organization) {
    await pool.query(`INSERT INTO organization_memberships
      (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
      VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, departmentUnit]);
  }
  return { id, membershipId };
}
const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const audits = async (action: string) => (await pool.query('SELECT actor_user_id, organization_id, context FROM audit_events WHERE action=$1 ORDER BY occurred_at', [action])).rows;
const term = (overrides: Record<string, unknown> = {}) => ({ name: '2026-27 Odd semester', kind: 'TERM', startsOn: '2026-07-01', endsOn: '2026-11-30', ...overrides });
const createTerm = async (overrides: Record<string, unknown> = {}) => (await api().post(base() + '/academic-terms').set(auth(admin.id)).send(term(overrides)).expect(201)).body.term;

describe('college settings', () => {
  it('refuses without a token, from another institution, and from a non-institution role', async () => {
    await api().get(base() + '/settings').expect(401);
    await api().get(base() + '/settings').set(auth(otherAdmin.id)).expect(403);
    await api().get(base() + '/settings').set(auth(outsider.id)).expect(403);
    await api().post(base() + '/settings').set(auth(otherAdmin.id)).send({ about: 'Hijack' }).expect(403);
  });

  it('lets every institution staff role read the profile, with the verified fields from operations', async () => {
    for (const reader of [owner, admin, placement, head, faculty]) {
      const body = (await api().get(base() + '/settings').set(auth(reader.id)).expect(200)).body.settings;
      expect(body.profile).toMatchObject({ legalName: 'Local Institute of Technology', displayName: 'Local Tech', websiteUrl: 'https://local.example.test',
        city: 'Local City', primaryContactEmail: 'office@local.example.test', institutionType: 'ENGINEERING_COLLEGE', profileSetUp: true });
      expect(body.college).toEqual({ about: null, placementContactEmail: null, updatedAt: null });
      expect(body.canEdit).toBe(reader === owner || reader === admin);
    }
  });

  it('lets an owner or admin write the description and placement contact, audited', async () => {
    const saved = await api().post(base() + '/settings').set(auth(admin.id))
      .send({ about: 'A college of engineering.', placementContactEmail: 'Placements@Local.Example.Test' }).expect(201);
    expect(saved.body.settings.college).toMatchObject({ about: 'A college of engineering.', placementContactEmail: 'placements@local.example.test' });
    await api().post(base() + '/settings').set(auth(owner.id)).send({ about: null }).expect(201);
    const row = await pool.query('SELECT about_text, placement_contact_email, updated_by_user_id FROM institution_settings WHERE institution_id=$1', [institutionId]);
    expect(row.rows[0]).toEqual({ about_text: null, placement_contact_email: 'placements@local.example.test', updated_by_user_id: owner.id });
    const trail = await audits('institution.settings.updated');
    expect(trail.map((entry) => [entry.actor_user_id, entry.organization_id, entry.context.changedFields])).toEqual([
      [admin.id, institutionId, ['about', 'placementContactEmail']], [owner.id, institutionId, ['about']],
    ]);
  });

  it('refuses every other staff role and writes nothing', async () => {
    for (const writer of [placement, head, faculty]) {
      await api().post(base() + '/settings').set(auth(writer.id)).send({ about: 'Not mine to say' }).expect(403);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_settings')).rows[0].n).toBe(0);
    expect(await audits('institution.settings.updated')).toEqual([]);
  });

  it('never lets the college change what operations verified', async () => {
    for (const field of ['displayName', 'legalName', 'websiteUrl', 'primaryContactEmail', 'institutionType', 'city']) {
      const refused = await api().post(base() + '/settings').set(auth(admin.id)).send({ about: 'x', [field]: 'Changed' }).expect(403);
      expect(refused.body.error.code).toBe('INSTITUTION_PROFILE_FIELD_OPERATIONS_CONTROLLED');
    }
    const profile = await pool.query('SELECT display_name, website_url FROM organization_profiles WHERE organization_id=$1', [institutionId]);
    expect(profile.rows[0]).toEqual({ display_name: 'Local Tech', website_url: 'https://local.example.test' });
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_settings')).rows[0].n).toBe(0);
  });

  it('validates input', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'INVALID_REQUEST'], [{ colour: 'red' }, 'UNKNOWN_FIELD'], [{ placementContactEmail: 'not-an-email' }, 'INSTITUTION_SETTINGS_INVALID'],
      [{ about: '=HYPERLINK("x")' }, 'INSTITUTION_SETTINGS_INVALID'], [{ about: 'x'.repeat(2001) }, 'INSTITUTION_SETTINGS_INVALID'], [{ about: 5 }, 'INSTITUTION_SETTINGS_INVALID'],
    ];
    for (const [body, code] of cases) {
      const refused = await api().post(base() + '/settings').set(auth(admin.id)).send(body).expect(400);
      expect(refused.body.error.code).toBe(code);
    }
  });
});

describe('grading scales', () => {
  const programmes = async (actor = admin) => (await api().get(base() + '/settings').set(auth(actor.id)).expect(200)).body.settings.programmes as { programUnitId: string; gradingScale: unknown }[];

  it('shows a programme without a grading scale as NA (null), never a guessed scale', async () => {
    const listed = await programmes(faculty);
    expect(listed.map((entry) => entry.programUnitId).sort()).toEqual([programme, otherProgramme].sort());
    expect(listed.every((entry) => entry.gradingScale === null)).toBe(true);
    expect(await loadProgrammeGradingScale(db, institutionId, programme)).toBeNull();
  });

  it('sets and replaces a programme scale, audited with before and after', async () => {
    const set = await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: programme, scale: 'CGPA_10', passThreshold: 6.5 }).expect(201);
    expect(set.body.gradingScale).toMatchObject({ programUnitId: programme, scale: 'CGPA_10', passThreshold: 6.5 });
    await api().post(base() + '/grading-scales').set(auth(owner.id)).send({ programUnitId: programme, scale: 'PERCENTAGE', passThreshold: 40 }).expect(201);
    expect(await loadProgrammeGradingScale(db, institutionId, programme)).toMatchObject({ scale: 'PERCENTAGE', passThreshold: 40 });
    expect(await loadProgrammeGradingScale(db, institutionId, otherProgramme)).toBeNull();
    const listed = await programmes(head);
    expect(listed.find((entry) => entry.programUnitId === programme)!.gradingScale).toMatchObject({ scale: 'PERCENTAGE', passThreshold: 40 });
    expect(listed.find((entry) => entry.programUnitId === otherProgramme)!.gradingScale).toBeNull();
    expect((await audits('institution.grading_scale.set')).map((entry) => [entry.context.before, entry.context.after])).toEqual([
      [null, { scale: 'CGPA_10', passThreshold: 6.5 }],
      [{ scale: 'CGPA_10', passThreshold: 6.5 }, { scale: 'PERCENTAGE', passThreshold: 40 }],
    ]);
  });

  it('keeps a scale without a threshold as NA, and never puts a threshold on letter or pass/fail scales', async () => {
    await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: programme, scale: 'GPA_4' }).expect(201);
    expect(await loadProgrammeGradingScale(db, institutionId, programme)).toMatchObject({ scale: 'GPA_4', passThreshold: null });
    for (const scale of ['LETTER', 'PASS_FAIL']) {
      const refused = await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: programme, scale, passThreshold: 1 }).expect(400);
      expect(refused.body.error.code).toBe('GRADING_SCALE_THRESHOLD_NOT_APPLICABLE');
    }
    await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: otherProgramme, scale: 'PASS_FAIL' }).expect(201);
  });

  it('refuses out-of-range thresholds, unknown scales and units that are not this college\'s programmes', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ programUnitId: programme, scale: 'CGPA_10', passThreshold: 10.5 }, 'INVALID_GRADING_SCALE'],
      [{ programUnitId: programme, scale: 'PERCENTAGE', passThreshold: -1 }, 'INVALID_GRADING_SCALE'],
      [{ programUnitId: programme, scale: 'CGPA_10', passThreshold: '6' }, 'INVALID_GRADING_SCALE'],
      [{ programUnitId: programme, scale: 'CGPA_5' }, 'INVALID_GRADING_SCALE'],
      [{ programUnitId: programme, scale: 'CGPA_10', extra: true }, 'UNKNOWN_FIELD'],
      [{ programUnitId: department, scale: 'CGPA_10' }, 'INVALID_GRADING_SCALE_PROGRAMME'],
      [{ programUnitId: otherInstitutionProgramme, scale: 'CGPA_10' }, 'INVALID_GRADING_SCALE_PROGRAMME'],
    ];
    for (const [body, code] of cases) {
      const refused = await api().post(base() + '/grading-scales').set(auth(admin.id)).send(body).expect(400);
      expect(refused.body.error.code).toBe(code);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_grading_scales')).rows[0].n).toBe(0);
  });

  it('lets only owners and admins change scales', async () => {
    for (const writer of [placement, head, faculty, otherAdmin]) {
      await api().post(base() + '/grading-scales').set(auth(writer.id)).send({ programUnitId: programme, scale: 'CGPA_10' }).expect(403);
    }
    await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: programme, scale: 'CGPA_10' }).expect(201);
    await api().post(base() + '/grading-scales/' + programme + '/remove').set(auth(head.id)).send({ reasonCode: 'WRONG_SCALE' }).expect(403);
  });

  it('removes a scale with a reason code, back to NA', async () => {
    await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: programme, scale: 'CGPA_10', passThreshold: 5 }).expect(201);
    await api().post(base() + '/grading-scales/' + programme + '/remove').set(auth(admin.id)).send({}).expect(400);
    await api().post(base() + '/grading-scales/' + programme + '/remove').set(auth(admin.id)).send({ reasonCode: 'WRONG_SCALE' }).expect(201);
    expect(await loadProgrammeGradingScale(db, institutionId, programme)).toBeNull();
    const [removed] = await audits('institution.grading_scale.removed');
    expect(removed.context).toMatchObject({ reasonCode: 'WRONG_SCALE', before: { scale: 'CGPA_10', passThreshold: 5 } });
    const again = await api().post(base() + '/grading-scales/' + programme + '/remove').set(auth(admin.id)).send({ reasonCode: 'WRONG_SCALE' }).expect(409);
    expect(again.body.error.code).toBe('GRADING_SCALE_NOT_SET');
  });
});

describe('academic calendar', () => {
  it('lets an admin create a term that every institution staff role reads', async () => {
    const today = new Date();
    const start = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(today.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
    const created = await createTerm({ startsOn: start, endsOn: end, unitId: programme });
    expect(created).toMatchObject({ name: '2026-27 Odd semester', kind: 'TERM', startsOn: start, endsOn: end, unit: { id: programme, kind: 'PROGRAM', name: 'BTech Computer Science' }, current: true, archived: false });
    for (const reader of [owner, placement, head, faculty]) {
      const listed = (await api().get(base() + '/academic-terms').set(auth(reader.id)).expect(200)).body;
      expect(listed.terms.map((entry: { id: string }) => entry.id)).toEqual([created.id]);
      expect(listed.canEdit).toBe(reader === owner);
    }
    const [audit] = await audits('institution.academic_term.created');
    expect(audit).toMatchObject({ actor_user_id: admin.id, organization_id: institutionId });
  });

  it('keeps other institutions out', async () => {
    await createTerm();
    await api().get(base() + '/academic-terms').expect(401);
    await api().get(base() + '/academic-terms').set(auth(otherAdmin.id)).expect(403);
    await api().post(base() + '/academic-terms').set(auth(otherAdmin.id)).send(term({ name: 'Intruder' })).expect(403);
    const mine = (await api().get(base(otherInstitutionId) + '/academic-terms').set(auth(otherAdmin.id)).expect(200)).body;
    expect(mine.terms).toEqual([]);
  });

  it('lets only owners and admins create, change or archive terms', async () => {
    const created = await createTerm();
    for (const writer of [placement, head, faculty]) {
      await api().post(base() + '/academic-terms').set(auth(writer.id)).send(term({ name: 'Mine' })).expect(403);
      await api().patch(base() + '/academic-terms/' + created.id).set(auth(writer.id)).send({ name: 'Renamed' }).expect(403);
      await api().post(base() + '/academic-terms/' + created.id + '/archive').set(auth(writer.id)).send({ reasonCode: 'CANCELLED' }).expect(403);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_academic_terms')).rows[0].n).toBe(1);
  });

  it('validates the term and its unit', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [term({ endsOn: '2026-06-30' }), 'INVALID_ACADEMIC_TERM_WINDOW'],
      [term({ endsOn: '2027-12-31' }), 'INVALID_ACADEMIC_TERM_WINDOW'],
      [term({ startsOn: '2026-02-30' }), 'INVALID_ACADEMIC_TERM'],
      [term({ kind: 'TIMETABLE' }), 'INVALID_ACADEMIC_TERM'],
      [term({ name: '' }), 'INVALID_ACADEMIC_TERM'],
      [term({ name: '=cmd' }), 'INVALID_ACADEMIC_TERM'],
      [term({ unitId: department }), 'INVALID_ACADEMIC_TERM_UNIT'],
      [term({ unitId: otherInstitutionProgramme }), 'INVALID_ACADEMIC_TERM_UNIT'],
      [term({ room: 'A1' }), 'UNKNOWN_FIELD'],
    ];
    for (const [body, code] of cases) {
      const refused = await api().post(base() + '/academic-terms').set(auth(admin.id)).send(body).expect(400);
      expect(refused.body.error.code).toBe(code);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_academic_terms')).rows[0].n).toBe(0);
  });

  it('refuses a second live term of the same name for the same unit, and frees the name once archived', async () => {
    const created = await createTerm();
    const clash = await api().post(base() + '/academic-terms').set(auth(admin.id)).send(term({ name: '2026-27 ODD SEMESTER' })).expect(409);
    expect(clash.body.error.code).toBe('ACADEMIC_TERM_NAME_TAKEN');
    await createTerm({ unitId: batch });
    await api().post(base() + '/academic-terms/' + created.id + '/archive').set(auth(admin.id)).send({ reasonCode: 'DUPLICATE' }).expect(201);
    await createTerm();
  });

  it('updates a term with its before and after audited', async () => {
    const created = await createTerm();
    const updated = await api().patch(base() + '/academic-terms/' + created.id).set(auth(owner.id)).send({ endsOn: '2026-12-15', kind: 'TERM', unitId: batch }).expect(200);
    expect(updated.body.term).toMatchObject({ endsOn: '2026-12-15', unit: { id: batch, kind: 'BATCH' } });
    await api().patch(base() + '/academic-terms/' + created.id).set(auth(owner.id)).send({ startsOn: '2027-01-01' }).expect(400);
    await api().patch(base() + '/academic-terms/' + created.id).set(auth(owner.id)).send({}).expect(400);
    await api().patch(base() + '/academic-terms/' + randomUUID()).set(auth(owner.id)).send({ name: 'Nothing' }).expect(403);
    const [audit] = await audits('institution.academic_term.updated');
    expect(audit.context.before).toMatchObject({ endsOn: '2026-11-30', unitId: null });
    expect(audit.context.after).toMatchObject({ endsOn: '2026-12-15', unitId: batch });
  });

  it('archives with a reason, never deletes, and hides archived terms from the calendar by default', async () => {
    const created = await createTerm();
    await api().post(base() + '/academic-terms/' + created.id + '/archive').set(auth(admin.id)).send({ reasonCode: 'lower' }).expect(400);
    const archived = await api().post(base() + '/academic-terms/' + created.id + '/archive').set(auth(admin.id)).send({ reasonCode: 'CANCELLED' }).expect(201);
    expect(archived.body.term).toMatchObject({ archived: true, archiveReasonCode: 'CANCELLED', current: false });
    await api().post(base() + '/academic-terms/' + created.id + '/archive').set(auth(admin.id)).send({ reasonCode: 'CANCELLED' }).expect(409);
    await api().patch(base() + '/academic-terms/' + created.id).set(auth(admin.id)).send({ name: 'Revived' }).expect(409);
    expect((await api().get(base() + '/academic-terms').set(auth(faculty.id)).expect(200)).body.terms).toEqual([]);
    const all = (await api().get(base() + '/academic-terms?state=ARCHIVED').set(auth(admin.id)).expect(200)).body.terms;
    expect(all.map((entry: { id: string }) => entry.id)).toEqual([created.id]);
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_academic_terms')).rows[0].n).toBe(1);
  });

  it('pages earliest first and filters by date window', async () => {
    const first = await createTerm({ name: 'Odd', startsOn: '2026-07-01', endsOn: '2026-11-30' });
    const exams = await createTerm({ name: 'End-semester examinations', kind: 'EXAMINATIONS', startsOn: '2026-12-01', endsOn: '2026-12-20' });
    const second = await createTerm({ name: 'Even', startsOn: '2027-01-05', endsOn: '2027-05-10' });
    const page1 = (await api().get(base() + '/academic-terms?limit=2').set(auth(faculty.id)).expect(200)).body;
    expect(page1.terms.map((entry: { id: string }) => entry.id)).toEqual([first.id, exams.id]);
    const page2 = (await api().get(base() + '/academic-terms?limit=2&cursor=' + page1.nextCursor).set(auth(faculty.id)).expect(200)).body;
    expect(page2).toMatchObject({ nextCursor: null });
    expect(page2.terms.map((entry: { id: string }) => entry.id)).toEqual([second.id]);
    const window = (await api().get(base() + '/academic-terms?from=2026-12-10&to=2027-01-01').set(auth(faculty.id)).expect(200)).body;
    expect(window.terms.map((entry: { id: string }) => entry.id)).toEqual([exams.id]);
    for (const query of ['limit=0', 'limit=201', 'state=OPEN', 'from=2026-13-01', 'cursor=nonsense', 'from=2027-01-01&to=2026-01-01']) {
      await api().get(base() + '/academic-terms?' + query).set(auth(faculty.id)).expect(400);
    }
  });
});

describe('staff profile and notification preferences', () => {
  it('shows a lecturer their own profile, roles, teaching and the schema defaults when nothing is saved', async () => {
    const subject = randomUUID(); const section = randomUUID();
    await unit(section, 'SECTION', 'CSE 3A', batch);
    await pool.query("INSERT INTO exam_subjects (id,institution_id,name,code) VALUES ($1,$2,'Data Structures','CS201')", [subject, institutionId]);
    await pool.query(`INSERT INTO faculty_teaching_assignments (id,institution_id,faculty_membership_id,unit_id,subject_id,academic_term,assigned_by_user_id,reason_code)
      VALUES ($1,$2,$3,$4,$5,'2026-27 Odd semester',$6,'NEW_TERM')`, [randomUUID(), institutionId, faculty.membershipId, section, subject, admin.id]);
    const profile = (await api().get(base() + '/staff-profile').set(auth(faculty.id)).expect(200)).body.staffProfile;
    expect(profile).toMatchObject({
      email: faculty.id + '@example.test', institutionName: 'Local Tech', roles: [{ role: 'FACULTY_LECTURER', department: null, batch: null }],
      teachingAssignments: [{ unit: 'CSE 3A', subject: 'Data Structures', academicTerm: '2026-27 Odd semester' }],
      notificationPreferences: null, staffRemindersLive: false,
    });
    // The defaults shown are the database's own, not the screen's.
    const probe = randomUUID();
    await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [probe, probe + '@example.test']);
    const defaults = await pool.query('INSERT INTO notification_preferences (user_id) VALUES ($1) RETURNING email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap', [probe]);
    expect(profile.notificationDefaults).toEqual({ emailEnabled: defaults.rows[0].email_enabled, quietHoursStartMinute: defaults.rows[0].quiet_hours_start_minute,
      quietHoursEndMinute: defaults.rows[0].quiet_hours_end_minute, dailyCap: defaults.rows[0].daily_cap });
    const headProfile = (await api().get(base() + '/staff-profile').set(auth(head.id)).expect(200)).body.staffProfile;
    expect(headProfile).toMatchObject({ roles: [{ role: 'DEPARTMENT_HEAD', department: 'Computer Science' }], teachingAssignments: [] });
  });

  it('saves the caller\'s own preferences only, audited', async () => {
    const saved = await api().post(base() + '/staff-profile/notification-preferences').set(auth(head.id)).send({ emailEnabled: false, dailyCap: 1 }).expect(201);
    expect(saved.body.staffProfile.notificationPreferences).toEqual({ emailEnabled: false, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 1 });
    await api().post(base() + '/staff-profile/notification-preferences').set(auth(head.id)).send({ quietHoursStartMinute: 0, quietHoursEndMinute: 360 }).expect(201);
    const rows = await pool.query('SELECT user_id, email_enabled, quiet_hours_start_minute, daily_cap FROM notification_preferences');
    expect(rows.rows).toEqual([{ user_id: head.id, email_enabled: false, quiet_hours_start_minute: 0, daily_cap: 1 }]);
    const trail = await audits('user.notification_preferences.updated');
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ actor_user_id: head.id, organization_id: institutionId });
    expect(trail[1].context.before).toMatchObject({ emailEnabled: false, dailyCap: 1, quietHoursStartMinute: 1320 });
  });

  it('validates preferences and refuses non-staff', async () => {
    for (const body of [{}, { emailEnabled: 'no' }, { dailyCap: 21 }, { quietHoursStartMinute: 1440 }, { quietHoursEndMinute: 1.5 }, { userId: admin.id, dailyCap: 1 }]) {
      await api().post(base() + '/staff-profile/notification-preferences').set(auth(faculty.id)).send(body).expect(400);
    }
    await api().get(base() + '/staff-profile').set(auth(outsider.id)).expect(403);
    await api().post(base() + '/staff-profile/notification-preferences').set(auth(otherAdmin.id)).send({ dailyCap: 1 }).expect(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM notification_preferences')).rows[0].n).toBe(0);
  });
});

describe('contract', () => {
  it('carries no compensation and no numeric readiness in any settings response', async () => {
    await api().post(base() + '/grading-scales').set(auth(admin.id)).send({ programUnitId: programme, scale: 'CGPA_10', passThreshold: 6 }).expect(201);
    await createTerm();
    for (const path of ['/settings', '/academic-terms', '/staff-profile']) {
      const body = JSON.stringify((await api().get(base() + path).set(auth(admin.id)).expect(200)).body);
      expect(body).not.toMatch(/compensation|salary|readiness/i);
    }
  });
});
