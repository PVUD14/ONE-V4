import { useState } from 'react';
import { Icon, type IconName } from '../icons/Icon.js';
import { MultiRing } from './pilotComponents.js';
import { DetailRows, OverlayForm, listModal, useOverlay } from './pilotOverlay.js';
import { usePilotSession } from './pilotSession.js';
import {
  pilotApplicants, pilotCampusDrives, pilotEmployerFunnel, pilotEmployerInterviews,
  pilotEmployerPersona, pilotEmployerRoles, pilotEmployerStats, sharedEvidenceFor, type PilotApplicant,
} from './pilotStaffData.js';

/** Employer pilot pages: the talent lead's view at Zenvia Labs. */

const STAGE_TONE: Readonly<Record<string, string>> = {
  Applied: 'slate', Screening: 'blue', Shortlisted: 'indigo',
  Assessment: 'amber', Interview: 'purple', Offer: 'green',
};

const STAGE_FLOW = ['Applied', 'Screening', 'Shortlisted', 'Assessment', 'Interview', 'Offer'] as const;

/** Shared "Post a Role" flow: the submitted role appears in the Opportunities table. */
function usePostRole(): () => void {
  const overlay = useOverlay();
  const session = usePilotSession();
  return () => overlay.openModal({
    title: 'Post a Role', subtitle: `${pilotEmployerPersona.company.name} · new opening`, body: <OverlayForm
      fields={[
        { label: 'Role title', name: 'title', placeholder: 'e.g. Data Engineer' },
        { label: 'Location', name: 'location', type: 'select', value: 'Bengaluru', options: ['Bengaluru', 'Hyderabad', 'Chennai', 'Remote'] },
        { label: 'Type', name: 'type', type: 'select', value: 'Full-time', options: ['Full-time', 'Internship', 'Contract'] },
        { label: 'Visibility', name: 'visibility', type: 'select', value: 'Publish now', options: ['Publish now', 'Save as draft'] },
      ]}
      submitLabel="Post Role"
      success="Role posted - it is now in your Opportunities list (sample)."
      onSubmit={(values) => session.addRole({
        title: values['title'] || 'Untitled Role',
        location: values['location'] || 'Bengaluru',
        type: values['type'] || 'Full-time',
        status: values['visibility'] === 'Save as draft' ? 'Draft' : 'Live',
      })} />,
  });
}

function Funnel({ rows }: { readonly rows: readonly { readonly label: string; readonly value: number }[] }): React.ReactElement {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return <div className="pilot-funnel">
    {rows.map((row) => (
      <div key={row.label} className="pilot-funnel-row">
        <span>{row.label}</span>
        <div className="pilot-bar indigo"><i style={{ width: `${(row.value / max) * 100}%` }} /></div>
        <span className="num">{row.value}</span>
      </div>
    ))}
  </div>;
}

