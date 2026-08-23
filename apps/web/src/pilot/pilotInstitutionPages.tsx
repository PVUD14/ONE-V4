import { AlertTriangle, ArrowRight, Building2, CalendarDays, ClipboardCheck, Download, TrendingUp, Users } from 'lucide-react';
import { MultiRing, Ring, Spark } from './pilotComponents.js';
import {
  pilotCohort, pilotDepartmentReadiness, pilotInstitutionDrives, pilotInterventions,
  pilotOffersTrend, pilotPipelineFunnel, pilotReadinessBands, pilotRoster,
} from './pilotStaffData.js';

/** Institution pilot pages: the placement officer's view of Arjun's college. */

const BAND_TONE: Readonly<Record<string, string>> = {
  Ready: 'green', Progressing: 'blue', Developing: 'amber', 'At risk': 'rose',
};

function Funnel({ rows }: { readonly rows: readonly { readonly label: string; readonly value: number }[] }): React.ReactElement {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return <div className="pilot-funnel">
    {rows.map((row) => (
      <div key={row.label} className="pilot-funnel-row">
        <span>{row.label}</span>
        <div className="pilot-bar"><i style={{ width: `${(row.value / max) * 100}%` }} /></div>
        <span className="num">{row.value}</span>
      </div>
    ))}
  </div>;
}

