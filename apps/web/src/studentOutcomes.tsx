/**
 * ONE · Student — share what you did after college (INST-13).
 *
 * Colleges report their graduates' outcomes for accreditation (NAAC, NBA, NIRF). ONE knows about a
 * placement only from applications a student shared; it knows nothing about higher studies or a
 * venture unless the student says so. This card, on the student's existing Profile page (no
 * navigation change), lets them tell a college they study at or graduated from, and withdraw it at
 * any time. The college never sees who: it appears only as a count in the college's accreditation
 * export, where any group under 5 is hidden, and it is labelled self-reported. Nothing is shared by
 * default and nothing else is collected.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { ApiRequestError } from './api.js';
import {
  listMyOutcomeDeclarations,
  selfReportedOutcomeLabels,
  shareOutcomeDeclaration,
  withdrawOutcomeDeclaration,
  type OutcomeCollegeDto,
  type SelfReportedOutcome,
} from './api/outcomes.js';

function formatDay(value: string | null): string {
  if (!value) return 'NA';
  const date = new Date(value + (value.length === 10 ? 'T00:00:00Z' : ''));
  return Number.isNaN(date.getTime()) ? 'NA' : date.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
}

function failure(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code === 'OUTCOME_COLLEGE_NOT_ELIGIBLE') {
    return `You can share this only with a college you study at or graduated from. Reference: ${error.correlationId}`;
  }
  return error instanceof ApiRequestError ? `${fallback} Reference: ${error.correlationId}` : fallback;
}

export function StudentOutcomesCard(): React.ReactElement | null {
  const [colleges, setColleges] = useState<readonly OutcomeCollegeDto[] | null>(null);
  const [choice, setChoice] = useState<Readonly<Record<string, SelfReportedOutcome | ''>>>({});
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const controller = new AbortController();
    listMyOutcomeDeclarations(token, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setColleges(response.colleges ?? []); setLoadError(''); }
    }).catch(() => { if (!controller.signal.aborted) setLoadError('Your outcome sharing could not be loaded.'); });
    return () => controller.abort();
  }, []);

  // Nobody to tell: a person with no college in ONE sees nothing here.
  if (!loadError && (!colleges || colleges.length === 0)) return null;

  async function share(college: OutcomeCollegeDto): Promise<void> {
    const token = getAccessToken();
    const outcome = choice[college.institutionId] || college.declaration?.outcome;
    if (!token || !outcome || busy) return;
    setBusy(true); setStatus(''); setError('');
    try {
      const response = await shareOutcomeDeclaration(token, college.institutionId, outcome);
      setColleges(response.colleges ?? []);
      setStatus(`Shared with ${college.institutionName}. It is counted from the start of next month, only as a number alongside other graduates.`);
    } catch (cause) {
      setError(failure(cause, 'That could not be shared.'));
    } finally { setBusy(false); }
  }

  async function withdraw(college: OutcomeCollegeDto): Promise<void> {
    const token = getAccessToken();
    if (!token || !college.declaration || busy) return;
    setBusy(true); setStatus(''); setError('');
    try {
      const response = await withdrawOutcomeDeclaration(token, college.declaration.id);
      setColleges(response.colleges ?? []);
      setChoice((current) => ({ ...current, [college.institutionId]: '' }));
      setStatus(`Withdrawn. ${college.institutionName} no longer counts it from its next export.`);
    } catch (cause) {
      setError(failure(cause, 'That could not be withdrawn.'));
    } finally { setBusy(false); }
  }

  return <section className="card wide-card" aria-labelledby="student-outcomes-title">
    <h2 id="student-outcomes-title">After college</h2>
    <p>Tell your college what you did after graduating. Your college never sees your name next to this: it appears only as a count in its accreditation reports, and any group of fewer than 5 people is hidden. It is marked as self-reported. Nothing is shared unless you choose, and you can withdraw it at any time.</p>
    {status ? <p className="role-api-success" role="status">{status}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : <ul className="hiring-list">
      {(colleges ?? []).map((college) => {
        const selected = choice[college.institutionId] ?? college.declaration?.outcome ?? '';
        return <li key={college.institutionId} className="hiring-list-item">
          <div>
            <h3>{college.institutionName}</h3>
            <p className="hiring-meta">{college.relationship === 'GRADUATED' ? `Graduated ${formatDay(college.graduatedOn)}` : 'Studying here now — counted once your graduation is recorded'}</p>
            <p className="hiring-meta">{college.declaration ? `Shared: ${selfReportedOutcomeLabels[college.declaration.outcome]} · since ${formatDay(college.declaration.declaredAt)}` : 'Nothing shared'}</p>
            <label className="student-form-field"><span>What did you go on to do?</span>
              <select value={selected} disabled={busy} onChange={(event) => setChoice((current) => ({ ...current, [college.institutionId]: event.target.value as SelfReportedOutcome | '' }))}>
                <option value="">Choose</option>
                {(Object.keys(selfReportedOutcomeLabels) as SelfReportedOutcome[]).map((key) => <option key={key} value={key}>{selfReportedOutcomeLabels[key]}</option>)}
              </select>
            </label>
          </div>
          <div className="hiring-actions">
            <button type="button" disabled={busy || !selected || selected === college.declaration?.outcome} onClick={() => { void share(college); }}>
              {college.declaration ? `Update what I share with ${college.institutionName}` : `Share with ${college.institutionName}`}
            </button>
            {college.declaration ? <button type="button" className="secondary" disabled={busy} onClick={() => { void withdraw(college); }}>Withdraw</button> : null}
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}
