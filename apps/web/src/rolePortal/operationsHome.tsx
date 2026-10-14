/**
 * ONE · Role portal — Operations — the Platform overview (re-skin phase 7)
 *
 * The operations Overview in the approved Momentum composition (inventory 06-screens/operations.html):
 * organisations and people on ONE, the queues waiting on operators, trust and safety, privacy,
 * background jobs and support. It replaces the earlier dashboard, which printed "NA" in every slot
 * the caller's access did not cover.
 *
 * It still renders from the one server-side summary (OPS-03) and fetches nothing else: a section
 * the caller's capabilities do not cover arrives as null and its block is left out. Counts of people
 * go through <SmallCount> (the server already withholds them under five); counts of records
 * (organisations, cases, requests) are shown as they are, with "+" once the server's cap is reached.
 * No names or contact details are in the summary, so none are shown.
 *
 * The approved page's AI operations, uptime, subscriptions and audit blocks have no source in the
 * summary; they are left out here and live on their own screens.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon.js';
import {
  ApiRequestError,
  getOperationsOverview,
  getProtectedAccessToken,
  type OperationsOverviewDto,
  type OverviewCountDto,
  type OverviewPeopleCountDto,
} from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { SupportCode } from '../supportCode.js';
import { formatDate } from '../dates.js';
import { codeLabel, roleLabel } from '../labels.js';
import { SmallCount, SuppressedBlock, SuppressedLegend, isSmallCount, partitionNeedsRanges } from '../momentum/smallCount.js';
import { StatusTag } from '../momentum/statusTag.js';
import { IhCard, IhClear, IhKpis, IhNote, IhPage, IhRows, IhTiles, go, shortDate } from './institutionMomentum.js';
import { Loading } from '../momentum/loader.js';

/** A count of records: the number, with "+" once the server's cap is reached. */
export function overviewCountText(count: OverviewCountDto): string {
  return count.capped ? `${count.value.toLocaleString('en-IN')}+` : count.value.toLocaleString('en-IN');
}

function RecordFigure({ count }: { readonly count: OverviewCountDto }): React.ReactElement {
  return <span className="num">{overviewCountText(count)}</span>;
}

/** A count of people: "<5" when withheld or under five, the number (with "+" when capped) otherwise. */
function PeopleFigure({ count, range = false }: { readonly count: OverviewPeopleCountDto; readonly range?: boolean }): React.ReactElement {
  return <SmallCount value={count} range={range} format={(value) => `${value.toLocaleString('en-IN')}${count.capped ? '+' : ''}`} />;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

type OverviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly overview: OperationsOverviewDto }
  | { readonly kind: 'forbidden'; readonly reference: string }
  | { readonly kind: 'error'; readonly reference: string | null };

// --- Cards -------------------------------------------------------------------------------------

