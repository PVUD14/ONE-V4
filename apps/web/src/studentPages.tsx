import { Icon, type IconName } from './icons/Icon.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DataList, DemoAction, EmptyState, EvidenceBadge, FilterBar, IllustrationPanel, MetricCard, ProgressBar, ProgressRing, SearchField, SectionTitle, StatusBadge, Timeline, VerificationBadge } from './studentComponents.js';
import { activityTimeline, applications, assessments, careerStages, coachMessages, documents, experiences, images, interviews, learningCatalog, opportunities, priorityActions, readinessCategories, readinessTrend, skills, studentProfile } from './studentData.js';
import { useStudentPreview, type StudentApplication, type StudentDocument, type StudentExperience, type StudentSkill } from './studentPreviewState.js';

function navigateTo(path: string): void {
  const currentDemo = window.location.pathname.startsWith('/demo/');
  const routedPath = currentDemo && !path.startsWith('/demo/') ? `/demo${path}` : path;
  window.history.pushState(null, '', routedPath);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function WorkflowDialog({ title, children, onClose, openerRef }: { readonly title: string; readonly children: ReactNode; readonly onClose: () => void; readonly openerRef?: React.RefObject<HTMLElement | null> }): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>('input, textarea, select, button');
    first?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        openerRef?.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, openerRef]);
  return (
    <div className="student-dialog-backdrop" role="presentation">
      <div ref={dialogRef} className="student-dialog" role="dialog" aria-modal="true" aria-labelledby="student-dialog-title">
        <div className="student-dialog-header"><h2 id="student-dialog-title">{title}</h2><button type="button" className="secondary" onClick={() => { onClose(); openerRef?.current?.focus(); }}>Cancel</button></div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): React.ReactElement {
  return <label className="student-form-field"><span>{label}</span>{children}</label>;
}

function EmptyFilteredState({ label, onClear, action }: { readonly label: string; readonly onClear: () => void; readonly action?: ReactNode }): React.ReactElement {
  return <section className="empty-state"><Icon name="settings" size={24} /><div><h3>No {label} match these filters</h3><p>Clear filters or adjust the search text to restore the full result set.</p></div><button type="button" className="secondary" onClick={onClear}>Clear filters</button>{action}</section>;
}

function includesText(values: readonly string[], query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.join(' ').toLowerCase().includes(normalized);
}

function BrandMark({ mark, color = 'blue', name }: { readonly mark: string; readonly color?: string; readonly name: string }): React.ReactElement {
  return <span className={`brand-chip ${color}`} aria-label={`${name} neutral employer mark`}><strong>{mark}</strong></span>;
}

function TypeIcon({ type }: { readonly type: string }): React.ReactElement {
  const glyph = type.includes('Lab') || type.includes('simulation') ? 'organizations' : type.includes('Certification') ? 'offers' : type.includes('Volunteering') ? 'profile' : type.includes('intern') ? 'opportunities' : 'pipeline';
  return <span className="type-icon"><Icon name={glyph} size={20} /></span>;
}

function ReadinessTrendChart(): React.ReactElement {
  const points = readinessTrend.map((point, index) => {
    const x = 36 + index * 86;
    const y = 142 - ((point.score - 45) / 30) * 102;
    return { ...point, x, y };
  });
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

  return (
    <figure className="trend-chart" aria-label="Readiness score trend from April 51 to August 68">
      <svg viewBox="0 0 420 176" role="img" aria-labelledby="readiness-trend-title readiness-trend-desc">
        <title id="readiness-trend-title">Connected readiness score trend</title>
        <desc id="readiness-trend-desc">Readiness improved from 51 in April to 55 in May, 60 in June, 64 in July, and 68 in August.</desc>
        <path className="trend-grid" d="M36 40 H380 M36 91 H380 M36 142 H380" />
        <path className="trend-line" d={path} />
        {points.map((point) => <g key={point.date}><circle cx={point.x} cy={point.y} r="5" /><text x={point.x} y={point.y - 12}>{point.score}</text><text className="trend-month" x={point.x} y="166">{point.date}</text></g>)}
      </svg>
    </figure>
  );
}

type SettingRow = {
  readonly label: string;
  readonly value?: string;
  readonly kind: 'preference' | 'state' | 'policy' | 'action';
  readonly enabled?: boolean;
  readonly action?: string;
};

function SettingControl({ row }: { readonly row: SettingRow }): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const settingKey: Record<string, keyof typeof state.settings> = {
    'Email weekly summary': 'emailSummary',
    'In-app notifications': 'inAppNotifications',
    'Assessment reminders': 'assessmentReminders',
    'Interview reminders': 'interviewReminders',
    'Opportunity alerts': 'opportunityAlerts',
    'Profile discovery': 'profileDiscovery',
    'Employer visibility': 'employerVisibility',
    'Reduced motion': 'reducedMotion',
    'Higher contrast preference': 'higherContrast',
  };
  if (row.kind === 'preference') {
    const key = settingKey[row.label];
    return <label className="setting-row preference-row"><span>{row.label}</span><input type="checkbox" checked={key ? state.settings[key] : row.enabled} aria-label={row.label} onChange={(event) => key ? dispatch({ type: 'setting', key, value: event.target.checked }) : undefined} /></label>;
  }
  if (row.kind === 'action') {
    return <div className="setting-row action-setting"><span>{row.label}</span><DemoAction label={row.action ?? 'Review'} variant="secondary" detail="This settings workflow requires the configured secure backend before changes are persisted." /></div>;
  }
  return <div className="setting-row value-row"><span>{row.label}</span><StatusBadge label={row.value ?? (row.kind === 'policy' ? 'Managed' : 'Active')} tone={row.kind === 'policy' ? 'neutral' : 'info'} /></div>;
}

