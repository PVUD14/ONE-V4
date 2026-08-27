import { useEffect, useState } from 'react';
import { AlertTriangle, Award, BookOpen, Building2, ClipboardCheck, Code2, FileText, Flame, LineChart, Plus, Target, Trophy, Wrench } from 'lucide-react';
import { MultiRing, Ring } from './pilot/pilotComponents.js';
import { PilotTabs } from './pilot/pilotOverlay.js';
import {
  getProtectedAccessToken,
  getStudentActivity,
  listInstitutionExamResults,
  listInstitutionExams,
  listStudentDocuments,
  type ExamNotAttemptedDto,
  type StudentDocumentDto,
} from './api.js';

/**
 * The six pilot-only pages, built with the pilot's views per the standing
 * rule: same composition, same tabs, same slots - and an explicit NA (or 0)
 * wherever the engine or content behind a widget does not exist yet. Real
 * data is used wherever it does exist (streak, resume documents, the
 * not-attempted intervention queue). Nothing is invented.
 */

function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function NaRingRailCard({ title, center, legend }: { readonly title: string; readonly center: string; readonly legend: readonly string[] }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <MultiRing segments={[]}>NA<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>{center}</div></MultiRing>
      <div className="pilot-legend" style={{ flex: 1 }}>
        {legend.map((label) => <div key={label}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">NA</span></div>)}
      </div>
    </div>
  </section>;
}

function NaListCard({ title, note }: { readonly title: string; readonly note: string }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>{note}</p>
  </section>;
}

function NaCourseTiles({ title, labels }: { readonly title: string; readonly labels: readonly string[] }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>{title}</h2><span className="pilot-chip slate">NA</span></div>
    <div className="pilot-row cols-5">
      {labels.map((label) => (
        <div key={label} className="pilot-course-card" style={{ opacity: .65 }}>
          <span className="pilot-tile" style={{ background: '#eef1f6', color: '#9aa5b8' }}><BookOpen size={17} /></span>
          <strong>{label}</strong>
          <small>NA — not live yet</small>
          <button type="button" className="pilot-btn ghost small" disabled>Open</button>
        </div>
      ))}
    </div>
  </section>;
}

// --- Practice ----------------------------------------------------------------

const PRACTICE_TABS = ['Overview', 'Coding', 'Aptitude', 'Projects', 'Contests'] as const;

export function StudentPracticePage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [tab, setTab] = useState(0);
  const [streak, setStreak] = useState<number | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void getStudentActivity(token, controller.signal).then((activity) => setStreak(activity.currentStreakDays)).catch(() => setStreak(null));
    return () => controller.abort();
  }, [token]);
  const tabLabel = PRACTICE_TABS[tab] ?? 'Overview';

  return <div className="pilot pilot-embed"><div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Practice</h1><p>Sharpen your skills with coding, problems, projects and real-world challenges.</p></div>
      </div>
      <PilotTabs labels={PRACTICE_TABS} active={tab} onChange={setTab} />

      {tab > 0 ? <NaListCard title={tabLabel} note={`${tabLabel} problem sets are not live yet — NA. Institution assessments are live under Assessments.`} /> : null}

      {tab === 0 ? <>
        <section className="pilot-hero">
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <div className="pilot-stat"><span className="pilot-tile green"><Code2 size={17} /></span><div><b>NA</b><small>Problems Solved</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile amber"><Trophy size={17} /></span><div><b>NA</b><small>Contests Participated</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile blue"><ClipboardCheck size={17} /></span><div><b>NA</b><small>Practice Time</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile rose"><Flame size={17} /></span><div><b>{streak ?? 'NA'}</b><small>Day Streak</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile teal"><LineChart size={17} /></span><div><b>NA</b><small>Success Rate</small></div></div>
          </div>
        </section>
        <NaCourseTiles title="Continue Practicing" labels={['NA', 'NA', 'NA', 'NA', 'NA']} />
        <NaCourseTiles title="Recommended for You" labels={['NA', 'NA', 'NA', 'NA', 'NA']} />
        <NaListCard title="Practice by Skill" note="A practice problem bank is not live yet — NA. Your institution's live assessments are under Assessments." />
      </> : null}
    </div>

    {tab === 0 ? <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Practice Overview</h2><span className="pilot-chip slate">NA</span></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[]}>NA<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Attempts</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            {['Solved', 'Attempted', 'Bookmarked'].map((label) => <div key={label}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">NA</span></div>)}
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <h2>Live today</h2>
        <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Timed practice happens through your institution&apos;s assessments.</p>
        <button type="button" className="pilot-btn soft small" onClick={() => go('/student/assessments')}>Open Assessments</button>
      </section>
    </aside> : null}
  </div></div>;
}

