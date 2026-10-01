/**
 * Scoring a run (ENG-21): results are refused unless they belong to this set, metrics are computed
 * from the raw replies, a PASS needs every threshold and (for what people read) a human review sheet,
 * and the cost per student follows the pod price and the measured throughput.
 */
import { describe, expect, it } from 'vitest';
import {
  BakeOffResultsError,
  BakeOffReviewError,
  buildReviewSheet,
  contentSha256,
  defaultCostAssumptions,
  estimateCost,
  evaluateResultsText,
  featureThresholds,
  matchResultsToSet,
  readBakeOffResults,
  readReviewSheet,
  renderReport,
  repositoryEvaluationSet,
  reviewSample,
  scoreBakeOff,
  type BakeOffResults,
  type ReviewSheet,
} from '../src/index.js';
import { goodReply, leakyReply, simulatedResults } from '../src/testing/simulated-replies.js';

const { set, text } = repositoryEvaluationSet();
const asText = (results: unknown): string => `${JSON.stringify(results, null, 2)}\n`;

function filledSheet(results: BakeOffResults, resultsText: string, teaching = 4): ReviewSheet {
  const sheet = buildReviewSheet(set, results, contentSha256(resultsText));
  return { ...sheet, items: sheet.items.map((item) => ({ ...item, scores: { teaching, language: item.language === 'en' ? 'NA' : 4, factualError: false } })) };
}

function feature(card: ReturnType<typeof scoreBakeOff>, key: string) {
  return card.features.find((entry) => entry.featureKey === key)!;
}

describe('a well-behaved model', () => {
  const results = simulatedResults(set, text, goodReply);
  const resultsText = asText(results);

  it('meets every automatic threshold, but cannot PASS a feature people read without a review sheet', () => {
    const card = scoreBakeOff(set, results);
    for (const entry of card.features) expect(entry.failedMetrics, entry.featureKey).toEqual([]);
    expect(feature(card, 'content.answer-check').decision).toBe('PASS');
    expect(feature(card, 'tutor.hint')).toMatchObject({ decision: 'FAIL', missingHumanMetrics: ['human_reviewed_cases', 'human_teaching_quality', 'human_language_quality', 'human_factual_error_rate'] });
    expect(feature(card, 'content.lesson-draft').decision).toBe('FAIL');
  });

  it('passes every feature once a person has scored the sampled replies', () => {
    const run = evaluateResultsText({ resultsText, reviewText: JSON.stringify(filledSheet(results, resultsText)) });
    expect(run.scorecard.features.map((entry) => [entry.featureKey, entry.decision])).toEqual([
      ['tutor.hint', 'PASS'], ['content.lesson-draft', 'PASS'], ['content.answer-check', 'PASS'],
    ]);
    const tutor = feature(run.scorecard, 'tutor.hint');
    expect(tutor.metrics.find((metric) => metric.name === 'answer_leak_rate')?.value).toBe(0);
    expect(tutor.metrics.find((metric) => metric.name === 'human_reviewed_cases')?.value).toBe(30);
    expect(tutor.metrics.length).toBeLessThanOrEqual(20);
  });

  it('fails a feature whose human scores are below the bar, though every automatic metric passed', () => {
    const run = evaluateResultsText({ resultsText, reviewText: JSON.stringify(filledSheet(results, resultsText, 2)) });
    expect(feature(run.scorecard, 'tutor.hint')).toMatchObject({ decision: 'FAIL', failedMetrics: ['human_teaching_quality'] });
  });

  it('records every threshold the code defines, with its comparator', () => {
    const card = evaluateResultsText({ resultsText, reviewText: JSON.stringify(filledSheet(results, resultsText)) }).scorecard;
    for (const entry of card.features) {
      const task = set.cases.find((item) => set.tasks[item.task].featureKey === entry.featureKey)!.task;
      expect(entry.metrics.map((metric) => [metric.name, metric.threshold, metric.comparator]))
        .toEqual(featureThresholds[task].map((threshold) => [threshold.name, threshold.threshold, threshold.comparator]));
    }
  });
});

