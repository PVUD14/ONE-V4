# ONE by Ai8ht — Privacy Notice (DRAFT)

> **STATUS: DRAFT FOR LEGAL REVIEW — NOT YET IN FORCE.**
> This skeleton was prepared by the engineering team to accurately describe what
> the system does. A qualified lawyer must review, complete the bracketed items,
> and confirm DPDP Act, 2023 + DPDP Rules compliance before any real (non-UAT)
> student is onboarded. Placeholders are marked `[TODO]`.

_Last updated: [TODO date] · Applies to: one.ai8ht.pro_

## Who we are

ONE is operated by [TODO: Ai8ht legal entity name, registered address]
("we", "us"). For your personal data, we act as the Data Fiduciary under the
Digital Personal Data Protection Act, 2023. [TODO lawyer: confirm the
fiduciary/processor split with partner institutions and reflect the contracts.]

## What we collect, and why

**Students:** name, email, phone, date of birth, institution/department/batch,
profile content you add (education, skills, projects, certifications, documents,
photo), assessment attempts and results, learning progress, and technical logs
(sign-ins, actions with timestamps). Purpose: providing your placement-readiness
workspace — profiles, learning, assessments, and placement processes run by your
institution.

**Institution staff:** name, email, role, and actions performed. Purpose:
operating your institution's placement and assessment workflows.

**Employer users:** name, work email, organisation, roles and drives you create,
and actions performed. Purpose: running hiring drives with partner institutions.

We do not collect data we do not need, and we do not sell personal data.

## What stays private by design

- Internal career-readiness signals are private guidance for you and your
  institution. They are **never shown to employers and never made public**.
- Your profile is visible to others only where the platform's rules allow it,
  and your **public profile exists only if you choose to share it**.

## AI features

Some features are powered by a third-party AI provider, **Anthropic** (Claude
API, processed in the United States):

- The in-app help assistant sends your typed question and our own help articles —
  not your profile or records.
- [TODO: enable only when shipped] Personalised AI answers send the minimum of
  your own account data needed to answer, only when you ask, with the same access
  rules as your own session.
- Staff AI tools may process institution-provided study material.

Anthropic processes this data as our processor under contract, does not use it to
train models, and retains it only briefly for abuse prevention. [TODO lawyer:
reference the executed DPA and confirm retention wording against current
Anthropic commercial terms.]

## Where your data lives, and cross-border transfer

Your data is stored on our servers in [TODO: server location — currently
hosting provider region]. AI requests are processed by Anthropic in the United
States, which is not a restricted jurisdiction under section 16 of the DPDP Act.
[TODO lawyer: keep aligned with any negative-list notifications.]

## How we protect it

Encryption in transit (TLS), role-based access, institution-level data isolation
enforced at the database layer, audit logging of actions, malware scanning of
uploads, and encrypted off-site backups. Access to production systems is limited
to named operators.

## How long we keep it

[TODO lawyer + ops: retention schedule.] Working basis: active account data is
kept while your account is active; on erasure request or account closure,
personal data is removed by our scheduled deletion process except where a legal
obligation requires longer retention (e.g., [TODO]). Backups roll off within
[TODO: retention days] days.

## Your rights

Under the DPDP Act you may: access a summary of your personal data (a
machine-readable export is available in Settings), request correction or erasure,
nominate a person to exercise rights on your behalf, and withdraw consent —
withdrawal stops the related processing but may make parts of the service
unavailable to you.

**Children:** ONE is intended for users 18 and over. [TODO lawyer + product:
either the verifiable-parental-consent flow for 16–18 or an explicit 18+ gate at
onboarding; current build has no parental-consent flow.]

## Grievances

Grievance Officer: [TODO name], [TODO email], [TODO address]. We respond within
[TODO days]. If unresolved, you may complain to the Data Protection Board of
India.

## Changes

We will notify you of material changes to this notice in the application before
they take effect.

---

### Engineering appendix (for the lawyer, delete before publication)

- Data export endpoint: implemented (Settings → Download Data Copy, JSON).
- Deletion: scheduled sweep implemented (`planthepath-privacy-deletion.timer`).
- Tenant isolation: composite foreign keys per institution at the schema level.
- Audit: correlation-ID audit events on protected actions.
- Backups: nightly, restore-verified, GPG-encrypted for off-host copies.
- AI: server-side proxy to Anthropic; help assistant sends no personal data;
  per-user daily caps; conversations logged for quality review (disclosed in
  the widget).
- Consent capture at onboarding: **not yet implemented** — must exist before
  this notice goes live.
