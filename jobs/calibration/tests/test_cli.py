"""End-to-end test of ``python -m calibration fit`` (ENG-13).

Why: the systemd run calls the module as a process; this proves the file contract the
TypeScript importer validates — a results file with provenance and items, counts-only logging,
and a refused export exiting non-zero without writing results.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from tests.synthetic import RUN_ID, export_document, simulate

JOB_ROOT = Path(__file__).resolve().parents[1]


def fit(tmp_path: Path, document: dict, *extra: str) -> subprocess.CompletedProcess:
    source = tmp_path / "export.json"
    source.write_text(json.dumps(document), encoding="utf-8")
    return subprocess.run(
        [sys.executable, "-m", "calibration", "fit", "--in", str(source), "--out", str(tmp_path / "results.json"), *extra],
        cwd=JOB_ROOT, capture_output=True, text=True, check=False,
    )


def test_fit_writes_results_and_logs_counts_only(tmp_path: Path):
    rng = np.random.default_rng(3)
    rows = simulate(rng.uniform(0.8, 2.0, 6), rng.uniform(-1.5, 1.5, 6), learners=400, seed=3)
    completed = fit(tmp_path, export_document(rows), "--min-responses", "250")
    assert completed.returncode == 0, completed.stderr
    results = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))
    assert results["runId"] == RUN_ID
    assert results["minResponses"] == 250
    assert results["library"].startswith("girth==0.8.0 numpy==")
    assert results["generatedAt"].endswith("Z")
    assert {item["status"] for item in results["items"]} == {"CALIBRATED"}
    log = json.loads(completed.stdout.strip())
    assert log == {"event": "engine.calibration.fitted", "runId": RUN_ID, "learners": 400, "responses": 2400,
                   "items": 6, "statuses": {"CALIBRATED": 6}}
    assert "L1" not in completed.stdout


def test_an_empty_export_fits_nothing(tmp_path: Path):
    completed = fit(tmp_path, export_document([]))
    assert completed.returncode == 0, completed.stderr
    results = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))
    assert results["items"] == [] and results["learnersRead"] == 0 and results["responsesRead"] == 0


def test_a_refused_export_exits_non_zero_and_writes_nothing(tmp_path: Path):
    document = export_document([["someone@example.test", "x", 1]])
    completed = fit(tmp_path, document)
    assert completed.returncode == 2
    assert not (tmp_path / "results.json").exists()
    assert json.loads(completed.stderr.strip())["reason"] == "ExportError"
