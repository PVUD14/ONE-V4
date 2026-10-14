import { useState } from 'react';
import { Icon, type IconName } from '../icons/Icon.js';
import { MultiRing, Ring, Spark } from './pilotComponents.js';
import { DetailRows, OverlayForm, downloadCsv, useOverlay } from './pilotOverlay.js';
import { ReportFormatBody } from './pilotShare.js';
import { usePilotSession } from './pilotSession.js';
import {
  pilotCohort, pilotDepartmentReadiness, pilotInstitutionDrives, pilotInterventions,
  pilotOffersTrend, pilotPipelineFunnel, pilotReadinessBands, pilotRoster, pilotRosterAlumni,
  type PilotRosterStudent,
} from './pilotStaffData.js';

/** Institution pilot pages: the placement officer's view of Arjun's college. */

const BAND_TONE: Readonly<Record<string, string>> = {
  'Ready for next step': 'green', Progressing: 'blue', Developing: 'amber', 'Not enough evidence': 'slate',
};

/**
 * One department's placement-eligible students split across the four advisory bands.
 * Readiness is a band, never a number, so departments compare by band counts.
 */
function DepartmentBands({ department }: { readonly department: typeof pilotDepartmentReadiness[number] }): React.ReactElement {
  const parts = [department.ready, department.progressing, department.developing, department.notEnough];
  const total = parts.reduce((sum, value) => sum + value, 0) || 1;
  return <div className="pilot-skill">
    <header><b>{department.label}</b><span>{department.ready} of {total} ready for next step</span></header>
    <div className="pilot-bar" style={{ display: 'flex' }} role="img" aria-label={`${department.label}: ${pilotReadinessBands.map((band, index) => `${parts[index]} ${band.label}`).join(', ')}`}>
      {pilotReadinessBands.map((band, index) => <i key={band.label} style={{ width: `${((parts[index] ?? 0) / total) * 100}%`, background: band.color, borderRadius: 0 }} />)}
    </div>
  </div>;
}

