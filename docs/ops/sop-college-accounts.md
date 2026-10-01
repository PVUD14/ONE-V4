# SOP — College account fields and contacts (Organization Detail → College account)

> What this is: the operator procedure for a college's account record: renewal date, contract
> reference, AI8HT account owner and the college's contacts. Why it exists: Appendix 1 OPS-17 (full)
> needs an SOP for every shipped module. Built by OPS-14. Written 2026-10-01 against base `719eb34`.

## Purpose

Keep the facts customer success needs (when the contract renews, who owns the account, whom to call)
in ONE, with contact details masked unless there is a reason to see them.

## Who and what capability

You need `ACCOUNT_MANAGE` for every read and write. OPERATIONS_ADMIN and the super admin hold it by
baseline. It can be granted to SECURITY_ADMIN. No action here needs an approval.

## Where

**Operations → Organization Detail → College account**, below the organisation list. Pick the
college from **College**.

## Steps

1. **Edit account fields…** sets any of these:
   - **Renewal date**: a real date.
   - **Contract reference**: an identifier only (letters, digits and `/ _ . : -`, no spaces). It
     cannot hold an amount. ONE stores no contract values.
   - **Owner**: an ACTIVE AI8HT operator.

   Choose a reason (`NEW_CONTRACT`, `RENEWAL_AGREED`, `OWNER_HANDOVER`, `CORRECTION`). The note is
   optional, at most 500 characters. Press **Save**. If someone else saved first, you get
   `COLLEGE_ACCOUNT_VERSION_CONFLICT`: reload and redo.
2. **Add contact…**:
   - role: `PRINCIPAL`, `PLACEMENT_OFFICER`, `ACADEMIC_COORDINATOR`, `IT_CONTACT`, `ACCOUNTS` or
     `OTHER`;
   - a name, and an email or a phone;
   - a reason: `NEW_CONTACT`, `CONTACT_REPLACED` or `CORRECTION`.

   A college can have at most 10 live contacts.
3. Contacts show masked (`m***@college.edu`, `***2345`). **Reveal…** only when you are about to use
   the contact, with `RENEWAL_OUTREACH`, `SUPPORT_FOLLOW_UP`, `ONBOARDING` or `ESCALATION`. The reveal
   is audited before the value is shown.
4. **Remove…** a contact with `CONTACT_LEFT`, `CONTACT_REPLACED`, `PRIVACY_REQUEST` or `CORRECTION`.
   Removal erases the name, email and phone for good. To correct a contact, remove it and add it again.

## A contact's privacy request

A college contact is not a ONE user, so the student and staff deletion flow does not reach them.
To serve their request, **Remove…** them with `PRIVACY_REQUEST`, then log a support case
(`PRIVACY_REQUEST`) recording that it was done, with no contact details in it.

## Never do

- Never type personal data into the note. Notes go into the audit log, which cannot be erased.
- Never record fees, amounts or bank details anywhere here. Billing is deferred (ADR-022).
- Never reveal a contact "to check". Every reveal names you.

## Gaps

- The **College** picker is filled from the organisations list, which needs `OPS_ORG_MANAGE`. An
  operator holding only `ACCOUNT_MANAGE` sees an empty picker with no message (security review
  OPS-SR-41).
- Contact names are shown in full. Only email and phone are masked.
- There is no renewal reminder, and reveals are not rate-limited.

## UAT

[ONE_OPERATIONS_UAT_V1.md](../uat/ONE_OPERATIONS_UAT_V1.md): O-14.
