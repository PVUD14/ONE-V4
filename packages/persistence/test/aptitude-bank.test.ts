/**
 * Unit tests for ENG-10's aptitude bank pack and its validator (no database).
 *
 * Pinned here: the committed data file is exactly what the authoring source builds; it passes the
 * validator — which runs the skill map and question bank editors' own submission rules — with 25
 * skills in three areas and 300 items, every item carrying an answer key and at least one
 * misconception-tagged distractor; the quantitative answer keys are what independent arithmetic
 * gives; and the validator refuses each way a pack can be incomplete (no tagged distractor, a
 * tag on the correct option or from another skill, a cyclic or unknown prerequisite, a missing
 * hint, missing provenance, a notice that does not say DRAFT).
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { answerPosition, count, fraction, num, ordinal, percent } from '../src/aptitude-bank-content/author.js';
import { buildAptitudeBankPack } from '../src/aptitude-bank-content/index.js';
import {
  APTITUDE_AREAS,
  summariseAptitudeBankPack,
  validateAptitudeBankPack,
  type AptitudeBankPack,
  type AptitudeItem,
} from '../src/aptitude-bank.js';

const packUrl = new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url);
const committed = async (): Promise<AptitudeBankPack> => JSON.parse(await readFile(packUrl, 'utf8')) as AptitudeBankPack;
const built = buildAptitudeBankPack();

const item = (pack: AptitudeBankPack, key: string): AptitudeItem => {
  const found = pack.items.find((entry) => entry.stableKey === key);
  if (!found) throw new Error(`no item ${key}`);
  return found;
};
const correctText = (entry: AptitudeItem): string => entry.options.find((option) => option.id === entry.correctOptionId)!.text;
/** A deep copy of the built pack with one change applied. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mutable JSON copy, edited freely by each case
type MutablePack = any;
const withChange = (change: (pack: MutablePack) => void): AptitudeBankPack => {
  const copy: MutablePack = JSON.parse(JSON.stringify(built));
  change(copy);
  return copy as AptitudeBankPack;
};

describe('the committed aptitude bank pack', () => {
  it('is exactly what the authoring source builds', async () => {
    expect(await committed()).toEqual(JSON.parse(JSON.stringify(built)));
  });

  it('passes the validator with 25 skills in three areas, 300 items and full tagging', async () => {
    const pack = await committed();
    expect(validateAptitudeBankPack(pack)).toEqual([]);
    const summary = summariseAptitudeBankPack(pack);
    expect(summary).toMatchObject({ skills: 25, items: 300, itemsWithTaggedDistractor: 300 });
    for (const area of APTITUDE_AREAS) expect(summary.byArea[area].skills).toBeGreaterThan(0);
    for (const n of Object.values(summary.bySkill)) expect(n).toBeGreaterThanOrEqual(8);
    expect(summary.misconceptions).toBe(pack.misconceptions.length);
  });

  it('is a DRAFT with complete agent provenance, cited sources and an AI8HT-owned licence', async () => {
    const pack = await committed();
    expect(pack.notice).toMatch(/\bDRAFT\b/);
    expect(pack).toMatchObject({ packKey: 'aptitude-bank-v1', promptVersion: 'eng-10-aptitude-bank-v1', rights: { licenceLabel: 'AI8HT-Owned', attribution: null } });
    expect(pack.generatorVersion).toBeTruthy();
    expect(Number.isNaN(Date.parse(pack.generatedAt))).toBe(false);
    expect(pack.sources.map((source) => source.id)).toEqual(['SSC-CGL', 'UPSC-CSAT', 'NCERT-MATHS']);
    for (const entry of [...pack.skills, ...pack.misconceptions, ...pack.items]) {
      expect(entry.basis.length).toBeGreaterThan(10);
      expect(entry.expertCheck.length).toBeGreaterThan(10);
    }
  });

  it('every item has one answer key among four options and at least one tagged distractor, never on the key', async () => {
    for (const entry of (await committed()).items) {
      expect(entry.options.map((option) => option.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(entry.options.filter((option) => option.id === entry.correctOptionId)).toHaveLength(1);
      expect(entry.options.find((option) => option.id === entry.correctOptionId)!.misconception).toBeNull();
      expect(entry.options.filter((option) => option.misconception).length).toBeGreaterThanOrEqual(1);
      expect(entry.hints).toHaveLength(4);
    }
  });

  it('spreads the answer key across all four positions', async () => {
    const positions = new Set((await committed()).items.map((entry) => entry.correctOptionId));
    expect([...positions].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(answerPosition('apt-q-percentages-001')).toBe(answerPosition('apt-q-percentages-001'));
  });

  it('prerequisites form an acyclic map with the aptitude roots first', async () => {
    const pack = await committed();
    const roots = pack.skills.filter((skill) => skill.prerequisites.length === 0).map((skill) => skill.stableKey);
    expect(roots).toEqual(expect.arrayContaining(['apt-q-arithmetic-operations', 'apt-q-number-properties', 'apt-v-vocabulary', 'apt-v-grammar']));
    expect(pack.skills.find((skill) => skill.stableKey === 'apt-q-profit-loss-discount')!.prerequisites).toEqual(['apt-q-percentages']);
  });
});

describe('quantitative answer keys agree with independent arithmetic', () => {
  it('LCM, HCF, order of operations and fractions', async () => {
    const pack = await committed();
    expect(correctText(item(pack, 'apt-q-number-properties-001'))).toBe('36'); // LCM(12, 18)
    expect(correctText(item(pack, 'apt-q-number-properties-005'))).toBe('12'); // HCF(36, 48)
    expect(correctText(item(pack, 'apt-q-number-properties-011'))).toBe('180 seconds'); // LCM(9, 12, 15)
    expect(correctText(item(pack, 'apt-q-arithmetic-operations-001'))).toBe('26'); // 6 + 4 × 5
    expect(correctText(item(pack, 'apt-q-arithmetic-operations-006'))).toBe('11/12'); // 2/3 + 1/4
    expect(correctText(item(pack, 'apt-q-arithmetic-operations-010'))).toBe('0.015'); // 0.3 × 0.05
  });

  it('percentages, profit and interest', async () => {
    const pack = await committed();
    expect(correctText(item(pack, 'apt-q-percentages-002'))).toBe('A decrease of 4%'); // 1.2 × 0.8 = 0.96
    expect(correctText(item(pack, 'apt-q-percentages-005'))).toBe('₹12,000'); // 15000 / 1.25
    expect(correctText(item(pack, 'apt-q-percentages-010'))).toBe('33⅓%'); // 50 / 150
    expect(correctText(item(pack, 'apt-q-profit-loss-discount-005'))).toBe('₹720'); // 1000 × 0.9 × 0.8
    expect(correctText(item(pack, 'apt-q-profit-loss-discount-012'))).toBe('A loss of 12%'); // 1.1 × 0.8 = 0.88
    expect(correctText(item(pack, 'apt-q-interest-005'))).toBe('₹450'); // 6000 × 10% × 9/12
    expect(correctText(item(pack, 'apt-q-interest-009'))).toBe('₹2100'); // 10000 × (1.1² − 1)
  });

  it('work, speed, mixtures, equations, data and probability', async () => {
    const pack = await committed();
    expect(correctText(item(pack, 'apt-q-time-work-002'))).toBe('6 days'); // 1/10 + 1/15 = 1/6
    expect(correctText(item(pack, 'apt-q-time-work-009'))).toBe('12 hours'); // 1/4 − 1/6 = 1/12
    expect(correctText(item(pack, 'apt-q-time-speed-distance-001'))).toBe('48 km/h'); // 2 × 40 × 60 / 100
    expect(correctText(item(pack, 'apt-q-time-speed-distance-009'))).toBe('25 seconds'); // 500 m at 20 m/s
    expect(correctText(item(pack, 'apt-q-mixtures-alligation-005'))).toBe('2 : 1'); // (35−25) : (25−20)
    expect(correctText(item(pack, 'apt-q-mixtures-alligation-009'))).toBe('32.4 litres'); // 40 × 0.9²
    expect(correctText(item(pack, 'apt-q-linear-equations-009'))).toBe('10 years'); // 4s + 5 = 3(s + 5)
    expect(correctText(item(pack, 'apt-q-data-interpretation-001'))).toBe('35.7%'); // 50 / 140
    expect(correctText(item(pack, 'apt-q-counting-probability-002'))).toBe('20'); // C(6, 3)
    expect(correctText(item(pack, 'apt-q-counting-probability-010'))).toBe('5/36'); // total 8 with two dice
  });

  it('logical items computed from their inputs', async () => {
    const pack = await committed();
    expect(correctText(item(pack, 'apt-l-coding-decoding-001'))).toBe('GRJ'); // DOG shifted +3
    expect(correctText(item(pack, 'apt-l-coding-decoding-006'))).toBe('RCYK'); // TEAM shifted −2 with wrap
    expect(correctText(item(pack, 'apt-l-direction-sense-003'))).toBe('13 km'); // 5-12-13
    expect(correctText(item(pack, 'apt-l-direction-sense-005'))).toBe('East'); // N, R, R, L
    expect(correctText(item(pack, 'apt-l-ordering-ranking-005'))).toBe('30th'); // 40 − 11 + 1
  });
});

describe('the authoring helpers', () => {
  it('format numbers the way items show them', () => {
    expect(num(12000)).toBe('12,000');
    expect(num(1234567)).toBe('12,34,567');
    expect(num(9000)).toBe('9000');
    expect(num(20.000000000000004)).toBe('20');
    expect(fraction(20, 32)).toBe('5/8');
    expect(fraction(36, 36)).toBe('1');
    expect(percent(100 / 3)).toBe('33⅓%');
    expect(percent(35.714)).toBe('35.7%');
    expect(count(1, 'day')).toBe('1 day');
    expect(count(2.4, 'hour')).toBe('2.4 hours');
    expect(ordinal(31)).toBe('31st');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(22)).toBe('22nd');
  });
});

describe('validateAptitudeBankPack refuses an incomplete pack', () => {
  it('an item with no misconception-tagged distractor', () => {
    const pack = withChange((copy) => {
      const target = (copy.items as AptitudeItem[]).find((entry) => entry.stableKey === 'apt-q-averages-001')!;
      for (const option of target.options as unknown as { misconception: unknown }[]) option.misconception = null;
    });
    expect(validateAptitudeBankPack(pack)).toContain('ITEM_NO_TAGGED_DISTRACTOR:apt-q-averages-001');
  });

  it('a tag on the correct option', () => {
    const pack = withChange((copy) => {
      const target = (copy.items as AptitudeItem[]).find((entry) => entry.stableKey === 'apt-q-averages-001')!;
      const correct = target.options.find((option) => option.id === target.correctOptionId) as { misconception: unknown };
      correct.misconception = { code: 'APT_Q_AVG_WRONG_COUNT', rationale: 'wrong' };
    });
    expect(validateAptitudeBankPack(pack)).toContain('ITEM_TAG_ON_CORRECT:apt-q-averages-001');
  });

  it('a tag with another skill\'s code, or an unknown code', () => {
    const other = withChange((copy) => {
      const target = (copy.items as AptitudeItem[]).find((entry) => entry.stableKey === 'apt-q-averages-001')!;
      const tagged = target.options.find((option) => option.misconception) as { misconception: { code: string } };
      tagged.misconception.code = 'APT_Q_PCT_WRONG_BASE';
    });
    expect(validateAptitudeBankPack(other)).toContain('ITEM_TAG_CODE_OTHER_SKILL:apt-q-averages-001:APT_Q_PCT_WRONG_BASE');
    const unknown = withChange((copy) => {
      const target = (copy.items as AptitudeItem[]).find((entry) => entry.stableKey === 'apt-q-averages-001')!;
      const tagged = target.options.find((option) => option.misconception) as { misconception: { code: string } };
      tagged.misconception.code = 'APT_Q_NOT_A_CODE';
    });
    expect(validateAptitudeBankPack(unknown)).toContain('ITEM_TAG_CODE_UNKNOWN:apt-q-averages-001:APT_Q_NOT_A_CODE');
  });

  it('a prerequisite cycle, and an unknown prerequisite', () => {
    const cyclic = withChange((copy) => {
      const root = (copy.skills as { stableKey: string; prerequisites: string[] }[]).find((skill) => skill.stableKey === 'apt-q-arithmetic-operations')!;
      root.prerequisites = ['apt-q-profit-loss-discount'];
    });
    expect(validateAptitudeBankPack(cyclic).some((problem) => problem.startsWith('SKILL_PREREQUISITE_CYCLE'))).toBe(true);
    const unknown = withChange((copy) => {
      const root = (copy.skills as { stableKey: string; prerequisites: string[] }[]).find((skill) => skill.stableKey === 'apt-q-arithmetic-operations')!;
      root.prerequisites = ['apt-q-not-a-skill'];
    });
    expect(validateAptitudeBankPack(unknown)).toContain('SKILL_PREREQUISITE_UNKNOWN:apt-q-not-a-skill:apt-q-arithmetic-operations');
  });

  it('a missing hint, a missing level, and duplicate option texts', () => {
    const pack = withChange((copy) => {
      const target = (copy.items as AptitudeItem[]).find((entry) => entry.stableKey === 'apt-v-idioms-001')! as unknown as { hints: string[]; options: { text: string }[] };
      target.hints[3] = '';
      const dup = (copy.items as AptitudeItem[]).find((entry) => entry.stableKey === 'apt-v-idioms-002')! as unknown as { options: { text: string }[] };
      dup.options[1]!.text = dup.options[0]!.text;
      const skill = (copy.skills as { stableKey: string; levels: Record<string, string> }[]).find((entry) => entry.stableKey === 'apt-v-idioms')!;
      skill.levels.TROUBLESHOOT = '';
    });
    const problems = validateAptitudeBankPack(pack);
    expect(problems).toContain('ITEM_HINTS_INCOMPLETE:apt-v-idioms-001');
    expect(problems).toContain('QUESTION_HINT_MISSING:4:apt-v-idioms-001');
    expect(problems).toContain('ITEM_OPTIONS_NOT_DISTINCT:apt-v-idioms-002');
    expect(problems).toContain('SKILL_LEVEL_MISSING:TROUBLESHOOT:apt-v-idioms');
  });

  it('missing provenance, a notice that does not say DRAFT, and an unused code', () => {
    const pack = withChange((copy) => {
      copy.notice = 'Aptitude content.';
      copy.generatorVersion = '';
      (copy.misconceptions as unknown[]).push({ code: 'APT_Q_UNUSED_CODE', skill: 'apt-q-averages', title: 'Unused', description: 'Never tagged.', basis: 'Test.', expertCheck: 'Test.' });
    });
    const problems = validateAptitudeBankPack(pack);
    expect(problems).toEqual(expect.arrayContaining(['NOTICE_MUST_SAY_DRAFT', 'GENERATOR_VERSION_MISSING', 'CODE_UNUSED:APT_Q_UNUSED_CODE']));
  });

  it('too few items on a skill', () => {
    const pack = withChange((copy) => {
      copy.items = (copy.items as AptitudeItem[]).filter((entry) => entry.skill !== 'apt-v-idioms' || entry.stableKey.endsWith('-001'));
    });
    expect(validateAptitudeBankPack(pack)).toContain('SKILL_TOO_FEW_ITEMS:apt-v-idioms');
  });
});
