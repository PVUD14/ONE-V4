"""Entry point: ``python -m calibration fit --in <export.json> --out <results.json>`` (ENG-13)."""
import sys

from calibration.cli import main

sys.exit(main(sys.argv[1:]))
