/**
 * The calibration results file is validated before anything is written (ENG-13).
 * Pure: no database. Why it exists: the Python job's output is the only way numbers enter
 * item_calibrations, so a malformed, out-of-range or learner-bearing file must be refused whole.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_ALGORITHM_ID,
  CALIBRATION_RESULTS_FORMAT,
  CalibrationResultsError,
  calibrationItemKey,
  parseCalibrationResults,
} from '../src/item-calibrations.js';

const itemA = '11111111-1111-4111-8111-111111111111';
const itemB = '22222222-2222-4222-8222-222222222222';

function results(overrides: Record<string, unknown> = {}, items?: Record<string, unknown>[]): Record<string, unknown> {
  const list = items ?? [
    { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: -0.51234, discrimination: 1.2, responsesUsed: 250, status: 'CALIBRATED', statusReason: null },
    { itemSource: 'INSTITUTION_EXAM_QUESTION', itemId: itemB, itemVersion: 2, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 12, status: 'PROVISIONAL', statusReason: 'TOO_FEW_RESPONSES' },
  ];
  return {
    format: CALIBRATION_RESULTS_FORMAT,
    runId: '33333333-3333-4333-8333-333333333333',
    algorithmId: CALIBRATION_ALGORITHM_ID,
    library: 'girth==0.8.0 numpy==2.4.6 scipy==1.17.1',
    minResponses: 200,
    exportedAt: '2026-09-28T10:00:00.000Z',
    generatedAt: '2026-09-28T10:01:00.000Z',
    learnersRead: 250,
    responsesRead: list.reduce((sum, item) => sum + (typeof item.responsesUsed === 'number' ? item.responsesUsed : 0), 0),
    itemsRead: list.length,
    items: list,
    ...overrides,
  };
}

function rejects(value: unknown, message: RegExp): void {
  expect(() => parseCalibrationResults(value)).toThrow(CalibrationResultsError);
  expect(() => parseCalibrationResults(value)).toThrow(message);
}

describe('parseCalibrationResults', () => {
  it('accepts a well-formed run and rounds parameters to the stored precision', () => {
    const parsed = parseCalibrationResults(results());
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ difficulty: -0.5123, discrimination: 1.2, status: 'CALIBRATED', statusReason: null });
    expect(parsed.items[1]).toMatchObject({ status: 'PROVISIONAL', statusReason: 'TOO_FEW_RESPONSES' });
    expect(calibrationItemKey(parsed.items[1]!)).toBe(`INSTITUTION_EXAM_QUESTION:${itemB}:2`);
  });

  it('refuses a CALIBRATED item with fewer responses than the run threshold', () => {
    rejects(results({}, [
      { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 199, status: 'CALIBRATED', statusReason: null },
    ]), /at least 200 responses/);
  });

  it('refuses a PROVISIONAL item without a known reason, and a CALIBRATED item with one', () => {
    rejects(results({}, [
      { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 3, status: 'PROVISIONAL', statusReason: null },
    ]), /statusReason/);
    rejects(results({}, [
      { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 300, status: 'CALIBRATED', statusReason: 'NO_VARIANCE' },
    ]), /no statusReason/);
  });

  it('refuses parameters outside the usable range or not finite', () => {
    const item = (difficulty: unknown, discrimination: unknown) => [{ itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty, discrimination, responsesUsed: 300, status: 'CALIBRATED', statusReason: null }];
    rejects(results({}, item(4.5, 1)), /difficulty/);
    rejects(results({}, item(0, 0.1)), /discrimination/);
    rejects(results({}, item(0, -1)), /discrimination/);
    rejects(results({}, item(Number.NaN, 1)), /difficulty/);
    rejects(results({}, item('0', 1)), /difficulty/);
  });

  it('refuses any field it does not know, so nothing per-learner can ride along', () => {
    rejects(results({ learners: ['L1'] }), /unexpected field "learners"/);
    rejects(results({}, [
      { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 300, status: 'CALIBRATED', statusReason: null, abilities: [0.1] },
    ]), /unexpected field "abilities"/);
  });

  it('refuses a wrong format, algorithm, model, item bank or run id', () => {
    rejects(results({ format: 'something-else' }), /format/);
    rejects(results({ algorithmId: 'item-calibration-2pl-v2' }), /algorithmId/);
    rejects(results({ runId: 'not-a-uuid' }), /runId/);
    rejects(results({}, [
      { itemSource: 'PLACEMENT_ITEM', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 3, status: 'PROVISIONAL', statusReason: 'TOO_FEW_RESPONSES' },
    ]), /itemSource/);
    rejects(results({}, [
      { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '3PL', difficulty: 0, discrimination: 1, responsesUsed: 3, status: 'PROVISIONAL', statusReason: 'TOO_FEW_RESPONSES' },
    ]), /model/);
  });

  it('refuses inconsistent counts and repeated items', () => {
    rejects(results({ itemsRead: 5 }), /itemsRead/);
    rejects(results({ responsesRead: 1 }), /responsesRead/);
    const repeated = { itemSource: 'CAREER_READINESS_QUESTION', itemId: itemA, itemVersion: 1, model: '2PL', difficulty: 0, discrimination: 1, responsesUsed: 3, status: 'PROVISIONAL', statusReason: 'TOO_FEW_RESPONSES' };
    rejects(results({}, [repeated, { ...repeated, itemId: itemA.toUpperCase() }]), /repeats an item/);
  });

  it('refuses something that is not an object', () => {
    rejects(null, /JSON object/);
    rejects([], /JSON object/);
  });
});

describe('the contract with the Python job', () => {
  // fixtures/calibration-results-from-job.json was written by jobs/calibration (`calibration.fit.run`)
  // from synthetic learners; it proves the importer accepts exactly what the job emits.
  it('accepts a results file produced by jobs/calibration', () => {
    const fromJob = JSON.parse(readFileSync(new URL('./fixtures/calibration-results-from-job.json', import.meta.url), 'utf8')) as unknown;
    const parsed = parseCalibrationResults(fromJob);
    expect(parsed.library).toMatch(/^girth==0\.8\.0 numpy==\S+ scipy==\S+$/);
    expect(parsed.items.filter((item) => item.status === 'CALIBRATED')).toHaveLength(4);
    expect(parsed.items.filter((item) => item.status === 'PROVISIONAL').map((item) => item.statusReason)).toEqual(['TOO_FEW_RESPONSES']);
  });
});
