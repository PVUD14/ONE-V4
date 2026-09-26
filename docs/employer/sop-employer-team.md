# SOP — Employer team: members, invitations and interviewers

> What this is: employer-facing help for managing the team (invite, resend, revoke, end a
> membership), with the matching operator steps. Why it exists: Appendix 2 EMP-18 (EM1 slice);
> journey J1 ("the owner invites an admin and two recruiters"). Built by EMP-02. Written
> 2026-09-26 against base `6864332`.

## For employers

### Who can do what

| Action | Owner | Admin | Recruiter |
|---|---|---|---|
| See the team | yes | yes | no ("managed by your owner or admin") |
| Invite an admin | yes | no | no |
| Invite a recruiter (also how interviewers join) | yes | yes | no |
| Revoke or resend an admin invitation | yes | no | no |
| Revoke or resend a recruiter invitation | yes | yes | no |
| End an owner's membership | another owner only, never the last owner | no | no |
| End an admin's membership | yes | no | no |
| End a recruiter's membership | yes | yes | no |

Your organisation must not be suspended or rejected; while awaiting verification you can set up
your team.

### Where

**Employer Portal → Team**.

### Invite someone

1. **Invite a team member**: **Work email**, **Role** (Admin or Recruiter) → **Send invitation**.
2. The invitation is valid for **14 days**. The *Invitations* list shows its delivery state.
3. **Interviewers** are invited as **Recruiters**; there is no "interviews only" role. An
   accepted recruiter appears in the interview participant options.
4. You cannot invite someone who already has a role in your organisation, or a second pending
   invitation to the same address. To change someone's role, end the membership and invite
   again.

### Resend or revoke

- **Resend** with a reason (`NOT_RECEIVED`, `LINK_EXPIRED`, `LINK_LOST`). A new link is issued
  and the old one stops working; the 14 days restart.
- **Revoke** with a reason (`SENT_IN_ERROR`, `WRONG_EMAIL`, `WRONG_ROLE`, `NO_LONGER_NEEDED`).

### End a membership

**End membership** with a reason (`LEFT_ORGANISATION`, `ROLE_CHANGE`, `ACCESS_NO_LONGER_NEEDED`,
`SECURITY_CONCERN`). Access stops on the person's next request; their past actions stay in the
audit record. They are not removed from interviews already scheduled but can no longer open them.

### Never do

- Never share one login between colleagues; invite each person.
- Never invite a personal email for a colleague; use their work address.

## Matching operator steps

| Situation | What Operations does |
|---|---|
| "My invitation never arrived" | Log a support case ([../ops/sop-support.md](../ops/sop-support.md)); look up the address; tell the employer's owner/admin to **Resend**. Operations does not resend employer team invitations |
| The last owner has left the company | Needs engineering today: no operator screen changes an employer's owner (Gap) |
| Security concern about a member | Ask an owner/admin to end the membership with `SECURITY_CONCERN`; if the organisation itself is at fault, see suspension in [../ops/sop-organizations.md](../ops/sop-organizations.md) |

## Gaps

- **HG-7:** with no production sender, team invitations are recorded as not emailed and
  cannot reach anyone in production.
- Changing a role in place is not built (end and re-invite).
- Replacing a departed last owner has no operator path.
- The Android app shows the team read-only; changes are made on the web.

## UAT

[ONE_EMPLOYER_UAT_V1.md](../uat/ONE_EMPLOYER_UAT_V1.md) — J1, E-T.
