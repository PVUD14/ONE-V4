# Employer portal progress

> Goal reports for the employer plan (docs/employer/EMPLOYER_PORTAL_PLAN.md), newest last, in the plan's Section 0.6 format.

Base branch: **feat/plan-phases-0-to-2** — the most advanced non-main branch; it contains all of
integration plus the plan-phase work. Chosen 2026-09-25 (OPS-00); head c802d3b after PRG-FIX.
Repository: PVUD14/ONE-V4 (private). Goal branches are cut from the base and merged back into it;
main and production are released by Divakar only.

## EMP-00 — Employer baseline and defect reproduction — 2026-09-25
**Result:** Complete. docs/employer/EMPLOYER_BASELINE.md. D-1…D-9 marked (Confirmed D-1–D-8, D-9 Corrected
— employer assessments now exist). Reproduction run on c802d3b, specs copied in temporarily then deleted:
D-1 web — 4 fail as expected (owner/admin land on /auth/callback, not /employer/recruiter; deep link;
chooser), 2 controls pass; one deep-link failure message is a draft-fixture label — tidy when EMP-01
commits the spec. D-3 API — 5 fail as expected (publish after suspension 201 not 403; new job/applicants;
students still see the job; PENDING and REJECTED publish), 2 controls pass.
**Next goal in workstream:** EMP-01.
