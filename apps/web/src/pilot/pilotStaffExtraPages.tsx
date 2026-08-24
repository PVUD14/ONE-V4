import { AlertTriangle, Building2, CalendarDays, CheckCircle2, ClipboardCheck, Download, FileText, MapPin, PenTool, Plus, TrendingUp, Users } from 'lucide-react';
import { Ring } from './pilotComponents.js';
import { DetailRows, OverlayForm, useOverlay } from './pilotOverlay.js';
import { usePilotSession } from './pilotSession.js';
import { pilotCohort, pilotEmployerPersona, pilotEmployerStats, pilotRoster } from './pilotStaffData.js';

/**
 * The remaining staff pages: institution assessments and interventions, employer
 * offers and company profile. Dates and names stay coherent with what the
 * student and the other portals already show.
 */

// --- Institution: Assessments -------------------------------------------------

const COHORT_ASSESSMENTS = [
  { name: 'Aptitude Mock Test', date: '20 May, 10:00 AM', invited: 412, kind: 'Aptitude', status: 'Scheduled' },
  { name: 'Communication Assessment', date: '20 May, 03:00 PM', invited: 412, kind: 'Communication', status: 'Scheduled' },
  { name: 'Technical Mock - NQT Pattern', date: '27 May, 10:00 AM', invited: 386, kind: 'Technical', status: 'Scheduled' },
  { name: 'Quantitative Aptitude - Round 2', date: '12 May', invited: 398, kind: 'Aptitude', status: 'Completed', average: 61, participation: 91 },
  { name: 'Verbal Ability Assessment', date: '05 May', invited: 402, kind: 'Verbal', status: 'Completed', average: 66, participation: 88 },
  { name: 'Coding Challenge - Set A', date: '28 Apr', invited: 214, kind: 'Technical', status: 'Completed', average: 58, participation: 84 },
] as const;

