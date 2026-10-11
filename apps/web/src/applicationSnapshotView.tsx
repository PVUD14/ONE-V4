/**
 * ONE · The consented application snapshot, on screen (EMP-07).
 *
 * One rendering of "what the student shared", used twice: the student reviews it before applying
 * (StudentOpportunitiesPage), and the employer reads it on Candidate Detail and from a row on
 * Applicants (CandidateDetailPanel). Showing both sides the same layout is the point — the employer
 * sees what the student saw, and nothing else. Missing facts say NA; nothing is filled in.
 *
 * Built only from existing pilot and hiring classes; no new styles.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { V2Stat } from './dashboardsV2.js';
import { basisLabels, describeEligibilityRule } from './hiringEligibility.js';
import { ApiRequestError } from './api.js';
import { downloadCandidateResume, getEmployerCandidate, type ApplicationSnapshotDto, type CandidateDetailDto } from './api/hiring.js';
import { EmployerEvidencePanel } from './skillEvidence.js';

const verificationLabels: Readonly<Record<string, string>> = {
  VERIFIED: 'verified by the college', SELF_REPORTED: 'self-reported', PENDING_VERIFICATION: 'awaiting the college',
};
const snapshotStatusText: Readonly<Record<string, string>> = {
  NOT_CAPTURED: 'This person applied before ONE kept a copy of what was shared, so there is nothing to show here. Their live profile is not shown in its place.',
  ERASED: 'This person deleted their ONE account. What they shared has been erased.',
  UNREADABLE: 'What this person shared could not be shown.',
};

function humanise(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return 'NA';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'NA';
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
}
function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function years(start: number | null, end: number | null): string {
  if (!start && !end) return 'NA';
  return `${start ?? 'NA'} – ${end ?? 'present'}`;
}

/** The snapshot itself. `audience` only changes the wording of the contact line. */
export function SnapshotSummary({ snapshot, audience }: { readonly snapshot: ApplicationSnapshotDto; readonly audience: 'student' | 'employer' }): React.ReactElement {
  const education = snapshot.education;
  const contactHidden = audience === 'employer' && snapshot.candidate.contactVisibleFrom;
  return <div aria-label="Shared profile">
    <h3>{snapshot.candidate.fullName ?? 'NA'}</h3>
    <p className="hiring-meta">
      {contactHidden
        ? 'Contact details are shown once you shortlist this candidate.'
        : <>Email: {snapshot.candidate.email ?? 'NA'} · Phone: {snapshot.candidate.phone ?? (audience === 'student' ? 'not shared' : 'NA')}</>}
    </p>
    <p>{education?.programmeName ?? 'NA'}{education?.departmentName ? `, ${education.departmentName}` : ''} · {education?.institutionName ?? 'NA'} · Graduating {education?.expectedGraduationYear ?? 'NA'}</p>
    {snapshot.profile.headline ? <p><strong>{snapshot.profile.headline}</strong></p> : null}
    {snapshot.profile.summary ? <p>{snapshot.profile.summary}</p> : null}
    <h4>Qualifications</h4>
    {snapshot.qualifications.length
      ? <ul className="hiring-stages" aria-label="Qualifications">{snapshot.qualifications.map((q, index) => <li key={`${q.qualificationType}-${index}`}>
        {q.programmeName} ({q.qualificationType}) · {q.institutionName ?? 'NA'} · {years(q.startedYear, q.completedYear)}{q.awarded ? ' · awarded' : ''}
        {' '}<span className={q.verification === 'VERIFIED' ? 'hiring-tag' : 'hiring-tag warn'}>{verificationLabels[q.verification] ?? humanise(q.verification)}</span>
      </li>)}</ul>
      : <p className="hiring-meta">No qualifications recorded.</p>}
    <h4>Links</h4>
    {snapshot.links.length
      ? <ul className="hiring-stages" aria-label="Shared links">{snapshot.links.map((link) => <li key={link.url}>
        <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label ?? link.url}</a>
      </li>)}</ul>
      : <p className="hiring-meta">No links shared.</p>}
    <h4>Résumé</h4>
    <p className="hiring-meta">{snapshot.resume
      ? `${snapshot.resume.title} — ${snapshot.resume.filename}, version ${snapshot.resume.versionNumber}, ${fileSize(snapshot.resume.byteSize)}`
      : 'No résumé attached.'}</p>
  </div>;
}

/**
 * The employer's Candidate Detail for one application: what the student shared, the eligibility
 * flags (outcome and basis, never figures), the stage timeline, interviews and the offer. Every
 * open is audited by the API; a candidate whose grant has ended is refused, and this says so.
 */
