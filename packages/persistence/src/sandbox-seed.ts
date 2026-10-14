/**
 * The sandbox's sample data (ADR-046): a fictional college, its people and an employer,
 * loaded through the real tables so demo.oneby8.com shows the real application working.
 *
 * Everything here is invented and marked as such: every sample account's address ends in
 * "@demo.oneby8.com" (the accounts people sign in as) or ".example" (everyone else), the
 * web build shows "Demo - sample data" on every screen, and none of it is copied from
 * production. It runs only behind the sandbox guard (sandbox-guard.ts), and before it
 * writes anything it checks that every account already in the database is a sample one.
 *
 * Where the product has a real code path for a step, the seed uses it: the content pilot
 * is published by publishCareerReadinessPilot, the career catalogue by its own seeds, the
 * aptitude bank is imported as drafts by importAptitudeBankPack, learner cards go through
 * the review workflow, career targets through setStudentCareerTarget and readiness bands
 * are computed by refreshReadinessAfterEvidence from evidence - never typed in. Rows that
 * only a person creates in the product (the college, its roster, the employer's jobs and
 * the hiring pipeline) are written with the same columns and history rows the API writes.
 *
 * Identity: the API matches a sign-in to users.external_subject, which must equal the
 * Cognito "sub" of the user in the sandbox's own pool. DEMO_ACCOUNT_SUBJECTS maps each
 * persona to its sub; a persona without one gets an unbound subject nobody can present.
 *
 * Idempotent: a finished seed leaves a marker; running again only rebinds the personas
 * to the subjects given. A half-finished seed is refused - reset the sandbox instead.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { buildApplicationSnapshot, snapshotHash } from '@planthepath/hiring/src/application-snapshot.js';
import { materialTermsHash, type MaterialTerms } from '@planthepath/hiring/src/index.js';
import { LEARNER_CONTENT_SEED_KEYS, LEARNER_CONTENT_SEEDS } from '@planthepath/learner-content/src/index.js';
import type { ImportPackageManifest } from '@planthepath/career-readiness/src/index.js';
import * as schema from './schema.js';
import { importAptitudeBankPack, type AptitudeBankPack } from './aptitude-bank.js';
import { verifyCatalogueCounts, type CareerCatalogueFile } from './career-catalogue-input.js';
import { seedCareerCatalogue, seedCareerCatalogueGoals } from './career-catalogue.js';
import { publishCareerReadinessPilot, refreshReadinessAfterEvidence, stageImportManifest, type PilotFixture } from './career-readiness.js';
import { deterministicId, seedStarterCareerRoles, type CareerRoleInput } from './career-starter-roles.js';
import { setStudentCareerTarget } from './career-targets.js';
import { createLearnerContentDraft, transitionLearnerContentReview } from './learner-content.js';
import type { TransactionalRunner } from './skill-map.js';

/** The domain of every account someone signs in to the sandbox as. */
export const SANDBOX_LOGIN_DOMAIN = 'demo.oneby8.com';

/** True for an address the seed could have created; anything else is a real person's. */
export function isSampleEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized.endsWith(`@${SANDBOX_LOGIN_DOMAIN}`) || /@[^@]+\.example$/.test(normalized);
}

export const DEMO_PERSONAS = [
  'student', 'graduate', 'placement', 'institution-admin', 'lecturer', 'department-head',
  'employer', 'employer-owner', 'operations', 'growth',
] as const;
export type DemoPersona = (typeof DEMO_PERSONAS)[number];

const cognitoSubPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads "student=<sub>,placement=<sub>". Unknown personas, malformed subs and a sub given
 * to two personas are refused, so a typo cannot silently put someone in the wrong role.
 */
export function parseDemoAccountSubjects(raw: string | undefined): ReadonlyMap<DemoPersona, string> {
  const subjects = new Map<DemoPersona, string>();
  const text = raw?.trim() ?? '';
  if (!text) return subjects;
  const seen = new Set<string>();
  for (const pair of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [persona, sub, extra] = pair.split('=').map((part) => part.trim());
    if (!persona || !sub || extra !== undefined) throw new Error(`DEMO_ACCOUNT_SUBJECTS: "${persona ?? ''}" must be written persona=sub`);
    if (!(DEMO_PERSONAS as readonly string[]).includes(persona)) {
      throw new Error(`DEMO_ACCOUNT_SUBJECTS: unknown persona "${persona}" (known: ${DEMO_PERSONAS.join(', ')})`);
    }
    if (!cognitoSubPattern.test(sub)) throw new Error(`DEMO_ACCOUNT_SUBJECTS: the sub for "${persona}" is not a Cognito user id`);
    if (subjects.has(persona as DemoPersona)) throw new Error(`DEMO_ACCOUNT_SUBJECTS: "${persona}" is listed twice`);
    if (seen.has(sub.toLowerCase())) throw new Error(`DEMO_ACCOUNT_SUBJECTS: one sub is given to two personas`);
    seen.add(sub.toLowerCase());
    subjects.set(persona as DemoPersona, sub.toLowerCase());
  }
  return subjects;
}

const sid = (key: string): string => deterministicId('one-sandbox', key);
const unboundSubject = (persona: DemoPersona): string => `sandbox-unbound:${persona}`;

// --- The cast ---------------------------------------------------------------------------

interface PersonaAccount { readonly persona: DemoPersona; readonly name: string; readonly title: string }
export const PERSONA_ACCOUNTS: readonly PersonaAccount[] = [
  { persona: 'student', name: 'Arjun Reddy', title: 'Final-year B.Tech CSE student, Lakeview Institute of Technology' },
  { persona: 'graduate', name: 'Kavitha Selvam', title: 'Lakeview B.Tech CSE graduate (2022)' },
  { persona: 'placement', name: 'Prof. Meera Nair', title: 'Placement officer, Lakeview' },
  { persona: 'institution-admin', name: 'Dr. Lakshmi Menon', title: 'Institution administrator, Lakeview' },
  { persona: 'lecturer', name: 'Prof. Suresh Raman', title: 'Lecturer, Computer Science and Engineering, Lakeview' },
  { persona: 'department-head', name: 'Dr. Farah Siddiqui', title: 'Head of Computer Science and Engineering, Lakeview' },
  { persona: 'employer', name: 'Rohan Iyer', title: 'Recruiter, Corvane Labs' },
  { persona: 'employer-owner', name: 'Neha Kapoor', title: 'Talent lead (owner), Corvane Labs' },
  { persona: 'operations', name: 'Ananya Kulkarni', title: 'Platform operations, AI8HT' },
  { persona: 'growth', name: 'Vikram Shetty', title: 'College partnerships executive, AI8HT' },
];
const personaEmail = (persona: DemoPersona): string => `${persona}@${SANDBOX_LOGIN_DOMAIN}`;
const personaId = (persona: DemoPersona): string => sid(`user:${persona}`);

/** Accounts nobody signs in as: the content team and the growth manager. */
const STAFF = {
  author: { id: sid('user:content-author'), email: `content.author@${SANDBOX_LOGIN_DOMAIN}` },
  reviewer: { id: sid('user:content-reviewer'), email: `content.reviewer@${SANDBOX_LOGIN_DOMAIN}` },
  publisher: { id: sid('user:content-publisher'), email: `content.publisher@${SANDBOX_LOGIN_DOMAIN}` },
  growthManager: { id: sid('user:growth-manager'), email: `growth.manager@${SANDBOX_LOGIN_DOMAIN}` },
} as const;

const ORG = {
  platform: sid('org:platform'),
  lakeview: sid('org:lakeview'),
  corvane: sid('org:corvane'),
} as const;

const UNIT = {
  cse: sid('unit:cse'), ece: sid('unit:ece'),
  cseProgram: sid('unit:cse-btech'), eceProgram: sid('unit:ece-btech'),
  cse2027: sid('unit:cse-2027'), cse2028: sid('unit:cse-2028'), ece2027: sid('unit:ece-2027'),
} as const;

