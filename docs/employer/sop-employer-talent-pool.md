# SOP — Talent pool (consented discovery)

> What this is: employer-facing help for searching the talent pool and inviting a student to
> apply, with the matching operator steps for switching it on. Why it exists: Appendix 2 EMP-18
> asks for an SOP per shipped module; this covers EMP-14 (ADR-044). Written 2026-10-01 against
> base `719eb34`.

## Status

**Built, switched off.** HG-4 was approved on 2026-10-01 and ADR-044 is accepted, but the flag
`employer.talent-pool` is **off by default**. The student consent wording is a **draft for legal
review** (`docs/legal/employer-discovery-consent-DRAFT-for-legal-review.md`, hard gate HG-6,
pending). The approved wording must be published before the flag is switched on.

## For employers

### Who

Owners, admins and recruiters of a verified, active employer. Web only; the Android app has no
employer talent-pool screen.

### Where

**Employer Portal → Talent Pool**. While the flag is off the page says *Not available yet*.

### Who you can find

Only students who joined the pool themselves, agreed to the current consent, set their profile to
employer discovery, have an active account with no deletion request, and have not blocked you.
Any of these ending removes them on your next request.

### Search

1. **Filter** by up to five catalogue skills (the student must have shown evidence for each),
   branch, graduation year and preferred city. At least one filter is required. Nothing else can
   be a filter, so no protected attribute can be searched.
2. **Search the talent pool**: 25 cards a page, up to 8 pages, no total. The order is fixed per
   employer and unrelated to evidence or recency.
3. A **card** shows a reference that is different for every employer, the skills, and branch,
   year and cities only if the student chose to show them. **Open card** lists the evidence items
   per skill. A card never shows a name, contact, college, identifier, readiness, score or count.
4. Every search and card view is audited.

### Invite to apply

1. Create a job whose audience is **invite only**, published, with an open deadline.
2. On the card, **Invite to apply** → choose the job → **Send invitation**. One invitation per
   card per job; at most **20 per employer in any 24 hours**. It lasts 14 days or until the job's
   deadline.
3. The student is told in-app. They may apply, decline, or block you. A decline or a block looks
   to you like no answer until the invitation expires.
4. You learn **who the student is only if they apply**, through the normal application and its
   snapshot. Your invitations list shows Pending, Applied or Closed.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| Switching the feature on | Only after Divakar clears HG-6: publish the approved discovery consent wording (a new version if it changed), then **Operations → Feature Flags**, `employer.talent-pool` — high-risk to enable, needs a second person or the solo cool-off ([../ops/sop-feature-flags.md](../ops/sop-feature-flags.md)) |
| A student complains about unwanted invitations | They can block the employer from Profile → Talent pool. If the employer is abusing invitations, open a trust case |
| A student wants to leave | They can always leave, even with the flag off; their listing ends and their visibility narrows at once |

## Gaps

- Search has no rate limit beyond auditing; an employer can page through many filter
  combinations (recorded as a residual risk in the security review).
- No operator screen for the pool beyond audit. Card views appear to the student only in their
  data export. Invitations are in-app only.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J11.
