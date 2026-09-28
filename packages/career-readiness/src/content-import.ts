/**
 * Content bulk import — the file rules, pure (OPS-09d).
 *
 * Why this exists: an operator uploads a CSV or JSON file of skills, questions, lessons or lesson
 * variants. These functions parse the file, refuse unknown columns and fields, enforce the caps,
 * and turn each row into the typed input the editors' own functions take (OPS-09a–c) — with row
 * issues, never exceptions, for anything a row gets wrong. They decide nothing the editors decide:
 * key uniqueness, text limits, prerequisite cycles and references are checked by running the rows
 * through the editors (packages/persistence/src/content-import.ts). The digest binds a commit to
 * the preview the uploader saw.
 *
 * Nothing here is a score, and the report never echoes a row's text (so never an answer key).
 *
 * Design: docs/architecture/content-bulk-import-design.md
 */
import { sha256Hex, stableStringify } from './index.js';
import { QUESTION_DIFFICULTIES, QUESTION_OPTION_IDS, type QuestionDifficulty, type QuestionDraftFields } from './question-bank.js';
import {
  isLessonLanguage,
  isLessonLevel,
  isLessonStyle,
  type LessonDraftFields,
  type LessonVariantMetadata,
} from './lesson-editor.js';
import { SKILL_LEVELS, SKILL_LICENCES, type SkillDraftFields, type SkillLicence } from './skill-map.js';

export const CONTENT_IMPORT_KINDS = ['SKILL', 'QUESTION', 'LESSON', 'LESSON_VARIANT'] as const;
export type ContentImportKind = (typeof CONTENT_IMPORT_KINDS)[number];
export const CONTENT_IMPORT_FORMATS = ['CSV', 'JSON'] as const;
export type ContentImportFormat = (typeof CONTENT_IMPORT_FORMATS)[number];

/** Rows per file. Keeps the evaluation (run at preview and again at commit) inside one request. */
export const CONTENT_IMPORT_MAX_ROWS = 200;
/** Characters per file; the API's 100 KB JSON body limit is the outer bound. */
export const CONTENT_IMPORT_MAX_CHARACTERS = 90_000;
export const CONTENT_IMPORT_FILENAME_MAX = 160;

const optionColumns = QUESTION_OPTION_IDS.map((id) => `option_${id}`);
const misconceptionColumns = QUESTION_OPTION_IDS.map((id) => `misconception_${id}`);
const rationaleColumns = QUESTION_OPTION_IDS.map((id) => `rationale_${id}`);
const rightsColumns = ['licence', 'attribution', 'basis'];

/** The fields of each kind, the same in CSV (as columns) and JSON (as keys). */
export const CONTENT_IMPORT_COLUMNS: Readonly<Record<ContentImportKind, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  SKILL: {
    required: ['stable_key', 'name', 'description'],
    optional: ['level_aware', 'level_guided', 'level_independent', 'level_troubleshoot', 'prerequisites', ...rightsColumns],
  },
  QUESTION: {
    required: ['stable_key', 'skill_key', 'prompt'],
    optional: [...optionColumns, 'correct_option', 'explanation', 'difficulty', 'hint_1', 'hint_2', 'hint_3', 'hint_4',
      ...misconceptionColumns, ...rationaleColumns, ...rightsColumns],
  },
  LESSON: {
    required: ['stable_key', 'title', 'level', 'style'],
    optional: ['summary', 'practice', 'module_key', 'skill_key', 'prerequisites', ...rightsColumns],
  },
  LESSON_VARIANT: {
    required: ['base_lesson_key', 'language', 'level', 'style', 'title'],
    optional: ['summary', 'practice', ...rightsColumns],
  },
};

export function isContentImportKind(value: unknown): value is ContentImportKind {
  return typeof value === 'string' && (CONTENT_IMPORT_KINDS as readonly string[]).includes(value);
}
export function isContentImportFormat(value: unknown): value is ContentImportFormat {
  return typeof value === 'string' && (CONTENT_IMPORT_FORMATS as readonly string[]).includes(value);
}

/** One row as read from the file: its values by field, and what is already wrong with it. */
export interface ContentImportRawRow {
  readonly rowNumber: number;
  readonly values: Readonly<Record<string, string>>;
  readonly issues: readonly string[];
}