export function InstitutionAssessments(): React.ReactElement {
  const overlay = useOverlay();
  const session = usePilotSession();
  const createAssessment = (): void => {
    overlay.openModal({
      title: 'Create Assessment', subtitle: 'Schedules for the selected cohort', body: <OverlayForm
        fields={[
          { label: 'Assessment name', name: 'name', placeholder: 'e.g. Aptitude Mock — Round 3' },
          { label: 'Type', name: 'kind', type: 'select', value: 'Aptitude', options: ['Aptitude', 'Technical', 'Communication', 'Verbal', 'Mock'] },
          { label: 'Date', name: 'date', type: 'date', value: '2026-06-02' },
          { label: 'Invite', name: 'cohort', type: 'select', value: 'All placement-eligible (412)', options: ['All placement-eligible (412)', 'CSE only (186)', 'At-risk students (57)'] },
        ]}
        submitLabel="Schedule Assessment"
        success="Assessment scheduled and invitations queued (sample)."
        onSubmit={(values) => session.addAssessment({
          name: values['name'] || 'Untitled Assessment',
          kind: values['kind'] || 'Aptitude',
          date: values['date'] || '2026-06-02',
          invited: values['cohort']?.includes('CSE') ? 186 : values['cohort']?.includes('At-risk') ? 57 : 412,
        })} />,
    });
  };
  const viewResults = (assessment: typeof COHORT_ASSESSMENTS[number]): void => {
    overlay.openModal({
      title: assessment.name, subtitle: 'Results summary', body: <div>
        <DetailRows rows={[
          ['Average score', String(assessment.status === 'Completed' ? assessment.average : '—')],
          ['Participation', assessment.status === 'Completed' ? `${assessment.participation}%` : '—'],
          ['Invited', String(assessment.invited)],
          ['Type', assessment.kind],
        ]} />
        <p className="pilot-modal-text" style={{ marginTop: 12 }}>The full results view breaks scores down by department and question, and flags students below the intervention threshold.</p>
      </div>,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Assessments</h1><p>Schedule cohort assessments and track participation and outcomes.</p></div>
        <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); createAssessment(); }}><Plus size={15} /> Create Assessment</button>
      </div>

      <div className="pilot-row cols-4">
        {[
          ['Scheduled', 3, 'blue', CalendarDays], ['Completed This Term', 12, 'green', CheckCircle2],
          ['Average Score', 64, 'amber', TrendingUp], ['Participation', '88%', 'purple', Users],
        ].map(([label, value, tone, Icon]) => (
          <section key={label as string} className="pilot-card pilot-kpi">
            {(() => { const Component = Icon as typeof Users; return <span className={`pilot-tile ${tone as string}`}><Component size={17} /></span>; })()}
            <div><b>{value as number}</b><small>{label as string}</small></div>
          </section>
        ))}
      </div>

      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Assessment</th><th>Date</th><th>Type</th><th>Invited</th><th>Result</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {session.createdAssessments.map((created) => (
              <tr key={`${created.name}-${created.date}`}>
                <td><strong>{created.name}</strong></td>
                <td>{created.date}</td>
                <td>{created.kind}</td>
                <td>{created.invited}</td>
                <td><small style={{ color: 'var(--p-muted)' }}>—</small></td>
                <td><span className="pilot-chip purple">Just scheduled</span></td>
                <td><button type="button" className="pilot-btn ghost small">Manage</button></td>
              </tr>
            ))}
            {COHORT_ASSESSMENTS.map((assessment) => (
              <tr key={assessment.name}>
                <td><strong>{assessment.name}</strong></td>
                <td>{assessment.date}</td>
                <td>{assessment.kind}</td>
                <td>{assessment.invited}</td>
                <td>{assessment.status === 'Completed' ? <small>avg <b>{assessment.average}</b> · {assessment.participation}% attended</small> : <small style={{ color: 'var(--p-muted)' }}>—</small>}</td>
                <td><span className={`pilot-chip ${assessment.status === 'Completed' ? 'green' : 'blue'}`}>{assessment.status}</span></td>
                <td><button type="button" className="pilot-btn ghost small" onClick={assessment.status === 'Completed' ? (event) => { event.stopPropagation(); viewResults(assessment); } : undefined}>{assessment.status === 'Completed' ? 'View Results' : 'Manage'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Participation Rate</h2>
        <Ring value={88} size={104} stroke={11} tone="green" />
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>Average across the last 6 cohort assessments</small>
      </section>
      <section className="pilot-card">
        <h2>Reading the Results</h2>
        <div className="pilot-list">
          {[
            'Aptitude averages are trending up 5 points term on term.',
            'Technical scores lag in ECE and MECH - practice sets assigned.',
            'Students below 40 are flagged automatically for intervention.',
          ].map((note) => (
            <div key={note} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <ClipboardCheck size={15} color="#1f55e5" style={{ flexShrink: 0 }} />
              <small style={{ color: 'var(--p-ink-2)' }}>{note}</small>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}

// --- Institution: Interventions -----------------------------------------------

const INTERVENTION_ROWS = [
  { student: 'Aditya Rao', registration: 'VIT2027-0644', initials: 'ADR', action: 'Career counselling session', owner: 'Prof. Meera Nair', due: '28 May', status: 'Open', tone: 'rose' },
  { student: 'Rohit Verma', registration: 'VIT2027-0590', initials: 'RV', action: 'Aptitude improvement plan', owner: 'Prof. S. Raman', due: '30 May', status: 'Open', tone: 'amber' },
  { student: 'Karthik Menon', registration: 'VIT2027-0521', initials: 'KM', action: 'Resume review with faculty', owner: 'Prof. Meera Nair', due: '2 Jun', status: 'In progress', tone: 'blue' },
  { student: 'Divya Krishnan', registration: 'VIT2027-0307', initials: 'DK', action: 'Communication coaching', owner: 'Dr. L. Thomas', due: '5 Jun', status: 'In progress', tone: 'purple' },
  { student: 'Suresh Babu', registration: 'VIT2027-0688', initials: 'SB', action: 'Mock interview practice', owner: 'Prof. S. Raman', due: 'Completed 12 May', status: 'Completed', tone: 'green' },
] as const;

export function InstitutionInterventions(): React.ReactElement {
  const overlay = useOverlay();
  const session = usePilotSession();
  const assignIntervention = (): void => {
    overlay.openModal({
      title: 'Assign Intervention', subtitle: 'Creates a tracked support action', body: <OverlayForm
        fields={[
          { label: 'Student', name: 'student', type: 'select', value: pilotRoster[4]?.name ?? 'Aditya Rao', options: pilotRoster.map((student) => student.name) },
          { label: 'Intervention', name: 'action', type: 'select', value: 'Career counselling session', options: ['Career counselling session', 'Aptitude improvement plan', 'Resume review with faculty', 'Communication coaching', 'Mock interview practice'] },
          { label: 'Owner', name: 'owner', type: 'select', value: 'Prof. Meera Nair', options: ['Prof. Meera Nair', 'Prof. S. Raman', 'Dr. L. Thomas'] },
          { label: 'Due date', name: 'due', type: 'date', value: '2026-06-05' },
        ]}
        submitLabel="Assign"
        success="Intervention assigned and the student notified (sample)."
        onSubmit={(values) => session.addIntervention({
          student: values['student'] || 'Student',
          action: values['action'] || 'Career counselling session',
          owner: values['owner'] || 'Prof. Meera Nair',
          due: values['due'] || '2026-06-05',
        })} />,
    });
  };
  const reviewIntervention = (row: { readonly student: string; readonly action: string; readonly owner: string; readonly due: string; readonly status: string }): void => {
    overlay.openModal({
      title: row.student, subtitle: 'Intervention review', body: <div>
        <DetailRows rows={[
          ['Intervention', row.action],
          ['Owner', row.owner],
          ['Due', row.due],
          ['Status', row.status],
        ]} />
        <p className="pilot-modal-text" style={{ marginTop: 12 }}>The full review adds session notes, readiness movement since assignment and a completion checklist.</p>
        <div className="pilot-modal-actions">
          <button type="button" className="pilot-btn ghost" onClick={() => { overlay.closeModal(); overlay.toast(`${row.student}: follow-up reminder sent (sample).`); }}>Send Reminder</button>
          <button type="button" className="pilot-btn" onClick={overlay.closeModal}>Done</button>
        </div>
      </div>,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Interventions</h1><p>Structured support for students who need attention before the placement season.</p></div>
        <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); assignIntervention(); }}><Plus size={15} /> Assign Intervention</button>
      </div>

      <div className="pilot-row cols-4">
        {[
          ['Needing Support', pilotCohort.atRisk, 'rose', AlertTriangle], ['Open', 4, 'amber', PenTool],
          ['In Progress', 2, 'blue', TrendingUp], ['Completed This Term', 18, 'green', CheckCircle2],
        ].map(([label, value, tone, Icon]) => (
          <section key={label as string} className="pilot-card pilot-kpi">
            {(() => { const Component = Icon as typeof Users; return <span className={`pilot-tile ${tone as string}`}><Component size={17} /></span>; })()}
            <div><b>{value as number}</b><small>{label as string}</small></div>
          </section>
        ))}
      </div>

      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Student</th><th>Intervention</th><th>Owner</th><th>Due</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {session.createdInterventions.map((created) => (
              <tr key={`${created.student}-${created.action}`}>
                <td><div className="pilot-person">
                  <span className="pilot-avatar">{created.student.split(' ').map((word) => word[0]).join('').slice(0, 2).toUpperCase()}</span>
                  <span><strong>{created.student}</strong><small>Just assigned</small></span>
                </div></td>
                <td>{created.action}</td>
                <td>{created.owner}</td>
                <td><small>{created.due}</small></td>
                <td><span className="pilot-chip purple">New</span></td>
                <td><button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); reviewIntervention({ ...created, status: 'New' }); }}>Review</button></td>
              </tr>
            ))}
            {INTERVENTION_ROWS.map((row) => (
              <tr key={row.student}>
                <td><div className="pilot-person">
                  <span className="pilot-avatar">{row.initials}</span>
                  <span><strong>{row.student}</strong><small>{row.registration}</small></span>
                </div></td>
                <td>{row.action}</td>
                <td>{row.owner}</td>
                <td><small>{row.due}</small></td>
                <td><span className={`pilot-chip ${row.status === 'Completed' ? 'green' : row.status === 'In progress' ? 'blue' : 'amber'}`}>{row.status}</span></td>
                <td><button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); reviewIntervention(row); }}>Review</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Why Interventions Work</h2>
        <div className="pilot-list">
          {[
            '14 of 18 completed interventions lifted readiness above 55.',
            'Aptitude plans show results within three weeks on average.',
            'Counselling first, then a concrete practice plan with a due date.',
          ].map((note) => (
            <div key={note} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <TrendingUp size={15} color="#0d6b4f" style={{ flexShrink: 0 }} />
              <small style={{ color: 'var(--p-ink-2)' }}>{note}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Completion Rate</h2>
        <Ring value={78} size={104} stroke={11} tone="blue" />
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>18 of 23 assigned interventions completed this term</small>
      </section>
    </aside>
  </div>;
}

// --- Employer: Offers ---------------------------------------------------------

const OFFER_ROWS = [
  { candidate: 'Sana Sheikh', initials: 'SS', college: 'Anna University', role: 'Graduate Software Engineer', sent: '18 May', expires: '1 Jun', status: 'Awaiting response', tone: 'amber' },
  { candidate: 'Nikhil Joshi', initials: 'NJ', college: 'NIT Trichy', role: 'Software Engineer', sent: '12 May', expires: 'Accepted 16 May', status: 'Accepted', tone: 'green' },
  { candidate: 'Ananya Das', initials: 'AD', college: 'VIT Chennai', role: 'SDE Intern', sent: '10 May', expires: 'Accepted 14 May', status: 'Accepted', tone: 'green' },
  { candidate: 'Harish Kumar', initials: 'HK', college: 'SRM Chennai', role: 'QA Engineer', sent: '8 May', expires: 'Declined 12 May', status: 'Declined', tone: 'rose' },
  { candidate: 'Meghna Rao', initials: 'MR', college: 'Anna University', role: 'Graduate Software Engineer', sent: 'Draft', expires: '—', status: 'Draft', tone: 'slate' },
] as const;

export function EmployerOffers(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Offers</h1><p>Offers extended this season across your open roles.</p></div>
        <button type="button" className="pilot-btn"><Plus size={15} /> Extend Offer</button>
      </div>

      <div className="pilot-row cols-4">
        {[
          ['Offers Extended', pilotEmployerStats.offersExtended, 'blue', FileText], ['Accepted', pilotEmployerStats.hires, 'green', CheckCircle2],
          ['Awaiting Response', 7, 'amber', CalendarDays], ['Declined', 2, 'rose', AlertTriangle],
        ].map(([label, value, tone, Icon]) => (
          <section key={label as string} className="pilot-card pilot-kpi">
            {(() => { const Component = Icon as typeof Users; return <span className={`pilot-tile ${tone as string}`}><Component size={17} /></span>; })()}
            <div><b>{value as number}</b><small>{label as string}</small></div>
          </section>
        ))}
      </div>

      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Candidate</th><th>Institution</th><th>Role</th><th>Sent</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {OFFER_ROWS.map((offer) => (
              <tr key={offer.candidate}>
                <td><div className="pilot-person">
                  <span className="pilot-avatar">{offer.initials}</span>
                  <span><strong>{offer.candidate}</strong><small>{offer.expires !== '—' ? offer.expires.startsWith('Accepted') || offer.expires.startsWith('Declined') ? offer.expires : `Expires ${offer.expires}` : 'Not sent yet'}</small></span>
                </div></td>
                <td>{offer.college}</td>
                <td>{offer.role}</td>
                <td><small>{offer.sent}</small></td>
                <td><span className={`pilot-chip ${offer.tone}`}>{offer.status}</span></td>
                <td><button type="button" className="pilot-btn ghost small">{offer.status === 'Draft' ? 'Edit Offer' : 'View Offer'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Acceptance Rate</h2>
        <Ring value={Math.round((pilotEmployerStats.hires / pilotEmployerStats.offersExtended) * 100)} size={104} stroke={11} tone="green" />
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>{pilotEmployerStats.hires} accepted of {pilotEmployerStats.offersExtended} offers extended</small>
      </section>
      <section className="pilot-card">
        <h2>Expiring Soon</h2>
        <div className="pilot-list">
          <div className="pilot-list-row" style={{ padding: '8px 2px' }}>
            <span className="pilot-tile amber" style={{ width: 32, height: 32 }}><CalendarDays size={14} /></span>
            <div className="grow"><strong style={{ fontSize: 12.5 }}>Sana Sheikh</strong><small>Offer expires 1 Jun - consider a follow-up</small></div>
          </div>
        </div>
      </section>
    </aside>
  </div>;
}

// --- Employer: Company Profile ------------------------------------------------

export function EmployerCompany(): React.ReactElement {
  const company = pilotEmployerPersona.company;
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Company Profile</h1><p>How {company.name} appears to students and placement cells.</p></div>
        <button type="button" className="pilot-btn ghost"><PenTool size={15} /> Edit Profile</button>
      </div>

      <section className="pilot-card">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`pilot-mark ${company.tone}`} style={{ width: 56, height: 56, fontSize: 17 }}>{company.mark}</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ fontSize: 19 }}>{company.name}</strong>
            <small style={{ color: 'var(--p-muted)', display: 'block', marginTop: 3 }}>Product engineering &amp; cloud platforms · Bengaluru HQ · 850 employees</small>
            <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}>
              <span className="pilot-chip blue">SaaS</span>
              <span className="pilot-chip green">Actively hiring</span>
              <span className="pilot-chip slate">Campus partner since 2025</span>
            </div>
          </div>
        </div>
      </section>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <h2>About</h2>
          <p className="pilot-modal-text">{company.name} builds workflow and analytics platforms used by growing businesses across India. The graduate programme rotates engineers through product, platform and quality teams in their first year, with a dedicated mentor throughout.</p>
          <div className="pilot-detail-rows" style={{ marginTop: 12 }}>
            <div><small>Founded</small><strong>2016</strong></div>
            <div><small>Headquarters</small><strong>Bengaluru</strong></div>
            <div><small>Engineering Offices</small><strong>Bengaluru · Hyderabad · Chennai</strong></div>
            <div><small>Graduate Intake 2027</small><strong>40 planned</strong></div>
          </div>
        </section>
        <section className="pilot-card">
          <h2>Why Students Choose Us</h2>
          <div className="pilot-list">
            {[
              'Structured first-year rotation with a named mentor',
              'Clear promotion path from graduate to engineer in 18 months',
              'Hybrid working: three days in office, two remote',
              'Learning budget for certifications and conferences',
            ].map((point) => (
              <div key={point} className="pilot-list-row" style={{ padding: '8px 2px' }}>
                <CheckCircle2 size={15} color="#0d6b4f" style={{ flexShrink: 0 }} />
                <small style={{ color: 'var(--p-ink-2)' }}>{point}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="pilot-card">
        <h2>Hiring Locations</h2>
        <div className="pilot-row cols-3">
          {[
            ['Bengaluru', '4 open roles'], ['Hyderabad', '1 open role'], ['Chennai', '1 open role'],
          ].map(([city, roles]) => (
            <div key={city} className="pilot-cat">
              <span className="pilot-tile indigo" style={{ width: 32, height: 32 }}><MapPin size={14} /></span>
              <div><strong>{city}</strong><small>{roles}</small></div>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Profile Completeness</h2>
        <Ring value={90} size={104} stroke={11} tone="blue" />
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>Add culture photos to reach 100% and improve drive registrations.</small>
      </section>
      <section className="pilot-card">
        <h2>Campus Presence</h2>
        <div className="pilot-list">
          {[
            ['VIT Chennai', 'Drive on 22 May · 154 registered'],
            ['NIT Trichy', 'Drive on 29 May · 96 registered'],
            ['Anna University', 'Drive on 3 Jun · 72 registered'],
          ].map(([campus, detail]) => (
            <div key={campus} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <span className="pilot-tile blue" style={{ width: 32, height: 32 }}><Building2 size={14} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{campus}</strong><small>{detail}</small></div>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Quick Actions</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}><Download size={15} /> Download Company Deck</button>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}><Users size={15} /> Invite a Teammate</button>
        </div>
      </section>
    </aside>
  </div>;
}
