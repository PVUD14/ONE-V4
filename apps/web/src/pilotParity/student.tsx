/**
 * ONE · Pilot-parity — Stream D — Learner
 *
 * Practice, Company Prep, Career Tools, Scholarships and Resume Builder: the five
 * pilot-exact pages. Real data is used wherever it exists; every other slot is NA. The Resume
 * Builder generates résumés from the student's own record (RESUME-GEN).
 */
import { deleteResume, documentVerificationLabel, getProtectedAccessToken, getResume, getResumeSources, getStudentActivity, listResumes, listStudentDocuments, previewResume } from '../api.js';
import type {
  ResumeCheckDto, ResumeContentDto, ResumeDraftDto, ResumeSourcesDto, ResumeSummaryDto, ResumeTemplateDto, ResumeTemplateKey, StudentDocumentDto,
} from '../api.js';
import { MultiRing } from '../pilot/pilotComponents.js';
import { ResumeBuilder, ResumeChecksList, ResumePaper, defaultResumeDraft, downloadVersion } from '../studentResumes.js';
import { PilotTabs } from '../pilot/pilotOverlay.js';
import { NaCourseTiles, NaListCard, NaRingRailCard, go } from './naWidgets.js';
import { PublishedContentCard } from './publishedContent.js';
import { PracticeBySkillCard } from '../studentLearning.js';
import { Award, Building2, ClipboardCheck, Code2, Download, FileText, Flame, LineChart, Target, Trash2, Trophy, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDate } from '../dates.js';

export const PRACTICE_TABS = ['Overview', 'Coding', 'Aptitude', 'Projects', 'Contests'] as const;

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
        <PublishedContentCard contentType="PRACTICE" title="Practice resources" />
        <PracticeBySkillCard />
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
        <PublishedContentCard contentType="COMPANY_PREP" title="Company preparation" />
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

export const TOOL_TABS = ['Overview', 'Planning', 'Building', 'Acceleration'] as const;

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
      <PublishedContentCard contentType="CAREER_TOOL" title="Career tools" />
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
      <PublishedContentCard contentType="SCHOLARSHIP" title="Scholarships" />
        <NaListCard title="Upcoming Deadlines" note="No scholarship deadlines yet — NA." />
    </aside> : null}
  </div></div>;
}

// --- Resume Builder ----------------------------------------------------------
// RESUME-GEN: the student generates a résumé from their own ONE record (studentResumes.tsx). My Resumes lists
// the generated ones and the uploaded résumé documents; Templates shows the three real templates; Examples
// shows the student's own record in each template (never an invented person); Resume Score is a checklist of
// objective completeness checks — ONE does not score résumés, so there is no number anywhere on this page.

type ResumeLoad = { readonly sources: ResumeSourcesDto; readonly templates: readonly ResumeTemplateDto[] };