// --- Company Prep ------------------------------------------------------------

export function StudentCompanyPrepPage(): React.ReactElement {
  const [tab, setTab] = useState(0);
  return <div className="pilot pilot-embed"><div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Company Preparation</h1><p>Prepare for your dream companies with tailored resources and practice.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'Companies', 'Interview Prep', 'Aptitude Prep', 'Mock Interviews', 'Saved']} active={tab} onChange={setTab} />
      {tab === 0 ? <>
        <section className="pilot-hero">
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <div className="pilot-stat"><span className="pilot-tile blue"><Building2 size={17} /></span><div><b>NA</b><small>Target Companies</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile purple"><ClipboardCheck size={17} /></span><div><b>NA</b><small>Prep Sets Completed</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile amber"><Target size={17} /></span><div><b>NA</b><small>Mock Interviews</small></div></div>
          </div>
        </section>
        <NaListCard title="Companies" note="Company prep guides are not live yet — NA. Real openings from real employers are under Opportunities." />
      </> : <NaListCard title={['Overview', 'Companies', 'Interview Prep', 'Aptitude Prep', 'Mock Interviews', 'Saved'][tab] ?? ''} note="This prep content is not live yet — NA." />}
    </div>
    {tab === 0 ? <aside className="pilot-rail">
      <NaRingRailCard title="Preparation Progress" center="Overall" legend={['Completed', 'In Progress', 'Not Started', 'Saved']} />
      <NaListCard title="Upcoming Interviews" note="No interview schedule yet — NA." />
    </aside> : null}
  </div></div>;
}

// --- Career Tools ------------------------------------------------------------

const TOOL_TABS = ['Overview', 'Planning', 'Building', 'Acceleration'] as const;

export function StudentCareerToolsPage(): React.ReactElement {
  const [tab, setTab] = useState(0);
  return <div className="pilot pilot-embed"><div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Career Tools</h1><p>Everything you need to plan, build and accelerate your career.</p></div>
      </div>
      <PilotTabs labels={TOOL_TABS} active={tab} onChange={setTab} />
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>{TOOL_TABS[tab]}</h2><span className="pilot-chip slate">NA</span></div>
        <div className="pilot-row cols-3">
          {[['Career Path Planner', 'Map the roles you can grow into'], ['Skill Gap Analyzer', 'Compare your skills against a target role'], ['Salary Insights', 'Compensation ranges by role and city']].map(([title, detail]) => (
            <div key={title} className="pilot-course-card" style={{ opacity: .65 }}>
              <span className="pilot-tile" style={{ background: '#eef1f6', color: '#9aa5b8' }}><Wrench size={17} /></span>
              <strong>{title}</strong>
              <small>{detail} — NA, not live yet</small>
              <button type="button" className="pilot-btn ghost small" disabled>Open →</button>
            </div>
          ))}
        </div>
        <p style={{ color: 'var(--p-muted)', marginTop: 12 }}>What is live today: your readiness band and roadmap under My Career, and real skills evidence under Skills.</p>
      </section>
    </div>
    {tab === 0 ? <aside className="pilot-rail">
      <NaRingRailCard title="Tools Usage Overview" center="Tools Used" legend={['Resume & Docs', 'Skill Tools', 'Planning', 'Job Search']} />
      <NaListCard title="Recommended for You" note="Tool recommendations are not live yet — NA." />
    </aside> : null}
  </div></div>;
}

