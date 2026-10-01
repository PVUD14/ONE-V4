/**
 * Builds ONE's evaluation set `one-ai-bakeoff` v1 from the repository's own content (ENG-21).
 *
 * Why this exists: the set must test the prompts the features will run, on items whose keys and
 * ladders people wrote, and it must be reproducible — the committed file the pod runs is checked
 * against this builder's output, byte for byte. Pure and deterministic: the packs and the prompt
 * registry in, the set out.
 *
 * Composition (the plan's 80 / 60 / 30 / 30): see docs/architecture/ai-bake-off-design.md, Decision 2.
 */
import { createHash } from 'node:crypto';
import {
  contentAnswerCheckPromptV1,
  contentLessonDraftPromptV1,
  hintLevelMeanings,
  oneAiFeatures,
  promptFingerprint,
  renderPrompt,
  tutorHintPromptV1,
  type PromptVersion,
} from '@planthepath/ai-orchestration/src/index.js';
import { HINT_LADDER_RULES_VERSION } from '@planthepath/career-readiness/src/index.js';
import {
  confirmationPatterns,
  hintMessages,
  hintMessageVariants,
  languageNames,
  lessonAbuseCases,
  lessonAuthorNotes,
  socLessonLevel,
  tutorAbuseCases,
} from './cases.js';
import {
  EVALUATION_SET_FORMAT,
  EVALUATION_SET_FORMAT_VERSION,
  EVALUATION_SET_KEY,
  EVALUATION_SET_VERSION,
  type EvaluationBlock,
  type EvaluationCase,
  type EvaluationLanguage,
  type EvaluationSet,
  type EvaluationTask,
  type TaskBinding,
} from './set-format.js';

export interface BankItem {
  readonly stableKey: string;
  readonly skill: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string; readonly misconception?: unknown }[];
  readonly correctOptionId: string;
  readonly hints: readonly string[];
}

export interface BankSkill {
  readonly stableKey: string;
  readonly name: string;
  readonly description: string;
  readonly levels?: Readonly<Record<string, string>>;
}

export interface AptitudeBankPack {
  readonly packKey: string;
  readonly promptVersion: string;
  readonly skills: readonly BankSkill[];
  readonly items: readonly BankItem[];
  readonly hintLadder?: { readonly promptVersion?: string };
}

export interface CareerTargetPack {
  readonly packKey: string;
  readonly promptVersion: string;
  readonly skills: readonly BankSkill[];
}

/** Which prompt each task runs. The importer may rebind feature keys (tests), never prompts. */
const taskPrompts: Readonly<Record<EvaluationTask, PromptVersion>> = {
  'tutor-hint': tutorHintPromptV1,
  'lesson-draft': contentLessonDraftPromptV1,
  'answer-check': contentAnswerCheckPromptV1,
};

export function taskBindings(): Readonly<Record<EvaluationTask, TaskBinding>> {
  const bind = (task: EvaluationTask): TaskBinding => {
    const prompt = taskPrompts[task];
    const feature = oneAiFeatures.find((entry) => entry.prompt.key === prompt.key && entry.prompt.version === prompt.version);
    if (!feature) throw new Error(`no feature runs prompt ${prompt.key} v${prompt.version}`);
    return { featureKey: feature.featureKey, promptKey: prompt.key, promptVersion: prompt.version, promptFingerprint: promptFingerprint(prompt) };
  };
  return { 'tutor-hint': bind('tutor-hint'), 'lesson-draft': bind('lesson-draft'), 'answer-check': bind('answer-check') };
}

function request(prompt: PromptVersion, parameters: Record<string, string>): EvaluationCase['request'] {
  const rendered = renderPrompt(prompt, parameters);
  return {
    messages: [{ role: 'system', content: rendered.system }, { role: 'user', content: rendered.user }],
    max_tokens: prompt.maxOutputTokens,
    temperature: prompt.temperature,
  };
}

function optionLines(item: BankItem): string {
  return item.options.map((option) => `${option.id}) ${option.text}`).join('\n');
}

function correctOption(item: BankItem): { readonly id: string; readonly text: string } {
  const found = item.options.find((option) => option.id === item.correctOptionId);
  if (!found) throw new Error(`item ${item.stableKey} has no option ${item.correctOptionId}`);
  return found;
}

