/**
 * ONE · Employer portal — Candidate Detail and Talent Pool (EMP-07).
 *
 * The screens behind two existing navigation labels that used to fall through to the applicants
 * list (EMPLOYER_BASELINE D-7). Candidate Detail now shows one applicant as they chose to be seen:
 * pick a job and an applicant whose details are still shared, and the consented snapshot, résumé,
 * eligibility flags, timeline, interviews and offer appear (CandidateDetailPanel), with the EMP-10
 * conversation beneath them (EmployerConversationPanel). Talent Pool says
 * plainly that it is not available yet — consented discovery is EMP-14 — instead of borrowing the
 * applicants list to look populated. No navigation item is added, removed, renamed or moved.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from '../auth.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { listEmployerApplicants, listEmployerOpportunities, type EmployerApplicantDto, type EmployerOpportunityDto } from '../api.js';
import { CandidateDetailPanel } from '../applicationSnapshotView.js';
import { EmployerConversationPanel } from '../applicationMessages.js';

function humanise(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export function EmployerCandidateDetailPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [opportunities, setOpportunities] = useState<readonly EmployerOpportunityDto[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
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
          {shared.map((item) => <option key={item.id} value={item.id}>{item.candidateName ?? 'NA'} · {humanise(item.state)}</option>)}
        </select>
      </label> : null}
      {withheld > 0 ? <p className="hiring-meta">{withheld} {withheld === 1 ? 'applicant is' : 'applicants are'} no longer sharing their details and cannot be opened.</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </section>
    {applicationId ? <>
      <CandidateDetailPanel key={applicationId} employerId={employerId} applicationId={applicationId} />
      {/* EMP-10: the conversation with this candidate, inside Candidate Detail. */}
      <EmployerConversationPanel key={`messages-${applicationId}`} employerId={employerId} applicationId={applicationId}
        candidateName={shared.find((item) => item.id === applicationId)?.candidateName ?? null} />
    </>
      : <div className="role-wide"><V2EmptyState icon="🧾" title="Choose a candidate"
        note="Pick a job and an applicant to see the profile, résumé and links they shared with you."
        hint="Contact details appear once you shortlist someone. Every view is recorded." /></div>}
  </StaffPilotWrap>;
}

/** Talent Pool, honestly: consented discovery (EMP-14) does not exist yet. */
export function EmployerTalentPoolPage(): React.ReactElement {
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Not available yet</span>
      <h1>Talent Pool</h1>
      <p>You can see people who applied to your jobs under Applicants and Candidate Detail.</p>
    </div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not available yet"
      note="Talent Pool will list students who have chosen to be discoverable by employers. That choice does not exist in ONE yet, so nobody is listed here."
      hint="Nothing is hidden: students appear only after they opt in." /></div>
  </section>;
}