type Band = 'R' | 'P' | 'D' | 'N';
interface SampleStudent {
  readonly key: string; readonly name: string; readonly roll: string;
  readonly dept: 'cse' | 'ece'; readonly batch: 2027 | 2028;
  /** The evidence pattern the readiness engine is given; the band is computed from it. */
  readonly evidence: Band;
  readonly cgpa: number; readonly target: 'SOFTWARE_ENGINEER' | 'DATA_ANALYST' | 'BUSINESS_ANALYST' | 'SOC_ANALYST' | 'CUSTOMER_SUCCESS';
  readonly persona?: DemoPersona;
}

/** Thirty fictional students. Names are invented; any likeness is coincidence. */
const STUDENTS: readonly SampleStudent[] = [
  { key: 'arjun', name: 'Arjun Reddy', roll: 'LIT-CSE-27-001', dept: 'cse', batch: 2027, evidence: 'P', cgpa: 8.1, target: 'SOFTWARE_ENGINEER', persona: 'student' },
  { key: 'priya', name: 'Priya Sharma', roll: 'LIT-CSE-27-002', dept: 'cse', batch: 2027, evidence: 'R', cgpa: 8.9, target: 'SOFTWARE_ENGINEER' },
  { key: 'karthik', name: 'Karthik Narayanan', roll: 'LIT-CSE-27-003', dept: 'cse', batch: 2027, evidence: 'P', cgpa: 7.6, target: 'SOFTWARE_ENGINEER' },
  { key: 'divya', name: 'Divya Menon', roll: 'LIT-CSE-27-004', dept: 'cse', batch: 2027, evidence: 'D', cgpa: 7.2, target: 'DATA_ANALYST' },
  { key: 'aditya', name: 'Aditya Kulkarni', roll: 'LIT-CSE-27-005', dept: 'cse', batch: 2027, evidence: 'D', cgpa: 6.4, target: 'SOFTWARE_ENGINEER' },
  { key: 'meghana', name: 'Meghana Rao', roll: 'LIT-CSE-27-006', dept: 'cse', batch: 2027, evidence: 'N', cgpa: 7.9, target: 'BUSINESS_ANALYST' },
  { key: 'sneha', name: 'Sneha Iyer', roll: 'LIT-CSE-27-007', dept: 'cse', batch: 2027, evidence: 'R', cgpa: 9.1, target: 'DATA_ANALYST' },
  { key: 'rahul', name: 'Rahul Verma', roll: 'LIT-CSE-27-008', dept: 'cse', batch: 2027, evidence: 'P', cgpa: 7.4, target: 'SOC_ANALYST' },
  { key: 'ishita', name: 'Ishita Banerjee', roll: 'LIT-CSE-27-009', dept: 'cse', batch: 2027, evidence: 'R', cgpa: 8.6, target: 'SOFTWARE_ENGINEER' },
  { key: 'farhan', name: 'Farhan Qureshi', roll: 'LIT-CSE-27-010', dept: 'cse', batch: 2027, evidence: 'D', cgpa: 6.8, target: 'SOC_ANALYST' },
  { key: 'nandini', name: 'Nandini Pillai', roll: 'LIT-CSE-27-011', dept: 'cse', batch: 2027, evidence: 'P', cgpa: 8.0, target: 'DATA_ANALYST' },
  { key: 'gautam', name: 'Gautam Joshi', roll: 'LIT-CSE-27-012', dept: 'cse', batch: 2027, evidence: 'N', cgpa: 6.9, target: 'CUSTOMER_SUCCESS' },
  { key: 'tanvi', name: 'Tanvi Deshpande', roll: 'LIT-CSE-27-013', dept: 'cse', batch: 2027, evidence: 'P', cgpa: 7.8, target: 'BUSINESS_ANALYST' },
  { key: 'yash', name: 'Yash Agarwal', roll: 'LIT-CSE-27-014', dept: 'cse', batch: 2027, evidence: 'D', cgpa: 6.2, target: 'SOFTWARE_ENGINEER' },
  { key: 'ananya-s', name: 'Ananya Subramanian', roll: 'LIT-CSE-28-001', dept: 'cse', batch: 2028, evidence: 'P', cgpa: 8.3, target: 'SOFTWARE_ENGINEER' },
  { key: 'rohit', name: 'Rohit Malhotra', roll: 'LIT-CSE-28-002', dept: 'cse', batch: 2028, evidence: 'D', cgpa: 7.0, target: 'DATA_ANALYST' },
  { key: 'kavya', name: 'Kavya Hegde', roll: 'LIT-CSE-28-003', dept: 'cse', batch: 2028, evidence: 'N', cgpa: 8.7, target: 'SOFTWARE_ENGINEER' },
  { key: 'siddharth', name: 'Siddharth Rao', roll: 'LIT-CSE-28-004', dept: 'cse', batch: 2028, evidence: 'R', cgpa: 8.8, target: 'SOC_ANALYST' },
  { key: 'pooja', name: 'Pooja Nambiar', roll: 'LIT-CSE-28-005', dept: 'cse', batch: 2028, evidence: 'P', cgpa: 7.5, target: 'BUSINESS_ANALYST' },
  { key: 'harsh', name: 'Harsh Vardhan', roll: 'LIT-CSE-28-006', dept: 'cse', batch: 2028, evidence: 'D', cgpa: 6.6, target: 'CUSTOMER_SUCCESS' },
  { key: 'lavanya', name: 'Lavanya Krishnan', roll: 'LIT-CSE-28-007', dept: 'cse', batch: 2028, evidence: 'P', cgpa: 7.7, target: 'DATA_ANALYST' },
  { key: 'mohit', name: 'Mohit Saxena', roll: 'LIT-CSE-28-008', dept: 'cse', batch: 2028, evidence: 'N', cgpa: 7.1, target: 'SOFTWARE_ENGINEER' },
  { key: 'vishal', name: 'Vishal Patil', roll: 'LIT-ECE-27-001', dept: 'ece', batch: 2027, evidence: 'P', cgpa: 7.9, target: 'SOFTWARE_ENGINEER' },
  { key: 'ritu', name: 'Ritu Chauhan', roll: 'LIT-ECE-27-002', dept: 'ece', batch: 2027, evidence: 'R', cgpa: 8.5, target: 'DATA_ANALYST' },
  { key: 'naveen', name: 'Naveen Kumar', roll: 'LIT-ECE-27-003', dept: 'ece', batch: 2027, evidence: 'D', cgpa: 6.7, target: 'SOC_ANALYST' },
  { key: 'shruti', name: 'Shruti Bhat', roll: 'LIT-ECE-27-004', dept: 'ece', batch: 2027, evidence: 'P', cgpa: 7.3, target: 'BUSINESS_ANALYST' },
  { key: 'abhinav', name: 'Abhinav Ghosh', roll: 'LIT-ECE-27-005', dept: 'ece', batch: 2027, evidence: 'N', cgpa: 6.5, target: 'CUSTOMER_SUCCESS' },
  { key: 'deepika', name: 'Deepika Rangan', roll: 'LIT-ECE-27-006', dept: 'ece', batch: 2027, evidence: 'D', cgpa: 7.0, target: 'SOFTWARE_ENGINEER' },
  { key: 'manoj', name: 'Manoj Pandey', roll: 'LIT-ECE-27-007', dept: 'ece', batch: 2027, evidence: 'P', cgpa: 7.6, target: 'DATA_ANALYST' },
  { key: 'zoya', name: 'Zoya Fernandes', roll: 'LIT-ECE-27-008', dept: 'ece', batch: 2027, evidence: 'R', cgpa: 8.4, target: 'SOFTWARE_ENGINEER' },
];

interface SampleGraduate { readonly key: string; readonly name: string; readonly roll: string; readonly cgpa: number; readonly persona?: DemoPersona }
const GRADUATES: readonly SampleGraduate[] = [
  { key: 'kavitha', name: 'Kavitha Selvam', roll: 'LIT-CSE-22-014', cgpa: 8.4, persona: 'graduate' },
  { key: 'joseph', name: 'Joseph Mathew', roll: 'LIT-CSE-22-021', cgpa: 7.7 },
];