function QueuesCard({ overview, open }: { readonly overview: OperationsOverviewDto; readonly open: (path: string) => () => void }): React.ReactElement | null {
  const { verification, employerAccessRequests, approvals } = overview;
  const tiles = [
    verification && { key: 'verification', label: 'Organizations awaiting a decision', value: <RecordFigure count={verification.awaitingDecision} />, muted: verification.awaitingDecision.value === 0 },
    verification && { key: 'review', label: 'Under review', value: <RecordFigure count={verification.underReview} />, muted: verification.underReview.value === 0 },
    employerAccessRequests && { key: 'access', label: 'Employer access requests', value: <RecordFigure count={employerAccessRequests.pending} />, muted: employerAccessRequests.pending.value === 0 },
    approvals && { key: 'approvals', label: 'Approvals awaiting a second operator', value: <RecordFigure count={approvals.pending} />, muted: approvals.pending.value === 0 },
  ].filter((tile): tile is NonNullable<typeof tile> & object => Boolean(tile));
  if (!tiles.length) return null;
  return <IhCard title="Verification queue" link={verification ? { label: 'Open Verification', onClick: open('/verification') } : null}>
    <IhTiles columns={Math.min(tiles.length, 4)} tiles={tiles} />
    <ul className="ih-list ih-gap">
      {employerAccessRequests ? <li className="ih-li" data-queue="employer-access">
        <span className="ih-li-i" aria-hidden="true"><Icon name="company" size={16} /></span>
        <div className="ih-li-t"><b>Employer access requests</b><small>{employerAccessRequests.oldestPendingAt ? `Oldest waiting since ${formatDate(employerAccessRequests.oldestPendingAt)}` : 'None waiting'}</small></div>
        <button type="button" className="pilot-btn ghost small" onClick={open('/organizations')}>Open Organizations</button>
      </li> : null}
      {approvals ? <li className="ih-li" data-queue="approvals">
        <span className="ih-li-i" aria-hidden="true"><Icon name="verification" size={16} /></span>
        <div className="ih-li-t"><b>Approvals</b><small>{approvals.awaitingExecution.value ? `${overviewCountText(approvals.awaitingExecution)} approved, awaiting execution` : 'Nothing approved is waiting to run'}</small></div>
        <button type="button" className="pilot-btn ghost small" onClick={open('/settings')}>Open Settings</button>
      </li> : null}
    </ul>
    <IhNote icon="info">Two-person rule: a change that needs approval takes effect only after a second operator agrees.</IhNote>
  </IhCard>;
}

function TrustCard({ trust, open }: { readonly trust: NonNullable<OperationsOverviewDto['trustSafety']>; readonly open: () => void }): React.ReactElement {
  const severity = trust.bySeverity;
  return <IhCard title="Trust & safety" link={{ label: 'Open cases', onClick: open }}>
    {trust.open.value === 0 ? <IhClear title="No open cases" line="Nothing has been reported that still needs a decision." />
      : <div className="ih-wait"><b className="num">{overviewCountText(trust.open)}</b><span>open {plural(trust.open.value, 'case', 'cases')} · {overviewCountText(trust.unassigned)} unassigned</span></div>}
    <IhRows rows={[
      ['Critical', <RecordFigure key="c" count={severity.CRITICAL} />, severity.CRITICAL.value ? 'warn' : undefined],
      ['High', <RecordFigure key="h" count={severity.HIGH} />, severity.HIGH.value ? 'warn' : undefined],
      ['Medium', <RecordFigure key="m" count={severity.MEDIUM} />],
      ['Low', <RecordFigure key="l" count={severity.LOW} />],
    ]} />
  </IhCard>;
}

function HealthCard({ jobs, open }: { readonly jobs: NonNullable<OperationsOverviewDto['jobs']>; readonly open: () => void }): React.ReactElement {
  const clear = jobs.failedEvents.value === 0 && jobs.openAlerts.value === 0;
  return <IhCard title="System health" link={{ label: 'System Health', onClick: open }}>
    {clear ? <IhClear title="Background work is healthy" line="No failed background events and no open health alerts." />
      : <div className="ih-wait"><span className="ih-ci warm" aria-hidden="true"><Icon name="warning" size={16} /></span><span>Background work needs a look</span></div>}
    <IhRows rows={[
      ['Failed background events', <RecordFigure key="f" count={jobs.failedEvents} />, jobs.failedEvents.value ? 'warn' : 'ok'],
      ['Open health alerts', <RecordFigure key="a" count={jobs.openAlerts} />, jobs.openAlerts.value ? 'warn' : 'ok'],
    ]} />
  </IhCard>;
}

