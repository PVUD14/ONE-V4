"""Offline calibration for ONE's learning engine (ENG-13, ENG-26, ADR-034).

Reads de-identified exports of attempts and fits item difficulty and discrimination (2PL, ENG-13)
and per-skill BKT parameters (ENG-26), then compares a refit with the parameters it would replace.
Writes files the TypeScript side validates; a monthly refit is only a proposal until accepted. No
database access, no network, no model or LLM call.
"""