function departmentBandRows(): string[][] {
  return pilotDepartmentReadiness.map((department) => [`${department.label} · ready / progressing / developing / not enough evidence`, `${department.ready} / ${department.progressing} / ${department.developing} / ${department.notEnough}`]);
}

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
  const overlay = useOverlay();
  const session = usePilotSession();
  const exportReport = (): void => {
    overlay.openModal({
      title: 'Export Report', subtitle: 'Placement Dashboard Report', body: <ReportFormatBody
        filenameBase="placement-dashboard-report" title="Placement Dashboard Report"
        rows={[
          ['Metric', 'Value'],
          ['Active students', String(pilotCohort.activeStudents)],
          ['Placement eligible', String(pilotCohort.placementEligible)],
          ['Offers this season', String(pilotCohort.offersThisSeason)],
          ['Students placed', String(pilotCohort.placedSoFar)],
          ...pilotReadinessBands.map((band) => [`Band · ${band.label}`, String(band.value)]),
          ['Need intervention', String(pilotCohort.atRisk)],
          ...departmentBandRows(),
        ]} />,
    });
  };
  const openIntervention = (item: typeof pilotInterventions[number]): void => {
    overlay.openModal({
      title: item.student, subtitle: 'Intervention detail', body: <div>
        <DetailRows rows={[
          ['Intervention', item.action],
          ['Due', item.due.replace('Due ', '')],
          ['Owner', 'Prof. Meera Nair'],
          ['Status', 'Open'],
        ]} />
        <p className="pilot-modal-text" style={{ marginTop: 12 }}>Full history, notes and outcome tracking live on the Interventions page.</p>
        <div className="pilot-modal-actions">
          <button type="button" className="pilot-btn" onClick={() => { overlay.closeModal(); session.navigate('interventions'); }}>Open Interventions</button>
        </div>
      </div>,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Placement Dashboard</h1>
          <p>Cohort readiness, placement activity and the students who need you this week.</p>
        </div>
        <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); exportReport(); }}><Icon name="download" size={16} /> Export Report</button>
      </div>

      <div className="pilot-row cols-5">
        {[
          ['Active Students', pilotCohort.activeStudents, 'blue', 'students'],
          ['Placement Eligible', pilotCohort.placementEligible, 'indigo', 'placement'],
          ['Offers This Season', pilotCohort.offersThisSeason, 'green', 'offers'],
          ['Students Placed', pilotCohort.placedSoFar, 'teal', 'placement'],
          ['Need Intervention', pilotCohort.atRisk, 'rose', 'warning'],
        ].map(([label, value, tone, glyph]) => (
          <section key={label as string} className="pilot-card pilot-kpi">
            <span className={`pilot-tile ${tone as string}`}><Icon name={glyph as IconName} size={16} /></span>
            <div><b>{value as number}</b><small>{label as string}</small></div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Cohort Readiness</h2><small style={{ color: 'var(--p-muted)' }}>{bandTotal} placement-eligible</small></div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <MultiRing segments={pilotReadinessBands.map((band) => ({ value: band.value, color: band.color }))}>
              {bandTotal}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>students</div>
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
        <div className="pilot-card-head"><h2>Students Needing Attention</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); session.navigate('interventions'); }}>View All Interventions</button></div>
        <div className="pilot-list">
          {pilotInterventions.map((item) => (
            <div key={item.student} className="pilot-list-row">
              <span className={`pilot-tile ${item.tone}`}><Icon name="warning" size={16} /></span>
              <div className="grow"><strong>{item.student}</strong><small>{item.action}</small></div>
              <span className="pilot-chip amber">{item.due}</span>
              <button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); openIntervention(item); }}>Review</button>
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
        <div className="pilot-card-head"><h2>Upcoming Drives</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); session.navigate('drives'); }}>View All</button></div>
        <div className="pilot-list">
          {session.createdDrives.slice(0, 2).map((created) => (
            <div key={`${created.company}-${created.date}`} className="pilot-list-row">
              <div className="pilot-date"><b>{created.date.split('-')[2]}</b><span>{['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(created.date.split('-')[1])] ?? ''}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{created.company}</strong><small>{created.role} · {created.mode}</small></div>
              <span className="pilot-chip purple">New</span>
            </div>
          ))}
          {pilotInstitutionDrives.slice(0, 3).map((drive) => (
            <div key={drive.company.name} className="pilot-list-row">
              <div className="pilot-date"><b>{drive.date.split(' ')[0]}</b><span>{drive.date.split(' ')[1]}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{drive.company.name}</strong><small>{drive.role} · {drive.mode}</small></div>
              <Icon name="arrow-right" size={16} style={{ color: "#98a5ba" }} />
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Department Readiness Bands</h2>
        {pilotDepartmentReadiness.map((department) => <DepartmentBands key={department.label} department={department} />)}
      </section>
    </aside>
  </div>;
}

const ROSTER_ISSUES = [
  ['Row 14', 'Duplicate email - already used on row 9'],
  ['Row 51', 'Registration number missing'],
  ['Row 88', 'This email already has a ONE account - invite skipped, student can link it instead'],
] as const;

/**
 * Roster upload as the real application does it: a template, a validation preview
 * that names the rows with problems, then an import that creates invitations.
 * Nothing leaves the browser here; the "file" is a built-in sample.
 */
function RosterUploadBody({ onImported }: { readonly onImported: (count: number) => void }): React.ReactElement {
  const overlay = useOverlay();
  const [stage, setStage] = useState<'choose' | 'preview' | 'done'>('choose');
  if (stage === 'choose') {
    return <div>
      <p className="pilot-modal-text">Upload a CSV with one row per student. ONE checks every row before anything is created, then sends each valid student an invitation to activate their account.</p>
      <DetailRows rows={[['Columns', 'name, email, registration, department, batch'], ['Limit', 'Up to 2,000 rows per file']]} />
      <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="pilot-btn ghost" onClick={() => {
          downloadCsv('roster-template.csv', [['name', 'email', 'registration', 'department', 'batch'], ['Sample Student', 'sample.student@college.example', 'LIT2028-0001', 'CSE', '2028']]);
          overlay.toast('roster-template.csv downloaded.');
        }}><Icon name="download" size={16} /> Download Template</button>
        <button type="button" className="pilot-btn" onClick={() => setStage('preview')}><Icon name="upload" size={16} /> Use sample file: batch-2028-cse.csv</button>
      </div>
    </div>;
  }
  if (stage === 'preview') {
    return <div>
      <div className="pilot-row cols-3" style={{ marginBottom: 12 }}>
        {[['Rows read', '120', 'blue'], ['Ready to import', '117', 'green'], ['Need attention', '3', 'amber']].map(([label, value, tone]) => (
          <div key={label} className="pilot-stat" style={{ border: '1px solid var(--p-line)', borderRadius: 12, padding: '9px 11px' }}>
            <span className={`pilot-tile ${tone}`} style={{ width: 30, height: 30 }}><Icon name="students" size={16} /></span>
            <div><b>{value}</b><small>{label}</small></div>
          </div>
        ))}
      </div>
      <div className="pilot-list">
        {ROSTER_ISSUES.map(([row, issue]) => (
          <div key={row} className="pilot-list-row" style={{ padding: '7px 2px' }}>
            <Icon name="warning" size={16} style={{ color: "#92400e", flexShrink: 0 }} />
            <div className="grow"><strong style={{ fontSize: 12.5 }}>{row}</strong><small>{issue}</small></div>
          </div>
        ))}
      </div>
      <div className="pilot-modal-actions">
        <button type="button" className="pilot-btn ghost" onClick={() => setStage('choose')}>Back</button>
        <button type="button" className="pilot-btn" onClick={() => { setStage('done'); onImported(117); }}>Import 117 &amp; Send Invitations</button>
      </div>
    </div>;
  }
  return <div>
    <div className="pilot-banner"><Icon name="check" size={16} /> 117 students added to Batch 2028 · CSE. Invitations are on their way.</div>
    <p className="pilot-modal-text" style={{ marginTop: 12 }}>Each student appears as <strong>Invited</strong> until they open the link and activate their account. Fix the 3 flagged rows and upload them again whenever you are ready.</p>
    <div className="pilot-modal-actions"><button type="button" className="pilot-btn" onClick={overlay.closeModal}>Done</button></div>
  </div>;
}

export function InstitutionStudents(): React.ReactElement {
  const overlay = useOverlay();
  const [batch, setBatch] = useState<'All' | '2027' | '2026'>('2027');
  const [invited, setInvited] = useState(0);
  const allStudents = [...pilotRoster, ...pilotRosterAlumni];
  const visible = batch === 'All' ? allStudents : allStudents.filter((student) => student.batch === batch);
  const exportStudents = (): void => {
    downloadCsv(`students-batch-${batch.toLowerCase()}.csv`, [
      ['Student', 'Registration', 'Department', 'Batch', 'Readiness band', 'Placement status'],
      ...visible.map((student) => [student.name, student.registration, student.department, student.batch, student.band, student.status]),
    ]);
    overlay.toast(`students-batch-${batch.toLowerCase()}.csv downloaded (${visible.length} students, sample data).`);
  };
  const viewStudent = (student: PilotRosterStudent): void => {
    overlay.openModal({
      title: student.name, subtitle: `${student.registration} · ${student.department} · Batch ${student.batch}`, body: <div>
        <DetailRows rows={[
          ['Readiness band', student.band],
          ['Placement status', student.status],
          ['Department', student.department],
        ]} />
        <p className="pilot-modal-text" style={{ marginTop: 12 }}>The full profile shows assessment history, applications and intervention notes.</p>
      </div>,
    });
  };
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Students</h1><p>Placement-eligible students with their advisory readiness band and current placement activity.</p></div>
        <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
          <label className="pilot-inline-filter">
            <span>Batch</span>
            <select value={batch} onChange={(event) => setBatch(event.target.value as typeof batch)} onClick={(event) => event.stopPropagation()}>
              <option>2027</option>
              <option>2026</option>
              <option>All</option>
            </select>
          </label>
          <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); exportStudents(); }}><Icon name="download" size={16} /> Export</button>
          <button type="button" className="pilot-btn" onClick={(event) => {
            event.stopPropagation();
            overlay.openModal({ title: 'Upload Roster', subtitle: 'Add a batch of students from a CSV file', body: <RosterUploadBody onImported={setInvited} /> });
          }}><Icon name="upload" size={16} /> Upload Roster</button>
        </div>
      </div>
      {invited > 0 ? <div className="pilot-banner blue"><Icon name="students" size={16} /> Batch 2028 · CSE: {invited} students invited, 0 activated so far. They join this list as they activate.</div> : null}
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Student</th><th>Department</th><th>Readiness Band</th><th>Placement Status</th><th></th></tr></thead>
          <tbody>
            {visible.map((student) => (
              <tr key={student.registration}>
                <td><div className="pilot-person">
                  <span className="pilot-avatar">{student.initials}</span>
                  <span><strong>{student.name}</strong><small>{student.registration} · Batch {student.batch}</small></span>
                </div></td>
                <td>{student.department}</td>
                <td><span className={`pilot-chip ${BAND_TONE[student.band]}`}>{student.band}</span></td>
                <td><small style={{ color: 'var(--p-ink-2)' }}>{student.status}</small></td>
                <td><button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); viewStudent(student); }}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function InstitutionDrives(): React.ReactElement {
  const overlay = useOverlay();
  const session = usePilotSession();
  const scheduleDrive = (): void => {
    overlay.openModal({
      title: 'Schedule Drive', subtitle: 'Adds the drive to this season', body: <OverlayForm
        fields={[
          { label: 'Company', name: 'company', type: 'select', value: 'Zenvia Labs', options: ['Zenvia Labs', 'Kortex Systems', 'BlueRiver Analytics', 'Nimbus Digital', 'Orbitech Solutions', 'Veridian Tech'] },
          { label: 'Role(s)', name: 'role', placeholder: 'e.g. Graduate Engineer Trainee' },
          { label: 'Date', name: 'date', type: 'date', value: '2026-06-20' },
          { label: 'Mode', name: 'mode', type: 'select', value: 'On campus', options: ['On campus', 'Online', 'Hybrid'] },
          { label: 'Eligible cohort', name: 'eligible', type: 'select', value: 'All placement-eligible (412)', options: ['All placement-eligible (412)', 'CSE + IT (238)', 'Final year only (186)'] },
        ]}
        submitLabel="Schedule Drive"
        success="Drive scheduled - it is now in the Placement Drives list (sample)."
        onSubmit={(values) => session.addDrive({
          company: values['company'] ?? 'Zenvia Labs',
          role: values['role'] || 'Graduate Engineer Trainee',
          date: values['date'] ?? '2026-06-20',
          mode: values['mode'] ?? 'On campus',
          eligible: values['eligible']?.includes('CSE') ? 238 : values['eligible']?.includes('Final') ? 186 : 412,
        })} />,
    });
  };
  const manageDrive = (drive: typeof pilotInstitutionDrives[number]): void => {
    overlay.openModal({
      title: `${drive.company.name} — ${drive.role}`, subtitle: 'Drive management', body: <div>
        <DetailRows rows={[
          ['Date', drive.date],
          ['Mode', drive.mode],
          ['Stage', drive.stage],
          ['Eligible students', String(drive.eligible)],
          ['Registered', `${drive.registered} (${Math.round((drive.registered / drive.eligible) * 100)}%)`],
          ['Not yet registered', String(drive.eligible - drive.registered)],
        ]} />
        <p className="pilot-modal-text" style={{ marginTop: 12 }}>Full management covers eligibility criteria, registration reminders, panel schedules and result publishing.</p>
        <div className="pilot-modal-actions">
          <button type="button" className="pilot-btn ghost" onClick={() => { overlay.closeModal(); overlay.toast(`Registration reminder sent to ${drive.eligible - drive.registered} students (sample).`); }}>Send Reminder</button>
          <button type="button" className="pilot-btn" onClick={overlay.closeModal}>Done</button>
        </div>
      </div>,
    });
  };
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Placement Drives</h1><p>Company visits, eligibility and registration for the 2027 season.</p></div>
        <button type="button" className="pilot-btn" onClick={(event) => { event.stopPropagation(); scheduleDrive(); }}><Icon name="calendar-small" size={16} /> Schedule Drive</button>
      </div>
      <section className="pilot-card">
        <div className="pilot-table-wrap"><table className="pilot-table">
          <thead><tr><th>Company</th><th>Roles</th><th>Date</th><th>Mode</th><th>Eligible</th><th>Registered</th><th>Stage</th><th></th></tr></thead>
          <tbody>
            {session.createdDrives.map((created) => (
              <tr key={`${created.company}-${created.role}-${created.date}`}>
                <td><div className="pilot-person">
                  <span className="pilot-mark slate" style={{ width: 34, height: 34, fontSize: 11.5 }}>{created.company.split(' ').map((word) => word[0]).join('').slice(0, 2).toUpperCase()}</span>
                  <strong>{created.company}</strong>
                </div></td>
                <td>{created.role}</td>
                <td>{created.date}</td>
                <td>{created.mode}</td>
                <td>{created.eligible}</td>
                <td><small style={{ color: 'var(--p-muted)' }}>Opens soon</small></td>
                <td><span className="pilot-chip purple">Just scheduled</span></td>
                <td><button type="button" className="pilot-btn ghost small">Manage</button></td>
              </tr>
            ))}
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
                <td><button type="button" className="pilot-btn ghost small" onClick={(event) => { event.stopPropagation(); manageDrive(drive); }}>Manage</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>
    </div>
  </div>;
}

export function InstitutionReports(): React.ReactElement {
  const overlay = useOverlay();
  const downloadReport = (): void => {
    overlay.openModal({
      title: 'Download Report', subtitle: 'Placement Season Report', body: <ReportFormatBody
        filenameBase="placement-season-report" title="Placement Season Report"
        rows={[
          ['Metric', 'Value'],
          ...pilotPipelineFunnel.map((row) => [`Pipeline · ${row.label}`, String(row.value)]),
          ...departmentBandRows(),
          ['Placement rate', `${Math.round((pilotCohort.placedSoFar / pilotCohort.placementEligible) * 100)}%`],
          ['Offers this season', String(pilotCohort.offersThisSeason)],
        ]} />,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Reports</h1><p>Placement outcomes and readiness for management and accreditation reviews.</p></div>
        <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); downloadReport(); }}><Icon name="download" size={16} /> Download Report</button>
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
        <div className="pilot-card-head"><h2>Readiness Bands by Department</h2><small style={{ color: 'var(--p-muted)' }}>Advisory bands · never a score</small></div>
        <div className="pilot-two">
          {pilotDepartmentReadiness.map((department) => <DepartmentBands key={department.label} department={department} />)}
        </div>
        <div className="pilot-legend" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
          {pilotReadinessBands.map((band) => <div key={band.label}><i style={{ background: band.color }} /> {band.label}</div>)}
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
            '52 CSE students now ready for next step',
            '4 new companies visiting this season',
          ].map((highlight) => (
            <div key={highlight} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <Icon name="analytics" size={16} style={{ color: "#0d6b4f" }} />
              <small style={{ color: 'var(--p-ink-2)' }}>{highlight}</small>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}