export function StudentResumeBuilderPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [tab, setTab] = useState(0);
  const [documents, setDocuments] = useState<readonly StudentDocumentDto[] | null>(null);
  const [load, setLoad] = useState<ResumeLoad | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [resumes, setResumes] = useState<readonly ResumeSummaryDto[] | null>(null);
  const [example, setExample] = useState<{ readonly content: ResumeContentDto; readonly checks: readonly ResumeCheckDto[] } | null>(null);
  const [builder, setBuilder] = useState<{ readonly resumeId: string | null; readonly initial: ResumeDraftDto } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listStudentDocuments(token, controller.signal).then((response) => setDocuments(response.documents)).catch(() => setDocuments(null));
    void getResumeSources(token, controller.signal).then((result) => { setLoad(result); setLoadFailed(false); })
      .catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listResumes(token, controller.signal).then((result) => setResumes(result.resumes)).catch(() => { if (!controller.signal.aborted) setResumes(null); });
    return () => controller.abort();
  }, [token, reload]);

  // The student's own record laid out once: the Templates, Examples and checks views read it.
  useEffect(() => {
    if (!token || !load) return undefined;
    const controller = new AbortController();
    void previewResume(token, defaultResumeDraft(load.sources), controller.signal).then(setExample).catch(() => { if (!controller.signal.aborted) setExample(null); });
    return () => controller.abort();
  }, [token, load]);

  const uploaded = (documents ?? []).filter((doc) => doc.documentType === 'RESUME' && !doc.archivedAt);
  const generated = resumes ?? [];

  function startNew(template: ResumeTemplateKey = 'CLASSIC'): void {
    if (!load) return;
    setStatus(null);
    setBuilder({ resumeId: null, initial: defaultResumeDraft(load.sources, template) });
    setTab(0);
  }

  async function startEdit(resumeId: string): Promise<void> {
    if (!token) return;
    setStatus(null);
    try {
      const { resume } = await getResume(token, resumeId);
      if (resume.latest) setBuilder({ resumeId, initial: resume.latest.selections });
    } catch {
      setStatus('That résumé could not be opened. Try again.');
    }
  }

  async function remove(resume: ResumeSummaryDto): Promise<void> {
    if (!token || !window.confirm(`Delete "${resume.title}" and every saved version of it? This cannot be undone.`)) return;
    try {
      await deleteResume(token, resume.id);
      setStatus('Résumé deleted.');
      setReload((value) => value + 1);
    } catch {
      setStatus('The résumé could not be deleted. Try again.');
    }
  }

  async function download(resume: ResumeSummaryDto): Promise<void> {
    if (!token) return;
    setStatus('Preparing the PDF…');
    setStatus(await downloadVersion(token, resume.id, resume.latestVersion));
  }

  const wide = tab > 1 || builder !== null;
  const checks = example?.checks ?? null;

  return <div className="pilot pilot-embed"><div className="pilot-page" style={wide ? { gridTemplateColumns: '1fr' } : undefined}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Resume Builder</h1><p>Create professional resumes that showcase your skills and land your dream job.</p></div>
        <button type="button" className="pilot-btn" disabled={!load} onClick={() => startNew()}><FileText size={15} /> Create New Resume</button>
      </div>
      <PilotTabs labels={['My Resumes', 'Templates', 'Examples', 'Resume Score']} active={tab} onChange={(index) => { setTab(index); setBuilder(null); }} />
      {status ? <p role="status" style={{ margin: '0 0 10px', fontSize: 12.5 }}>{status}</p> : null}
      {loadFailed ? <NaListCard title="Your record" note="Your record could not be loaded, so a résumé cannot be generated just now. Try again shortly." /> : null}

      {builder && token && load ? (
        <ResumeBuilder key={builder.resumeId ?? 'new'} token={token} sources={load.sources} templates={load.templates} initial={builder.initial} resumeId={builder.resumeId}
          onSaved={() => { setBuilder(null); setReload((value) => value + 1); setStatus('Résumé saved. Download the PDF from My Resumes.'); }}
          onCancel={() => setBuilder(null)} />
      ) : null}

      {!builder && tab === 0 ? <>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>My Resumes</h2><span className="pilot-chip blue">{generated.length} generated</span></div>
          <div className="pilot-list">
            {generated.length ? generated.map((resume) => (
              <div key={resume.id} className="pilot-list-row">
                <span className="pilot-tile blue" style={{ width: 34, height: 34 }}><FileText size={15} /></span>
                <div className="grow"><strong style={{ fontSize: 12.5 }}>{resume.title}</strong><small>{templateName(load, resume.template)} · version {resume.latestVersion} · saved {formatDay(resume.latestSavedAt)}</small></div>
                <button type="button" className="pilot-btn soft small" onClick={() => void download(resume)}><Download size={13} /> PDF</button>
                <button type="button" className="pilot-btn ghost small" disabled={!load} onClick={() => void startEdit(resume.id)}>Edit</button>
                <button type="button" className="pilot-btn ghost small" aria-label={`Delete ${resume.title}`} onClick={() => void remove(resume)}><Trash2 size={13} /></button>
              </div>
            )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>{resumes === null ? 'Loading…' : 'No generated résumés yet. Create one from your ONE record.'}</p>}
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Uploaded résumés</h2><span className="pilot-chip slate">{uploaded.length}</span></div>
          <div className="pilot-list">
            {uploaded.length ? uploaded.map((doc) => (
              <div key={doc.id} className="pilot-list-row">
                <span className="pilot-tile teal" style={{ width: 34, height: 34 }}><FileText size={15} /></span>
                <div className="grow"><strong style={{ fontSize: 12.5 }}>{doc.title}</strong><small>{doc.file ? doc.file.filename : 'No file attached yet'} · {documentVerificationLabel(doc).toLowerCase()}</small></div>
                <button type="button" className="pilot-btn ghost small" onClick={() => go('/student/documents')}>Open</button>
              </div>
            )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>No uploaded résumé documents. Uploads live under Documents.</p>}
          </div>
        </section>
      </> : null}

      {!builder && tab === 1 ? <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          {(load?.templates ?? []).map((template) => (
            <section key={template.key} className="pilot-card">
              <div className="pilot-card-head"><h2>{template.name}</h2></div>
              <p style={{ color: 'var(--p-muted)', marginTop: 0, fontSize: 12.5 }}>{template.description}</p>
              {example ? <div style={{ maxHeight: 260, overflow: 'hidden', marginBottom: 10 }}><ResumePaper content={example.content} template={template.key} compact /></div> : null}
              <button type="button" className="pilot-btn small" onClick={() => startNew(template.key)}>Use {template.name}</button>
            </section>
          ))}
        </div>
        {!load && !loadFailed ? <p style={{ color: 'var(--p-muted)' }}>Loading templates…</p> : null}
        <PublishedContentCard contentType="RESUME_BUILDER" title="Resume guidance" />
      </> : null}

      {!builder && tab === 2 ? <>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Examples</h2><span className="pilot-chip blue">Your own record</span></div>
          <p style={{ color: 'var(--p-muted)', marginTop: 0 }}>Each template filled with your own record as it stands — never a made-up person. Term results and career objective stay out until you tick them in the builder.</p>
        </section>
        {example ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
          {(load?.templates ?? []).map((template) => <div key={template.key}><h3 style={{ fontSize: 13, margin: '0 0 6px' }}>{template.name}</h3><ResumePaper content={example.content} template={template.key} compact /></div>)}
        </div> : <p style={{ color: 'var(--p-muted)' }}>{loadFailed ? 'NA — your record could not be loaded.' : 'Preparing examples…'}</p>}
      </> : null}

      {!builder && tab === 3 ? (
        <section className="pilot-card" style={{ maxWidth: 720 }}>
          <div className="pilot-card-head"><h2>Resume checks</h2><span className="pilot-chip slate">Checklist</span></div>
          <p style={{ color: 'var(--p-muted)', marginTop: 0 }}>ONE does not give résumés a number. These are plain checks on your record as a first résumé would show it; each says what to add.</p>
          {checks ? <ResumeChecksList checks={checks} /> : <p style={{ color: 'var(--p-muted)' }}>{loadFailed ? 'NA — your record could not be loaded.' : 'Checking…'}</p>}
        </section>
      ) : null}
    </div>
    {!wide ? <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Resume Overview</h2><span className="pilot-chip blue">Live</span></div>
        <div className="pilot-detail-rows">
          <div><small>Generated</small><strong>{resumes === null ? 'NA' : generated.length}</strong></div>
          <div><small>Saved versions</small><strong>{resumes === null ? 'NA' : generated.reduce((sum, resume) => sum + resume.versionCount, 0)}</strong></div>
          <div><small>Uploaded</small><strong>{documents === null ? 'NA' : uploaded.length}</strong></div>
          <div><small>Verified education</small><strong>{load ? load.sources.qualifications.filter((q) => q.verified).length : 'NA'}</strong></div>
        </div>
        <small style={{ display: 'block', marginTop: 10, color: 'var(--p-muted)' }}>Counts of your own records. ONE does not grade résumés.</small>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recent Resumes</h2><span className="pilot-chip blue">{generated.length + uploaded.length}</span></div>
        <div className="pilot-list">
          {generated.length || uploaded.length ? [
            ...generated.map((resume) => ({ id: resume.id, title: resume.title, note: `generated · version ${resume.latestVersion}` })),
            ...uploaded.map((doc) => ({ id: doc.id, title: doc.title, note: `uploaded · ${documentVerificationLabel(doc).toLowerCase()}` })),
          ].slice(0, 3).map((row) => (
            <div key={row.id} className="pilot-list-row">
              <span className="pilot-tile blue" style={{ width: 34, height: 34 }}><FileText size={15} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{row.title}</strong><small>{row.note}</small></div>
            </div>
          )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>None yet.</p>}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Still to add</h2><span className="pilot-chip slate">Checklist</span></div>
        {checks ? (checks.some((check) => !check.passed)
          ? <ResumeChecksList checks={checks.filter((check) => !check.passed).slice(0, 4)} />
          : <p style={{ margin: 0 }}>Every check passes.</p>) : <p style={{ color: 'var(--p-muted)', margin: 0 }}>NA</p>}
      </section>
      <NaListCard title="Resume Tips" note="Curated resume tips are not live yet — NA." />
    </aside> : null}
  </div></div>;
}

function templateName(load: ResumeLoad | null, key: ResumeTemplateKey): string {
  return (load?.templates ?? []).find((template) => template.key === key)?.name ?? key.charAt(0) + key.slice(1).toLowerCase();
}

function formatDay(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : value;
}

// --- Institution Interventions ----------------------------------------------