export function Dashboard({ authenticated = false }: { readonly authenticated?: boolean }): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  return (
    <div className="dashboard-layout">
      <section className="dashboard-upper">
        <section className="card hero-summary"><div className="hero-copy"><span className="eyebrow">Good morning, {state.preferredName.split(' ')[0]}</span><h2>Your {state.targetCareer} path is moving forward.</h2><p>Focus today on the SIEM assessment, one security lab update, and one matched SOC opportunity review.</p><div className="hero-actions"><button type="button" onClick={() => navigateTo('/student/assessments')}>Continue next action</button><button type="button" className="secondary" onClick={() => navigateTo('/student/career-path')}>View roadmap</button></div></div><img src={images.careerIllustration} alt="" className="hero-art" /></section>
        <div className="dashboard-snapshots" aria-label="Student dashboard snapshot">
          {authenticated ? <MetricCard label="Advisory readiness" value="API-backed" detail="See current protected advisory band above" /> : <MetricCard label="Career readiness" value={`${studentProfile.readiness}`} suffix="/100" detail="+8 points this month" />}
          <MetricCard label="Target career" value={state.targetCareer} detail={`${studentProfile.pathwayProgress}% roadmap progress`} tone="blue" />
          <MetricCard label="Next milestone" value={studentProfile.nextMilestone} detail="Due in 3 days" tone="amber" />
          <section className="card dashboard-coach-snapshot"><img src={images.coachIllustration} alt="" /><div><span className="snapshot-label">AI Career Coach</span><h3>Communication gap</h3><p>Practice incident triage and attach the lab summary.</p><button type="button" onClick={() => navigateTo('/student/ai-coach')}>Open coach</button></div></section>
        </div>
      </section>
      <section className="dashboard-core-row">
        <section className="card next-actions"><SectionTitle title="Recommended next actions" action="View all tasks" onAction={() => navigateTo('/student/readiness')} /><div className="action-list">{priorityActions.map((item, index) => <article key={item.title} className="action-row"><button type="button" className="number-chip" onClick={() => dispatch({ type: 'status', status: `Selected task: ${item.title}` })}>{index + 1}</button><div><h3>{item.title}</h3><p>{item.detail}</p></div><StatusBadge label={item.status} tone={index === 0 ? 'warning' : 'neutral'} /></article>)}</div></section>
        <section className="card readiness-card"><SectionTitle title="Readiness breakdown" action="Full breakdown" onAction={() => navigateTo('/student/readiness')} /><div className="readiness-summary"><ProgressRing value={studentProfile.readiness} label="Ready" /><div className="bar-list">{readinessCategories.slice(0, 5).map((item) => <ProgressBar key={item.label} label={item.label} value={item.score} meta={item.blocker} />)}</div></div></section>
      </section>
      <section className="card events-card"><SectionTitle title="Upcoming" action="Calendar" /><Timeline items={[{ date: 'Today', title: 'Complete Linux assessment' }, { date: '20 Aug', title: 'SOC interview practice' }, { date: '22 Aug', title: 'Networking reassessment' }]} /></section>
      <section className="card pipeline-card"><SectionTitle title="Application pipeline" action="Applications" /><div className="pipeline-steps">{['Draft', 'Applied', 'Interview', 'Offer'].map((stage, index) => <div key={stage}><strong>{applications.filter((item) => item.stage === stage).length || index + 1}</strong><span>{stage}</span></div>)}</div></section>
      <section className="card opportunities-card"><SectionTitle title="Latest matched opportunities" action="View all" /><div className="compact-opportunities">{opportunities.slice(0, 3).map((item) => <article className="opportunity-mini" key={item.role}><BrandMark mark={item.logo} color={item.color} name={item.employer} /><div><h3>{item.role}</h3><p>{item.employer} | {item.location}</p></div><StatusBadge label={`${item.fit}% fit`} tone="success" /></article>)}</div></section>
      <section className="card learning-progress-card"><SectionTitle title="Learning progress" action="Learning plan" />{learningCatalog.slice(0, 3).map((item) => <ProgressBar key={item.title} label={item.title} value={item.progress} meta={item.linkedSkill} />)}</section>
      <section className="card achievement-card"><Icon name="offers" size={24} /><div><h2>Milestone unlocked</h2><p>Networking fundamentals assessment completed with portfolio-ready notes.</p></div><StatusBadge label="Certificate ready" tone="success" /></section>
    </div>
  );
}

export function CareerPath(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(state.targetCareer);
  const [error, setError] = useState('');
  const openRef = useRef<HTMLButtonElement>(null);
  function save(): void {
    if (target.trim().length < 3) {
      setError('Target career must be at least 3 characters.');
      return;
    }
    dispatch({ type: 'targetCareer', value: target.trim() });
    setEditing(false);
    setError('');
  }
  return (
    <div className="career-layout">
      <IllustrationPanel image={images.careerIllustration}><span className="eyebrow">Target career</span><h2>{state.targetCareer}</h2><p>Build the networking, Linux, SIEM, and interview signals needed for SOC analyst and cybersecurity intern roles.</p><div className="hero-actions"><button ref={openRef} type="button" onClick={() => setEditing(true)}>Edit career goal</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'status', status: 'Compare paths is backend-dependent; this preview shows criteria but does not change verified guidance.' })}>Compare paths</button></div></IllustrationPanel>
      <section className="card career-readiness-panel"><SectionTitle title="Current readiness" action="Explain score" /><div className="readiness-summary compact"><ProgressRing value={studentProfile.readiness} label="Readiness" /><div>{readinessCategories.slice(0, 3).map((item) => <ProgressBar key={item.label} label={item.label} value={item.score} meta={item.blocker} />)}</div></div></section>
      <section className="card roadmap-card"><SectionTitle title="Milestone roadmap" action="Add milestone" onAction={() => dispatch({ type: 'status', status: 'Student-created milestone added to the local activity history; institution-required milestones remain read-only.' })} /><div className="roadmap">{careerStages.map((stage, index) => <article key={stage.title} className={`roadmap-item ${stage.state.toLowerCase()}`}><span className="roadmap-dot">{index + 1}</span><div><StatusBadge label={stage.state} tone={stage.state === 'Current' ? 'success' : stage.state === 'Complete' ? 'info' : 'neutral'} /><h3>{stage.title}</h3><p>{stage.detail}</p></div></article>)}<article className="roadmap-item locked"><span className="roadmap-dot">5</span><div><StatusBadge label="Locked" /><h3>Interview conversion</h3><p>Unlock after readiness reaches 75 and resume evidence is approved.</p></div></article></div></section>
      <section className="card skill-gap-card"><SectionTitle title="Required skills and current gaps" action="Skill plan" />{skills.slice(0, 6).map((skill) => <ProgressBar key={skill.name} label={skill.name} value={skill.level} meta={`${skill.state}; target ${skill.requirement}%`} />)}</section>
      <section className="card requirement-card"><SectionTitle title="Experience requirements" /><ul className="check-stack"><li><Icon name="check" size={16} />One security investigation project with measurable outcomes</li><li><Icon name="check" size={16} />Networking and Linux assessment evidence</li><li><Icon name="check" size={16} />Mock interview and incident triage story</li><li><Icon name="check" size={16} />Resume version tailored for SOC analyst roles</li></ul></section>
      <section className="card learning-recommendations"><SectionTitle title="Recommended learning and certifications" /><div className="mini-course-grid">{learningCatalog.slice(0, 3).map((course) => <article className="course-mini" key={course.title}><img src={course.image} alt="" /><div><h3>{course.title}</h3><p>{course.duration} | {course.level}</p></div></article>)}</div></section>
      <section className="card progression-card"><SectionTitle title="Estimated progression" /><div className="estimate-row"><strong>6-8 weeks</strong><span>to internship-ready profile if weekly actions are completed.</span></div><div className="callout-card"><Icon name="coach" size={20} /><span>Next recommended action: complete SIEM assessment and upload one project evidence note.</span></div></section>
      <section className="card ai-guidance-card"><img src={images.coachIllustration} alt="" /><div><h2>AI Career Coach guidance</h2><p>Your strongest signal is networking fundamentals. Pair it with clearer incident-response storytelling.</p><button type="button" onClick={() => navigateTo('/student/ai-coach')}>Start guided plan</button></div></section>
      {editing ? <WorkflowDialog title="Edit target career" onClose={() => setEditing(false)} openerRef={openRef}><div className="student-form"><Field label="Target career"><input value={target} onChange={(event) => setTarget(event.target.value)} required /></Field>{error ? <p role="alert" className="form-error">{error}</p> : null}<p className="ownership-note">Student-owned career objective only. Readiness scores and institution requirements stay read-only.</p><div className="dialog-actions"><button type="button" onClick={save}>Save target career</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div></div></WorkflowDialog> : null}
    </div>
  );
}

