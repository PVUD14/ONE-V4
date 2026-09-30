import { BarChart3, CalendarDays, CheckCircle2, MessageSquare, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthStatus } from './auth.js';
import type { ApiHealth } from './api.js';
import { staffBasePath, staffNavItems, type StaffRouteKey } from './staffConfig.js';
import { MiniActionButton, MoreButton, StaffKpiCard, StaffPageHeader, StaffPreviewBadge, StaffSection, StaffShell } from './staffComponents.js';
import { actionCards, announcements, attentionStudents, departmentReadiness, placementIdentity, placementPipeline, placementTrend, quickActions, readinessDistribution, readinessTrend, skillGaps, staffKpis, topRecruiters, upcomingInterviews } from './staffData.js';
import { StaffPreviewProvider, useStaffPreviewState, type StaffPreviewRecord } from './staffPreviewState.js';

type Row = Record<string, string | number>;

const staffRouteTitle: Record<StaffRouteKey, string> = {
  dashboard: 'Placement Dashboard',
  students: 'Students',
  departments: 'Departments',
  batches: 'Batches',
  'student-search': 'Student Search',
  readiness: 'Readiness',
  assessments: 'Assessments',
  interventions: 'Interventions',
  opportunities: 'Opportunities',
  applications: 'Applications',
  interviews: 'Interviews',
  offers: 'Offers',
  employers: 'Employers',
  communications: 'Communications',
  events: 'Events',
  reports: 'Reports',
  dashboards: 'Dashboards',
};

const routeAction: Record<Exclude<StaffRouteKey, 'dashboard'>, string> = {
  students: 'Edit placement status',
  departments: 'Edit coordinator',
  batches: 'Edit cycle settings',
  'student-search': 'Add to cohort',
  readiness: 'Create intervention',
  assessments: 'Create assessment',
  interventions: 'Create intervention',
  opportunities: 'Recommend to cohort',
  applications: 'Add coordination note',
  interviews: 'Schedule mock interview',
  offers: 'Verify received',
  employers: 'Add relationship note',
  communications: 'Compose announcement',
  events: 'Create event',
  reports: 'Generate preview',
  dashboards: 'Create saved view',
};