function PrivacyCard({ requests, holds, open }: {
  readonly requests: OperationsOverviewDto['privacyRequests']; readonly holds: OperationsOverviewDto['privacyHolds']; readonly open: () => void;
}): React.ReactElement {
  const rows: (readonly [string, React.ReactNode, ('ok' | 'warn' | undefined)?])[] = [];
  if (requests) {
    rows.push(['Open privacy requests', <RecordFigure key="o" count={requests.open} />]);
    rows.push(['Data exports in progress', <RecordFigure key="e" count={requests.openExports} />]);
    rows.push(['Deletions in progress', <RecordFigure key="d" count={requests.openDeletions} />]);
    rows.push(['Deletions due within 7 days', <RecordFigure key="s" count={requests.deletionsDueWithin7Days} />, requests.deletionsDueWithin7Days.value ? 'warn' : undefined]);
    rows.push(['Failed', <RecordFigure key="f" count={requests.failed} />, requests.failed.value ? 'warn' : undefined]);
  }
  if (holds) rows.push(['Active legal holds', <RecordFigure key="h" count={holds.active} />]);
  return <IhCard title="Privacy" link={{ label: 'Security', onClick: open }}>
    <IhRows rows={rows} />
    {holds ? <IhNote>Releasing a legal hold needs a second person’s approval.</IhNote> : null}
  </IhCard>;
}

function PeopleCard({ accounts, open }: { readonly accounts: NonNullable<OperationsOverviewDto['accounts']>; readonly open: () => void }): React.ReactElement {
  const parts = [accounts.students, accounts.withOrganizationRoles];
  const total = accounts.total.suppressed || accounts.total.capped ? null : accounts.total.value;
  const ranged = partitionNeedsRanges(parts, total);
  const bars = !ranged && !accounts.total.suppressed && !accounts.total.capped;
  const row = (label: string, count: OverviewPeopleCountDto, part = true) => {
    const small = isSmallCount(count);
    return <li key={label}>
      <div className="bh-share-h"><span>{label}</span><b><PeopleFigure count={count} range={part && ranged} /></b></div>
      {small ? <SuppressedBlock /> : bars && count.value !== null ? <div className="bh-track" aria-hidden="true"><i style={{ width: `${Math.min(100, (count.value / Math.max(1, accounts.total.value ?? 1)) * 100)}%` }} /></div> : null}
    </li>;
  };
  const anySmall = parts.some((part) => isSmallCount(part)) || isSmallCount(accounts.total);
  return <IhCard title="People on ONE" link={{ label: 'Users', onClick: open }}>
    <ul className="bh-share">
      {row('All accounts', accounts.total, false)}
      {row('Student accounts', accounts.students)}
      {row('With an organization role', accounts.withOrganizationRoles)}
    </ul>
    {anySmall ? <SuppressedLegend /> : null}
    <IhNote icon="info">{ranged ? 'Counts of fewer than five people read “<5”, and the others show as ranges so a small group cannot be worked out from the total.' : 'Counts of fewer than five people read “<5”.'}</IhNote>
  </IhCard>;
}

function OrganisationsCard({ organizations, open }: { readonly organizations: NonNullable<OperationsOverviewDto['organizations']>; readonly open: () => void }): React.ReactElement {
  return <IhCard title="Organizations" link={{ label: 'Organizations', onClick: open }}>
    <IhTiles columns={3} tiles={[
      { key: 'colleges', icon: 'organizations', label: 'Colleges', value: <RecordFigure count={organizations.institutions.total} /> },
      { key: 'employers', icon: 'company', label: 'Employers', value: <RecordFigure count={organizations.employers.total} /> },
      { key: 'active', label: 'Active', value: <RecordFigure count={organizations.active} /> },
    ]} />
    {organizations.recent.length ? <ul className="ih-list ih-gap">{organizations.recent.slice(0, 4).map((organization) => <li key={organization.id} className="ih-li">
      <span className="ih-li-i" aria-hidden="true"><Icon name={organization.kind === 'INSTITUTION' ? 'organizations' : 'company'} size={16} /></span>
      <div className="ih-li-t"><b>{organization.name}</b><small>{organization.kind === 'INSTITUTION' ? 'College' : 'Employer'}{organization.active ? '' : ' · Inactive'}</small></div>
      <StatusTag kind="verification" state={organization.verificationState} label={codeLabel(organization.verificationState)} />
    </li>)}</ul> : <p className="ih-empty ih-gap">No organizations onboarded yet.</p>}
  </IhCard>;
}