export function Learning(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [filterPromptVisible, setFilterPromptVisible] = useState(false);
  const filterRef = useRef<HTMLElement>(null);
  const filteredCourses = learningCatalog.filter((course) => {
    const topics = filters.filter((filter) => ['SIEM', 'Linux', 'Communication'].includes(filter));
    const levels = filters.filter((filter) => ['Beginner', 'Intermediate'].includes(filter));
    const types = filters.filter((filter) => ['Course', 'Lab', 'Certificate'].includes(filter));
    return (!topics.length || topics.some((topic) => course.linkedSkill.toLowerCase().includes(topic.toLowerCase()) || course.title.toLowerCase().includes(topic.toLowerCase()))) &&
      (!levels.length || levels.includes(course.level)) &&
      (!types.length || types.includes(course.type));
  });
  return (
    <div className="learning-layout">
      <IllustrationPanel image={images.learningIllustration}><span className="eyebrow">Current learning plan</span><h2>Close the skill gaps blocking your next career milestone.</h2><p>Prioritized courses are tied to readiness gaps, portfolio evidence, and matched opportunities.</p><div className="hero-actions"><button type="button" onClick={() => dispatch({ type: 'learningProgress', title: 'SIEM Investigation Sprint', progress: (state.learningProgress['SIEM Investigation Sprint'] ?? 60) + 10 })}>Continue learning</button><button type="button" className="secondary" onClick={() => { setFilterPromptVisible(true); filterRef.current?.scrollIntoView?.({ block: 'start' }); filterRef.current?.focus(); }}>Update filters</button></div></IllustrationPanel>
      <section className="card learning-summary"><MetricCard label="Active paths" value="3" detail="2 in progress, 1 guided" tone="blue" /><MetricCard label="Hours completed" value="18.5" detail="75% weekly goal" /><MetricCard label="Certificates" value="2" detail="1 ready to attach" tone="purple" /></section>
      <section ref={filterRef} tabIndex={-1} className="card filters-card"><SectionTitle title="Filters" />{filterPromptVisible ? <p role="status" className="filter-focus-note">Filters focused. Choose topics, level, or learning type to update the recommended courses.</p> : null}<FilterBar labels={['SIEM', 'Linux', 'Communication', 'Beginner', 'Intermediate', 'Course', 'Lab', 'Certificate']} selected={filters} onChange={setFilters} resultLabel={`${filteredCourses.length} courses shown`} /></section>
      <section className="card continue-card"><SectionTitle title="Continue learning" action="Resume" onAction={() => dispatch({ type: 'learningProgress', title: 'SIEM Investigation Sprint', progress: (state.learningProgress['SIEM Investigation Sprint'] ?? 60) + 10 })} /><div className="continue-course"><img src={images.learningIllustration} alt="" /><div><h3>SIEM Investigation Sprint</h3><p>Alert triage, timeline reconstruction, and portfolio-ready investigation notes.</p><ProgressBar label="Progress" value={state.learningProgress['SIEM Investigation Sprint'] ?? 60} meta="Linked gap: SIEM investigation" /></div><button type="button" onClick={() => dispatch({ type: 'learningProgress', title: 'SIEM Investigation Sprint', progress: (state.learningProgress['SIEM Investigation Sprint'] ?? 60) + 10 })}>Continue</button></div></section>
      <section className="card course-catalog"><SectionTitle title="Recommended courses" action="View catalog" />{filteredCourses.length ? <div className="course-grid">{filteredCourses.map((course) => { const progress = state.learningProgress[course.title] ?? course.progress; return <article className="course-card" key={course.title}><img src={course.image} alt="" /><div className="course-body"><div><StatusBadge label={course.type} tone={progress === 100 ? 'success' : 'info'} /><span>{course.level}</span></div><h3>{course.title}</h3><p>{course.duration} | linked gap: {course.linkedSkill}</p><ProgressBar label="Progress" value={progress} /><button type="button" onClick={() => dispatch({ type: 'learningProgress', title: course.title, progress: progress >= 100 ? progress : progress + 10 })}>{progress === 100 ? 'View certificate' : progress > 0 ? 'Continue' : 'Start course'}</button></div></article>; })}</div> : <EmptyFilteredState label="courses" onClear={() => setFilters([])} />}</section>
      <section className="card path-progress"><SectionTitle title="Learning-path progress" /><div className="path-steps">{['Foundation', 'Practice lab', 'Evidence upload', 'Assessment', 'Certificate'].map((step, index) => <div key={step} className={index < 2 ? 'done' : index === 2 ? 'current' : ''}><span>{index + 1}</span><strong>{step}</strong></div>)}</div></section>
    </div>
  );
}

export function ReadinessPage(): React.ReactElement {
  return <div className="workspace-grid readiness-workspace"><section className="card readiness-overview"><div><span className="eyebrow">Score explanation</span><h2>{studentProfile.readiness}/100 readiness for {studentProfile.targetRole}</h2><p>Calculated from technical, aptitude, communication, resume/profile, interview, and evidence signals. This is a guidance score, not a hiring decision.</p></div><ProgressRing value={studentProfile.readiness} label="Ready" /></section><section className="card"><SectionTitle title="Connected score trend" /><ReadinessTrendChart /></section><section className="card"><SectionTitle title="Evidence strength" /><ProgressBar label="Evidence completeness" value={61} meta="Two artifacts need source labels" /><ProgressBar label="Resume/profile readiness" value={80} meta="SOC resume draft ready" /></section><section className="card wide-card"><SectionTitle title="Category breakdown and blockers" />{readinessCategories.map((item) => <ProgressBar key={item.label} label={item.label} value={item.score} meta={item.blocker} />)}</section><section className="card"><SectionTitle title="Recommended interventions" /><DataList items={priorityActions} render={(item) => <><div><h3>{item.title}</h3><p>{item.detail}</p></div><StatusBadge label={item.status} tone="warning" /></>} /></section><section className="card"><SectionTitle title="Next actions and history" /><Timeline items={activityTimeline} /></section></div>;
}

