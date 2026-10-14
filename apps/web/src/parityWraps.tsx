import { useEffect, useState } from 'react';
import { Icon } from './icons/Icon.js';
import { MultiRing, Ring } from './pilot/pilotComponents.js';
import { codeLabel } from './labels.js';
import {
  getLearnerCareerReadinessState,
  getProtectedAccessToken,
  getStudentProfile,
  listStudentExams,
  type LearnerCareerReadinessState,
  type StudentExamDto,
  type StudentProfileDto,
} from './api.js';

/**
 * Pilot-exact conversions for the nine functional pages that kept a V2 body:
 * the pilot page's head and rail are reproduced around the REAL functional
 * panel, embedded unchanged so no workflow is lost. Rails show real values
 * where an engine exists; a rail card with no source is hidden. Tips copy from
 * the pilot is retained (it is guidance text, not data).
 */

function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function PilotShell({ title, subtitle, rail, wide = false, children }: {
  readonly title: string; readonly subtitle: string; readonly rail?: React.ReactNode;
  readonly wide?: boolean; readonly children: React.ReactNode;
}): React.ReactElement {
  return <div className="pilot pilot-embed"><div className="pilot-page" style={wide || !rail ? { gridTemplateColumns: '1fr' } : undefined}>
    <div className="pilot-content">
      <div className="pilot-page-head"><div><h1>{title}</h1><p>{subtitle}</p></div></div>
      <div className="embedded-real">{children}</div>
    </div>
    {rail ? <aside className="pilot-rail">{rail}</aside> : null}
  </div></div>;
}

function useLearner(): LearnerCareerReadinessState | null {
  const token = getProtectedAccessToken();
  const [learner, setLearner] = useState<LearnerCareerReadinessState | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void getLearnerCareerReadinessState(token, controller.signal).then(setLearner).catch(() => setLearner(null));
    return () => controller.abort();
  }, [token]);
  return learner;
}

// --- Student: My Roadmap -----------------------------------------------------

