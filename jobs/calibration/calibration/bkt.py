"""Offline BKT refit: algorithm ``bkt-fit-mle-v1`` (ENG-26).

Why this exists: ENG-06 runs Bayesian Knowledge Tracing in shadow with one cited, provisional
parameter set for every skill (packages/mastery-bkt). ENG-26 fits per-skill parameters from
consenting learners' de-identified observation sequences, so ENG-27 / HG-5 can later decide
whether to use them. This module only fits; it never decides adoption, and nothing it writes
reaches the live mastery or readiness path (docs/architecture/recalibration-runs-table-design.md).

The model is the one packages/mastery-bkt implements (Corbett & Anderson 1995; the recursion of
Baker, Corbett & Aleven 2008): P(L0), P(T), P(G), P(S), no forgetting, the learning step after the
evidence step. Parameters are fitted by maximum likelihood over every sequence of the skill
(the forward algorithm), with standard errors from the observed information. A fit is accepted
as FITTED only when it is admissible under the same five conditions mastery-bkt enforces and
precise enough to compare month to month; otherwise the skill keeps the defaults (DEFAULT).

Deterministic for identical input: fixed starting points, no clock (``generated_at`` is an
argument), no randomness, no I/O.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from importlib.metadata import version
from typing import Sequence

import numpy as np

BKT_ALGORITHM_ID = "bkt-fit-mle-v1"
BKT_EXPORT_FORMAT = "one-bkt-export-v1"
BKT_RESULTS_FORMAT = "one-bkt-fit-results-v1"
DEFAULT_MIN_LEARNERS = 100
# A fitted probability whose standard error exceeds this is too imprecise to use or to compare
# month to month: its 95% interval would be wider than +/- 0.2.
MAX_STANDARD_ERROR = 0.1
MAX_SEQUENCE_LENGTH = 10_000
PARAMETERS = ("pInit", "pLearn", "pGuess", "pSlip")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SEQUENCE_RE = re.compile(r"^[01]+$")
_EPSILON = 1e-12


class BktExportError(ValueError):
    """The file is not a well-formed, de-identified BKT export."""


@dataclass(frozen=True)
class BktExport:
    run_id: str
    exported_at: str
    # (skill id, observations) — one learner's ordered sequence on one skill. No learner key at all:
    # the fit treats every sequence independently, so nothing links two sequences to one person.
    sequences: tuple[tuple[str, str], ...]


def library_versions() -> str:
    return " ".join(f"{name}=={version(name)}" for name in ("numpy", "scipy"))


def parse_bkt_export(document: object) -> BktExport:
    """Strict: exactly the documented fields, skill ids and 0/1 strings only."""
    if not isinstance(document, dict):
        raise BktExportError("export must be a JSON object")
    expected = {"format", "runId", "exportedAt", "sequences"}
    if set(document) != expected:
        raise BktExportError(f"export must have exactly the fields {sorted(expected)}")
    if document["format"] != BKT_EXPORT_FORMAT:
        raise BktExportError(f"export format must be {BKT_EXPORT_FORMAT}")
    run_id = document["runId"]
    if not isinstance(run_id, str) or not _UUID_RE.match(run_id):
        raise BktExportError("export runId must be a lower-case UUID")
    exported_at = document["exportedAt"]
    if not isinstance(exported_at, str) or not 1 <= len(exported_at) <= 64:
        raise BktExportError("export exportedAt must be a timestamp")
    raw = document["sequences"]
    if not isinstance(raw, list):
        raise BktExportError("export sequences must be a list")
    sequences = []
    for index, entry in enumerate(raw):
        if not (isinstance(entry, list) and len(entry) == 2):
            raise BktExportError(f"sequence {index} must be [skillId, observations]")
        skill, observed = entry
        if not isinstance(skill, str) or not _UUID_RE.match(skill):
            raise BktExportError(f"sequence {index}: skill must be a lower-case UUID")
        if not isinstance(observed, str) or not _SEQUENCE_RE.match(observed) or len(observed) > MAX_SEQUENCE_LENGTH:
            raise BktExportError(f"sequence {index}: observations must be a string of 0 and 1")
        sequences.append((skill, observed))
    return BktExport(run_id, exported_at, tuple(sequences))


def wrong_answer_fixed_point(p: dict) -> float:
    return (1 - p["pGuess"]) * p["pLearn"] / (1 - p["pGuess"] - p["pSlip"])


def admissible(p: dict) -> bool:
    """The five conditions packages/mastery-bkt's validateParameters enforces (ENG-06 design)."""
    values = [p[name] for name in PARAMETERS]
    if not all(math.isfinite(v) and 0 < v < 1 for v in values):
        return False
    g, s, t, l0 = p["pGuess"], p["pSlip"], p["pLearn"], p["pInit"]
    if g >= 0.5 or s >= 0.5 or g + s >= 1:
        return False
    if t >= 1 - s / (1 - g):
        return False
    return l0 > wrong_answer_fixed_point(p)


def _matrix(sequences: Sequence[str]) -> tuple[np.ndarray, np.ndarray]:
    longest = max(len(s) for s in sequences)
    observed = np.zeros((len(sequences), longest), dtype=float)
    mask = np.zeros((len(sequences), longest), dtype=bool)
    for row, sequence in enumerate(sequences):
        observed[row, : len(sequence)] = [1.0 if c == "1" else 0.0 for c in sequence]
        mask[row, : len(sequence)] = True
    return observed, mask


