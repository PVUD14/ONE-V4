/**
 * Builds the aptitude bank pack (ENG-10) from its authoring source: the skill map, the
 * misconception codes and the 300 items, with the pack's provenance.
 *
 * Why this exists: the committed data file `data/engine/aptitude-bank-v1.draft.json` is this
 * function's output (`aptitude:build-pack`), and a test pins the two together, so the file a
 * person reviews is exactly what the source says. Deterministic: no clock, no randomness.
 */
import { HINT_LADDER_RULES_VERSION } from '@planthepath/career-readiness';
import type { AptitudeBankPack } from '../aptitude-bank.js';
import { LOGICAL_ITEMS } from './logical.js';
import { QUANTITATIVE_ITEMS } from './quantitative.js';
import { MISCONCEPTIONS, SKILLS, SOURCE_BASIS, SOURCES } from './skills.js';
import { VERBAL_ITEMS } from './verbal.js';

export const APTITUDE_PACK_KEY = 'aptitude-bank-v1';
export const APTITUDE_PROMPT_VERSION = 'eng-10-aptitude-bank-v1';
export const APTITUDE_GENERATOR_VERSION = 'claude-opus-5-5';
/** When the pack was written (fixed, so the build is reproducible). */
export const APTITUDE_GENERATED_AT = '2026-09-28T00:00:00.000Z';

/** ENG-15 revised the hint ladders under their own prompt version, checked by hint-ladder-v1. */
export const APTITUDE_HINT_LADDER_PROMPT_VERSION = 'eng-15-hint-ladders-v1';
export const APTITUDE_HINT_LADDER_GENERATED_AT = '2026-10-01T00:00:00.000Z';
export const APTITUDE_HINT_LADDER_EXPERT_CHECK =
  'Level 1 is a nudge, 2 names the method, 3 does the first step, 4 stops just short of choosing the answer. Confirm that no level before 4 settles the answer, that level 4 still leaves the choice to the learner, and that every step is correct. Levels 3 and 4 make an answer assisted.';

export function buildAptitudeBankPack(): AptitudeBankPack {
  return {
    notice: 'DRAFT — model-produced content (program Part B.8). Written by the coding agent under ENG-10 (hint ladders revised under ENG-15, see `hintLadder`), by hand, from the public syllabi cited in `sources`, with no model call made by the product. Every item, passage, hint and explanation is original; none is taken or adapted from a question bank. Import only as DRAFT with AGENT_DRAFTED provenance through db:import:aptitude-bank-draft; never publish without a subject expert checking each record\'s expertCheck note, a second person reviewing it, and a publish approval. Not shown on any student screen. Difficulty bands and levels are the agent\'s proposal, not measured values. Rationale: docs/career-readiness/aptitude-bank-v1.md.',
    packKey: APTITUDE_PACK_KEY,
    generatorVersion: APTITUDE_GENERATOR_VERSION,
    promptVersion: APTITUDE_PROMPT_VERSION,
    generatedAt: APTITUDE_GENERATED_AT,
    sourceBasis: SOURCE_BASIS,
    sources: SOURCES,
    rights: { licenceLabel: 'AI8HT-Owned', attribution: null },
    skills: SKILLS,
    misconceptions: MISCONCEPTIONS,
    items: [...QUANTITATIVE_ITEMS, ...LOGICAL_ITEMS, ...VERBAL_ITEMS],
    hintLadder: {
      generatorVersion: APTITUDE_GENERATOR_VERSION,
      promptVersion: APTITUDE_HINT_LADDER_PROMPT_VERSION,
      generatedAt: APTITUDE_HINT_LADDER_GENERATED_AT,
      rulesVersion: HINT_LADDER_RULES_VERSION,
      expertCheck: APTITUDE_HINT_LADDER_EXPERT_CHECK,
    },
  };
}