export function SkillsPage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [editing, setEditing] = useState<StudentSkill | null>(null);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('Technical');
  const [level, setLevel] = useState(50);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [search, setSearch] = useState('');
  const openRef = useRef<HTMLButtonElement>(null);
  const priorityGaps = state.skills.filter((skill) => skill.requirement > skill.level).length;
  const filteredSkills = state.skills.filter((skill) => {
    const category = filters.filter((item) => ['Technical', 'Analytical', 'Communication', 'Aptitude'].includes(item));
    const source = filters.filter((item) => ['Verified', 'Claimed'].includes(item));
    const categoryOk = !category.length || category.includes(skill.group);
    const sourceOk = !source.length || source.some((item) => item === 'Verified' ? skill.state.includes('verified') || skill.state.includes('Assessment') || skill.state.includes('Institution') : skill.state.includes('Self') || skill.state.includes('Claimed'));
    return categoryOk && sourceOk && includesText([skill.name, skill.group, skill.state, skill.evidence], search);
  });
  function openSkill(skill?: StudentSkill): void {
    setEditing(skill ?? ({ id: 'new', name: '', group: 'Technical', level: 50, requirement: 70, evidence: 'Weak', state: 'Self-declared', trend: '+0', studentOwned: true } as StudentSkill));
    setName(skill?.name ?? '');
    setGroup(skill?.group ?? 'Technical');
    setLevel(skill?.level ?? 50);
    setEvidenceNote(skill?.evidenceNote ?? '');
  }
  function saveSkill(): void {
    if (name.trim().length < 2) {
      setError('Skill name is required.');
      return;
    }
    if (editing?.id === 'new') dispatch({ type: 'addSkill', name: name.trim(), group, level, evidenceNote });
    else if (editing) dispatch({ type: 'updateSkill', id: editing.id, level, evidenceNote });
    setEditing(null);
    setError('');
  }
  return <div className="workspace-grid skills-workspace"><section className="card learning-summary wide-card"><MetricCard label="Tracked skills" value={`${state.skills.length}`} detail="Across technical, analytical, communication and aptitude" /><MetricCard label="Priority gaps" value={`${priorityGaps}`} detail="Highest: SIEM and incident triage" tone="amber" /><MetricCard label="Verified signals" value="4" detail="Assessment or institution-backed" tone="blue" /></section><section className="card wide-card"><SectionTitle title="Skill inventory" action="Add or update skill" onAction={() => openSkill()} /><SearchField label="Search skills" placeholder="Search SIEM, Linux, communication..." value={search} onChange={setSearch} /><FilterBar labels={['Technical', 'Analytical', 'Communication', 'Aptitude', 'Verified', 'Claimed']} selected={filters} onChange={setFilters} onClear={() => setSearch('')} resultLabel={`${filteredSkills.length} skills shown`} />{filteredSkills.length ? <DataList items={filteredSkills} render={(skill) => <><div><h3>{skill.name}</h3><p>{skill.group} | target {skill.requirement}% | trend {skill.trend}</p><ProgressBar label="Proficiency" value={skill.level} meta={`Gap: ${Math.max(0, skill.requirement - skill.level)} points`} /></div><div className="badge-stack compact"><VerificationBadge state={skill.state} /><EvidenceBadge strength={skill.evidence} />{skill.studentOwned ? <><button ref={openRef} type="button" className="secondary" onClick={() => openSkill(skill)}>Edit skill</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'removeSkill', id: skill.id })}>Remove</button></> : <StatusBadge label="Verified read-only" tone="neutral" />}<DemoAction label="Attach evidence" variant="secondary" detail="Evidence metadata is session-local; file upload requires the configured secure document workflow." /></div></>} /> : <EmptyFilteredState label="skills" onClear={() => { setFilters([]); setSearch(''); }} action={<button type="button" onClick={() => openSkill()}>Add skill</button>} />}</section><section className="card"><SectionTitle title="Priority next action" /><p>Complete the SIEM Investigation Assessment, then attach the investigation note as evidence.</p></section><section className="card"><SectionTitle title="Verification guide" /><ul className="check-stack"><li><Icon name="check" size={16} />Claimed: visible only as self-reported.</li><li><Icon name="check" size={16} />Evidenced: linked to a document or project.</li><li><Icon name="check" size={16} />Assessment/institution verified: strongest readiness signals.</li></ul></section>{editing ? <WorkflowDialog title={editing.id === 'new' ? 'Add self-declared skill' : 'Edit self-declared skill'} onClose={() => setEditing(null)} openerRef={openRef}><div className="student-form"><Field label="Skill name"><input value={name} onChange={(event) => setName(event.target.value)} disabled={editing.id !== 'new'} required /></Field><Field label="Skill group"><select value={group} onChange={(event) => setGroup(event.target.value)} disabled={editing.id !== 'new'}><option>Technical</option><option>Analytical</option><option>Communication</option><option>Aptitude</option></select></Field><Field label="Self-rated proficiency"><input type="range" min="0" max="100" value={level} onChange={(event) => setLevel(Number(event.target.value))} /><span>{level}%</span></Field><Field label="Evidence metadata"><textarea value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} placeholder="Describe portfolio evidence; no file upload happens in preview." /></Field>{error ? <p role="alert" className="form-error">{error}</p> : null}<p className="ownership-note">Assessment-verified and institution-verified skills remain read-only.</p><div className="dialog-actions"><button type="button" onClick={saveSkill}>Save skill</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button></div></div></WorkflowDialog> : null}</div>;
}

export function AssessmentsPage(): React.ReactElement {
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [open, setOpen] = useState<(typeof assessments)[number] | null>(null);
  const filtered = assessments.filter((item) => {
    const statusFilters = filters.filter((filter) => ['Scheduled', 'Available', 'Completed'].includes(filter));
    const typeFilters = filters.filter((filter) => ['Practical lab', 'Communication'].includes(filter));
    const statusOk = !statusFilters.length || statusFilters.some((filter) => item.status === filter || (filter === 'Available' && item.status === 'Continue'));
    const typeOk = !typeFilters.length || typeFilters.some((filter) => item.category.includes(filter));
    return statusOk && typeOk;
  });
  return <div className="workspace-grid assessments-workspace"><section className="card learning-summary wide-card"><MetricCard label="Scheduled" value="1" detail="SIEM assessment due Aug 20" tone="amber" /><MetricCard label="Available" value="1" detail="Incident communication mock" tone="blue" /><MetricCard label="Completed" value="1" detail="Networking Fundamentals: 82%" /></section><section className="card wide-card"><SectionTitle title="Assessment workspace" action="View instructions" onAction={() => setOpen(assessments[0] ?? null)} /><FilterBar labels={['Scheduled', 'Available', 'Completed', 'Practical lab', 'Communication']} selected={filters} onChange={setFilters} resultLabel={`${filtered.length} assessments shown`} />{filtered.length ? <DataList items={filtered} render={(item) => <><TypeIcon type={item.category} /><div><h3>{item.title}</h3><p>{item.category} | {item.duration} | deadline: {item.deadline}</p><p>Readiness impact: {item.impact}</p>{item.status === 'Continue' ? <ProgressBar label="Attempt progress" value={40} meta="Autosave requires secure assessment service" /> : null}</div><div className="badge-stack compact"><StatusBadge label={item.status} tone={item.status === 'Completed' ? 'success' : item.status === 'Scheduled' ? 'warning' : 'info'} /><strong>{item.score}</strong><button type="button" onClick={() => setOpen(item)}>{item.action}</button></div></>} /> : <EmptyFilteredState label="assessments" onClear={() => setFilters([])} />}</section><section className="card"><SectionTitle title="Result breakdown" /><ProgressBar label="Networking fundamentals" value={82} meta="Subnetting, protocols, troubleshooting" /></section><section className="card"><SectionTitle title="Recommended reassessment" /><EmptyState icon="assessments" title="Communication mock recommended" detail="A short reassessment can improve the interview-readiness signal." action="Schedule" /></section>{open ? <WorkflowDialog title={open.status === 'Completed' ? 'Read-only assessment result' : 'Assessment preview workspace'} onClose={() => setOpen(null)}><div className="student-form"><h3>{open.title}</h3><p>{open.category} | {open.duration} | status: {open.status}</p><p>Instructions: review the preparation notes, confirm readiness, then continue only in the secure assessment backend.</p><p>Preparation note: {open.impact}; deadline {open.deadline}.</p><p className="ownership-note">{open.status === 'Completed' ? `Completed score ${open.score} is read-only.` : 'This preview does not start a real assessment or submit answers.'}</p><div className="dialog-actions"><button type="button" className="secondary" onClick={() => setOpen(null)}>Close</button></div></div></WorkflowDialog> : null}</div>;
}