export interface ContentImportParsed {
  readonly kind: ContentImportKind;
  readonly format: ContentImportFormat;
  /** Problems with the whole file (size, header, shape). Any one means nothing can be committed. */
  readonly fileProblems: readonly string[];
  readonly rows: readonly ContentImportRawRow[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks. Null when a quote is left open. */
export function parseCsvRecords(text: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && !fieldStarted) { quoted = true; fieldStarted = true; continue; }
    if (char === ',') { record.push(field); field = ''; fieldStarted = false; continue; }
    if (char === '\r' && text[index + 1] === '\n') continue;
    if (char === '\n' || char === '\r') { record.push(field); records.push(record); record = []; field = ''; fieldStarted = false; continue; }
    field += char;
    fieldStarted = true;
  }
  if (quoted) return null;
  if (fieldStarted || field || record.length) { record.push(field); records.push(record); }
  return records;
}

const blankRecord = (record: readonly string[]): boolean => record.every((cell) => !cell.trim());

function rowIssues(kind: ContentImportKind, values: Record<string, string>): string[] {
  return CONTENT_IMPORT_COLUMNS[kind].required.filter((column) => !values[column]).map((column) => `IMPORT_FIELD_REQUIRED:${column}`);
}

function parseCsv(kind: ContentImportKind, content: string): { fileProblems: string[]; rows: ContentImportRawRow[] } {
  const records = parseCsvRecords(content);
  if (!records) return { fileProblems: ['IMPORT_CSV_UNTERMINATED_QUOTE'], rows: [] };
  const [headerRecord, ...body] = records.filter((record) => !blankRecord(record));
  if (!headerRecord) return { fileProblems: ['IMPORT_FILE_EMPTY'], rows: [] };
  const header = headerRecord.map((cell) => cell.trim().toLowerCase());
  const { required, optional } = CONTENT_IMPORT_COLUMNS[kind];
  const known = new Set([...required, ...optional]);
  const problems: string[] = [];
  header.forEach((column, index) => {
    if (!column) problems.push('IMPORT_COLUMN_BLANK');
    else if (!known.has(column)) problems.push(`IMPORT_COLUMN_UNKNOWN:${column.slice(0, 64)}`);
    else if (header.indexOf(column) !== index) problems.push(`IMPORT_COLUMN_DUPLICATE:${column}`);
  });
  for (const column of required) if (!header.includes(column)) problems.push(`IMPORT_COLUMN_MISSING:${column}`);
  if (problems.length) return { fileProblems: [...new Set(problems)], rows: [] };
  const rows = body.map((record, index): ContentImportRawRow => {
    const values: Record<string, string> = {};
    header.forEach((column, at) => { values[column] = (record[at] ?? '').trim(); });
    const issues = record.length > header.length && !blankRecord(record.slice(header.length)) ? ['IMPORT_ROW_TOO_MANY_CELLS'] : [];
    return { rowNumber: index + 2, values, issues: [...issues, ...rowIssues(kind, values)] };
  });
  return { fileProblems: [], rows };
}

function parseJson(kind: ContentImportKind, content: string): { fileProblems: string[]; rows: ContentImportRawRow[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { fileProblems: ['IMPORT_JSON_INVALID'], rows: [] };
  }
  if (!Array.isArray(parsed)) return { fileProblems: ['IMPORT_JSON_NOT_A_LIST'], rows: [] };
  const { required, optional } = CONTENT_IMPORT_COLUMNS[kind];
  const known = new Set([...required, ...optional]);
  const rows = parsed.map((entry, index): ContentImportRawRow => {
    const rowNumber = index + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { rowNumber, values: {}, issues: ['IMPORT_ROW_NOT_AN_OBJECT'] };
    const issues: string[] = [];
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!known.has(key)) { issues.push(`IMPORT_FIELD_UNKNOWN:${key.slice(0, 64)}`); continue; }
      if (value === null || value === undefined) { values[key] = ''; continue; }
      if (key === 'prerequisites' && Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        values[key] = (value as string[]).map((item) => item.trim()).join(';');
        continue;
      }
      if (typeof value !== 'string') { issues.push(`IMPORT_FIELD_NOT_TEXT:${key}`); continue; }
      values[key] = value.trim();
    }
    return { rowNumber, values, issues: [...issues, ...rowIssues(kind, values)] };
  });
  return { fileProblems: [], rows };
}

