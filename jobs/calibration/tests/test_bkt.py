"""Tests for the BKT refit (ENG-26) on synthetic learners.

Why: the refit must recover known per-skill parameters, refuse to call a fit FITTED when it is
inadmissible (the five conditions packages/mastery-bkt enforces) or imprecise, keep the export
free of anything that links a sequence to a person, and be deterministic. Learners are generated
from known (L0, T, G, S) with tests/synthetic.py; no real person or skill is involved.

Tolerance: every fitted parameter lies within 3.5 of its own reported standard errors of the truth
(400 learners, 6-12 opportunities each). Observed with the pinned stack (2026-10-08): largest
|error| / SE 1.59.
"""
from __future__ import annotations

import math

import pytest

from calibration.bkt import (
    BKT_ALGORITHM_ID,
    BKT_RESULTS_FORMAT,
    PARAMETERS,
    BktExportError,
    admissible,
    fit_skills,
    log_likelihood,
    parse_bkt_export,
    run_bkt,
    _matrix,
)
from tests.synthetic import BKT_RUN_ID, bkt_export_document, simulate_bkt, skill_key

TRUE = [(0.36, 0.10, 0.30, 0.05), (0.25, 0.15, 0.20, 0.10), (0.50, 0.05, 0.25, 0.08), (0.30, 0.20, 0.15, 0.12)]


def population(seed: int, learners: int = 400, truth=TRUE) -> list[list]:
    rows = []
    for index, parameters in enumerate(truth):
        rows += simulate_bkt(parameters, learners, 12, seed + index, skill_key(index))
    return rows


def test_the_synthetic_truth_is_admissible():
    for parameters in TRUE:
        assert admissible(dict(zip(PARAMETERS, parameters)))


def test_admissibility_matches_mastery_bkt():
    defaults = {"pInit": 0.36, "pLearn": 0.1, "pGuess": 0.3, "pSlip": 0.05}
    assert admissible(defaults)
    assert not admissible({**defaults, "pGuess": 0.5})
    assert not admissible({**defaults, "pSlip": 0.5})
    assert not admissible({**defaults, "pLearn": 0.95})            # T >= 1 - S / (1 - G)
    assert not admissible({**defaults, "pInit": 0.1})              # below the wrong-answer fixed point 0.108
    assert not admissible({**defaults, "pInit": 0.0})


def test_the_likelihood_is_the_mastery_bkt_recursion():
    l0, t, g, s = 0.36, 0.1, 0.3, 0.05
    sequence = "0110"
    known, expected = l0, 0.0
    for symbol in sequence:
        correct = known * (1 - s) + (1 - known) * g
        expected += math.log(correct if symbol == "1" else 1 - correct)
        posterior = known * (1 - s) / correct if symbol == "1" else known * s / (1 - correct)
        known = posterior + (1 - posterior) * t
    observed, mask = _matrix([sequence, "1"])
    single = math.log(l0 * (1 - s) + (1 - l0) * g)
    assert log_likelihood((l0, t, g, s), observed, mask) == pytest.approx(expected + single, abs=1e-9)


def test_recovers_known_parameters_within_their_standard_errors():
    rows = fit_skills(parse_bkt_export(bkt_export_document(population(26))).sequences)
    assert [row["status"] for row in rows] == ["FITTED"] * 4
    for row, truth in zip(rows, TRUE):
        for name, true_value in zip(PARAMETERS, truth):
            error = abs(row["parameters"][name] - true_value)
            assert error <= 3.5 * row["standardErrors"][name] + 1e-4, (row["skillId"], name, error)
            assert row["standardErrors"][name] <= 0.1


def test_status_rule():
    few = simulate_bkt(TRUE[0], 20, 10, 1, skill_key(10))
    all_right = [[skill_key(11), "1111"]] * 150
    # Learners who start far below the wrong-answer fixed point: the fit is real but BKT under it
    # could let a wrong answer raise mastery, so the defaults stay.
    low_prior = simulate_bkt((0.03, 0.3, 0.2, 0.1), 400, 12, 2, skill_key(12))
    rows = {row["skillId"]: row for row in fit_skills([tuple(r) for r in few + all_right + low_prior])}
    assert rows[skill_key(10)]["statusReason"] == "TOO_FEW_LEARNERS"
    assert rows[skill_key(11)]["statusReason"] == "NO_VARIANCE"
    assert rows[skill_key(12)]["statusReason"] == "NOT_ADMISSIBLE"
    for row in rows.values():
        assert row["status"] == "DEFAULT" and row["parameters"] is None and row["standardErrors"] is None


def test_run_is_deterministic_and_carries_no_learner():
    export = parse_bkt_export(bkt_export_document(population(7, learners=150)))
    first = run_bkt(export, generated_at="2026-10-01T00:00:00Z", library="numpy==x scipy==y")
    second = run_bkt(export, generated_at="2026-10-01T00:00:00Z", library="numpy==x scipy==y")
    assert first == second
    assert first["format"] == BKT_RESULTS_FORMAT and first["algorithmId"] == BKT_ALGORITHM_ID
    assert first["runId"] == BKT_RUN_ID and first["skillsRead"] == 4 and first["sequencesRead"] == 600
    assert set(first["skills"][0]) == {"skillId", "learners", "observations", "status", "statusReason", "parameters", "standardErrors"}


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(learner="L1"),
        lambda d: d.update(format="one-calibration-export-v1"),
        lambda d: d.update(runId="NOT-A-UUID"),
        lambda d: d["sequences"].append(["L1", skill_key(0), "01"]),
        lambda d: d["sequences"].append([skill_key(0), "01x"]),
        lambda d: d["sequences"].append([skill_key(0), ""]),
        lambda d: d["sequences"].append(["someone@example.test", "01"]),
    ],
)
def test_a_malformed_export_is_refused(mutate):
    document = bkt_export_document([[skill_key(0), "0101"]])
    mutate(document)
    with pytest.raises(BktExportError):
        parse_bkt_export(document)