const pageContent: Record<Exclude<StaffRouteKey, 'dashboard'>, { title: string; description: string; metrics: readonly string[]; workflow: string; rows: readonly Row[] }> = {
  students: { title: 'Students', description: 'Roster of placement-eligible students with readiness, risk, department, batch and intervention state.', metrics: ['4,286 total students', '1,084 placement eligible', '269 need intervention'], workflow: 'View student opens the student readiness presentation; Assign routes to intervention planning.', rows: attentionStudents.map((s) => ({ Student: s.name, Department: s.department, Batch: s.batch, Readiness: `${s.readiness}%`, Risk: s.readiness < 50 ? 'High' : 'Watch', Intervention: s.intervention })) },
  departments: { title: 'Departments', description: 'Department metrics, readiness comparison, placement performance and skill-gap concentration.', metrics: ['5 departments', '68% average readiness', '694 interventions tracked'], workflow: 'Department review highlights readiness, ready counts, at-risk groups and dominant gaps.', rows: departmentReadiness.map((d) => ({ Department: d.department, Students: d.students, Readiness: `${d.readiness}%`, Ready: d.ready, 'Need intervention': d.intervention })) },
  batches: { title: 'Batches', description: 'Batch and year summaries for student count, readiness and placement progress.', metrics: ['2027 primary cycle', '3 active batches', '66% eligible readiness'], workflow: 'Batch filters support focused outreach and placement-progress review.', rows: [{ Batch: '2027', Students: 1560, Readiness: '69%', Applications: 842, Offers: 126 }, { Batch: '2026', Students: 1320, Readiness: '74%', Applications: 1190, Offers: 198 }, { Batch: '2028', Students: 1406, Readiness: '58%', Applications: 214, Offers: 18 }] },
  'student-search': { title: 'Student Search', description: 'Expanded search for department, batch, readiness, risk and placement state.', metrics: ['Recent: Rahul Kumar', 'Filter: CSE 2027', 'Saved view: intervention queue'], workflow: 'Search results support view-student and assign-intervention preview actions.', rows: attentionStudents.map((s) => ({ Match: s.name, Department: s.department, Batch: s.batch, Readiness: `${s.readiness}%`, State: s.gap })) },
  readiness: { title: 'Readiness', description: 'Institution readiness trend, distribution, category breakdown and intervention queue.', metrics: ['71% average score', '+6% vs last month', '103 high risk'], workflow: 'Readiness bands remain interactive and route intervention work to the same secure preview queue.', rows: readinessDistribution.map((r) => ({ Band: r.label, Range: r.range, Students: r.value, Percent: `${r.percent}%` })) },
  assessments: { title: 'Assessments', description: 'Scheduled, active and completed assessments with participation and result summaries.', metrics: ['12 scheduled', '78% completion', '184 reminders due'], workflow: 'Schedule Assessment opens a preview-only assignment/reminder workflow.', rows: [{ Assessment: 'Aptitude diagnostic', Status: 'Active', Participation: '82%', Average: '64%' }, { Assessment: 'Cloud foundations', Status: 'Scheduled', Participation: 'CSE 2027', Average: 'Pending' }, { Assessment: 'Resume screening', Status: 'Completed', Participation: '91%', Average: 'Ready 66%' }] },
  interventions: { title: 'Interventions', description: 'Active interventions with severity, owner, due date, progress and affected students.', metrics: ['42 active plans', '12 overdue', '5 owners assigned'], workflow: 'Create intervention is preview-only until secure backend workflow enforcement exists.', rows: [{ Intervention: 'Resume Review', Priority: 'High', Owner: 'Placement Cell', Due: '20 Aug', Progress: '62%' }, { Intervention: 'Aptitude Bootcamp', Priority: 'Medium', Owner: 'Training Team', Due: '24 Aug', Progress: '48%' }, { Intervention: 'Mock Interview', Priority: 'High', Owner: 'Faculty mentors', Due: '22 Aug', Progress: '38%' }] },
  opportunities: { title: 'Opportunities', description: 'Institution-visible employer opportunities with eligibility, match counts and deadlines.', metrics: ['36 open roles', '812 matched students', '9 deadlines this week'], workflow: 'Publish and recommend actions are preview-only presentations, not backend writes.', rows: [{ Opportunity: 'Security Analyst Intern', Employer: 'TCS', Eligible: 312, Deadline: '20 Aug', Action: 'Recommend' }, { Opportunity: 'Cloud Trainee', Employer: 'Infosys', Eligible: 248, Deadline: '22 Aug', Action: 'Publish' }, { Opportunity: 'Data Engineer', Employer: 'Accenture', Eligible: 186, Deadline: '26 Aug', Action: 'Recommend' }] },
  applications: { title: 'Applications', description: 'Application pipeline, stage counts, searchable student list, pending actions and exceptions.', metrics: ['3,842 applications', '612 shortlisted', '41 exceptions'], workflow: 'Exception review routes to student and opportunity context without mutating backend state.', rows: placementPipeline.map((p) => ({ Stage: p.label, Count: p.value, Review: p.label === 'Applications' ? 'Duplicates and eligibility' : 'Stage movement' })) },
  interviews: { title: 'Interviews', description: 'Upcoming schedules, participating students, employer, role, preparation and result state.', metrics: ['45 upcoming students', '3 employers', '87% prep complete'], workflow: 'Details shows interview context; calendar actions route here or to Events.', rows: upcomingInterviews.map((i) => ({ Employer: i.employer, When: i.when, Students: i.students, Preparation: 'Checklist active', Result: 'Pending' })) },
  offers: { title: 'Offers', description: 'Offers received, accepted, declined and pending with compensation and conversion context.', metrics: ['198 offers', '164 placed', '5.15% application-to-offer'], workflow: 'Offer review supports student-level follow-up and acceptance-state preview.', rows: [{ Student: 'Asha Mehta', Employer: 'TCS', Package: '6.5 LPA', Status: 'Accepted' }, { Student: 'Rahul Kumar', Employer: 'Infosys', Package: '5.8 LPA', Status: 'Pending' }, { Student: 'Neha Patel', Employer: 'Accenture', Package: '7.2 LPA', Status: 'Accepted' }] },
  employers: { title: 'Employers', description: 'Employer directory with active opportunities, interviews, offers, placements and engagement status.', metrics: ['24 active employers', '36 opportunities', '164 placements'], workflow: 'Employer engagement actions open preview records only.', rows: topRecruiters.map((r) => ({ Employer: r.name, Opportunities: r.offers > 30 ? 4 : 2, Interviews: r.offers, Offers: r.offers, Placed: r.placed })) },
  communications: { title: 'Communications', description: 'Announcements, targeted audiences, delivery status and scheduled messages.', metrics: ['3 active announcements', '92% delivered', '2 scheduled'], workflow: 'Compose message is clearly preview-only pending secure messaging workflow.', rows: announcements.map((a) => ({ Announcement: a, Audience: 'Placement eligible students', Delivery: 'Scheduled', Status: 'Preview' })) },
  events: { title: 'Events', description: 'Placement drives, workshops, assessments and interviews with registration and attendance counts.', metrics: ['8 events', '642 registrations', '78% attendance'], workflow: 'Calendar/list views help review registrations without backend event writes.', rows: [{ Event: 'TCS campus drive', Type: 'Drive', Date: '20 Aug', Registrations: 312, Attendance: 'Pending' }, { Event: 'Resume workshop', Type: 'Workshop', Date: '18 Aug', Registrations: 186, Attendance: '82%' }, { Event: 'Aptitude assessment', Type: 'Assessment', Date: '19 Aug', Registrations: 420, Attendance: 'Pending' }] },
  reports: { title: 'Reports', description: 'Placement, readiness, skill-gap, assessment, intervention and employer engagement reports.', metrics: ['6 report families', 'Last export: preview', 'No protected data exposed'], workflow: 'Export controls are preview-only because secure report generation is backend-dependent.', rows: [{ Report: 'Placement summary', Scope: 'Institution', Status: 'Ready preview' }, { Report: 'Skill-gap analysis', Scope: 'Department', Status: 'Ready preview' }, { Report: 'Employer engagement', Scope: 'Placement cell', Status: 'Draft preview' }] },
  dashboards: { title: 'Dashboards', description: 'Saved dashboard summaries, department and batch views, and report shortcuts.', metrics: ['4 saved views', '2 department boards', '3 report shortcuts'], workflow: 'Saved views summarize operational slices without duplicating the main dashboard.', rows: [{ Dashboard: 'CSE readiness watch', Owner: 'Anita Sharma', Focus: 'High-risk CSE students' }, { Dashboard: '2027 placement cycle', Owner: 'Placement Cell', Focus: 'Applications to offers' }, { Dashboard: 'Employer engagement', Owner: 'Placement Cell', Focus: 'Recruiter activity' }] },
};

