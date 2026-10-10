/**
 * Cost per student from the pod's price and the throughput a bake-off run measured (ENG-21).
 *
 * Why this exists: the plan's target is under ₹10 of AI cost per student. The pod is billed by the
 * hour whether busy or idle, so the honest figure is pod time per request (measured: a batch's wall
 * time divided by its requests, at the run's concurrency), scaled by how many requests a student
 * makes and by how much of the paid time does work. The usage figures are assumptions, labelled as
 * such everywhere they appear; every one is an option of the commands.
 *
 * Design: docs/architecture/ai-bake-off-design.md (Decision 6).
 */
import type { BatchResult } from './results.js';
import { evaluationTasks, type EvaluationTask } from './set-format.js';

export interface CostAssumptions {
  /** The pod's price (ADR-047: an RTX A6000 on RunPod). A fact, not an assumption. */
  readonly podUsdPerHour: number;
  /** Requests per active student per month, per feature. Assumptions. */
  readonly requestsPerStudentMonth: Readonly<Record<EvaluationTask, number>>;
  /** Share of paid pod time doing work. Assumption. */
  readonly utilisation: number;
  /** Rupees per US dollar. Assumption. */
  readonly inrPerUsd: number;
}

export const defaultCostAssumptions: CostAssumptions = {
  podUsdPerHour: 0.57,
  // ADR-052: explanations a student asks for in a month (an assumption; cache hits cost nothing, so this is high).
  requestsPerStudentMonth: { 'tutor-hint': 100, 'lesson-draft': 0.1, 'answer-check': 0.2, 'explain-topic': 4 },
  utilisation: 0.3,
  inrPerUsd: 85,
};

export interface CostEstimate {
  readonly assumptions: CostAssumptions;
  /** Measured pod seconds per request, for each feature the run measured. */
  readonly secondsPerRequest: Readonly<Partial<Record<EvaluationTask, number>>>;
  readonly inrPerRequest: Readonly<Partial<Record<EvaluationTask, number>>>;
  /** Σ requests × cost ÷ utilisation, in rupees, per active student per month. */
  readonly inrPerStudentMonth: number;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function validateCostAssumptions(assumptions: CostAssumptions): void {
  const positive = [assumptions.podUsdPerHour, assumptions.inrPerUsd, assumptions.utilisation];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0) || assumptions.utilisation > 1) {
    throw new Error('cost assumptions: price and rate must be positive; utilisation must be in (0, 1]');
  }
  if (Object.values(assumptions.requestsPerStudentMonth).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('cost assumptions: requests per student must be zero or more');
  }
}

export function estimateCost(batches: readonly BatchResult[], assumptions: CostAssumptions = defaultCostAssumptions): CostEstimate {
  validateCostAssumptions(assumptions);
  // The features this run measured (one set covers the first three, ADR-052's covers explain-topic): each
  // set's cost is its own features' share of a student's month.
  const tasks = evaluationTasks.filter((task) => batches.some((entry) => entry.task === task));
  if (!tasks.length) throw new Error('no batch to measure');
  const secondsPerRequest: Partial<Record<EvaluationTask, number>> = {};
  const inrPerRequest: Partial<Record<EvaluationTask, number>> = {};
  let monthly = 0;
  for (const task of tasks) {
    const batch = batches.find((entry) => entry.task === task)!;
    const seconds = batch.wallSeconds / batch.cases;
    const inr = (assumptions.podUsdPerHour / 3600) * seconds * assumptions.inrPerUsd;
    secondsPerRequest[task] = round(seconds, 4);
    inrPerRequest[task] = round(inr, 6);
    monthly += assumptions.requestsPerStudentMonth[task] * inr;
  }
  return { assumptions, secondsPerRequest, inrPerRequest, inrPerStudentMonth: round(monthly / assumptions.utilisation, 4) };
}

/** One line for an evaluation note: what the cost figure assumed. */
const usageNames: Readonly<Record<EvaluationTask, string>> = { 'tutor-hint': 'hints', 'lesson-draft': 'drafts', 'answer-check': 'checks', 'explain-topic': 'explanations' };

/** One line for an evaluation note: what the cost figure assumed, for the features it covered (v1's three by default). */
export function describeCostAssumptions(assumptions: CostAssumptions, tasks: readonly EvaluationTask[] = ['tutor-hint', 'lesson-draft', 'answer-check']): string {
  const usage = assumptions.requestsPerStudentMonth;
  return `cost assumes $${assumptions.podUsdPerHour}/h, ${tasks.map((task) => `${usage[task]} ${usageNames[task]}`).join(' + ')} per student-month, utilisation ${assumptions.utilisation}, Rs ${assumptions.inrPerUsd}/USD`;
}

/** The features a cost estimate measured, in task order. */
export function costTasks(estimate: CostEstimate): readonly EvaluationTask[] {
  return evaluationTasks.filter((task) => estimate.secondsPerRequest[task] !== undefined);
}
