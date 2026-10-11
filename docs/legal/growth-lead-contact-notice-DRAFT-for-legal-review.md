# DRAFT — FOR LEGAL REVIEW — NOT PUBLISHED

> Proposed notice that AI8HT's growth (partnerships) staff give or send to a person at a prospective
> college or employer when they first contact them, and whose words ONE records as given on the
> person's contact record (GROWTH-03; `docs/architecture/growth-portal-design.md` §13.3,
> `docs/architecture/growth-leads-table-design.md` §5). Nothing here is published until Divakar approves
> it (program hard gate HG-6). Every bracketed item must be settled by legal review.
>
> **DRAFT.** Version recorded on contact records until publication: `draft-2026-10`
> (`GROWTH_CONTACT_NOTICE_VERSION`, `packages/authorization/src/growth-leads.ts`). The text below is the
> same text the API serves to the Growth screens with the label "Draft for legal review"; a change here
> must be made there too (a unit test compares the two).

## Who this notice is for

A principal, trustee, director, placement officer, HR or talent-acquisition person, or founder at an
organisation AI8HT would like to partner with — who is **not** a ONE user and has not signed up for
anything. The person's details are held under one of three bases only (design §13.2, interim rule O-21):
they gave the details themselves; the organisation published them for this kind of enquiry; or a
colleague at the same organisation passed them on for this purpose. [Legal review: confirm whether
each basis is sufficient under the Digital Personal Data Protection Act, 2023 and its Rules — consent
under section 6, or the "voluntarily provided" legitimate use under section 7(a) — and whether the
second and third bases need consent at first contact.]

## Proposed notice text (DRAFT)

AI8HT runs ONE, a platform that helps colleges prepare their students for work and helps employers hire them.

We hold your name and your work contact details only to contact you about your organisation partnering with ONE.

We got them from you, from your organisation's official listing, or from a colleague at your organisation who passed them on for this purpose.

We do not use them for marketing campaigns, do not share them outside AI8HT and do not buy or combine them with other data.

We keep them while we are in touch with your organisation and erase them 24 months after our last contact, or sooner if you ask.

To see what we hold, have it corrected or erased, or ask us not to contact you again, write to the privacy contact named in this notice.

[Privacy contact: name or role, email address and postal address of AI8HT's grievance officer — to be
supplied at publication.] [Data Protection Board complaint route — wording to be confirmed by legal review.]

## What ONE records, and what it does with a request

| Notice element | Where ONE enforces it |
|---|---|
| One purpose | Stated beside every contact form; contacts are reachable only from the lead they belong to; no export, campaign or sharing path exists |
| Where the details came from | `permission_basis` and `source` on every contact, required by the database (CHECK); only the three bases above are accepted |
| Notice given | `notice_given_at`, `notice_version`, who recorded it — set once; the screens show "Notice not yet given" until it is |
| 24 months | The daily privacy-worker sweep erases name, email and phone of every contact whose lead has had no activity for 24 months (D12) |
| See what we hold | Operations → Privacy → Growth lead contacts: lookup by email or phone returns every row held, audited by request reference |
| Erase / stop contacting | The same console erases every matching contact (fields nulled; the database refuses a removed contact that keeps any) and can set do-not-contact on the organisation, after which no contact may be added to it and the same organisation cannot be entered again |

## Open points for legal review

1. The lawful basis for each source (above), and whether consent must be captured at first contact.
2. Whether 24 months is proportionate for a lead that went cold, and whether a shorter period should
   apply to a lead marked lost.
3. Whether the notice must be given in a language other than English in some states.
4. The grievance-officer details and the Board complaint wording.
5. Whether a phone call (no written notice) satisfies the notice duty if the notice is sent by email
   the same day.
