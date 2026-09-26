/**
 * ONE · Role portal — Shared
 *
 * Workspace guards, the honest read-only / not-built / sign-in states, and error
 * formatting. Depends on nothing in the shell, so the families can import it freely.
 *
 * Split out of rolePortalPages.tsx so each stream owns its own surface. The
 * shell and the route dispatcher remain there and import from here.
 */
import { ApiRequestError } from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';

export interface AuthenticatedWorkspaceSummary {
  readonly role: string;
  readonly organizationId: string | null;
}

export const institutionWorkspaceRoles = new Set(['INSTITUTION_OWNER', 'INSTITUTION_ADMIN']);

export function isInstitutionWorkspace(workspace: AuthenticatedWorkspaceSummary | undefined): workspace is AuthenticatedWorkspaceSummary & { readonly organizationId: string } {
  return Boolean(workspace?.organizationId && institutionWorkspaceRoles.has(workspace.role));
}

// Staff surfaces (dashboard, exam engine) are shared with the wider institution
// staff roles; admin-only management pages keep the narrower set above.
export const institutionStaffWorkspaceRoles = new Set(['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER', 'CAREER_COUNSELOR']);

export function isInstitutionStaffWorkspace(workspace: AuthenticatedWorkspaceSummary | undefined): workspace is AuthenticatedWorkspaceSummary & { readonly organizationId: string } {
  return Boolean(workspace?.organizationId && institutionStaffWorkspaceRoles.has(workspace.role));
}

export function InstitutionWorkspaceError({ title, unauthorized = false }: { readonly title: string; readonly unauthorized?: boolean }): React.ReactElement {
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>{title}</h1><p>{unauthorized ? 'You do not have permission to perform this action.' : 'We could not resolve your institution workspace.'}</p></div></div><p className="form-error" role="alert">{unauthorized ? 'You do not have permission to perform this action.' : 'We could not load your institution workspace. Reference: workspace-context-missing'}</p></section>;
}

