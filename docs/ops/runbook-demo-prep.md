# Runbook — Client demo: before and after

The pilot at oneby8.com/demo uses shared demo accounts with a common password.
That password is a *demo prop*, not a secret — it is typed on screens, pasted into
chats, and seen by every audience. The control that keeps this safe is rotation.

## Before the demo (day before, 10 minutes)

1. `curl -fsS https://oneby8.com/health` → `{"status":"ok"}`, and no deploy is
   scheduled during the demo window. If one is in flight, finish or postpone it.
2. Sign in as one demo account per persona (student, institution, employer) and
   click through the flow you plan to show. The pilot resets on reload by design —
   rehearse with that in mind.
3. Confirm the current demo password works and matches the vault entry.
4. Brief the junior team: no UAT activity on demo accounts during the demo window.

## After the demo (same day — rotation is the point)

The demo accounts live in the Cognito user pool `ap-south-1_nPl3qFkvB`
(AWS console → Amazon Cognito → User pools, region ap-south-1).

1. Generate a new password on the build machine — never invent one by hand and
   never write it in chat, docs, or commit messages:

```
node -e "console.log('AI8HT_'+require('crypto').randomBytes(9).toString('base64url'))"
```

2. In the Cognito console, for **each demo account** (`demo.*` users): select the
   user → *Reset password* / set the new password as permanent.
3. Update the single vault entry the demo password lives in. The vault is the only
   written home of the value.
4. Sign in once as one demo account to prove the new password works.
5. Tell the juniors through the private channel that the password rotated and where
   to find it (the vault entry — not the value itself in the message).

## Credential hygiene rules (standing)

- The UAT credential sheet is a vault item, shared per-person. The legacy local
  text file copy is retired once the vault holds it; no new copies are made.
- Real user accounts are never used in demos; demo personas only, with the
  fictional companies already seeded in the pilot.
- If a password is ever typed into the wrong place (a chat, a commit, a recording),
  rotate it that day — the same steps as above.
