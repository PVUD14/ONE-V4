/**
 * The evaluation set (ENG-21): the plan's composition, built from the repository's real content,
 * deterministic, and identical to the committed file the pod runs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { onePromptRegistry, promptFingerprint, oneAiFeatures } from '@planthepath/ai-orchestration/src/index.js';
import { hintLadderFindings } from '@planthepath/career-readiness/src/index.js';
import { buildEvaluationSet, committedSetPath, contentSha256, repositoryEvaluationSet, serialiseEvaluationSet, type AptitudeBankPack, type CareerTargetPack } from '../src/index.js';

const bank = JSON.parse(readFileSync(new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url), 'utf8')) as AptitudeBankPack;
const soc = JSON.parse(readFileSync(new URL('../../../data/engine/soc-analyst-l1-target-v1.draft.json', import.meta.url), 'utf8')) as CareerTargetPack;

describe('one-ai-bakeoff v1', () => {
  const { set, text } = repositoryEvaluationSet();

  it('has the plan\'s 200 prompts: 80 English, 60 Indian-language, 30 grading, 30 abuse', () => {
    const blocks = (block: string) => set.cases.filter((entry) => entry.block === block).length;
    expect(set.cases).toHaveLength(200);
    expect({ english: blocks('ENGLISH'), indian: blocks('INDIAN_LANGUAGE'), grading: blocks('GRADING'), abuse: blocks('ABUSE') })
      .toEqual({ english: 80, indian: 60, grading: 30, abuse: 30 });
    expect(set.cases.filter((entry) => entry.block === 'INDIAN_LANGUAGE').every((entry) => entry.language === 'te' || entry.language === 'hi')).toBe(true);
    expect(new Set(set.cases.map((entry) => entry.id)).size).toBe(200);
  });

  it('covers cybersecurity with every SOC Analyst L1 skill, and every aptitude skill', () => {
    const sources = new Set(set.cases.map((entry) => entry.source));
    for (const skill of soc.skills) expect(sources.has(skill.stableKey)).toBe(true);
    const itemSkills = new Set(set.cases.filter((entry) => entry.task !== 'lesson-draft').map((entry) => entry.source.replace(/-\d{3}$/u, '')));
    for (const skill of bank.skills) expect(itemSkills.has(skill.stableKey)).toBe(true);
  });

  it('tests every hint level, all six abuse categories and both Indian languages', () => {
    const categories = new Set(set.cases.map((entry) => entry.category));
    for (const category of ['HINT_L1', 'HINT_L2', 'HINT_L3', 'HINT_L4', 'ANSWER_DEMAND', 'PROMPT_INJECTION', 'OFF_TOPIC', 'PERSONAL_DATA', 'READINESS', 'CHEATING_OR_HARM', 'LESSON', 'LESSON_ABUSE', 'ANSWER_CHECK']) {
      expect(categories.has(category)).toBe(true);
    }
    const abuseLanguages = new Set(set.cases.filter((entry) => entry.block === 'ABUSE').map((entry) => entry.language));
    expect([...abuseLanguages].sort()).toEqual(['en', 'hi', 'te']);
  });

  it('uses the real keys and the human-written ladders, which pass ENG-15\'s own leak rules', () => {
    const items = new Map(bank.items.map((item) => [item.stableKey, item]));
    for (const entry of set.cases) {
      if (entry.expect.kind === 'answer-check') expect(entry.expect.correctOptionId).toBe(items.get(entry.source)!.correctOptionId);
      if (entry.expect.kind === 'tutor-hint') {
        const item = items.get(entry.source)!;
        expect(entry.expect.leak.correctOptionId).toBe(item.correctOptionId);
        expect(hintLadderFindings({ prompt: item.prompt, options: item.options, correctOptionId: item.correctOptionId, hints: item.hints })).toEqual([]);
        // The approved hints shown to the model stop at the requested level.
        const level = Number(entry.category.replace('HINT_L', '')) || null;
        const system = entry.request.messages[0]!.content;
        if (level !== null && level < 4) expect(system).not.toContain(`Level ${level + 1}: `);
      }
    }
  });

  it('renders exactly the registered prompts the features run', () => {
    const registry = onePromptRegistry();
    for (const [task, binding] of Object.entries(set.tasks)) {
      const prompt = registry.get(binding.promptKey, binding.promptVersion);
      expect(binding.promptFingerprint, task).toBe(promptFingerprint(prompt));
      expect(oneAiFeatures.find((feature) => feature.featureKey === binding.featureKey)?.prompt).toBe(prompt);
    }
    for (const entry of set.cases) {
      const prompt = registry.get(set.tasks[entry.task].promptKey, set.tasks[entry.task].promptVersion);
      expect(entry.request.max_tokens).toBe(prompt.maxOutputTokens);
      expect(entry.request.temperature).toBe(prompt.temperature);
      expect(entry.request.messages.map((message) => message.role)).toEqual(['system', 'user']);
      expect(JSON.stringify(entry.request)).not.toMatch(/\{\{\w+\}\}/u);
    }
  });

  it('carries no real contact data: personal-data cases use visibly synthetic values only', () => {
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/iu);
    expect(text).not.toMatch(/(?<!\d)[6-9]\d{4}\s?\d{5}(?!\d)/u);
  });

  it('is deterministic and the committed file is exactly the builder\'s output', () => {
    expect(serialiseEvaluationSet(buildEvaluationSet(bank, soc))).toBe(text);
    const committed = readFileSync(committedSetPath, 'utf8');
    expect(contentSha256(committed), 'run `corepack pnpm --filter @planthepath/ai-evaluation bake-off:build-set`').toBe(contentSha256(text));
  });

  it('refuses a pack that has changed shape instead of quietly building a different set', () => {
    expect(() => buildEvaluationSet({ ...bank, skills: bank.skills.slice(1) }, soc)).toThrow(/25/u);
    expect(() => buildEvaluationSet({ ...bank, items: bank.items.filter((item) => item.skill !== bank.skills[0]!.stableKey) }, soc)).toThrow(/no item/u);
  });
});