export function StudentRoadmapV3({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const learner = useLearner();
  const actions = learner?.roadmap ?? [];
  const done = actions.filter((action) => action.state === 'COMPLETED').length;
  const progress = actions.length ? Math.round((done / actions.length) * 100) : null;
  // Progress shows only once the roadmap has actions. Milestones have no source yet, so neither a
  // milestone count nor an "Upcoming Milestones" card is drawn.
  return <PilotShell title="My Roadmap" subtitle="Your personalized path toward your target career." rail={<>
    {progress !== null ? <section className="pilot-card" style={{ textAlign: 'center' }}>
      <h2 style={{ textAlign: 'left' }}>Roadmap Progress</h2>
      <Ring value={progress} size={112} stroke={12}><span style={{ fontSize: 21 }}>{`${progress}%`}</span></Ring>
      <div className="pilot-row cols-2" style={{ marginTop: 12 }}>
        <div><b style={{ fontSize: 17 }}>{done}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Tasks Completed</small></div>
        <div><b style={{ fontSize: 17 }}>{actions.length}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Total Tasks</small></div>
      </div>
    </section> : null}
    <section className="pilot-card">
      <h2>Recommended Next</h2>
      <div style={{ display: 'flex', gap: 12 }}>
        <span className="pilot-tile purple"><Icon name="coach" size={20} /></span>
        <div>
          <strong style={{ fontSize: 13 }}>{actions.length ? codeLabel(actions[0]!.actionCode) : 'Complete a lesson'}</strong>
          <small style={{ display: 'block', color: 'var(--p-muted)', margin: '3px 0 8px' }}>{actions.length ? 'Your next advisory action from real evidence.' : 'Advisory actions appear as your evidence grows.'}</small>
          <button type="button" className="pilot-btn soft small" onClick={() => go('/student/learning')}>Open Learning <Icon name="arrow-right" size={16} /></button>
        </div>
      </div>
    </section>
    <section className="pilot-card">
      <h2>Roadmap Tips</h2>
      <div className="pilot-list">
        {['Finish lessons in order — prerequisites unlock later ones.', 'Attempt every assigned assessment; results feed your band.', 'Keep your profile current so guidance stays relevant.'].map((tip) => (
          <div key={tip} className="pilot-list-row" style={{ padding: '8px 2px' }}>
            <Icon name="check" size={16} style={{ color: "var(--brand)" }} />
            <small style={{ color: 'var(--p-ink-2)' }}>{tip}</small>
          </div>
        ))}
      </div>
    </section>
  </>}>{children}</PilotShell>;
}

// --- Student: Ask ONE to explain (ADR-052) ------------------------------------

export function StudentExplainV3({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <PilotShell title="Ask ONE to explain" subtitle="AI-written lessons on any topic you name — AI-generated, not checked by a person." wide>{children}</PilotShell>;
}

// --- Student: Learn ----------------------------------------------------------

export function StudentLearningV3({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const learner = useLearner();
  const lessons = learner?.catalog?.modules?.flatMap((module) => module.lessons ?? []) ?? [];
  const completed = learner?.progress?.filter((item) => item.state === 'COMPLETED').length ?? 0;
  const notStarted = Math.max(0, lessons.length - completed);
  const percent = lessons.length ? Math.round((completed / lessons.length) * 100) : null;
  const modules = learner?.catalog?.modules ?? [];
  // Progress shows once there are published lessons ("In Progress" has no source, so it is not drawn);
  // weekly goals have no source and are not drawn; the module list shows only when modules exist.
  const rail = percent !== null || modules.length ? <>
    {percent !== null ? <section className="pilot-card">
      <div className="pilot-card-head"><h2>Learning Progress</h2><button type="button" className="pilot-link" onClick={() => go('/student/readiness')}>View Details</button></div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <MultiRing segments={[
          { value: completed, color: 'var(--ok)' },
          { value: notStarted, color: 'var(--band-1)' },
        ]}>{`${percent}%`}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Overall</div></MultiRing>
        <div className="pilot-legend" style={{ flex: 1 }}>
          <div><i style={{ background: 'var(--ok)' }} /> Completed <span className="num">{completed}</span></div>
          <div><i style={{ background: 'var(--band-1)' }} /> Not Started <span className="num">{notStarted}</span></div>
        </div>
      </div>
    </section> : null}
    {modules.length ? <section className="pilot-card">
      <div className="pilot-card-head"><h2>Recommended for You</h2></div>
      <div className="pilot-list">
        {modules.slice(0, 3).map((module) => (
          <div key={module.id} className="pilot-list-row">
            <span className="pilot-tile teal"><Icon name="learning" size={16} /></span>
            <div className="grow"><strong>{module.title}</strong><small>{module.lessons.length} lessons</small></div>
          </div>
        ))}
      </div>
    </section> : null}
  </> : undefined;
  return <PilotShell title="Learn" subtitle="Courses and lessons that build your readiness evidence." rail={rail}>{children}</PilotShell>;
}

// --- Student: Assessments ----------------------------------------------------

export function StudentAssessmentsV3({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [exams, setExams] = useState<readonly StudentExamDto[]>([]);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listStudentExams(token, controller.signal).then((response) => setExams(response.assessments)).catch(() => setExams([]));
    return () => controller.abort();
  }, [token]);
  const results = exams.filter((exam) => exam.latestResult);
  const high = results.filter((exam) => exam.latestResult!.percentage >= 70).length;
  const medium = results.filter((exam) => exam.latestResult!.percentage >= 40 && exam.latestResult!.percentage < 70).length;
  const low = results.filter((exam) => exam.latestResult!.percentage < 40).length;
  const average = results.length ? Math.round(results.reduce((sum, exam) => sum + exam.latestResult!.percentage, 0) / results.length) : null;
  return <PilotShell title="Assessments" subtitle="Scheduled, available and completed assessments for your goal." rail={<>
    {average !== null ? <section className="pilot-card">
      <div className="pilot-card-head"><h2>Performance Summary</h2><small style={{ color: 'var(--p-muted)' }}>Published results</small></div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <MultiRing segments={[
          { value: high, color: 'var(--ok)' }, { value: medium, color: 'var(--orange)' }, { value: low, color: 'var(--danger)' },
        ]}>{`${average}%`}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Average</div></MultiRing>
        <div className="pilot-legend" style={{ flex: 1 }}>
          <div><i style={{ background: 'var(--ok)' }} /> High (&gt;= 70%) <span className="num">{high}</span></div>
          <div><i style={{ background: 'var(--orange)' }} /> Medium (40–69%) <span className="num">{medium}</span></div>
          <div><i style={{ background: 'var(--danger)' }} /> Low (&lt; 40%) <span className="num">{low}</span></div>
        </div>
      </div>
    </section> : null}
    <section className="pilot-card">
      <div className="pilot-card-head"><h2>Recent Test Activity</h2></div>
      <div className="pilot-list">
        {results.length ? results.slice(0, 4).map((exam) => (
          <div key={exam.id} className="pilot-list-row">
            <span className="pilot-tile indigo" style={{ width: 34, height: 34 }}><Icon name="assessments" size={16} /></span>
            <div className="grow"><strong style={{ fontSize: 12.5 }}>{exam.title}</strong><small>{exam.subjectName}</small></div>
            <span className={`pilot-chip ${exam.latestResult!.percentage >= 70 ? 'green' : exam.latestResult!.percentage >= 40 ? 'amber' : 'rose'}`}>{exam.latestResult!.percentage}%</span>
          </div>
        )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>No published results yet.</p>}
      </div>
    </section>
  </>}>{children}</PilotShell>;
}

// --- Student: Opportunities --------------------------------------------------

export function StudentOpportunitiesV3({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  // Opportunity insights by category have no source yet, so that card is not drawn.
  return <PilotShell title="Opportunities" subtitle="Real openings from real employers, matched to your consent choices." rail={<>
    <section className="pilot-card">
      <h2>Application Tips</h2>
      <div className="pilot-list">
        {['Apply early — deadlines close applications automatically.', 'Applying shares your profile for that role only.', 'You can withdraw any time; it ends the employer’s access.'].map((tip) => (
          <div key={tip} className="pilot-list-row" style={{ padding: '8px 2px' }}>
            <Icon name="check" size={16} style={{ color: "var(--brand)" }} />
            <small style={{ color: 'var(--p-ink-2)' }}>{tip}</small>
          </div>
        ))}
      </div>
    </section>
  </>}>{children}</PilotShell>;
}

// --- Student: Profile --------------------------------------------------------

export function StudentProfileV3({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [profile, setProfile] = useState<StudentProfileDto | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void getStudentProfile(token, controller.signal).then((response) => setProfile(response.profile)).catch(() => setProfile(null));
    return () => controller.abort();
  }, [token]);
  const fields = profile ? [profile.targetCareer, profile.profileHeadline, profile.profileSummary, profile.portfolioUrl, profile.careerInterests.length ? 'x' : null] : [];
  const completeness = profile ? Math.round((fields.filter(Boolean).length / fields.length) * 100) : null;
  return <PilotShell title="Profile" subtitle="Your living record — what your placement cell works from and employers see when you share it." rail={<>
    {completeness !== null ? <section className="pilot-card" style={{ textAlign: 'center' }}>
      <h2 style={{ textAlign: 'left' }}>Profile Completeness</h2>
      <Ring value={completeness} size={104} stroke={11} tone="blue"><span style={{ fontSize: 20 }}>{`${completeness}%`}</span></Ring>
      <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>Based on your real profile fields — target career, headline, summary, portfolio, interests.</small>
    </section> : null}
    <section className="pilot-card">
      <h2>Profile Tips</h2>
      <div className="pilot-list">
        {['A clear target career anchors your roadmap.', 'Your headline is the first line recruiters read.', 'Sharing is always your explicit choice — QR or link.'].map((tip) => (
          <div key={tip} className="pilot-list-row" style={{ padding: '8px 2px' }}>
            <Icon name="check" size={16} style={{ color: "var(--brand)" }} />
            <small style={{ color: 'var(--p-ink-2)' }}>{tip}</small>
          </div>
        ))}
      </div>
    </section>
  </>}>{children}</PilotShell>;
}

// --- Staff wrappers (full-width pilot shells) --------------------------------

export function StaffPilotWrap({ title, subtitle, children }: {
  readonly title: string; readonly subtitle: string; readonly children: React.ReactNode;
}): React.ReactElement {
  return <PilotShell title={title} subtitle={subtitle} wide>{children}</PilotShell>;
}