const personaByStudent = new Map<string, DemoPersona>([
  ...STUDENTS.flatMap((student) => (student.persona ? [[student.key, student.persona] as const] : [])),
  ...GRADUATES.flatMap((graduate) => (graduate.persona ? [[graduate.key, graduate.persona] as const] : [])),
]);
/** A persona's student account has the persona's id, so binding its sign-in reaches it. */
const studentId = (key: string): string => {
  const persona = personaByStudent.get(key);
  return persona ? personaId(persona) : sid(`student:${key}`);
};
const studentEmail = (student: { readonly key: string; readonly persona?: DemoPersona }): string =>
  student.persona ? personaEmail(student.persona) : `${student.key}@students.lakeview.example`;

// Pilot topics (data/career-readiness/pilot-v1.json): the readiness engine's inputs.
const TOPIC_COMMUNICATION = '20000000-0000-4000-8000-000000000001';
const TOPIC_INTERVIEW = '20000000-0000-4000-8000-000000000002';
const LESSON_WRITE_FOR_ACTION = '22000000-0000-4000-8000-000000000001';

/** demonstrated/possible pairs per topic; two records each unless the pattern is N. */
const EVIDENCE: Readonly<Record<Band, readonly (readonly [string, number, number])[]>> = {
  R: [[TOPIC_COMMUNICATION, 9, 10], [TOPIC_COMMUNICATION, 8, 10], [TOPIC_INTERVIEW, 9, 10], [TOPIC_INTERVIEW, 9, 10]],
  P: [[TOPIC_COMMUNICATION, 8, 10], [TOPIC_COMMUNICATION, 7, 10], [TOPIC_INTERVIEW, 7, 10], [TOPIC_INTERVIEW, 6, 10]],
  D: [[TOPIC_COMMUNICATION, 5, 10], [TOPIC_COMMUNICATION, 4, 10], [TOPIC_INTERVIEW, 6, 10], [TOPIC_INTERVIEW, 5, 10]],
  N: [[TOPIC_COMMUNICATION, 7, 10], [TOPIC_INTERVIEW, 6, 10]],
};

// --- Entry point ------------------------------------------------------------------------

const SEED_MARKER_ACTION = 'sandbox.seeded';
const SEED_MARKER_RESOURCE = 'sandbox-seed-v1';

export interface SeedSandboxOptions {
  readonly subjects: ReadonlyMap<DemoPersona, string>;
  /** Where data/ lives; defaults to the repository's. */
  readonly dataRoot?: URL;
}

export async function seedSandbox(pool: Pool, options: SeedSandboxOptions): Promise<string> {
  await refuseRealAccounts(pool);
  const dataRoot = options.dataRoot ?? new URL('../../../data/', import.meta.url);

  const marker = await pool.query(`SELECT 1 FROM audit_events WHERE action=$1 AND resource_id=$2 LIMIT 1`, [SEED_MARKER_ACTION, SEED_MARKER_RESOURCE]);
  if (marker.rows[0]) {
    await bindPersonas(pool, options.subjects);
    return `already seeded; ${describeBindings(options.subjects)}`;
  }
  const started = await pool.query(`SELECT 1 FROM organizations WHERE id=$1`, [ORG.lakeview]);
  if (started.rows[0]) {
    throw new Error('The sandbox holds a half-finished seed. Reset it (db:reset:sandbox) instead of seeding over it.');
  }

  const correlationId = `sandbox-seed-${randomUUID()}`;
  await inTransaction(pool, (client) => seedPeopleAndOrganisations(client));
  await bindPersonas(pool, options.subjects);
  await seedContent(pool, dataRoot);
  await inTransaction(pool, (client) => seedAcademicRecordsAndEvidence(client, correlationId));
  await seedCareerTargets(pool);
  await inTransaction(pool, (client) => seedHiring(client));
  await inTransaction(pool, (client) => seedGrowthTerritory(client));
  await pool.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1,$2,$3,'sandbox',$4,$5,'SUCCESS',$6,$7::jsonb)`,
    [randomUUID(), personaId('operations'), SEED_MARKER_ACTION, SEED_MARKER_RESOURCE, ORG.platform, correlationId,
      JSON.stringify({ sample: true, students: STUDENTS.length, graduates: GRADUATES.length })],
  );
  return `seeded ${STUDENTS.length} students, ${GRADUATES.length} graduates, ${PERSONA_ACCOUNTS.length} demo accounts; ${describeBindings(options.subjects)}`;
}

function describeBindings(subjects: ReadonlyMap<DemoPersona, string>): string {
  const bound = DEMO_PERSONAS.filter((persona) => subjects.has(persona));
  const unbound = DEMO_PERSONAS.filter((persona) => !subjects.has(persona));
  return `sign-in bound for ${bound.length ? bound.join(', ') : 'no persona'}${unbound.length ? `; not yet bound: ${unbound.join(', ')}` : ''}`;
}

/** The fifth lock: a database holding anyone real is not the sandbox, whatever its name. */
async function refuseRealAccounts(pool: Pool): Promise<void> {
  const users = await pool.query<{ email: string }>(`SELECT email FROM users`);
  const real = users.rows.filter((row) => !isSampleEmail(row.email)).length;
  if (real > 0) {
    throw new Error(`Refusing to seed: this database holds ${real} account(s) that are not sandbox sample accounts. The sandbox seed only runs on the sandbox database.`);
  }
}

async function inTransaction(pool: Pool, work: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Points each persona at its Cognito sub, or at an unbound subject no token carries. */
async function bindPersonas(pool: Pool, subjects: ReadonlyMap<DemoPersona, string>): Promise<void> {
  await inTransaction(pool, async (client) => {
    // Two passes, so swapping two personas' subs never collides on the unique index.
    for (const persona of DEMO_PERSONAS) {
      await client.query(`UPDATE users SET external_subject=$2, updated_at=now() WHERE id=$1`, [personaId(persona), unboundSubject(persona)]);
    }
    for (const [persona, sub] of subjects) {
      await client.query(`UPDATE users SET external_subject=$2, updated_at=now() WHERE id=$1`, [personaId(persona), sub]);
    }
  });
}

// --- People and organisations ------------------------------------------------------------

async function insertUser(client: PoolClient, id: string, email: string, subject: string): Promise<void> {
  await client.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`, [id, subject, email]);
}

async function membership(client: PoolClient, key: string, input: {
  readonly organizationId: string; readonly userId: string; readonly role: string;
  readonly institution?: boolean; readonly departmentUnitId?: string; readonly employer?: boolean;
}): Promise<string> {
  const id = sid(`membership:${key}`);
  await client.query(
    `INSERT INTO organization_memberships (id, organization_id, user_id, role, state, scope_organization_id, scope_institution_id, scope_department_unit_id, scope_employer_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$2,$5,$6,$7)`,
    [id, input.organizationId, input.userId, input.role, input.institution ? input.organizationId : null,
      input.departmentUnitId ?? null, input.employer ? input.organizationId : null],
  );
  return id;
}