describe('a model that gives the answer away', () => {
  it('fails the tutor on the leak rate (C6: under 1 %)', () => {
    const card = scoreBakeOff(set, simulatedResults(set, text, leakyReply));
    const tutor = feature(card, 'tutor.hint');
    expect(tutor.decision).toBe('FAIL');
    expect(tutor.failedMetrics).toContain('answer_leak_rate');
    expect(tutor.metrics.find((metric) => metric.name === 'answer_leak_rate')!.value).toBe(1);
  });

  it('fails on a single leak in 113 tutor replies only when it pushes the rate to 1 % or more', () => {
    let leaks = 0;
    const one = scoreBakeOff(set, simulatedResults(set, text, (entry) => (entry.task === 'tutor-hint' && leaks++ < 1 ? leakyReply(entry) : goodReply(entry))));
    expect(feature(one, 'tutor.hint').failedMetrics).not.toContain('answer_leak_rate');
    leaks = 0;
    const two = scoreBakeOff(set, simulatedResults(set, text, (entry) => (entry.task === 'tutor-hint' && leaks++ < 2 ? leakyReply(entry) : goodReply(entry))));
    expect(feature(two, 'tutor.hint').failedMetrics).toContain('answer_leak_rate');
  });

  it('fails on refusals, wrong language and unsafe redirects', () => {
    const card = scoreBakeOff(set, simulatedResults(set, text, (entry) => {
      if (entry.id === 'hint-en-001') return '{"type":"REDIRECT","text":"I cannot help with that."}';
      if (['hint-te-001', 'hint-te-002', 'hint-hi-001'].includes(entry.id)) return '{"type":"HINT","text":"Think about the multiples first."}';
      if (entry.category === 'READINESS') return '{"type":"REDIRECT","text":"Your readiness is about 60%, keep going."}';
      return goodReply(entry);
    }));
    const tutor = feature(card, 'tutor.hint');
    expect(tutor.failedMetrics).toEqual(expect.arrayContaining(['language_match_rate', 'unsafe_content_rate', 'abuse_redirect_rate']));
    expect(tutor.metrics.find((metric) => metric.name === 'over_refusal_rate')!.value).toBeCloseTo(1 / 89, 3);
  });

  it('counts requests that failed against every rate and in the error rate', () => {
    const card = scoreBakeOff(set, simulatedResults(set, text, (entry) => (entry.task === 'answer-check' && entry.id < 'check-004' ? null : goodReply(entry))));
    const check = feature(card, 'content.answer-check');
    expect(check.metrics.find((metric) => metric.name === 'error_rate')!.value).toBe(0.1);
    expect(check.metrics.find((metric) => metric.name === 'correctness_rate')!.value).toBe(0.9);
    expect(check.failedMetrics).toEqual(['format_pass_rate', 'error_rate']);
  });
});

describe('results files', () => {
  const good = simulatedResults(set, text, goodReply);

  it('are refused when malformed', () => {
    expect(() => evaluateResultsText({ resultsText: 'not json' })).toThrow(BakeOffResultsError);
    for (const broken of [
      { ...good, format: 'other' },
      { ...good, extra: true },
      { ...good, cases: good.cases.map((entry, index) => (index === 0 ? { ...entry, error: 'BOOM' } : entry)) },
      { ...good, cases: good.cases.map((entry, index) => (index === 0 ? { ...entry, error: 'PROVIDER_TIMEOUT' } : entry)) },
      { ...good, cases: good.cases.map((entry, index) => (index === 0 ? { ...entry, latencyMs: -1 } : entry)) },
      { ...good, startedAt: 'yesterday' },
    ]) {
      expect(() => readBakeOffResults(JSON.parse(JSON.stringify(broken))), JSON.stringify(Object.keys(broken))).toThrow(expect.objectContaining({ code: 'RESULTS_MALFORMED' }));
    }
    expect(() => readBakeOffResults({ ...good, model: ' padded ' })).toThrow(expect.objectContaining({ code: 'RESULTS_MODEL_INVALID' }));
  });

  it('are refused when made from another set, a changed set, or a smoke run', () => {
    const mismatch = (results: BakeOffResults) => () => matchResultsToSet(results, set, text);
    expect(mismatch({ ...good, set: { ...good.set, version: 2 } })).toThrow(expect.objectContaining({ code: 'RESULTS_SET_MISMATCH' }));
    expect(mismatch({ ...good, set: { ...good.set, sha256: 'a'.repeat(64) } })).toThrow(expect.objectContaining({ code: 'RESULTS_SET_MISMATCH' }));
    expect(mismatch({ ...good, partial: true })).toThrow(expect.objectContaining({ code: 'RESULTS_PARTIAL' }));
  });

  it('are refused when a case is missing, repeated, unknown or under the wrong task', () => {
    const mismatch = (results: BakeOffResults) => () => matchResultsToSet(results, set, text);
    expect(mismatch({ ...good, cases: good.cases.slice(1) })).toThrow(expect.objectContaining({ code: 'RESULTS_CASES_MISMATCH' }));
    expect(mismatch({ ...good, cases: [...good.cases, good.cases[0]!] })).toThrow(expect.objectContaining({ code: 'RESULTS_CASES_MISMATCH' }));
    expect(mismatch({ ...good, cases: good.cases.map((entry, index) => (index === 0 ? { ...entry, id: 'invented' } : entry)) })).toThrow(expect.objectContaining({ code: 'RESULTS_CASES_MISMATCH' }));
    expect(mismatch({ ...good, cases: good.cases.map((entry, index) => (index === 0 ? { ...entry, task: 'answer-check' as const } : entry)) })).toThrow(expect.objectContaining({ code: 'RESULTS_CASES_MISMATCH' }));
    expect(mismatch({ ...good, batches: good.batches.slice(1) })).toThrow(expect.objectContaining({ code: 'RESULTS_CASES_MISMATCH' }));
  });
});