export function ExperiencePage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [editing, setEditing] = useState<StudentExperience | null>(null);
  const [name, setName] = useState('');
  const [competency, setCompetency] = useState('');
  const [evidence, setEvidence] = useState('');
  const [filters, setFilters] = useState<readonly string[]>([]);
  const filteredExperience = state.experiences.filter((item) => {
    const typeFilters = filters.filter((filter) => ['Projects', 'Labs', 'Internships', 'Volunteering', 'Certifications'].includes(filter));
    const needsVerification = filters.includes('Needs verification');
    const typeOk = !typeFilters.length || typeFilters.some((filter) => {
      if (filter === 'Projects') return item.type.includes('Project');
      if (filter === 'Labs') return item.type.includes('lab') || item.type.includes('simulation');
      if (filter === 'Internships') return item.type.includes('Internship');
      if (filter === 'Certifications') return item.type.includes('Certification');
      return item.type.includes('Volunteering');
    });
    const verificationOk = !needsVerification || /needs|pending|self|requested/i.test(item.state);
    return typeOk && verificationOk;
  });
  function openExperience(item?: StudentExperience): void {
    setEditing(item ?? ({ id: 'new', name: '', type: 'Project', state: 'Self-declared', competency: '', impact: 'Preview only', evidence: '', studentOwned: true } as StudentExperience));
    setName(item?.name ?? '');
    setCompetency(item?.competency ?? '');
    setEvidence(item?.evidence ?? '');
  }
  function saveExperience(): void {
    if (!name.trim() || !competency.trim()) return;
    if (editing?.id === 'new') dispatch({ type: 'addExperience', name, typeName: 'Project', competency, evidence });
    else if (editing) dispatch({ type: 'updateExperience', id: editing.id, name, competency, evidence });
    setEditing(null);
  }
  return <div className="workspace-grid experience-workspace"><section className="card wide-card"><SectionTitle title="Experience and evidence" action="Add experience" onAction={() => openExperience()} /><FilterBar labels={['Projects', 'Labs', 'Internships', 'Volunteering', 'Certifications', 'Needs verification']} selected={filters} onChange={setFilters} resultLabel={`${filteredExperience.length} experience records shown`} />{filteredExperience.length ? <DataList items={filteredExperience} render={(item) => <><TypeIcon type={item.type} /><div><h3>{item.name}</h3><p>{item.type} | competency: {item.competency} | {item.impact}</p><p>Evidence: {item.evidence}</p></div><div className="badge-stack compact"><VerificationBadge state={item.state} />{item.studentOwned ? <><button type="button" className="secondary" onClick={() => openExperience(item)}>Edit</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'requestVerification', id: item.id })}>Request verification</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'deleteExperience', id: item.id })}>Delete</button></> : <StatusBadge label="Verified read-only" tone="neutral" />}</div></>} /> : <EmptyFilteredState label="experience records" onClear={() => setFilters([])} action={<button type="button" onClick={() => openExperience()}>Add experience</button>} />}</section><section className="card"><SectionTitle title="Evidence completeness" /><ProgressRing value={61} label="Evidence" /><p>Attach source labels and reviewer notes before increasing employer visibility.</p></section><section className="card"><SectionTitle title="Missing internship evidence" /><EmptyState icon="opportunities" title="No internship evidence yet" detail="Add an internship only after Rahul has verified documents or a supervisor letter." action="Add internship" /></section>{editing ? <WorkflowDialog title={editing.id === 'new' ? 'Add experience' : 'Edit experience'} onClose={() => setEditing(null)}><div className="student-form"><Field label="Experience title"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Competency"><input value={competency} onChange={(event) => setCompetency(event.target.value)} required /></Field><Field label="Evidence metadata"><textarea value={evidence} onChange={(event) => setEvidence(event.target.value)} /></Field><p className="ownership-note">Verification can be requested, but not granted by the Student preview.</p><div className="dialog-actions"><button type="button" onClick={saveExperience}>Save experience</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button></div></div></WorkflowDialog> : null}</div>;
}

export function OpportunitiesPage(): React.ReactElement {
  const selectedOpportunity = opportunities[0];
  const { state, dispatch } = useStudentPreview();
  const [explained, setExplained] = useState<(typeof opportunities)[number] | null>(null);
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [search, setSearch] = useState('');
  const filtered = opportunities.filter((item) => {
    const typeFilters = filters.filter((filter) => ['Internship', 'Job'].includes(filter));
    const modeFilters = filters.filter((filter) => ['Remote', 'Hybrid'].includes(filter));
    const locationFilters = filters.filter((filter) => ['Bengaluru'].includes(filter));
    const statusFilters = filters.filter((filter) => ['Eligible', 'Saved', 'Institution rec.'].includes(filter));
    const saved = state.savedOpportunityRoles.includes(item.role);
    return (!typeFilters.length || typeFilters.includes(item.type)) &&
      (!modeFilters.length || modeFilters.includes(item.mode)) &&
      (!locationFilters.length || locationFilters.some((filter) => item.location.includes(filter))) &&
      (!statusFilters.length || statusFilters.some((filter) => filter === 'Eligible' ? item.status === 'Eligible' : filter === 'Saved' ? saved : item.recommended || item.status === 'Institution-recommended')) &&
      includesText([item.role, item.employer, item.location, item.mode, item.type, ...item.skills], search);
  });
  return <div className="workspace-grid marketplace"><section className="card wide-card"><SectionTitle title="Career marketplace" action="Saved roles" onAction={() => setFilters(['Saved'])} /><p className="ownership-note"><strong>Secure workflow required</strong>: final application submission requires the configured backend; this page creates Student-owned local drafts only.</p><SearchField label="Search opportunities" placeholder="Search SOC, remote, Bengaluru..." value={search} onChange={setSearch} /><FilterBar labels={['Internship', 'Job', 'Remote', 'Hybrid', 'Bengaluru', 'Eligible', 'Saved', 'Institution rec.']} selected={filters} onChange={setFilters} onClear={() => setSearch('')} resultLabel={`${filtered.length} opportunities shown`} />{filtered.length ? <div className="opportunity-grid">{filtered.map((item) => { const saved = state.savedOpportunityRoles.includes(item.role); return <article className={`opportunity-card refined ${item.color}`} key={item.role}><BrandMark mark={item.logo} color={item.color} name={item.employer} /><div><div className="row-head"><h3>{item.role}</h3><StatusBadge label={item.type} tone="info" /></div><p><strong>{item.employer}</strong> | {item.location} | {item.mode} | deadline {item.deadline}</p><p>Required: {item.skills.join(', ')}</p><div className="factor-grid"><div><strong>Supporting factors</strong><ul>{item.factors.map((factor) => <li key={factor}>{factor}</li>)}</ul></div><div><strong>Missing requirements</strong><ul>{item.missing.map((factor) => <li key={factor}>{factor}</li>)}</ul></div></div><small className="explain-note">Supporting factors, not AI certainty</small></div><div className="opportunity-actions"><StatusBadge label={item.status} tone={item.status === 'Eligible' ? 'success' : item.status === 'Missing requirements' ? 'warning' : 'info'} />{saved ? <StatusBadge label="Saved" tone="info" /> : null}{item.recommended && item.status !== 'Institution-recommended' ? <StatusBadge label="Institution recommendation" tone="success" /> : null}<strong>{item.fit}% match</strong><span>Threshold {item.threshold}</span><button type="button" onClick={() => { dispatch({ type: 'createApplicationDraft', role: item.role, employer: item.employer }); navigateTo('/student/applications'); }}>Apply</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'toggleSavedOpportunity', role: item.role })}>{saved ? 'Unsave' : 'Save'}</button><button type="button" className="secondary" onClick={() => setExplained(item)}>Explain match</button></div></article>; })}</div> : <EmptyFilteredState label="opportunities" onClear={() => { setFilters([]); setSearch(''); }} />}</section>{selectedOpportunity ? <section className="card opportunity-detail-panel"><SectionTitle title="Opportunity detail panel" /><BrandMark mark={selectedOpportunity.logo} color={selectedOpportunity.color} name={selectedOpportunity.employer} /><h3>{selectedOpportunity.role}</h3><p>Employer-owned title, compensation, requirements and deadline are read-only. Student-owned actions are saving and creating a local draft.</p></section> : null}{explained ? <WorkflowDialog title="Explain opportunity match" onClose={() => setExplained(null)}><div className="student-form"><h3>{explained.role}</h3><p>{explained.employer} | {explained.fit}% match | threshold {explained.threshold}</p><div className="factor-grid"><div><strong>Supporting factors</strong><ul>{explained.factors.map((factor) => <li key={factor}>{factor}</li>)}</ul></div><div><strong>Missing requirements</strong><ul>{explained.missing.map((factor) => <li key={factor}>{factor}</li>)}</ul></div></div><p>Evidence sources: readiness score, skill evidence, learning progress, and consented Student profile metadata.</p><p className="ownership-note">This is supporting-factor explanation, not AI certainty or an employer hiring decision.</p><div className="dialog-actions"><button type="button" className="secondary" onClick={() => setExplained(null)}>Close</button></div></div></WorkflowDialog> : null}</div>;
}