def log_likelihood(p: Sequence[float], observed: np.ndarray, mask: np.ndarray) -> float:
    """Total log-likelihood of every sequence under BKT with p = (L0, T, G, S) — the forward
    algorithm, which for a two-state chain is exactly mastery-bkt's update applied step by step."""
    l0, t, g, s = p
    known = np.full(observed.shape[0], l0)
    total = 0.0
    for step in range(observed.shape[1]):
        o, m = observed[:, step], mask[:, step]
        correct = np.clip(known * (1 - s) + (1 - known) * g, _EPSILON, 1 - _EPSILON)
        total += float(np.sum(np.where(m, np.where(o == 1, np.log(correct), np.log(1 - correct)), 0.0)))
        posterior = np.where(o == 1, known * (1 - s) / correct, known * s / (1 - correct))
        known = np.where(m, posterior + (1 - posterior) * t, known)
    return total


# Unconstrained coordinates: L0 and T on (0, 1), G and S on (0, 0.5) — the half-unit box keeps
# the fit away from the "known means mostly wrong" mirror solution (Baker et al. 2008's bound).
_SCALE = np.array([1.0, 1.0, 0.5, 0.5])


def _to_probabilities(x: np.ndarray) -> np.ndarray:
    return _SCALE / (1 + np.exp(-x))


def _to_unconstrained(p: np.ndarray) -> np.ndarray:
    q = p / _SCALE
    return np.log(q / (1 - q))


# Four fixed starts spanning low/high guess and slip; the best likelihood wins. (Sixteen starts that
# also varied P(L0) and P(T) found the same optimum on every synthetic population tried.)
_STARTS = [np.array([0.4, 0.1, g, s]) for g in (0.1, 0.3) for s in (0.05, 0.2)]


def _hessian(f, x: np.ndarray, h: float = 1e-3) -> np.ndarray:
    n = len(x)
    out = np.zeros((n, n))
    for i in range(n):
        for j in range(i, n):
            ei, ej = np.eye(n)[i] * h, np.eye(n)[j] * h
            value = (f(x + ei + ej) - f(x + ei - ej) - f(x - ei + ej) + f(x - ei - ej)) / (4 * h * h)
            out[i, j] = out[j, i] = value
    return out


def fit_skill(sequences: Sequence[str]) -> tuple[dict, dict | None]:
    """Maximum-likelihood parameters and their standard errors (None when the observed
    information is not positive definite — the likelihood is flat in some direction)."""
    from scipy.optimize import minimize  # imported here so the pure parts load without scipy

    observed, mask = _matrix(sequences)

    def objective(x: np.ndarray) -> float:
        return -log_likelihood(_to_probabilities(x), observed, mask)

    best = None
    for start in _STARTS:
        found = minimize(objective, _to_unconstrained(start), method="BFGS", options={"gtol": 1e-6, "maxiter": 500})
        if best is None or found.fun < best.fun - 1e-9:
            best = found
    assert best is not None
    x = best.x
    p = _to_probabilities(x)
    parameters = dict(zip(PARAMETERS, (float(v) for v in p)))
    information = _hessian(objective, x)
    if not np.all(np.isfinite(information)) or np.min(np.linalg.eigvalsh(information)) <= 0:
        return parameters, None
    covariance = np.linalg.inv(information)
    q = p / _SCALE
    jacobian = _SCALE * q * (1 - q)  # dp/dx, the delta method back to probabilities
    errors = jacobian * np.sqrt(np.clip(np.diag(covariance), 0, None))
    return parameters, dict(zip(PARAMETERS, (float(v) for v in errors)))


def _round(value: float) -> float:
    return round(value, 4)


def fit_skills(sequences: Sequence[tuple[str, str]], min_learners: int = DEFAULT_MIN_LEARNERS) -> list[dict]:
    """One row per skill, sorted by skill id, following the status rule in the design note."""
    if min_learners < 1:
        raise ValueError("min_learners must be at least 1")
    by_skill: dict[str, list[str]] = {}
    for skill, observed in sequences:
        by_skill.setdefault(skill, []).append(observed)
    rows = []
    for skill in sorted(by_skill):
        group = sorted(by_skill[skill])
        observations = sum(len(s) for s in group)
        correct = sum(s.count("1") for s in group)
        row = {"skillId": skill, "learners": len(group), "observations": observations,
               "status": "DEFAULT", "statusReason": None, "parameters": None, "standardErrors": None}
        if len(group) < min_learners:
            row["statusReason"] = "TOO_FEW_LEARNERS"
        elif correct in (0, observations):
            row["statusReason"] = "NO_VARIANCE"
        else:
            parameters, errors = fit_skill(group)
            rounded = {name: _round(value) for name, value in parameters.items()}
            if not admissible(rounded):
                row["statusReason"] = "NOT_ADMISSIBLE"
            elif errors is None or not all(math.isfinite(e) and e <= MAX_STANDARD_ERROR for e in errors.values()):
                row["statusReason"] = "IMPRECISE"
            else:
                row.update(status="FITTED", parameters=rounded,
                           standardErrors={name: _round(value) for name, value in errors.items()})
        rows.append(row)
    return rows


def run_bkt(export: BktExport, generated_at: str, min_learners: int = DEFAULT_MIN_LEARNERS, library: str | None = None) -> dict:
    """The results document for one BKT refit: provenance and counts, then skills. No learner."""
    skills = fit_skills(export.sequences, min_learners)
    return {
        "format": BKT_RESULTS_FORMAT,
        "runId": export.run_id,
        "algorithmId": BKT_ALGORITHM_ID,
        "library": library or library_versions(),
        "minLearners": min_learners,
        "exportedAt": export.exported_at,
        "generatedAt": generated_at,
        "sequencesRead": len(export.sequences),
        "observationsRead": sum(len(s) for _, s in export.sequences),
        "skillsRead": len(skills),
        "skills": skills,
    }
