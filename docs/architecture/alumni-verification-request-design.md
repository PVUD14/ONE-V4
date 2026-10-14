# Alumni verification requests — design

What this is: the design for letting someone who has **left** an institution ask that
institution to verify the record it issued them. Written before the code because
verification is permanent — a mistake here cannot be undone by a later migration — and
because the change turns out to be smaller and more interesting than it first appeared.

No migration. That is the headline.

## What already works

The academic-records design did this right without anyone noticing. Verification is
scoped by **which institution issued the qualification**, and by nothing else:

- `student_qualifications.institution_id` is nullable, and a qualification either names a
  ONE organization or carries a free-text institution name that can never become verified.
- `submitTermForVerification` requires only that `q.institution_id IS NOT NULL`.
- `listVerificationQueue(institutionId)` selects pending terms `WHERE q.institution_id = $1`.
- `decideTermVerification` is scoped the same way, and a database trigger makes the result
  permanent.

**Not one of those asks whether the person is currently enrolled.** A graduate from 2019
pointing a qualification at their old college would land in that college's queue and be
verifiable today. The engine was built for this; nobody had opened the door to it.

So this work is not a new subsystem. It is three missing pieces and one bug.

## The three missing pieces

### 1. A student cannot find their institution

`institutionId` is a UUID supplied by the caller. There is no route that lists
institutions, so the only way to set it is to already know a UUID — which no student does.
This is the entire reason the capability has been unreachable.

**A searchable directory of institutions**, returning id and name for organizations that
are `INSTITUTION`, `active` and `VERIFIED`. Authenticated, because everything is; a
signed-in person may look up the college they attended.

It deliberately returns **only** identity: name, city, state. Not counts, not contact
details, not staff. A directory is for recognising your own college in a list, and
anything beyond that is an institution profile nobody asked to publish.

### 2. Nothing checks that the institution is an institution

`institution_id` carries a foreign key to `organizations`, which guarantees the row
exists — and nothing more. Today a student could point a qualification at an **employer's**
organization id. That employer could never verify it (no staff member holds an institution
role there, and the queue route requires one), so it would sit pending forever, looking to
the student like an institution ignoring them.

Declaring a qualification therefore validates that the named organization is an active,
verified institution, and refuses otherwise.

### 3. Staff cannot tell who is asking

The queue returns the term, the programme and the student's email. For a current student
that is enough, because staff can look them up on the roster. For a request from someone
who left in 2019 it is not: staff need to know that this person is **not** on the roster,
and roughly when they claim to have attended, before going to the archive.

The queue therefore also returns the student's name, the claimed programme dates, and a
**relationship status** derived from `institution_relationships` — `CURRENT`, `FORMER` or
`NONE`. `FORMER` is the honest label for a graduated or transferred relationship; `NONE`
means the institution has no record of this person at all, which is exactly the case that
needs a human to check the archive rather than the screen.

### What the queue still cannot show, and why

**ONE holds no platform-level name for a person.** A student's name exists only in
`institution_student_profiles.full_name`, which each institution records on its own roster.
So for a `CURRENT` or `FORMER` request the institution sees the name it wrote itself, and
for a `NONE` request it sees **no name at all** — only the email address and the claimed
programme and dates.

That is the honest outcome rather than a defect to paper over: we would be inventing a
name we have never been told. The queue returns null and the screen shows the email.

It is also a gap worth naming. A person who signs up to ONE independently — the very
audience the alumni path exists for — has nowhere to record who they are. That belongs
with the independent-learner account, not here, and this design deliberately does not
smuggle a half-version of it in.

### The bug

`listAcademicRecords` selects `o.name` from `organizations`. That column was renamed to
`legal_name` in migration `0001`, so the query raises `column o.name does not exist` and
**every call to `GET /students/me/academic-records` fails**. The route has no test that
calls it — the integration suite exercises the constraints and the submit/decide
functions directly — so nothing caught it.

Fixed here, with a test that reads the records back and asserts the institution name,
because the value of that test is entirely in the column actually existing.

## What this design refuses to do

**No parallel request table.** `verification_state = 'PENDING_VERIFICATION'` on the term
*is* the request. A second table tracking the same thing would create two places for one
truth and a way for them to disagree.

**No enrolment requirement, and no new one.** The absence of an enrolment check is the
feature, not an oversight to be tidied up. Anyone reading `listVerificationQueue` later
should know that.

**The institution is not told who its alumni are.** The directory lets a student find a
college; it does not let a college enumerate people claiming to have attended. Staff see
a person only once that person has submitted a record to them — which is the student's own
act, and the only reason their name and email reach that institution.

**An institution not on ONE cannot be worked around.** A qualification naming a
free-text institution stays `SELF_REPORTED` for good, enforced by a CHECK constraint. That
is the honest outcome: there is nobody to ask.

## Consequences

- A graduate can turn a photograph of a marksheet into a verified record, provided their
  college is on ONE — which is a reason to sign up on the first day, before they have
  learned anything.
- A college gains a queue for the alumni verification requests its registrar's office
  currently answers by email, one at a time.
- A student whose college is not on ONE gets an honest `SELF_REPORTED` label and a reason
  to tell their college about us.
- The student academic-records page starts working again.
