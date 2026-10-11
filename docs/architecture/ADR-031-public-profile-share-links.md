# ADR-031 — A Student May Publish a Profile Behind a Revocable Link

**Status:** Accepted
**Decision date:** 2026-09-14
**Scope:** Whether ONE serves anything without authentication, and what a student may publish
**Author:** Divakar · Agent-assisted: yes (Claude) · Reviewed: pending

## Context

Until now ONE has had **no unauthenticated route of any kind**. Every path requires a
verified principal. That is a real and unusual security property, and it is the reason a
stolen link, a leaked URL or a crawler has never been able to reach a single record.

It also means a student's proven record is trapped inside the product. The platform spends
considerable effort making an academic record verifiable — an institution confirms it, the
confirmation is permanent, the unverified parts are labelled as unverified — and then the
only people who can ever see the result are people already signed in to ONE. A graduate
cannot put it on a CV. An employer who is not on the platform cannot look at it.

Divakar authorised opening this door on 2026-09-13, having been told plainly that it ends
the no-public-routes property.

## Decision

**A student may publish a profile page reachable without signing in, addressed by an
unguessable token, scoped to what they chose to show, expiring by default and revocable
at any moment.**

The route is deliberately narrow. It serves one page shape for one subject, reached only
by presenting a token that exists in the database and has not expired or been revoked.
Nothing else in the product becomes public.

## What the page may carry

- The student's name, headline, target role, city, institution and expected graduation.
- Academic records, each marked **verified** (with the confirming institution named) or
  **self-reported**, with the reason a record cannot be confirmed stated in words.
- Results of assessments ONE administered.
- Learning the student completed on ONE.
- Certificate **titles** the student declared. Never the files.
- Skills the student listed, marked as their own claim.
- A profile photo, and one of a fixed set of cover backgrounds.
- A portfolio link, labelled as unchecked by us.

## What the page may never carry

**The readiness band, in any form.** Not the band, not a number derived from it, not a
label that stands in for it. `readiness_snapshots` already carries
`CHECK (NOT employer_visible)` and `CHECK (advisory)`; this design adds the rule that no
public route reads that table at all. A band on a page anyone can open is worse than
showing it to an employer, which we also refuse.

**No score about the person.** No profile-strength percentage, no completeness meter, no
skills-match figure. The reference design this page was modelled on carries two such
numbers; both were rejected. Where a summary is useful the page states a **count of
facts** — "four of six records independently confirmed" — which is a description of the
evidence, not a judgement of the student.

**Applications, their outcomes, and employer feedback.** A public page must not reveal
that somebody is job-hunting, where they applied, or that they were turned down.

**Uploaded files.** Certificates and transcripts stay private; only titles may appear.

**Anything an institution recorded internally**, including staff notes and interventions.

## The decisions inside the decision

### The address is a random token, not a handle

`/p/{token}` where the token is unguessable, rather than `/p/rahul-kumar`.

A handle reads better and is easier to say out loud. It is also permanent: revoking and
re-publishing gives the same address, so a link shared once can never truly be withdrawn.
A token makes revocation mean what it says — the old address is dead, and the new one is
unrelated to it.

**Only a digest of the token is stored**, using the same hashing the invitation tokens
use. A database disclosure therefore leaks no working profile URLs.

### Links expire by default

Ninety days, extendable in one click, with warning before lapse. A profile that lives
forever is one the student forgets they left open — shared at twenty-one and still
serving at thirty. Expiry is the difference between publishing something and abandoning
it.

### Revocation is immediate and total

Revoking stops the link for everyone, including people who already had it. A replacement
link is a new token at a new address; the old one never returns.

### Assessment results are off by default

The student may switch them on. They are defensible — ONE administered them — but a
percentage attached to a person is close enough to the thing this product refuses
everywhere else that it should be a deliberate act, not a default.

### The photo is stored once, and is off on the public page by default

Today the Android app saves a photo **to the device only**, which means the web app never
sees it and a reinstall loses it. That is replaced: one photo, stored server-side through
the same scan-and-encrypt path as every other upload, visible in every client.

On the public page it is **off by default**. Name, city, institution and graduation year
are already enough to identify a young person; a face is the point at which a forwarded
link becomes genuinely personal. In India a photograph on a CV is unremarkable, so this is
the student's call to make — but it is theirs to make, not ours to assume.

### Covers are a fixed set, not an upload

A student picks one of four backgrounds. Uploads are refused, and the refusal is explained
on the screen rather than hidden.

The page carries the AI8HT wordmark. An uploaded cover would need somebody looking at
every image before it appeared under our mark, and nobody is doing that. A moderation
queue we cannot staff is worse than a feature we did not ship.

### Search engines are asked not to index it

The page sends `noindex`. A token is unguessable but a shared link can be crawled from
wherever it was pasted, and a student sharing a link with three employers has not asked to
be a search result.

### An unknown token is indistinguishable from an expired one

An unknown, expired or revoked token returns the same response, so the route cannot be
used to learn which tokens are real.

## Why not the alternatives

**Keep everything behind sign-in, and let employers register.** This is what exists, and it
is why the capability has never been usable. An employer asked to create an account to look
at one candidate will not do it.

**Publish to a search-indexed public directory.** Far larger blast radius, a moderation
obligation we cannot meet, and it makes every student findable rather than every student
shareable. Rejected without much hesitation.

**Signed, expiring URLs with no stored row.** Cheaper, but revocation becomes impossible
without a denylist, which is a stored row wearing a disguise. Rejected.

## Consequences

- **ONE now has one unauthenticated route.** That is a permanent change to the security
  posture and should be stated as such in any security review, not discovered in one.
- The independent-learner path (C2) gains its point: somebody with no institution can still
  hold a page showing what they have and what is confirmed.
- The revocable-token machinery built here is the same machinery a subscribable calendar
  feed needs, which is why the calendar was deliberately left as a download in A2.
- A profile photo becomes real platform data, so the Android device-only photo is retired
  rather than left to disagree with the server.
- Anything added to this page later inherits these rules by default. A future contributor
  wanting to add a field to the public profile should read this file first and be required
  to argue that the field is not a score, not an application, and not a band.
