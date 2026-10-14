"""Command line for the calibration jobs (ENG-13, ENG-26).

    python -m calibration fit         --in export.json --out results.json [--min-responses 200]
    python -m calibration recalibrate --in export.json --baseline baseline.json --out proposal.json [--min-responses 200]
    python -m calibration bkt-refit   --in bkt-export.json --baseline baseline.json --out proposal.json [--min-learners 100]

Why this exists: deploy/scripts/run-recalibration.sh runs export (TypeScript) -> recalibrate /
bkt-refit (this) -> record (TypeScript). These steps read only de-identified exports and the
parameters they would replace, and write only parameters and a comparison; they print counts,
never a pseudonym, an item or a skill. ``fit`` is ENG-13's plain fit, kept for its importer.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from calibration.bkt import DEFAULT_MIN_LEARNERS, BktExportError, parse_bkt_export
from calibration.drift import summarize_report
from calibration.fit import DEFAULT_MIN_RESPONSES, ExportError, parse_export, run, summarize
from calibration.recalibrate import BaselineError, bkt_proposal, item_proposal, parse_baseline


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _fail(error: Exception) -> int:
    print(json.dumps({"event": "engine.calibration.failed", "reason": type(error).__name__, "detail": str(error)}), file=sys.stderr)
    return 2


def _read(path: str) -> object:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _write(path: str, document: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m calibration")
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("fit", help="fit 2PL item parameters from a de-identified export")
    fit.add_argument("--in", dest="input", required=True)
    fit.add_argument("--out", dest="output", required=True)
    fit.add_argument("--min-responses", type=int, default=DEFAULT_MIN_RESPONSES)
    recalibrate = commands.add_parser("recalibrate", help="refit 2PL items and compare with the live calibrations")
    recalibrate.add_argument("--in", dest="input", required=True)
    recalibrate.add_argument("--baseline", required=True)
    recalibrate.add_argument("--out", dest="output", required=True)
    recalibrate.add_argument("--min-responses", type=int, default=DEFAULT_MIN_RESPONSES)
    refit = commands.add_parser("bkt-refit", help="fit per-skill BKT parameters and compare with the last accepted fit")
    refit.add_argument("--in", dest="input", required=True)
    refit.add_argument("--baseline", required=True)
    refit.add_argument("--out", dest="output", required=True)
    refit.add_argument("--min-learners", type=int, default=DEFAULT_MIN_LEARNERS)
    args = parser.parse_args(argv)

    if getattr(args, "min_responses", 1) < 1:
        parser.error("--min-responses must be at least 1")
    if getattr(args, "min_learners", 1) < 1:
        parser.error("--min-learners must be at least 1")

    try:
        if args.command == "fit":
            export = parse_export(_read(args.input))
        elif args.command == "recalibrate":
            export = parse_export(_read(args.input))
            baseline = parse_baseline(_read(args.baseline), "ITEM_2PL", export.run_id)
        else:
            export = parse_bkt_export(_read(args.input))
            baseline = parse_baseline(_read(args.baseline), "BKT", export.run_id)
    except (OSError, json.JSONDecodeError, ExportError, BktExportError, BaselineError) as error:
        return _fail(error)

    if args.command == "fit":
        results = run(export, generated_at=_now(), min_responses=args.min_responses)
        _write(args.output, results)
        print(json.dumps(summarize(results)))
        return 0
    if args.command == "recalibrate":
        proposal = item_proposal(export, baseline, _now(), args.min_responses)
        print(json.dumps(summarize(proposal["results"])))
    else:
        proposal = bkt_proposal(export, baseline, _now(), args.min_learners)
    _write(args.output, proposal)
    print(json.dumps(summarize_report(proposal["report"])))
    return 0