export function EmployerDashboard(): React.ReactElement {
  const overlay = useOverlay();
  const session = usePilotSession();
  const postRole = usePostRole();
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Recruiter Dashboard</h1>
          <p>Your open roles, pipeline health and the interviews coming up this week.</p>
        </div>
        <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); postRole(); }}><Icon name="plus" size={16} /> Post a Role</button>
      </div>

      <div className="pilot-row cols-5">
        {[
          ['Open Roles', pilotEmployerStats.openRoles, 'blue', 'opportunities'],
          ['Total Applicants', pilotEmployerStats.totalApplicants, 'indigo', 'applicants'],
          ['In Pipeline', pilotEmployerStats.inPipeline, 'purple', 'pipeline'],
          ['Offers Extended', pilotEmployerStats.offersExtended, 'amber', 'offers'],
          ['Hires', pilotEmployerStats.hires, 'green', 'placement'],
        ].map(([label, value, tone, glyph]) => (
          <section key={label as string} className="pilot-card pilot-kpi">
            <span className={`pilot-tile ${tone as string}`}><Icon name={glyph as IconName} size={16} /></span>
            <div><b>{value as number}</b><small>{label as string}</small></div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Hiring Funnel</h2><small style={{ color: 'var(--p-muted)' }}>All roles · this season</small></div>
          <Funnel rows={pilotEmployerFunnel} />
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>This Week&apos;s Interviews</h2><button type="button" className="pilot-link">View Calendar</button></div>
          <div className="pilot-list">
            {pilotEmployerInterviews.map((interview) => (
              <div key={`${interview.candidate}-${interview.when}`} className="pilot-list-row">
                <span className="pilot-tile purple"><Icon name="meetings" size={16} /></span>
                <div className="grow"><strong>{interview.candidate}</strong><small>{interview.round} · {interview.role}</small></div>
                <small>{interview.when}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recently Shortlisted</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); session.navigate('applicants'); }}>Open Applicants</button></div>
        <div className="pilot-list">
          {pilotApplicants.filter((applicant) => applicant.stage === 'Shortlisted' || applicant.stage === 'Interview').map((applicant) => (
            <div key={applicant.name} className="pilot-list-row">
              <span className="pilot-avatar" style={{ width: 34, height: 34, fontSize: 11.5 }}>{applicant.initials}</span>
              <div className="grow"><strong>{applicant.name}</strong><small>{applicant.college} · {applicant.roleApplied}</small></div>
              {applicant.highlight ? <small style={{ color: 'var(--p-ink-2)' }}>{applicant.highlight}</small> : null}
              <span className={`pilot-chip ${STAGE_TONE[applicant.stage]}`}>{applicant.stage}</span>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Pipeline Mix</h2><small style={{ color: 'var(--p-muted)' }}>Active candidates</small></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: 45, color: '#1f55e5' }, { value: 24, color: '#4f46e5' },
            { value: 15, color: '#b45309' }, { value: 8, color: '#5936cf' },
          ]}>{pilotEmployerStats.inPipeline}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>In pipeline</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#1f55e5' }} /> Screening <span className="num">45</span></div>
            <div><i style={{ background: '#4f46e5' }} /> Shortlisted <span className="num">24</span></div>
            <div><i style={{ background: '#b45309' }} /> Assessment <span className="num">15</span></div>
            <div><i style={{ background: '#5936cf' }} /> Interview <span className="num">8</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Campus Drives</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); overlay.openModal(listModal('Campus Drives', `${pilotCampusDrives.length} scheduled this season`, pilotCampusDrives.map((drive) => ({ title: drive.institution, detail: `${drive.role} · ${drive.registered} registered`, trailing: drive.date })))); }}>View All</button></div>
        <div className="pilot-list">
          {pilotCampusDrives.map((drive) => (
            <div key={drive.institution} className="pilot-list-row">
              <div className="pilot-date"><b>{drive.date.split(' ')[0]}</b><span>{drive.date.split(' ')[1]}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{drive.institution}</strong><small>{drive.role} · {drive.registered} registered</small></div>
              <Icon name="arrow-right" size={16} style={{ color: "#98a5ba" }} />
            </div>
          ))}
        </div>
      </section>
      <div className="pilot-banner blue"><Icon name="analytics" size={16} /> Applications up 32% since the Lakeview drive was announced.</div>
    </aside>
  </div>;
}

