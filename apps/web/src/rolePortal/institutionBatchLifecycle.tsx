/**
 * Year-end actions on the institution Students page (INST-10).
 *
 * Graduate, transfer or end a whole unit or a list of roll numbers: preview what will change,
 * then commit exactly that, with a reason. Nothing is requested until the admin asks for a
 * preview. Students keep their ONE account, records and choices; the college keeps only what
 * happened before the date. Pilot classes only; no new styles.
 */
import { useState } from 'react';
import { ApiRequestError, commitRelationshipBatch, previewRelationshipBatch } from '../api.js';
import type { InstitutionUnitDto, RelationshipBatchPreviewDto, RelationshipBatchRequest, RelationshipBatchState } from '../api.js';
import { formatApiError } from './shared.js';

const actions: readonly (readonly [RelationshipBatchState, string, string])[] = [
  ['GRADUATED', 'Graduate', 'graduated'],
  ['TRANSFERRED', 'Transfer out', 'transferred'],
  ['ENDED', 'End relationship', 'no longer enrolled'],
];

/** Why the batch changed; recorded with every student's audit row. */
const reasons: Readonly<Record<RelationshipBatchState, readonly (readonly [string, string])[]>> = {
  GRADUATED: [['YEAR_END_GRADUATION', 'Completed the programme'], ['EARLY_COMPLETION', 'Completed early']],
  TRANSFERRED: [['TRANSFERRED_OUT', 'Moved to another institution'], ['PROGRAMME_TRANSFER', 'Moved to a programme outside ONE']],
  ENDED: [['LEFT_PROGRAMME', 'Left the programme'], ['WITHDRAWN_BY_INSTITUTION', 'Withdrawn by the institution']],
};

const outcomeLabels: Readonly<Record<string, string>> = { CHANGE: 'Will change', UNCHANGED: 'Already left — no change', INVALID: 'Cannot change' };
const issueLabels: Readonly<Record<string, string>> = {
  STUDENT_NOT_FOUND: 'Not on your roster',
  EFFECTIVE_BEFORE_START: 'Date is before this student joined',
};
const stateLabels: Readonly<Record<string, string>> = {
  ACTIVE: 'Active', VERIFIED: 'Verified', GRADUATED: 'Graduated', TRANSFERRED: 'Transferred', ENDED: 'Ended', REVOKED: 'Revoked', PENDING: 'Pending',
};
const unitKindLabels: Readonly<Record<string, string>> = { CAMPUS: 'Campus', DEPARTMENT: 'Department', PROGRAM: 'Programme', BATCH: 'Batch', SECTION: 'Section' };

function batchErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const reference = ` Reference: ${error.correlationId}`;
    switch (error.code) {
      case 'BATCH_PREVIEW_STALE': return `The roster changed since your preview. Nothing was saved — preview again.${reference}`;
      case 'EFFECTIVE_DATE_IN_FUTURE': return `The date cannot be in the future. Prepare the batch now and commit it on the day.${reference}`;
      case 'BATCH_TOO_LARGE': return `A batch can change at most 1,000 students. Choose a smaller unit.${reference}`;
      case 'NOTHING_TO_CHANGE': return `No student in this selection is currently enrolled.${reference}`;
      case 'BATCH_HAS_INVALID_ROWS': return `Some rows cannot be changed, so nothing was saved.${reference}`;
      case 'UNIT_ID_INVALID': return `Choose a unit from your institution.${reference}`;
      case 'INVALID_TARGET': return `Enter between 1 and 1,000 roll numbers, or choose a unit.${reference}`;
      default: break;
    }
  }
  return formatApiError(error, 'The batch could not be processed.');
}