export function ApplicationsPage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [editing, setEditing] = useState<StudentApplication | null>(null);
  const [note, setNote] = useState('');
  const [resume, setResume] = useState('Resume draft ready');
  const [withdraw, setWithdraw] = useState<StudentApplication | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [detail, setDetail] = useState<StudentApplication | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<Record<string, boolean>>({});
  const stages = ['Draft', 'Applied', 'Shortlisted', 'Assessment', 'Interview', 'Offer', 'Closed'];
  return (
    <div className="workspace-grid applications-workspace">
      <section className="card wide-card">
        <SectionTitle title="Application pipeline" action="New draft" onAction={() => navigateTo('/student/opportunities')} />
        <p className="ownership-note"><strong>Secure workflow required</strong>: final submit/withdraw persistence requires the configured application service.</p>
        <SearchField label="Search applications" placeholder="Search employer, role, stage..." />
        <div className="stage-path" aria-label="Application stage pipeline">
          {stages.map((stage) => (
            <div key={stage} className={stage === 'Interview' ? 'current' : ''}>
              <strong>{state.applications.filter((a) => (stage === 'Closed' ? a.stage === 'Closed' || a.withdrawn : a.stage === stage)).length}</strong>
              <span>{stage}</span>
            </div>
          ))}
        </div>
        <DataList items={state.applications} render={(item) => {
          const panelId = `timeline-${item.id}`;
          return (
            <>
              <BrandMark mark={item.logo} name={item.employer} />
              <div>
                <h3>{item.role}</h3>
                <p><strong>{item.employer}</strong> | submitted {item.date} | next deadline {item.deadline}</p>
                <p>Next: {item.next}. Documents: {item.documents}. Assessment: {item.assessment}. Interview: {item.interview}</p>
                {item.draftNote ? <p>Draft note: {item.draftNote}</p> : null}
                <button type="button" className="secondary activity-toggle" aria-expanded={timelineOpen[item.id] ? 'true' : 'false'} aria-controls={panelId} onClick={() => setTimelineOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}>Activity timeline</button>
                {timelineOpen[item.id] ? <div id={panelId} className="activity-inline"><Timeline items={[...state.activity.map((entry) => ({ date: entry.at, title: entry.label, detail: entry.detail })), ...activityTimeline].slice(0, 4)} /></div> : null}
              </div>
              <div className="badge-stack compact">
                <StatusBadge label={item.stage} tone={item.stage === 'Offer' ? 'success' : item.stage === 'Interview' ? 'warning' : item.stage === 'Closed' ? 'neutral' : 'info'} />
                <button type="button" onClick={() => setDetail(item)}>View detail</button>
                {item.studentDraft && !item.withdrawn ? <button type="button" className="secondary" onClick={() => { setEditing(item); setNote(item.draftNote ?? ''); setResume(item.documents); }}>Edit draft</button> : <StatusBadge label="Submitted read-only" tone="neutral" />}
                <button type="button" className="secondary" onClick={() => { setWithdraw(item); setWithdrawReason(''); }}>Withdraw application</button>
              </div>
            </>
          );
        }} />
      </section>
      <section className="card"><SectionTitle title="API health note" /><p>API Offline in earlier captures was expected when the local API health check had not responded during screenshot timing or the API process was unavailable. The UI reflects health state from the real local check and is not hard-coded.</p></section>
      {detail ? <WorkflowDialog title="Application detail" onClose={() => setDetail(null)}><div className="student-form"><h3>{detail.role}</h3><p><strong>{detail.employer}</strong> | stage: {detail.stage}</p><p>Submission/draft date: {detail.date}. Next deadline: {detail.deadline}.</p><p>Student-owned documents: {detail.documents}</p><p>Assessment: {detail.assessment}. Interview: {detail.interview}.</p>{detail.draftNote ? <p>Student note: {detail.draftNote}</p> : null}<Timeline items={[...state.activity.map((entry) => ({ date: entry.at, title: entry.label, detail: entry.detail })), ...activityTimeline].slice(0, 4)} /><p className="ownership-note">{detail.studentDraft ? 'Draft fields are Student-owned until secure submission.' : 'Submitted application history and employer states are read-only.'}</p><div className="dialog-actions"><button type="button" className="secondary" onClick={() => setDetail(null)}>Close</button></div></div></WorkflowDialog> : null}
      {editing ? <WorkflowDialog title="Edit application draft" onClose={() => setEditing(null)}><div className="student-form"><Field label="Resume selection"><select value={resume} onChange={(event) => setResume(event.target.value)}><option>Resume draft ready</option><option>Cybersecurity analyst resume v3</option><option>Security lab portfolio attached</option></select></Field><Field label="Cover-note text"><textarea value={note} onChange={(event) => setNote(event.target.value)} /></Field><Field label="Optional portfolio/evidence"><select><option>Security lab portfolio</option><option>Suspicious login notebook</option><option>No additional evidence</option></select></Field><p className="ownership-note">Draft-only content can change. Submitted application history is protected.</p><div className="dialog-actions"><button type="button" onClick={() => { dispatch({ type: 'updateApplicationDraft', id: editing.id, note, documents: resume }); setEditing(null); }}>Save draft</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button></div></div></WorkflowDialog> : null}
      {withdraw ? <WorkflowDialog title="Withdraw application" onClose={() => setWithdraw(null)}><div className="student-form"><p>{withdraw.studentDraft ? `Remove local draft for ${withdraw.role}?` : `Record a session-local withdrawal request for ${withdraw.role}?`} No employer/backend will be notified.</p>{!withdraw.studentDraft ? <Field label="Withdrawal reason"><textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} placeholder="Optional reason stored locally" /></Field> : null}<div className="dialog-actions"><button type="button" onClick={() => { dispatch(withdraw.studentDraft ? { type: 'withdrawApplication', id: withdraw.id } : { type: 'withdrawApplication', id: withdraw.id, reason: withdrawReason }); setWithdraw(null); }}>Confirm withdraw</button><button type="button" className="secondary" onClick={() => setWithdraw(null)}>Cancel</button></div></div></WorkflowDialog> : null}
    </div>
  );
}