export function EmployerOpportunities(): React.ReactElement {
  const session = usePilotSession();
  const postRole = usePostRole();
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Opportunities</h1><p>Roles {pilotEmployerPersona.company.name} is hiring for this season.</p></div>
        <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); postRole(); }}><Icon name="plus" size={16} /> Post a Role</button>
      </div>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Role</th><th>Location</th><th>Type</th><th>Applicants</th><th>Shortlisted</th><th>Current Stage</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {session.postedRoles.map((posted) => (
              <tr key={`${posted.title}-${posted.location}`}>
                <td><strong>{posted.title}</strong><small style={{ display: 'block', color: 'var(--p-muted)' }}>Posted just now</small></td>
                <td>{posted.location}</td>
                <td>{posted.type}</td>
                <td><b>0</b></td>
                <td>0</td>
                <td><small>{posted.status === 'Live' ? 'Applications open' : 'Not published'}</small></td>
                <td><span className={`pilot-chip ${posted.status === 'Live' ? 'green' : 'slate'}`}>{posted.status}</span></td>
                <td><button type="button" className="pilot-btn ghost small">Manage</button></td>
              </tr>
            ))}
            {pilotEmployerRoles.map((role) => (
              <tr key={role.title}>
                <td><strong>{role.title}</strong><small style={{ display: 'block', color: 'var(--p-muted)' }}>{role.posted}</small></td>
                <td>{role.location}</td>
                <td>{role.type}</td>
                <td><b>{role.applicants}</b></td>
                <td>{role.shortlisted}</td>
                <td><small>{role.stage}</small></td>
                <td><span className={`pilot-chip ${role.status === 'Live' ? 'green' : role.status === 'Closing soon' ? 'amber' : 'slate'}`}>{role.status}</span></td>
                <td><button type="button" className="pilot-btn ghost small">Manage</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function EmployerApplicants(): React.ReactElement {
  const overlay = useOverlay();
  // Advancing a candidate moves them through the real stage flow, so a client
  // can watch the chip change live. Session-local; the sample data resets on reload.
  const [stages, setStages] = useState<Readonly<Record<string, PilotApplicant['stage']>>>({});
  const stageOf = (applicant: PilotApplicant): PilotApplicant['stage'] => stages[applicant.name] ?? applicant.stage;

  const advance = (applicant: PilotApplicant): void => {
    const current = stageOf(applicant);
    const index = STAGE_FLOW.indexOf(current);
    if (index < 0 || index >= STAGE_FLOW.length - 1) return;
    const next = STAGE_FLOW[index + 1]!;
    setStages((previous) => ({ ...previous, [applicant.name]: next }));
    overlay.toast(`${applicant.name} advanced to ${next} (sample).`);
  };

  const showProfile = (applicant: PilotApplicant): void => {
    overlay.openModal({
      title: applicant.name,
      subtitle: `${applicant.college} · ${applicant.roleApplied}`,
      body: <div>
        <DetailRows rows={[
          ['Current stage', stageOf(applicant)],
          ['Applied', applicant.appliedWhen.replace('Applied ', '')],
          ['Institution', applicant.college],
          ['Role', applicant.roleApplied],
        ]} />
        {applicant.highlight ? <p className="pilot-modal-text" style={{ marginTop: 12 }}><strong>Recruiter note:</strong> {applicant.highlight}</p> : null}
        <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Skill evidence shared with consent</h3>
        <div className="pilot-list">
          {sharedEvidenceFor(applicant.name).map((evidence) => (
            <div key={evidence.item} className="pilot-list-row" style={{ padding: '7px 2px' }}>
              <Icon name="check" size={16} style={{ color: "#0d6b4f", flexShrink: 0 }} />
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{evidence.item}</strong><small>{evidence.verifiedBy}</small></div>
            </div>
          ))}
        </div>
        <p className="pilot-modal-text" style={{ marginTop: 10 }}><Icon name="eye-off" size={16} style={{ verticalAlign: '-2px' }} /> {applicant.name.split(' ')[0]} chose what to share when applying. Readiness bands, marks they did not share and counselling notes are never visible to employers.</p>
      </div>,
    });
  };

  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Applicants</h1><p>Candidates across your open roles, by pipeline stage.</p></div>
        <div style={{ display: 'flex', gap: 9 }}>
          <button type="button" className="pilot-btn ghost">Filter: All Roles</button>
          <button type="button" className="pilot-btn ghost">Stage: All</button>
        </div>
      </div>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Candidate</th><th>Institution</th><th>Role</th><th>Stage</th><th>Applied</th><th></th></tr></thead>
          <tbody>
            {pilotApplicants.map((applicant) => {
              const stage = stageOf(applicant);
              return (
                <tr key={applicant.name}>
                  <td><div className="pilot-person">
                    <span className="pilot-avatar">{applicant.initials}</span>
                    <span><strong>{applicant.name}</strong>{applicant.highlight ? <small>{applicant.highlight}</small> : null}</span>
                  </div></td>
                  <td>{applicant.college}</td>
                  <td>{applicant.roleApplied}</td>
                  <td><span className={`pilot-chip ${STAGE_TONE[stage]}`}>{stage}</span></td>
                  <td><small>{applicant.appliedWhen}</small></td>
                  <td><div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
                    <button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); showProfile(applicant); }}>Profile</button>
                    <button type="button" className="pilot-btn small" disabled={stage === 'Offer'}
                      onClick={(event) => { event.stopPropagation(); advance(applicant); }}>{stage === 'Offer' ? 'Offer Sent' : 'Advance'}</button>
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function EmployerInterviews(): React.ReactElement {
  const overlay = useOverlay();
  // Rescheduling updates the row in place - session-local, resets on reload.
  const [times, setTimes] = useState<Readonly<Record<string, string>>>({});
  const reschedule = (interview: typeof pilotEmployerInterviews[number]): void => {
    overlay.openModal({
      title: `Reschedule — ${interview.candidate}`, subtitle: `${interview.round} · currently ${times[interview.candidate] ?? interview.when}`, body: <OverlayForm
        fields={[
          { label: 'Date', name: 'date', type: 'date', value: '2026-05-27' },
          { label: 'Time', name: 'time', type: 'time', value: '15:00' },
          { label: 'Mode', name: 'mode', type: 'select', value: interview.mode, options: ['Video', 'Phone', 'In person'] },
        ]}
        submitLabel="Confirm New Slot"
        success={`${interview.candidate}'s interview rescheduled and both sides notified (sample).`}
        onSubmit={(values) => {
          const [, month = '05', day = '27'] = (values['date'] ?? '').split('-');
          const time = values['time'] ?? '15:00';
          const [rawHour = '15', minute = '00'] = time.split(':');
          const hour = Number(rawHour);
          const formatted = `${day} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month)] ?? 'May'}, ${String(hour % 12 || 12).padStart(2, '0')}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
          setTimes((previous) => ({ ...previous, [interview.candidate]: formatted }));
        }} />,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Interviews</h1><p>Scheduled rounds across your roles.</p></div>
        <button type="button" className="pilot-btn ghost"><Icon name="calendar-small" size={16} /> Sync Calendar</button>
      </div>
      <section className="pilot-card">
        <div className="pilot-list">
          {pilotEmployerInterviews.map((interview) => (
            <div key={`${interview.candidate}-${interview.when}`} className="pilot-list-row">
              <span className="pilot-tile purple"><Icon name="meetings" size={16} /></span>
              <div className="grow"><strong>{interview.candidate}</strong><small>{interview.round} · {interview.role} · {interview.mode}</small></div>
              {times[interview.candidate] ? <span className="pilot-chip purple">{times[interview.candidate]}</span> : <small>{interview.when}</small>}
              <button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); reschedule(interview); }}>Reschedule</button>
              <button type="button" className="pilot-btn small">Join</button>
            </div>
          ))}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <h2>Interview Load This Week</h2>
        <div className="pilot-legend">
          <div><i style={{ background: '#5936cf' }} /> Technical rounds <span className="num">6</span></div>
          <div><i style={{ background: '#1f55e5' }} /> Screening calls <span className="num">4</span></div>
          <div><i style={{ background: '#0d6b4f' }} /> Final rounds <span className="num">2</span></div>
        </div>
      </section>
      <section className="pilot-card">
        <h2>Panel Availability</h2>
        <p style={{ margin: 0, color: 'var(--p-muted)', fontSize: 12.5 }}>3 interviewers free on Thursday afternoon. Friday is fully booked.</p>
      </section>
    </aside>
  </div>;
}
