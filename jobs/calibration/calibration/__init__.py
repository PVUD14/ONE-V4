"""Offline 2PL item calibration for ONE's learning engine (ENG-13, ADR-034).

Reads a de-identified export of attempts, fits item difficulty and discrimination, and writes a
results file that the TypeScript importer validates and stores in ``item_calibrations``. No
database access, no network, no model or LLM call.
"""
