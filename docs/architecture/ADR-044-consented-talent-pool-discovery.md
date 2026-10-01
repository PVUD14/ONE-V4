# ADR-044 — A Consented Talent Pool: Employers May Find Students Who Opted In; Never by Score, Never by Name

**Status:** Proposed — awaiting Divakar's hard-gate approval **HG-4** (which covers EMP-13 and EMP-14), and the
discovery consent wording awaits **HG-6** (legal review). The feature is built and ships **dark**: the flag
`employer.talent-pool` is off by default and switching it on needs a second person. Approving means switching
the flag on through Operations → Feature flags once the wording is approved; nothing else changes.
**Date:** 2026-10-01
**Goal:** EMP-14 (Appendix 2)
**Relates to:** ADR-043 (consented per-skill evidence, never readiness), ADR-020 (readiness never reaches an
employer), ADR-019 (consents are separate and revocable)
**Design:** `docs/architecture/talent-pool-table-design.md` (migration 0098)

## Context

EMP-13 lets a student show verified evidence to an employer they applied to. Employers also want to find
students before a job closes, and the consent registry (0028) was built anticipating a distinct
`employer-discovery` consent for exactly that. Discovery reaches employers the student never chose, so it is
the more sensitive of the two.

## Decision

A student may join a talent pool by an explicit opt-in that grants the `employer-discovery` consent and sets
their profile visibility to `EMPLOYER_DISCOVERY`; both are required, and either being withdrawn removes them on
the next request. They choose every field an employer can see: verified evidence items per skill (EMP-13's
qualifying rule), branch, graduation year, preferred cities. They can block particular employers and leave at
any time.

A verified, active employer may **filter** (never rank) the pool by catalogue skills with shown evidence,
branch, graduation year and city, and sees a card with no name, contact detail, college or identifier. The only
way to contact a student is an in-app invitation to apply to an invite-only job; the employer learns who the
student is only if the student applies, through the normal consented application. Every search, card view and
invitation is audited; invitations are limited per employer per day.

## Why filters and cards, not a ranked list

- **A ranking is a score.** Ordering students by evidence, recency or "match" is readiness by another name and
  invites automated selection (ADR-043's reasoning, unchanged). Results come in an order unrelated to the
  student (a per-employer hash), with no total.
- **Minimal cards protect people who have not chosen this employer.** A name or college turns discovery into a
  directory; a pseudonymous card with only what the student ticked lets the student decide when to be known —
  by applying.
- **An invitation, not a message.** Free text to an unidentified student invites contact-detail swaps and
  pressure; a fixed invitation to a real, published job keeps contact inside a path the student answers.

## Alternatives rejected

- **Reuse `employer.skill-evidence` (one switch for both).** Approving per-application sharing must not
  silently open discovery.
- **Visibility alone, or consent alone.** The plan requires both; the consent is the auditable, versioned
  record, the visibility is the student's everyday control on their profile.
- **Show the college name.** With branch and year it narrows to a handful of people.
- **Search by any profile field.** Unknown filters are refused, so protected attributes can never be added by
  accident.
- **Tell the employer when an invitation is declined.** A decline looks like no answer (as INST-14).

## Consequences

- One migration (0098) with four tables, the consent definition (draft version) and the flag; new student and
  employer routes; the Talent Pool page becomes real behind the flag; a talent-pool card on the student's
  Profile (web) and Android.
- Invite-only jobs become visible to a student holding a live invitation (and only while the flag is on).
- Privacy deletion ends the listing first and erases it; the export gains `talentPool`.
- Until HG-4 (and HG-6 for the wording) the flag stays off: no student is offered the opt-in, no employer can
  search, and nothing is read or audited.
