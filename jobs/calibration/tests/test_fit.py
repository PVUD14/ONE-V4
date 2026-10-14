"""Tests for the 2PL calibration (ENG-13) on synthetic learners.

Why: the acceptance criterion is that the job recovers known item parameters within a stated
tolerance, and that items with too few responses stay PROVISIONAL. Tolerances (seeded, so the run
is reproducible):
  * 2,000 learners answering all 20 items: RMSE(b) <= 0.15, RMSE(a) <= 0.20,
    max |b error| <= 0.35, max |a error| <= 0.45;
  * the same with 30% of responses missing (about 1,400 per item): RMSE(b) <= 0.20, RMSE(a) <= 0.25.
Observed with the pinned stack (2026-09-28): RMSE(b) 0.057 / 0.109, RMSE(a) 0.090 / 0.158.
"""
from __future__ import annotations

import json

import numpy as np
import pytest

from calibration.fit import (
    ALGORITHM_ID,
    RESULTS_FORMAT,
    ExportError,
    calibrate,
    parse_export,
    provisional_difficulty,
    run,
)
from tests.synthetic import export_document, item_key, simulate

SEED = 20260928


def true_parameters(items: int, seed: int = SEED) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    return rng.uniform(0.8, 2.0, items), rng.uniform(-2.0, 2.0, items)


def fitted(results: list[dict]) -> dict[str, dict]:
    return {f"{r['itemSource']}:{r['itemId']}:{r['itemVersion']}": r for r in results}


def errors(rows: dict[str, dict], a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ea = np.array([rows[item_key(i)]["discrimination"] - a[i] for i in range(len(a))])
    eb = np.array([rows[item_key(i)]["difficulty"] - b[i] for i in range(len(b))])
    return ea, eb


def rmse(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(values ** 2)))


def test_recovers_known_item_parameters_within_tolerance():
    a, b = true_parameters(20)
    export = parse_export(export_document(simulate(a, b, learners=2000, seed=SEED)))
    rows = fitted(calibrate(export.responses))
    assert all(row["status"] == "CALIBRATED" and row["statusReason"] is None for row in rows.values())
    ea, eb = errors(rows, a, b)
    assert rmse(eb) <= 0.15, rmse(eb)
    assert rmse(ea) <= 0.20, rmse(ea)
    assert np.abs(eb).max() <= 0.35
    assert np.abs(ea).max() <= 0.45


def test_recovers_parameters_when_learners_answer_different_subsets():
    a, b = true_parameters(20, seed=SEED + 1)
    export = parse_export(export_document(simulate(a, b, learners=2000, seed=SEED + 1, missing_rate=0.3)))
    rows = fitted(calibrate(export.responses))
    assert all(row["status"] == "CALIBRATED" for row in rows.values())
    ea, eb = errors(rows, a, b)
    assert rmse(eb) <= 0.20, rmse(eb)
    assert rmse(ea) <= 0.25, rmse(ea)


def test_items_with_too_few_responses_stay_provisional_and_do_not_disturb_the_rest():
    a, b = true_parameters(20)
    rows = simulate(a, b, learners=2000, seed=SEED)
    # Two new items answered by only 150 of the learners: below the 200 threshold.
    sparse = simulate(np.array([1.0, 1.5]), np.array([0.0, 1.0]), learners=150, seed=SEED + 2, first_item=100)
    results = fitted(calibrate(parse_export(export_document(rows + sparse)).responses, min_responses=200))
    for index in (100, 101):
        row = results[item_key(index)]
        assert row["status"] == "PROVISIONAL"
        assert row["statusReason"] == "TOO_FEW_RESPONSES"
        assert row["responsesUsed"] == 150
        assert row["discrimination"] == 1.0
    ea, eb = errors(results, a, b)
    assert rmse(eb) <= 0.15 and rmse(ea) <= 0.20


def test_the_threshold_is_the_boundary():
    a, b = true_parameters(5)
    rows = simulate(a, b, learners=300, seed=SEED)
    at = fitted(calibrate(parse_export(export_document(rows)).responses, min_responses=300))
    above = fitted(calibrate(parse_export(export_document(rows)).responses, min_responses=301))
    assert {row["status"] for row in at.values()} == {"CALIBRATED"}
    assert {(row["status"], row["statusReason"]) for row in above.values()} == {("PROVISIONAL", "TOO_FEW_RESPONSES")}


