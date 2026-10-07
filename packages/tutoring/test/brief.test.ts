/**
 * The tutoring brief (ENG-22): content only, no field for anything about the student, the request
 * phrasing chosen by level, and byte-identical to what the evaluation set sent the model — so a PASS
 * for tutor-hint@1 describes what students receive.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderPrompt, tutorHintPromptV2 } from '@planthepath/ai-orchestration/src/index.js';
import { hintMessages, repositoryEvaluationSet, type AptitudeBankPack } from '@planthepath/ai-evaluation/src/index.js';
import { TUTOR_BRIEF_KEYS, TUTOR_HINT_PROMPT, TutorBriefError, buildTutorBrief, tutorPromptParameters, tutorStudentMessage } from '../src/index.js';

const options = [{ id: 'a', text: '12' }, { id: 'b', text: '15' }, { id: 'c', text: '18' }, { id: 'd', text: '21' }];
const ladder = ['Nudge text', 'Strategy text', 'Worked step text', 'Near solution text'];
const base = { questionPrompt: 'What is 3 × 6?', options, correctOptionId: 'c', publishedLadder: ladder, level: 2, language: 'en' };

describe('the tutoring brief', () => {
  it('has exactly the content keys — nothing about the student, no readiness', () => {
    const brief = buildTutorBrief(base);
    expect(Object.keys(brief).sort()).toEqual([...TUTOR_BRIEF_KEYS]);
    const text = JSON.stringify(brief).toLowerCase();
    for (const word of ['user', 'student_id', 'subject', 'email', 'name', 'institution', 'readiness', 'band', 'score', 'mastery']) {
      expect(Object.keys(brief).some((key) => key.toLowerCase().includes(word))).toBe(false);
    }
    expect(text).not.toContain('readiness');
  });

  it('ignores anything else a caller passes: only content reaches the brief', () => {
    const smuggled = { ...base, studentName: 'Synthetic Learner', email: 'learner@example.test', readinessBand: 'DEVELOPING' } as typeof base;
    const brief = buildTutorBrief(smuggled);
    const text = JSON.stringify(brief);
    expect(text).not.toContain('Synthetic Learner');
    expect(text).not.toContain('learner@example.test');
    expect(text).not.toContain('DEVELOPING');
  });

  it('carries the published hints up to the level only', () => {
    expect(buildTutorBrief(base).approvedHints).toEqual(['Nudge text', 'Strategy text']);
    expect(buildTutorBrief({ ...base, level: 4 }).approvedHints).toEqual(ladder);
  });

  it('uses the evaluated request phrasings: "where to start" at level 1, "what next" above it', () => {
    expect(tutorStudentMessage(1, 'en')).toBe(hintMessages.en.START);
    for (const level of [2, 3, 4]) expect(tutorStudentMessage(level, 'hi')).toBe(hintMessages.hi.NEXT_STEP);
    expect(buildTutorBrief({ ...base, level: 1, language: 'te' }).studentMessage).toBe(hintMessages.te.START);
  });

  it('refuses a brief it cannot ground: bad level, language, key, options or a short ladder', () => {
    const code = (change: Partial<typeof base>) => {
      try { buildTutorBrief({ ...base, ...change }); return 'BUILT'; } catch (error) { return (error as TutorBriefError).code; }
    };
    expect(code({ level: 0 })).toBe('INVALID_LEVEL');
    expect(code({ level: 5 })).toBe('INVALID_LEVEL');
    expect(code({ language: 'ta' })).toBe('INVALID_LANGUAGE');
    expect(code({ correctOptionId: 'z' })).toBe('UNKNOWN_KEY');
    expect(code({ options: [options[0]!] })).toBe('NO_OPTIONS');
    expect(code({ publishedLadder: ['only one'], level: 3 })).toBe('LADDER_TOO_SHORT');
    expect(code({ publishedLadder: ['', 'b', 'c', 'd'], level: 1 })).toBe('LADDER_TOO_SHORT');
    expect(code({ questionPrompt: '  ' })).toBe('EMPTY_PROMPT');
  });

  it('runs the prompt version the bake-off evaluates (tutor-hint@2)', () => {
    expect(TUTOR_HINT_PROMPT).toEqual({ key: tutorHintPromptV2.key, version: tutorHintPromptV2.version });
  });

  it('renders every parameter tutor-hint@2 declares, and no other', () => {
    const parameters = tutorPromptParameters(buildTutorBrief(base));
    expect(Object.keys(parameters).sort()).toEqual([...tutorHintPromptV2.parameters].sort());
    expect(parameters.correctOption).toBe('c) 18');
    expect(parameters.approvedHints).toBe('Level 1: Nudge text\nLevel 2: Strategy text');
  });
});

describe('parity with the evaluation set', () => {
  const bank = JSON.parse(readFileSync(new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url), 'utf8')) as AptitudeBankPack;
  const { set } = repositoryEvaluationSet();

  it('renders byte-for-byte what the bake-off sent for the same item, level, language and request', () => {
    let compared = 0;
    const languages = new Set<string>();
    for (const entry of set.cases) {
      if (entry.task !== 'tutor-hint' || !/^HINT_L[1-4]$/u.test(entry.category)) continue;
      const level = Number(entry.category.slice(-1));
      const language = entry.language;
      const user = entry.request.messages.find((message) => message.role === 'user')!.content;
      if (user !== tutorStudentMessage(level, language)) continue;
      const item = bank.items.find((candidate) => candidate.stableKey === entry.source);
      expect(item, entry.id).toBeDefined();
      const brief = buildTutorBrief({
        questionPrompt: item!.prompt, options: item!.options.map((option) => ({ id: option.id, text: option.text })),
        correctOptionId: item!.correctOptionId, publishedLadder: item!.hints, level, language,
      });
      const rendered = renderPrompt(tutorHintPromptV2, tutorPromptParameters(brief));
      expect([{ role: 'system', content: rendered.system }, { role: 'user', content: rendered.user }], entry.id).toEqual(entry.request.messages);
      compared += 1;
      languages.add(language);
    }
    expect(compared).toBeGreaterThanOrEqual(10);
    expect([...languages].sort()).toEqual(['en', 'hi', 'te']);
  });
});