export function AuthenticatedReadOnlyModule({ title, detail }: { readonly title: string; readonly detail: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Read-only</span><h1>{title}</h1><p>{detail}</p></div></div>
    <div className="role-wide"><V2EmptyState icon="🔎" title="View-only for your role"
      note="You can see authorized context here, but changes for this module are not switched on yet for your role."
      hint="Assessments and Help & FAQ are fully live — use the sidebar to reach them." /></div></section>;
}

export function AuthenticatedNotYetAvailable({ title, detail }: { readonly title: string; readonly detail: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Coming later</span><h1>{title}</h1><p>{detail}</p></div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not built yet"
      note="This module is on the roadmap but has no live workflow behind it yet — nothing here is hidden or broken."
      hint="Your dashboard shows everything that is live for your role today." /></div></section>;
}

export function RestrictedApiState({ title, message }: { readonly title: string; readonly message: string }): React.ReactElement {
  return <section className="role-module"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>{title}</h1><p>{message}</p></div></div>
    <div className="role-wide"><V2EmptyState icon="🔐" title="Sign-in required"
      note="This protected workflow only renders for an authorized identity — no preview or fake data is substituted." /></div></section>;
}

export function formatApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  const message = safeErrorMessage(error.code) ?? fallback;
  return `${message}${error.field ? ` Field: ${error.field}.` : ''} Reference: ${error.correlationId}`;
}

export function safeErrorMessage(code: string | undefined): string | undefined {
  switch (code) {
    case 'CAREER_TOPIC_NOT_LIVE': return 'This set names topics that are not yet published. Publish those topics first, then publish the set.';
    case 'STUDENT_EMAIL_ALREADY_EXISTS': return 'This email is already associated with a ONE identity and cannot be attached automatically. Use the approved onboarding/recovery workflow.';
    case 'INSTITUTION_STUDENT_ID_ALREADY_EXISTS': return 'A Student with this institution ID already exists.';
    case 'INVALID_ACADEMIC_DATE_WINDOW': return 'Expected graduation date must be on or after academic start date.';
    case 'INVALID_ACADEMIC_UNIT_SCOPE': return 'Selected academic unit is not valid for this Institution and field.';
    case 'STAFF_INVITATION_ALREADY_PENDING': return 'Staff invitation already pending.';
    case 'TEAM_MEMBER_ALREADY_EXISTS': return 'This person is already on your team. To change their role, end their membership and invite them again.';
    case 'TEAM_INVITATION_ALREADY_PENDING': return 'An invitation to this address is already pending. Resend it instead.';
    case 'TEAM_INVITATION_NOT_PENDING': return 'This invitation is no longer pending. Refresh to see its current state.';
    case 'TEAM_MEMBER_NOT_ACTIVE': return 'This membership has already ended.';
    case 'TEAM_LAST_OWNER': return 'Your last owner cannot be removed. Add another owner through ONE operations first.';
    case 'TEAM_EMAIL_INVALID': return 'Enter a valid email address.';
    case 'EMPLOYER_ORGANISATION_INACTIVE': return 'Your employer account is suspended or was not approved, so your team cannot be changed.';
    case 'COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED': return 'Your legal name, display name, website, address and contact email are managed by AI8HT operations. Contact operations to change them.';
    case 'COMPANY_PROFILE_CAREERS_URL_OFF_DOMAIN': return 'The careers page must be on your company website, or a subdomain of it.';
    case 'COMPANY_PROFILE_PAYMENT_DEMAND': return 'The description asks students to pay. ONE does not allow asking candidates for fees or deposits.';
    case 'COMPANY_PROFILE_NOT_SET_UP': return 'AI8HT operations has not finished setting up your company record yet. Contact operations.';
    case 'COMPANY_PROFILE_INVALID': return 'Check the fields: the description is up to 2000 characters and web addresses start with https://.';
    case 'EMPLOYER_ACCESS_REQUEST_NOT_PENDING': return 'This request has already been decided. Refresh to see its current state.';
    case 'EMPLOYER_ACCESS_REQUEST_ORGANIZATION_INVALID': return 'Choose the employer organisation you created for this request.';
    // EMP-05: job lifecycle.
    case 'OPPORTUNITY_VERSION_CONFLICT': return 'Someone saved a newer version of this job while you were editing. Reload it and make your change again.';
    case 'OPPORTUNITY_NOT_EDITABLE': return 'A withdrawn job cannot be edited.';
    case 'OPPORTUNITY_PAYMENT_DEMAND': return 'The job text asks candidates to pay. ONE does not allow asking candidates for fees or deposits.';
    case 'OPPORTUNITY_TRANSITION_NOT_ALLOWED': return 'That action is not available for this job in its current state. Refresh to see where it is now.';
    case 'OPPORTUNITY_HAS_OPEN_APPLICATIONS': return 'Decide every open application first: move each one on, or reject it. To stop new applications now, close the job instead.';
    case 'OPPORTUNITY_DEADLINE_PASSED': return "This job's deadline has passed. Save a new version with a later deadline first.";
    case 'OPPORTUNITY_NOT_PUBLISHABLE': return 'Only a draft or paused job can be published.';
    case 'INVALID_APPLICATIONDEADLINE': return 'Choose a deadline in the future.';
    case 'REASON_CODE_REQUIRED': return 'Choose a reason.';
    // EMP-06: eligibility, skills and stages.
    case 'INVALID_ELIGIBILITY_RULES': return 'Check the eligibility rules: a minimum CGPA is on the 10-point scale (up to 10), backlogs are a whole number, and lists are separated by commas.';
    case 'DUPLICATE_ELIGIBILITY_RULE': return 'Each kind of rule can be set once. Combine the values into one rule.';
    case 'ELIGIBILITY_RULE_CANNOT_BLOCK': return 'Other requirements and work authorisation are shown to students but cannot decide who may apply.';
    case 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE': return 'A rule cannot refer to gender, religion, caste, age, disability, marital status, region of origin or a photo.';
    case 'UNKNOWN_INSTITUTION': return 'A college in a rule is not on ONE.';
    case 'INVALID_SKILLS': return 'Check the skills: each needs a name of up to 120 characters and a level.';
    case 'DUPLICATE_SKILL': return 'That skill is already listed.';
    case 'UNKNOWN_CATALOGUE_SKILL': return 'A chosen skill is no longer in the ONE catalogue. Search again.';
    case 'UNKNOWN_CAREER_ROLE': return 'The chosen catalogue role is no longer available.';
    case 'INVALID_STAGES': return 'Check the stages: each needs a kind and a name of up to 120 characters.';
    case 'STAGE_ORDER_INVALID': return 'Put the stages in order: screening, then assessments and group discussions, then interviews, with any offer last.';
    case 'INVALID_REASONCODE': return 'Choose a reason from the list.';
    case 'AUDIENCE_REQUIRED': return 'Choose who can see this job before it goes live.';
    case 'EMPLOYER_ORGANISATION_UNVERIFIED': return 'Your company is not verified yet, so jobs cannot go live. You can keep editing drafts.';
    case 'FORBIDDEN': return 'You do not have permission to perform this action.';
    // INST-SR-02: permanent record changes need a department (heads) or a teaching assignment (faculty).
    case 'SCOPE_REQUIRED': return 'You can view these records, but confirming or uploading results needs a department or teaching assignment on your account. Ask your institution administrator to assign one.';
    // OPS-02: dual control for high-risk actions.
    case 'APPROVAL_REQUIRED': return 'This is a high-risk action: it needs an approval from a second person first.';
    case 'APPROVAL_NOT_APPROVED': return 'This request has not been approved, or its approval was already used.';
    case 'APPROVAL_EXPIRED': return 'This approval has expired. File a new request.';
    case 'APPROVAL_PAYLOAD_MISMATCH': return 'The action no longer matches what was approved. File a new request.';
    case 'APPROVAL_NOT_REQUESTER': return 'Only the person who asked for this action can carry it out.';
    case 'APPROVAL_SELF_DECISION_REFUSED': return 'You cannot decide your own request while another approver exists.';
    case 'APPROVAL_SOLO_COOLING_OFF': return 'As the only approver you can approve your own request 15 minutes after filing it.';
    case 'APPROVAL_SUBJECT_CONFLICT': return 'You cannot approve a grant of capability to yourself.';
    case 'APPROVAL_NOT_PENDING': return 'This request has already been decided.';
    default: return undefined;
  }
}
