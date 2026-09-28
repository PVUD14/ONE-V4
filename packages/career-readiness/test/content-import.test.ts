/**
 * Content bulk import file rules (OPS-09d): CSV and JSON parsing, refusal of unknown columns and
 * fields, the caps, row-level issues, the typed editor input each kind produces, prerequisite
 * order within a file, and a digest that changes with the file or with what the editors made of it.
 * The report never carries a row's text. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_IMPORT_MAX_CHARACTERS,
  CONTENT_IMPORT_MAX_ROWS,
  contentImportCommittable,
  contentImportReport,
  importPrerequisiteOrder,
  lessonImportInput,
  lessonVariantImportInput,
  parseContentImportFile,
  parseCsvRecords,
  questionImportInput,
  skillImportInput,
} from '../src/index.js';

describe('CSV records', () => {
  it('reads quoted fields holding commas, doubled quotes and line breaks', () => {
    expect(parseCsvRecords('a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  });

  it('reports an unterminated quote as unreadable', () => {
    expect(parseCsvRecords('a,b\n"open,1\n')).toBeNull();
  });
});

describe('parsing a file', () => {
  it('reads a skill CSV into rows numbered as a spreadsheet shows them', () => {
    const parsed = parseContentImportFile('SKILL', 'CSV', '﻿stable_key,name,description,prerequisites\nsyn-one,One,First,\n\nsyn-two,Two,Second,syn-one\n');
    expect(parsed.fileProblems).toEqual([]);
    expect(parsed.rows.map((row) => [row.rowNumber, row.values.stable_key, row.issues])).toEqual([[2, 'syn-one', []], [3, 'syn-two', []]]);
  });

  it('refuses unknown, duplicated and missing columns as file problems', () => {
    expect(parseContentImportFile('SKILL', 'CSV', 'stable_key,name,description,score\nsyn-a,A,B,9\n').fileProblems).toEqual(['IMPORT_COLUMN_UNKNOWN:score']);
    expect(parseContentImportFile('SKILL', 'CSV', 'stable_key,name,name,description\nsyn-a,A,A,B\n').fileProblems).toEqual(['IMPORT_COLUMN_DUPLICATE:name']);
    expect(parseContentImportFile('QUESTION', 'CSV', 'stable_key,prompt\nsyn-q,Q\n').fileProblems).toEqual(['IMPORT_COLUMN_MISSING:skill_key']);
  });

  it('refuses unknown JSON fields and non-text values as row issues', () => {
    const parsed = parseContentImportFile('SKILL', 'JSON', JSON.stringify([
      { stable_key: 'syn-a', name: 'A', description: 'B', correct: 'x' },
      { stable_key: 'syn-b', name: 'B', description: 7 },
      'not a row',
      { stable_key: 'syn-c', name: 'C', description: 'D', prerequisites: ['syn-a', 'syn-b'] },
    ]));
    expect(parsed.fileProblems).toEqual([]);
    expect(parsed.rows.map((row) => row.issues)).toEqual([
      ['IMPORT_FIELD_UNKNOWN:correct'],
      ['IMPORT_FIELD_NOT_TEXT:description', 'IMPORT_FIELD_REQUIRED:description'],
      ['IMPORT_ROW_NOT_AN_OBJECT'],
      [],
    ]);
    expect(parsed.rows[3]!.values.prerequisites).toBe('syn-a;syn-b');
  });

  it('marks missing required values, extra cells and repeated keys on their rows', () => {
    const parsed = parseContentImportFile('SKILL', 'CSV', 'stable_key,name,description\nsyn-a,A,\nsyn-b,B,C,extra\nsyn-b,B,C\n');
    expect(parsed.rows.map((row) => row.issues)).toEqual([
      ['IMPORT_FIELD_REQUIRED:description'],
      ['IMPORT_ROW_TOO_MANY_CELLS', 'IMPORT_KEY_DUPLICATE'],
      ['IMPORT_KEY_DUPLICATE'],
    ]);
  });

  it('caps the size and the number of rows, and refuses an empty or malformed file', () => {
    expect(parseContentImportFile('SKILL', 'CSV', 'x'.repeat(CONTENT_IMPORT_MAX_CHARACTERS + 1)).fileProblems).toEqual(['IMPORT_FILE_TOO_LARGE']);
    const many = ['stable_key,name,description', ...Array.from({ length: CONTENT_IMPORT_MAX_ROWS + 1 }, (_, index) => `syn-${index + 100},N,D`)].join('\n');
    expect(parseContentImportFile('SKILL', 'CSV', many).fileProblems).toEqual(['IMPORT_TOO_MANY_ROWS']);
    expect(parseContentImportFile('SKILL', 'CSV', 'stable_key,name,description\n').fileProblems).toEqual(['IMPORT_FILE_EMPTY']);
    expect(parseContentImportFile('SKILL', 'CSV', '   ').fileProblems).toEqual(['IMPORT_FILE_EMPTY']);
    expect(parseContentImportFile('SKILL', 'JSON', '{"rows": []}').fileProblems).toEqual(['IMPORT_JSON_NOT_A_LIST']);
    expect(parseContentImportFile('SKILL', 'JSON', '[{').fileProblems).toEqual(['IMPORT_JSON_INVALID']);
    expect(parseContentImportFile('SKILL', 'CSV', 'stable_key,name,description\n"open,A,B\n').fileProblems).toEqual(['IMPORT_CSV_UNTERMINATED_QUOTE']);
  });
});

describe('rows to editor input', () => {
  it('builds a skill with its levels, prerequisites and rights', () => {
    const { input, issues } = skillImportInput({ stable_key: 'Syn-A', name: 'A', description: 'B', level_aware: 'knows', prerequisites: 'syn-b; SYN-C;', licence: 'CC-BY-4.0', attribution: 'Synthetic' });
    expect(issues).toEqual([]);
    expect(input.stableKey).toBe('syn-a');
    expect(input.fields.levels).toEqual({ AWARE: 'knows', GUIDED: '', INDEPENDENT: '', TROUBLESHOOT: '' });
    expect(input.fields.prerequisites).toEqual(['syn-b', 'syn-c']);
    expect(input.fields.licenceLabel).toBe('CC-BY-4.0');
    expect(skillImportInput({ stable_key: 'syn-a', name: 'A', description: 'B', licence: 'MIT' }).issues).toEqual(['IMPORT_LICENCE_UNKNOWN']);
  });

  it('builds a question with consecutive options, a key, a band, a hint ladder and misconception codes', () => {
    const { input, issues } = questionImportInput({
      stable_key: 'syn-q', skill_key: 'syn-skill', prompt: 'P', option_a: 'A', option_b: 'B', option_c: 'C', correct_option: 'B',
      explanation: 'E', difficulty: 'foundation', hint_1: 'h1', hint_2: 'h2', hint_3: 'h3', hint_4: 'h4',
      misconception_c: 'syn_code', rationale_c: 'why',
    });
    expect(issues).toEqual([]);
    expect(input.options).toEqual([
      { id: 'a', text: 'A', misconception: null }, { id: 'b', text: 'B', misconception: null },
      { id: 'c', text: 'C', misconception: { code: 'SYN_CODE', rationale: 'why' } },
    ]);
    expect(input.fields).toMatchObject({ correctOptionId: 'b', explanation: 'E', difficulty: 'FOUNDATION', hints: ['h1', 'h2', 'h3', 'h4'] });
  });

  it('flags question fields the editor could not represent', () => {
    const { issues } = questionImportInput({
      stable_key: 'syn-q', skill_key: 's', prompt: 'P', option_a: 'A', option_c: 'C', correct_option: 'z', difficulty: 'hard',
      misconception_d: 'X_CODE', rationale_e: 'loose', licence: 'Unknown',
    });
    expect(issues).toEqual(expect.arrayContaining([
      'IMPORT_OPTIONS_NOT_CONSECUTIVE', 'IMPORT_CORRECT_OPTION_INVALID', 'IMPORT_DIFFICULTY_UNKNOWN',
      'IMPORT_MISCONCEPTION_WITHOUT_OPTION:d', 'IMPORT_RATIONALE_WITHOUT_MISCONCEPTION:e', 'IMPORT_LICENCE_UNKNOWN',
    ]));
  });

  it('builds lessons and variants with their vocabularies', () => {
    const lesson = lessonImportInput({ stable_key: 'syn-l', title: 'T', level: 'standard', style: 'worked_example', module_key: 'Mod-1', skill_key: 'Syn-S', prerequisites: 'syn-k' });
    expect(lesson.issues).toEqual([]);
    expect(lesson.input).toMatchObject({ level: 'STANDARD', style: 'WORKED_EXAMPLE', topicKey: 'syn-s', fields: { moduleKey: 'mod-1', prerequisites: ['syn-k'] } });
    expect(lessonImportInput({ stable_key: 'syn-l', title: 'T', level: 'EXPERT', style: 'POEM' }).issues).toEqual(['IMPORT_LEVEL_UNKNOWN', 'IMPORT_STYLE_UNKNOWN']);
    const variant = lessonVariantImportInput({ base_lesson_key: 'Syn-L', language: 'TE', level: 'STANDARD', style: 'EXPLANATION', title: 'T' });
    expect(variant.issues).toEqual([]);
    expect(variant.input).toMatchObject({ baseLessonKey: 'syn-l', variant: { language: 'te', level: 'STANDARD', style: 'EXPLANATION' }, fields: { moduleKey: null, prerequisites: [] } });
    expect(lessonVariantImportInput({ base_lesson_key: 'syn-l', language: 'xx', level: 'STANDARD', style: 'EXPLANATION', title: 'T' }).issues).toEqual(['IMPORT_LANGUAGE_UNKNOWN']);
  });

  it('marks two rows for the same variant of the same lesson', () => {
    const parsed = parseContentImportFile('LESSON_VARIANT', 'CSV', 'base_lesson_key,language,level,style,title\nsyn-l,te,STANDARD,EXPLANATION,A\nsyn-l,te,STANDARD,EXPLANATION,B\nsyn-l,hi,STANDARD,EXPLANATION,C\n');
    expect(parsed.rows.map((row) => row.issues)).toEqual([['IMPORT_VARIANT_DUPLICATE'], ['IMPORT_VARIANT_DUPLICATE'], []]);
  });
});

describe('prerequisite order within a file', () => {
  it('puts every row after the rows it requires, keeping file order otherwise', () => {
    const rows = [
      { key: 'c', prerequisites: ['b'] }, { key: 'a', prerequisites: [] }, { key: 'b', prerequisites: ['a', 'outside'] }, { key: 'd', prerequisites: [] },
    ];
    expect(importPrerequisiteOrder(rows).map((row) => row.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves a cycle in file order for the editor to refuse', () => {
    const rows = [{ key: 'x', prerequisites: ['y'] }, { key: 'y', prerequisites: ['x'] }];
    expect(importPrerequisiteOrder(rows).map((row) => row.key)).toEqual(['y', 'x']);
  });
});

describe('the report and its digest', () => {
  const csv = 'stable_key,skill_key,prompt,option_a,option_b,correct_option,explanation\nsyn-q,syn-s,Secret prompt,Alpha,Beta,b,Secret explanation\n';

  it('never carries row text, so never an answer key', () => {
    const report = contentImportReport(parseContentImportFile('QUESTION', 'CSV', csv), new Map());
    expect(report.rows).toEqual([{ rowNumber: 2, key: 'syn-q', outcome: 'CREATE', issues: [] }]);
    const text = JSON.stringify(report);
    for (const secret of ['Secret prompt', 'Secret explanation', 'Beta', 'correct']) expect(text).not.toContain(secret);
    expect(contentImportCommittable(report)).toBe(true);
  });

  it('changes with the file, and with what the editors found', () => {
    const parsed = parseContentImportFile('QUESTION', 'CSV', csv);
    const clean = contentImportReport(parsed, new Map());
    expect(contentImportReport(parsed, new Map()).digest).toBe(clean.digest);
    expect(contentImportReport(parseContentImportFile('QUESTION', 'CSV', csv.replace(',b,', ',a,')), new Map()).digest).not.toBe(clean.digest);
    const refused = contentImportReport(parsed, new Map([[2, ['QUESTION_KEY_EXISTS']]]));
    expect(refused.digest).not.toBe(clean.digest);
    expect(refused.counts).toEqual({ create: 0, invalid: 1 });
    expect(contentImportCommittable(refused)).toBe(false);
  });

  it('is not committable with a file problem', () => {
    const report = contentImportReport(parseContentImportFile('SKILL', 'CSV', 'stable_key,bogus\n'), new Map());
    expect(report.fileProblems.length).toBeGreaterThan(0);
    expect(contentImportCommittable(report)).toBe(false);
  });
});
