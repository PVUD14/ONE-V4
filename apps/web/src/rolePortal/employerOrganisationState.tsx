/**
 * Employer organisation state gate (EMP-03).
 *
 * The API refuses a suspended or rejected employer everything except reading its own
 * status, and an unverified employer everything that publishes or touches candidates
 * (Appendix 2 §5.1). Without this gate those refusals would surface as a scatter of
 * failed loads on every page. Instead a suspended or rejected employer sees one plain
 * status page explaining what happened and what they can do, and an unverified
 * employer sees a short notice, with candidate pages saying plainly that they open
 * once the organisation is verified.
 *
 * This is display only. The server remains the authority: if the status cannot be
 * read the page renders as before and the API still refuses what it must. EMP-16: the status
 * page carries the organisation's trust cases, which a suspended employer may still answer.
 */
import { useEffect, useState } from 'react';
import { getEmployerOrganisationStatus, getProtectedAccessToken, type EmployerOrganisationStatusDto } from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { EmployerTrustCasesPanel } from './employerSettings.js';

const candidateRoutePattern = /applicant|candidate|talent|interview|offer|report|analytic|scorecard/i;

type GateState =
  | { readonly state: 'loading' }
  | { readonly state: 'known'; readonly organisation: EmployerOrganisationStatusDto }
  | { readonly state: 'unknown' };

export function EmployerOrganisationGate({ employerId, routeLabel, children }: {
  readonly employerId: string | null | undefined;
  readonly routeLabel: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const token = getProtectedAccessToken();
  const [gate, setGate] = useState<GateState>(token && employerId ? { state: 'loading' } : { state: 'unknown' });
  useEffect(() => {
    if (!token || !employerId) { setGate({ state: 'unknown' }); return undefined; }
    const controller = new AbortController();
    setGate({ state: 'loading' });
    getEmployerOrganisationStatus(token, employerId, controller.signal)
      // Anything other than a well-formed status is treated as unknown, never as a verdict.
      .then((response) => setGate(isOrganisationStatus(response?.organisation) ? { state: 'known', organisation: response.organisation } : { state: 'unknown' }))
      .catch(() => { if (!controller.signal.aborted) setGate({ state: 'unknown' }); });
    return () => controller.abort();
  }, [token, employerId]);

  if (gate.state === 'loading') {
    return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="status">Checking your organisation&apos;s status…</p></div></div></section>;
  }
  if (gate.state === 'unknown') return <>{children}</>;

  const { organisation } = gate;
  if (!organisation.canDraft) return <EmployerOrganisationStatusPage organisation={organisation} routeLabel={routeLabel} employerId={employerId ?? null} />;
  if (!organisation.canReachCandidates) {
    const notice = <section className="role-preview-notice" role="note"><span><strong>Awaiting verification</strong> - AI8HT operations is reviewing your organisation. You can prepare draft jobs now; publishing and candidates open once it is verified.</span></section>;
    if (candidateRoutePattern.test(routeLabel)) {
      return <section className="role-module role-module--dense">
        <div className="role-page-heading"><div>
          <span className="eyebrow">Awaiting verification</span>
          <h1>{routeLabel}</h1>
          <p>Candidates open once your organisation is verified.</p>
        </div></div>
        <div className="role-wide"><V2EmptyState icon="⏳" title="Available once your organisation is verified"
          note="AI8HT operations is reviewing your organisation. Until it is verified, jobs cannot be published and no candidate information is shared with you."
          hint="Opportunities is open now: you can prepare draft jobs and their audiences." /></div>
      </section>;
    }
    return <>{notice}{children}</>;
  }
  return <>{children}</>;
}

function isOrganisationStatus(value: unknown): value is EmployerOrganisationStatusDto {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.verificationState === 'string' && typeof record.canDraft === 'boolean' && typeof record.canReachCandidates === 'boolean';
}

/**
 * The plain status page for a suspended, rejected or inactive employer. EMP-16: it also lists the
 * trust and safety cases about the organisation, because answering one is the thing such an
 * employer can still do (§5.1).
 */
export function EmployerOrganisationStatusPage({ organisation, routeLabel, employerId = null }: {
  readonly organisation: EmployerOrganisationStatusDto; readonly routeLabel: string; readonly employerId?: string | null;
}): React.ReactElement {
  const rejected = organisation.verificationState === 'REJECTED';
  const title = rejected ? 'Your organisation was not verified' : organisation.verificationState === 'SUSPENDED' ? 'Your organisation is suspended' : 'Your organisation is not active';
  const note = rejected
    ? 'AI8HT operations did not verify this employer organisation, so it cannot publish jobs or see candidates.'
    : 'AI8HT operations has suspended this employer organisation. While it is suspended you cannot publish jobs or see candidates, and your published jobs are paused so students no longer see them.';
  const hint = rejected
    ? 'If you think this is a mistake, contact AI8HT operations. If operations has asked you to respond to a concern, or decided one, it is listed below.'
    : 'Contact AI8HT operations to resolve this. When the suspension is lifted your jobs stay paused until you publish them again. If operations has asked you to respond to a concern, or decided one, it is listed below.';
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Organisation status</span>
      <h1>{routeLabel}</h1>
      <p role="status">{title}.</p>
    </div></div>
    <div className="role-wide"><V2EmptyState icon="⛔" title={title} note={note} hint={hint} /></div>
    {employerId ? <EmployerTrustCasesPanel employerId={employerId} /> : null}
  </section>;
}
