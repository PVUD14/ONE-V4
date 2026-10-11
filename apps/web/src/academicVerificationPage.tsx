/**
 * The queue an institution works to confirm the records it issued, and the upload that
 * lets it confirm a whole term at once (INST-04).
 *
 * The decision it supports is permanent — a database trigger refuses to un-verify a
 * record — so the screen's job is to give staff what they need to be sure before they
 * press the button, and to be honest about what it cannot tell them.
 *
 * The important case is the last one. A request can come from someone this institution
 * has no roster record of at all: an alumnus who left before ONE existed. For them there
 * is no name to show, because ONE has never been told one. The screen says so and shows
 * the email and the claimed dates, rather than filling the column with a guess.
 *
 * Evidence is shown as the student's document title, type and version only (ADR-027). A
 * verifier cannot open it: that needs the student's consent for that exact version, which
 * ONE cannot record yet, so the screen says the document has not been shared.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  commitAcademicResults, decideVerification, listVerificationQueue, previewAcademicResults,
  type RecordedResultDto, type ResultsImportOutcome, type ResultsImportPreviewDto, type VerificationQueueEntryDto,
} from './api.js';
import { formatApiError } from './rolePortal/shared.js';

const RELATIONSHIP_LABEL: Readonly<Record<VerificationQueueEntryDto['relationship'], string>> = {
  CURRENT: 'Current student',
  FORMER: 'Former student',
  NONE: 'Not on your roster',
};

/** Reason codes for a rejection (plan Section 5.4). A confirmation records MATCHES_INSTITUTION_RECORD. */
export const rejectionReasons = [
  ['DOES_NOT_MATCH_RECORD', 'Does not match our record'],
  ['RECORD_NOT_FOUND', 'No record of this result'],
  ['NOT_OUR_STUDENT', 'Not a student of this institution'],
  ['EVIDENCE_INSUFFICIENT', 'Needs clearer evidence'],
] as const;

function scaleSuffix(scale: string | null): string {
  return scale === 'PERCENTAGE' ? '%' : scale === 'CGPA_10' ? ' / 10' : scale === 'GPA_4' ? ' / 4' : '';
}

function result(entry: { readonly resultValue: string | number | null; readonly resultScale: string | null; readonly resultLetter: string | null }): string {
  if (entry.resultLetter) return entry.resultLetter;
  if (entry.resultValue === null) return 'NA';
  return `${entry.resultValue}${scaleSuffix(entry.resultScale)}`;
}

function years(entry: VerificationQueueEntryDto): string {
  const from = entry.claimedStartedOn ? new Date(entry.claimedStartedOn).getFullYear() : null;
  const to = entry.claimedCompletedOn ? new Date(entry.claimedCompletedOn).getFullYear() : null;
  if (!from && !to) return 'Dates not stated';
  return `Claims ${from ?? '?'} – ${to ?? 'present'}`;
}

function Evidence({ entry }: { readonly entry: VerificationQueueEntryDto }): React.ReactElement {
  if (!entry.evidence) return <span className="hiring-meta">No evidence attached</span>;
  return <>
    <span>{entry.evidence.title}</span><br />
    <span className="hiring-meta">{entry.evidence.documentType} · version {entry.evidence.versionNumber}</span><br />
    <span className="hiring-meta">Not shared with the college — the student has not given consent to open this version.</span>
  </>;
}

