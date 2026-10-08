"""Comparison of a refit with the parameters it would replace (ENG-26).

Why this exists: a monthly recalibration (2PL items) or BKT refit (skills) is only adopted after
Divakar reads what would change. This module turns (baseline, refit) into the machine-readable
comparison report the TypeScript side stores and renders. Pure: no clock, no I/O, no randomness.

Drift rule, for every parameter compared (design: docs/architecture/recalibration-runs-table-design.md):

    drifted  <=>  |proposed - previous| > max(practical floor, z * sqrt(SE_previous^2 + SE_proposed^2))

The floor is the smallest change that matters in use; the z-term is the change sampling noise alone
can produce. A change is called drift only when it is both larger than noise and large enough to
matter. Item discrimination is compared on the log scale (a ratio), everything else on its own
scale. The report carries parameters and counts only — never a learner, never readiness.
"""
from __future__ import annotations

import math
from typing import Iterable

import numpy as np
from numpy.polynomial.hermite_e import hermegauss

REPORT_FORMAT = "one-recalibration-report-v1"
# z for the noise term. BKT's standard errors come from the observed information and were measured
# well calibrated on synthetic refits (sd of the standardised change 0.94-1.04), so z = 3. The 2PL
# standard errors treat ability as known and were measured about 15-27% small (sd 1.14 for b, 1.27
# for log a over 400 independent refits), so the item z is raised in proportion, to 3.5.
BKT_Z = 3.0
ITEM_Z = 3.5
ITEM_DIFFICULTY_FLOOR = 0.3  # logits: at most 7.5 points of P(correct) for an average learner, a = 1
ITEM_DISCRIMINATION_LOG_FLOOR = round(math.log(1.25), 4)  # a 25% change in slope
BKT_PROBABILITY_FLOOR = 0.05  # five points on any BKT probability

ITEM_BOUNDS = {
    "z": ITEM_Z,
    "difficultyFloor": ITEM_DIFFICULTY_FLOOR,
    "discriminationLogRatioFloor": ITEM_DISCRIMINATION_LOG_FLOOR,
}
BKT_BOUNDS = {"z": BKT_Z, "probabilityFloor": BKT_PROBABILITY_FLOOR}

_NODES, _WEIGHTS = hermegauss(61)
_WEIGHTS = _WEIGHTS / math.sqrt(2 * math.pi)


def twopl_standard_errors(discrimination: float, difficulty: float, responses: int) -> tuple[float, float]:
    """Standard errors of (a, b) from the expected Fisher information of `responses` answers by
    learners of standard-normal ability (the distribution the MML fit assumes). It treats ability
    as known, so it understates the true error a little; the practical floors absorb that."""
    if responses < 1:
        return math.inf, math.inf
    a, b = discrimination, difficulty
    p = 1 / (1 + np.exp(-a * (_NODES - b)))
    w = _WEIGHTS * p * (1 - p)
    d = _NODES - b
    information = responses * np.array([[np.sum(w * d * d), -a * np.sum(w * d)], [-a * np.sum(w * d), a * a * np.sum(w)]])
    covariance = np.linalg.inv(information)
    return float(math.sqrt(covariance[0, 0])), float(math.sqrt(covariance[1, 1]))


def compare_parameter(name: str, previous: float, proposed: float, se_previous: float, se_proposed: float,
                      floor: float, z: float, scale: str = "absolute") -> dict:
    if scale == "log-ratio":
        delta = math.log(proposed / previous)
        se_previous, se_proposed = se_previous / previous, se_proposed / proposed
    else:
        delta = proposed - previous
    se_difference = math.sqrt(se_previous ** 2 + se_proposed ** 2)
    tolerance = max(floor, z * se_difference)
    return {
        "name": name,
        "scale": scale,
        "previous": round(previous, 4),
        "proposed": round(proposed, 4),
        "change": round(delta, 4),
        "seDifference": round(se_difference, 4),
        "tolerance": round(tolerance, 4),
        "drifted": abs(delta) > tolerance,
    }


def _counts(units: list[dict]) -> dict:
    counts = {change: 0 for change in CHANGES}
    for unit in units:
        counts[unit["change"]] += 1
    return counts


CHANGES = ("STABLE", "DRIFTED", "NEW", "NEWLY_CALIBRATED", "LOST_CALIBRATION", "NOT_REFITTED", "NOT_CALIBRATED")


def _verdict(counts: dict) -> str:
    if counts["DRIFTED"] > 0:
        return "DRIFTED"
    if counts["STABLE"] > 0:
        return "STABLE"
    return "NO_COMPARISON"


