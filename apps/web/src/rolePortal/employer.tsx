/**
 * ONE · Role portal — Stream B — Hiring
 *
 * The authenticated recruiter surface.
 *
 * Split out of rolePortalPages.tsx so each stream owns its own surface. The
 * shell and the route dispatcher remain there and import from here.
 */
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { EmployerApplicantsPage, EmployerOpportunitiesPage } from '../hiringPages.js';
import { StaffPilotWrap } from '../parityWraps.js';
import type { RolePortalConfig } from '../rolePortalConfig.js';
import { RestrictedApiState } from './shared.js';
import { useEffect, useState } from 'react';

export function EmployerRecruiterRealityPage({ portal, routeLabel }: { readonly portal: RolePortalConfig; readonly routeLabel: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [employerMembership, setEmployerMembership] = useState<{ readonly organizationId: string; readonly role: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSecurityContext(token, controller.signal).then((context) => {
      const membership = context.memberships.find((item) => ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(item.role));
      if (membership) setEmployerMembership({ organizationId: membership.organizationId, role: membership.role });
      else setError('This identity has no active employer-scoped membership.');
    }).catch(() => setError('Unable to resolve employer context.'));
    return () => controller.abort();
  }, [token]);
  if (!token) return <RestrictedApiState title="Sign in to manage hiring" message="Sign in with an employer identity to see your opportunities and applicants. Preview role switching is not authentication." />;
  if (error) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="alert" className="form-error">{error}</p></div></div></section>;
  if (!employerMembership) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="status">Loading your employer workspace…</p></div></div></section>;

  const employerId = employerMembership.organizationId;
  if (/opportunit/i.test(routeLabel)) {
    return <StaffPilotWrap title="Opportunities" subtitle="Post roles, choose their audience and publish. Applications land under Applicants.">
      <EmployerOpportunitiesPage employerId={employerId} /></StaffPilotWrap>;
  }
  if (/interview/i.test(routeLabel)) {
    return <StaffPilotWrap title="Applicants" subtitle="Move real candidates through your process; every change is logged.">
      <EmployerApplicantsPage employerId={employerId} applicationStateFilter="INTERVIEW" /></StaffPilotWrap>;
  }
  if (/offer/i.test(routeLabel)) {
    return <StaffPilotWrap title="Applicants" subtitle="Move real candidates through your process; every change is logged.">
      <EmployerApplicantsPage employerId={employerId} applicationStateFilter="OFFER" /></StaffPilotWrap>;
  }
  if (/applicant|candidate|talent/i.test(routeLabel)) {
    return <StaffPilotWrap title="Applicants" subtitle="Move real candidates through your process; every change is logged.">
      <EmployerApplicantsPage employerId={employerId} /></StaffPilotWrap>;
  }

  // Routes whose backend does not exist yet keep saying so rather than borrowing
  // another page's data.
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Coming later</span>
      <h1>{routeLabel}</h1>
      <p>Opportunities and Applicants carry your live pipeline today.</p>
    </div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not built yet"
      note={`${routeLabel} is on the roadmap but has no live workflow behind it yet - nothing here is hidden or broken.`}
      hint="Interviews and offers are managed from the applicant row on the Applicants page." /></div>
  </section>;
}