/** Start of the chosen day in the admin's local time, as the API's ISO date-time. */
export function startOfLocalDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1).toISOString();
}

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function YearEndBatchPanel({ token, institutionId, units, onChanged }: {
  readonly token: string;
  readonly institutionId: string;
  readonly units: readonly InstitutionUnitDto[];
  readonly onChanged: (message: string) => void;
}): React.ReactElement {
  const [state, setState] = useState<RelationshipBatchState>('GRADUATED');
  const [targetKind, setTargetKind] = useState<'unit' | 'rolls'>('unit');
  const [unitId, setUnitId] = useState('');
  const [rolls, setRolls] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState(reasons.GRADUATED[0]![0]);
  const [preview, setPreview] = useState<{ readonly request: RelationshipBatchRequest; readonly batch: RelationshipBatchPreviewDto } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const words = actions.find(([value]) => value === state)?.[2] ?? 'changed';

  function reset(): void { setPreview(null); setError(''); }

  function buildRequest(): RelationshipBatchRequest | null {
    const effective = date ? { effectiveTo: startOfLocalDay(date) } : {};
    if (targetKind === 'unit') {
      if (!unitId) { setError('Choose a batch or unit.'); return null; }
      return { state, unitId, ...effective };
    }
    const ids = rolls.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    if (ids.length === 0) { setError('Enter at least one roll number.'); return null; }
    return { state, institutionStudentIds: ids, ...effective };
  }

  async function runPreview(): Promise<void> {
    setError('');
    const request = buildRequest();
    if (!request) return;
    setBusy(true);
    try {
      const result = await previewRelationshipBatch(token, institutionId, request);
      setPreview({ request, batch: result.batch });
    } catch (cause) {
      setPreview(null);
      setError(batchErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runCommit(): Promise<void> {
    if (!preview) return;
    setError('');
    setBusy(true);
    try {
      const result = await commitRelationshipBatch(token, institutionId, { ...preview.request, previewDigest: preview.batch.digest, reasonCode: reason });
      const when = new Date(result.batch.effectiveTo).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      setPreview(null);
      onChanged(`${result.batch.changed} student${result.batch.changed === 1 ? '' : 's'} recorded as ${words} from ${when}. They keep their ONE accounts and will be notified.`);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === 'BATCH_PREVIEW_STALE') setPreview(null);
      setError(batchErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const counts = preview?.batch.counts;
  const canCommit = Boolean(preview && counts && counts.invalid === 0 && counts.change > 0 && !busy);
  return <section className="role-card role-wide role-management-form" aria-labelledby="year-end-actions-heading">
    <h2 id="year-end-actions-heading">Year-end actions</h2>
    <p>Graduate, transfer or end a whole batch, or a list of roll numbers, in one step. Students keep their ONE account, their records and their choices; after the date, your college sees only what happened before it.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <label><span>Action</span><select value={state} onChange={(event) => { const next = event.target.value as RelationshipBatchState; setState(next); setReason(reasons[next][0]![0]); reset(); }}>
      {actions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label><span>Students</span><select value={targetKind} onChange={(event) => { setTargetKind(event.target.value as 'unit' | 'rolls'); reset(); }}>
      <option value="unit">Everyone in a batch or unit</option>
      <option value="rolls">A list of roll numbers</option>
    </select></label>
    {targetKind === 'unit'
      ? <label><span>Batch or unit</span><select value={unitId} onChange={(event) => { setUnitId(event.target.value); reset(); }}>
          <option value="">Choose…</option>
          {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name} ({unitKindLabels[unit.kind] ?? unit.kind})</option>)}
        </select></label>
      : <label><span>Roll numbers (one per line)</span><textarea value={rolls} rows={4} onChange={(event) => { setRolls(event.target.value); reset(); }} /></label>}
    <label><span>Effective date (leave empty for today)</span><input type="date" value={date} max={todayLocal()} onChange={(event) => { setDate(event.target.value); reset(); }} /></label>
    <div className="role-record-actions"><button type="button" disabled={busy} onClick={() => void runPreview()}>Preview</button></div>
    {preview && counts ? <div>
      <p role="status">{counts.change} will be recorded as {words}, {counts.unchanged} already left, {counts.invalid} cannot be changed.</p>
      {preview.batch.rows.length === 0 ? <p>No students in this selection.</p> : <div className="role-record-table-wrap"><table className="role-record-table">
        <caption className="sr-only">Year-end preview</caption>
        <thead><tr><th>Roll number</th><th>Student</th><th>Now</th><th>Outcome</th><th>Issues</th></tr></thead>
        <tbody>{preview.batch.rows.map((row) => <tr key={row.institutionStudentId}>
          <td>{row.institutionStudentId}</td><td>{row.fullName ?? 'NA'}</td><td>{row.currentState ? stateLabels[row.currentState] ?? row.currentState : 'NA'}</td>
          <td>{outcomeLabels[row.outcome] ?? row.outcome}</td><td>{row.issues.map((issue) => issueLabels[issue] ?? issue).join(', ') || 'None'}</td>
        </tr>)}</tbody>
      </table></div>}
      {counts.invalid > 0 ? <p>Fix or remove the rows that cannot change, then preview again. Nothing is saved while any row cannot change.</p> : null}
      <label><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value)}>
        {reasons[state].map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select></label>
      <div className="role-record-actions"><button type="button" disabled={!canCommit} onClick={() => void runCommit()}>Commit {counts.change} change{counts.change === 1 ? '' : 's'}</button></div>
    </div> : null}
  </section>;
}
