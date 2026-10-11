# SOP — Settings: employer terms, data retention, notifications and trust cases

> What this is: employer-facing help for the Settings page — accepting ONE's employer terms,
> what ONE keeps about candidates, your notification choices, and answering a trust case — with
> the matching operator steps. Why it exists: Appendix 2 EMP-18 asks for an SOP per shipped
> module; this covers EMP-16. Written 2026-10-01 against base `719eb34`.

## Status of the terms text

The employer terms are a **draft for legal review**
(`docs/legal/employer-terms-DRAFT-for-legal-review.md`; hard gate HG-6, pending). Nothing is
seeded: until Operations publishes a version, publishing jobs works exactly as before. A version
published as a draft shows **"Draft — pending legal review"** on every screen.

## For employers

### Who

| Action | Owner | Admin | Recruiter |
|---|---|---|---|
| Read Settings and the terms | yes | yes | no ("managed by your owner or admin") |
| Accept the terms | yes | no | no |
| Set your own notification choices | yes | yes | no (on the web) |
| Read and answer trust cases about your organisation | yes | yes | no |

### Where

**Employer Portal → Settings**: *Employer terms*, *What ONE keeps about candidates*, *Your
notifications*, *Trust and safety cases*. A suspended or rejected employer's status page also
lists its trust cases. Android: **Terms and trust** on Home, read-only; accepting, responding and
appealing are on the web.

### Accept the terms

1. **Settings → Employer terms**: read the version, then accept it (owner only).
2. Until an owner accepts the **current** version, publishing a job, reopening one, and
   requesting or resubmitting a campus drive are refused (`EMPLOYER_TERMS_NOT_ACCEPTED`).
3. It is never retroactive: a new material version pulls nothing already live; only your next
   publish waits. A non-material version asks nobody to accept again.

### What ONE keeps about candidates

Shown on Settings: you see a candidate only while their grant is live; it ends at withdrawal,
rejection, hire, a deletion request or expiry; message text is erased 180 days after the grant
ends unless a case or hold needs it.

### Your notifications

**Email me about hiring activity** and **Most emails a day** → **Save notifications**. Production
email is not switched on yet, so this records your choice for when it is.

### Answer a trust case

1. You see a case about your organisation only after ONE Operations asks you to respond, or has
   decided it. **Open** shows the summary Operations wrote, evidence about your own jobs and
   detector signals; anything else is counted, never described. You never see who reported it.
2. **Respond to the case** → **Send response**. The case moves to *under investigation*.
3. After a decision you may **Appeal the decision** once → **Send appeal**.
4. You can read and answer cases even while suspended.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| Publish a terms version | **Organizations → Manage employer terms**: version, title, terms text, *What changed*, whether employers must accept it (material), *Legal review* state and, for an approved version, *Who approved it, and where it is recorded* → **Publish version** (needs `OPS_ORG_MANAGE`, a reason code, audited). Publish to real employers only as legally approved, on Divakar's instruction. There is no dual control on this action |
| Ask an employer to respond to a case | **Trust and Safety → open the case → Ask for response**: write the summary the employer will read **verbatim** (never identify the reporter) and a reason code |
| Record a decision or answer an appeal | **Trust and Safety** case timeline shows the summary, the employer's response and appeal with their author. Reversing an enforcement action on appeal has no route yet |
| Expired grants | The daily privacy job revokes grants past their expiry; access already stops at the expiry instant. Nothing sets an expiry today, because closing an application revokes at once |

## Gaps

- No in-app notice tells owners that a response is requested or new terms need accepting.
- Operators cannot reverse an enforcement action on appeal.
- Retention of closed cases is still undecided.
- On AWS the daily privacy timer has not yet been adapted (`deploy/systemd`, runbook).

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — E-X.
