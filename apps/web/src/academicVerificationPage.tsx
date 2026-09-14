/**
 * The queue an institution works to confirm the records it issued.
 *
 * The decision it supports is permanent — a database trigger refuses to un-verify a
 * record — so the screen's job is to give staff what they need to be sure before they
 * press the button, and to be honest about what it cannot tell them.
 *
 * The important case is the last one. A request can come from someone this institution
 * has no roster record of at all: an alumnus who left before ONE existed. For them there
 * is no name to show, because ONE has never been told one. The screen says so and shows
 * the email and the claimed dates, rather than filling the column with a guess.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { decideVerification, listVerificationQueue, type VerificationQueueEntryDto } from './api.js';

const RELATIONSHIP_LABEL: Readonly<Record<VerificationQueueEntryDto['relationship'], string>> = {
  CURRENT: 'Current student',
  FORMER: 'Former student',
  NONE: 'Not on your roster',
};

function result(entry: VerificationQueueEntryDto): string {
  if (entry.resultLetter) return entry.resultLetter;
  if (entry.resultValue === null) return 'NA';
  const scale = entry.resultScale === 'PERCENTAGE' ? '%' : entry.resultScale === 'CGPA_10' ? ' / 10' : entry.resultScale === 'GPA_4' ? ' / 4' : '';
  return `${entry.resultValue}${scale}`;
}

function years(entry: VerificationQueueEntryDto): string {
  const from = entry.claimedStartedOn ? new Date(entry.claimedStartedOn).getFullYear() : null;
  const to = entry.claimedCompletedOn ? new Date(entry.claimedCompletedOn).getFullYear() : null;
  if (!from && !to) return 'Dates not stated';
  return `Claims ${from ?? '?'} – ${to ?? 'present'}`;
}

export function AcademicVerificationPage({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const [queue, setQueue] = useState<readonly VerificationQueueEntryDto[] | null>(null);
  const [status, setStatus] = useState('Loading the verification queue…');
  const [deciding, setDeciding] = useState<string | null>(null);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    listVerificationQueue(token, institutionId, abort.signal)
      .then((response) => { setQueue(response.queue); setStatus(''); })
      .catch(() => { if (!abort.signal.aborted) setStatus('The verification queue could not be loaded.'); });
    return () => abort.abort();
  }, [institutionId]);

  async function decide(termId: string, decision: 'VERIFIED' | 'REJECTED'): Promise<void> {
    const token = getAccessToken();
    if (!token || deciding) return;
    setDeciding(termId);
    try {
      const response = await decideVerification(token, institutionId, termId, decision);
      setQueue(response.queue);
      setStatus(decision === 'VERIFIED'
        ? 'Verified. This decision is permanent and cannot be reversed.'
        : 'Rejected. The student can correct the record and submit it again.');
    } catch {
      setStatus('That decision could not be recorded.');
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
        <thead><tr><th>Person</th><th>Standing</th><th>Programme</th><th>Term</th><th>Result</th><th>Decision</th></tr></thead>
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
          <td>{result(entry)}{entry.backlogCount ? <><br /><span className="hiring-meta">{entry.backlogCount} backlog</span></> : null}</td>
          <td><div className="hiring-actions">
            <button type="button" disabled={deciding === entry.termId} onClick={() => { void decide(entry.termId, 'VERIFIED'); }}>Confirm</button>
            <button type="button" className="secondary" disabled={deciding === entry.termId} onClick={() => { void decide(entry.termId, 'REJECTED'); }}>Reject</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>
    </section> : null}
  </div>;
}
