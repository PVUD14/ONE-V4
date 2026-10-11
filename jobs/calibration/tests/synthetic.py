"""Synthetic learners for the calibration tests (ENG-13).

Why this exists: parameter recovery can only be tested against items whose true difficulty and
discrimination are known, so learners with standard-normal ability answer items drawn from a
known 2PL model. No real person or item is involved; item ids are generated.
"""
from __future__ import annotations

import numpy as np

from calibration.fit import EXPORT_FORMAT

RUN_ID = "0e130000-0000-4000-8000-000000000001"


def item_key(index: int, source: str = "CAREER_READINESS_QUESTION") -> str:
    return f"{source}:0e13{index:04x}-0000-4000-8000-{index:012x}:1"


def simulate(
    discrimination: np.ndarray,
    difficulty: np.ndarray,
    learners: int,
    seed: int,
    missing_rate: float = 0.0,
    first_item: int = 0,
    first_learner: int = 1,
) -> list[list]:
    """Export rows [pseudonym, item, correct] for `learners` learners answering every item
    (or each item with probability 1 - missing_rate)."""
    rng = np.random.default_rng(seed)
    theta = rng.standard_normal(learners)
    probability = 1 / (1 + np.exp(-discrimination[:, None] * (theta[None, :] - difficulty[:, None])))
    answers = (rng.random(probability.shape) < probability).astype(int)
    asked = rng.random(probability.shape) >= missing_rate
    rows = []
    for column in range(learners):
        for row in range(len(difficulty)):
            if asked[row, column]:
                rows.append([f"L{first_learner + column}", item_key(first_item + row), int(answers[row, column])])
    return rows


def export_document(rows: list[list], run_id: str = RUN_ID) -> dict:
    return {"format": EXPORT_FORMAT, "runId": run_id, "exportedAt": "2026-09-28T00:00:00.000Z", "responses": rows}


# --- ENG-26: BKT learners --------------------------------------------------------------------

BKT_RUN_ID = "0e260000-0000-4000-8000-000000000001"


def skill_key(index: int) -> str:
    return f"0e26{index:04x}-0000-4000-8000-{index:012x}"


def simulate_bkt(parameters: tuple[float, float, float, float], learners: int, longest: int, seed: int,
                 skill: str) -> list[list]:
    """Export rows [skill, "0110..."] for `learners` learners each taking between longest/2 and
    longest opportunities on one skill, generated from known (L0, T, G, S) exactly as BKT assumes:
    known or not at the start, answer by slip/guess, then learn with probability T."""
    p_init, p_learn, p_guess, p_slip = parameters
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(learners):
        known = rng.random() < p_init
        observed = []
        for _ in range(int(rng.integers(max(2, longest // 2), longest + 1))):
            correct = (rng.random() >= p_slip) if known else (rng.random() < p_guess)
            observed.append("1" if correct else "0")
            if not known and rng.random() < p_learn:
                known = True
        rows.append([skill, "".join(observed)])
    return rows


def bkt_export_document(rows: list[list], run_id: str = BKT_RUN_ID) -> dict:
    return {"format": "one-bkt-export-v1", "runId": run_id, "exportedAt": "2026-10-01T00:00:00.000Z", "sequences": rows}


DIGEST = "0" * 64


def baseline_document(kind: str, rows: list[dict], run_id: str, previous_run_id: str | None = None) -> dict:
    collection = "items" if kind == "ITEM_2PL" else "skills"
    return {"format": "one-recalibration-baseline-v1", "kind": kind, "runId": run_id, "baselineDigest": DIGEST,
            "previousRunId": previous_run_id, collection: rows}


def item_baseline_rows(results: dict) -> list[dict]:
    """A previous run's results as the live calibrations the TypeScript baseline export would list."""
    return [{"itemSource": r["itemSource"], "itemId": r["itemId"], "itemVersion": r["itemVersion"], "runId": results["runId"],
             "status": r["status"], "difficulty": r["difficulty"], "discrimination": r["discrimination"],
             "responsesUsed": r["responsesUsed"]} for r in results["items"]]


def skill_baseline_rows(results: dict) -> list[dict]:
    """A previously accepted BKT run's FITTED skills, as the baseline export lists them."""
    return [{"skillId": r["skillId"], "parameters": r["parameters"], "standardErrors": r["standardErrors"]}
            for r in results["skills"] if r["status"] == "FITTED"]
