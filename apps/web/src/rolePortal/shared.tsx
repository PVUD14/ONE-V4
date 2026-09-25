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
    case 'FORBIDDEN': return 'You do not have permission to perform this action.';
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
