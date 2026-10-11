/**
 * Lesson languages for students over HTTP (ENG-16).
 *
 * The acceptance: a student can select a language, and a lesson with no published rendering in it
 * falls back to English with a notice. Around it: a Telugu variant reaches the student only once
 * it is PUBLISHED (never as a draft, in review, or approved-but-unpublished, and never after it is
 * archived); approving it needs a native-speaker review code, recorded with the rights review;
 * only the words change, so completing a lesson read in Telugu completes the base lesson once; a
 * rendering written for an older version of the lesson is served with a notice; only offered
 * languages can be chosen; the public catalogue stays English; the choice is audited. Plus the
 * §6.6 minimums for the new route. Real Postgres in a throwaway schema; synthetic data only.
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { publishCareerReadinessPilot, type PilotFixture } from '@planthepath/persistence/src/career-readiness.js';
import { renderLessonVersions } from '@planthepath/persistence/src/lesson-languages.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { CareerReadinessController } from './career-readiness.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for lesson language tests');

const schemaName = 'eng16_lessons_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let fixture: PilotFixture;
let moduleKey: string;

interface Member { readonly userId: string; readonly membershipId: string }

async function user(): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  return userId;
}

let granterId: string;

async function member(grants: readonly string[], role = 'OPERATIONS_ADMIN'): Promise<Member> {
  const userId = await user();
  const membershipId = randomUUID();
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$2,NULL)`,
    [membershipId, platformId, userId, role],
  );
  for (const capability of grants) {
    await pool.query(
      "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
      [randomUUID(), membershipId, capability, granterId],
    );
  }
  return { userId, membershipId };
}

let editor: Member;
let reviewer: Member;
let publisher: Member;
let reader: string;
let englishReader: string;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => randomUUID() },
      verifier: {
        async verifyAccessToken(token: string) {
          if (!tokens.has(token)) throw new Error('Invalid local test identity');
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    controllers: [CareerReadinessController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  granterId = (await member([], 'PLATFORM_SUPER_ADMIN')).userId;
  editor = await member(['CONTENT_EDIT']);
  reviewer = await member(['CONTENT_REVIEW']);
  publisher = await member(['CONTENT_PUBLISH']);
  reader = await user();
  englishReader = await user();

  const pilotBytes = await readFile(new URL('../../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const actors = { authorUserId: await user(), reviewerUserId: await user(), publisherUserId: await user() };
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  moduleKey = fixture.module.stableKey;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'eng16-' + randomUUID() });
const ops = '/api/v1/operations/lessons';
const firstPilot = () => fixture.lessons[0]!;
const secondPilot = () => fixture.lessons[1]!;

interface ServedLesson {
  readonly id: string; readonly stableKey: string; readonly version: number; readonly title: string; readonly topicId: string;
  readonly body: { summary?: string; practice?: string }; readonly prerequisiteLessonIds: string[];
  readonly language: string; readonly languageNotice: string | null;
}
interface LearnerState {
  readonly catalog: { modules: { lessons: ServedLesson[] }[] };
  readonly lessonLanguage: { selected: string; offered: { language: string; name: string; nativeName: string }[] };
}

async function learner(userId: string): Promise<LearnerState> {
  const response = await api().get('/api/v1/career-readiness/me').set(auth(userId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as LearnerState;
}
const lessonsOf = (state: LearnerState) => state.catalog.modules.flatMap((module) => module.lessons);
const servedOf = async (userId: string, stableKey: string) => lessonsOf(await learner(userId)).find((lesson) => lesson.stableKey === stableKey)!;
const choose = (userId: string, body: unknown) => api().put('/api/v1/career-readiness/me/lesson-language').set(auth(userId)).send(body as object);

function transition(actor: Member, revisionId: string, body: Record<string, unknown>) {
  return api().post(`${ops}/revisions/${revisionId}/transition`).set(auth(actor.userId)).send(body);
}
const approveBody = (over: Record<string, unknown> = {}) => ({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED', ...over });

/** Create a variant of a live pilot lesson and save a complete draft; returns its ids. */
async function draftVariant(baseId: string, language: string, text: { title: string; summary: string; practice?: string }): Promise<{ lessonId: string; revisionId: string }> {
  const created = await api().post(`${ops}/lessons/${baseId}/variants`).set(auth(editor.userId))
    .send({ language, level: 'STANDARD', style: 'EXPLANATION', title: text.title, reasonCode: 'NEW_LANGUAGE' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const revisionId = created.body.lesson.open.id as string;
  const saved = await api().post(`${ops}/revisions/${revisionId}/draft`).set(auth(editor.userId))
    .send({ ...text, licenceLabel: 'AI8HT-Owned', basis: 'Synthetic basis', reasonCode: 'DRAFT_EDIT' });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  return { lessonId: created.body.lesson.lessonId as string, revisionId };
}

async function publishVariant(revisionId: string): Promise<void> {
  expect((await transition(editor, revisionId, { toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' })).status).toBe(201);
  expect((await transition(reviewer, revisionId, approveBody({ languageReviewCode: 'NATIVE_SPEAKER_REVIEWED' }))).status).toBe(201);
  const published = await api().post(`${ops}/revisions/${revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_VARIANT' });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
}

const TELUGU = { title: 'సింథటిక్ పాఠం', summary: 'సింథటిక్ సారాంశం — పరీక్ష కోసం మాత్రమే.', practice: 'సింథటిక్ అభ్యాసం.' };

describe('access (§6.6 minimums for the new route)', () => {
  it('401 without a token', async () => {
    await api().put('/api/v1/career-readiness/me/lesson-language').send({ language: 'te' }).expect(401);
  });

  it('400 on a malformed body, and on a language not offered', async () => {
    for (const body of [{}, { language: 3 }, { language: 'te', extra: true }, [], { language: 'xx' }]) {
      const response = await choose(reader, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const notOffered = await choose(reader, { language: 'hi' });
    expect(notOffered.status).toBe(400);
    expect(notOffered.body.error.code).toBe('LESSON_LANGUAGE_NOT_OFFERED');
    expect((await pool.query('SELECT count(*)::int AS n FROM learner_language_preferences WHERE user_id=$1', [reader])).rows[0].n).toBe(0);
  });
});

describe('choosing a language (the acceptance)', () => {
  it('starts in English, offering English and Telugu', async () => {
    const state = await learner(reader);
    expect(state.lessonLanguage).toEqual({ selected: 'en', offered: [
      { language: 'en', name: 'English', nativeName: 'English' }, { language: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
    ] });
    for (const lesson of lessonsOf(state)) expect(lesson).toMatchObject({ language: 'en', languageNotice: null });
  });

  it('a student selects Telugu; every lesson with no published Telugu version falls back to English with a notice', async () => {
    const chosen = await choose(reader, { language: 'te' });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.lessonLanguage.selected).toBe('te');
    const state = await learner(reader);
    expect(state.lessonLanguage.selected).toBe('te');
    const english = new Map(fixture.lessons.map((lesson) => [lesson.id, lesson]));
    for (const lesson of lessonsOf(state)) {
      expect(lesson).toMatchObject({ language: 'en', languageNotice: 'TRANSLATION_MISSING', title: english.get(lesson.id)!.title });
    }
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='learner.lesson_language.changed' AND actor_user_id=$1", [reader])).rows;
    expect(audit.map((row) => row.context)).toEqual([{ from: 'en', to: 'te' }]);
    // Choosing it again changes nothing and writes no second audit row.
    expect((await choose(reader, { language: 'te' })).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='learner.lesson_language.changed' AND actor_user_id=$1", [reader])).rows[0].n).toBe(1);
  });
});

describe('a Telugu variant reaches students only when published', () => {
  let variant: { lessonId: string; revisionId: string };

  it('is never served as a draft, in review, or approved but unpublished', async () => {
    variant = await draftVariant(firstPilot().id, 'te', TELUGU);
    expect(await servedOf(reader, firstPilot().stableKey)).toMatchObject({ language: 'en', languageNotice: 'TRANSLATION_MISSING' });
    expect((await transition(editor, variant.revisionId, { toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' })).status).toBe(201);
    expect(await servedOf(reader, firstPilot().stableKey)).toMatchObject({ language: 'en', title: firstPilot().title });
  });

  it('cannot be approved without a native-speaker review, which is recorded with the rights review', async () => {
    const missing = await transition(reviewer, variant.revisionId, approveBody());
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('LESSON_LANGUAGE_REVIEW_MISSING');
    expect((await transition(reviewer, variant.revisionId, approveBody({ languageReviewCode: 'SOUNDS_RIGHT' }))).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await pool.query('SELECT state FROM content_revisions WHERE id=$1', [variant.revisionId])).rows[0].state).toBe('IN_REVIEW');
    const approved = await transition(reviewer, variant.revisionId, approveBody({ languageReviewCode: 'NATIVE_SPEAKER_CONSULTED' }));
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const record = (await pool.query("SELECT source_metadata FROM source_records WHERE source_entity_type='LESSON_EDITOR_REVISION' AND source_record_id=$1", [variant.revisionId])).rows[0];
    expect(record.source_metadata).toMatchObject({ language: 'te', languageReview: 'NATIVE_SPEAKER_CONSULTED' });
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='operations.content.lesson_transitioned' AND resource_id=$1 AND context->>'toState'='APPROVED'", [variant.revisionId])).rows[0];
    expect(audit.context).toMatchObject({ languageReviewCode: 'NATIVE_SPEAKER_CONSULTED' });
    // Approved is not published.
    expect(await servedOf(reader, firstPilot().stableKey)).toMatchObject({ language: 'en', languageNotice: 'TRANSLATION_MISSING' });
  });

  it('once published, a Telugu reader reads it; only the words change; an English reader is unaffected', async () => {
    const published = await api().post(`${ops}/revisions/${variant.revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_VARIANT' });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const pilot = firstPilot();
    const served = await servedOf(reader, pilot.stableKey);
    expect(served).toMatchObject({
      id: pilot.id, version: 1, topicId: pilot.topicId, prerequisiteLessonIds: [],
      title: TELUGU.title, body: { summary: TELUGU.summary, practice: TELUGU.practice }, language: 'te', languageNotice: null,
    });
    // The other lessons still fall back.
    expect(await servedOf(reader, secondPilot().stableKey)).toMatchObject({ language: 'en', languageNotice: 'TRANSLATION_MISSING', title: secondPilot().title });
    expect(await servedOf(englishReader, pilot.stableKey)).toMatchObject({ language: 'en', languageNotice: null, title: pilot.title });
    // The public catalogue has no learner and stays English.
    const catalog = await api().get('/api/v1/career-readiness/catalog').expect(200);
    const listed = (catalog.body.modules as { lessons: ServedLesson[] }[]).flatMap((module) => module.lessons).find((lesson) => lesson.id === pilot.id)!;
    expect(listed.title).toBe(pilot.title);
    expect(listed).not.toHaveProperty('language');
  });

  it('completing the lesson read in Telugu completes the base lesson once, with one piece of evidence', async () => {
    const completed = await api().post(`/api/v1/career-readiness/lessons/${firstPilot().id}/complete`).set(auth(reader));
    expect(completed.status, JSON.stringify(completed.body)).toBe(201);
    expect((await api().post(`/api/v1/career-readiness/lessons/${firstPilot().id}/complete`).set(auth(reader))).body).toMatchObject({ idempotentReplay: true });
    const evidence = (await pool.query("SELECT topic_id FROM evidence_records WHERE subject_user_id=$1 AND evidence_type='LESSON_COMPLETION'", [reader])).rows;
    expect(evidence).toEqual([{ topic_id: firstPilot().topicId }]);
    // Switching back to English keeps the completion.
    expect((await choose(reader, { language: 'en' })).status).toBe(200);
    const state = await api().get('/api/v1/career-readiness/me').set(auth(reader)).expect(200);
    expect((state.body.progress as { lessonVersionId: string; state: string }[])).toEqual([expect.objectContaining({ lessonVersionId: firstPilot().id, state: 'COMPLETED' })]);
    expect((await choose(reader, { language: 'te' })).status).toBe(200);
  });

  it('is served with a notice once the English lesson is revised after it', async () => {
    const pilot = firstPilot();
    const started = await api().post(`${ops}/lessons/${pilot.id}/revisions`).set(auth(editor.userId)).send({ reasonCode: 'CONTENT_UPDATE' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const revisionId = started.body.lesson.open.id as string;
    const topicKey = fixture.topics.find((topic) => topic.id === pilot.topicId)!.stableKey;
    const saved = await api().post(`${ops}/revisions/${revisionId}/draft`).set(auth(editor.userId)).send({
      title: 'Synthetic revised English title', summary: 'Synthetic revised English summary.', moduleKey, topicKey, prerequisites: [],
      licenceLabel: 'AI8HT-Owned', basis: 'Synthetic basis', reasonCode: 'DRAFT_EDIT',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect((await transition(editor, revisionId, { toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' })).status).toBe(201);
    // An English revision takes no language review code.
    expect((await transition(reviewer, revisionId, approveBody({ languageReviewCode: 'NATIVE_SPEAKER_REVIEWED' }))).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await transition(reviewer, revisionId, approveBody())).status).toBe(201);
    expect((await api().post(`${ops}/revisions/${revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'LESSON_REVISION' })).status).toBe(201);

    const served = await servedOf(reader, pilot.stableKey);
    expect(served).toMatchObject({ version: 2, title: TELUGU.title, language: 'te', languageNotice: 'TRANSLATION_OUTDATED' });
    expect(served.id).not.toBe(pilot.id);
    expect(await servedOf(englishReader, pilot.stableKey)).toMatchObject({ version: 2, title: 'Synthetic revised English title', languageNotice: null });
  });

  it('is no longer served once archived: the lesson falls back to English with a notice', async () => {
    const archived = await api().post(`${ops}/lessons/${variant.lessonId}/archive`).set(auth(publisher.userId)).send({ reasonCode: 'OUT_OF_DATE' });
    expect(archived.status, JSON.stringify(archived.body)).toBe(201);
    expect(await servedOf(reader, firstPilot().stableKey)).toMatchObject({ language: 'en', languageNotice: 'TRANSLATION_MISSING', title: 'Synthetic revised English title' });
    // Telugu stays offered: it is the pilot's second language.
    expect((await learner(reader)).lessonLanguage.offered.map((option) => option.language)).toEqual(['en', 'te']);
  });
});

describe('languages beyond Telugu', () => {
  it('are offered once something is published in them, and lesson titles on the learning step follow the choice', async () => {
    const tamil = await draftVariant(secondPilot().id, 'ta', { title: 'Synthetic Tamil title', summary: 'Synthetic Tamil summary.' });
    expect((await choose(englishReader, { language: 'ta' })).body.error.code).toBe('LESSON_LANGUAGE_NOT_OFFERED');
    await publishVariant(tamil.revisionId);
    expect((await learner(englishReader)).lessonLanguage.offered.map((option) => option.language)).toEqual(['en', 'te', 'ta']);
    expect((await choose(englishReader, { language: 'ta' })).status).toBe(200);
    const served = await servedOf(englishReader, secondPilot().stableKey);
    expect(served).toMatchObject({ title: 'Synthetic Tamil title', body: { summary: 'Synthetic Tamil summary.' }, language: 'ta', languageNotice: null });
    expect(served.body).not.toHaveProperty('practice');

    const rendered = await renderLessonVersions(pool, [secondPilot().id], 'ta');
    expect(rendered.get(secondPilot().id)).toMatchObject({ title: 'Synthetic Tamil title', language: 'ta' });
    expect((await renderLessonVersions(pool, [secondPilot().id], 'te')).get(secondPilot().id)).toMatchObject({ language: 'en', languageNotice: 'TRANSLATION_MISSING' });
  });
});