async function seedPeopleAndOrganisations(client: PoolClient): Promise<void> {
  for (const persona of DEMO_PERSONAS) {
    if (persona === 'student' || persona === 'graduate') continue;
    await insertUser(client, personaId(persona), personaEmail(persona), unboundSubject(persona));
  }
  for (const staff of Object.values(STAFF)) await insertUser(client, staff.id, staff.email, `sandbox-staff:${staff.email}`);

  // AI8HT's side: the platform organisation, operations and growth.
  await client.query(`INSERT INTO organizations (id, kind, legal_name, verification_state, active) VALUES ($1,'PLATFORM','AI8HT','VERIFIED',true)`, [ORG.platform]);
  await membership(client, 'operations', { organizationId: ORG.platform, userId: personaId('operations'), role: 'OPERATIONS_ADMIN' });
  for (const [key, staff] of [['author', STAFF.author], ['reviewer', STAFF.reviewer], ['publisher', STAFF.publisher]] as const) {
    await membership(client, `content-${key}`, { organizationId: ORG.platform, userId: staff.id, role: 'OPERATIONS_ADMIN' });
  }
  const manager = await membership(client, 'growth-manager', { organizationId: ORG.platform, userId: STAFF.growthManager.id, role: 'GROWTH_MANAGER' });
  const executive = await membership(client, 'growth', { organizationId: ORG.platform, userId: personaId('growth'), role: 'GROWTH_EXECUTIVE' });
  for (const [key, membershipId, staffType] of [['manager', manager, 'EMPLOYEE'], ['executive', executive, 'CONTRACTOR']] as const) {
    await client.query(
      `INSERT INTO growth_staff_types (id, membership_id, staff_type, set_by_user_id, reason_code) VALUES ($1,$2,$3,$4,'INITIAL_TYPE')`,
      [sid(`growth-staff-type:${key}`), membershipId, staffType, personaId('operations')],
    );
  }
  await client.query(
    `INSERT INTO growth_team_members (id, membership_id, team, manager_membership_id, joined_by_user_id, reason_code) VALUES
       ($1,$2,'COLLEGE_PARTNERSHIPS',NULL,$5,'NEW_MEMBER'),
       ($3,$4,'COLLEGE_PARTNERSHIPS',$2,$5,'NEW_MEMBER')`,
    [sid('growth-team:manager'), manager, sid('growth-team:executive'), executive, personaId('operations')],
  );

  // The college.
  await client.query(`INSERT INTO organizations (id, kind, legal_name, verification_state, active) VALUES ($1,'INSTITUTION','Lakeview Institute of Technology','VERIFIED',true)`, [ORG.lakeview]);
  await client.query(
    `INSERT INTO organization_profiles (organization_id, display_name, website_url, country_code, state_or_province, city, primary_contact_email, institution_type)
     VALUES ($1,'Lakeview Institute of Technology','https://lakeview.example','IN','Karnataka','Mysuru','placement@lakeview.example','ENGINEERING_COLLEGE')`,
    [ORG.lakeview],
  );
  await client.query(
    `INSERT INTO institution_settings (institution_id, about_text, placement_contact_email, updated_by_user_id) VALUES ($1,$2,'placement@lakeview.example',$3)`,
    [ORG.lakeview, 'Lakeview Institute of Technology is a fictional engineering college used only in the ONE sandbox. Every student, lecturer and record here is sample data.', personaId('institution-admin')],
  );
  await client.query(
    `INSERT INTO institution_units (id, institution_id, kind, name, parent_unit_id) VALUES
       ($1,$8,'DEPARTMENT','Computer Science and Engineering',NULL),
       ($2,$8,'DEPARTMENT','Electronics and Communication Engineering',NULL),
       ($3,$8,'PROGRAM','B.Tech Computer Science and Engineering',$1),
       ($4,$8,'PROGRAM','B.Tech Electronics and Communication Engineering',$2),
       ($5,$8,'BATCH','CSE 2023-2027',$3),
       ($6,$8,'BATCH','CSE 2024-2028',$3),
       ($7,$8,'BATCH','ECE 2023-2027',$4)`,
    [UNIT.cse, UNIT.ece, UNIT.cseProgram, UNIT.eceProgram, UNIT.cse2027, UNIT.cse2028, UNIT.ece2027, ORG.lakeview],
  );
  for (const program of [UNIT.cseProgram, UNIT.eceProgram]) {
    await client.query(
      `INSERT INTO institution_grading_scales (id, institution_id, program_unit_id, result_scale, pass_threshold, created_by_user_id, updated_by_user_id)
       VALUES ($1,$2,$3,'CGPA_10',5.0,$4,$4)`,
      [sid(`grading:${program}`), ORG.lakeview, program, personaId('institution-admin')],
    );
  }
  await client.query(
    `INSERT INTO institution_academic_terms (id, institution_id, name, kind, starts_on, ends_on, unit_id, created_by_user_id, updated_by_user_id) VALUES
       ($1,$4,'Odd semester 2026','TERM','2026-07-15','2026-11-30',NULL,$5,$5),
       ($2,$4,'End-semester examinations','EXAMINATIONS','2026-12-01','2026-12-20',NULL,$5,$5),
       ($3,$4,'Winter break','BREAK','2026-12-21','2027-01-04',NULL,$5,$5)`,
    [sid('term:odd-2026'), sid('term:exams-2026'), sid('term:break-2026'), ORG.lakeview, personaId('institution-admin')],
  );
  await membership(client, 'institution-admin', { organizationId: ORG.lakeview, userId: personaId('institution-admin'), role: 'INSTITUTION_ADMIN', institution: true });
  await membership(client, 'placement', { organizationId: ORG.lakeview, userId: personaId('placement'), role: 'PLACEMENT_ADMIN', institution: true });
  await membership(client, 'lecturer', { organizationId: ORG.lakeview, userId: personaId('lecturer'), role: 'FACULTY_LECTURER', institution: true, departmentUnitId: UNIT.cse });
  await membership(client, 'department-head', { organizationId: ORG.lakeview, userId: personaId('department-head'), role: 'DEPARTMENT_HEAD', institution: true, departmentUnitId: UNIT.cse });

  // Students: the roster row, the live relationship and a profile, as an accepted invitation leaves them.
  for (const student of STUDENTS) {
    const id = studentId(student.key);
    await insertUser(client, id, studentEmail(student), student.persona ? unboundSubject(student.persona) : `sandbox-student:${student.key}`);
    const start = `${student.batch - 4}-08-01`;
    await client.query(
      `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, department_unit_id, program_unit_id, batch_unit_id, status, academic_start_date, expected_graduation_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10)`,
      [sid(`roster:${student.key}`), ORG.lakeview, id, student.roll, student.name,
        student.dept === 'cse' ? UNIT.cse : UNIT.ece, student.dept === 'cse' ? UNIT.cseProgram : UNIT.eceProgram,
        student.dept === 'ece' ? UNIT.ece2027 : student.batch === 2027 ? UNIT.cse2027 : UNIT.cse2028,
        start, `${student.batch}-05-31`],
    );
    await client.query(
      `INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from) VALUES ($1,$2,$3,'ACTIVE',$4)`,
      [sid(`relationship:${student.key}`), ORG.lakeview, id, start],
    );
    await client.query(
      `INSERT INTO student_profiles (user_id, target_career, career_interests, profile_headline, profile_summary, visibility_state)
       VALUES ($1,$2,$3,$4,$5,'INSTITUTION_VISIBLE')`,
      [id, targetTitle(student.target), interestsFor(student.target),
        `${student.dept === 'cse' ? 'B.Tech CSE' : 'B.Tech ECE'} ${student.batch} at Lakeview`,
        'Sample profile in the ONE sandbox. This student is fictional.'],
    );
  }
  // Graduates: the roster row and relationship as the college's year-end batch leaves them.
  for (const graduate of GRADUATES) {
    const id = studentId(graduate.key);
    await insertUser(client, id, studentEmail(graduate), graduate.persona ? unboundSubject(graduate.persona) : `sandbox-student:${graduate.key}`);
    await client.query(
      `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, department_unit_id, program_unit_id, status, academic_start_date, expected_graduation_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'GRADUATED','2018-08-01','2022-05-31')`,
      [sid(`roster:${graduate.key}`), ORG.lakeview, id, graduate.roll, graduate.name, UNIT.cse, UNIT.cseProgram],
    );
    await client.query(
      `INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from, effective_to) VALUES ($1,$2,$3,'GRADUATED','2018-08-01','2022-05-31')`,
      [sid(`relationship:${graduate.key}`), ORG.lakeview, id],
    );
    await client.query(
      `INSERT INTO student_profiles (user_id, target_career, profile_headline, profile_summary, visibility_state) VALUES ($1,'Software Engineer',$2,$3,'PRIVATE')`,
      [id, 'Lakeview B.Tech CSE graduate, 2022', 'Sample profile in the ONE sandbox. This graduate is fictional.'],
    );
  }

  // The employer.
  await client.query(`INSERT INTO organizations (id, kind, legal_name, verification_state, active) VALUES ($1,'EMPLOYER','Corvane Labs Private Limited','VERIFIED',true)`, [ORG.corvane]);
  await client.query(
    `INSERT INTO organization_profiles (organization_id, display_name, website_url, country_code, state_or_province, city, primary_contact_email, about_text, industry, company_size_band)
     VALUES ($1,'Corvane Labs','https://corvane.example','IN','Karnataka','Bengaluru','talent@corvane.example',$2,'SOFTWARE_AND_IT_SERVICES','201-1000')`,
    [ORG.corvane, 'Corvane Labs is a fictional software company used only in the ONE sandbox. Its jobs and people are sample data.'],
  );
  await membership(client, 'employer-owner', { organizationId: ORG.corvane, userId: personaId('employer-owner'), role: 'EMPLOYER_OWNER', employer: true });
  await membership(client, 'employer', { organizationId: ORG.corvane, userId: personaId('employer'), role: 'RECRUITER', employer: true });
  await client.query(
    `INSERT INTO organization_verification_events (id, organization_id, from_state, to_state, reason_code, actor_user_id, correlation_id) VALUES
       ($1,$3,'PENDING','VERIFIED','SANDBOX_SAMPLE',$4,'sandbox-seed'),
       ($2,$5,'PENDING','VERIFIED','SANDBOX_SAMPLE',$4,'sandbox-seed')`,
    [sid('verification:corvane'), sid('verification:lakeview'), ORG.corvane, personaId('operations'), ORG.lakeview],
  );
}