// --- Scholarships ------------------------------------------------------------

export function StudentScholarshipsPage(): React.ReactElement {
  const [tab, setTab] = useState(0);
  const labels = ['Overview', 'Recommended', 'Merit Based', 'Need Based', 'Deadlines'] as const;
  return <div className="pilot pilot-embed"><div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Scholarships</h1><p>Discover and apply for scholarships to support your education journey.</p></div>
      </div>
      <PilotTabs labels={labels} active={tab} onChange={setTab} />
      {tab === 0 ? (
        <section className="pilot-hero">
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
            <div className="pilot-stat"><span className="pilot-tile amber"><Award size={17} /></span><div><b>NA</b><small>Matched to You</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile blue"><ClipboardCheck size={17} /></span><div><b>NA</b><small>Applications</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile rose"><Flame size={17} /></span><div><b>NA</b><small>Closing Soon</small></div></div>
          </div>
        </section>
      ) : null}
      <NaListCard title={labels[tab] ?? ''} note="Scholarship listings are not live yet — NA. They arrive when a scholarships content partner or institution feed is connected." />
    </div>
    {tab === 0 ? <aside className="pilot-rail">
      <NaRingRailCard title="Scholarship Insights" center="Available" legend={['Merit Based', 'Need Based', 'Corporate', 'Private']} />
      <NaListCard title="Upcoming Deadlines" note="No scholarship deadlines yet — NA." />
    </aside> : null}
  </div></div>;
}

// --- Resume Builder ----------------------------------------------------------