def _report(kind: str, run_id: str, algorithm_id: str, baseline: dict, bounds: dict, units: list[dict]) -> dict:
    counts = _counts(units)
    return {
        "format": REPORT_FORMAT,
        "kind": kind,
        "runId": run_id,
        "algorithmId": algorithm_id,
        "baselineDigest": baseline["baselineDigest"],
        "bounds": bounds,
        "verdict": _verdict(counts),
        "counts": counts,
        "units": units,
    }


def _item_key(row: dict) -> str:
    return f"{row['itemSource']}:{row['itemId'].lower()}:{row['itemVersion']}"


def compare_items(baseline: dict, results: dict) -> dict:
    """The 2PL comparison: each item of the refit against the item's live calibration (latest
    CALIBRATED, else latest PROVISIONAL — what the placement test reads today)."""
    previous = {_item_key(row): row for row in baseline["items"]}
    proposed = {_item_key(row): row for row in results["items"]}
    units = []
    for key in sorted(set(previous) | set(proposed)):
        old, new = previous.get(key), proposed.get(key)
        unit = {"key": key, "previousStatus": old["status"] if old else None,
                "proposedStatus": new["status"] if new else None, "parameters": []}
        if new is None:
            unit["change"] = "NOT_REFITTED"
        elif old is None:
            unit["change"] = "NEW" if new["status"] == "CALIBRATED" else "NOT_CALIBRATED"
        elif old["status"] == "CALIBRATED" and new["status"] == "CALIBRATED":
            se_a_old, se_b_old = twopl_standard_errors(old["discrimination"], old["difficulty"], old["responsesUsed"])
            se_a_new, se_b_new = twopl_standard_errors(new["discrimination"], new["difficulty"], new["responsesUsed"])
            unit["parameters"] = [
                compare_parameter("difficulty", old["difficulty"], new["difficulty"], se_b_old, se_b_new, ITEM_DIFFICULTY_FLOOR, ITEM_Z),
                compare_parameter("discrimination", old["discrimination"], new["discrimination"], se_a_old, se_a_new,
                                  ITEM_DISCRIMINATION_LOG_FLOOR, ITEM_Z, "log-ratio"),
            ]
            unit["change"] = "DRIFTED" if any(p["drifted"] for p in unit["parameters"]) else "STABLE"
        elif old["status"] == "CALIBRATED":
            unit["change"] = "LOST_CALIBRATION"
        elif new["status"] == "CALIBRATED":
            unit["change"] = "NEWLY_CALIBRATED"
        else:
            unit["change"] = "NOT_CALIBRATED"
        units.append(unit)
    return _report("ITEM_2PL", results["runId"], results["algorithmId"], baseline, ITEM_BOUNDS, units)


def _people(count: int) -> int | str:
    """The people rule the operations panels use: a count of 1-4 learners prints as "<5"."""
    return "<5" if 0 < count < 5 else count


def compare_skills(baseline: dict, results: dict) -> dict:
    """The BKT comparison: each skill of the refit against the last accepted BKT fit. A skill
    without one runs on the provisional defaults; there is nothing fitted to drift from."""
    previous = {row["skillId"]: row for row in baseline["skills"]}
    proposed = {row["skillId"]: row for row in results["skills"]}
    units = []
    for key in sorted(set(previous) | set(proposed)):
        old, new = previous.get(key), proposed.get(key)
        unit = {"key": key, "previousStatus": "FITTED" if old else None,
                "proposedStatus": new["status"] if new else None,
                "learners": _people(new["learners"]) if new else None, "parameters": []}
        if new is None:
            unit["change"] = "NOT_REFITTED"
        elif new["status"] != "FITTED":
            unit["change"] = "LOST_CALIBRATION" if old else "NOT_CALIBRATED"
        elif old is None:
            unit["change"] = "NEW"
        else:
            unit["parameters"] = [
                compare_parameter(name, old["parameters"][name], new["parameters"][name],
                                  old["standardErrors"][name], new["standardErrors"][name], BKT_PROBABILITY_FLOOR, BKT_Z)
                for name in ("pInit", "pLearn", "pGuess", "pSlip")
            ]
            unit["change"] = "DRIFTED" if any(p["drifted"] for p in unit["parameters"]) else "STABLE"
        units.append(unit)
    return _report("BKT", results["runId"], results["algorithmId"], baseline, BKT_BOUNDS, units)


def drifted_keys(report: dict) -> list[str]:
    return [unit["key"] for unit in report["units"] if unit["change"] == "DRIFTED"]


def summarize_report(report: dict) -> dict:
    """Counts only, for the job log."""
    return {"event": "engine.recalibration.compared", "kind": report["kind"], "runId": report["runId"],
            "verdict": report["verdict"], "counts": report["counts"]}


__all__: Iterable[str] = (
    "BKT_BOUNDS", "ITEM_BOUNDS", "REPORT_FORMAT", "compare_items", "compare_skills", "drifted_keys",
    "summarize_report", "twopl_standard_errors",
)