function InvitationsCard({ invitations, open }: { readonly invitations: NonNullable<OperationsOverviewDto['invitations']>; readonly open: () => void }): React.ReactElement {
  const { staff, student } = invitations;
  return <IhCard title="Invitations" link={{ label: 'Users', onClick: open }}
    aside={staff.total.value ? `${overviewCountText(staff.accepted)} of ${overviewCountText(staff.total)} staff accepted` : null}>
    <IhTiles columns={3} tiles={[
      { key: 'pending', label: 'Staff pending', value: <RecordFigure count={staff.pending} />, muted: staff.pending.value === 0 },
      { key: 'stale', label: 'Pending over 72 hours', value: <RecordFigure count={staff.pendingOver72Hours} />, muted: staff.pendingOver72Hours.value === 0 },
      { key: 'undelivered', label: 'Student invitations not delivered', value: <RecordFigure count={student.notDelivered} />, muted: student.notDelivered.value === 0 },
    ]} />
    {invitations.expiringSoon.length ? <ul className="ih-list ih-gap">{invitations.expiringSoon.slice(0, 3).map((invitation) => {
      const when = new Date(invitation.expiresAt);
      return <li key={invitation.id} className="ih-li">
        <span className="ih-date" aria-hidden="true"><small>{when.toLocaleDateString('en-GB', { month: 'short' })}</small><b>{when.getDate()}</b></span>
        <div className="ih-li-t"><b>Invitation expires</b><small>{[invitation.role ? roleLabel(invitation.role) : null, invitation.organizationName].filter(Boolean).join(' · ') || 'Staff invitation'}</small></div>
      </li>;
    })}</ul> : null}
    <IhNote>Membership is created only after the verified recipient accepts. Recipients are listed on the Users screen, not here.</IhNote>
  </IhCard>;
}

function SupportCard({ support, open }: { readonly support: NonNullable<OperationsOverviewDto['support']>; readonly open: () => void }): React.ReactElement {
  return <IhCard title="Support" link={{ label: 'Support', onClick: open }}>
    <IhTiles columns={3} tiles={[
      { key: 'open', label: 'Open cases', value: <RecordFigure count={support.open} />, muted: support.open.value === 0 },
      { key: 'overdue', label: 'Past SLA', value: <RecordFigure count={support.overdue} />, muted: support.overdue.value === 0 },
      { key: 'unassigned', label: 'Unassigned', value: <RecordFigure count={support.unassigned} />, muted: support.unassigned.value === 0 },
    ]} />
  </IhCard>;
}

// --- Page --------------------------------------------------------------------------------------