/** Where a row points in the file's own terms: its key (a variant: base key and variant triple). */
export function contentImportRowKey(kind: ContentImportKind, values: Readonly<Record<string, string>>): string {
  if (kind === 'LESSON_VARIANT') {
    const base = values.base_lesson_key ?? '';
    return base ? `${base}:${values.language ?? ''}/${values.level ?? ''}/${values.style ?? ''}` : '';
  }
  return values.stable_key ?? '';
}

/**
 * Parse a file of one kind. Whole-file problems (size, row count, header, JSON shape) are
 * `fileProblems`; everything else is an issue on its row. Rows repeating a key are all marked.
 */
export function parseContentImportFile(kind: ContentImportKind, format: ContentImportFormat, content: string): ContentImportParsed {
  if (content.length > CONTENT_IMPORT_MAX_CHARACTERS) return { kind, format, fileProblems: ['IMPORT_FILE_TOO_LARGE'], rows: [] };
  const text = content.replace(/^﻿/, '');
  if (!text.trim()) return { kind, format, fileProblems: ['IMPORT_FILE_EMPTY'], rows: [] };
  const { fileProblems, rows } = format === 'CSV' ? parseCsv(kind, text) : parseJson(kind, text);
  if (fileProblems.length) return { kind, format, fileProblems, rows: [] };
  if (!rows.length) return { kind, format, fileProblems: ['IMPORT_FILE_EMPTY'], rows: [] };
  if (rows.length > CONTENT_IMPORT_MAX_ROWS) return { kind, format, fileProblems: ['IMPORT_TOO_MANY_ROWS'], rows: [] };
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = contentImportRowKey(kind, row.values).toLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateCode = kind === 'LESSON_VARIANT' ? 'IMPORT_VARIANT_DUPLICATE' : 'IMPORT_KEY_DUPLICATE';
  return {
    kind, format, fileProblems: [],
    rows: rows.map((row) => {
      const key = contentImportRowKey(kind, row.values).toLowerCase();
      return key && (counts.get(key) ?? 0) > 1 ? { ...row, issues: [...row.issues, duplicateCode] } : row;
    }),
  };
}

// ---------------------------------------------------------------------------
// Rows → editor input
// ---------------------------------------------------------------------------

const orNull = (value: string | undefined): string | null => (value ? value : null);

function readLicence(values: Readonly<Record<string, string>>, issues: string[]): SkillLicence | null {
  const licence = values.licence ?? '';
  if (!licence) return null;
  if (!(SKILL_LICENCES as readonly string[]).includes(licence)) { issues.push('IMPORT_LICENCE_UNKNOWN'); return null; }
  return licence as SkillLicence;
}

/** `a;b;c` → keys, lower-cased; blanks dropped. */
export function readImportKeyList(value: string | undefined): readonly string[] {
  return (value ?? '').split(';').map((key) => key.trim().toLowerCase()).filter(Boolean);
}

export interface SkillImportInput {
  readonly stableKey: string;
  readonly name: string;
  readonly description: string;
  readonly fields: SkillDraftFields;
}

export function skillImportInput(values: Readonly<Record<string, string>>): { readonly input: SkillImportInput; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const name = values.name ?? '';
  const description = values.description ?? '';
  const licenceLabel = readLicence(values, issues);
  const levels = Object.fromEntries(SKILL_LEVELS.map((level) => [level, values[`level_${level.toLowerCase()}`] ?? ''])) as SkillDraftFields['levels'];
  return {
    input: {
      stableKey: (values.stable_key ?? '').toLowerCase(), name, description,
      fields: {
        name, description, levels, prerequisites: readImportKeyList(values.prerequisites), licenceLabel,
        attribution: orNull(values.attribution), basis: orNull(values.basis),
      },
    },
    issues,
  };
}

export interface QuestionImportInput {
  readonly stableKey: string;
  readonly topicKey: string;
  readonly prompt: string;
  /** Everything but the skill tag (a key here) and the misconception ids (codes here, resolved by the importer). */
  readonly fields: Omit<QuestionDraftFields, 'topicId' | 'options'>;
  readonly options: readonly { readonly id: string; readonly text: string; readonly misconception: { readonly code: string; readonly rationale: string } | null }[];
}

