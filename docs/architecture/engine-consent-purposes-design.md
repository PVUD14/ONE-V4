# Engine Consent Purposes and the 18+ Gate — Design

**Status:** Adopted for the ungated parts (ENG-01). Publishing the definitions and the age-gate wording
waits for hard gate HG-6 (legal/policy text).
**Date:** 2026-09-25
**Migration:** none in this change — see "What is gated"
**Rule:** Consent is a record a person's data use depends on; written down before anything is built.

## Why this exists

The learning engine (Part D of the program) profiles behaviour: which items a student gets right, how
fast, with which hints. Under DPDP (obligations from 14 May 2027) that needs a lawful basis the
student chose, separately from the privacy notice everyone accepts to use ONE. Three uses are
distinct enough to need their own consent, each optional and each withdrawable:

| Purpose key | Gates exactly | Without it |
| --- | --- | --- |
| `adaptive-learning` | A personalised plan and mastery tracking built from the student's attempt history | The non-adaptive path: the same catalogue order for everyone, no per-student projection written |
| `ai-tutoring` | AI tutor replies to the student | No tutor; authored hints only |
| `model-improvement` | Inclusion of the student's de-identified attempts in model-improvement exports | The student is left out of every such export |

## Enforcement

`packages/persistence/src/consent-purposes.ts` exposes `hasConsentPurpose(db, userId, purpose)`.
Engine code calls it **server-side, on every request**, and takes the non-adaptive path on `false`.

- **Fails closed.** No live definition, a withdrawal, or a grant of an older version all answer
  `false`. Until HG-6 publishes the definitions, every student is on the non-adaptive path — the
  safe default, not an outage.
- **No caching.** A withdrawal recorded through the existing `POST /me/consents/:key/withdraw`
  takes effect on the next request. That endpoint is already generic over keys, so it covers the new
  purposes as soon as their definitions exist.
- **Withdrawal effects.** `adaptive-learning` withdrawn: no new projections are written; existing
  evidence is kept, because evidence rows are immutable by design (0004) and the deletion policy
  keeps assessment evidence anonymised — the ENG-00 baseline records the conflict between D.1's
  "deletion removes attempts" and that policy as an open decision for ENG-03/ENG-05.
  `model-improvement` withdrawn: `studentsConsentingToModelImprovement` excludes the student from
  the next export.

**Rejected: a client-side check only.** The web and Android consent screens are the place a student
decides, not the place it is enforced; ENG-00 found that no API route enforces consent today.

## The consent gate's checking window

ENG-00 found the web gate rendered the workspace while its first check was in flight, and the
Android app opened the workspace when the check failed. Both now fail closed: the web gate shows a
"checking" card until the answer arrives; Android shows "We could not confirm your privacy consent"
with a retry on any failure other than an expired session, which signs the user out as before.

## The 18+ gate (decided here, built once HG-6 approves the wording)

V1 serves adults only until a verifiable parental-consent flow exists.

**Chosen: an 18+ confirmation at student onboarding**, recorded as a consent-style row (the
confirmation, its policy version and when) and nothing else. A student who says they are under 18
is stopped with a plain message and nothing further is stored about them.

**Rejected: a self-declared date of birth.** It is still self-declared, so it is no stronger proof
of age than a confirmation, and it stores a precise personal attribute ONE has no other use for —
more data than the decision needs, which DPDP's data-minimisation duty argues against.
**Rejected: document-based age verification.** Disproportionate for V1 and a new category of
sensitive data to hold.

## What is gated (HG-6)

- **The definitions themselves.** There is no operator path for publishing consent definitions; they
  are created by SQL, so the migration that inserts `adaptive-learning`, `ai-tutoring` and
  `model-improvement` *is* the act of publishing their wording to students. It is drafted, not
  applied: `docs/legal/engine-consent-notice-DRAFT-for-legal-review.md` carries the proposed titles
  and notice text, and the migration follows Divakar's HG-6 approval.
- **The age-gate wording and screen.** Designed above; built with the approved wording.

Everything else in ENG-01 is built and tested now, so the approval is the only thing between the
drafts and students.
