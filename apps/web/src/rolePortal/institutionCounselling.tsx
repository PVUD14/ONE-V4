/**
 * Restricted counselling notes on the institution Interventions page (INST-11, ADR-036).
 *
 * Counselling sits beside interventions because it is the same kind of work — support for one
 * student — but its notes are not scoped like interventions. The server returns only the notes
 * this staff member may read (their own, all of them for owners and admins, or a case they were
 * added to) and never says whether others exist; this screen filters nothing for security.
 * Nothing here adds a navigation item (HG-3): it is a section of the existing Interventions page.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiRequestError, getProtectedAccessToken } from '../api.js';
import { supportCodeSuffix } from '../supportCode.js';
import { formatDate } from '../dates.js';
import { MISSING_TEXT } from '../labels.js';
import {
  addCounsellingParticipant, eraseCounsellingNote, listCounsellingCases, listCounsellingNotes, removeCounsellingParticipant,
  setCounsellingNoteVisibility, writeCounsellingNote, type CounsellingCasesDto, type CounsellingNotesDto,
} from '../api/counselling.js';

const roleLabels: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'Owner', INSTITUTION_ADMIN: 'Administrator', PLACEMENT_ADMIN: 'Placement officer',
  DEPARTMENT_HEAD: 'Department head', FACULTY_LECTURER: 'Faculty',
};
const addReasons = [['CASE_REFERRAL', 'Referred to this case'], ['CASE_SUPPORT', 'Supporting the student']] as const;
const removeReasons = [['CASE_CLOSED', 'Case closed'], ['ROLE_CHANGED', 'Role changed']] as const;
const eraseReasons = [['STUDENT_REQUEST', 'The student asked for it'], ['RECORDED_IN_ERROR', 'Recorded in error']] as const;

/** A plain message and the correlation ID; never upstream error text (build rules). */
export function counsellingError(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    const reference = supportCodeSuffix(cause.correlationId);
    if (cause.status === 401) return 'Your session has expired. Sign in again.' + reference;
    if (cause.code === 'SCOPE_REQUIRED') return 'Writing a counselling note needs a department or teaching assignment on your staff membership. An administrator can set it.' + reference;
    if (cause.status === 403) return 'Counselling notes for this student are not available to you.' + reference;
    if (cause.status === 409) return 'This record has changed. Refresh before trying again.' + reference;
    if (cause.status === 400) return 'Check the title and note.' + reference;
    return 'Counselling notes could not be loaded or saved. Try again.' + reference;
  }
  return 'Counselling notes could not be loaded or saved. Try again.';
}

function dateOf(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return MISSING_TEXT;
  return formatDate(value);
}

