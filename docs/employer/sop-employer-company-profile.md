# SOP — Company profile and requesting employer access

> What this is: employer-facing help for the company profile students see on every job, and for
> a new company asking for employer access, with the matching operator steps. Why it exists:
> Appendix 2 EMP-18 (EM1 slice). Built by EMP-04. Written 2026-09-26 against base `6864332`.

## For employers — company profile

### Who

Owners and admins edit; recruiters read. Available while awaiting verification and when
verified; not while suspended or rejected.

### Where

**Employer Portal → Company Profile**. The page shows *How students see you*, *Describe your
company* and *Verified details*.

### Steps

1. Under **Describe your company** fill **About the company**, **Industry** (fixed list),
   **Company size** and **Careers page (on your website)**.
2. **Save profile**. Students see it as "About <company>" on every job, on web and Android.

### Rules

- The **careers page** must be on the website ONE holds for you, or a subdomain of it. With no
  website on record it is refused.
- **About** text asking students for payment, deposits or fees is refused.
- **Verified details** — legal name, display name, website, address, country, contact email —
  are the details verification was done against. You cannot change them; ask ONE Operations.

## For companies not yet on ONE — requesting access

1. On the ONE sign-in page choose **Request employer access** (`/employer-access`).
2. Enter **Your name**, **Company name**, **Work email** and **Company website**. Use an address
   on your company's own domain; public webmail is not accepted.
3. You see the same confirmation whatever happens next. Nothing is created until ONE Operations
   has verified your company and invites your first owner.

## Matching operator steps

| Situation | Operator procedure |
|---|---|
| An access request arrives | [../ops/sop-organizations.md](../ops/sop-organizations.md) §C |
| An employer asks to change a verified detail | Verify the change as you would a new organisation (website, domain contact); edit it on **Organizations**. **Do not** use *Edit details* for a partial change — it can blank address fields (see sop-organizations "Never do") |
| A job shows odd company text | Check the profile as a student would; if abusive, suspend per sop-organizations §B and log a case |

## Gaps

- **Logo:** not built (needs the file store).
- **HG-7:** requesters get no confirmation email; the queue marks every request's email as
  unconfirmed.
- **Retention** of declined and spam requests (proposed 180 days) is not yet in the privacy
  worker.
- No notification tells Operations a request has arrived; check the queue or the Overview tile.
- Employer Help & FAQ articles have not been updated for these modules in this slice (EMP-18
  item 4 is application content).

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — E-P, and O-2 in the operations UAT.