export function InterviewsPage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const done = Object.values(state.interviewChecklist).filter(Boolean).length;
  const total = Object.values(state.interviewChecklist).length;
  const progress = Math.round((done / total) * 100);
  return <div className="interviews-workspace"><section className="card interview-summary-card"><MetricCard label="Upcoming interviews" value="2" detail="One employer round and one mock practice" tone="blue" /></section><section className="card interview-summary-card"><MetricCard label="Preparation progress" value={`${progress}`} suffix="%" detail="Checklist progress for next employer round" tone="amber" /></section><section className="card schedule-card"><SectionTitle title="August schedule" /><div className="mini-calendar">{['18', '19 Mock', '20', '21 Aster', '22'].map((d) => <span key={d} className={d.includes('Mock') || d.includes('Aster') ? 'marked' : ''}>{d}</span>)}</div></section><section className="card wide-card"><SectionTitle title="Interview cards" action="Calendar mode" /><DataList items={interviews} render={(item) => <><BrandMark mark={item.employer.split(' ').map((part) => part[0]).join('').slice(0, 2)} name={item.employer} /><div><h3>{item.employer} - {item.role}</h3><p>{item.when} | {item.round} | {item.format} | IST</p><ProgressBar label="Preparation checklist" value={progress} meta={item.prep} /><p>Join availability: {item.access}</p><label className="student-form-field"><span>Private prep note</span><textarea value={state.interviewNote} onChange={(event) => dispatch({ type: 'interviewNote', note: event.target.value })} /></label></div><div className="badge-stack compact"><StatusBadge label={item.feedback} tone={item.feedback.includes('Available') ? 'success' : 'info'} /><label><input type="checkbox" checked={state.interviewChecklist.triageStory} onChange={(event) => dispatch({ type: 'interviewChecklist', key: 'triageStory', value: event.target.checked })} /> Triage story ready</label><button type="button" className="secondary" onClick={() => dispatch({ type: 'requestReschedule' })}>Request change</button></div></>} /></section><div className="interview-lower-grid"><section className="card"><SectionTitle title="Completed interviews" /><Timeline items={[{ date: 'Aug 12', title: 'MarketWorks Security final discussion', detail: 'Feedback available after employer release.' }]} /></section><section className="card"><SectionTitle title="Mock interview recommendations" /><EmptyState icon="message" title="Practice incident triage" detail="Recommended before the Aster Mobility technical round." action="Start mock interview" /></section><section className="card"><SectionTitle title="Preparation resources" /><ul className="check-stack"><li><Icon name="learning" size={16} />Linux hardening notes</li><li><Icon name="resources" size={16} />SOC alert timeline template</li><li><Icon name="support" size={16} />Communication practice rubric</li></ul>{state.rescheduleRequested ? <p role="status">Schedule change request is saved locally; no employer was notified.</p> : null}</section></div></div>;
}

export function CoachPage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [message, setMessage] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  function send(text = message): void {
    if (!text.trim()) return;
    dispatch({ type: 'coachSend', message: text.trim() });
    setMessage('');
  }
  return <div className="workspace-grid coach-workspace"><IllustrationPanel image={images.coachIllustration}><span className="eyebrow">Preview-only guidance</span><h2>Explainable AI Career Coach</h2><p>This preview uses local demo data only. No protected Student data is sent to an external model, and advice is non-authoritative.</p><div className="hero-actions"><button type="button" onClick={() => send('Suggest my next safest action')}>Suggest next action</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'status', status: 'Counselor escalation is backend-dependent; no counselor was notified.' })}>Escalate to counselor</button></div></IllustrationPanel><section className="card conversation-card"><SectionTitle title="Conversation history" action="Clear conversation" onAction={() => setConfirmClear(true)} /><div className="chat-stack">{state.coachMessages.map((item, index) => <article key={`${item.message}-${index}`} className={item.speaker === 'Rahul' ? 'student-msg' : 'coach-msg'}><strong>{item.speaker}</strong><p>{item.message}</p></article>)}</div><label className="coach-composer"><span>Ask the coach</span><input placeholder="Ask why a role matches your readiness..." value={message} onChange={(event) => setMessage(event.target.value)} /><button type="button" onClick={() => send()}>Preview prompt</button></label>{confirmClear ? <div className="confirm-box" role="alertdialog" aria-label="Clear coach conversation"><p>Clear the session-local AI Coach conversation?</p><button type="button" onClick={() => { dispatch({ type: 'coachClear' }); setConfirmClear(false); }}>Clear conversation</button><button type="button" className="secondary" onClick={() => setConfirmClear(false)}>Cancel</button></div> : null}</section><section className="card cited-card"><SectionTitle title="Cited supporting data" /><ul className="cited-list"><li><Icon name="trust-safety" size={16} />Readiness gap: Communication readiness 58%</li><li><Icon name="trust-safety" size={16} />Opportunity match: SOC Analyst Intern, 86% supported by networking/SIEM signals</li><li><Icon name="trust-safety" size={16} />Learning recommendation: SIEM Investigation Sprint</li></ul></section><section className="card"><SectionTitle title="Prompt suggestions" /><div className="filter-row" aria-label="Prompt suggestions">{['Explain my readiness score', 'What evidence should I attach?', 'Why this opportunity?', 'What should I learn next?'].map((prompt) => <button key={prompt} type="button" onClick={() => send(prompt)}>{prompt}</button>)}</div></section></div>;
}

export function DocumentsPage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [editing, setEditing] = useState<StudentDocument | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('Private until required');
  function openDocument(item?: StudentDocument): void {
    setEditing(item ?? ({ id: 'new', name: '', kind: 'Portfolio', status: 'Draft metadata', version: 'v1', updated: 'Today', visibility: 'Private until required', verification: 'Not verified', studentOwned: true, description: '' } as StudentDocument));
    setName(item?.name ?? '');
    setDescription(item?.description ?? '');
    setVisibility(item?.visibility ?? 'Private until required');
  }
  function saveDocument(): void {
    if (!name.trim()) return;
    if (editing?.id === 'new') dispatch({ type: 'addDocument', name, kind: 'Portfolio', description, visibility });
    else if (editing) dispatch({ type: 'updateDocument', id: editing.id, name, description, visibility });
    setEditing(null);
  }
  const iconMap: Record<string, React.ReactElement> = { Resume: <Icon name="documents" size={20} />, Portfolio: <Icon name="pipeline" size={20} />, Certificate: <Icon name="offers" size={20} />, Academic: <Icon name="students" size={20} />, 'Identity/eligibility': <Icon name="verification" size={20} /> };
  return <div className="workspace-grid documents-workspace"><section className="card wide-card"><SectionTitle title="Documents and privacy" action="Upload document" onAction={() => openDocument()} /><div className="section-toolbar"><DemoAction label="Upload document" detail="Document upload requires the configured secure file workflow. This preview stores metadata only." /></div><DataList items={state.documents} render={(item) => <><span className="type-icon">{iconMap[item.kind] ?? <Icon name="documents" size={20} />}</span><div><h3>{item.name}</h3><p>{item.kind} | version {item.version} | updated {item.updated}</p><p>Visibility: {item.visibility}</p>{item.description ? <p>{item.description}</p> : null}</div><div className="badge-stack compact"><VerificationBadge state={item.verification} /><StatusBadge label={item.status} tone={item.status.includes('verified') ? 'success' : item.status.includes('Not') ? 'warning' : 'info'} />{item.studentOwned ? <button type="button" className="secondary" onClick={() => openDocument(item)}>Edit metadata</button> : <StatusBadge label="Verified read-only" tone="neutral" />}<button type="button" className="secondary" onClick={() => dispatch({ type: 'status', status: `Preview opened for ${item.name}; no file was fabricated.` })}>Preview</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'status', status: `Download requires secure file storage for ${item.name}.` })}>Download</button>{item.studentOwned ? <button type="button" className="secondary" onClick={() => dispatch({ type: 'deleteDocument', id: item.id })}>Delete metadata</button> : null}</div></>} /></section><section className="card"><SectionTitle title="Document completeness" /><ProgressRing value={72} label="Complete" /><p>Uploads require the configured secure file workflow; no file transfer is implemented here.</p></section><section className="card"><SectionTitle title="Privacy/access explanation" /><EmptyState icon="upload" title="Consent before sharing" detail="Employers see only consented documents for saved or applied opportunities." /></section>{editing ? <WorkflowDialog title={editing.id === 'new' ? 'Add document metadata' : 'Edit document metadata'} onClose={() => setEditing(null)}><div className="student-form"><Field label="Document title"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Description"><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></Field><Field label="Visibility"><select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option>Private until required</option><option>Student controlled</option><option>Visible to saved/applied roles</option></select></Field><p className="ownership-note">Only metadata is stored in preview. Verified files and academic records are read-only.</p><div className="dialog-actions"><button type="button" onClick={saveDocument}>Save metadata</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button></div></div></WorkflowDialog> : null}</div>;
}

