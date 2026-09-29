/**
 * ONE · Role portal — Institution — Faculty cohort view over the learning engine (INST-15)
 *
 * A section of the lecturer's existing "My Students" page (no navigation change): the skills
 * several of their students are stuck on, the most common misconceptions in their classes, and
 * who has reviews due. Everything comes from the server, already scoped to the lecturer's active
 * teaching assignments and to students who hold the adaptive-learning consent; nothing is
 * filtered here. Until students have been asked for that consent the section says so and shows
 * NA. No number about a student's learning is shown — names, skill names and counts of students,
 * with counts under 5 shown as "<5" or withheld by the server.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getLearningCohort, getProtectedAccessToken, listLearningCohortDueReviews, suppressedCountLabel } from '../api.js';
import type { LearningCohortDto, LearningCohortDueDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { go } from '../pilotParity/naWidgets.js';
import { formatApiError } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';

/** A response is used only when it has the shape the server sends; anything else is treated as a failed load. */
function isCohort(value: unknown): value is LearningCohortDto {
  const body = value as Partial<LearningCohortDto> | null;
  return Boolean(body && typeof body.consent?.offered === 'boolean' && Array.isArray(body.stuckSkills) && Array.isArray(body.misconceptions)
    && body.studentsSharing && typeof body.studentsSharing.suppressed === 'boolean');
}

function isDuePage(value: unknown): value is LearningCohortDueDto {
  const body = value as Partial<LearningCohortDueDto> | null;
  return Boolean(body && Array.isArray(body.students) && body.students.every((student) => Array.isArray(student.dueSkills)));
}

function loadError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.status === 403) return `You do not have permission to view this. Reference: ${error.correlationId}`;
  return formatApiError(error, fallback);
}

export function FacultyLearningCohortSection({ authenticatedWorkspace, basePath }: {
  readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined;
  readonly basePath: string;
}): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const isFaculty = authenticatedWorkspace?.role === 'FACULTY_LECTURER';
  const [cohort, setCohort] = useState<LearningCohortDto | null>(null);
  const [due, setDue] = useState<LearningCohortDueDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token || !institutionId || !isFaculty) return;
    const controller = new AbortController();
    setCohort(null); setDue(null); setError('');
    Promise.all([getLearningCohort(token, institutionId, controller.signal), listLearningCohortDueReviews(token, institutionId, null, controller.signal)])
      .then(([summary, page]) => {
        if (!isCohort(summary) || !isDuePage(page)) { setError('Unable to load learning across your students.'); return; }
        setCohort(summary); setDue(page);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'Unable to load learning across your students.')); });
    return () => controller.abort();
  }, [token, institutionId, isFaculty]);
  // The page itself explains a missing sign-in or the wrong role; this section adds nothing then.
  if (!token || !institutionId || !isFaculty) return null;

  async function moreDue(): Promise<void> {
    if (!due?.nextCursor) return;
    try {
      const next = await listLearningCohortDueReviews(token!, institutionId, due.nextCursor);
      if (!isDuePage(next)) { setError('Unable to load more students.'); return; }
      setDue({ ...next, students: [...due.students, ...next.students] });
    } catch (cause) {
      setError(loadError(cause, 'Unable to load more students.'));
    }
  }

  const offered = cohort?.consent.offered ?? false;
  const stuckStudents = cohort ? new Set(cohort.stuckSkills.flatMap((skill) => skill.students.map((student) => student.profileId))).size : null;
  const assignTask = <button type="button" className="pilot-link" onClick={() => go(`${basePath}/assigned-tasks`)}>Assign a task</button>;
  return <section className="role-card role-wide" aria-label="Learning across your students">
    <div className="pilot-card-head"><h2>Learning across your students</h2></div>
    <p>From the practice your students have done in ONE, for students in your teaching assignments who have chosen to share their learning data.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!cohort && !error ? <p role="status">Loading learning across your students…</p> : null}
    {cohort ? <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="🤝" tone="blue" value={offered ? suppressedCountLabel(cohort.studentsSharing) : 'NA'} label="Sharing learning data" />
      <V2Stat icon="🧗" tone="amber" value={offered ? String(stuckStudents ?? 0) : 'NA'} label="Stuck on a skill" />
      <V2Stat icon="🧩" tone="purple" value={offered ? cohort.misconceptions.length : 'NA'} label="Common misconceptions" />
      <V2Stat icon="🔁" tone="green" value={offered && due ? (due.nextCursor ? `${due.students.length}+` : due.students.length) : 'NA'} label="Reviews due" />
    </div> : null}
    {cohort && !offered ? <V2EmptyState icon="🔒" title="No learning data to show yet"
      note="Students have not yet been asked whether to share their learning data, so nothing from their practice is shown here."
      hint="This section fills in once students can choose to share it." /> : null}
    {cohort && offered && cohort.mode === 'MEMBERSHIP' ? <p>Your college has not started recording teaching assignments, so no students are included here yet.</p> : null}
    {cohort && offered ? <>
      <h3>Stuck on the same skill</h3>
      <p>Students who have practised a skill on at least two days without yet getting it right on their own.</p>
      {cohort.stuckSkills.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Skills your students are stuck on</caption>
        <thead><tr><th scope="col">Skill</th><th scope="col">Students</th><th scope="col">Who</th><th scope="col">Action</th></tr></thead>
        <tbody>{cohort.stuckSkills.map((skill) => <tr key={skill.skillId}><th scope="row">{skill.skillName}</th><td>{skill.studentCount}</td>
          <td>{skill.students.map((student) => `${student.fullName} (${student.rollNumber})`).join(', ')}</td><td>{assignTask}</td></tr>)}</tbody></table></div>
        : <p>No student is stuck on a skill right now.</p>}
      <h3>Most common misconceptions</h3>
      <p>Mistakes held by five or more of your students. Smaller groups are not shown, so no student can be singled out.</p>
      {cohort.misconceptions.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Common misconceptions</caption>
        <thead><tr><th scope="col">Misconception</th><th scope="col">Skill</th><th scope="col">Students</th><th scope="col">Action</th></tr></thead>
        <tbody>{cohort.misconceptions.map((entry) => <tr key={entry.code}><th scope="row">{entry.title}</th><td>{entry.skillName}</td><td>{entry.students}</td>
          <td><button type="button" className="pilot-link" onClick={() => go(`${basePath}/interventions`)}>Plan an intervention</button></td></tr>)}</tbody></table></div>
        : <p>{cohort.misconceptionsWithheld ? 'Some misconceptions are held by fewer than five students, so none is shown.' : 'No misconception is common among your students right now.'}</p>}
      {cohort.misconceptions.length && cohort.misconceptionsWithheld ? <p>Other misconceptions are held by fewer than five students and are not shown.</p> : null}
      <h3>Reviews due</h3>
      <p>Students with a skill due for review. Dates are not shown.</p>
      {due && due.students.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Students with reviews due</caption>
        <thead><tr><th scope="col">Student</th><th scope="col">Skills due</th><th scope="col">Action</th></tr></thead>
        <tbody>{due.students.map((student) => <tr key={student.profileId}><th scope="row"><strong>{student.fullName}</strong><span>{student.rollNumber}</span></th>
          <td>{student.dueSkills.join(', ') || 'NA'}</td><td>{assignTask}</td></tr>)}</tbody></table></div>
        : due ? <p>No student has a review due right now.</p> : null}
      {due?.nextCursor ? <div className="role-record-actions"><button type="button" className="secondary" onClick={() => void moreDue()}>Load more students</button></div> : null}
    </> : null}
  </section>;
}
