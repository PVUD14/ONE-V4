# SOP — Jobs: post, publish, edit, pause, close, reopen, withdraw

> What this is: employer-facing help for running a job through its life on ONE, with the matching
> operator steps. Why it exists: Appendix 2 EMP-18 asks for an SOP per shipped module; this covers
> EMP-05 (job lifecycle and versions) and the posting and publishing that existed before it.
> Written 2026-10-01 against base `719eb34`.

## For employers

### Who

| Action | Owner | Admin | Recruiter |
|---|---|---|---|
| Create a draft, edit a draft, withdraw a draft | yes | yes | yes |
| Publish, pause, close, reopen, edit a live job | yes | yes | yes |

Your organisation must be **verified** to publish, pause, close or reopen. While it is awaiting
verification you can create and edit drafts only. Publishing (and reopening) also needs your
owner to have accepted ONE's current employer terms, once Operations has published terms
(see [sop-employer-terms-and-trust.md](sop-employer-terms-and-trust.md)).

### Where

- **Employer Portal → Opportunities**: the list of your jobs, **Create draft**, **Publish**.
- **Employer Portal → Opportunity Detail**: one job — *Current terms*, **Edit job**, the job
  actions (**Pause**, **Close**, **Reopen**, **Withdraw**) and *Version history*.
- Android shows each job's state, version and closed date read-only; changes are made on the web.

### Post and publish

1. **Opportunities → Create draft**: title, summary, employment type, work mode, location, pay
   (or leave it undisclosed), deadline. **Who can see it**: all students, or only colleges that
   approve a campus drive ([sop-employer-campus-drives.md](sop-employer-campus-drives.md)).
2. **Publish**. A job that would reach nobody is refused. Wording that asks students to pay a fee
   or deposit is flagged to ONE Operations for review when you create or publish the job, and an
   edit to a live job carrying such wording is refused (`OPPORTUNITY_PAYMENT_DEMAND`).

### Edit a job (every edit is a new version)

1. **Opportunity Detail → Edit job**, change what you need, **Save new version**.
2. Version 1 is never changed; applicants stay bound to the version they applied under.
3. If you change a **material term** — employment type, work mode, location, pay, duration,
   joining conditions or eligibility — each open applicant must **accept the new terms** before
   you can move them on or make them an offer. The Applicants list marks them *Awaiting
   new-terms acceptance*. You can still reject.
4. Changing only the **deadline** is recorded without asking anyone.
5. Changing only wording (title, summary, responsibilities) creates a version and asks nobody.
6. If someone else saved a version while you were editing, yours is refused
   (`OPPORTUNITY_VERSION_CONFLICT`); reload and edit again.

### Pause, close, reopen, withdraw

| Action | From | Reason | Effect |
|---|---|---|---|
| **Pause** | Published | optional: `HIRING_ON_HOLD`, `REVIEWING_APPLICANTS`, `UPDATING_DETAILS` | Students stop seeing it and cannot apply |
| **Close** | Published, Paused | required: `POSITION_FILLED`, `ENOUGH_APPLICANTS`, `HIRING_ON_HOLD`, `ROLE_CANCELLED`, `POSTED_IN_ERROR` | No new applications; existing applicants carry on |
| **Reopen** | Paused, Closed | — | Needs an audience and a future deadline |
| **Withdraw** | Draft, Published, Paused, Closed | required: `POSTED_IN_ERROR`, `ROLE_CANCELLED`, `DUPLICATE_POSTING`, `TERMS_INCORRECT` | Final. Refused while any application is still open: decide every applicant first |

A job also **closes on its own at its deadline** (reason `DEADLINE_PASSED`), once the background
worker runs. A job whose deadline has passed cannot be published or reopened
(`OPPORTUNITY_DEADLINE_PASSED`).

### Never do

- Never ask students for money, a deposit or a "registration fee", in a job or anywhere else.
- Never withdraw and re-post a job to dodge applicants' acceptance of new terms.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| A job looks like a scam (fee, deposit, off-platform payment) | Check the review signals under **Trust and Safety → Detector signals awaiting review**; open a case; if the employer is at fault, suspend it ([../ops/sop-organizations.md](../ops/sop-organizations.md) §B) — suspension pauses every published job at once |
| "My job did not close at the deadline" | Expected while the automation worker is not running (it is not deployed on AWS yet). The job still drops out of students' lists at the deadline; tell the employer to **Close** it by hand |
| An employer is reinstated after suspension | Tell them each job stays **Paused** until they republish it |

## Gaps

- Creating or first publishing a job that demands payment is flagged, not refused, so it reaches
  students until Operations acts on the signal (EMP-SR-22, open).
- The deadline close needs the automation worker, which does not run on AWS yet
  (`docs/ops/runbook-move-to-aws.md`). Jobs published before EMP-05 have no deadline event.
- Version history shows up to 200 versions per job.
- Android's terms dialog says eligibility changed but does not list the rules.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J5, E-L (and J2 for suspension).