export function PlacementOfficerPortal(props: { readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly showDevelopmentIndicators: boolean }): React.ReactElement {
  return <StaffPreviewProvider><PlacementOfficerPortalInner {...props} /></StaffPreviewProvider>;
}

function PlacementOfficerPortalInner({ apiHealth, authStatus, authNotice, onSignIn, onSignOut, showDevelopmentIndicators }: { readonly apiHealth: ApiHealth; readonly authStatus: AuthStatus; readonly authNotice: string; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly showDevelopmentIndicators: boolean }): React.ReactElement {
  const [path, setPath] = useState(normalizeStaffPath(window.location.pathname));
  const [dateRange, setDateRange] = useState('Aug 1 - Aug 16, 2025');
  const [department, setDepartment] = useState('All departments');
  const [risk, setRisk] = useState('All readiness');
  const [studentQuery, setStudentQuery] = useState('');
  const [highlightBand, setHighlightBand] = useState('Ready');
  const [bandSelectionCount, setBandSelectionCount] = useState(0);
  const route = staffNavItems.find((item) => item.path === path)?.route ?? 'dashboard';

  useEffect(() => {
    document.title = route === 'dashboard' ? 'Placement Dashboard | ONE by AI8HT' : `${staffRouteTitle[route]} - Placement Officer | ONE by AI8HT`;
  }, [route]);

  useEffect(() => {
    const onPop = (): void => setPath(normalizeStaffPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const targetId = window.location.hash.replace('#', '');
    if (!targetId || targetId === 'filters-open') return undefined;
    const frame = window.requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function navigate(nextPath: string): void {
    const currentDemo = window.location.pathname.startsWith('/demo/');
    const routedPath = currentDemo && !nextPath.startsWith('/demo/') ? `/demo${nextPath}` : nextPath;
    window.history.pushState(null, '', routedPath);
    setPath(normalizeStaffPath(routedPath));
    if (window.navigator.userAgent.includes('jsdom')) return;
    try {
      window.scrollTo({ top: 0 });
    } catch {
      // jsdom does not implement scrollTo; browsers use this to reset route position.
    }
  }

  const visibleStudents = useMemo(() => attentionStudents.filter((student) => {
    const queryMatch = `${student.name} ${student.department} ${student.gap} ${student.intervention}`.toLowerCase().includes(studentQuery.toLowerCase());
    const departmentMatch = department === 'All departments' || student.department === department;
    const riskMatch = risk === 'All readiness' || (risk === 'Needs intervention' && student.readiness < 58) || (risk === 'High risk' && student.readiness < 50);
    return queryMatch && departmentMatch && riskMatch;
  }), [department, risk, studentQuery]);

  const shellProps = { apiHealth, authStatus, authNotice, showDevelopmentIndicators, activePath: path, onNavigate: navigate, onSignIn, onSignOut };

  if (route !== 'dashboard') {
    return <StaffShell {...shellProps}>{showDevelopmentIndicators ? <StaffPreviewBadge apiHealth={apiHealth} /> : null}<DemoModeNotice /><StaffOperationalPage route={route} onNavigate={navigate} /></StaffShell>;
  }

  return (
    <StaffShell {...shellProps}>
      {showDevelopmentIndicators ? <StaffPreviewBadge apiHealth={apiHealth} /> : null}
      <StaffPageHeader dateRange={dateRange} department={department} risk={risk} onDateRange={setDateRange} onDepartment={setDepartment} onRisk={setRisk} />
      <div className="staff-dashboard" data-date-range={dateRange}>
        <section className="staff-kpi-grid" aria-label="Placement KPI summary">{staffKpis.map((item) => <StaffKpiCard key={item.label} item={item} />)}</section>
        <StaffSection id="readiness-overview" title="Readiness overview" className="readiness-overview-card"><div className="readiness-overview-grid"><ReadinessTrendChart /><ReadinessDistribution activeBand={highlightBand} selectionCount={bandSelectionCount} onSelectBand={(band) => { setHighlightBand(band); setBandSelectionCount((value) => value + 1); }} /></div></StaffSection>
        <StaffSection title="Placement pipeline" className="placement-pipeline-card"><PlacementPipeline /></StaffSection>
        <StaffSection title="Top skill gaps" action="View full report" onAction={() => navigate(`${staffBasePath}/reports`)} className="skill-gaps-card"><div className="staff-bar-list">{skillGaps.map((gap) => <div key={gap.label} className="staff-bar-row"><span>{gap.label}</span><div><i style={{ width: `${gap.value}%` }} /></div><strong>{gap.value}%</strong></div>)}</div></StaffSection>
        <StaffSection id="students-attention" title="Students requiring attention" className="attention-card">
          <div className="attention-toolbar"><label className="attention-search"><Search size={15} /><span className="sr-only">Search students requiring attention</span><input value={studentQuery} onChange={(event) => setStudentQuery(event.target.value)} placeholder="Search student, gap, intervention..." /></label><span>{visibleStudents.length} records</span></div>
          <div className="attention-table-wrap"><table className="attention-table"><caption>Students requiring attention for placement readiness interventions</caption><thead><tr><th>Student</th><th>Department</th><th>Batch</th><th>Readiness</th><th>Primary gap</th><th>Last activity</th><th>Intervention</th><th>Actions</th></tr></thead><tbody>{visibleStudents.map((student) => <tr key={student.name}><td><span className="student-avatar">{initials(student.name)}</span><strong>{student.name}</strong></td><td>{student.department}</td><td>{student.batch}</td><td><span className="risk-score">{student.readiness}%</span></td><td>{student.gap}</td><td>{student.lastActivity}</td><td><span className="intervention-pill">{student.intervention}</span></td><td><MiniActionButton label="View" onClick={() => navigate(`${staffBasePath}/students`)} /><MiniActionButton label="Assign" onClick={() => navigate(`${staffBasePath}/interventions`)} /><MoreButton label={`More actions for ${student.name}`} onClick={() => navigate(`${staffBasePath}/student-search`)} /></td></tr>)}</tbody></table><div className="attention-records" aria-label="Students requiring attention records">{visibleStudents.map((student) => <article key={student.name}><div><strong>{student.name}</strong><span>{student.department} - Batch {student.batch}</span></div><dl><div><dt>Readiness</dt><dd>{student.readiness}%</dd></div><div><dt>Primary gap</dt><dd>{student.gap}</dd></div><div><dt>Last activity</dt><dd>{student.lastActivity}</dd></div><div><dt>Intervention</dt><dd>{student.intervention}</dd></div></dl><div className="record-actions"><MiniActionButton label="View student" onClick={() => navigate(`${staffBasePath}/students`)} /><MiniActionButton label="Assign" onClick={() => navigate(`${staffBasePath}/interventions`)} /></div></article>)}</div></div>
        </StaffSection>
        <StaffSection title="Upcoming interviews" action="View calendar" onAction={() => navigate(`${staffBasePath}/events`)} className="interviews-card"><div className="interview-list">{upcomingInterviews.map((item) => <article key={item.employer}><span className="employer-mark">{item.employer.slice(0, 2)}</span><div><strong>{item.employer}</strong><small>{item.when}</small></div><span>{item.students} Students</span><MiniActionButton label="Details" onClick={() => navigate(`${staffBasePath}/interviews`)} /></article>)}</div></StaffSection>
        <StaffSection title="Recent announcements" action="View all" onAction={() => navigate(`${staffBasePath}/communications`)} className="announcements-card"><div className="announcement-list">{announcements.map((item) => <article key={item}><MessageSquare size={16} /><div><strong>{item}</strong><small>Posted in placement communications</small></div></article>)}</div></StaffSection>
        <section className="action-card-grid" aria-label="Operational workflow entry points">{actionCards.map((item) => { const Icon = item.icon; const target = item.label.toLowerCase() === 'reports' ? 'reports' : item.label.toLowerCase(); return <article className="staff-card workflow-card" key={item.label}><Icon size={22} /><div><h3>{item.label}</h3><p>{item.detail}</p></div><MiniActionButton label={`Manage ${item.label}`} onClick={() => navigate(`${staffBasePath}/${target}`)} /></article>; })}</section>
        <StaffSection title="Department readiness comparison" action="View full analysis" onAction={() => navigate(`${staffBasePath}/readiness`)} className="department-card"><table className="department-table"><thead><tr><th>Department</th><th>Students</th><th>Avg readiness</th><th>Ready</th><th>Need intervention</th></tr></thead><tbody>{departmentReadiness.map((row) => <tr key={row.department}><td>{row.department}</td><td>{row.students.toLocaleString()}</td><td><span className="mini-readiness-bar"><i style={{ width: `${row.readiness}%` }} /></span>{row.readiness}%</td><td>{row.ready}</td><td>{row.intervention}</td></tr>)}</tbody></table></StaffSection>
        <StaffSection title="Placement trend" className="placement-trend-card"><PlacementTrendChart /></StaffSection>
        <StaffSection title="Top recruiters" action="View all" onAction={() => navigate(`${staffBasePath}/employers`)} className="recruiters-card"><div className="recruiter-list">{topRecruiters.map((item) => <article key={item.name}><span className="employer-mark">{item.name.slice(0, 2)}</span><strong>{item.name}</strong><span>Offers: {item.offers}</span><span>Placed: {item.placed}</span></article>)}</div></StaffSection>
        <StaffSection title="Quick actions" className="quick-actions-card"><div className="quick-action-list">{quickActions.map((item) => { const Icon = item.icon; return <button type="button" key={item.label} onClick={() => navigate(item.label.includes('Report') ? `${staffBasePath}/reports` : item.label.includes('Assessment') ? `${staffBasePath}/assessments` : item.label.includes('Intervention') ? `${staffBasePath}/interventions` : item.label.includes('Announcement') ? `${staffBasePath}/communications` : `${staffBasePath}/opportunities`)}><Icon size={16} /><span>{item.label}</span></button>; })}</div></StaffSection>
      </div>
      <DemoModeNotice />
    </StaffShell>
  );
}

function StaffOperationalPage({ route, onNavigate }: { readonly route: Exclude<StaffRouteKey, 'dashboard'>; readonly onNavigate: (path: string) => void }): React.ReactElement {
  const page = pageContent[route];
  const { records, activity, upsertRecord, resetDemoData } = useStaffPreviewState();
  const [formOpen, setFormOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useState('');
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const previewRecords = records.filter((record) => record.route === route);
  const action = routeAction[route];

  function savePreview(record: StaffPreviewRecord): void {
    upsertRecord(record, action);
    setToast('Demo changes not saved to backend');
    setFormOpen(false);
    openButtonRef.current?.focus();
  }

  function reset(): void {
    resetDemoData();
    setToast('Demo data reset for this session');
    setConfirmReset(false);
  }

  return <section className="staff-page-content"><div className="staff-page-header staff-page-heading"><div><span className="staff-eyebrow">{placementIdentity.organization}</span><h1>{page.title}</h1><p>{page.description} Preview data only; authorization remains backend-enforced.</p></div><button ref={openButtonRef} type="button" className="staff-mini-action" onClick={() => setFormOpen(true)}>{action}</button></div>{toast ? <div className="staff-toast" role="status">{toast}</div> : null}<div className="staff-page-grid"><section className="staff-page-metrics" aria-label={`${page.title} metrics`}>{page.metrics.map((metric) => { const [value = metric, ...rest] = metric.split(' '); return <article className="staff-card staff-mini-metric" key={metric}><strong>{value}</strong><span>{rest.join(' ')}</span></article>; })}</section><StaffSection title={`${page.title} actions`} className="staff-page-workflow"><p>{page.workflow}</p><p className="staff-readonly-note">{readOnlyText(route)}</p><div className="staff-workflow-actions"><MiniActionButton label={action} onClick={() => setFormOpen(true)} /><MiniActionButton label="View student" onClick={() => onNavigate(`${staffBasePath}/students`)} disabled={route === 'students'} /><MiniActionButton label="Assign intervention" onClick={() => onNavigate(`${staffBasePath}/interventions`)} disabled={route === 'interventions'} /><MiniActionButton label={confirmReset ? 'Confirm reset' : 'Reset'} onClick={confirmReset ? reset : () => setConfirmReset(true)} /></div></StaffSection><StaffSection title={`${page.title} records`} className="staff-page-records"><ResponsiveTable rows={[...previewRecords.map((record) => ({ Title: record.title, Status: record.status, Owner: record.owner, Note: record.note })), ...page.rows]} onReview={() => setFormOpen(true)} onAssign={() => onNavigate(`${staffBasePath}/interventions`)} /></StaffSection><StaffSection title="Preview activity log" className="staff-page-workflow"><div className="preview-activity-log">{activity.length === 0 ? <p>No demo changes yet.</p> : activity.slice(0, 4).map((event) => <article key={event.id}><strong>{event.action}</strong><span>{event.detail}</span></article>)}</div></StaffSection></div>{formOpen ? <PreviewWorkflowDialog route={route} action={action} onSave={savePreview} onClose={() => { setFormOpen(false); openButtonRef.current?.focus(); }} /> : null}</section>;
}

function DemoModeNotice(): React.ReactElement {
  const { dirty } = useStaffPreviewState();
  return <div className="staff-demo-notice" role="note"><span>Demo mode — changes are stored only for this session.</span><span>{dirty ? 'Demo changes not saved to backend' : 'Preview data only. Secure sign-in, authorization and persistent actions require the configured backend workflow.'}</span></div>;
}

function PreviewWorkflowDialog({ route, action, onSave, onClose }: { readonly route: Exclude<StaffRouteKey, 'dashboard'>; readonly action: string; readonly onSave: (record: StaffPreviewRecord) => void; readonly onClose: () => void }): React.ReactElement {
  const [title, setTitle] = useState(defaultTitle(route));
  const [status, setStatus] = useState(defaultStatus(route));
  const [owner, setOwner] = useState('Anita Sharma');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (!title.trim() || !status.trim() || !owner.trim()) {
      setError('Title, status and owner are required.');
      return;
    }
    onSave({ route, title: title.trim(), status: status.trim(), owner: owner.trim(), note: note.trim() || readOnlyText(route) });
  }

  return <div className="staff-modal-backdrop" role="presentation"><section className="staff-modal" role="dialog" aria-modal="true" aria-labelledby="staff-workflow-title"><h2 id="staff-workflow-title">{action}</h2><p>{formHelp(route)}</p><form onSubmit={submit} noValidate><label><span>Title <em>required</em></span><input ref={firstFieldRef} value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label><span>Status <em>required</em></span><input value={status} onChange={(event) => setStatus(event.target.value)} required /></label><label><span>Owner <em>required</em></span><input value={owner} onChange={(event) => setOwner(event.target.value)} required /></label><label><span>Institution note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add an institution-scoped preview note" /></label><div className="staff-readonly-note">{readOnlyText(route)}</div>{error ? <p className="staff-form-error" role="alert">{error}</p> : null}<div className="staff-modal-actions"><button type="button" className="staff-mini-action" onClick={onClose}>Cancel</button><button type="submit" className="staff-mini-action">Save changes</button></div></form></section></div>;
}

function ResponsiveTable({ rows, onReview, onAssign }: { readonly rows: readonly Row[]; readonly onReview: () => void; readonly onAssign: () => void }): React.ReactElement {
  const columns = Object.keys(rows[0] ?? {});
  return <div className="staff-responsive-records"><table className="department-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}<th>Actions</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{row[column]}</td>)}<td><MiniActionButton label="Review" onClick={onReview} /></td></tr>)}</tbody></table><div className="attention-records">{rows.map((row, index) => <article key={index}>{columns.map((column) => <div key={column}><span>{column}</span><strong>{row[column]}</strong></div>)}<div className="record-actions"><MiniActionButton label="Review" onClick={onReview} /><MiniActionButton label="Assign" onClick={onAssign} /></div></article>)}</div></div>;
}

function defaultTitle(route: Exclude<StaffRouteKey, 'dashboard'>): string {
  if (route === 'assessments') return 'Cloud foundations assessment';
  if (route === 'interventions') return 'Communication coaching plan';
  if (route === 'communications') return 'Placement drive announcement';
  if (route === 'events') return 'Employer readiness workshop';
  if (route === 'dashboards') return 'Department readiness view';
  return `${staffRouteTitle[route]} preview update`;
}

function defaultStatus(route: Exclude<StaffRouteKey, 'dashboard'>): string {
  if (route === 'opportunities') return 'Recommended to eligible cohort';
  if (route === 'events') return 'Published preview';
  if (route === 'communications') return 'Scheduled preview';
  if (route === 'offers') return 'Received verified by institution';
  return 'Updated in session preview';
}

function formHelp(route: Exclude<StaffRouteKey, 'dashboard'>): string {
  const help: Partial<Record<Exclude<StaffRouteKey, 'dashboard'>, string>> = {
    students: 'Edit institution placement status, participation, counselor assignment, or institution notes.',
    assessments: 'Create or edit assessment title, competency, cohort, schedule, duration, deadline and readiness impact.',
    interventions: 'Create, assign, update, complete or reopen institution intervention work.',
    opportunities: 'Recommend, set institution visibility, notify eligible students, or add institution guidance.',
    communications: 'Compose, save draft, schedule, or send a demo announcement.',
    events: 'Create or edit event schedule, venue, capacity, registration window and audience.',
    dashboards: 'Save or edit a custom dashboard view, scope, filters and visible widgets.',
    reports: 'Configure report filters and generate a preview; secure backend export is not implemented.',
  };
  return help[route] ?? 'Record an institution-scoped preview update for this module.';
}

function readOnlyText(route: Exclude<StaffRouteKey, 'dashboard'>): string {
  if (route === 'students' || route === 'student-search') return 'Read-only: student identity, consent decisions, profile fields, student-owned evidence and documents.';
  if (route === 'readiness') return 'Read-only: readiness scores generated from evidence cannot be directly edited.';
  if (route === 'opportunities') return 'Read-only: employer-owned title, compensation, eligibility requirements and deadline.';
  if (route === 'applications') return 'Read-only: student-submitted applications cannot be submitted, withdrawn or modified by this preview.';
  if (route === 'offers') return 'Read-only: employer-issued compensation and offer terms.';
  if (route === 'employers') return 'Read-only: employer-owned organization identity.';
  if (route === 'assessments') return 'Read-only: completed assessment results and verified academic source records.';
  return 'Frontend permission checks are presentation logic only; backend enforcement is still required.';
}

function ReadinessTrendChart(): React.ReactElement {
  const points = readinessTrend.map((value, index) => ({ x: 30 + index * 34, y: 132 - value }));
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  return <figure className="staff-line-chart"><svg viewBox="0 0 510 150" role="img" aria-label="Average readiness score trend from August 1 to August 16"><title>Connected readiness trend</title><desc>Average readiness moves from 52 to 89 over the selected date range.</desc><path className="chart-grid" d="M30 30 H485 M30 75 H485 M30 120 H485" /><path className="chart-line" d={path} />{points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="3.5" />)}</svg><figcaption>Average Readiness Score - 71% - +6% vs last month</figcaption></figure>;
}

function ReadinessDistribution({ activeBand, selectionCount, onSelectBand }: { readonly activeBand: string; readonly selectionCount: number; readonly onSelectBand: (band: string) => void }): React.ReactElement {
  const selected = readinessDistribution.find((item) => item.label === activeBand) ?? readinessDistribution[0]!;
  return <div className="distribution-panel"><figure className="donut-chart" aria-label="Readiness distribution donut"><div aria-hidden="true" /><figcaption>Readiness Distribution</figcaption></figure><div className="distribution-legend">{readinessDistribution.map((item) => <button key={item.label} type="button" aria-pressed={activeBand === item.label} className={activeBand === item.label ? 'selected' : ''} onClick={() => onSelectBand(item.label)}><span className="distribution-marker" style={{ background: item.color }} /><strong><span>{item.label}</span><span>({item.range})</span></strong><em className="distribution-count">{item.value}</em><em className="distribution-percent">{item.percent}%</em></button>)}</div><p className="result-count" role="status">Selected readiness band: {selected.label}, {selected.value} students, {selected.percent}%. Selection refresh {selectionCount}.</p></div>;
}

function PlacementPipeline(): React.ReactElement {
  const conversion = ((placementPipeline[3].value / placementPipeline[0].value) * 100).toFixed(2);
  return <div className="pipeline-widget" aria-label="Placement pipeline funnel"><div className="funnel" aria-hidden="true">{placementPipeline.map((item, index) => <span key={item.label} style={{ width: `${100 - index * 12}%` }} />)}</div><div className="pipeline-stages">{placementPipeline.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value.toLocaleString()}</strong></div>)}</div><div className="pipeline-conversion"><span>Conversion (Applications to Offers)</span><strong>{conversion}%</strong></div></div>;
}