export function OperationsHome({ basePath }: { readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<OverviewState>({ kind: 'loading' });
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    getOperationsOverview(token, controller.signal)
      .then((response) => setState({ kind: 'ready', overview: response.overview }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setState({ kind: 'forbidden', reference: cause.correlationId });
        else setState({ kind: 'error', reference: cause instanceof ApiRequestError ? cause.correlationId : null });
      });
    return () => controller.abort();
  }, [token]);

  if (state.kind === 'forbidden') {
    return <V2EmptyState illustration="no-access" icon="🔐" title="Not permitted" note="The operations overview is for AI8HT operations staff. Your access has not changed." hint={<SupportCode reference={state.reference} />} />;
  }
  if (state.kind === 'error') {
    return <V2EmptyState illustration="500-something-went-wrong" icon="⚠️" title="The overview could not be loaded" note="Nothing on this page is shown until the server's counts load. Try again shortly."
      {...(state.reference ? { hint: <SupportCode reference={state.reference} /> } : {})} />;
  }

  const overview = state.kind === 'ready' ? state.overview : null;
  const open = (path: string) => () => go(`${basePath}${path}`);
  const organizations = overview?.organizations ?? null;
  const trust = overview?.trustSafety ?? null;
  const hasQueues = Boolean(overview && (overview.verification || overview.employerAccessRequests || overview.approvals));

  return <IhPage className="bh" eyebrow="ONE platform" title="Platform overview"
    summary="Organizations and people on ONE, the queues waiting on operators, and how the platform is running."
    actions={<>
      <button type="button" className="pilot-btn ghost" onClick={open('/audit-logs')}><Icon name="audit-logs" size={16} /> Open audit log</button>
      {organizations ? <button type="button" className="pilot-btn" onClick={open('/organizations')}><Icon name="plus" size={16} /> Add an organization</button> : null}
    </>}>
    {!overview ? <Loading className="ih-empty">Loading the operations workspace…</Loading> : <>
      <IhKpis items={[
        organizations && { key: 'orgs', icon: 'organizations', value: <RecordFigure count={organizations.total} />, label: 'Organizations',
          note: `${overviewCountText(organizations.institutions.total)} ${plural(organizations.institutions.total.value, 'college', 'colleges')} · ${overviewCountText(organizations.employers.total)} ${plural(organizations.employers.total.value, 'employer', 'employers')}` },
        overview.accounts && { key: 'people', icon: 'users', value: <PeopleFigure count={overview.accounts.total} />, label: 'People on ONE' },
        overview.verification && { key: 'verify', icon: 'verification', value: <RecordFigure count={overview.verification.awaitingDecision} />, label: 'To verify',
          note: `${overviewCountText(overview.verification.underReview)} under review` },
        trust && { key: 'trust', icon: 'trust-safety', value: <RecordFigure count={trust.open} />, label: trust.open.value === 1 ? 'Open safety case' : 'Open safety cases',
          note: `${overviewCountText(trust.bySeverity.CRITICAL)} critical · ${overviewCountText(trust.bySeverity.HIGH)} high` },
        overview.support && { key: 'support', icon: 'support', value: <RecordFigure count={overview.support.open} />, label: overview.support.open.value === 1 ? 'Open support case' : 'Open support cases',
          note: `${overviewCountText(overview.support.overdue)} past their SLA` },
      ]} />
      <div className="ih-grid">
        {hasQueues ? <div className={trust ? 'ih-c8' : 'ih-c12'}><QueuesCard overview={overview} open={open} /></div> : null}
        {trust ? <div className={hasQueues ? 'ih-c4' : 'ih-c6'}><TrustCard trust={trust} open={open('/trust-and-safety')} /></div> : null}
        {organizations ? <div className="ih-c8"><OrganisationsCard organizations={organizations} open={open('/organizations')} /></div> : null}
        {overview.jobs ? <div className="ih-c4"><HealthCard jobs={overview.jobs} open={open('/system-health')} /></div> : null}
        {overview.invitations ? <div className="ih-c8"><InvitationsCard invitations={overview.invitations} open={open('/users')} /></div> : null}
        {overview.privacyRequests || overview.privacyHolds ? <div className="ih-c4"><PrivacyCard requests={overview.privacyRequests} holds={overview.privacyHolds} open={open('/security')} /></div> : null}
        {overview.accounts ? <div className="ih-c4"><PeopleCard accounts={overview.accounts} open={open('/users')} /></div> : null}
        {overview.support ? <div className="ih-c4"><SupportCard support={overview.support} open={open('/support')} /></div> : null}
        <div className="ih-c4"><IhCard title="Protected boundaries">
          <div className="bh-lockbox"><Icon name="lock" size={16} />
            <div><b>Operations sees counts, not people</b><small>Operations never sees a student’s private progress, an employer’s hiring records beyond scope, or anyone’s secrets. This overview carries counts only — no names or contact details.</small></div>
          </div>
          <IhNote icon="info">Counts stop at 10,000 and then read 10,000+. Updated {shortDate(overview.generatedAt) ?? 'just now'}.</IhNote>
        </IhCard></div>
      </div>
    </>}
  </IhPage>;
}