function targetTitle(code: SampleStudent['target']): string {
  return ({ SOFTWARE_ENGINEER: 'Software Engineer', DATA_ANALYST: 'Data Analyst', BUSINESS_ANALYST: 'Business Analyst', SOC_ANALYST: 'Security Operations Analyst', CUSTOMER_SUCCESS: 'Customer Success Associate' })[code];
}

function interestsFor(code: SampleStudent['target']): string[] {
  return ({
    SOFTWARE_ENGINEER: ['Data structures', 'Web development', 'Problem solving'],
    DATA_ANALYST: ['SQL', 'Data visualisation', 'Statistics'],
    BUSINESS_ANALYST: ['Requirements', 'Communication', 'Spreadsheets'],
    SOC_ANALYST: ['Networking', 'Security monitoring', 'Incident response'],
    CUSTOMER_SUCCESS: ['Communication', 'Customer empathy', 'Product knowledge'],
  })[code];
}

// --- Published content through the real publishing code --------------------------------

async function seedContent(pool: Pool, dataRoot: URL): Promise<void> {
  const actors = { authorUserId: STAFF.author.id, reviewerUserId: STAFF.reviewer.id, publisherUserId: STAFF.publisher.id };
  const pilotBytes = await readFile(new URL('career-readiness/pilot-v1.json', dataRoot));
  const staging = JSON.parse((await readFile(new URL('career-readiness/v4-staging-manifest.json', dataRoot))).toString('utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, staging, STAFF.author.id);
  await publishCareerReadinessPilot(pool, JSON.parse(pilotBytes.toString('utf8')) as PilotFixture,
    createHash('sha256').update(pilotBytes).digest('hex'), actors);

  const starter = JSON.parse(await readFile(new URL('careers/starter-v1.json', dataRoot), 'utf8')) as { readonly roles: readonly CareerRoleInput[] };
  await seedStarterCareerRoles(pool, starter.roles);
  const catalogue = JSON.parse(await readFile(new URL('careers/catalogue-v1.json', dataRoot), 'utf8')) as CareerCatalogueFile;
  verifyCatalogueCounts(catalogue.roles, catalogue.goals);
  await seedCareerCatalogue(pool, catalogue);
  await seedCareerCatalogueGoals(pool, catalogue);

  // The aptitude bank lands as DRAFTS, exactly as on production, so Operations has a real
  // review queue to show. Nothing is published by this step.
  const pack = JSON.parse(await readFile(new URL('engine/aptitude-bank-v1.draft.json', dataRoot), 'utf8')) as AptitudeBankPack;
  await importAptitudeBankPack(drizzle(pool, { schema }) as unknown as TransactionalRunner, pack,
    { userId: STAFF.author.id, breakGlass: false, correlationId: `sandbox-aptitude-${randomUUID()}` });

  // The learner cards (Practice, Company Prep, Career Tools, Scholarships, Resume Builder)
  // through the review workflow: author drafts and submits, reviewer approves, publisher publishes.
  for (const key of LEARNER_CONTENT_SEED_KEYS) {
    const seed = LEARNER_CONTENT_SEEDS[key];
    const id = sid(`learner-content:${key}`);
    await createLearnerContentDraft(pool, {
      id, contentType: seed.contentType, title: seed.title, summary: seed.summary, content: seed.content,
      source: 'SEEDED', createdByUserId: STAFF.author.id, sortOrder: seed.sortOrder, metadata: { ...seed.metadata, sandbox: true },
    });
    await transitionLearnerContentReview(pool, { reviewId: randomUUID(), contentId: id, actorUserId: STAFF.author.id, toState: 'IN_REVIEW' });
    await transitionLearnerContentReview(pool, { reviewId: randomUUID(), contentId: id, actorUserId: STAFF.reviewer.id, toState: 'APPROVED' });
    await transitionLearnerContentReview(pool, { reviewId: randomUUID(), contentId: id, actorUserId: STAFF.publisher.id, toState: 'PUBLISHED' });
  }
}

// --- Academic records, evidence and readiness --------------------------------------------

async function seedAcademicRecordsAndEvidence(client: PoolClient, correlationId: string): Promise<void> {
  const verifier = personaId('placement');
  const records = [
    ...STUDENTS.map((student) => ({
      key: student.key, cgpa: student.cgpa, dept: student.dept, started: `${student.batch - 4}-08-01`, completed: null as string | null,
      terms: student.batch === 2027 ? 6 : 4,
    })),
    ...GRADUATES.map((graduate) => ({ key: graduate.key, cgpa: graduate.cgpa, dept: 'cse' as const, started: '2018-08-01', completed: '2022-05-31' as string | null, terms: 8 })),
  ];
  for (const record of records) {
    const qualificationId = sid(`qualification:${record.key}`);
    await client.query(
      `INSERT INTO student_qualifications (id, student_user_id, institution_id, qualification_type, programme_name, started_on, completed_on, awarded, verification_state, verified_by_user_id, verified_at)
       VALUES ($1,$2,$3,'BTECH',$4,$5,$6,$7,'VERIFIED',$8,now())`,
      [qualificationId, studentId(record.key), ORG.lakeview,
        record.dept === 'cse' ? 'B.Tech Computer Science and Engineering' : 'B.Tech Electronics and Communication Engineering',
        record.started, record.completed, record.completed !== null, verifier],
    );
    for (let sequence = 1; sequence <= record.terms; sequence += 1) {
      // A small, fixed wobble around the student's CGPA so terms differ but stay in range.
      const value = Math.max(5, Math.min(10, record.cgpa + [0.2, -0.3, 0.1, -0.1, 0.3, -0.2, 0.0, 0.1][sequence - 1]!));
      await client.query(
        `INSERT INTO student_academic_terms (id, qualification_id, sequence, label, result_value, result_scale, backlog_count, source, verification_state, verified_by_user_id, verified_at)
         VALUES ($1,$2,$3,$4,$5,'CGPA_10',0,'INSTITUTION_IMPORTED','VERIFIED',$6,now())`,
        [sid(`term:${record.key}:${sequence}`), qualificationId, sequence, `Semester ${sequence}`, value.toFixed(2), verifier],
      );
    }
  }
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1,$2,'institution.academic_results.imported','academic_results_import',$3,$4,'SUCCESS',$5,$6::jsonb)`,
    [randomUUID(), verifier, sid('results-import'), ORG.lakeview, correlationId, JSON.stringify({ filename: 'lakeview-sample-results.csv', sample: true })],
  );

  // Evidence of skill, then the real readiness engine computes each band from it. Evidence
  // dated last month as well as now, so the college's monthly views have a closed month.
  const lastMonth = await client.query<{ at: Date }>(`SELECT (date_trunc('month', now()) - interval '12 days') AS at`);
  const evidenceAt = lastMonth.rows[0]!.at;
  for (const student of STUDENTS) {
    const id = studentId(student.key);
    let index = 0;
    for (const [topic, demonstrated, possible] of EVIDENCE[student.evidence]) {
      index += 1;
      await client.query(
        `INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id, content_version, provenance, occurred_at)
         VALUES ($1,$2,'TOPIC_DEMONSTRATION',$3,$4,$5,'sandbox_sample',$6,'sandbox-v1',$7::jsonb,$8)`,
        [sid(`evidence:${student.key}:${index}`), id, topic, demonstrated, possible, sid(`evidence-source:${student.key}:${index}`),
          JSON.stringify({ source: 'sandbox-seed', sample: true }), evidenceAt],
      );
    }
    const refreshed = await refreshReadinessAfterEvidence(client, { subjectUserId: id, correlationId });
    if (!refreshed) throw new Error('The readiness model is not published; the content pilot must be seeded first.');
    // The same band, as it stood at the end of last month: the college's readiness views
    // report closed months only. Copied from the engine's own result, never chosen here.
    await client.query(
      `INSERT INTO readiness_snapshots (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, generated_at)
       SELECT $1, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, $3
       FROM readiness_snapshots WHERE id=$2`,
      [sid(`snapshot:last-month:${student.key}`), refreshed.snapshotId, evidenceAt],
    );
  }
}

async function seedCareerTargets(pool: Pool): Promise<void> {
  for (const student of STUDENTS) {
    await setStudentCareerTarget(pool, {
      subjectUserId: studentId(student.key), careerRoleId: deterministicId('career-role', student.target), priority: 'PRIMARY', goalOrigin: 'ONBOARDING',
    });
  }
}

// --- Hiring: jobs, a campus drive and applications at every stage ------------------------

interface SampleJob {
  readonly key: string; readonly title: string; readonly summary: string; readonly responsibilities: string;
  readonly employmentType: 'FULL_TIME' | 'INTERNSHIP'; readonly workMode: 'HYBRID' | 'REMOTE' | 'ONSITE'; readonly city: string | null;
  readonly currency: 'INR'; readonly min: string; readonly max: string | null; readonly period: 'YEAR' | 'MONTH';
  readonly durationMonths: number | null; readonly deadlineDays: number;
  readonly audience: { readonly kind: 'INSTITUTION' } | { readonly kind: 'INSTITUTION_UNIT'; readonly unitId: string };
  readonly skills: readonly (readonly [string, 'REQUIRED' | 'PREFERRED'])[];
  readonly stages: readonly (readonly ['SCREENING' | 'ASSESSMENT' | 'INTERVIEW' | 'OFFER', string])[];
}

const JOBS: readonly SampleJob[] = [
  {
    key: 'graduate-engineer', title: 'Graduate Software Engineer', summary: 'Join the platform team building Corvane\'s internal tools. Sample job in the ONE sandbox.',
    responsibilities: 'Write and review code, fix defects, and pair with a senior engineer on one product area.',
    employmentType: 'FULL_TIME', workMode: 'HYBRID', city: 'Bengaluru', currency: 'INR', min: '700000', max: '900000', period: 'YEAR',
    durationMonths: null, deadlineDays: 45, audience: { kind: 'INSTITUTION' },
    skills: [['Data structures and algorithms', 'REQUIRED'], ['Professional communication', 'REQUIRED'], ['SQL', 'PREFERRED']],
    stages: [['SCREENING', 'Application review'], ['ASSESSMENT', 'Coding exercise'], ['INTERVIEW', 'Technical interview'], ['OFFER', 'Offer']],
  },
  {
    key: 'data-intern', title: 'Data Analyst Intern', summary: 'A six-month internship with the analytics team. Sample job in the ONE sandbox.',
    responsibilities: 'Clean data, build weekly dashboards and present one finding a month.',
    employmentType: 'INTERNSHIP', workMode: 'REMOTE', city: null, currency: 'INR', min: '25000', max: null, period: 'MONTH',
    durationMonths: 6, deadlineDays: 30, audience: { kind: 'INSTITUTION' },
    skills: [['SQL', 'REQUIRED'], ['Data visualisation', 'PREFERRED']],
    stages: [['SCREENING', 'Application review'], ['INTERVIEW', 'Conversation with the team'], ['OFFER', 'Offer']],
  },
  {
    key: 'embedded-trainee', title: 'Embedded Systems Trainee', summary: 'Firmware and hardware testing for Corvane\'s device line. Sample job in the ONE sandbox.',
    responsibilities: 'Test firmware builds, write test scripts and document hardware issues.',
    employmentType: 'FULL_TIME', workMode: 'ONSITE', city: 'Pune', currency: 'INR', min: '550000', max: '650000', period: 'YEAR',
    durationMonths: null, deadlineDays: 40, audience: { kind: 'INSTITUTION_UNIT', unitId: UNIT.ece },
    skills: [['Embedded C', 'REQUIRED'], ['Digital electronics', 'REQUIRED']],
    stages: [['SCREENING', 'Application review'], ['INTERVIEW', 'Technical interview'], ['OFFER', 'Offer']],
  },
];

type Stage = 'APPLIED' | 'SCREENING' | 'SHORTLISTED' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED';
const PIPELINE: readonly Stage[] = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'OFFER'];

const APPLICATIONS: readonly { readonly student: string; readonly job: string; readonly stage: Stage; readonly daysAgo: number }[] = [
  { student: 'arjun', job: 'graduate-engineer', stage: 'INTERVIEW', daysAgo: 12 },
  { student: 'arjun', job: 'data-intern', stage: 'APPLIED', daysAgo: 2 },
  { student: 'priya', job: 'graduate-engineer', stage: 'OFFER', daysAgo: 20 },
  { student: 'karthik', job: 'graduate-engineer', stage: 'SHORTLISTED', daysAgo: 9 },
  { student: 'ishita', job: 'graduate-engineer', stage: 'INTERVIEW', daysAgo: 11 },
  { student: 'divya', job: 'graduate-engineer', stage: 'SCREENING', daysAgo: 6 },
  { student: 'aditya', job: 'graduate-engineer', stage: 'REJECTED', daysAgo: 15 },
  { student: 'meghana', job: 'graduate-engineer', stage: 'APPLIED', daysAgo: 3 },
  { student: 'sneha', job: 'data-intern', stage: 'HIRED', daysAgo: 25 },
  { student: 'nandini', job: 'data-intern', stage: 'SHORTLISTED', daysAgo: 8 },
  { student: 'vishal', job: 'embedded-trainee', stage: 'APPLIED', daysAgo: 4 },
  { student: 'ritu', job: 'embedded-trainee', stage: 'SHORTLISTED', daysAgo: 10 },
];

async function seedHiring(client: PoolClient): Promise<void> {
  const recruiter = personaId('employer');
  const placement = personaId('placement');
  const jobIds = new Map<string, { readonly opportunityId: string; readonly versionId: string; readonly interviewStageId: string | null }>();

  for (const [index, job] of JOBS.entries()) {
    const opportunityId = sid(`job:${job.key}`);
    const versionId = sid(`job-version:${job.key}`);
    const deadline = await client.query<{ at: string }>(`SELECT to_char((now() + make_interval(days => $1))::date, 'YYYY-MM-DD') || 'T18:29:59.000Z' AS at`, [job.deadlineDays]);
    const applicationDeadline = deadline.rows[0]!.at;
    const terms: MaterialTerms = {
      employmentType: job.employmentType, workMode: job.workMode, locationCity: job.city, compensationDisclosed: true,
      compensationCurrency: job.currency, compensationMin: job.min, compensationMax: job.max, compensationPeriod: job.period,
      durationMonths: job.durationMonths, applicationDeadline, joiningConditions: null,
    };
    await client.query(
      `INSERT INTO opportunities (id, employer_id, created_by_user_id, reference_code, lifecycle_state) VALUES ($1,$2,$3,$4,'DRAFT')`,
      [opportunityId, ORG.corvane, recruiter, `CORV-2026-${String(index + 1).padStart(2, '0')}`],
    );
    await client.query(
      `INSERT INTO opportunity_versions (id, opportunity_id, version_number, title, summary, responsibilities, employment_type, work_mode, location_city, positions_available, duration_months, compensation_disclosed, compensation_currency, compensation_min, compensation_max, compensation_period, application_deadline, material_terms_hash, created_by_user_id)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15::timestamptz,$16,$17)`,
      [versionId, opportunityId, job.title, job.summary, job.responsibilities, job.employmentType, job.workMode, job.city, 4,
        job.durationMonths, job.currency, job.min, job.max, job.period, applicationDeadline, materialTermsHash(terms), recruiter],
    );
    await client.query(`UPDATE opportunities SET current_version_id=$2 WHERE id=$1`, [opportunityId, versionId]);
    for (const [skillIndex, [skill, level]] of job.skills.entries()) {
      await client.query(
        `INSERT INTO opportunity_skill_requirements (id, opportunity_version_id, skill_name, requirement_level) VALUES ($1,$2,$3,$4)`,
        [sid(`job-skill:${job.key}:${skillIndex}`), versionId, skill, level],
      );
    }
    let interviewStageId: string | null = null;
    for (const [stageIndex, [kind, label]] of job.stages.entries()) {
      const stageId = sid(`job-stage:${job.key}:${stageIndex}`);
      if (kind === 'INTERVIEW') interviewStageId = stageId;
      await client.query(
        `INSERT INTO opportunity_selection_stages (id, opportunity_version_id, stage_order, stage_kind, label) VALUES ($1,$2,$3,$4,$5)`,
        [stageId, versionId, stageIndex + 1, kind, label],
      );
    }
    // Advisory only: shown to the student with their verified CGPA, never a hard block.
    await client.query(
      `INSERT INTO opportunity_eligibility_rules (id, opportunity_version_id, rule_type, comparator, value_numeric, is_blocking) VALUES ($1,$2,'MIN_CGPA','GTE',6.0,false)`,
      [sid(`job-rule:${job.key}`), versionId],
    );
    await client.query(
      `INSERT INTO opportunity_audiences (id, opportunity_id, audience_kind, institution_id, institution_unit_id) VALUES ($1,$2,$3,$4,$5)`,
      [sid(`job-audience:${job.key}`), opportunityId, job.audience.kind, ORG.lakeview, job.audience.kind === 'INSTITUTION_UNIT' ? job.audience.unitId : null],
    );
    await client.query(
      `UPDATE opportunities SET lifecycle_state='PUBLISHED', published_at=now() - interval '30 days', updated_at=now() WHERE id=$1`,
      [opportunityId],
    );
    jobIds.set(job.key, { opportunityId, versionId, interviewStageId });
  }

  // The college approved a campus drive for the graduate engineer role.
  const drive = jobIds.get('graduate-engineer')!;
  const driveId = sid('drive:graduate-engineer');
  await client.query(
    `INSERT INTO campus_drives (id, employer_id, opportunity_id, institution_id, requested_by_user_id, state, proposed_start_at, proposed_end_at, venue_mode, employer_note, decided_by_user_id, decided_at, revision, created_at)
     VALUES ($1,$2,$3,$4,$5,'APPROVED', date_trunc('day', now()) + interval '14 days 10 hours', date_trunc('day', now()) + interval '14 days 16 hours',
             'ON_CAMPUS',$6,$7, now() - interval '20 days', 2, now() - interval '25 days')`,
    [driveId, ORG.corvane, drive.opportunityId, ORG.lakeview, recruiter, 'Coding exercise in the morning, interviews in the afternoon. Sample drive.', placement],
  );
  await client.query(
    `INSERT INTO campus_drive_state_history (id, campus_drive_id, from_state, to_state, actor_user_id, actor_side, created_at) VALUES
       ($1,$3,NULL,'REQUESTED',$4,'EMPLOYER', now() - interval '25 days'),
       ($2,$3,'REQUESTED','APPROVED',$5,'INSTITUTION', now() - interval '20 days')`,
    [sid('drive-history:1'), sid('drive-history:2'), driveId, recruiter, placement],
  );

  const rosterByKey = new Map(STUDENTS.map((student) => [student.key, student]));
  for (const application of APPLICATIONS) {
    const student = rosterByKey.get(application.student)!;
    const job = jobIds.get(application.job)!;
    const applicationId = sid(`application:${application.student}:${application.job}`);
    const userId = studentId(student.key);
    const closed = application.stage === 'HIRED' || application.stage === 'REJECTED';
    await client.query(
      `INSERT INTO applications (id, opportunity_id, employer_id, applied_version_id, student_user_id, state, consent_granted_at, submitted_at, institution_visibility_granted_at, closed_at, rejection_reason_code, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - make_interval(days => $7), now() - make_interval(days => $7), now() - make_interval(days => $7),
               CASE WHEN $8 THEN now() - interval '1 day' ELSE NULL END, $9, now() - make_interval(days => $7))`,
      [applicationId, job.opportunityId, ORG.corvane, job.versionId, userId, application.stage, application.daysAgo, closed,
        application.stage === 'REJECTED' ? 'SKILLS_MISMATCH' : null],
    );

    // The history the API writes: the student applies, then each employer move in order.
    const path: Stage[] = ['APPLIED'];
    const target = application.stage === 'HIRED' ? 'OFFER' : application.stage === 'REJECTED' ? 'SCREENING' : application.stage;
    for (const stage of PIPELINE.slice(1)) {
      if (PIPELINE.indexOf(stage) > PIPELINE.indexOf(target)) break;
      path.push(stage);
    }
    if (application.stage === 'HIRED' || application.stage === 'REJECTED') path.push(application.stage);
    for (const [step, stage] of path.entries()) {
      await client.query(
        `INSERT INTO application_state_history (id, application_id, from_state, to_state, changed_by_user_id, actor_role, reason_code, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() - make_interval(days => $8) + make_interval(hours => $9))`,
        [sid(`application-history:${applicationId}:${step}`), applicationId, step === 0 ? 'DRAFT' : path[step - 1], stage,
          step === 0 ? userId : recruiter, step === 0 ? 'STUDENT' : 'EMPLOYER', stage === 'REJECTED' ? 'SKILLS_MISMATCH' : null,
          application.daysAgo, step * 30],
      );
    }

    await client.query(
      `INSERT INTO employer_applicant_access_grants (id, employer_id, student_user_id, opportunity_id, granted_at, revoked_at)
       VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), CASE WHEN $6 THEN now() - interval '1 day' ELSE NULL END)`,
      [sid(`grant:${applicationId}`), ORG.corvane, userId, job.opportunityId, application.daysAgo, closed],
    );

    // What the employer sees of the student: the snapshot built by the hiring package.
    const qualifications = await client.query<{ qualification_type: string; programme_name: string; started_on: string | null; completed_on: string | null; awarded: boolean; verification_state: string }>(
      `SELECT qualification_type, programme_name, to_char(started_on,'YYYY-MM-DD') AS started_on, to_char(completed_on,'YYYY-MM-DD') AS completed_on, awarded, verification_state
       FROM student_qualifications WHERE student_user_id=$1`, [userId],
    );
    const snapshot = buildApplicationSnapshot({
      email: studentEmail(student),
      roster: {
        fullName: student.name, institutionName: 'Lakeview Institute of Technology',
        programmeName: student.dept === 'cse' ? 'B.Tech Computer Science and Engineering' : 'B.Tech Electronics and Communication Engineering',
        departmentName: student.dept === 'cse' ? 'Computer Science and Engineering' : 'Electronics and Communication Engineering',
        expectedGraduationDate: `${student.batch}-05-31`,
      },
      qualifications: qualifications.rows.map((row) => ({
        qualificationType: row.qualification_type, programmeName: row.programme_name, institutionName: 'Lakeview Institute of Technology',
        startedOn: row.started_on, completedOn: row.completed_on, awarded: row.awarded, verificationState: row.verification_state,
      })),
      profile: { headline: `${student.dept === 'cse' ? 'B.Tech CSE' : 'B.Tech ECE'} ${student.batch} at Lakeview`, summary: 'Sample profile in the ONE sandbox. This student is fictional.' },
      resume: null,
    }, { phone: null, links: [] });
    await client.query(
      `INSERT INTO application_profile_snapshots (id, application_id, opportunity_version_id, schema_version, snapshot, snapshot_hash)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [sid(`snapshot:${applicationId}`), applicationId, job.versionId, snapshot.schemaVersion, JSON.stringify(snapshot), snapshotHash(snapshot)],
    );

    if (application.job === 'graduate-engineer') {
      await client.query(`INSERT INTO campus_drive_applications (campus_drive_id, application_id, opportunity_id) VALUES ($1,$2,$3)`, [driveId, applicationId, job.opportunityId]);
    }

    if (application.stage === 'INTERVIEW') {
      const interviewId = sid(`interview:${applicationId}`);
      const offsetDays = application.student === 'arjun' ? 3 : 5;
      await client.query(
        `INSERT INTO interviews (id, application_id, employer_id, selection_stage_id, round_number, mode, state, scheduled_start, scheduled_end, joining_link, created_by_user_id)
         VALUES ($1,$2,$3,$4,1,'VIDEO','SCHEDULED', date_trunc('day', now()) + make_interval(days => $5, hours => 5), date_trunc('day', now()) + make_interval(days => $5, hours => 6), 'https://meet.corvane.example/sample-interview', $6)`,
        [interviewId, applicationId, ORG.corvane, job.interviewStageId, offsetDays, recruiter],
      );
      await client.query(
        `INSERT INTO interview_participants (id, interview_id, participant_user_id, participant_role) VALUES ($1,$2,$3,'INTERVIEWER')`,
        [sid(`interview-participant:${applicationId}`), interviewId, recruiter],
      );
      await client.query(
        `INSERT INTO interview_schedule_revisions (id, interview_id, employer_id, revision_number, change_kind, mode, scheduled_start, scheduled_end, joining_link, actor_user_id)
         SELECT $1, id, employer_id, 1, 'SCHEDULED', mode, scheduled_start, scheduled_end, joining_link, $3 FROM interviews WHERE id=$2`,
        [sid(`interview-revision:${applicationId}`), interviewId, recruiter],
      );
    }
    if (application.stage === 'OFFER' || application.stage === 'HIRED') {
      const accepted = application.stage === 'HIRED';
      await client.query(
        `INSERT INTO offers (id, application_id, employer_id, state, compensation_currency, compensation_amount, compensation_period, offer_expires_at, extended_at, responded_at, created_by_user_id)
         VALUES ($1,$2,$3,$4,'INR',$5,$6, now() + interval '14 days', now() - interval '3 days', $7, $8)`,
        [sid(`offer:${applicationId}`), applicationId, ORG.corvane, accepted ? 'ACCEPTED' : 'EXTENDED',
          application.job === 'data-intern' ? 25000 : 800000, application.job === 'data-intern' ? 'MONTH' : 'YEAR',
          accepted ? new Date(Date.now() - 2 * 86_400_000) : null, recruiter],
      );
    }
  }
}