function PlacementTrendChart(): React.ReactElement {
  return <figure className="staff-column-chart" aria-label="Placement trend for offers and placed students"><svg viewBox="0 0 420 170" role="img" aria-labelledby="placement-trend-title placement-trend-desc"><title id="placement-trend-title">Placement trend</title><desc id="placement-trend-desc">Monthly offers rise from 32 in March to 68 in July, then 54 in August.</desc>{placementTrend.map((item, index) => { const x = 34 + index * 62; const h = item.offers * 1.45; return <g key={item.month}><rect x={x} y={140 - h} width="22" height={h} rx="5" /><text x={x + 11} y={132 - h}>{item.offers}</text><text x={x + 11} y="160">{item.month}</text></g>; })}</svg><figcaption><span><BarChart3 size={14} /> Offers</span><span><CheckCircle2 size={14} /> Placed</span></figcaption></figure>;
}

function normalizeStaffPath(path: string): string {
  const normalizedPath = path.replace(/\/$/, '') || staffBasePath;
  const normalized = normalizedPath.startsWith('/demo/') ? normalizedPath.slice('/demo'.length) : normalizedPath;
  return staffNavItems.some((item) => item.path === normalized) ? normalized : staffBasePath;
}

function initials(name: string): string {
  return name.split(' ').map((part) => part[0]).join('');
}