export function InstitutionDashboard(): React.ReactElement {
  const bandTotal = pilotReadinessBands.reduce((sum, band) => sum + band.value, 0);
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Placement Dashboard</h1>
          <p>Cohort readiness, placement activity and the students who need you this week.</p>
        </div>
        <button type="button" className="pilot-btn ghost"><Download size={15} /> Export Report</button>
      </div>

      <div className="pilot-row cols-5">
        {[
          ['Active Students', pilotCohort.activeStudents, 'blue', Users],
          ['Placement Eligible', pilotCohort.placementEligible, 'indigo', ClipboardCheck],
          ['Offers This Season', pilotCohort.offersThisSeason, 'green', TrendingUp],
          ['Students Placed', pilotCohort.placedSoFar, 'teal', Building2],
          ['Need Intervention', pilotCohort.atRisk, 'rose', AlertTriangle],
        ].map(([label, value, tone, Icon]) => (
          <section key={label as string} className="pilot-card pilot-kpi">
            {(() => { const Component = Icon as typeof Users; return <span className={`pilot-tile ${tone as string}`}><Component size={17} /></span>; })()}
            <div><b>{value as number}</b><small>{label as string}</small></div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Cohort Readiness</h2><small style={{ color: 'var(--p-muted)' }}>{bandTotal} placement-eligible</small></div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <MultiRing segments={pilotReadinessBands.map((band) => ({ value: band.value, color: band.color }))}>
              {pilotCohort.averageReadiness}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Avg readiness</div>
            </MultiRing>
            <div className="pilot-legend" style={{ flex: 1 }}>
              {pilotReadinessBands.map((band) => (
                <div key={band.label}><i style={{ background: band.color }} /> {band.label} <span className="num">{band.value}</span></div>
              ))}
            </div>
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Placement Pipeline</h2><small style={{ color: 'var(--p-muted)' }}>This season</small></div>
          <Funnel rows={pilotPipelineFunnel} />
        </section>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Students Needing Attention</h2><button type="button" className="pilot-link">View All Interventions</button></div>
        <div className="pilot-list">
          {pilotInterventions.map((item) => (
            <div key={item.student} className="pilot-list-row">
              <span className={`pilot-tile ${item.tone}`}><AlertTriangle size={16} /></span>
              <div className="grow"><strong>{item.student}</strong><small>{item.action}</small></div>
              <span className="pilot-chip amber">{item.due}</span>
              <button type="button" className="pilot-btn ghost small">Review</button>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Offers Trend</h2><span className="pilot-chip green">+19 this month</span></div>
        <Spark points={pilotOffersTrend} tone="green" />
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Drives</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {pilotInstitutionDrives.slice(0, 3).map((drive) => (
            <div key={drive.company.name} className="pilot-list-row">
              <div className="pilot-date"><b>{drive.date.split(' ')[0]}</b><span>{drive.date.split(' ')[1]}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{drive.company.name}</strong><small>{drive.role} · {drive.mode}</small></div>
              <ArrowRight size={14} color="#98a5ba" />
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Department Readiness</h2>
        {pilotDepartmentReadiness.map((department) => (
          <div key={department.label} className="pilot-skill">
            <header><b>{department.label}</b><span>{department.value}%</span></header>
            <div className="pilot-bar thin"><i style={{ width: `${department.value}%` }} /></div>
          </div>
        ))}
      </section>
    </aside>
  </div>;
}

export function InstitutionStudents(): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Students</h1><p>Placement-eligible students with readiness and current placement activity.</p></div>
        <div style={{ display: 'flex', gap: 9 }}>
          <button type="button" className="pilot-btn ghost">Filter: 2027 Batch</button>
          <button type="button" className="pilot-btn ghost"><Download size={15} /> Export</button>
        </div>
      </div>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Student</th><th>Department</th><th>Readiness</th><th>Band</th><th>Placement Status</th><th></th></tr></thead>
          <tbody>
            {pilotRoster.map((student) => (
              <tr key={student.registration}>
                <td><div className="pilot-person">
                  <span className="pilot-avatar">{student.initials}</span>
                  <span><strong>{student.name}</strong><small>{student.registration} · Batch {student.batch}</small></span>
                </div></td>
                <td>{student.department}</td>
                <td style={{ minWidth: 140 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="pilot-bar thin" style={{ flex: 1 }}><i style={{ width: `${student.readiness}%` }} /></div>
                    <b>{student.readiness}</b>
                  </div>
                </td>
                <td><span className={`pilot-chip ${BAND_TONE[student.band]}`}>{student.band}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{student.status}</small></td>
                <td><button type="button" className="pilot-btn ghost small">View</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function InstitutionDrives(): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Placement Drives</h1><p>Company visits, eligibility and registration for the 2027 season.</p></div>
        <button type="button" className="pilot-btn"><CalendarDays size={15} /> Schedule Drive</button>
      </div>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Company</th><th>Roles</th><th>Date</th><th>Mode</th><th>Eligible</th><th>Registered</th><th>Stage</th><th></th></tr></thead>
          <tbody>
            {pilotInstitutionDrives.map((drive) => (
              <tr key={drive.company.name}>
                <td><div className="pilot-person">
                  <span className={`pilot-mark ${drive.company.tone}`} style={{ width: 34, height: 34, fontSize: 11.5 }}>{drive.company.mark}</span>
                  <strong>{drive.company.name}</strong>
                </div></td>
                <td>{drive.role}</td>
                <td>{drive.date}</td>
                <td>{drive.mode}</td>
                <td>{drive.eligible}</td>
                <td style={{ minWidth: 130 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="pilot-bar thin green" style={{ flex: 1 }}><i style={{ width: `${Math.round((drive.registered / drive.eligible) * 100)}%` }} /></div>
                    <b>{drive.registered}</b>
                  </div>
                </td>
                <td><span className="pilot-chip blue">{drive.stage}</span></td>
                <td><button type="button" className="pilot-btn ghost small">Manage</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function InstitutionReports(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Reports</h1><p>Placement outcomes and readiness for management and accreditation reviews.</p></div>
        <button type="button" className="pilot-btn ghost"><Download size={15} /> Download PDF</button>
      </div>
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Offers This Season</h2><span className="pilot-chip green">{pilotCohort.offersThisSeason} total</span></div>
          <Spark points={pilotOffersTrend} tone="green" height={140} />
        </section>
        <section className="pilot-card">
          <h2>Season Pipeline</h2>
          <Funnel rows={pilotPipelineFunnel} />
        </section>
      </div>
      <section className="pilot-card">
        <h2>Readiness by Department</h2>
        <div className="pilot-two">
          {pilotDepartmentReadiness.map((department) => (
            <div key={department.label} className="pilot-skill">
              <header><b>{department.label}</b><span>{department.value}% average readiness</span></header>
              <div className="pilot-bar"><i style={{ width: `${department.value}%` }} /></div>
            </div>
          ))}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Placement Rate</h2>
        <Ring value={Math.round((pilotCohort.placedSoFar / pilotCohort.placementEligible) * 100)} size={104} stroke={11} tone="green" />
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>{pilotCohort.placedSoFar} of {pilotCohort.placementEligible} eligible students placed</small>
      </section>
      <section className="pilot-card">
        <h2>Highlights</h2>
        <div className="pilot-list">
          {[
            'Offers up 24% on last season',
            'CSE readiness crossed 70% average',
            '4 new companies visiting this season',
          ].map((highlight) => (
            <div key={highlight} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <TrendingUp size={15} color="#0d6b4f" />
              <small style={{ color: 'var(--p-ink-2)' }}>{highlight}</small>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}
