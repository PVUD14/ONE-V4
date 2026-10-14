/**
 * Content bulk import (OPS-09d): a CSV or JSON file of skills, questions, lessons or lesson
 * variants, previewed and then committed, every row landing as a DRAFT authored by the importer.
 *
 * Why this exists: verified tracks need content in volume, and until now only an engineer-run
 * import pack could create it in bulk. This is the operator's path, and it is built on the
 * editors rather than beside them: every row is created and saved by the same functions a single
 * edit uses (createSkill/saveSkillDraft, createQuestion/saveQuestionDraft, createLesson,
 * createLessonVariant/saveLessonDraft), so every validation, the acyclic prerequisite check, the
 * provenance rules and the editors' audit rows apply unchanged — and because the importer is the
 * author of every revision, the editors' contributor rule keeps them from reviewing or publishing
 * what they imported. Nothing here moves a revision out of DRAFT.
 *
 * Preview and commit are one evaluation in a transaction (each row in its own savepoint, so one bad
 * row does not hide the next). The preview is always rolled back; the commit keeps its work only
 * when no row is invalid and the report's digest equals the one the uploader previewed. A refused
 * commit writes nothing at all.
 *
 * Design: docs/architecture/content-bulk-import-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  contentImportCommittable,
  contentImportReport,
  importPrerequisiteOrder,
  lessonImportInput,
  lessonVariantImportInput,
  questionImportInput,
  skillImportInput,
  type ContentImportParsed,
  type ContentImportRawRow,
  type ContentImportReport,
} from '@planthepath/career-readiness';
import { createLesson, createLessonVariant, LessonEditorError, LessonEditorRefused, saveLessonDraft } from './lesson-editor.js';
import { createQuestion, QuestionBankError, QuestionBankRefused, saveQuestionDraft } from './question-bank.js';
import { validateAuditWriteInput } from './repositories.js';
import { createSkill, saveSkillDraft, SkillMapError, SkillMapRefused, type SqlRunner, type TransactionalRunner } from './skill-map.js';

// The file rules, for callers (the API) that do not depend on packages/career-readiness directly.
export {
  CONTENT_IMPORT_COLUMNS,
  CONTENT_IMPORT_FILENAME_MAX,
  CONTENT_IMPORT_FORMATS,
  CONTENT_IMPORT_KINDS,
  CONTENT_IMPORT_MAX_CHARACTERS,
  CONTENT_IMPORT_MAX_ROWS,
  isContentImportFormat,
  isContentImportKind,
  parseContentImportFile,
  type ContentImportFormat,
  type ContentImportKind,
  type ContentImportParsed,
  type ContentImportReport,
} from '@planthepath/career-readiness';

type Rows<T> = { rows: T[] };
async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

/** Who imports, and whether through the super admin's break-glass (§5.1: audited as such). */
export interface ContentImportActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

export type ContentImportRefusal = 'IMPORT_FILE_INVALID' | 'IMPORT_HAS_INVALID_ROWS' | 'IMPORT_STALE';

/** A commit refused as a whole; nothing was written. Carries the fresh report for the screen. */
export class ContentImportRejected extends Error {
  constructor(readonly code: ContentImportRefusal, readonly report: ContentImportReport) {
    super(code);
    this.name = 'ContentImportRejected';
  }
}

/** A row's own problem found while evaluating it; rolls back only that row's savepoint. */
class RowIssues extends Error {
  constructor(readonly issues: readonly string[]) {
    super('row issues');
    this.name = 'RowIssues';
  }
}

/** Ends an evaluation that must not persist (a preview, or a commit that is refused). */
class Rollback extends Error {
  constructor() {
    super('rollback');
    this.name = 'Rollback';
  }
}

/** The editors' refusals as the codes they already show; anything else as one safe code. */
function issuesOf(error: unknown): readonly string[] {
  if (error instanceof RowIssues) return error.issues;
  if (error instanceof SkillMapError || error instanceof QuestionBankError || error instanceof LessonEditorError) {
    return error.problems.length ? error.problems : [error.code];
  }
  if (error instanceof SkillMapRefused || error instanceof QuestionBankRefused || error instanceof LessonEditorRefused) return [error.code];
  return ['IMPORT_ROW_REJECTED'];
}

interface Evaluation {
  readonly report: ContentImportReport;
  readonly createdKeys: readonly string[];
}

/**
 * Run every row through its editor inside `tx`. Each row (and, for skills and lessons, each of
 * its two steps) runs in a savepoint: a failure rolls back that row only and becomes its issues.
 */
