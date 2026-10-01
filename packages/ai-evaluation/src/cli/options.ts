/**
 * Command-line options shared by the bake-off commands (ENG-21): the cost assumptions, each one
 * overridable, so a report always says which numbers it assumed.
 */
import { defaultCostAssumptions, type CostAssumptions } from '../cost.js';

export function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function numberOption(argv: readonly string[], name: string, fallback: number): number {
  const raw = optionValue(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

/** --pod-usd-per-hour, --hints-per-student, --drafts-per-student, --checks-per-student, --utilisation, --inr-per-usd. */
export function costAssumptionsFromArgv(argv: readonly string[]): CostAssumptions {
  const base = defaultCostAssumptions;
  return {
    podUsdPerHour: numberOption(argv, '--pod-usd-per-hour', base.podUsdPerHour),
    requestsPerStudentMonth: {
      'tutor-hint': numberOption(argv, '--hints-per-student', base.requestsPerStudentMonth['tutor-hint']),
      'lesson-draft': numberOption(argv, '--drafts-per-student', base.requestsPerStudentMonth['lesson-draft']),
      'answer-check': numberOption(argv, '--checks-per-student', base.requestsPerStudentMonth['answer-check']),
    },
    utilisation: numberOption(argv, '--utilisation', base.utilisation),
    inrPerUsd: numberOption(argv, '--inr-per-usd', base.inrPerUsd),
  };
}