function wrongOption(item: BankItem): { readonly id: string; readonly text: string } {
  const wrong = item.options.find((option) => option.id !== item.correctOptionId && option.misconception)
    ?? item.options.find((option) => option.id !== item.correctOptionId);
  if (!wrong) throw new Error(`item ${item.stableKey} has no wrong option`);
  return wrong;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

function tutorCase(input: {
  readonly id: string; readonly block: EvaluationBlock; readonly category: string; readonly language: EvaluationLanguage;
  readonly item: BankItem; readonly level: 1 | 2 | 3 | 4; readonly message: string;
  readonly accept: readonly ('HINT' | 'REDIRECT')[]; readonly leakPatterns: readonly string[]; readonly unsafePatterns: readonly string[];
}): EvaluationCase {
  const correct = correctOption(input.item);
  if (input.item.hints.length < input.level) throw new Error(`item ${input.item.stableKey} has no level-${input.level} hint`);
  const approved = input.item.hints.slice(0, input.level).map((hint, index) => `Level ${index + 1}: ${hint}`).join('\n');
  return {
    id: input.id, task: 'tutor-hint', block: input.block, category: input.category, language: input.language, source: input.item.stableKey,
    request: request(tutorHintPromptV1, {
      hintLevel: String(input.level),
      levelMeaning: hintLevelMeanings[input.level],
      language: languageNames[input.language],
      itemPrompt: input.item.prompt,
      itemOptions: optionLines(input.item),
      correctOption: `${correct.id}) ${correct.text}`,
      approvedHints: approved,
      studentMessage: input.message,
    }),
    expect: {
      kind: 'tutor-hint', accept: input.accept,
      leak: { prompt: input.item.prompt, options: input.item.options.map((option) => ({ id: option.id, text: option.text })), correctOptionId: input.item.correctOptionId },
      leakPatterns: input.leakPatterns, unsafePatterns: input.unsafePatterns,
    },
  };
}

function hintCase(id: string, block: EvaluationBlock, language: EvaluationLanguage, item: BankItem, index: number): EvaluationCase {
  const level = ((index % 4) + 1) as 1 | 2 | 3 | 4;
  const variant = hintMessageVariants[(index + Math.floor(index / 4)) % 4]!;
  const correct = correctOption(item);
  const message = fill(hintMessages[language][variant], { wrong: wrongOption(item).text, correctLetter: correct.id, correct: correct.text });
  return tutorCase({
    id, block, category: `HINT_L${level}`, language, item, level, message, accept: ['HINT'],
    leakPatterns: variant === 'CHOSE_CORRECT' ? confirmationPatterns[language] : [], unsafePatterns: [],
  });
}

function levelDescriptor(skill: BankSkill): string {
  return skill.levels?.INDEPENDENT ?? socLessonLevel;
}

function lessonCase(id: string, block: EvaluationBlock, language: EvaluationLanguage, skill: BankSkill, note: string, abuse: { readonly unsafePatterns: readonly string[] } | null): EvaluationCase {
  return {
    id, task: 'lesson-draft', block, category: abuse ? 'LESSON_ABUSE' : 'LESSON', language, source: skill.stableKey,
    request: request(contentLessonDraftPromptV1, {
      language: languageNames[language], levelDescriptor: levelDescriptor(skill), skillName: skill.name, skillDescription: skill.description, authorNote: note,
    }),
    expect: { kind: 'lesson-draft', accept: abuse ? 'REFUSED' : 'LESSON', unsafePatterns: abuse ? abuse.unsafePatterns : [] },
  };
}

function answerCheckCase(id: string, item: BankItem): EvaluationCase {
  return {
    id, task: 'answer-check', block: 'GRADING', category: 'ANSWER_CHECK', language: 'en', source: item.stableKey,
    request: request(contentAnswerCheckPromptV1, { itemPrompt: item.prompt, itemOptions: optionLines(item) }),
    expect: { kind: 'answer-check', optionIds: item.options.map((option) => option.id), correctOptionId: item.correctOptionId },
  };
}

const pad = (value: number, width = 3): string => String(value).padStart(width, '0');

/** The set. Throws if a pack lacks what the selection needs (a pack change must be noticed, not absorbed). */
export function buildEvaluationSet(bank: AptitudeBankPack, soc: CareerTargetPack): EvaluationSet {
  const skills = bank.skills;
  if (skills.length !== 25) throw new Error(`the aptitude bank has ${skills.length} skills; the v1 selection needs 25`);
  if (soc.skills.length !== 13) throw new Error(`the SOC target has ${soc.skills.length} skills; the v1 selection needs 13`);
  const itemsBySkill = new Map<string, BankItem[]>();
  for (const item of [...bank.items].sort((a, b) => a.stableKey.localeCompare(b.stableKey))) {
    itemsBySkill.set(item.skill, [...(itemsBySkill.get(item.skill) ?? []), item]);
  }
  const itemOf = (skillIndex: number, position: number): BankItem => {
    const item = itemsBySkill.get(skills[skillIndex]!.stableKey)?.[position];
    if (!item) throw new Error(`skill ${skills[skillIndex]!.stableKey} has no item at position ${position + 1}`);
    return item;
  };

  const cases: EvaluationCase[] = [];

  // ENGLISH (80): 50 tutor hints (two items per aptitude skill), 30 lessons (13 SOC + 17 aptitude skills).
  for (let index = 0; index < 50; index += 1) {
    cases.push(hintCase(`hint-en-${pad(index + 1)}`, 'ENGLISH', 'en', itemOf(Math.floor(index / 2), index % 2), index));
  }
  soc.skills.forEach((skill, index) => cases.push(lessonCase(`lesson-en-${pad(index + 1)}`, 'ENGLISH', 'en', skill, lessonAuthorNotes[index % 4]!, null)));
  for (let index = 0; index < 17; index += 1) {
    cases.push(lessonCase(`lesson-en-${pad(index + 14)}`, 'ENGLISH', 'en', skills[index]!, lessonAuthorNotes[(index + 13) % 4]!, null));
  }

  // INDIAN_LANGUAGE (60): Telugu 26 hints + 14 lessons, Hindi 13 hints + 7 lessons.
  for (let index = 0; index < 26; index += 1) {
    const item = index < 25 ? itemOf(index, 2) : itemOf(0, 3);
    cases.push(hintCase(`hint-te-${pad(index + 1)}`, 'INDIAN_LANGUAGE', 'te', item, index));
  }
  for (let index = 0; index < 13; index += 1) {
    cases.push(hintCase(`hint-hi-${pad(index + 1)}`, 'INDIAN_LANGUAGE', 'hi', itemOf(index, 4), index));
  }
  for (let index = 0; index < 14; index += 1) {
    const skill = index < 7 ? skills[17 + index]! : soc.skills[index - 7]!;
    cases.push(lessonCase(`lesson-te-${pad(index + 1)}`, 'INDIAN_LANGUAGE', 'te', skill, lessonAuthorNotes[index % 4]!, null));
  }
  for (let index = 0; index < 7; index += 1) {
    const skill = index < 4 ? skills[18 + index]! : soc.skills[7 + (index - 4)]!;
    cases.push(lessonCase(`lesson-hi-${pad(index + 1)}`, 'INDIAN_LANGUAGE', 'hi', skill, lessonAuthorNotes[(index + 1) % 4]!, null));
  }

  // GRADING (30): answer-key checks across all 25 skills, five skills twice.
  for (let index = 0; index < 30; index += 1) {
    cases.push(answerCheckCase(`check-${pad(index + 1)}`, index < 25 ? itemOf(index, 5) : itemOf(index - 25, 6)));
  }

  // ABUSE (30): 24 tutor, 6 lesson.
  tutorAbuseCases.forEach((abuse, index) => {
    const item = itemOf(index % 25, 7);
    cases.push(tutorCase({
      id: `abuse-hint-${pad(index + 1, 2)}`, block: 'ABUSE', category: abuse.category, language: abuse.language, item,
      level: ((index % 2) + 1) as 1 | 2, message: abuse.message,
      accept: abuse.category === 'ANSWER_DEMAND' ? ['REDIRECT', 'HINT'] : ['REDIRECT'],
      leakPatterns: [], unsafePatterns: abuse.unsafePatterns ?? [],
    }));
  });
  lessonAbuseCases.forEach((abuse, index) => {
    const skill = index % 2 === 0 ? soc.skills[index]! : skills[index]!;
    cases.push(lessonCase(`abuse-lesson-${pad(index + 1, 2)}`, 'ABUSE', abuse.language, skill, abuse.note, { unsafePatterns: abuse.unsafePatterns }));
  });

  return {
    format: EVALUATION_SET_FORMAT,
    formatVersion: EVALUATION_SET_FORMAT_VERSION,
    setKey: EVALUATION_SET_KEY,
    setVersion: EVALUATION_SET_VERSION,
    notice: 'ONE AI evaluation set (ENG-21). Built by packages/ai-evaluation from the aptitude bank and the SOC Analyst L1 target; regenerate with `corepack pnpm --filter @planthepath/ai-evaluation bake-off:build-set`, never edit by hand. No real person or student data. `expect` is for the scorer and is never sent to a model.',
    builtFrom: {
      aptitudeBank: `${bank.packKey} (${bank.promptVersion}; ladders ${bank.hintLadder?.promptVersion ?? 'item'})`,
      careerTarget: `${soc.packKey} (${soc.promptVersion})`,
      leakRules: HINT_LADDER_RULES_VERSION,
    },
    tasks: taskBindings(),
    cases,
  };
}

/** The file's exact text: two-space JSON with a final newline. */
export function serialiseEvaluationSet(set: EvaluationSet): string {
  return `${JSON.stringify(set, null, 2)}\n`;
}

/** SHA-256 of a file's text with CRLF normalised to LF, so a Windows checkout and the pod agree. */
export function contentSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
