/**
 * What a faculty reviewer is shown (OPS-10, ADR-037): a whitelist per content type. A body that
 * carries every secret field — the correct option, the explanation, misconception tags and their
 * rationale, the hint ladder, rights and agent provenance — yields a view in which none of them
 * appears. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import { externalReviewContent, externalReviewTitle } from '../src/index.js';

const SECRET = 'SYNTHETIC-SECRET-MARKER';

const questionBody = {
  schema: 'question-bank/v1',
  stableKey: 'syn-question-one',
  topicId: '11111111-1111-4111-8111-111111111111',
  prompt: 'Synthetic: which follow-up is clearest?',
  options: [
    { id: 'a', text: 'Synthetic vague request', misconception: { codeId: '22222222-2222-4222-8222-222222222222', rationale: `${SECRET} rationale` } },
    { id: 'b', text: 'Synthetic specific request' },
  ],
  correctOptionId: 'b',
  explanation: `${SECRET} explanation`,
  difficulty: 'FOUNDATION',
  hints: [`${SECRET} hint 1`, `${SECRET} hint 2`, `${SECRET} hint 3`, `${SECRET} hint 4`],
  rights: { licenceLabel: 'AI8HT-Owned', attribution: `${SECRET} attribution` },
  basis: 'Synthetic basis',
  provenance: { source: 'AGENT_DRAFTED', generatorVersion: `${SECRET}-gen`, promptVersion: 'p1', generatedAt: '2026-09-01T00:00:00Z' },
  expertCheck: `${SECRET} expert note`,
};

describe('the faculty view of a question', () => {
  it('shows the prompt, option texts, difficulty and skill, and never the key, tags, hints, rights or provenance', () => {
    const view = externalReviewContent('QUESTION', questionBody, { skillName: 'Synthetic skill' });
    expect(view).toEqual({
      kind: 'QUESTION', stableKey: 'syn-question-one', skill: 'Synthetic skill', prompt: 'Synthetic: which follow-up is clearest?',
      options: [{ id: 'a', text: 'Synthetic vague request' }, { id: 'b', text: 'Synthetic specific request' }], difficulty: 'FOUNDATION',
    });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(SECRET);
    for (const field of ['correctOptionId', 'explanation', 'misconception', 'hints', 'rights', 'provenance', 'topicId']) expect(serialised).not.toContain(field);
  });

  it('titles a question by its prompt, never by its options', () => {
    expect(externalReviewTitle('QUESTION', questionBody)).toBe('Synthetic: which follow-up is clearest?');
    expect(externalReviewTitle('QUESTION', { ...questionBody, prompt: 'x'.repeat(200) })).toHaveLength(118);
  });
});

describe('the faculty view of a skill', () => {
  it('shows the levels, prerequisites and basis, falling back to the node name, without rights or provenance', () => {
    const view = externalReviewContent('TOPIC', {
      stableKey: 'syn-skill', levels: { AWARE: 'Knows it', GUIDED: 'With help', INDEPENDENT: 'Alone', TROUBLESHOOT: 'Fixes it' },
      prerequisites: ['syn-base'], basis: 'Synthetic criterion', rights: { licenceLabel: 'CC-BY-4.0', attribution: SECRET },
      provenance: { source: 'AGENT_DRAFTED', generatorVersion: SECRET }, expertCheck: SECRET,
    }, { nodeName: 'Synthetic skill', nodeDescription: 'Synthetic description' });
    expect(view).toMatchObject({ kind: 'SKILL', stableKey: 'syn-skill', name: 'Synthetic skill', description: 'Synthetic description', prerequisites: ['syn-base'], basis: 'Synthetic criterion' });
    expect(view.kind === 'SKILL' ? view.levels.map((entry) => entry.level) : []).toEqual(['AWARE', 'GUIDED', 'INDEPENDENT', 'TROUBLESHOOT']);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

describe('the faculty view of a lesson', () => {
  it('shows a base lesson and a variant with its language, level and style', () => {
    const base = externalReviewContent('LESSON', { stableKey: 'syn-lesson', title: 'Synthetic lesson', body: { summary: 'Synthetic summary', practice: 'Synthetic practice' }, prerequisites: ['syn-first'], rights: { attribution: SECRET } });
    expect(base).toEqual({ kind: 'LESSON', stableKey: 'syn-lesson', title: 'Synthetic lesson', summary: 'Synthetic summary', practice: 'Synthetic practice', variant: null, prerequisites: ['syn-first'], basis: null });
    const variantBody = { stableKey: 'syn-lesson', variantOf: '33333333-3333-4333-8333-333333333333', variant: { language: 'te', level: 'FOUNDATION', style: 'SUMMARY' }, title: 'Synthetic variant', body: { summary: 'Synthetic' } };
    const variant = externalReviewContent('LESSON', variantBody);
    expect(variant.kind === 'LESSON' ? variant.variant : null).toMatchObject({ label: 'te/FOUNDATION/SUMMARY', level: 'FOUNDATION', style: 'SUMMARY' });
    expect(externalReviewTitle('LESSON', variantBody)).toBe('Synthetic variant (te/FOUNDATION/SUMMARY)');
    expect(JSON.stringify(base)).not.toContain(SECRET);
  });
});
