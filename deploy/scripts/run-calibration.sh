#!/usr/bin/env bash
# ENG-13: one item-calibration run — export (TypeScript) -> fit (Python) -> import (TypeScript).
#
# Why this exists: ADR-034 keeps Python offline. The Python step never touches the database; it
# reads a de-identified, consented export and writes item parameters, which the TypeScript
# importer validates and stores in one transaction. Run by planthepath-calibration.service.
# Written in the repository only: installing it on a server is Divakar's manual step.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/planthepath-next/current}"
CALIBRATION_PYTHON="${CALIBRATION_PYTHON:-/srv/planthepath-next/shared/calibration-venv/bin/python}"
MIN_RESPONSES="${CALIBRATION_MIN_RESPONSES:-200}"

# The export holds per-learner response patterns (pseudonymous): owner-only, and gone on exit.
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$APP_ROOT"
corepack pnpm --silent --filter @planthepath/persistence engine:calibration-export --out "$work/export.json"
(cd jobs/calibration && "$CALIBRATION_PYTHON" -m calibration fit \
  --in "$work/export.json" --out "$work/results.json" --min-responses "$MIN_RESPONSES")
# Only item parameters remain after the fit; drop the export before touching the database again.
rm -f "$work/export.json"
corepack pnpm --silent --filter @planthepath/persistence engine:calibration-import --in "$work/results.json"
