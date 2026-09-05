/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
 *
 * Generate and display institution-scoped career-readiness reports.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiBaseUrl, ApiRequestError, getProtectedAccessToken } from './api.js';

interface InstitutionReport {
  readonly reportId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly expiresAt: string;
  readonly aggregate: {
    readonly suppressed: boolean;
    readonly minimumCohortSize: number;
    readonly cohortSize: number;
    readonly bands: readonly { readonly band: string; readonly count: number }[];
  };
}

const bandLabels: Record<string, string> = {
  NOT_ENOUGH_EVIDENCE: 'Not enough evidence',
  DEVELOPING: 'Developing',
  PROGRESSING: 'Progressing',
  READY_FOR_NEXT_STEP: 'Ready for next step',
};

export function InstitutionReportsPage({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const today = new Date().toISOString().slice(0, 10);
  const [periodStart, setPeriodStart] = useState(today.slice(0, 7) + '-01');
  const [periodEnd, setPeriodEnd] = useState(today);
  const [report, setReport] = useState<InstitutionReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setReport(null);
    setError('');
    setLoading(false);
    return () => request.current?.abort();
  }, [institutionId, token]);

  async function generate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !institutionId || request.current && !request.current.signal.aborted && loading) return;
    setReport(null);
    setError('');
    if (!periodStart || !periodEnd || periodEnd < periodStart) {
      setError('Choose a start date on or before the end date.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const correlationId = crypto.randomUUID();
    const query = new URLSearchParams({ periodStart, periodEnd });
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/v1/institutions/${encodeURIComponent(institutionId)}/career-readiness/reports?${query}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new ApiRequestError({ status: response.status, correlationId });
      const result = await response.json() as InstitutionReport;
      if (!controller.signal.aborted) setReport(result);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiRequestError && cause.status === 401) {
        setError('Your session has expired. Sign in again to generate a report.');
      } else if (cause instanceof ApiRequestError && cause.status === 403) {
        setError('You do not have permission to generate reports for this institution.');
      } else {
        setError(`Unable to generate the report. Try again. Reference: ${correlationId}`);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><h1>Reports</h1>
      <p>Career-readiness summaries for your institution. Select a reporting period to generate a report.</p>
    </div></div>
    {!token || !institutionId ? <p className="form-error" role="alert">Sign in to an institution workspace to generate reports.</p> : <>
      <form className="role-management-form role-card role-wide" onSubmit={(event) => void generate(event)}>
        <label>Start date<input type="date" required value={periodStart} disabled={loading} onChange={(event) => setPeriodStart(event.target.value)} /></label>
        <label>End date<input type="date" required value={periodEnd} min={periodStart} disabled={loading} onChange={(event) => setPeriodEnd(event.target.value)} /></label>
        <button type="submit" disabled={loading}>{loading ? 'Generating report…' : 'Generate report'}</button>
      </form>
      {loading ? <p role="status">Generating your institution report…</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!report && !loading && !error ? <p>Select a period and generate a report to view readiness data.</p> : null}
      {report ? <section className="role-card role-wide" aria-labelledby="institution-report-title">
        <h2 id="institution-report-title">Career-readiness report</h2>
        <p>Reporting period: <time dateTime={report.periodStart}>{report.periodStart}</time> to <time dateTime={report.periodEnd}>{report.periodEnd}</time></p>
        {report.aggregate.suppressed ? <p role="status">
          Results are withheld to protect student privacy. At least {report.aggregate.minimumCohortSize} students with readiness records are required for a report.
        </p> : <>
          <p>Students with readiness records: <strong>{report.aggregate.cohortSize}</strong></p>
          {report.aggregate.bands.length ? <div className="role-record-table-wrap"><table className="role-record-table">
            <caption>Readiness distribution</caption>
            <thead><tr><th scope="col">Readiness band</th><th scope="col">Students</th></tr></thead>
            <tbody>{report.aggregate.bands.map(({ band, count }) => <tr key={band}>
              <th scope="row">{bandLabels[band] ?? band}</th><td>{count}</td>
            </tr>)}</tbody>
          </table></div> : <p>No readiness records were returned for this period.</p>}
        </>}
        <p>Report reference: {report.reportId}</p>
        <p>Expires: <time dateTime={report.expiresAt}>{report.expiresAt.slice(0, 10)}</time></p>
      </section> : null}
    </>}
  </section>;
}