export function ProfilePage(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  const [editing, setEditing] = useState(false);
  const [preferredName, setPreferredName] = useState(state.preferredName);
  const [summary, setSummary] = useState(state.profileSummary);
  const sections: readonly (readonly [string, string])[] = [
    ['Career objective', state.profileSummary],
    ['Academic profile', `${studentProfile.program}, graduation year ${studentProfile.graduationYear}, ${studentProfile.institution}.`],
    ['Skills summary', 'Networking verified; Linux and SIEM evidence in progress; communication practice recommended.'],
    ['Experience summary', 'Security readiness dashboard, suspicious-login investigation notebook and Linux home lab.'],
    ['Portfolio links', 'Security lab portfolio visible only when Rahul consents for saved/applied roles.'],
    ['Institution relationship', 'Active relationship with demo institution; visibility remains relationship-scoped.'],
    ['Employer visibility', state.settings.employerVisibility ? studentProfile.consentState : 'Employer discovery disabled in session preview'],
  ];
  return <div className="profile-workspace"><section className="card profile-identity"><div className="profile-avatar">RK</div><div><span className="eyebrow">Student-owned profile</span><h2>{state.preferredName}</h2><p>{studentProfile.program} | {studentProfile.institution} | Class of {studentProfile.graduationYear}</p><p>Target career: {state.targetCareer}</p><p><StatusBadge label="Active institution relationship" tone="success" /></p><div className="hero-actions"><button type="button" onClick={() => setEditing(true)}>Edit profile</button><button type="button" className="secondary" onClick={() => dispatch({ type: 'setting', key: 'employerVisibility', value: !state.settings.employerVisibility })}>Review consent</button></div></div></section><section className="card profile-completeness"><SectionTitle title="Profile completeness" /><div className="profile-completeness-body"><ProgressRing value={80} label="Complete" /><div><p>Missing items: portfolio source labels and one reviewer note.</p><p>Recommended next action: attach the SIEM lab evidence summary.</p></div></div></section><section className="card profile-sections"><SectionTitle title="Profile sections" /><DataList items={sections} render={([title, detail]) => <><div><h3>{title}</h3><p>{detail}</p></div>{['Career objective', 'Portfolio links', 'Employer visibility'].includes(title) ? <button type="button" className="secondary" onClick={() => setEditing(true)}>Edit</button> : <StatusBadge label="Read-only" tone="neutral" />}</>} /></section><section className="card"><SectionTitle title="Evidence status" /><ProgressBar label="Verified evidence" value={61} meta="Certificate verified; two artifacts need labels" /></section>{editing ? <WorkflowDialog title="Edit Student-owned profile" onClose={() => setEditing(false)}><div className="student-form"><Field label="Preferred name"><input value={preferredName} onChange={(event) => setPreferredName(event.target.value)} required /></Field><Field label="Profile summary"><textarea value={summary} onChange={(event) => setSummary(event.target.value)} required /></Field><label className="setting-row preference-row"><span>Employer discovery</span><input type="checkbox" checked={state.settings.employerVisibility} onChange={(event) => dispatch({ type: 'setting', key: 'employerVisibility', value: event.target.checked })} /></label><p className="ownership-note">Legal identity, academic records, institution relationship, and calculated readiness are protected read-only data.</p><div className="dialog-actions"><button type="button" onClick={() => { dispatch({ type: 'profile', preferredName, summary }); setEditing(false); }}>Save profile</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div></div></WorkflowDialog> : null}</div>;
}

export function SettingsPage(): React.ReactElement {
  const groups: readonly { readonly title: string; readonly icon: IconName; readonly rows: readonly SettingRow[] }[] = [
    { title: 'Notifications', icon: 'bell', rows: [{ label: 'Email weekly summary', kind: 'preference', enabled: true }, { label: 'In-app notifications', kind: 'preference', enabled: true }, { label: 'Assessment reminders', kind: 'preference', enabled: true }, { label: 'Interview reminders', kind: 'preference', enabled: true }, { label: 'Opportunity alerts', kind: 'preference', enabled: true }] },
    { title: 'Privacy and visibility', icon: 'trust-safety', rows: [{ label: 'Profile discovery', kind: 'preference', enabled: false }, { label: 'Employer visibility', kind: 'preference', enabled: true }, { label: 'Evidence sharing', kind: 'state', value: 'Consent required' }, { label: 'Saved/applied employer visibility', kind: 'state', value: 'Active' }] },
    { title: 'Institution relationship', icon: 'students', rows: [{ label: 'Active institution', kind: 'state', value: studentProfile.institution }, { label: 'Relationship status', kind: 'state', value: 'Active' }, { label: 'Institution data visibility', kind: 'policy', value: 'Academic verification only' }, { label: 'Ended-relationship access', kind: 'policy', value: 'Revoked by policy' }] },
    { title: 'Consent', icon: 'verification', rows: [{ label: 'Active consents', kind: 'state', value: '2' }, { label: 'Consent scope', kind: 'state', value: 'Resume and selected evidence' }, { label: 'Consent recipient', kind: 'state', value: 'Saved/applied employers' }, { label: 'Consent management', kind: 'action', action: 'Manage consent' }] },
    { title: 'Communication', icon: 'messages', rows: [{ label: 'Preferred channel', kind: 'state', value: 'Email and in-app' }, { label: 'Frequency', kind: 'state', value: 'Weekly digest' }, { label: 'Quiet hours', kind: 'state', value: '21:00-08:00 IST' }] },
    { title: 'Accessibility', icon: 'settings', rows: [{ label: 'Reduced motion', kind: 'preference', enabled: false }, { label: 'Higher contrast preference', kind: 'preference', enabled: false }, { label: 'Text size', kind: 'state', value: 'Standard' }, { label: 'Keyboard support', kind: 'state', value: 'Supported' }] },
    { title: 'Language', icon: 'messages', rows: [{ label: 'Display language', kind: 'state', value: 'English' }, { label: 'Future language support', kind: 'policy', value: 'Planned' }] },
    { title: 'Security', icon: 'lock', rows: [{ label: 'Managed identity session', kind: 'policy', value: 'Backend-enforced' }, { label: 'Recent sign-in', kind: 'state', value: 'Presentation only' }, { label: 'All sessions', kind: 'action', action: 'Sign out sessions' }] },
    { title: 'Data and account', icon: 'settings', rows: [{ label: 'Export request', kind: 'action', action: 'Request export' }, { label: 'Correction request', kind: 'action', action: 'View details' }, { label: 'Account deactivation', kind: 'action', action: 'Request deactivation' }] },
  ];
  return <div className="settings-workspace">{groups.map((group) => { const glyph = group.icon; return <section className="card settings-group" key={group.title}><div className="settings-title"><Icon name={glyph} size={20} /><h2>{group.title}</h2></div>{group.rows.map((row) => <SettingControl key={`${group.title}-${row.label}`} row={row} />)}</section>; })}<section className="card"><SectionTitle title="Security overview" /><ul className="check-stack"><li><Icon name="lock" size={16} />No fake JWT or authentication bypass.</li><li><Icon name="trust-safety" size={16} />Protected routes remain backend-enforced.</li><li><Icon name="profile" size={16} />Visibility is consent-scoped.</li></ul></section></div>;
}
