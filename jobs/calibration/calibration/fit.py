"""The calibration itself: algorithm ``item-calibration-2pl-v1`` (ENG-13).

Why this exists: the placement test needs each item's difficulty (b) and discrimination (a) under
the two-parameter logistic model, P(correct | theta) = 1 / (1 + exp(-a * (theta - b))). They are
fitted here, offline, by marginal maximum likelihood (girth ``twopl_mml``) over a de-identified
export. The status rule and the provisional values are specified in
docs/architecture/item-calibrations-table-design.md; the database enforces the same bounds and
threshold, so a result this module gets wrong is refused on import rather than stored.

Everything here is deterministic for identical input: no clock (``generated_at`` is an argument),
no randomness, no I/O.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from importlib.metadata import version
from typing import Callable, Iterable, Sequence

import numpy as np

ALGORITHM_ID = "item-calibration-2pl-v1"
EXPORT_FORMAT = "one-calibration-export-v1"
RESULTS_FORMAT = "one-calibration-results-v1"
DEFAULT_MIN_RESPONSES = 200
MIN_ITEMS_FOR_FIT = 3
DIFFICULTY_BOUNDS = (-4.0, 4.0)
DISCRIMINATION_BOUNDS = (0.2, 4.0)
PROVISIONAL_DISCRIMINATION = 1.0
ITEM_SOURCES = ("CAREER_READINESS_QUESTION", "INSTITUTION_EXAM_QUESTION")

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_UUID_RE = re.compile(rf"^{_UUID}$")
_ITEM_RE = re.compile(rf"^({'|'.join(ITEM_SOURCES)}):({_UUID}):([1-9][0-9]{{0,8}})$")
_PSEUDONYM_RE = re.compile(r"^L[1-9][0-9]{0,8}$")

# A fitter takes an [items x learners] matrix (1, 0, or girth's INVALID_RESPONSE for "not asked")
# and returns (discrimination, difficulty) arrays. Injectable so tests can exercise the guards.
Fitter = Callable[[np.ndarray], "tuple[np.ndarray, np.ndarray]"]


class ExportError(ValueError):
    """The export file is not a well-formed, de-identified calibration export."""


@dataclass(frozen=True)
class Response:
    learner: str
    item: str
    correct: int


@dataclass(frozen=True)
class CalibrationExport:
    run_id: str
    exported_at: str
    responses: tuple[Response, ...]


def library_versions() -> str:
    """The pinned fitting stack, recorded on the run as provenance."""
    return " ".join(f"{name}=={version(name)}" for name in ("girth", "numpy", "scipy"))


def parse_export(document: object) -> CalibrationExport:
    """Validates the export strictly: exactly the documented fields, pseudonyms only, one response
    per learner and item. Anything that looks like more than that is refused, not ignored."""
    if not isinstance(document, dict):
        raise ExportError("export must be a JSON object")
    expected = {"format", "runId", "exportedAt", "responses"}
    if set(document) != expected:
        raise ExportError(f"export must have exactly the fields {sorted(expected)}")
    if document["format"] != EXPORT_FORMAT:
        raise ExportError(f"export format must be {EXPORT_FORMAT}")
    run_id = document["runId"]
    if not isinstance(run_id, str) or not _UUID_RE.match(run_id):
        raise ExportError("export runId must be a lower-case UUID")
    exported_at = document["exportedAt"]
    if not isinstance(exported_at, str) or not 1 <= len(exported_at) <= 64:
        raise ExportError("export exportedAt must be a timestamp")
    raw = document["responses"]
    if not isinstance(raw, list):
        raise ExportError("export responses must be a list")
    seen: set[tuple[str, str]] = set()
    responses = []
    for index, entry in enumerate(raw):
        if not (isinstance(entry, list) and len(entry) == 3):
            raise ExportError(f"response {index} must be [pseudonym, item, correct]")
        learner, item, correct = entry
        if not isinstance(learner, str) or not _PSEUDONYM_RE.match(learner):
            raise ExportError(f"response {index}: learner must be a per-run pseudonym like L1")
        if not isinstance(item, str) or not _ITEM_RE.match(item):
            raise ExportError(f"response {index}: item must be source:uuid:version")
        if correct not in (0, 1) or isinstance(correct, bool):
            raise ExportError(f"response {index}: correct must be 0 or 1")
        if (learner, item) in seen:
            raise ExportError(f"response {index}: a learner may answer an item only once in an export")
        seen.add((learner, item))
        responses.append(Response(learner, item, correct))
    return CalibrationExport(run_id, exported_at, tuple(responses))


def _clamp(value: float, bounds: tuple[float, float]) -> float:
    return min(max(value, bounds[0]), bounds[1])


def provisional_difficulty(responses: int, correct: int) -> float:
    """The difficulty at which an average learner (theta = 0) has the smoothed success rate
    (k + 1) / (n + 2), with a = 1 — a prior, not a fit. 0 when nobody has answered."""
    p = (correct + 1) / (responses + 2)
    return round(_clamp(-math.log(p / (1 - p)), DIFFICULTY_BOUNDS), 4)


def girth_twopl(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Joint 2PL fit by marginal maximum likelihood, standard-normal ability distribution."""
    from girth import twopl_mml  # imported here so the pure parts load without the library

    fitted = twopl_mml(matrix)
    return np.asarray(fitted["Discrimination"], dtype=float), np.asarray(fitted["Difficulty"], dtype=float)