export function CounsellingNotesSection({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  return <CounsellingWorkspace key={institutionId + ':' + (token ?? '')} institutionId={institutionId} token={token} />;
}

function CounsellingWorkspace({ institutionId, token }: { readonly institutionId: string; readonly token: string | null }): React.ReactElement {
  const [cases, setCases] = useState<CounsellingCasesDto | null>(null);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<CounsellingNotesDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState({ studentUserId: '', title: '', note: '', share: false });
  const [participant, setParticipant] = useState({ membershipId: '', reasonCode: addReasons[0][0] as string });
  const [eraseReason, setEraseReason] = useState<string>(eraseReasons[0][0]);
  const mutation = useRef(false);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    setCases(null);
    listCounsellingCases(token, institutionId, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setCases(response); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(counsellingError(cause)); });
    return () => controller.abort();
  }, [token, institutionId, refresh]);

  useEffect(() => {
    if (!token || !selected) { setDetail(null); return undefined; }
    const controller = new AbortController();
    setDetail(null);
    listCounsellingNotes(token, institutionId, selected, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setDetail(response); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(counsellingError(cause)); });
    return () => controller.abort();
  }, [token, institutionId, selected, refresh]);

  async function run(action: () => Promise<unknown>, success: string): Promise<void> {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await action();
      setNotice(success);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(counsellingError(cause));
    } finally {
      mutation.current = false; setBusy(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!token || !form.studentUserId) return;
    const studentUserId = form.studentUserId;
    void run(async () => {
      await writeCounsellingNote(token, institutionId, studentUserId, { title: form.title, note: form.note, shareWithStudent: form.share });
      setForm({ studentUserId: '', title: '', note: '', share: false });
      setSelected(studentUserId);
    }, form.share ? 'Note saved and shared with the student.' : 'Note saved. Only its readers can see it.');
  }

  // Students to write about: the caller's write scope, plus cases they already hold.
  const writable = new Map<string, string>();
  for (const student of cases?.students ?? []) writable.set(student.id, student.name);
  for (const entry of cases?.cases ?? []) if (entry.participant) writable.set(entry.studentUserId, entry.studentName);

  return <div className="pilot pilot-embed"><div className="pilot-page"><div className="pilot-content">
    <section className="pilot-card" aria-labelledby="counselling-title">
      <div className="pilot-card-head"><h2 id="counselling-title">Counselling notes</h2><span className="pilot-chip rose">Restricted</span></div>
      <p>Readable only by the note&apos;s author, institution owners and administrators, and staff added to that student&apos;s counselling case. Staff only unless you choose to share a note with the student. Every read is recorded.</p>
      {!token ? <p role="alert">Sign in to an institution workspace to use counselling notes.</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!cases ? <p role="status">{error || !token ? 'Counselling notes are unavailable.' : 'Loading counselling cases…'}</p> : <>
        {cases.cases.length ? <div className="pilot-list" aria-label="Counselling cases">
          {cases.cases.map((entry) => <div className="pilot-list-row" key={entry.studentUserId}>
            <div className="grow"><strong>{entry.studentName}</strong><small>{entry.notes} {entry.notes === 1 ? 'note' : 'notes'} you can read · Last note {dateOf(entry.lastNoteAt)}</small></div>
            {entry.participant ? <span className="pilot-chip blue">Case participant</span> : null}
            <button type="button" className="pilot-btn ghost small" disabled={busy} onClick={() => { setError(''); setSelected(entry.studentUserId); }}>Open notes for {entry.studentName}</button>
          </div>)}
        </div> : <p>No counselling notes you can read yet.</p>}
        <form className="role-management-form" onSubmit={submit} aria-label="Write a counselling note">
          <h3>Write a counselling note</h3>
          <label>Student<select required disabled={busy} value={form.studentUserId} onChange={(event) => setForm({ ...form, studentUserId: event.target.value })}>
            <option value="">Select a student</option>
            {[...writable].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          {!writable.size ? <p>No students are in your writing scope.</p> : null}
          <label>Title<input required maxLength={200} disabled={busy} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label>Note<textarea required maxLength={4000} rows={4} disabled={busy} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
          <label><input type="checkbox" disabled={busy} checked={form.share} onChange={(event) => setForm({ ...form, share: event.target.checked })} /> Share this note with the student</label>
          <button className="pilot-btn" type="submit" disabled={busy || !writable.size}>{busy ? 'Saving…' : 'Save note'}</button>
        </form>
      </>}
    </section>
    {selected ? <section className="pilot-card" aria-labelledby="counselling-case-title">
      <div className="pilot-card-head"><h2 id="counselling-case-title">{detail ? 'Notes for ' + detail.student.name : 'Counselling case'}</h2>
        <button type="button" className="pilot-btn ghost small" disabled={busy} onClick={() => setSelected('')}>Close case</button></div>
      {!detail ? <p role="status">{error ? 'This case is unavailable.' : 'Loading notes…'}</p> : <>
        {detail.notes.length ? <div className="pilot-list">{detail.notes.map((note) => <article className="pilot-card" key={note.id}>
          <h3>{note.title}</h3>
          <p>{note.note}</p>
          <p><small>{note.writtenByYou ? 'Written by you' : `Written by ${note.authorName} (${roleLabels[note.authorRole] ?? 'Staff'})`} · {dateOf(note.createdAt)}</small></p>
          <span className={'pilot-chip ' + (note.visibility === 'SUBJECT_VISIBLE' ? 'amber' : 'slate')}>{note.visibility === 'SUBJECT_VISIBLE' ? 'Shared with the student' : 'Staff only'}</span>
          <div className="role-record-actions">
            {note.canChangeVisibility && token ? <button type="button" className="pilot-btn ghost small" disabled={busy} onClick={() => void run(() => setCounsellingNoteVisibility(token, institutionId, note.id, {
              visibility: note.visibility === 'SUBJECT_VISIBLE' ? 'STAFF_ONLY' : 'SUBJECT_VISIBLE', version: note.version,
            }), note.visibility === 'SUBJECT_VISIBLE' ? 'The note is staff only again.' : 'The note is now shared with the student.')}>
              {note.visibility === 'SUBJECT_VISIBLE' ? 'Stop sharing with the student' : 'Share with the student'}</button> : null}
            {note.canErase && token ? <button type="button" className="pilot-btn ghost small" disabled={busy} onClick={() => void run(() => eraseCounsellingNote(token, institutionId, note.id, eraseReason), 'The note was erased.')}>Erase note</button> : null}
          </div>
        </article>)}</div> : <p>No notes you can read for this student.</p>}
        {detail.canManageParticipants ? <label>Reason for erasing a note<select disabled={busy} value={eraseReason} onChange={(event) => setEraseReason(event.target.value)}>
          {eraseReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label> : null}
        {detail.canManageParticipants || detail.participants.length ? <>
          <h3>Case participants</h3>
          {detail.participants.length ? <div className="pilot-list" aria-label="Case participants">{detail.participants.map((member) => <div className="pilot-list-row" key={member.membershipId}>
            <div className="grow"><strong>{member.name}</strong><small>{roleLabels[member.role] ?? 'Staff'} · Added {dateOf(member.addedAt)}</small></div>
            {detail.canManageParticipants && token ? <button type="button" className="pilot-btn ghost small" disabled={busy} onClick={() => void run(() => removeCounsellingParticipant(token, institutionId, detail.student.id, member.membershipId, removeReasons[0][0]), 'Participant removed.')}>Remove {member.name}</button> : null}
          </div>)}</div> : <p>No staff have been added to this case. Owners and administrators can read every note.</p>}
          {detail.canManageParticipants && token ? <form className="role-management-form" aria-label="Add a case participant" onSubmit={(event) => {
            event.preventDefault();
            if (!participant.membershipId) return;
            void run(() => addCounsellingParticipant(token, institutionId, detail.student.id, participant.membershipId, participant.reasonCode), 'Participant added. They can now read this student\'s counselling notes.');
          }}>
            <label>Staff member<select required disabled={busy} value={participant.membershipId} onChange={(event) => setParticipant({ ...participant, membershipId: event.target.value })}>
              <option value="">Select a staff member</option>
              {detail.eligibleStaff.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.name} — {roleLabels[member.role] ?? 'Staff'}</option>)}
            </select></label>
            <label>Reason<select disabled={busy} value={participant.reasonCode} onChange={(event) => setParticipant({ ...participant, reasonCode: event.target.value })}>
              {addReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
            <button className="pilot-btn" type="submit" disabled={busy || !detail.eligibleStaff.length}>Add to case</button>
          </form> : null}
        </> : null}
      </>}
    </section> : null}
  </div></div></div>;
}