async function evaluate(tx: TransactionalRunner, parsed: ContentImportParsed, reasonCode: string, actor: ContentImportActor): Promise<Evaluation> {
  const found = new Map<number, string[]>();
  const add = (rowNumber: number, issues: readonly string[]): void => { found.set(rowNumber, [...(found.get(rowNumber) ?? []), ...issues]); };
  const attempt = async (rowNumber: number, work: (runner: TransactionalRunner) => Promise<void>): Promise<boolean> => {
    try {
      await tx.transaction(async (savepoint) => { await work(savepoint as TransactionalRunner); });
      return true;
    } catch (error) {
      add(rowNumber, issuesOf(error));
      return false;
    }
  };
  // Rows the parser already refused (a missing required field, an unknown field) are not evaluated.
  const evaluable = parsed.rows.filter((row) => row.issues.length === 0);

  if (parsed.kind === 'SKILL') {
    const created: { readonly row: ContentImportRawRow; readonly key: string; readonly prerequisites: readonly string[]; readonly revisionId: string; readonly fields: ReturnType<typeof skillImportInput>['input']['fields'] }[] = [];
    for (const row of evaluable) {
      const { input, issues } = skillImportInput(row.values);
      add(row.rowNumber, issues);
      let revisionId = '';
      const ok = await attempt(row.rowNumber, async (runner) => {
        revisionId = (await createSkill(runner, { stableKey: input.stableKey, name: input.name, description: input.description, reasonCode, actor })).revisionId;
      });
      if (ok) created.push({ row, key: input.stableKey, prerequisites: input.fields.prerequisites, revisionId, fields: input.fields });
    }
    // Saved in prerequisite order within the file, so the editor's acyclic check runs on each.
    for (const entry of importPrerequisiteOrder(created)) {
      await attempt(entry.row.rowNumber, async (runner) => { await saveSkillDraft(runner, { revisionId: entry.revisionId, fields: entry.fields, actor }); });
    }
  } else if (parsed.kind === 'LESSON') {
    const created: { readonly row: ContentImportRawRow; readonly key: string; readonly prerequisites: readonly string[]; readonly revisionId: string; readonly input: ReturnType<typeof lessonImportInput>['input'] }[] = [];
    for (const row of evaluable) {
      const { input, issues } = lessonImportInput(row.values);
      add(row.rowNumber, issues);
      let revisionId = '';
      const ok = await attempt(row.rowNumber, async (runner) => {
        revisionId = (await createLesson(runner, { stableKey: input.stableKey, title: input.title, level: input.level, style: input.style, reasonCode, actor })).revisionId;
      });
      if (ok) created.push({ row, key: input.stableKey, prerequisites: input.fields.prerequisites, revisionId, input });
    }
    for (const entry of importPrerequisiteOrder(created)) {
      await attempt(entry.row.rowNumber, async (runner) => {
        await saveLessonDraft(runner, { revisionId: entry.revisionId, draft: { ...entry.input.fields, topicKey: entry.input.topicKey }, actor });
      });
    }
  } else if (parsed.kind === 'QUESTION') {
    for (const row of evaluable) {
      const { input, issues } = questionImportInput(row.values);
      add(row.rowNumber, issues);
      await attempt(row.rowNumber, async (runner) => {
        const options = [];
        const unknown: string[] = [];
        for (const option of input.options) {
          if (!option.misconception) { options.push({ id: option.id, text: option.text, misconception: null }); continue; }
          // A code names its latest version that is not archived; the editor then checks it is on this question's skill.
          const [code] = await rows<{ id: string }>(runner, sql`
            SELECT id FROM misconception_codes WHERE code = ${option.misconception.code} AND review_state <> 'ARCHIVED' ORDER BY version DESC LIMIT 1
          `);
          if (!code) { unknown.push(`IMPORT_MISCONCEPTION_UNKNOWN:${option.id}`); continue; }
          options.push({ id: option.id, text: option.text, misconception: { codeId: code.id, rationale: option.misconception.rationale } });
        }
        if (unknown.length) throw new RowIssues(unknown);
        const created = await createQuestion(runner, { stableKey: input.stableKey, topicKey: input.topicKey, prompt: input.prompt, reasonCode, actor });
        await saveQuestionDraft(runner, { revisionId: created.revisionId, draft: { ...input.fields, options, topicKey: input.topicKey }, actor });
      });
    }
  } else {
    for (const row of evaluable) {
      const { input, issues } = lessonVariantImportInput(row.values);
      add(row.rowNumber, issues);
      await attempt(row.rowNumber, async (runner) => {
        const [base] = await rows<{ entity_id: string }>(runner, sql`
          SELECT entity_id FROM content_revisions
          WHERE entity_type = 'LESSON' AND body ->> 'stableKey' = ${input.baseLessonKey} AND COALESCE(body ->> 'variantOf', '') = ''
          ORDER BY revision DESC LIMIT 1
        `);
        if (!base) throw new RowIssues(['IMPORT_BASE_LESSON_UNKNOWN']);
        const created = await createLessonVariant(runner, { baseLessonId: base.entity_id, variant: input.variant, title: input.title, reasonCode, actor });
        await saveLessonDraft(runner, { revisionId: created.revisionId, draft: { ...input.fields, topicKey: null }, actor });
      });
    }
  }

  const report = contentImportReport(parsed, found);
  return { report, createdKeys: report.rows.filter((row) => row.outcome === 'CREATE').map((row) => row.key) };
}

