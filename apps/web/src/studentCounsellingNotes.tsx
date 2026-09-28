/**
 * Counselling notes the student's college chose to share with them (INST-11).
 *
 * A college's counselling notes are staff only by default; a note appears here only after its
 * author or an administrator shared it. The student sees the text and when it was written, and
 * which kind of staff member wrote it — never a name or an internal identifier. Shown inside the
 * dashboard's Support card, so no navigation changes.
 */
import { useEffect, useState } from 'react';
import { listMySharedCounsellingNotes, type SharedCounsellingNoteDto } from './api/counselling.js';

const writerRoles: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'college administration', INSTITUTION_ADMIN: 'college administration', PLACEMENT_ADMIN: 'placement office',
  DEPARTMENT_HEAD: 'department head', FACULTY_LECTURER: 'faculty',
};

export function SharedCounsellingNotes({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [notes, setNotes] = useState<readonly SharedCounsellingNoteDto[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    listMySharedCounsellingNotes(token, institutionId, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setNotes(response.notes); })
      .catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, [token, institutionId]);
  return <div aria-labelledby="shared-counselling-title">
    <h3 id="shared-counselling-title">Counselling notes shared with you</h3>
    {unavailable ? <p>NA — shared counselling notes are unavailable right now.</p>
      : notes === null ? <p role="status">Loading shared notes…</p>
        : notes.length ? <ul className="pilot-list" aria-label="Shared counselling notes">{notes.map((note) => {
          const writer = Object.hasOwn(writerRoles, note.authorRole) ? writerRoles[note.authorRole] : null;
          const written = Number.isFinite(Date.parse(note.createdAt))
            ? new Date(note.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'NA';
          return <li key={note.id} className="pilot-list-row"><div className="grow">
            <strong>{note.title}</strong>
            <p>{note.note}</p>
            <small>{writer ? `Shared by your ${writer}` : 'Shared by your college'} · {written}</small>
          </div></li>;
        })}</ul> : <p>Your college has not shared any counselling notes with you.</p>}
  </div>;
}
