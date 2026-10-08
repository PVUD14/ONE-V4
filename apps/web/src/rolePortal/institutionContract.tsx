/**
 * ONE · Role portal — Institution — data-processing terms and leaving ONE (INST-18)
 *
 * Two sections of the admin's existing Settings page (no navigation change), replacing its
 * "Data-processing terms — not built yet" state:
 *  - the college's data-processing terms: status, the text with its legal-review label (a draft is
 *    never presented as final), and Accept for an owner;
 *  - "Leaving ONE": the college's exit, if any, and — while a notice is open — the exit export, one
 *    file per section, with the plain list of what it never contains. Counselling notes sit apart and
 *    need an explicit confirmation and a listed reason.
 *
 * Whether the viewer may accept or export is always the server's answer. Real data only.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api.js';
import {
  acceptInstitutionDataTerms,
  downloadInstitutionExitExport,
  getInstitutionDataTerms,
  getInstitutionExit,
  type InstitutionDataTermsDto,
  type InstitutionExitDto,
  type InstitutionExitExportDto,
  type InstitutionExitExportSection,
} from '../api/institutionContract.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import * as dates from '../dates.js';

const termsStatusLabels: Readonly<Record<string, string>> = {
  NO_TERMS_PUBLISHED: 'None published yet', ACCEPTED: 'Accepted', ACCEPTANCE_REQUIRED: 'Acceptance needed',
};

export const exitSectionLabels: Readonly<Record<InstitutionExitExportSection, string>> = {
  units: 'Academic structure', roster: 'Student roster', staff: 'Staff', 'teaching-assignments': 'Teaching assignments',
  assessments: 'Assessments', 'assessment-results': 'Assessment results', 'staff-actions': 'Staff actions (without counselling notes)',
  'verification-decisions': 'Verification decisions', 'counselling-notes': 'Counselling notes (restricted)',
};

export const exitReasonLabels: Readonly<Record<string, string>> = {
  COLLEGE_EXIT_RECORDS: 'Keeping the college’s records on leaving ONE',
  ACCREDITATION_ARCHIVE: 'Accreditation archive',
  LEGAL_RETENTION: 'A legal duty to keep the records',
  STUDENT_WELFARE_CONTINUITY: 'Continuity of a student’s care',
  LEGAL_OBLIGATION: 'A legal obligation',
  REGULATOR_REQUEST: 'A regulator’s request',
  COLLEGE_RECORDS_POLICY: 'The college’s records policy',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return 'NA';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'NA' : dates.formatDate(date);
}

function saveFile(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function exitExportErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'The file could not be prepared. Try again.';
  const reference = supportCodeSuffix(error.correlationId);
  switch (error.code) {
    case 'EXIT_NOT_IN_NOTICE': return 'The exit export is available only while an exit notice is open for your college.' + reference;
    case 'EXPORT_RATE_LIMITED': return 'You have reached the limit of 30 exports in 24 hours. Try again later.' + reference;
    case 'COUNSELLING_EXPORT_CONFIRMATION_REQUIRED': return 'Confirm that you are asking for counselling notes before downloading them.' + reference;
    case 'COUNSELLING_EXPORT_REASON_INVALID': return 'Choose one of the listed reasons for releasing counselling notes.' + reference;
    default: break;
  }
  if (error.status === 403) return 'Only an owner of the college can take the exit export.' + reference;
  return 'The file could not be prepared. Try again.' + reference;
}

// --- Terms --------------------------------------------------------------------------

export function InstitutionDataTermsSection({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [terms, setTerms] = useState<InstitutionDataTermsDto | null>(null);
  const [canAccept, setCanAccept] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getInstitutionDataTerms(token, institutionId, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) { setTerms(loaded.terms ?? null); setCanAccept(loaded.canAccept === true); setError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'The data-processing terms could not be loaded.')); });
    return () => controller.abort();
  }, [token, institutionId]);

  async function accept(version: string): Promise<void> {
    setBusy(true); setError('');
    try {
      const updated = await acceptInstitutionDataTerms(token, institutionId, version);
      setTerms(updated.terms); setCanAccept(updated.canAccept);
    } catch (cause) {
      setError(formatApiError(cause, 'The terms could not be accepted.'));
    } finally {
      setBusy(false);
    }
  }

  const current = terms?.current ?? null;
  return <section className="role-card role-wide" aria-label="Data-processing terms">
    <h2>Data-processing terms</h2>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!terms && !error ? <p role="status">Loading the data-processing terms…</p> : null}
    {terms ? <p><strong>Status:</strong> {termsStatusLabels[terms.status] ?? 'NA'}</p> : null}
    {terms && !current ? <p>AI8HT has not published data-processing terms yet, so there is nothing to accept. Nothing has been accepted on your college’s behalf, and adding students works as it does today.</p> : null}
    {current ? <>
      <p>
        <strong>{current.title}</strong> · version {current.version} · published {formatDate(current.publishedAt)}{' '}
        {current.legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW'
          ? <StatusBadge label="Draft — pending legal review" tone="warning" />
          : <StatusBadge label="Reviewed" tone="success" />}
      </p>
      {current.legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW'
        ? <p className="hiring-meta">This text is a draft that has not finished legal review. It is not final.</p>
        : <p className="hiring-meta">Legal review: {current.legalReviewReference ?? 'NA'}</p>}
      {current.changeSummary ? <p><strong>What changed:</strong> {current.changeSummary}</p> : null}
      <div style={{ whiteSpace: 'pre-wrap' }} aria-label="Terms text">{current.body}</div>
      <p role="status">{terms?.status === 'ACCEPTED'
        ? terms.currentVersionAccepted ? 'Your college has accepted these terms.' : 'Your college has accepted the terms it needs to; this latest version changed nothing that needs accepting again.'
        : 'An owner of your college must accept these terms before more students are added. Students already on ONE are not affected.'}</p>
      <p className="hiring-meta">{terms?.latestAcceptance
        ? `Last accepted: version ${terms.latestAcceptance.version} on ${formatDate(terms.latestAcceptance.acceptedAt)} by ${terms.latestAcceptance.acceptedBy ?? 'NA'}.`
        : 'Not accepted yet.'}</p>
      {canAccept && !terms?.currentVersionAccepted
        ? <button type="button" disabled={busy} onClick={() => void accept(current.version)}>Accept version {current.version} for my college</button>
        : !canAccept && terms?.status === 'ACCEPTANCE_REQUIRED' ? <p className="hiring-meta">Only an owner of the college can accept the terms.</p> : null}
    </> : null}
  </section>;
}

// --- Leaving ONE --------------------------------------------------------------------

function exitStatus(exit: InstitutionExitDto | null): string {
  if (!exit) return 'Your college is using ONE. To leave, contact AI8HT operations; the exit export opens here once AI8HT records the notice.';
  switch (exit.state) {
    case 'NOTICE': return `AI8HT recorded on ${formatDate(exit.noticeAt)} that your college’s agreement is ending. Take the exit export below before your college’s use of ONE ends.`;
    case 'ENDED': return `Your college stopped using ONE on ${formatDate(exit.endedAt)}. Its records are kept until ${formatDate(exit.retentionEndsAt)} and can be restored until then.`;
    case 'CANCELLED': return `The exit recorded on ${formatDate(exit.noticeAt)} was cancelled on ${formatDate(exit.cancelledAt)}. Your college is using ONE.`;
    case 'PURGED': return `Your college’s records were deleted on ${formatDate(exit.purgedAt)}, after the retention period.`;
  }
}

export function InstitutionExitSection({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [exit, setExit] = useState<InstitutionExitDto | null>(null);
  const [exportInfo, setExportInfo] = useState<InstitutionExitExportDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('COLLEGE_EXIT_RECORDS');
  const [counsellingReason, setCounsellingReason] = useState('');
  const [confirmCounselling, setConfirmCounselling] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getInstitutionExit(token, institutionId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setExit(result.exit ?? null); setExportInfo(result.export ?? null); setLoaded(true); setError(''); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setLoaded(true); setError(formatApiError(cause, 'Your college’s exit status could not be loaded.')); } });
    return () => controller.abort();
  }, [token, institutionId]);

  async function download(section: InstitutionExitExportSection, part: number): Promise<void> {
    setBusy(`${section}:${part}`); setError(''); setNotice('');
    try {
      const restricted = section === 'counselling-notes';
      const file = await downloadInstitutionExitExport(token, institutionId, section, {
        reasonCode: restricted ? counsellingReason : reason, part, ...(restricted ? { includeRestrictedCounsellingNotes: confirmCounselling } : {}),
      });
      saveFile(file.filename, file.csv);
      setNotice(`${exitSectionLabels[section]}${part > 1 ? `, file ${part}` : ''} downloaded. The download is recorded with your reason.`);
    } catch (cause) {
      setError(exitExportErrorMessage(cause));
    } finally {
      setBusy('');
    }
  }

  const parts = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);
  return <section className="role-card role-wide" aria-label="Leaving ONE">
    <h2>Leaving ONE</h2>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {!loaded ? <p role="status">Loading your college’s exit status…</p> : null}
    {loaded && !error ? <p>{exitStatus(exit)}</p> : null}
    {loaded && !error ? <p className="hiring-meta">When a college leaves, its students keep their ONE accounts and everything that is theirs, and results the college verified stay verified. The college’s own records are kept for 90 days, then deleted with a second AI8HT approval.</p> : null}
    {exportInfo && exportInfo.available ? <>
      <h3>Exit export</h3>
      <p>One file per section; a large section comes in files of up to 10,000 rows. Every download is recorded with your reason.</p>
      <label><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value)}>
        {exportInfo.reasons.map((code) => <option key={code} value={code}>{exitReasonLabels[code] ?? code}</option>)}
      </select></label>
      <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Exit export sections</caption>
        <thead><tr><th>Section</th><th>Rows</th><th>Download</th></tr></thead>
        <tbody>{exportInfo.sections.map((entry) => <tr key={entry.section}>
          <td>{exitSectionLabels[entry.section]}</td><td>{entry.rows}</td>
          <td>{parts(entry.parts).map((part) => <button key={part} type="button" className="secondary" disabled={busy !== ''}
            onClick={() => void download(entry.section, part)}>{entry.parts > 1 ? `File ${part}` : 'Download'}</button>)}</td>
        </tr>)}</tbody>
      </table></div>
      <p><strong>Never in the export:</strong></p>
      <ul>{exportInfo.excluded.map((item) => <li key={item}>{item}</li>)}</ul>
      {exportInfo.restricted ? <div aria-label="Counselling notes">
        <h3>Counselling notes (restricted)</h3>
        <p>{exportInfo.restricted.rows} counselling {exportInfo.restricted.rows === 1 ? 'note is' : 'notes are'} held. They are not in any other file. Release them only if you must; the release is recorded separately.</p>
        <label><span>Reason for releasing them</span><select value={counsellingReason} onChange={(event) => setCounsellingReason(event.target.value)}>
          <option value="">Choose a reason</option>
          {exportInfo.restricted.reasons.map((code) => <option key={code} value={code}>{exitReasonLabels[code] ?? code}</option>)}
        </select></label>
        <label><span>I am asking for the college’s restricted counselling notes</span><input type="checkbox" checked={confirmCounselling}
          onChange={(event) => setConfirmCounselling(event.target.checked)} /></label>
        {parts(exportInfo.restricted.parts).map((part) => <button key={part} type="button" className="secondary"
          disabled={busy !== '' || !confirmCounselling || !counsellingReason} onClick={() => void download('counselling-notes', part)}>
          {exportInfo.restricted!.parts > 1 ? `Download counselling notes, file ${part}` : 'Download counselling notes'}</button>)}
      </div> : null}
    </> : null}
    {exportInfo && !exportInfo.available && exit?.state === 'NOTICE' ? <p className="hiring-meta">Only an owner of the college can take the exit export.</p> : null}
  </section>;
}
