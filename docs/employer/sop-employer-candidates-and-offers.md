# SOP — Applicants, Candidate Detail, résumés, feedback and offers

> What this is: employer-facing help for working with the people who applied — the pipeline,
> what each candidate shared, résumé downloads, feedback and offers — with the matching operator
> steps. Why it exists: Appendix 2 EMP-18 asks for an SOP per shipped module; this covers EMP-07
> (consented snapshot and candidate view), the applicant-access grant fix (EMP-SR-01/02) and the
> pipeline and offer routes that existed before them. Written 2026-10-01 against base `719eb34`.

## For employers

### Who

Owners, admins and recruiters of a **verified, active** employer. Nobody at your organisation
sees any candidate while it is awaiting verification, suspended or rejected.

### The one rule behind every candidate screen

You see a candidate only while their **applicant-access grant** is live. The grant is created
when the student applies and ends when:

- the student withdraws, or declines changed terms;
- you **reject** or **hire** them (the application closes);
- the student asks ONE to delete their account (from the moment they ask);
- the grant expires (nothing sets an expiry today; closing already ends it at once).

From the next request after it ends, the person is withheld: lists keep the row and its stage
but show *Details no longer shared*, Candidate Detail and the résumé are refused, and you cannot
move, interview, message or make an offer to them. You can still cancel an interview, withdraw an
offer and release feedback to a rejected candidate.

### Where

- **Applicants**: every applicant of a job, by stage, with eligibility flags and the stages
  ahead. Owners and admins also see **Export applicants**
  ([sop-employer-exports.md](sop-employer-exports.md)).
- **Candidate Detail**: one applicant as they chose to be seen.
- **Offers**: offers you sent and the candidate's answer.
- Android: recruiters see what an applicant shared on the applicant page; offers read-only.

### Read what a candidate shared

1. **Applicants → View details** (or **Candidate Detail**, then choose the candidate).
2. You see the **snapshot** the student reviewed and agreed to share at apply: name, education,
   qualifications without marks, links and the résumé they chose. It is frozen; it never follows
   later profile changes.
3. **Contact details** (email, phone) appear only from **Shortlisted** onward.
4. An application made before snapshots existed says it has none; ONE never fills it from the
   live profile.
5. Every view is audited with your name.

### Download a résumé

1. On Candidate Detail choose the résumé. ONE issues a link that lives **60 seconds**, works
   **once**, and only for you.
2. The file downloads as an attachment. If the candidate withdraws inside that minute, the
   download is refused.
3. Résumé uploads are switched off on the AWS production server until a virus scanner exists,
   so most applications there carry no résumé.

### Move applicants through the pipeline

1. **Applicants**: move a candidate to the next stage (screening, shortlist, assessment,
   interview, offer). Backward moves are refused.
2. A candidate waiting to accept changed job terms cannot be moved forward until they do.
3. **Reject** closes the application and ends your access to the person.
4. **Share feedback** (after rejecting): choose reasons from ONE's list and an optional note.
   Your internal rejection reason and notes are never shown to the candidate.

### Make an offer

1. Move the candidate to **Offer**, then **Send offer** with currency, amount, period, expiry
   and optional joining date and conditions.
2. Only the candidate can accept. You record **Hired** only after they accept.
3. **Withdraw offer** stands you down; the student is told.

### Never do

- Never copy candidate details out of ONE to keep after an application closes.
- Never contact a candidate through details they shared to ask for money.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A student asks why an employer can still see them | Look up the application in support; the employer sees nothing once the grant ends. If it is still open, the student can **Withdraw** |
| An employer says a candidate "disappeared" | Explain the grant: the student withdrew, the application closed, or the student asked for deletion. Never restore access by hand |
| A student asks to be deleted | [../ops/sop-privacy.md](../ops/sop-privacy.md) — employer access stops when the request is opened; executing it revokes every grant |
| A résumé download fails with "not available" | Uploads are off on AWS; nothing to fix in the employer account |

## Gaps

- Writes outside a transaction (sending an offer) check the grant without a row lock.
- Pipeline rejection reasons are free text, not a fixed list, and the stage-move, offer and
  audience audit rows do not record the organisation (EMP-SR-08, open).
- Résumé uploads are off on AWS until a virus scanner exists.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J3, J8, E-C.