export function questionImportInput(values: Readonly<Record<string, string>>): { readonly input: QuestionImportInput; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const options: { id: string; text: string; misconception: { code: string; rationale: string } | null }[] = [];
  let gap = false;
  for (const id of QUESTION_OPTION_IDS) {
    const text = values[`option_${id}`] ?? '';
    const code = (values[`misconception_${id}`] ?? '').toUpperCase();
    const rationale = values[`rationale_${id}`] ?? '';
    if (!text) {
      if (code) issues.push(`IMPORT_MISCONCEPTION_WITHOUT_OPTION:${id}`);
      else if (rationale) issues.push(`IMPORT_RATIONALE_WITHOUT_MISCONCEPTION:${id}`);
      gap = true;
      continue;
    }
    if (gap) issues.push('IMPORT_OPTIONS_NOT_CONSECUTIVE');
    if (!code && rationale) issues.push(`IMPORT_RATIONALE_WITHOUT_MISCONCEPTION:${id}`);
    options.push({ id, text, misconception: code ? { code, rationale } : null });
  }
  const correct = (values.correct_option ?? '').toLowerCase();
  if (correct && !(QUESTION_OPTION_IDS as readonly string[]).includes(correct)) issues.push('IMPORT_CORRECT_OPTION_INVALID');
  const difficultyRaw = (values.difficulty ?? '').toUpperCase();
  const difficulty = difficultyRaw && (QUESTION_DIFFICULTIES as readonly string[]).includes(difficultyRaw) ? difficultyRaw as QuestionDifficulty : null;
  if (difficultyRaw && !difficulty) issues.push('IMPORT_DIFFICULTY_UNKNOWN');
  const licenceLabel = readLicence(values, issues);
  return {
    input: {
      stableKey: (values.stable_key ?? '').toLowerCase(),
      topicKey: (values.skill_key ?? '').toLowerCase(),
      prompt: values.prompt ?? '',
      options,
      fields: {
        prompt: values.prompt ?? '',
        correctOptionId: correct && (QUESTION_OPTION_IDS as readonly string[]).includes(correct) ? correct : null,
        explanation: orNull(values.explanation),
        difficulty,
        hints: [values.hint_1 ?? '', values.hint_2 ?? '', values.hint_3 ?? '', values.hint_4 ?? ''],
        licenceLabel,
        attribution: orNull(values.attribution),
        basis: orNull(values.basis),
      },
    },
    issues: [...new Set(issues)],
  };
}

export interface LessonImportInput {
  readonly stableKey: string;
  readonly title: string;
  readonly level: LessonVariantMetadata['level'];
  readonly style: LessonVariantMetadata['style'];
  readonly topicKey: string | null;
  readonly fields: Omit<LessonDraftFields, 'topicId'>;
}

function readLevelAndStyle(values: Readonly<Record<string, string>>, issues: string[]): { level: LessonVariantMetadata['level']; style: LessonVariantMetadata['style'] } {
  const level = (values.level ?? '').toUpperCase();
  const style = (values.style ?? '').toUpperCase();
  if (level && !isLessonLevel(level)) issues.push('IMPORT_LEVEL_UNKNOWN');
  if (style && !isLessonStyle(style)) issues.push('IMPORT_STYLE_UNKNOWN');
  return { level: isLessonLevel(level) ? level : 'STANDARD', style: isLessonStyle(style) ? style : 'EXPLANATION' };
}

export function lessonImportInput(values: Readonly<Record<string, string>>): { readonly input: LessonImportInput; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const { level, style } = readLevelAndStyle(values, issues);
  const title = values.title ?? '';
  const licenceLabel = readLicence(values, issues);
  return {
    input: {
      stableKey: (values.stable_key ?? '').toLowerCase(), title, level, style,
      topicKey: orNull((values.skill_key ?? '').toLowerCase()),
      fields: {
        title, summary: values.summary ?? '', practice: orNull(values.practice),
        moduleKey: orNull((values.module_key ?? '').toLowerCase()),
        prerequisites: readImportKeyList(values.prerequisites), licenceLabel,
        attribution: orNull(values.attribution), basis: orNull(values.basis),
      },
    },
    issues,
  };
}

