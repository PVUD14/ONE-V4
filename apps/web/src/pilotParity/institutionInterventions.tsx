/**
 * ONE · Pilot-parity — Stream C — Institution
 *
 * The interventions shell. Its not-attempted queue is real, derived from live
 * assessment results; intervention records themselves are NA until the table exists.
 */
import { getProtectedAccessToken, listInstitutionExamResults, listInstitutionExams } from '../api.js';
import type { ExamNotAttemptedDto } from '../api.js';
import { Ring } from '../pilot/pilotComponents.js';
import { NaListCard, go } from './naWidgets.js';
import { AlertTriangle, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

export function InstitutionInterventionsPage({ institutionId, basePath }: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [queue, setQueue] = useState<readonly (ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string })[] | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listInstitutionExams(token, institutionId, controller.signal).then(async (response) => {
      const published = response.assessments.filter((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0).slice(0, 3);
      const groups = await Promise.all(published.map((exam) =>
        listInstitutionExamResults(token, institutionId, exam.id, controller.signal)
          .then((result) => result.notAttempted.map((entry) => ({ ...entry, examTitle: exam.title, endsAt: exam.endsAt })))
          .catch(() => [])));
      setQueue(groups.flat());
    }).catch(() => setQueue([]));
    return () => controller.abort();
  }, [token, institutionId]);

  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Interventions</h1><p>Structured support for students who need attention before the placement season.</p></div>
        <button type="button" className="pilot-btn" disabled title="Structured intervention workflows are not built yet"><Plus size={15} /> Assign Intervention</button>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Needs attention now</h2><span className="pilot-chip blue">Live — from assessment data</span></div>
        <div className="pilot-list">
          {queue === null ? <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Loading…</p>
            : queue.length ? queue.slice(0, 8).map((entry, index) => (
              <div key={`${entry.institutionStudentId}-${index}`} className="pilot-list-row">
                <span className="pilot-tile rose"><AlertTriangle size={16} /></span>
                <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? `In progress now: ${entry.examTitle}` : `Has not attempted: ${entry.examTitle}`}</small></div>
                <span className="pilot-chip amber">Due {new Date(entry.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/assessments`)}>Review</button>
              </div>
            )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Nobody needs attention right now — every assigned assessment is attempted.</p>}
        </div>
      </section>

      <NaListCard title="Tracked interventions" note="Structured intervention records (owner, due date, outcome tracking) are not built yet — NA. The live queue above is derived from real assessment data." />
    </div>
    <aside className="pilot-rail">
      <NaListCard title="Why Interventions Work" note="Outcome insights arrive once structured intervention records exist — NA." />
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Completion Rate</h2>
        <Ring value={0} size={104} stroke={11} tone="blue"><span style={{ fontSize: 16, color: 'var(--p-muted)' }}>NA</span></Ring>
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>NA — no tracked interventions yet</small>
      </section>
    </aside>
  </div></div>;
}