export function StudentResumeBuilderPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [tab, setTab] = useState(0);
  const [documents, setDocuments] = useState<readonly StudentDocumentDto[] | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listStudentDocuments(token, controller.signal).then((response) => setDocuments(response.documents)).catch(() => setDocuments(null));
    return () => controller.abort();
  }, [token]);
  const resumes = (documents ?? []).filter((doc) => doc.documentType === 'RESUME' && !doc.archivedAt);

  return <div className="pilot pilot-embed"><div className="pilot-page" style={tab === 0 || tab === 1 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Resume Builder</h1><p>Create professional resumes that showcase your skills and land your dream job.</p></div>
        <button type="button" className="pilot-btn" onClick={() => go('/student/documents')}><FileText size={15} /> Create New Resume</button>
      </div>
      <PilotTabs labels={['My Resumes', 'Templates', 'Examples', 'Resume Score']} active={tab} onChange={setTab} />

      {tab === 0 ? (
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>My Resumes</h2><span className="pilot-chip blue">{resumes.length} real</span></div>
          <div className="pilot-list">
            {resumes.length ? resumes.map((doc) => (
              <div key={doc.id} className="pilot-list-row">
                <span className="pilot-tile teal" style={{ width: 34, height: 34 }}><FileText size={15} /></span>
                <div className="grow"><strong style={{ fontSize: 12.5 }}>{doc.title}</strong><small>{doc.file ? doc.file.filename : 'No file attached yet'} · {doc.verificationState.replaceAll('_', ' ').toLowerCase()}</small></div>
                <button type="button" className="pilot-btn ghost small" onClick={() => go('/student/documents')}>Open</button>
              </div>
            )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>No resume documents yet. Add one under Documents — it appears here.</p>}
          </div>
        </section>
      ) : null}
      {tab === 1 ? <NaListCard title="Templates" note="Guided resume templates are not live yet — NA." /> : null}
      {tab === 2 ? <NaListCard title="Examples" note="Role-specific resume examples are not live yet — NA." /> : null}
      {tab === 3 ? (
        <section className="pilot-card" style={{ maxWidth: 640 }}>
          <div className="pilot-card-head"><h2>Resume Score</h2><span className="pilot-chip slate">NA</span></div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
            <Ring value={0} size={104} stroke={11} tone="blue"><span style={{ fontSize: 16, color: 'var(--p-muted)' }}>NA</span></Ring>
            <div className="pilot-legend" style={{ flex: 1 }}>
              {['Content', 'Format', 'Skills', 'Impact'].map((label) => <div key={label}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">NA/100</span></div>)}
            </div>
          </div>
          <p style={{ color: 'var(--p-muted)', marginTop: 12 }}>Automated resume scoring is not live yet — NA.</p>
        </section>
      ) : null}
    </div>
    {tab === 0 || tab === 1 ? <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Resume Overview</h2><span className="pilot-chip slate">NA</span></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Ring value={0} size={88} stroke={10} tone="blue"><span style={{ fontSize: 14, color: 'var(--p-muted)' }}>NA</span></Ring>
          <div className="pilot-legend" style={{ flex: 1 }}>
            {['Content', 'Format', 'Skills', 'Impact'].map((label) => <div key={label}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">NA/100</span></div>)}
          </div>
        </div>
        <small style={{ display: 'block', marginTop: 10, color: 'var(--p-muted)' }}>Automated resume scoring is not live yet — NA.</small>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recent Resumes</h2><span className="pilot-chip blue">{resumes.length} real</span></div>
        <div className="pilot-list">
          {resumes.length ? resumes.slice(0, 3).map((doc) => (
            <div key={doc.id} className="pilot-list-row">
              <span className="pilot-tile blue" style={{ width: 34, height: 34 }}><FileText size={15} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{doc.title}</strong><small>{doc.verificationState.replaceAll('_', ' ').toLowerCase()}</small></div>
            </div>
          )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>None yet.</p>}
        </div>
      </section>
      <NaListCard title="Resume Tips" note="Curated resume tips are not live yet — NA." />
    </aside> : null}
  </div></div>;
}

// --- Institution Interventions ----------------------------------------------

export function InstitutionInterventionsPage({ institutionId, basePath }: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [queue, setQueue] = useState<readonly (ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string })[] | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listInstitutionExams(token, institutionId, controller.signal).then(async (response) => {
      const published = response.assessments.filter((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0).slice(0, 3);
      const groups = await Promise.all(published.map((exam) =>
        listInstitutionExamResults(token, institutionId, exam.id, controller.signal)
          .then((result) => result.notAttempted.map((entry) => ({ ...entry, examTitle: exam.title, endsAt: exam.endsAt })))
          .catch(() => [])));
      setQueue(groups.flat());
    }).catch(() => setQueue([]));
    return () => controller.abort();
  }, [token, institutionId]);

  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Interventions</h1><p>Structured support for students who need attention before the placement season.</p></div>
        <button type="button" className="pilot-btn" disabled title="Structured intervention workflows are not built yet"><Plus size={15} /> Assign Intervention</button>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Needs attention now</h2><span className="pilot-chip blue">Live — from assessment data</span></div>
        <div className="pilot-list">
          {queue === null ? <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Loading…</p>
            : queue.length ? queue.slice(0, 8).map((entry, index) => (
              <div key={`${entry.institutionStudentId}-${index}`} className="pilot-list-row">
                <span className="pilot-tile rose"><AlertTriangle size={16} /></span>
                <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? `In progress now: ${entry.examTitle}` : `Has not attempted: ${entry.examTitle}`}</small></div>
                <span className="pilot-chip amber">Due {new Date(entry.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/assessments`)}>Review</button>
              </div>
            )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Nobody needs attention right now — every assigned assessment is attempted.</p>}
        </div>
      </section>

      <NaListCard title="Tracked interventions" note="Structured intervention records (owner, due date, outcome tracking) are not built yet — NA. The live queue above is derived from real assessment data." />
    </div>
    <aside className="pilot-rail">
      <NaListCard title="Why Interventions Work" note="Outcome insights arrive once structured intervention records exist — NA." />
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Completion Rate</h2>
        <Ring value={0} size={104} stroke={11} tone="blue"><span style={{ fontSize: 16, color: 'var(--p-muted)' }}>NA</span></Ring>
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>NA — no tracked interventions yet</small>
      </section>
    </aside>
  </div></div>;
}