export interface LessonVariantImportInput {
  readonly baseLessonKey: string;
  readonly variant: LessonVariantMetadata;
  readonly title: string;
  readonly fields: Omit<LessonDraftFields, 'topicId'>;
}

export function lessonVariantImportInput(values: Readonly<Record<string, string>>): { readonly input: LessonVariantImportInput; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const { level, style } = readLevelAndStyle(values, issues);
  const language = (values.language ?? '').toLowerCase();
  if (language && !isLessonLanguage(language)) issues.push('IMPORT_LANGUAGE_UNKNOWN');
  const title = values.title ?? '';
  const licenceLabel = readLicence(values, issues);
  return {
    input: {
      baseLessonKey: (values.base_lesson_key ?? '').toLowerCase(),
      variant: { language: isLessonLanguage(language) ? language : 'en', level, style },
      title,
      fields: {
        title, summary: values.summary ?? '', practice: orNull(values.practice), moduleKey: null, prerequisites: [], licenceLabel,
        attribution: orNull(values.attribution), basis: orNull(values.basis),
      },
    },
    issues,
  };
}

/**
 * Prerequisite order within the file: every row after the file's rows it requires, ties in file
 * order. A cycle is left in file order; the editor's acyclic check then refuses it on save.
 */
export function importPrerequisiteOrder<T extends { readonly key: string; readonly prerequisites: readonly string[] }>(rows: readonly T[]): readonly T[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const state = new Map<string, 'visiting' | 'done'>();
  const ordered: T[] = [];
  const visit = (row: T): void => {
    if (state.get(row.key)) return;
    state.set(row.key, 'visiting');
    for (const required of row.prerequisites) {
      const dependency = byKey.get(required);
      if (dependency && state.get(required) === undefined) visit(dependency);
    }
    state.set(row.key, 'done');
    ordered.push(row);
  };
  for (const row of rows) visit(row);
  return ordered;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type ContentImportRowOutcome = 'CREATE' | 'INVALID';

/** What the uploader sees for one row: never the row's text. */
export interface ContentImportRowReport {
  readonly rowNumber: number;
  readonly key: string;
  readonly outcome: ContentImportRowOutcome;
  readonly issues: readonly string[];
}

export interface ContentImportReport {
  readonly kind: ContentImportKind;
  readonly format: ContentImportFormat;
  readonly digest: string;
  readonly rowCount: number;
  readonly counts: { readonly create: number; readonly invalid: number };
  readonly fileProblems: readonly string[];
  readonly rows: readonly ContentImportRowReport[];
}

/**
 * The report and its digest. The digest covers the kind, format, every row's normalised values and
 * every row's outcome and issues, so a commit is refused unless the file and what the editors make
 * of it are exactly what was previewed.
 */
export function contentImportReport(parsed: ContentImportParsed, issuesByRow: ReadonlyMap<number, readonly string[]>): ContentImportReport {
  const rows = parsed.rows.map((row): ContentImportRowReport => {
    const issues = [...new Set([...row.issues, ...(issuesByRow.get(row.rowNumber) ?? [])])];
    return { rowNumber: row.rowNumber, key: contentImportRowKey(parsed.kind, row.values).slice(0, 200), outcome: issues.length ? 'INVALID' : 'CREATE', issues };
  });
  const digest = sha256Hex(stableStringify({
    kind: parsed.kind, format: parsed.format, fileProblems: parsed.fileProblems,
    rows: parsed.rows.map((row) => row.values),
    results: rows.map((row) => [row.rowNumber, row.outcome, row.issues]),
  }));
  const invalid = rows.filter((row) => row.outcome === 'INVALID').length;
  return {
    kind: parsed.kind, format: parsed.format, digest, rowCount: rows.length,
    counts: { create: rows.length - invalid, invalid }, fileProblems: parsed.fileProblems, rows,
  };
}

/** Whether a report may be committed: no file problem, at least one row, and no invalid row. */
export function contentImportCommittable(report: ContentImportReport): boolean {
  return report.fileProblems.length === 0 && report.rowCount > 0 && report.counts.invalid === 0;
}
