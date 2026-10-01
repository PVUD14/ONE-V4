/**
 * `bake-off:review-sheet --results <file> --out <sheet.json>` — write the human review sheet for a
 * results file (ENG-21): the sampled cases with what was asked and what the model replied, and empty
 * scores for a person to fill in with docs/ai/bake-off-human-review-rubric.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildReviewSheet } from '../review.js';
import { evaluateResultsText, repositoryEvaluationSet } from '../repository.js';
import { optionValue } from './options.js';

const argv = process.argv.slice(2);
const resultsPath = optionValue(argv, '--results');
const outPath = optionValue(argv, '--out');
if (!resultsPath || !outPath) throw new Error('usage: bake-off:review-sheet --results <file> --out <sheet.json>');
const run = evaluateResultsText({ resultsText: readFileSync(resultsPath, 'utf8') });
const sheet = buildReviewSheet(repositoryEvaluationSet().set, run.results, run.resultsSha256);
writeFileSync(outPath, `${JSON.stringify(sheet, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ event: 'ai.bake_off.review_sheet', model: sheet.model, items: sheet.items.length }));