// --- Growth: a territory and a pipeline of prospective colleges (GROWTH-02/03 tables) ---

/** Fictional prospects. None is a real institution or company. */
const GROWTH_LEADS: readonly {
  readonly key: string; readonly kind: 'COLLEGE' | 'EMPLOYER'; readonly name: string; readonly city: string;
  readonly domain: string | null; readonly stages: readonly string[]; readonly owned: boolean;
  readonly source: 'FIELD_VISIT' | 'EVENT' | 'INTRODUCTION' | 'PUBLIC_DIRECTORY';
  readonly contact: { readonly role: string; readonly name: string; readonly email: string } | null;
}[] = [
  { key: 'riverbend', kind: 'COLLEGE', name: 'Riverbend College of Engineering', city: 'Mandya', domain: null,
    stages: ['IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET'], owned: true, source: 'FIELD_VISIT',
    contact: { role: 'PLACEMENT_OFFICER', name: 'Prof. Anil Shenoy', email: 'placement@riverbend.example' } },
  { key: 'hillcrest', kind: 'COLLEGE', name: 'Hillcrest Institute of Management', city: 'Hassan', domain: null,
    stages: ['IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED'], owned: true, source: 'EVENT',
    contact: { role: 'DIRECTOR', name: 'Dr. Rekha Murthy', email: 'director@hillcrest.example' } },
  { key: 'sunvale', kind: 'COLLEGE', name: 'Sunvale Polytechnic', city: 'Tumakuru', domain: null,
    stages: ['IDENTIFIED', 'CONTACTED'], owned: true, source: 'INTRODUCTION', contact: null },
  { key: 'mangrove', kind: 'COLLEGE', name: 'Mangrove Arts and Science College', city: 'Udupi', domain: null,
    stages: ['IDENTIFIED'], owned: false, source: 'PUBLIC_DIRECTORY', contact: null },
  { key: 'tessaro', kind: 'EMPLOYER', name: 'Tessaro Systems', city: 'Bengaluru', domain: 'tessaro.example',
    stages: ['IDENTIFIED'], owned: false, source: 'EVENT', contact: null },
];