export function CandidateDetailPanel({ employerId, applicationId, onClose }: { readonly employerId: string; readonly applicationId: string; readonly onClose?: () => void }): React.ReactElement {
  const [candidate, setCandidate] = useState<CandidateDetailDto | null>(null);
  const [status, setStatus] = useState('Loading the candidate…');
  const [downloadStatus, setDownloadStatus] = useState('');
  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    setCandidate(null); setStatus('Loading the candidate…'); setDownloadStatus('');
    getEmployerCandidate(token, employerId, applicationId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) { setCandidate(response.candidate); setStatus(''); } })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setStatus(error instanceof ApiRequestError && error.status === 403
          ? 'This candidate is no longer sharing their details with you, or you do not have access to them.'
          : `The candidate could not be loaded.${error instanceof ApiRequestError && error.correlationId ? ` Reference: ${error.correlationId}.` : ''}`);
      });
    return () => abort.abort();
  }, [employerId, applicationId]);

  async function downloadResume(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setDownloadStatus('Preparing the résumé…');
    try {
      const { blob, filename } = await downloadCandidateResume(token, employerId, applicationId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename; link.rel = 'noopener';
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setDownloadStatus('Résumé downloaded. The download was recorded.');
    } catch (error) {
      setDownloadStatus(error instanceof ApiRequestError && error.status === 403
        ? 'The résumé is no longer available to you.'
        : 'The résumé could not be downloaded. Try again.');
    }
  }

  return <section id="candidate-detail" className="role-card role-wide" aria-label="Candidate detail">
    <div className="hiring-actions">
      <h2>Candidate detail</h2>
      {onClose ? <button type="button" className="secondary" onClick={onClose}>Close</button> : null}
    </div>
    {status ? <p role="status">{status}</p> : null}
    {candidate ? <>
      <div className="v2-row v2-cols-4 career-stat-strip">
        <V2Stat icon="📌" tone="blue" value={humanise(candidate.application.state)} label="Stage" />
        <V2Stat icon="🗓️" tone="purple" value={formatDate(candidate.application.submittedAt)} label="Applied" />
        <V2Stat icon="📅" tone="amber" value={candidate.interviews.length} label="Interviews" />
        <V2Stat icon="🏁" tone="green" value={candidate.offer ? humanise(candidate.offer.state) : 'NA'} label="Offer" />
      </div>
      <p className="hiring-meta">{candidate.application.title} · applied under version {candidate.application.appliedVersionNumber}
        {candidate.application.currentVersionNumber && candidate.application.currentVersionNumber !== candidate.application.appliedVersionNumber
          ? ` (the job is now on version ${candidate.application.currentVersionNumber})` : ''}
        {candidate.application.termsAcknowledgementPending ? <span className="hiring-tag warn">Awaiting new-terms acceptance</span> : null}</p>

      <h3>What they shared with you</h3>
      {candidate.snapshot
        ? <>
          <p className="hiring-meta">Shared when they applied, on {formatDate(candidate.sharedAt, true)}. This is their copy at that moment, not their live profile.</p>
          <SnapshotSummary snapshot={candidate.snapshot} audience="employer" />
          {candidate.resumeAvailable
            ? <div className="hiring-actions"><button type="button" onClick={() => { void downloadResume(); }}>Download résumé</button></div>
            : null}
          {downloadStatus ? <p role="status">{downloadStatus}</p> : null}
        </>
        : <p>{snapshotStatusText[candidate.snapshotStatus] ?? snapshotStatusText.UNREADABLE}</p>}

      <h3>Eligibility</h3>
      {candidate.eligibility
        ? <ul className="hiring-stages" aria-label="Eligibility outcomes">{candidate.eligibility.outcomes.map((outcome, index) => <li key={`${outcome.ruleType}-${index}`}>
          {describeEligibilityRule(outcome)}: {outcome.outcome === 'NOT_EVALUATED' ? 'for you to judge'
            : outcome.outcome === 'MET' ? 'met' : outcome.outcome === 'NOT_MET' ? 'not met' : 'not known'}
          {outcome.basis ? <span className={outcome.basis === 'SELF_REPORTED' ? 'hiring-tag warn' : 'hiring-tag'}>{basisLabels[outcome.basis]}</span> : null}
        </li>)}</ul>
        : <p className="hiring-meta">This job had no eligibility rules when they applied.</p>}

      <h3>Timeline</h3>
      <ol className="hiring-stages" aria-label="Stage timeline">{candidate.timeline.map((entry, index) => <li key={`${entry.toState}-${index}`}>
        {humanise(entry.toState)} · {formatDate(entry.occurredAt, true)}{entry.actor ? ` · by ${entry.actor === 'STUDENT' ? 'the candidate' : 'your team'}` : ''}
      </li>)}</ol>

      <h3>Interviews</h3>
      {candidate.interviews.length
        ? <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Round</th><th>Mode</th><th>State</th><th>Start</th><th>Scorecards</th></tr></thead>
          <tbody>{candidate.interviews.map((interview) => <tr key={interview.roundNumber}>
            <td>{interview.roundNumber}</td><td>{humanise(interview.mode)}</td><td>{humanise(interview.state)}</td>
            <td>{formatDate(interview.scheduledStart, true)}</td><td>{interview.scorecardCount}</td>
          </tr>)}</tbody>
        </table></div>
        : <p className="hiring-meta">No interviews yet.</p>}

      <h3>Offer</h3>
      {candidate.offer
        ? <p>{humanise(candidate.offer.state)} · joining {formatDate(candidate.offer.joiningDate)} · expires {formatDate(candidate.offer.expiresAt, true)}</p>
        : <p className="hiring-meta">No offer yet.</p>}

      {/* EMP-13: the verified evidence the candidate chose to share, per job skill (renders nothing while the feature is off). */}
      <EmployerEvidencePanel employerId={employerId} applicationId={applicationId} />
    </> : null}
  </section>;
}
