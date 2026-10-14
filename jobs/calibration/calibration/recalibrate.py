"""Monthly recalibration and BKT refit proposals (ENG-26).

Why this exists: a refit is not adopted by being computed. This module joins a fit (ENG-13's 2PL
``run`` or the BKT ``run_bkt``) with the comparison against the parameters it would replace, into
one *proposal* file. The TypeScript side records the proposal as a PENDING run; only Divakar's
explicit accept puts item parameters into ``item_calibrations`` (and BKT parameters are only ever
recorded — ENG-27 / HG-5 own using them). Design: docs/architecture/recalibration-runs-table-design.md.

Pure: no database, network, clock or randomness.
"""
from __future__ import annotations

import re

from calibration.bkt import PARAMETERS, BktExport, run_bkt
from calibration.drift import compare_items, compare_skills
from calibration.fit import ITEM_SOURCES, CalibrationExport, run

BASELINE_FORMAT = "one-recalibration-baseline-v1"
PROPOSAL_FORMAT = "one-recalibration-proposal-v1"
KINDS = ("ITEM_2PL", "BKT")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


class BaselineError(ValueError):
    """The baseline file is not a well-formed baseline for this run."""


def _probability(value: object, where: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value < 1:
        raise BaselineError(f"{where} must be a probability strictly between 0 and 1")
    return float(value)


def _number(value: object, where: str, low: float, high: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not low <= value <= high:
        raise BaselineError(f"{where} must lie within [{low}, {high}]")
    return float(value)


def parse_baseline(document: object, kind: str, run_id: str) -> dict:
    """Strict, like the exports: exactly the documented fields, for the same run as the export."""
    if not isinstance(document, dict):
        raise BaselineError("baseline must be a JSON object")
    collection = "items" if kind == "ITEM_2PL" else "skills"
    expected = {"format", "kind", "runId", "baselineDigest", "previousRunId", collection}
    if set(document) != expected:
        raise BaselineError(f"baseline must have exactly the fields {sorted(expected)}")
    if document["format"] != BASELINE_FORMAT:
        raise BaselineError(f"baseline format must be {BASELINE_FORMAT}")
    if document["kind"] != kind:
        raise BaselineError(f"baseline kind must be {kind}")
    if document["runId"] != run_id:
        raise BaselineError("baseline and export must belong to the same run")
    if not isinstance(document["baselineDigest"], str) or not _DIGEST_RE.match(document["baselineDigest"]):
        raise BaselineError("baselineDigest must be a sha256 hex digest")
    previous = document["previousRunId"]
    if previous is not None and (not isinstance(previous, str) or not _UUID_RE.match(previous)):
        raise BaselineError("previousRunId must be a lower-case UUID or null")
    rows = document[collection]
    if not isinstance(rows, list):
        raise BaselineError(f"baseline {collection} must be a list")
    for index, row in enumerate(rows):
        where = f"baseline {collection}[{index}]"
        if kind == "ITEM_2PL":
            keys = {"itemSource", "itemId", "itemVersion", "runId", "status", "difficulty", "discrimination", "responsesUsed"}
            if not isinstance(row, dict) or set(row) != keys:
                raise BaselineError(f"{where} must have exactly the fields {sorted(keys)}")
            if row["itemSource"] not in ITEM_SOURCES or not _UUID_RE.match(str(row["itemId"])) or not _UUID_RE.match(str(row["runId"])):
                raise BaselineError(f"{where}: item identity is malformed")
            if not isinstance(row["itemVersion"], int) or row["itemVersion"] < 1:
                raise BaselineError(f"{where}: itemVersion must be a positive integer")
            if row["status"] not in ("PROVISIONAL", "CALIBRATED"):
                raise BaselineError(f"{where}: status must be PROVISIONAL or CALIBRATED")
            _number(row["difficulty"], f"{where}.difficulty", -4, 4)
            _number(row["discrimination"], f"{where}.discrimination", 0.2, 4)
            if not isinstance(row["responsesUsed"], int) or row["responsesUsed"] < 0:
                raise BaselineError(f"{where}: responsesUsed must be a non-negative integer")
        else:
            keys = {"skillId", "parameters", "standardErrors"}
            if not isinstance(row, dict) or set(row) != keys or not _UUID_RE.match(str(row["skillId"])):
                raise BaselineError(f"{where} must be {{skillId, parameters, standardErrors}}")
            for group in ("parameters", "standardErrors"):
                if not isinstance(row[group], dict) or set(row[group]) != set(PARAMETERS):
                    raise BaselineError(f"{where}.{group} must name exactly {list(PARAMETERS)}")
                for name in PARAMETERS:
                    if group == "parameters":
                        _probability(row[group][name], f"{where}.{group}.{name}")
                    else:
                        _number(row[group][name], f"{where}.{group}.{name}", 0, 1)
    return document


def item_proposal(export: CalibrationExport, baseline: dict, generated_at: str, min_responses: int) -> dict:
    results = run(export, generated_at=generated_at, min_responses=min_responses)
    return {
        "format": PROPOSAL_FORMAT,
        "kind": "ITEM_2PL",
        "runId": export.run_id,
        "baselineDigest": baseline["baselineDigest"],
        "previousRunId": baseline["previousRunId"],
        "results": results,
        "report": compare_items(baseline, results),
    }


def bkt_proposal(export: BktExport, baseline: dict, generated_at: str, min_learners: int) -> dict:
    results = run_bkt(export, generated_at=generated_at, min_learners=min_learners)
    return {
        "format": PROPOSAL_FORMAT,
        "kind": "BKT",
        "runId": export.run_id,
        "baselineDigest": baseline["baselineDigest"],
        "previousRunId": baseline["previousRunId"],
        "results": results,
        "report": compare_skills(baseline, results),
    }
