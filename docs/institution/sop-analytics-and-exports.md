# SOP — Analytics access and CSV exports

> What this is: the procedure college owners and administrators follow to give someone analytics and
> exports access, and the procedure the person with access follows to download the college's CSV
> files. Why it exists: Appendix 3 INST-19; supplementary UAT script I-X. Built by INST-08 (access and
> four exports); INST-13 added the fifth, accreditation outcomes
> ([its own SOP](sop-accreditation-exports.md)). Written 2026-10-01 against base `719eb34`.
> Design: `docs/architecture/institution-exports-design.md`.

## Who can do what

| Who | Can |
|---|---|
| Owner, administrator | Grant and remove analytics and exports access (**Staff → Analytics and exports access**) |
| Administrator, department head **holding access** | Download exports (**Reports → Exports**; department heads: **Reports and Analytics → Exports**) |
| Owner | Cannot be given access (ADR-018). An owner who needs exports also holds an administrator membership, granted by someone else |
| Placement officer, faculty | Cannot be given access |

Nobody can grant access to themselves. Access ends on the next request once removed.

## A. Grant or remove access (owner or administrator)

1. **Staff → Analytics and exports access**. The table *Who can export* lists every administrator and
   department head with their department and current access.
2. Choose a **Reason for granting** (`Responsible for college reporting`, `Reports for their
   department`, `Leads accreditation preparation`) and grant.
3. A department head with *None set — cannot export until one is* needs a department first (see the
   [staff SOP](sop-staff-scope-and-teaching.md)).
4. To remove: choose a **Reason for removing** (`No longer responsible for reporting`, `Periodic access
   review`, `Left the college`) and remove.
5. Review the list once a term (`Periodic access review`).

## B. Download an export (person with access)

1. Open **Exports**. Choose **What to export**:

   | Export | Contains |
   |---|---|
   | Student roster with activation | One row per current student: roll number, name, email, units, relationship and activation state |
   | Readiness band distribution | Students per readiness band for **one month that has ended**; bands only; a band under 5 shows `<5` |
   | Assessment results | One assessment: one row per attempt, plus assigned students who have not taken it |
   | Staff-action summary | Interventions, tasks, notes, verifications and meetings opened in one ended month, as counts only — no titles, no text, never counselling notes |
   | Accreditation outcomes | See [its SOP](sop-accreditation-exports.md) |

2. For a summary, choose the **Month** (only ended months are accepted). For a per-student export you
   may **Limit to one department, programme, batch or section**.
3. Choose a **Reason for this export** (`Report to college management`, `Accreditation preparation`,
   `Department review`, `Placement planning`) and download.
4. The file covers only the students you are responsible for. A department head's file is their
   department only.

## Limits you will meet

| Message | Meaning |
|---|---|
| *You do not have analytics and exports access…* | Ask an owner or administrator to grant it |
| *Exports need a department on your staff membership…* | Your membership has no department |
| *Choose a month that has ended…* | Summaries are whole ended months only, so files cannot be compared to single out a student |
| *This export has more than 10,000 rows…* | Limit it to one unit |
| *You have reached the limit of 30 exports in 24 hours…* | Wait, then try again |

Every export — and every refused attempt without access — is recorded with who, why and what.

## Handling the file

- The file holds students' personal data. Keep it on college systems; delete it when the purpose ends.
- Open it in a spreadsheet as is: cells that could run as formulas are already made safe.
- It never contains readiness scores, salary or internal references. If you ever see one, stop and
  report it to AI8HT.

## Gaps

- No placement or application export: placement statistics are on screen only.
- Exports are desk files: there is no export on Android.
- A relationship or unit change after a month ends can still change that month's counts slightly
  (recorded as a residual risk in the security review).

## UAT

[ONE_INSTITUTION_UAT_V1.md](../uat/ONE_INSTITUTION_UAT_V1.md) — I-X.
