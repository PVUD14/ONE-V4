/**
 * Tests for the skill map's content rules (OPS-09a): reading a stored body of any shape,
 * carrying the keys the editor does not own, what a draft and a submission must hold, and the
 * prerequisite graph check (the existing acyclic check, keyed on stable keys).
 */
import { describe, expect, it } from 'vitest';
import {
  composeSkillBody,
  readSkillDraftFields,
  SKILL_LEVELS,
  skillMapGraphProblems,
  validateSkillDraft,
  type SkillDraftFields,
} from '../src/index.js';

const complete = (over: Partial<SkillDraftFields> = {}): SkillDraftFields => ({
  name: 'Alert triage',
  description: 'Sorting security alerts by what they mean and how urgent they are.',
  levels: { AWARE: 'Knows what an alert is', GUIDED: 'Triages with a runbook', INDEPENDENT: 'Triages unaided', TROUBLESHOOT: 'Finds why a rule misfires' },
  prerequisites: ['soc-security-fundamentals'],
  licenceLabel: 'AI8HT-Owned',
  attribution: null,
  basis: 'Synthetic test basis',
  ...over,
});

describe('readSkillDraftFields', () => {
  it('reads an older body without levels or rights, filling name and description from the node', () => {
    const fields = readSkillDraftFields({ stableKey: 'x', prerequisites: ['a-skill', 7] }, { name: 'Node name', description: 'Node description' });
    expect(fields.name).toBe('Node name');
    expect(fields.description).toBe('Node description');
    expect(fields.prerequisites).toEqual(['a-skill']);
    expect(fields.levels).toEqual({ AWARE: '', GUIDED: '', INDEPENDENT: '', TROUBLESHOOT: '' });
    expect(fields.licenceLabel).toBeNull();
    expect(readSkillDraftFields({}, { name: 'N', description: 'D' }).prerequisites).toEqual([]);
    expect(readSkillDraftFields(null, { name: 'N', description: 'D' }).name).toBe('N');
  });

  it('ignores a licence outside the list rather than trusting it', () => {
    expect(readSkillDraftFields({ rights: { licenceLabel: 'All-Rights-Reserved' } }, { name: 'N', description: 'D' }).licenceLabel).toBeNull();
  });
});

describe('composeSkillBody', () => {
  it('replaces the editor-owned fields and carries everything else (ENG-11 expert checks and provenance)', () => {
    const previous = { expertCheck: 'Check the protocol list', packKey: 'soc-pack', provenance: { source: 'AGENT_DRAFTED' }, name: 'Old' };
    const body = composeSkillBody(previous, 'soc-alert-triage', complete());
    expect(body).toMatchObject({
      schema: 'skill-map/v1', stableKey: 'soc-alert-triage', name: 'Alert triage', expertCheck: 'Check the protocol list', packKey: 'soc-pack',
      provenance: { source: 'AGENT_DRAFTED' }, rights: { licenceLabel: 'AI8HT-Owned', attribution: null },
    });
    expect(Object.keys(body.levels as object)).toEqual([...SKILL_LEVELS]);
  });
});

describe('validateSkillDraft', () => {
  it('accepts a complete submission', () => {
    expect(validateSkillDraft('soc-alert-triage', complete(), true)).toEqual([]);
  });

  it('lets a draft be incomplete but not a submission: all four levels and a licence are needed', () => {
    const draft = complete({ levels: { AWARE: 'Only this', GUIDED: '', INDEPENDENT: '', TROUBLESHOOT: '' }, licenceLabel: null });
    expect(validateSkillDraft('soc-alert-triage', draft, false)).toEqual([]);
    expect(validateSkillDraft('soc-alert-triage', draft, true)).toEqual([
      'SKILL_LEVEL_MISSING:GUIDED', 'SKILL_LEVEL_MISSING:INDEPENDENT', 'SKILL_LEVEL_MISSING:TROUBLESHOOT', 'SKILL_LICENCE_MISSING',
    ]);
  });

  it('asks for attribution only when the licence does', () => {
    expect(validateSkillDraft('soc-alert-triage', complete({ licenceLabel: 'CC-BY-4.0' }), true)).toEqual(['SKILL_ATTRIBUTION_MISSING']);
    expect(validateSkillDraft('soc-alert-triage', complete({ licenceLabel: 'CC-BY-4.0', attribution: 'Source, CC BY 4.0' }), true)).toEqual([]);
  });

  it('refuses a bad key, lengths, a self prerequisite and duplicates', () => {
    expect(validateSkillDraft('Bad Key', complete(), false)).toContain('SKILL_KEY_INVALID');
    expect(validateSkillDraft('soc-x', complete({ name: '' }), false)).toContain('SKILL_NAME_INVALID');
    expect(validateSkillDraft('soc-x', complete({ levels: { ...complete().levels, AWARE: 'x'.repeat(501) } }), false)).toContain('SKILL_LEVEL_TOO_LONG:AWARE');
    expect(validateSkillDraft('soc-x', complete({ prerequisites: ['soc-x'] }), false)).toContain('SKILL_PREREQUISITE_SELF');
    expect(validateSkillDraft('soc-x', complete({ prerequisites: ['soc-a', 'soc-a'] }), false)).toContain('SKILL_PREREQUISITE_DUPLICATE');
    expect(validateSkillDraft('soc-x', complete({ prerequisites: Array.from({ length: 21 }, (_, index) => `soc-p${index}`) }), false)).toContain('SKILL_PREREQUISITES_TOO_MANY');
  });
});

describe('skillMapGraphProblems', () => {
  const graph = new Map<string, readonly string[]>([
    ['soc-networking-fundamentals', []],
    ['soc-os-log-sources', ['soc-networking-fundamentals']],
    ['soc-security-monitoring-siem', ['soc-os-log-sources']],
  ]);

  it('accepts an edge that keeps the map acyclic', () => {
    expect(skillMapGraphProblems(graph, 'soc-alert-triage', ['soc-security-monitoring-siem'])).toEqual([]);
  });

  it('refuses a prerequisite that closes a cycle', () => {
    expect(skillMapGraphProblems(graph, 'soc-networking-fundamentals', ['soc-security-monitoring-siem'])).toEqual(['SKILL_PREREQUISITE_CYCLE']);
  });

  it('refuses a prerequisite that is not a requirable skill', () => {
    expect(skillMapGraphProblems(graph, 'soc-alert-triage', ['soc-unknown'])).toEqual(['SKILL_PREREQUISITE_UNKNOWN:soc-unknown']);
  });

  it('refuses a skill requiring itself', () => {
    expect(skillMapGraphProblems(graph, 'soc-os-log-sources', ['soc-os-log-sources'])).toEqual(['SKILL_PREREQUISITE_SELF']);
  });

  it('does not blame this skill for another skill naming a retired key', () => {
    const withStale = new Map(graph);
    withStale.set('soc-legacy', ['retired-topic']);
    expect(skillMapGraphProblems(withStale, 'soc-alert-triage', ['soc-legacy'])).toEqual([]);
  });
});
