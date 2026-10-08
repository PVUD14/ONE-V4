"""Stability and drift tests for the monthly recalibration and the BKT refit (ENG-26).

Why: ENG-26's acceptance is that, on synthetic data, parameters stay within the stability bounds
across runs, or the report flags which items drifted. Each case fits two independent populations
(a harsher test than real months, which share most of their attempt log): drawn from the same
known parameters, every comparison must be STABLE; with some items or skills perturbed, exactly
those must be flagged DRIFTED. The report must carry no learner and nothing about readiness.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from calibration.bkt import parse_bkt_export, run_bkt
from calibration.drift import BKT_BOUNDS, ITEM_BOUNDS, compare_parameter, drifted_keys, twopl_standard_errors
from calibration.fit import parse_export, run
from calibration.recalibrate import BaselineError, bkt_proposal, item_proposal, parse_baseline
from tests.synthetic import (
    BKT_RUN_ID,
    DIGEST,
    RUN_ID,
    baseline_document,
    bkt_export_document,
    export_document,
    item_baseline_rows,
    item_key,
    simulate,
    simulate_bkt,
    skill_baseline_rows,
    skill_key,
)

JOB_ROOT = Path(__file__).resolve().parents[1]
NEXT_RUN = "0e260000-0000-4000-8000-0000000000a2"
GENERATED = "2026-10-01T00:00:00Z"

rng = np.random.default_rng(2026)
A = rng.uniform(0.8, 2.0, 12)
B = rng.uniform(-1.2, 1.2, 12)
SKILLS = [(0.36, 0.10, 0.30, 0.05), (0.25, 0.15, 0.20, 0.10), (0.50, 0.05, 0.25, 0.08), (0.30, 0.20, 0.15, 0.12)]


def item_results(a: np.ndarray, b: np.ndarray, seed: int, run_id: str) -> dict:
    export = parse_export(export_document(simulate(a, b, learners=600, seed=seed), run_id=run_id))
    return run(export, generated_at=GENERATED, library="girth==test")


def item_report(previous: dict, a: np.ndarray, b: np.ndarray, seed: int) -> dict:
    export = parse_export(export_document(simulate(a, b, learners=600, seed=seed), run_id=NEXT_RUN))
    baseline = parse_baseline(baseline_document("ITEM_2PL", item_baseline_rows(previous), NEXT_RUN, previous["runId"]),
                              "ITEM_2PL", NEXT_RUN)
    return item_proposal(export, baseline, GENERATED, 200)


def bkt_population(seed: int, truth=SKILLS, run_id: str = BKT_RUN_ID) -> dict:
    rows = []
    for index, parameters in enumerate(truth):
        rows += simulate_bkt(parameters, 400, 12, seed + index, skill_key(index))
    return bkt_export_document(rows, run_id=run_id)


def bkt_report(previous: dict, truth, seed: int) -> dict:
    export = parse_bkt_export(bkt_population(seed, truth, NEXT_RUN))
    baseline = parse_baseline(baseline_document("BKT", skill_baseline_rows(previous), NEXT_RUN, previous["runId"]), "BKT", NEXT_RUN)
    return bkt_proposal(export, baseline, GENERATED, 100)


@pytest.fixture(scope="module")
def previous_items() -> dict:
    return item_results(A, B, seed=11, run_id=RUN_ID)


@pytest.fixture(scope="module")
def previous_skills() -> dict:
    return run_bkt(parse_bkt_export(bkt_population(31)), generated_at=GENERATED, library="numpy==test")


FORBIDDEN_KEYS = {"learner", "learnerId", "pseudonym", "user", "userId", "subjectUserId", "subjectKey", "email", "institutionId"}


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


def assert_clean(document: dict) -> None:
    """No learner pseudonym, e-mail or person key, and nothing about readiness."""
    text = json.dumps(document)
    assert not re.search(r'"L[1-9][0-9]*"', text)
    assert "@" not in text
    # The only "readiness" allowed is the name of the question bank an item comes from.
    assert "readiness" not in text.replace("CAREER_READINESS_QUESTION", "").lower()
    assert not (_keys(document) & FORBIDDEN_KEYS)


def test_items_refitted_from_the_same_parameters_stay_within_bounds(previous_items):
    proposal = item_report(previous_items, A, B, seed=12)
    report = proposal["report"]
    assert report["verdict"] == "STABLE"
    assert report["counts"]["STABLE"] == 12 and report["counts"]["DRIFTED"] == 0
    assert report["bounds"] == ITEM_BOUNDS
    for unit in report["units"]:
        for parameter in unit["parameters"]:
            assert abs(parameter["change"]) <= parameter["tolerance"]
    assert proposal["results"]["runId"] == NEXT_RUN and proposal["previousRunId"] == RUN_ID
    assert_clean(proposal)


def test_items_from_a_perturbed_population_are_flagged_exactly(previous_items):
    b, a = B.copy(), A.copy()
    shifted = [int(i) for i in np.argsort(np.abs(B))[:3]]  # three mid-difficulty items, harder by a logit
    b[shifted] += 1.0
    steeper = int(np.argsort(np.abs(B))[3])
    a[steeper] = min(a[steeper] * 2.5, 3.9)
    report = item_report(previous_items, a, b, seed=13)["report"]
    assert report["verdict"] == "DRIFTED"
    assert sorted(drifted_keys(report)) == sorted(item_key(i) for i in shifted + [steeper])
    by_key = {unit["key"]: unit for unit in report["units"]}
    for index in shifted:
        difficulty = by_key[item_key(index)]["parameters"][0]
        assert difficulty["name"] == "difficulty" and difficulty["drifted"] and difficulty["change"] > 0
    assert by_key[item_key(steeper)]["parameters"][1]["drifted"]


def test_item_status_changes_are_reported_not_compared(previous_items):
    rows = item_baseline_rows(previous_items)
    rows[0] = {**rows[0], "status": "PROVISIONAL"}          # was provisional, now calibrated
    rows = [row for row in rows if row["itemId"] != rows[1]["itemId"]]  # never calibrated before
    extra = {**rows[2], "itemId": "0e26ffff-0000-4000-8000-00000000ffff"}  # live, but nobody answered it this month
    baseline = parse_baseline(baseline_document("ITEM_2PL", rows + [extra], NEXT_RUN), "ITEM_2PL", NEXT_RUN)
    export = parse_export(export_document(simulate(A, B, learners=600, seed=12), run_id=NEXT_RUN))
    report = item_proposal(export, baseline, GENERATED, 200)["report"]
    changes = {unit["key"]: unit["change"] for unit in report["units"]}
    assert changes[item_key(0)] == "NEWLY_CALIBRATED"
    assert changes[item_key(1)] == "NEW"
    assert changes[f"CAREER_READINESS_QUESTION:{extra['itemId']}:1"] == "NOT_REFITTED"
    # Raising the threshold above the month's responses loses every calibration: flagged, and live keeps the old fit.
    lost = item_proposal(export, baseline, GENERATED, 10_000)["report"]
    assert lost["counts"]["LOST_CALIBRATION"] == 10 and lost["verdict"] == "NO_COMPARISON"


def test_skills_refitted_from_the_same_parameters_stay_within_bounds(previous_skills):
    proposal = bkt_report(previous_skills, SKILLS, seed=41)
    report = proposal["report"]
    assert report["verdict"] == "STABLE" and report["counts"]["STABLE"] == 4
    assert report["bounds"] == BKT_BOUNDS
    for unit in report["units"]:
        assert unit["learners"] == 400
        for parameter in unit["parameters"]:
            assert abs(parameter["change"]) <= parameter["tolerance"]
    assert_clean(proposal)


def test_skills_from_a_perturbed_population_are_flagged_exactly(previous_skills):
    truth = list(SKILLS)
    truth[0] = (0.36, 0.10, 0.10, 0.05)   # guessing much harder
    truth[2] = (0.50, 0.05, 0.25, 0.25)   # slipping much more
    report = bkt_report(previous_skills, truth, seed=41)["report"]
    assert report["verdict"] == "DRIFTED"
    assert drifted_keys(report) == [skill_key(0), skill_key(2)]
    by_key = {unit["key"]: {p["name"]: p for p in unit["parameters"]} for unit in report["units"]}
    assert by_key[skill_key(0)]["pGuess"]["drifted"] and by_key[skill_key(0)]["pGuess"]["change"] < 0
    assert by_key[skill_key(2)]["pSlip"]["drifted"] and by_key[skill_key(2)]["pSlip"]["change"] > 0


def test_a_first_bkt_refit_has_nothing_to_drift_from():
    document = bkt_population(51, SKILLS[:1], NEXT_RUN)
    document["sequences"] += simulate_bkt(SKILLS[1], 3, 6, 5, skill_key(9))  # three learners only
    export = parse_bkt_export(document)
    baseline = parse_baseline(baseline_document("BKT", [], NEXT_RUN), "BKT", NEXT_RUN)
    report = bkt_proposal(export, baseline, GENERATED, 100)["report"]
    assert report["verdict"] == "NO_COMPARISON"
    units = {unit["key"]: unit for unit in report["units"]}
    assert units[skill_key(0)]["change"] == "NEW"
    assert units[skill_key(9)]["change"] == "NOT_CALIBRATED" and units[skill_key(9)]["learners"] == "<5"


def test_the_drift_rule_needs_both_noise_and_practical_size():
    # Within noise but above the floor: not drift. Above both: drift. Below the floor: never drift.
    assert not compare_parameter("difficulty", 0.0, 0.5, 0.2, 0.2, 0.3, 3.0)["drifted"]
    assert compare_parameter("difficulty", 0.0, 0.9, 0.2, 0.2, 0.3, 3.0)["drifted"]
    assert not compare_parameter("pGuess", 0.30, 0.34, 0.001, 0.001, 0.05, 3.0)["drifted"]
    ratio = compare_parameter("discrimination", 1.0, 2.0, 0.05, 0.1, 0.2231, 3.0, "log-ratio")
    assert ratio["drifted"] and ratio["change"] == pytest.approx(0.6931, abs=1e-4)


def test_standard_errors_shrink_with_responses():
    se_a_small, se_b_small = twopl_standard_errors(1.2, 0.0, 200)
    se_a_large, se_b_large = twopl_standard_errors(1.2, 0.0, 800)
    assert se_b_large == pytest.approx(se_b_small / 2, rel=1e-6)
    assert se_a_large == pytest.approx(se_a_small / 2, rel=1e-6)
    assert twopl_standard_errors(1.2, 0.0, 0) == (float("inf"), float("inf"))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(runId="0e260000-0000-4000-8000-0000000000ff"),
        lambda d: d.update(kind="BKT"),
        lambda d: d.update(baselineDigest="abc"),
        lambda d: d.update(extra=1),
        lambda d: d["items"].append({"itemSource": "CODE_TASK", "itemId": "x"}),
        lambda d: d["items"].append({**d["items"][0], "learner": "L1"}),
        lambda d: d["items"].append({**d["items"][0], "difficulty": 9}),
    ],
)
def test_a_malformed_baseline_is_refused(previous_items, mutate):
    document = baseline_document("ITEM_2PL", item_baseline_rows(previous_items), NEXT_RUN)
    mutate(document)
    with pytest.raises(BaselineError):
        parse_baseline(document, "ITEM_2PL", NEXT_RUN)


def _cli(tmp_path: Path, command: str, export: dict, baseline: dict, *extra: str) -> subprocess.CompletedProcess:
    (tmp_path / "export.json").write_text(json.dumps(export), encoding="utf-8")
    (tmp_path / "baseline.json").write_text(json.dumps(baseline), encoding="utf-8")
    return subprocess.run(
        [sys.executable, "-m", "calibration", command, "--in", str(tmp_path / "export.json"),
         "--baseline", str(tmp_path / "baseline.json"), "--out", str(tmp_path / "proposal.json"), *extra],
        cwd=JOB_ROOT, capture_output=True, text=True, check=False,
    )


def test_cli_recalibrate_writes_a_proposal_and_logs_counts_only(tmp_path: Path, previous_items):
    export = export_document(simulate(A, B, learners=600, seed=12), run_id=NEXT_RUN)
    baseline = baseline_document("ITEM_2PL", item_baseline_rows(previous_items), NEXT_RUN, RUN_ID)
    completed = _cli(tmp_path, "recalibrate", export, baseline)
    assert completed.returncode == 0, completed.stderr
    proposal = json.loads((tmp_path / "proposal.json").read_text(encoding="utf-8"))
    assert proposal["format"] == "one-recalibration-proposal-v1" and proposal["kind"] == "ITEM_2PL"
    assert proposal["baselineDigest"] == DIGEST and proposal["report"]["verdict"] == "STABLE"
    lines = [json.loads(line) for line in completed.stdout.strip().splitlines()]
    assert [line["event"] for line in lines] == ["engine.calibration.fitted", "engine.recalibration.compared"]
    assert "0e13" not in completed.stdout and "L1" not in completed.stdout


def test_cli_bkt_refit_writes_a_proposal_and_logs_counts_only(tmp_path: Path):
    export = bkt_population(61, SKILLS[:2], NEXT_RUN)
    completed = _cli(tmp_path, "bkt-refit", export, baseline_document("BKT", [], NEXT_RUN), "--min-learners", "50")
    assert completed.returncode == 0, completed.stderr
    proposal = json.loads((tmp_path / "proposal.json").read_text(encoding="utf-8"))
    assert proposal["kind"] == "BKT" and proposal["results"]["minLearners"] == 50
    assert {s["status"] for s in proposal["results"]["skills"]} == {"FITTED"}
    assert json.loads(completed.stdout.strip())["counts"]["NEW"] == 2
    assert skill_key(0) not in completed.stdout and skill_key(1) not in completed.stdout
    assert_clean(proposal)


def test_cli_refuses_a_baseline_for_another_run(tmp_path: Path):
    export = bkt_population(61, SKILLS[:1], NEXT_RUN)
    completed = _cli(tmp_path, "bkt-refit", export, baseline_document("BKT", [], BKT_RUN_ID))
    assert completed.returncode == 2
    assert not (tmp_path / "proposal.json").exists()
    assert json.loads(completed.stderr.strip())["reason"] == "BaselineError"
