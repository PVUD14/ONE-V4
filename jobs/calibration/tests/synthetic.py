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
