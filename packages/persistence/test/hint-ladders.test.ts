/**
 * ENG-15 acceptance on the aptitude pack, with no database: every item has a complete four-step
 * hint ladder that passes the ladder rules (hint-ladder-v1) — it climbs, never names the answer —
 * and whose worked step and near solution are about the item; the ladders carry their own DRAFT
 * provenance; and the validator refuses a pack that breaks any of this.
 *
 * Design: docs/architecture/hint-ladder-authoring-design.md
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HINT_LADDER_RULES_VERSION, hintLadderFindings } from '@planthepath/career-readiness';
import { APTITUDE_HINT_SHARED_LIMIT, validateAptitudeBankPack, type AptitudeBankPack, type AptitudeItem } from '../src/aptitude-bank.js';
import { buildAptitudeBankPack } from '../src/aptitude-bank-content/index.js';
import { agentDraftBodyKeys } from '../src/skill-map.js';
import { readHintLadderProvenance } from '@planthepath/career-readiness';

const packUrl = new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url);
const committed = async (): Promise<AptitudeBankPack> => JSON.parse(await readFile(packUrl, 'utf8')) as AptitudeBankPack;
const built = buildAptitudeBankPack();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a mutable JSON copy, edited freely by each case
type MutablePack = any;
const withChange = (change: (pack: MutablePack) => void): AptitudeBankPack => {
  const copy: MutablePack = JSON.parse(JSON.stringify(built));
  change(copy);
  return copy as AptitudeBankPack;
};
const find = (pack: MutablePack, key: string): { hints: string[]; options: { id: string; text: string }[]; correctOptionId: string } =>
  (pack.items as AptitudeItem[]).find((entry) => entry.stableKey === key)! as unknown as { hints: string[]; options: { id: string; text: string }[]; correctOptionId: string };

describe('ENG-15: every aptitude item has a complete hint ladder', () => {
  it('all 300 items carry four written levels that pass hint-ladder-v1', async () => {
    const pack = await committed();
    expect(pack.items).toHaveLength(300);
    for (const item of pack.items) {
      expect(item.hints, item.stableKey).toHaveLength(4);
      for (const hint of item.hints) expect(hint.trim().length, item.stableKey).toBeGreaterThan(0);
      expect(hintLadderFindings(item), item.stableKey).toEqual([]);
    }
  });

  it('the worked step and the near solution are about the item: none is shared by more than two items', async () => {
    const pack = await committed();
    for (const level of [2, 3]) {
      const uses = new Map<string, number>();
      for (const item of pack.items) uses.set(item.hints[level]!, (uses.get(item.hints[level]!) ?? 0) + 1);
      expect(Math.max(...uses.values())).toBeLessThanOrEqual(APTITUDE_HINT_SHARED_LIMIT);
    }
  });

  it('the ladders carry their own DRAFT provenance, apart from the items\'', async () => {
    const pack = await committed();
    expect(pack.notice).toMatch(/\bDRAFT\b/);
    expect(pack.hintLadder).toMatchObject({
      generatorVersion: pack.generatorVersion, promptVersion: 'eng-15-hint-ladders-v1', rulesVersion: HINT_LADDER_RULES_VERSION,
    });
    expect(pack.promptVersion).toBe('eng-10-aptitude-bank-v1');
    expect(Number.isNaN(Date.parse(pack.hintLadder.generatedAt))).toBe(false);
    expect(pack.hintLadder.expertCheck).toMatch(/assisted/);
  });

  it('a question body drafted with ladder provenance gives the ladder row ENG-15\'s provenance, with both expert notes', () => {
    const body = agentDraftBodyKeys({
      generatorVersion: built.generatorVersion, promptVersion: built.promptVersion, generatedAt: built.generatedAt, packKey: built.packKey,
      expertCheck: 'Check the item.',
      hintLadder: { generatorVersion: built.hintLadder.generatorVersion, promptVersion: built.hintLadder.promptVersion, generatedAt: built.hintLadder.generatedAt, expertCheck: built.hintLadder.expertCheck },
    });
    const ladder = readHintLadderProvenance(body)!;
    expect(ladder).toMatchObject({ generatorVersion: built.generatorVersion, promptVersion: 'eng-15-hint-ladders-v1', generatedAt: '2026-10-01T00:00:00.000Z' });
    expect(ladder.expertCheck).toBe(`Check the item. Hint ladder: ${built.hintLadder.expertCheck}`);
  });
});

describe('ENG-15: the pack validator refuses a bad ladder', () => {
  it('a level that repeats an earlier one, a hint that states the answer, and one that points at its letter', () => {
    const pack = withChange((copy) => {
      const repeat = find(copy, 'apt-q-linear-equations-001');
      repeat.hints[1] = repeat.hints[0]!.toUpperCase();
      const names = find(copy, 'apt-v-idioms-003');
      names.hints[2] = `It means "${names.options.find((option) => option.id === names.correctOptionId)!.text}".`;
      const letter = find(copy, 'apt-v-idioms-004');
      letter.hints[3] = `Choose option ${letter.correctOptionId}.`;
    });
    expect(validateAptitudeBankPack(pack)).toEqual(expect.arrayContaining([
      'ITEM_HINT_REPEATS_EARLIER:2:apt-q-linear-equations-001',
      'ITEM_HINT_NAMES_ANSWER:3:apt-v-idioms-003',
      'ITEM_HINT_NAMES_OPTION:4:apt-v-idioms-004',
    ]));
  });

  it('a near solution shared by more than two items', () => {
    const pack = withChange((copy) => {
      for (const key of ['apt-v-idioms-001', 'apt-v-idioms-002', 'apt-v-idioms-003']) find(copy, key).hints[3] = 'Pick the meaning that fits the sentence.';
    });
    expect(validateAptitudeBankPack(pack)).toEqual(expect.arrayContaining([
      'ITEM_HINT_GENERIC:4:apt-v-idioms-001', 'ITEM_HINT_GENERIC:4:apt-v-idioms-002', 'ITEM_HINT_GENERIC:4:apt-v-idioms-003',
    ]));
    const two = withChange((copy) => {
      for (const key of ['apt-v-idioms-001', 'apt-v-idioms-002']) find(copy, key).hints[3] = 'Pick the meaning that fits the sentence.';
    });
    expect(validateAptitudeBankPack(two)).toEqual([]);
  });

  it('missing ladder provenance, or ladders checked by other rules', () => {
    expect(validateAptitudeBankPack(withChange((copy) => { delete copy.hintLadder; }))).toContain('HINT_LADDER_PROVENANCE_MISSING');
    expect(validateAptitudeBankPack(withChange((copy) => { copy.hintLadder.promptVersion = ''; }))).toContain('HINT_LADDER_PROVENANCE_MISSING');
    expect(validateAptitudeBankPack(withChange((copy) => { copy.hintLadder.rulesVersion = 'hint-ladder-v0'; }))).toContain('HINT_LADDER_RULES_VERSION_INVALID');
  });
});
