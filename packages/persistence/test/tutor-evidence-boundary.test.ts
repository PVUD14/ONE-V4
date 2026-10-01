/**
 * ENG-22 acceptance: the tutor cannot write evidence. The tutor's code — the pure rules in
 * packages/tutoring, the request side (tutor-hints.ts), the job (tutor-hint-worker.ts) and the sandbox
 * set-up — is read here, and any write to the tables a person's record or a readiness band is built
 * from fails the build, as does any read of readiness. The behavioural half (a full request → job →
 * answer cycle leaves evidence and mastery to the existing answer path) is in the API's
 * tutor-hints.integration.spec.ts.
 */
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const persistenceSrc = new URL('../src/', import.meta.url);
const tutoringSrc = new URL('../../tutoring/src/', import.meta.url);

/** The record, mastery and readiness tables, and the planner's audit. */
const protectedTables = [
  'evidence_records', 'mastery_projections', 'learner_skill_state', 'learning_attempt_events', 'readiness_snapshots', 'readiness_factors',
  'learning_decisions', 'career_gap_snapshots', 'career_gap_items',
] as const;

async function tutorSources(): Promise<{ name: string; text: string }[]> {
  const persistence = ['tutor-hints.ts', 'tutor-hint-worker.ts', 'tutor-sandbox.ts', 'run-tutor-sandbox-consent.ts'];
  const files = [
    ...await Promise.all(persistence.map(async (name) => ({ name, text: await readFile(new URL(name, persistenceSrc), 'utf8') }))),
    ...await Promise.all((await readdir(tutoringSrc)).filter((name) => name.endsWith('.ts'))
      .map(async (name) => ({ name: `tutoring/${name}`, text: await readFile(new URL(name, tutoringSrc), 'utf8') }))),
  ];
  return files;
}

function writesTo(text: string, table: string): boolean {
  return new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+${table}\b`, 'iu').test(text);
}

describe('the tutor cannot write evidence', () => {
  it('no tutor source writes to a record, mastery, skill-state, attempt, readiness or planner table', async () => {
    const files = await tutorSources();
    expect(files.length).toBeGreaterThanOrEqual(8);
    const violations = files.flatMap(({ name, text }) => protectedTables.filter((table) => writesTo(text, table)).map((table) => `${name}: ${table}`));
    expect(violations).toEqual([]);
    // Nor through the ORM: the tutor writes with plain SQL only, so the scan above sees every write.
    expect(files.filter(({ text }) => /\.(?:insert|update|delete)\(\s*schema\./u.test(text)).map(({ name }) => name)).toEqual([]);
  });

  it('no tutor source reads readiness, and the pure rules touch no database at all', async () => {
    const files = await tutorSources();
    expect(files.filter(({ text }) => /readiness_snapshots|readiness_factors|career_gap_/u.test(text)).map(({ name }) => name)).toEqual([]);
    const pure = files.filter(({ name }) => name.startsWith('tutoring/'));
    expect(pure.length).toBeGreaterThanOrEqual(4);
    expect(pure.filter(({ text }) => /from 'pg'|drizzle-orm|@planthepath\/persistence/u.test(text)).map(({ name }) => name)).toEqual([]);
  });

  it('the one step-table write is the hint level, raised by one', async () => {
    const text = await readFile(new URL('learning-experience.ts', persistenceSrc), 'utf8');
    const tutorRequest = text.slice(text.indexOf('export async function requestStepTutorHint'), text.indexOf('export async function answerStepQuestion'));
    expect(tutorRequest.length).toBeGreaterThan(200);
    const writes = [...tutorRequest.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/giu)].map((match) => match[0].replace(/\s+/gu, ' '));
    expect(writes).toEqual(['UPDATE learning_step_items']);
    expect(tutorRequest).toMatch(/SET hint_level = hint_level \+ 1/u);
  });

  it('the scan would catch a tutor that wrote evidence', () => {
    expect(writesTo("await db.execute(sql`INSERT INTO evidence_records (id) VALUES (1)`)", 'evidence_records')).toBe(true);
    expect(writesTo('UPDATE learner_skill_state SET evidence_band = 1', 'learner_skill_state')).toBe(true);
    expect(writesTo('SELECT * FROM evidence_records', 'evidence_records')).toBe(false);
  });
});