export function AcademicVerificationPage({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const [queue, setQueue] = useState<readonly VerificationQueueEntryDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading the verification queue…');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    listVerificationQueue(token, institutionId, abort.signal)
      .then((response) => { setQueue(response.queue); setNextCursor(response.nextCursor ?? null); setStatus(''); })
      .catch((error: unknown) => { if (!abort.signal.aborted) setStatus(formatApiError(error, 'The verification queue could not be loaded.')); });
    return () => abort.abort();
  }, [institutionId]);

  async function loadMore(): Promise<void> {
    const token = getAccessToken();
    if (!token || !nextCursor) return;
    try {
      const response = await listVerificationQueue(token, institutionId, undefined, nextCursor);
      setQueue((current) => [...(current ?? []), ...response.queue]);
      setNextCursor(response.nextCursor ?? null);
    } catch (error) {
      setStatus(formatApiError(error, 'More requests could not be loaded.'));
    }
  }

  async function decide(termId: string, decision: 'VERIFIED' | 'REJECTED', reasonCode: string): Promise<void> {
    const token = getAccessToken();
    if (!token || deciding) return;
    setDeciding(termId);
    try {
      const response = await decideVerification(token, institutionId, termId, decision, reasonCode);
      setQueue(response.queue);
      setNextCursor(response.nextCursor ?? null);
      setRejecting(null); setReason('');
      setStatus(decision === 'VERIFIED'
        ? 'Verified. This decision is permanent and cannot be reversed.'
        : 'Rejected. The student can correct the record and submit it again.');
    } catch (error) {
      setStatus(formatApiError(error, 'That decision could not be recorded.'));
    } finally { setDeciding(null); }
  }

  const alumni = (queue ?? []).filter((entry) => entry.relationship !== 'CURRENT').length;

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Academic verification</h2>
      <p>Results students have asked you to confirm. You are the only institution that can confirm a record you issued, and <strong>a confirmation is permanent</strong>.</p>
      {queue && alumni > 0
        ? <p>{alumni === 1 ? '1 request is' : `${alumni} requests are`} from someone who is not a current student. Those are alumni asking you to confirm a record you issued them — check your archive before deciding.</p>
        : null}
      {status ? <p role="status">{status}</p> : null}
    </section>

    {queue && queue.length === 0
      ? <section className="card wide-card"><p>Nothing is waiting. When a student or former student submits a result for confirmation it will appear here.</p></section>
      : null}

    {queue && queue.length > 0 ? <section className="card wide-card">
      <div className="data-table-wrap"><table>
        <thead><tr><th>Person</th><th>Standing</th><th>Programme</th><th>Term</th><th>Result</th><th>Evidence</th><th>Decision</th></tr></thead>
        <tbody>{queue.map((entry) => <tr key={entry.termId}>
          <td>
            {entry.studentName
              ? <><strong>{entry.studentName}</strong><br /></>
              : <><span className="hiring-meta">No roster record — identify by email</span><br /></>}
            <span className="hiring-meta">{entry.studentEmail}</span>
            {entry.institutionStudentId ? <><br /><span className="hiring-meta">{entry.institutionStudentId}</span></> : null}
          </td>
          <td>
            <span className={`hiring-state state-${entry.relationship.toLowerCase()}`}>{RELATIONSHIP_LABEL[entry.relationship]}</span>
            <br /><span className="hiring-meta">{years(entry)}</span>
          </td>
          <td>{entry.programmeName}<br /><span className="hiring-meta">{entry.qualificationType}</span></td>
          <td>{entry.label}</td>
          <td>
            {result(entry)}{entry.backlogCount ? <><br /><span className="hiring-meta">{entry.backlogCount} backlog</span></> : null}
            {entry.institutionRecord
              ? <><br /><span className="hiring-state state-former">Your verified record: {result(entry.institutionRecord)}{entry.institutionRecord.backlogCount !== null ? `, ${entry.institutionRecord.backlogCount} backlog` : ''}</span></>
              : null}
          </td>
          <td><Evidence entry={entry} /></td>
          <td><div className="hiring-actions">
            <button type="button" disabled={deciding === entry.termId} onClick={() => { void decide(entry.termId, 'VERIFIED', 'MATCHES_INSTITUTION_RECORD'); }}>Confirm</button>
            {rejecting === entry.termId
              ? <>
                <label><span className="sr-only">Reason for rejecting</span>
                  <select value={reason} onChange={(event) => setReason(event.target.value)}>
                    <option value="">Choose a reason</option>
                    {rejectionReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </select></label>
                <button type="button" className="secondary" disabled={!reason || deciding === entry.termId}
                  onClick={() => { void decide(entry.termId, 'REJECTED', reason); }}>Confirm rejection</button>
              </>
              : <button type="button" className="secondary" disabled={deciding === entry.termId} onClick={() => { setRejecting(entry.termId); setReason(''); }}>Reject</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {nextCursor ? <div className="hiring-actions"><button type="button" className="secondary" onClick={() => { void loadMore(); }}>Load more requests</button></div> : null}
    </section> : null}
  </div>;
}

const OUTCOME_LABEL: Readonly<Record<ResultsImportOutcome, string>> = {
  CREATE: 'Will be recorded as verified',
  CONFIRM: "Confirms the student's own entry",
  UNCHANGED: 'Already verified — nothing to change',
  CONFLICT: 'Not written — conflicts with an existing record',
  INVALID: 'Fix this row',
  SKIPPED: 'Skipped — nothing is recorded',
};

const ISSUE_LABEL: Readonly<Record<string, string>> = {
  student_not_found: 'No student with this ID on the roster you manage',
  term_sequence_invalid: 'Term number must be 1 to 30',
  term_label_invalid: 'Term name is missing, too long or starts with = + - @',
  scale_invalid: 'Scale must be CGPA_10, GPA_4, PERCENTAGE, LETTER or PASS_FAIL',
  result_invalid: 'Result does not fit its scale',
  backlogs_invalid: 'Backlogs must be a whole number from 0 to 100',
  qualification_type_invalid: 'Unknown qualification type',
  qualification_type_required: 'Qualification type needed for this student’s first upload',
  programme_invalid: 'Programme is too long or starts with = + - @',
  programme_required: 'Programme needed for this student’s first upload',
  duplicate_row: 'This student and term appear twice',
  qualification_mismatch: 'Qualification differs from an earlier row for this student',
  declaration_in_institution_record: 'The student entered a different value in your programme record',
  student_deleted: 'This student deleted their ONE account, so no results are recorded for them',
};

const uploadReasons = [
  ['RESULTS_DECLARED', 'Results declared by the examination office'],
  ['PAST_TERMS_BACKFILL', 'Adding earlier terms'],
  ['CORRECTED_SHEET', 'Corrected sheet for rows not yet recorded'],
] as const;

const templateCsv = 'institution_student_id,term_sequence,term_label,scale,result,backlogs,qualification_type,programme\n';

function reported(value: RecordedResultDto): string {
  return `${result(value)}${value.backlogCount !== null ? `, ${value.backlogCount} backlog` : ''}`;
}

/**
 * Bulk results upload: validate, review every row, then commit exactly what was shown.
 * The server refuses a commit with any invalid row, or one whose records changed since
 * the preview; conflicts are listed and left as they are.
 */
export function AcademicResultsUpload({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const [csv, setCsv] = useState(templateCsv);
  const [filename, setFilename] = useState('results.csv');
  const [preview, setPreview] = useState<ResultsImportPreviewDto | null>(null);
  const [reasonCode, setReasonCode] = useState<string>(uploadReasons[0][0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function readFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setFilename(file.name.slice(0, 160));
    setCsv(await file.text());
    setPreview(null);
  }

  async function validate(): Promise<void> {
    const token = getAccessToken();
    if (!token) { setError('You are not signed in.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      setPreview((await previewAcademicResults(token, institutionId, filename, csv)).preview);
    } catch (cause) {
      setPreview(null);
      setError(formatApiError(cause, 'The file could not be read. Check the header row matches the template and try again.'));
    } finally { setBusy(false); }
  }

  async function commit(): Promise<void> {
    const token = getAccessToken();
    if (!token || !preview) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const committed = (await commitAcademicResults(token, institutionId, { filename, csv, previewDigest: preview.digest, reasonCode })).import;
      setNotice(`${committed.created} result${committed.created === 1 ? '' : 's'} recorded as verified, ${committed.confirmed} student entr${committed.confirmed === 1 ? 'y' : 'ies'} confirmed.`
        + (committed.counts.conflict ? ` ${committed.counts.conflict} conflicting row${committed.counts.conflict === 1 ? ' was' : 's were'} left unchanged.` : ''));
      setPreview(null);
    } catch (cause) {
      setError(formatApiError(cause, 'Nothing was recorded: the records changed since you validated this file, or a row is invalid. Validate it again.'));
    } finally { setBusy(false); }
  }

  const writable = preview ? preview.counts.create + preview.counts.confirm : 0;

  return <section className="card wide-card">
    <h2>Upload results</h2>
    <p>Upload one term's results as a CSV. Each row is recorded exactly as issued, on its own scale, as <strong>verified by your institution and attributed to you</strong>. Where a student entered a different value, both are shown — theirs is never overwritten.</p>
    <p className="hiring-meta">Columns: institution_student_id, term_sequence, term_label, scale (CGPA_10, GPA_4, PERCENTAGE, LETTER, PASS_FAIL), result, backlogs. Add qualification_type and programme for a student's first upload.</p>
    <label><span>CSV file</span><input type="file" accept=".csv,text/csv" onChange={(event) => { void readFile(event.target.files?.[0]); }} /></label>
    <label><span>Or paste the CSV</span><textarea value={csv} rows={5} onChange={(event) => { setCsv(event.target.value); setPreview(null); }} /></label>
    <div className="hiring-actions"><button type="button" disabled={busy} onClick={() => { void validate(); }}>Validate results</button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {preview ? <>
      <p role="status">{preview.rowCount} rows: {preview.counts.create} to record, {preview.counts.confirm} confirming a student's entry, {preview.counts.unchanged} unchanged, {preview.counts.conflict} in conflict, {preview.counts.invalid} to fix{preview.counts.skipped ? `, ${preview.counts.skipped} skipped` : ''}.{preview.counts.differsFromStudent ? ` ${preview.counts.differsFromStudent} differ from what the student entered — both will be kept.` : ''}</p>
      <div className="data-table-wrap"><table>
        <thead><tr><th>Row</th><th>Student</th><th>Term</th><th>Result</th><th>Outcome</th><th>Student entered / existing record</th></tr></thead>
        <tbody>{preview.rows.map((row) => <tr key={row.rowNumber}>
          <td>{row.rowNumber}</td>
          <td>{row.studentName ?? <span className="hiring-meta">Not found</span>}<br /><span className="hiring-meta">{row.institutionStudentId || 'NA'}</span></td>
          <td>{row.termLabel || 'NA'}{row.termSequence !== null ? <><br /><span className="hiring-meta">Term {row.termSequence}</span></> : null}</td>
          <td>{row.result || 'NA'} {row.scale}{row.backlogs !== null ? <><br /><span className="hiring-meta">{row.backlogs} backlog</span></> : null}</td>
          <td><span className={`hiring-state state-${row.outcome.toLowerCase()}`}>{OUTCOME_LABEL[row.outcome]}</span>
            {row.issues.map((issue) => <React.Fragment key={issue}><br /><span className="hiring-meta">{ISSUE_LABEL[issue] ?? issue}</span></React.Fragment>)}</td>
          <td>{row.studentReported ? <>Student entered {reported(row.studentReported)}</> : row.verifiedRecord ? <>Verified record: {reported(row.verifiedRecord)}</> : 'NA'}</td>
        </tr>)}</tbody>
      </table></div>
      {preview.counts.invalid > 0
        ? <p className="form-error" role="alert">Fix the {preview.counts.invalid} row{preview.counts.invalid === 1 ? '' : 's'} marked "Fix this row" and validate again. Nothing is recorded while any row is invalid.</p>
        : <div className="hiring-actions">
          <label><span>Reason</span><select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
            {uploadReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
          <button type="button" disabled={busy || writable === 0} onClick={() => { void commit(); }}>Record {writable} verified result{writable === 1 ? '' : 's'}</button>
        </div>}
    </> : null}
  </section>;
}
