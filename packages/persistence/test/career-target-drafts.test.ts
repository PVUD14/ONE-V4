/**
 * Unit tests for ENG-11: the SOC Analyst L1 draft pack and the pack validator (no database).
 *
 * Pinned here: the committed pack is valid, says it is a draft, carries complete provenance,
 * cites a basis and an expert check for every skill and requirement, names every new skill in a
 * requirement, and has an acyclic prerequisite map; each rule of the validator refuses the pack
 * it exists to refuse; and computeCareerGap runs against the pack's requirements.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { computeCareerGap } from '@planthepath/career-readiness';
import { validateCareerTargetDraftPack, type CareerTargetDraftPack } from '../src/career-target-drafts.js';

const packUrl = new URL('../../../data/engine/soc-analyst-l1-target-v1.draft.json', import.meta.url);
const load = async (): Promise<CareerTargetDraftPack> => JSON.parse(await readFile(packUrl, 'utf8')) as CareerTargetDraftPack;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('SOC Analyst L1 draft pack', () => {
  it('is valid, a draft, for catalogue role C01, with complete provenance', async () => {
    const pack = await load();
    expect(validateCareerTargetDraftPack(pack)).toEqual([]);
    expect(pack.notice).toMatch(/\bDRAFT\b/);
    expect(pack.roleCatalogueCode).toBe('C01');
    expect(pack.generatorVersion).toBeTruthy();
    expect(pack.promptVersion).toBe('eng-11-soc-analyst-l1-target-v1');
    expect(Number.isNaN(Date.parse(pack.generatedAt))).toBe(false);
    // The basis names the NQR qualification it is aligned to.
    expect(pack.sourceBasis).toContain('QG-05-IT-01540-2023-V1.1-NASSCOM');
  });

  it('cites a qualification criterion for every new skill and every requirement built on one', async () => {
    const pack = await load();
    expect(pack.skills).toHaveLength(13);
    for (const skill of pack.skills) {
      expect(skill.stableKey).toMatch(/^soc-/);
      expect(skill.basis).toMatch(/SSC\/N090[67]|Q0909|catalogue C01/);
      expect(skill.expertCheck.length).toBeGreaterThan(10);
    }
    const newKeys = new Set(pack.skills.map((skill) => skill.stableKey));
    for (const item of pack.requirements.filter((entry) => newKeys.has(entry.topic))) {
      expect(item.basis).toMatch(/SSC\/N090[67]|Q0909|[Cc]atalogue C01/);
      expect(item.expertCheck.length).toBeGreaterThan(5);
    }
  });

  it('asks only for evidence the product can record today, and keeps the starter requirements unchanged', async () => {
    const pack = await load();
    const newKeys = new Set(pack.skills.map((skill) => skill.stableKey));
    for (const item of pack.requirements.filter((entry) => newKeys.has(entry.topic))) {
      expect(item.requiredEvidenceTypes).toEqual(['ASSESSMENT_OUTCOME']);
    }
    const starter = JSON.parse(await readFile(new URL('../../../data/careers/starter-v1.json', import.meta.url), 'utf8')) as {
      roles: { code: string; requirements: { topic: string; level: string; targetMastery: number; rationale: string }[] }[];
    };
    for (const live of starter.roles.find((role) => role.code === 'SOC_ANALYST')!.requirements) {
      const carried = pack.requirements.find((item) => item.topic === live.topic);
      expect(carried).toMatchObject({ level: live.level, targetMastery: live.targetMastery, rationale: live.rationale });
    }
  });

  it('gives computeCareerGap a requirement set it can rank, every requirement unknown before any evidence', async () => {
    const pack = await load();
    const requirements = pack.requirements.map((item, index) => ({
      topicId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, requirementLevel: item.level, targetMastery: item.targetMastery,
    }));
    const gap = computeCareerGap(requirements, []);
    expect(gap.requirementsTotal).toBe(15);
    expect(gap.requirementsUnknown).toBe(15);
    expect(gap.requirementsMet).toBe(0);
    // Essentials rank ahead of the rest when nothing is known.
    const levels = gap.items.map((item) => item.requirementLevel);
    expect(levels.lastIndexOf('ESSENTIAL')).toBeLessThan(levels.indexOf('IMPORTANT'));
    expect(levels.lastIndexOf('IMPORTANT')).toBeLessThan(levels.indexOf('HELPFUL'));
  });
});

describe('validateCareerTargetDraftPack', () => {
  it('refuses a pack that does not say it is a draft or lacks provenance', async () => {
    const pack = clone(await load());
    expect(validateCareerTargetDraftPack({ ...pack, notice: 'Final content' })).toContain('NOTICE_MUST_SAY_DRAFT');
    expect(validateCareerTargetDraftPack({ ...pack, generatorVersion: '' })).toContain('GENERATOR_VERSION_MISSING');
    expect(validateCareerTargetDraftPack({ ...pack, promptVersion: '' })).toContain('PROMPT_VERSION_MISSING');
    expect(validateCareerTargetDraftPack({ ...pack, generatedAt: 'yesterday' })).toContain('GENERATED_AT_INVALID');
    expect(validateCareerTargetDraftPack({ ...pack, sourceBasis: '' })).toContain('SOURCE_BASIS_MISSING');
  });

  it('refuses an unknown or cyclic prerequisite', async () => {
    type MutablePack = { skills: { stableKey: string; prerequisites: string[] }[] };
    const asPack = (value: MutablePack): CareerTargetDraftPack => value as unknown as CareerTargetDraftPack;
    const pack = clone(await load()) as unknown as MutablePack;
    const unknown = clone(pack);
    unknown.skills[0]!.prerequisites = ['soc-not-a-skill'];
    expect(validateCareerTargetDraftPack(asPack(unknown)).some((problem) => problem.startsWith('PREREQUISITE_UNKNOWN'))).toBe(true);
    const cyclic = clone(pack);
    const triage = cyclic.skills.find((skill) => skill.stableKey === 'soc-alert-triage')!;
    const ir = cyclic.skills.find((skill) => skill.stableKey === 'soc-incident-response-process')!;
    expect(ir.prerequisites).toContain('soc-alert-triage');
    triage.prerequisites = [...triage.prerequisites, 'soc-incident-response-process'];
    expect(validateCareerTargetDraftPack(asPack(cyclic)).some((problem) => problem.startsWith('PREREQUISITE_CYCLE'))).toBe(true);
  });

  it('refuses targets, levels, evidence types and rationale the requirement tables would refuse', async () => {
    const pack = clone(await load()) as unknown as { requirements: Record<string, unknown>[] } & CareerTargetDraftPack;
    const mutate = (change: Record<string, unknown>): readonly string[] => {
      const copy = clone(pack);
      Object.assign(copy.requirements[0]!, change);
      return validateCareerTargetDraftPack(copy);
    };
    const key = pack.requirements[0]!.topic as string;
    expect(mutate({ targetMastery: 0 })).toContain(`REQUIREMENT_TARGET_INVALID:${key}`);
    expect(mutate({ targetMastery: 1.2 })).toContain(`REQUIREMENT_TARGET_INVALID:${key}`);
    expect(mutate({ targetMastery: 0.7005 })).toContain(`REQUIREMENT_TARGET_INVALID:${key}`);
    expect(mutate({ level: 'CRITICAL' })).toContain(`REQUIREMENT_LEVEL_INVALID:${key}`);
    expect(mutate({ requiredEvidenceTypes: ['INTERVIEW'] })).toContain(`REQUIREMENT_EVIDENCE_INVALID:${key}`);
    expect(mutate({ rationale: 'x'.repeat(501) })).toContain(`REQUIREMENT_RATIONALE_INVALID:${key}`);
    expect(mutate({ expertCheck: '' })).toContain(`REQUIREMENT_EXPERT_CHECK_MISSING:${key}`);
    expect(mutate({ basis: '' })).toContain(`REQUIREMENT_BASIS_MISSING:${key}`);
  });

  it('refuses a skill no requirement names, and a duplicate requirement', async () => {
    const pack = clone(await load());
    const orphan = { ...pack, requirements: pack.requirements.filter((item) => item.topic !== 'soc-vulnerability-basics') };
    expect(validateCareerTargetDraftPack(orphan)).toContain('SKILL_NOT_REQUIRED:soc-vulnerability-basics');
    const duplicate = { ...pack, requirements: [...pack.requirements, pack.requirements[0]!] };
    expect(validateCareerTargetDraftPack(duplicate)).toContain(`REQUIREMENT_DUPLICATE:${pack.requirements[0]!.topic}`);
  });
});
