/**
 * ONE · Employer portal — Candidate Detail and Talent Pool (EMP-07).
 *
 * The screens behind two existing navigation labels that used to fall through to the applicants
 * list (EMPLOYER_BASELINE D-7). Candidate Detail now shows one applicant as they chose to be seen:
 * pick a job and an applicant whose details are still shared, and the consented snapshot, résumé,
 * eligibility flags, timeline, interviews and offer appear (CandidateDetailPanel), with the EMP-10
 * conversation beneath them (EmployerConversationPanel), and the employer's own screening-test
 * results for that application (EMP-12, EmployerCandidateAssessmentsPanel). Talent Pool is consented
 * discovery (EMP-14, talentPool.tsx); while it is switched off it says plainly that it is not
 * available, instead of borrowing the applicants list to look populated. No navigation item is added, removed, renamed or moved.
 */
import { useEffect, useRef, useState } from 'react';
import { getAccessToken } from '../auth.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { listEmployerApplicants, listEmployerOpportunities, type EmployerApplicantDto, type EmployerOpportunityDto } from '../api.js';
import { CandidateDetailPanel } from '../applicationSnapshotView.js';
import { EmployerConversationPanel } from '../applicationMessages.js';
import { EmployerCandidateAssessmentsPanel } from '../employerAssessmentsPage.js';
import { EmployerTalentPoolWorkspace } from '../talentPool.js';
import { applicationStageLabel } from '../labels.js';
import { candidateAppliedSuffix } from '../hiringPages.js';
import { portalRecordFromHistory } from './shared.js';

function humanise(value: string): string {
  return applicationStageLabel(value);
}

export function EmployerCandidateDetailPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [opportunities, setOpportunities] = useState<readonly EmployerOpportunityDto[]>([]);
  // An Applicants row can open this page on one candidate; the choice arrives in history state.
  const [opportunityId, setOpportunityId] = useState(() => portalRecordFromHistory('opportunityId') ?? '');
  const pendingApplication = useRef(portalRecordFromHistory('applicationId'));
  const [applicants, setApplicants] = useState<readonly EmployerApplicantDto[]>([]);
  const [applicationId, setApplicationId] = useState('');
  const [status, setStatus] = useState('Loading your jobs…');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    listEmployerOpportunities(token, employerId, abort.signal)
      .then((response) => {
        if (abort.signal.aborted) return;
        setOpportunities(response.opportunities);
        setStatus(response.opportunities.length ? '' : 'You have no jobs yet, so there are no candidates to show.');
      })
      .catch(() => { if (!abort.signal.aborted) setStatus('Your jobs could not be loaded.'); });
    return () => abort.abort();
  }, [employerId]);

  useEffect(() => {
    const token = getAccessToken();
    setApplicants([]); setApplicationId('');
    if (!token || !opportunityId) return;
    const abort = new AbortController();
    listEmployerApplicants(token, employerId, opportunityId, abort.signal)
      .then((response) => {
        if (abort.signal.aborted) return;
        setApplicants(response.applications);
        setStatus(response.applications.length ? '' : 'No applications for this job yet.');
        const pending = pendingApplication.current;
        pendingApplication.current = null;
        if (pending && response.applications.some((item) => item.id === pending && item.candidateAccess !== false && !item.consentRevoked)) setApplicationId(pending);
      })
      .catch(() => { if (!abort.signal.aborted) setStatus('Applicants could not be loaded.'); });
    return () => abort.abort();
  }, [employerId, opportunityId]);

  // Only people still sharing their details can be opened; the rest are counted, not listed.
  const shared = applicants.filter((item) => item.candidateAccess !== false && !item.consentRevoked);
  const withheld = applicants.length - shared.length;

  return <StaffPilotWrap title="Candidate Detail" subtitle="What each applicant chose to share with you when they applied.">
    <section className="role-card role-wide">
      <label className="student-form-field"><span>Job</span>
        <select value={opportunityId} onChange={(event) => setOpportunityId(event.target.value)}>
          <option value="">Select a job</option>
          {opportunities.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.referenceCode} ({item.applicationCount})</option>)}
        </select>
      </label>
      {opportunityId ? <label className="student-form-field"><span>Candidate</span>
        <select value={applicationId} onChange={(event) => setApplicationId(event.target.value)}>
          <option value="">Select a candidate</option>
          {shared.map((item) => <option key={item.id} value={item.id}>{item.candidateName?.trim() ? item.candidateName : ['Candidate', candidateAppliedSuffix(item.submittedAt)].filter(Boolean).join(' · ')} · {humanise(item.state)}</option>)}
        </select>
      </label> : null}
      {withheld > 0 ? <p className="hiring-meta">{withheld} {withheld === 1 ? 'applicant is' : 'applicants are'} no longer sharing their details and cannot be opened.</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </section>
    {applicationId ? <>
      <CandidateDetailPanel key={applicationId} employerId={employerId} applicationId={applicationId} />
      {/* EMP-12: this candidate's results on the employer's own screening tests, through the live grant. */}
      <EmployerCandidateAssessmentsPanel key={`assessments-${applicationId}`} employerId={employerId} applicationId={applicationId} />
      {/* EMP-10: the conversation with this candidate, inside Candidate Detail. */}
      <EmployerConversationPanel key={`messages-${applicationId}`} employerId={employerId} applicationId={applicationId}
        candidateName={shared.find((item) => item.id === applicationId)?.candidateName ?? null} />
    </>
      : <div className="role-wide"><V2EmptyState icon="🧾" title="Choose a candidate"
        note="Pick a job and an applicant to see the profile, résumé and links they shared with you."
        hint="Contact details appear once you shortlist someone. Every view is recorded." /></div>}
  </StaffPilotWrap>;
}

/**
 * Talent Pool: consented discovery (EMP-14, ADR-044). While the feature is off (HG-4 pending) the API
 * answers `available: false` and the page keeps the honest not-available state from EMP-07.
 */
export function EmployerTalentPoolPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  return <EmployerTalentPoolWorkspace employerId={employerId} />;
}