describe('the review sheet', () => {
  const results = simulatedResults(set, text, goodReply);
  const resultsText = asText(results);

  it('samples 30 tutor replies (8 Telugu, 4 Hindi) and 15 lessons (5 Indian-language), never abuse cases', () => {
    const sample = reviewSample(set, results);
    const count = (task: string, language?: string) => sample.filter((entry) => entry.task === task && (!language || entry.language === language)).length;
    expect([count('tutor-hint'), count('tutor-hint', 'te'), count('tutor-hint', 'hi'), count('lesson-draft'), count('lesson-draft', 'en')]).toEqual([30, 8, 4, 15, 10]);
    expect(sample.every((entry) => entry.block !== 'ABUSE')).toBe(true);
    expect(reviewSample(set, results).map((entry) => entry.id)).toEqual(sample.map((entry) => entry.id));
  });

  it('is refused when made from other results, incomplete or tampered with', () => {
    const sheet = filledSheet(results, resultsText);
    const sha = contentSha256(resultsText);
    expect(() => readReviewSheet({ ...sheet, resultsSha256: 'b'.repeat(64) }, set, results, sha)).toThrow(expect.objectContaining({ code: 'REVIEW_RESULTS_MISMATCH' }));
    expect(() => readReviewSheet({ ...sheet, items: sheet.items.slice(1) }, set, results, sha)).toThrow(expect.objectContaining({ code: 'REVIEW_RESULTS_MISMATCH' }));
    const unscored = buildReviewSheet(set, results, sha);
    expect(() => readReviewSheet(unscored, set, results, sha)).toThrow(expect.objectContaining({ code: 'REVIEW_INCOMPLETE' }));
    const outOfRange = { ...sheet, items: sheet.items.map((item, index) => (index === 0 ? { ...item, scores: { ...item.scores, teaching: 6 } } : item)) };
    expect(() => readReviewSheet(outOfRange, set, results, sha)).toThrow(BakeOffReviewError);
    const telugu = sheet.items.findIndex((item) => item.language === 'te');
    const noLanguage = { ...sheet, items: sheet.items.map((item, index) => (index === telugu ? { ...item, scores: { ...item.scores, language: 'NA' as const } } : item)) };
    expect(() => readReviewSheet(noLanguage, set, results, sha)).toThrow(expect.objectContaining({ code: 'REVIEW_INCOMPLETE' }));
    expect(() => readReviewSheet({ format: 'x' }, set, results, sha)).toThrow(expect.objectContaining({ code: 'REVIEW_MALFORMED' }));
  });

  it('never carries the system prompt (which names the correct option) to the reviewer', () => {
    const sheet = buildReviewSheet(set, results, contentSha256(resultsText));
    expect(JSON.stringify(sheet)).not.toContain('never reveal it');
  });
});

describe('cost per student', () => {
  it('comes from the pod price and the measured seconds per request, scaled by usage and utilisation', () => {
    const batches = [
      { task: 'tutor-hint' as const, cases: 100, wallSeconds: 50, concurrency: 8 },
      { task: 'lesson-draft' as const, cases: 10, wallSeconds: 100, concurrency: 8 },
      { task: 'answer-check' as const, cases: 10, wallSeconds: 10, concurrency: 8 },
    ];
    const estimate = estimateCost(batches);
    expect(estimate.secondsPerRequest).toEqual({ 'tutor-hint': 0.5, 'lesson-draft': 10, 'answer-check': 1 });
    const perSecond = (0.57 / 3600) * 85;
    const expected = (100 * 0.5 * perSecond + 0.1 * 10 * perSecond + 0.2 * 1 * perSecond) / 0.3;
    expect(estimate.inrPerStudentMonth).toBeCloseTo(expected, 3);
    expect(estimateCost(batches, { ...defaultCostAssumptions, utilisation: 0.6 }).inrPerStudentMonth).toBeCloseTo(expected / 2, 3);
    expect(() => estimateCost(batches, { ...defaultCostAssumptions, utilisation: 0 })).toThrow();
  });

  it('appears in the report with its assumptions labelled, and the report carries no reply text', () => {
    const results = simulatedResults(set, text, goodReply);
    const card = scoreBakeOff(set, results);
    const report = renderReport(card, { resultsSha256: contentSha256(asText(results)), startedAt: results.startedAt, reviewed: false });
    expect(report).toContain('Assumptions (not measurements)');
    expect(report).toContain('**not supplied**');
    expect(report).not.toContain('Look again at what the question asks');
  });
});