async function audit(runner: SqlRunner, input: {
  readonly actor: ContentImportActor; readonly action: string; readonly resourceId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actor.userId, action: input.action, resourceType: 'content_import', resourceId: input.resourceId, correlationId: input.actor.correlationId });
  const context = { ...input.context, ...(input.actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actor.userId}::uuid, ${input.action}, 'content_import', ${input.resourceId}, NULL, 'SUCCESS',
            ${input.actor.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}

/** One import at a time: two uploads naming the same keys queue rather than race. */
async function lockImports(tx: SqlRunner): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('operations-content-import'))`);
}

/**
 * The validation report for a file. The rows go through the editors in a transaction that is
 * always rolled back; the one write is the preview's audit row, after it. Answer keys and row text
 * appear nowhere in the report or the audit row.
 */
export async function previewContentImport(db: TransactionalRunner, input: {
  readonly parsed: ContentImportParsed; readonly filename: string; readonly actor: ContentImportActor;
}): Promise<ContentImportReport> {
  let report: ContentImportReport = contentImportReport(input.parsed, new Map());
  if (!input.parsed.fileProblems.length) {
    try {
      await db.transaction(async (tx) => {
        await lockImports(tx);
        report = (await evaluate(tx as TransactionalRunner, input.parsed, 'TRACK_BUILD', input.actor)).report;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }
  await audit(db, {
    actor: input.actor, action: 'operations.content.import_previewed', resourceId: report.digest,
    context: {
      kind: report.kind, format: report.format, filename: input.filename, rowCount: report.rowCount, counts: report.counts,
      fileProblemCount: report.fileProblems.length, digest: report.digest,
    },
  });
  return report;
}

/**
 * Commit exactly the previewed file: all rows or none. Refused (and nothing written, not even an
 * audit row) when the file has a problem, any row is invalid, or the evaluation no longer matches
 * the digest the uploader saw.
 */
export async function commitContentImport(db: TransactionalRunner, input: {
  readonly parsed: ContentImportParsed; readonly filename: string; readonly previewDigest: string; readonly reasonCode: string;
  readonly actor: ContentImportActor;
}): Promise<{ readonly reference: string; readonly report: ContentImportReport; readonly createdKeys: readonly string[] }> {
  if (input.parsed.fileProblems.length) throw new ContentImportRejected('IMPORT_FILE_INVALID', contentImportReport(input.parsed, new Map()));
  const reference = randomUUID();
  let refusal = null as ContentImportRejected | null;
  try {
    return await db.transaction(async (tx) => {
      await lockImports(tx);
      const { report, createdKeys } = await evaluate(tx as TransactionalRunner, input.parsed, input.reasonCode, input.actor);
      if (!contentImportCommittable(report)) { refusal = new ContentImportRejected('IMPORT_HAS_INVALID_ROWS', report); throw new Rollback(); }
      if (report.digest !== input.previewDigest) { refusal = new ContentImportRejected('IMPORT_STALE', report); throw new Rollback(); }
      await audit(tx, {
        actor: input.actor, action: 'operations.content.import_committed', resourceId: reference,
        context: {
          kind: report.kind, format: report.format, filename: input.filename, digest: report.digest, reasonCode: input.reasonCode,
          created: createdKeys.length, keys: createdKeys,
        },
      });
      return { reference, report, createdKeys };
    });
  } catch (error) {
    if (error instanceof Rollback && refusal) throw refusal;
    throw error;
  }
}
