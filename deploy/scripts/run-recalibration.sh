#!/usr/bin/env bash
# ENG-26: the monthly recalibration — refit 2PL items and BKT skills, compare each with the
# parameters it would replace, and record both as PENDING proposals with a markdown report.
#
# Why this exists: a refit must not change what students meet just by being computed. Per kind:
# export (TypeScript) -> fit + compare (Python, no database access) -> record (TypeScript). Nothing
# is adopted here; Divakar reads the reports and accepts or rejects each run
# (docs/ops/runbook-monthly-recalibration.md). Replaces ENG-13's weekly run-calibration.sh, which
# imported every fit straight into item_calibrations. Run by planthepath-recalibration.service.
# Written in the repository only: installing it on a server is Divakar's manual step.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/planthepath-next/current}"
CALIBRATION_PYTHON="${CALIBRATION_PYTHON:-/srv/planthepath-next/shared/calibration-venv/bin/python}"
MIN_RESPONSES="${CALIBRATION_MIN_RESPONSES:-200}"
MIN_LEARNERS="${RECALIBRATION_MIN_LEARNERS:-100}"
REPORT_DIR="${RECALIBRATION_REPORT_DIR:-/srv/planthepath-next/shared/recalibration-reports}"
KINDS="${RECALIBRATION_KINDS:-items bkt}"

# Exports hold per-learner response patterns (pseudonymous): owner-only, and gone on exit.
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$APP_ROOT"
recalibration() { corepack pnpm --silent --filter @planthepath/persistence engine:recalibration "$@"; }

for kind in $KINDS; do
  case "$kind" in
    items) fit=(recalibrate --min-responses "$MIN_RESPONSES") ;;
    bkt)   fit=(bkt-refit --min-learners "$MIN_LEARNERS") ;;
    *) echo "{\"event\":\"engine.recalibration.failed\",\"reason\":\"unknown kind\"}" >&2; exit 2 ;;
  esac
  recalibration export --kind "$kind" --out "$work/$kind-export.json" --baseline "$work/$kind-baseline.json"
  (cd jobs/calibration && "$CALIBRATION_PYTHON" -m calibration "${fit[0]}" \
    --in "$work/$kind-export.json" --baseline "$work/$kind-baseline.json" --out "$work/$kind-proposal.json" "${fit[@]:1}")
  # Only parameters and the comparison remain after the fit; drop the export before touching the database again.
  rm -f "$work/$kind-export.json"
  recalibration record --in "$work/$kind-proposal.json" --report-dir "$REPORT_DIR"
done
