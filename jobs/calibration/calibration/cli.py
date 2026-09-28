"""Command line for the calibration job (ENG-13).

    python -m calibration fit --in export.json --out results.json [--min-responses 200]

Why this exists: deploy/scripts/run-calibration.sh runs export (TypeScript) -> fit (this) ->
import (TypeScript). This step reads only the de-identified export and writes only item
parameters; it prints counts, never a pseudonym or an item.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from calibration.fit import DEFAULT_MIN_RESPONSES, ExportError, parse_export, run, summarize


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m calibration")
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("fit", help="fit 2PL item parameters from a de-identified export")
    fit.add_argument("--in", dest="input", required=True)
    fit.add_argument("--out", dest="output", required=True)
    fit.add_argument("--min-responses", type=int, default=DEFAULT_MIN_RESPONSES)
    args = parser.parse_args(argv)

    if args.min_responses < 1:
        parser.error("--min-responses must be at least 1")
    try:
        with open(args.input, encoding="utf-8") as handle:
            export = parse_export(json.load(handle))
    except (OSError, json.JSONDecodeError, ExportError) as error:
        print(json.dumps({"event": "engine.calibration.failed", "reason": type(error).__name__, "detail": str(error)}), file=sys.stderr)
        return 2
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    results = run(export, generated_at=generated_at, min_responses=args.min_responses)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(results, handle)
    print(json.dumps(summarize(results)))
    return 0