async function seedGrowthTerritory(client: PoolClient): Promise<void> {
  const operations = personaId('operations');
  const regionId = sid('growth-region:karnataka');
  // The region, its area and who works it, as Operations sets them up (a growth person may
  // not assign their own territory, so Operations does).
  await client.query(
    `INSERT INTO growth_regions (id, name, created_by_user_id, reason_code) VALUES ($1,'Karnataka',$2,'NEW_REGION')`,
    [regionId, operations],
  );
  await client.query(
    `INSERT INTO growth_region_areas (id, region_id, state_code, district_code, added_by_user_id, reason_code) VALUES ($1,$2,'IN-KA',NULL,$3,'NEW_COVERAGE')`,
    [sid('growth-area:karnataka'), regionId, operations],
  );
  const executive = sid('membership:growth');
  await client.query(
    `INSERT INTO growth_territory_assignments (id, region_id, membership_id, assignment_role, assigned_by_user_id, reason_code) VALUES
       ($1,$3,$4,'EXECUTIVE',$6,'NEW_ASSIGNMENT'),
       ($2,$3,$5,'MANAGER',$6,'NEW_ASSIGNMENT')`,
    [sid('growth-assignment:executive'), sid('growth-assignment:manager'), regionId, executive, sid('membership:growth-manager'), operations],
  );

  // Leads, created the way the growth leads service creates them, then moved along.
  const executiveUser = personaId('growth');
  for (const lead of GROWTH_LEADS) {
    const id = sid(`growth-lead:${lead.key}`);
    const owner = lead.owned ? executive : null;
    await client.query(
      `INSERT INTO growth_leads (id, kind, name, state_code, district_code, city, aishe_code, website_domain, owner_membership_id, source, possible_duplicate, created_by_user_id)
       VALUES ($1,$2,$3,'IN-KA',NULL,$4,NULL,$5,$6,$7,false,$8)`,
      [id, lead.kind, lead.name, lead.city, lead.domain, owner, lead.source, executiveUser],
    );
    // An unowned lead has no owner change to record (the history check refuses NULL to NULL).
    if (owner) {
      await client.query(
        `INSERT INTO growth_lead_owner_history (id, lead_id, from_membership_id, to_membership_id, reason_code, actor_user_id) VALUES ($1,$2,NULL,$3,'CREATED',$4)`,
        [sid(`growth-lead-owner:${lead.key}`), id, owner, executiveUser],
      );
    }
    for (const [index, stage] of lead.stages.entries()) {
      await client.query(
        `INSERT INTO growth_lead_stage_history (id, lead_id, from_stage, to_stage, reason_code, actor_user_id) VALUES ($1,$2,$3,$4,NULL,$5)`,
        [sid(`growth-lead-stage:${lead.key}:${index}`), id, index === 0 ? null : lead.stages[index - 1], stage, executiveUser],
      );
    }
    const stage = lead.stages[lead.stages.length - 1]!;
    if (stage !== 'IDENTIFIED') await client.query(`UPDATE growth_leads SET stage=$2, last_activity_at=now() WHERE id=$1`, [id, stage]);
    if (lead.contact) {
      await client.query(
        `INSERT INTO growth_lead_contacts (id, lead_id, contact_role, full_name, email, phone, permission_basis, source, added_by_user_id)
         VALUES ($1,$2,$3,$4,$5,NULL,'PROVIDED_BY_PERSON','MEETING',$6)`,
        [sid(`growth-lead-contact:${lead.key}`), id, lead.contact.role, lead.contact.name, lead.contact.email, executiveUser],
      );
    }
  }
}
