/**
 * The employer's Reports screen (EMP-15): funnel and stage drop-off by job, by college and by
 * campus drive, time to shortlist, interview, offer and hire, and offer outcomes — all from
 * GET /employers/:id/reports.
 *
 * Every figure about people arrives already suppressed by the server: a group under 5 is shown as
 * "<5" and a total that would reveal such a group reads "Withheld". The screen never adds withheld
 * cells together or derives a figure the server did not send, and it shows no candidate. It
 * replaces the earlier unsuppressed hiring-analytics view on the same Reports label (no navigation
 * change).
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from '../auth.js';
import { getEmployerReports, type EmployerReportsDto, type ReportCountDto, type ReportTableDto } from '../api/hiring.js';
import { V2Stat } from '../dashboardsV2.js';
import { formatApiError } from './shared.js';

const cellLabels: readonly (readonly [string, string])[] = [
  ['APPLIED', 'Applied'], ['SCREENING', 'Screening'], ['SHORTLISTED', 'Shortlisted'], ['ASSESSMENT', 'Assessment'],
  ['INTERVIEW', 'Interview'], ['OFFER', 'Offer'], ['HIRED', 'Hired'],
  ['LEFT_AT_APPLIED', 'Left at applied'], ['LEFT_AT_SCREENING', 'Left at screening'], ['LEFT_AT_SHORTLISTED', 'Left at shortlisted'],
  ['LEFT_AT_ASSESSMENT', 'Left at assessment'], ['LEFT_AT_INTERVIEW', 'Left at interview'], ['LEFT_AT_OFFER', 'Left at offer'],
];
const metricLabels: Readonly<Record<string, string>> = {
  SHORTLIST: 'Submission to shortlist', INTERVIEW: 'Submission to interview', OFFER: 'Submission to first offer', HIRE: 'Submission to hire',
};
const offerLabels: readonly (readonly [string, string])[] = [
  ['EXTENDED', 'Awaiting an answer'], ['ACCEPTED', 'Accepted'], ['DECLINED', 'Declined'], ['EXPIRED', 'Expired'], ['WITHDRAWN', 'Withdrawn by you'],
];
const driveStateLabels: Readonly<Record<string, string>> = {
  REQUESTED: 'Awaiting the college', CHANGES_REQUESTED: 'Changes requested', APPROVED: 'Approved', SCHEDULED: 'Scheduled',
  REJECTED: 'Declined by the college', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};

function count(value: ReportCountDto): string {
  return value.suppressed || value.value === null ? '<5' : String(value.value);
}
function cellValue(table: ReportTableDto, key: string): string {
  const found = table.cells.find((cell) => cell.key === key);
  return !found || found.suppressed || found.count === null ? '<5' : String(found.count);
}
function total(table: ReportTableDto): string {
  if (table.suppressed) return '<5';
  return table.total.suppressed || table.total.value === null ? 'Withheld' : String(table.total.value);
}

function StageTable({ caption, groupHeading, rows, empty }: {
  readonly caption: string; readonly groupHeading: string; readonly empty: string;
  readonly rows: readonly { readonly key: string; readonly label: React.ReactNode; readonly table: ReportTableDto }[];
}): React.ReactElement {
  if (!rows.length) return <p>{empty}</p>;
  return <div className="role-record-table-wrap"><table className="role-record-table">
    <caption className="sr-only">{caption}</caption>
    <thead><tr><th>{groupHeading}</th><th>Applications</th>{cellLabels.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
    <tbody>{rows.map((row) => <tr key={row.key}>
      <td>{row.label}</td><td>{total(row.table)}</td>
      {row.table.suppressed
        ? <td colSpan={cellLabels.length}>Fewer than 5 applications — not broken down.</td>
        : cellLabels.map(([key]) => <td key={key}>{cellValue(row.table, key)}</td>)}
    </tr>)}</tbody>
  </table></div>;
}

export function EmployerReportsPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [result, setResult] = useState<{ readonly employerId: string; readonly reports: EmployerReportsDto } | null>(null);
  const [status, setStatus] = useState('Loading your hiring reports…');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); setFailed(true); return undefined; }
    setFailed(false);
    void getEmployerReports(token, employerId, abort.signal).then(({ reports }) => {
      if (!abort.signal.aborted) { setResult({ employerId, reports }); setStatus(''); }
    }).catch((error: unknown) => {
      if (abort.signal.aborted) return;
      setFailed(true);
      setStatus(formatApiError(error, 'Your hiring reports could not be loaded.'));
    });
    return () => abort.abort();
  }, [employerId]);
  const reports = result?.employerId === employerId ? result.reports : null;
  const timing = (metric: string) => reports?.timeToStage?.find((row) => row.metric === metric);
  const offerDays = timing('OFFER');

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><h1>Hiring reports</h1>
      <p>Every application to your jobs, grouped. No candidate is shown: any group of fewer than {reports?.threshold ?? 5} people reads &quot;&lt;5&quot;,
        and a total reads &quot;Withheld&quot; when it would let a small group be worked out.</p></div></div>
    {status ? <p role={failed ? 'alert' : 'status'}>{status}</p> : null}

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📨" tone="blue" label="Applications" value={reports ? total(reports.overall) : 'NA'} />
      <V2Stat icon="⏱" tone="amber" label="Median days to first offer" value={!offerDays ? 'NA' : offerDays.medianDays === null ? 'Too few offers' : offerDays.medianDays.toFixed(1)} />
      <V2Stat icon="🤝" tone="green" label="Offer acceptance" value={!reports ? 'NA' : reports.offers.acceptanceRate === null ? 'Too few answers' : `${(reports.offers.acceptanceRate * 100).toFixed(0)}%`} />
      <V2Stat icon="🏫" tone="indigo" label="Campus drives" value={reports ? reports.byDrive.length : 'NA'} />
    </div>

    <section className="role-card role-wide"><h2>Where applications are now</h2>
      <p>Open applications by their current stage, hires, and — for rejected or withdrawn applications — the stage they left at.</p>
      {reports ? <StageTable caption="All applications" groupHeading="All jobs" empty="No applications yet."
        rows={[{ key: 'overall', label: 'All jobs', table: reports.overall }]} /> : <p>NA</p>}
    </section>

    <section className="role-card role-wide"><h2>Funnel by job</h2>
      {reports ? <StageTable caption="Funnel by job" groupHeading="Job" empty="No published jobs yet."
        rows={reports.byJob.map((job) => ({ key: job.opportunityId, label: <>{job.title ?? 'Untitled'}{job.referenceCode ? <span className="hiring-meta"> · {job.referenceCode}</span> : null}</>, table: job.table }))} /> : <p>NA</p>}
      {reports?.byJobTruncated ? <p>Showing your 200 most recent jobs.</p> : null}
    </section>

    <section className="role-card role-wide"><h2>Funnel by college</h2>
      <p>The college each student named in the application they chose to share with you. A college is named only when at least 5 applications name it; the rest are grouped.</p>
      {reports ? <StageTable caption="Funnel by college" groupHeading="College" empty="No applications yet."
        rows={reports.byCollege.map((group, index) => ({ key: group.collegeName ?? `other-${index}`, label: group.collegeName ?? 'Other colleges or not stated', table: group.table }))} /> : <p>NA</p>}
    </section>

    <section className="role-card role-wide"><h2>Funnel by campus drive</h2>
      {reports ? <StageTable caption="Funnel by campus drive" groupHeading="Drive" empty="No campus drives yet. Request one from a job's Opportunity Detail."
        rows={reports.byDrive.map((drive) => ({ key: drive.driveId, label: <>{drive.institutionName}<span className="hiring-meta"> · {drive.opportunityTitle ?? 'Untitled'} · {driveStateLabels[drive.state] ?? drive.state}</span></>, table: drive.table }))} /> : <p>NA</p>}
      {reports?.byDriveTruncated ? <p>Showing your 200 most recent drives.</p> : null}
    </section>

    <section className="role-card role-wide"><h2>Time to each stage</h2>
      <p>Median days from submission, over applications that reached the stage. Shown only when at least 5 did.</p>
      {reports ? <div className="role-record-table-wrap"><table className="role-record-table"><thead><tr><th>Step</th><th>Applications</th><th>Median days</th></tr></thead>
        <tbody>{reports.timeToStage.map((row) => <tr key={row.metric}><td>{metricLabels[row.metric] ?? row.metric}</td><td>{count(row.applications)}</td>
          <td>{row.medianDays === null ? 'NA' : row.medianDays.toFixed(1)}</td></tr>)}</tbody></table></div> : <p>NA</p>}
    </section>

    <section className="role-card role-wide"><h2>Offer outcomes</h2>
      <p>The latest offer on each application. The acceptance rate is accepted ÷ (accepted + declined + expired), shown only when both groups hold at least 5.</p>
      {reports ? <div className="role-record-table-wrap"><table className="role-record-table"><thead><tr><th>Outcome</th><th>Applications</th></tr></thead>
        <tbody>{reports.offers.table.suppressed
          ? <tr><td colSpan={2}>Fewer than 5 applications have an offer — not broken down.</td></tr>
          : offerLabels.map(([key, label]) => <tr key={key}><td>{label}</td><td>{cellValue(reports.offers.table, key)}</td></tr>)}
        <tr><td>All offers</td><td>{total(reports.offers.table)}</td></tr></tbody></table></div> : <p>NA</p>}
    </section>
  </section>;
}