def test_an_item_everyone_answers_the_same_way_is_provisional():
    a, b = true_parameters(5)
    rows = simulate(a, b, learners=400, seed=SEED)
    rows += [[f"L{learner}", item_key(50), 1] for learner in range(1, 401)]
    results = fitted(calibrate(parse_export(export_document(rows)).responses))
    assert results[item_key(50)]["status"] == "PROVISIONAL"
    assert results[item_key(50)]["statusReason"] == "NO_VARIANCE"
    assert results[item_key(50)]["difficulty"] < -4.0 + 1e-9  # clamped prior: very easy
    assert {results[item_key(i)]["status"] for i in range(5)} == {"CALIBRATED"}


def test_fewer_than_three_fittable_items_are_not_fitted():
    a, b = true_parameters(2)
    results = calibrate(parse_export(export_document(simulate(a, b, learners=500, seed=SEED))).responses)
    assert [(row["status"], row["statusReason"]) for row in results] == [("PROVISIONAL", "TOO_FEW_ITEMS")] * 2


def test_an_estimate_outside_the_usable_range_is_stored_as_provisional():
    a, b = true_parameters(4)
    responses = parse_export(export_document(simulate(a, b, learners=300, seed=SEED))).responses

    def wild(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return np.array([1.2, -0.4, 1.0, float("nan")]), np.array([0.5, 0.0, 7.5, 0.0])

    results = calibrate(responses, fitter=wild)
    assert [(row["status"], row["statusReason"]) for row in results] == [
        ("CALIBRATED", None),
        ("PROVISIONAL", "ESTIMATE_OUT_OF_RANGE"),
        ("PROVISIONAL", "ESTIMATE_OUT_OF_RANGE"),
        ("PROVISIONAL", "ESTIMATE_OUT_OF_RANGE"),
    ]
    assert all(-4 <= row["difficulty"] <= 4 and 0.2 <= row["discrimination"] <= 4 for row in results)


def test_provisional_difficulty_is_a_smoothed_prior():
    assert provisional_difficulty(0, 0) == 0.0
    assert provisional_difficulty(10, 5) == 0.0
    assert provisional_difficulty(10, 9) < 0 < provisional_difficulty(10, 1)
    assert provisional_difficulty(100_000, 100_000) == -4.0
    assert provisional_difficulty(100_000, 0) == 4.0


def test_identical_input_gives_identical_output_and_no_learner_leaves_the_job():
    a, b = true_parameters(8)
    document = export_document(simulate(a, b, learners=600, seed=SEED))
    first = run(parse_export(document), generated_at="2026-09-28T00:00:00Z", library="girth==0.8.0")
    second = run(parse_export(json.loads(json.dumps(document))), generated_at="2026-09-28T00:00:00Z", library="girth==0.8.0")
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)

    assert first["format"] == RESULTS_FORMAT and first["algorithmId"] == ALGORITHM_ID
    assert set(first) == {"format", "runId", "algorithmId", "library", "minResponses", "exportedAt", "generatedAt",
                          "learnersRead", "responsesRead", "itemsRead", "items"}
    assert {key for item in first["items"] for key in item} == {
        "itemSource", "itemId", "itemVersion", "model", "difficulty", "discrimination", "responsesUsed", "status", "statusReason"}
    serialized = json.dumps(first)
    assert '"L1"' not in serialized and "L1," not in serialized
    assert first["learnersRead"] == 600
    assert first["responsesRead"] == sum(item["responsesUsed"] for item in first["items"])


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda d: d.update(format="other"), "format"),
        (lambda d: d.update(extra=1), "exactly the fields"),
        (lambda d: d.update(runId="not-a-uuid"), "runId"),
        (lambda d: d["responses"].append(["student@example.test", item_key(0), 1]), "pseudonym"),
        (lambda d: d["responses"].append(["0e130000-0000-4000-8000-000000000009", item_key(0), 1]), "pseudonym"),
        (lambda d: d["responses"].append(["L99", "question-7", 1]), "source:uuid:version"),
        (lambda d: d["responses"].append(["L99", item_key(0), 2]), "0 or 1"),
        (lambda d: d["responses"].append(["L99", item_key(0), True]), "0 or 1"),
        (lambda d: d["responses"].append(["L99", item_key(0), 1, "extra"]), "pseudonym, item, correct"),
        (lambda d: d["responses"].extend([["L99", item_key(0), 1], ["L99", item_key(0), 0]]), "only once"),
    ],
)
def test_a_malformed_or_identifying_export_is_refused(mutate, message):
    document = export_document([["L1", item_key(0), 1]])
    mutate(document)
    with pytest.raises(ExportError, match=message):
        parse_export(document)