def _in_bounds(value: float, bounds: tuple[float, float]) -> bool:
    return math.isfinite(value) and bounds[0] <= value <= bounds[1]


def _item_parts(item: str) -> tuple[str, str, int]:
    match = _ITEM_RE.match(item)
    assert match is not None  # parse_export already checked every key
    return match.group(1), match.group(2), int(match.group(3))


def calibrate(
    responses: Iterable[Response],
    min_responses: int = DEFAULT_MIN_RESPONSES,
    fitter: Fitter | None = None,
) -> list[dict]:
    """One row per item, sorted by item key, following the status rule in the design document."""
    if min_responses < 1:
        raise ValueError("min_responses must be at least 1")
    fitter = fitter or girth_twopl
    responses = list(responses)
    totals: dict[str, list[int]] = {}
    for response in responses:
        counts = totals.setdefault(response.item, [0, 0])
        counts[0] += 1
        counts[1] += response.correct

    items = sorted(totals)
    rows: dict[str, dict] = {}

    def provisional(item: str, reason: str) -> None:
        n, k = totals[item]
        rows[item] = _row(item, provisional_difficulty(n, k), PROVISIONAL_DISCRIMINATION, n, "PROVISIONAL", reason)

    eligible = []
    for item in items:
        n, k = totals[item]
        if n < min_responses:
            provisional(item, "TOO_FEW_RESPONSES")
        elif k == 0 or k == n:
            provisional(item, "NO_VARIANCE")
        else:
            eligible.append(item)

    if len(eligible) < MIN_ITEMS_FOR_FIT:
        for item in eligible:
            provisional(item, "TOO_FEW_ITEMS")
    elif eligible:
        from girth import INVALID_RESPONSE

        item_index = {item: row for row, item in enumerate(eligible)}
        learners = sorted({r.learner for r in responses if r.item in item_index}, key=lambda name: int(name[1:]))
        learner_index = {learner: column for column, learner in enumerate(learners)}
        matrix = np.full((len(eligible), len(learners)), INVALID_RESPONSE, dtype=int)
        for response in responses:
            row = item_index.get(response.item)
            if row is not None:
                matrix[row, learner_index[response.learner]] = response.correct
        discrimination, difficulty = fitter(matrix)
        for item, row in item_index.items():
            a = round(float(discrimination[row]), 4)
            b = round(float(difficulty[row]), 4)
            if _in_bounds(a, DISCRIMINATION_BOUNDS) and _in_bounds(b, DIFFICULTY_BOUNDS):
                rows[item] = _row(item, b, a, totals[item][0], "CALIBRATED", None)
            else:
                provisional(item, "ESTIMATE_OUT_OF_RANGE")

    return [rows[item] for item in items]


def _row(item: str, difficulty: float, discrimination: float, responses: int, status: str, reason: str | None) -> dict:
    source, item_id, item_version = _item_parts(item)
    return {
        "itemSource": source,
        "itemId": item_id,
        "itemVersion": item_version,
        "model": "2PL",
        "difficulty": difficulty,
        "discrimination": discrimination,
        "responsesUsed": responses,
        "status": status,
        "statusReason": reason,
    }


def run(
    export: CalibrationExport,
    generated_at: str,
    min_responses: int = DEFAULT_MIN_RESPONSES,
    fitter: Fitter | None = None,
    library: str | None = None,
) -> dict:
    """The results document for one run: provenance and counts, then items. Carries no learner."""
    items = calibrate(export.responses, min_responses, fitter)
    return {
        "format": RESULTS_FORMAT,
        "runId": export.run_id,
        "algorithmId": ALGORITHM_ID,
        "library": library or library_versions(),
        "minResponses": min_responses,
        "exportedAt": export.exported_at,
        "generatedAt": generated_at,
        "learnersRead": len({r.learner for r in export.responses}),
        "responsesRead": len(export.responses),
        "itemsRead": len(items),
        "items": items,
    }


def summarize(results: dict) -> dict:
    """Counts only, for the job log."""
    statuses: dict[str, int] = {}
    for item in results["items"]:
        label = item["status"] if item["statusReason"] is None else f"{item['status']}:{item['statusReason']}"
        statuses[label] = statuses.get(label, 0) + 1
    return {
        "event": "engine.calibration.fitted",
        "runId": results["runId"],
        "learners": results["learnersRead"],
        "responses": results["responsesRead"],
        "items": results["itemsRead"],
        "statuses": dict(sorted(statuses.items())),
    }


__all__: Sequence[str] = (
    "ALGORITHM_ID",
    "CalibrationExport",
    "DEFAULT_MIN_RESPONSES",
    "ExportError",
    "Response",
    "calibrate",
    "library_versions",
    "parse_export",
    "provisional_difficulty",
    "run",
    "summarize",
)
