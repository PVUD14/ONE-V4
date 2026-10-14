import { useState } from 'react';
import { Icon, type IconName } from '../icons/Icon.js';
import { MultiRing, Ring, Spark, WeekBars, toneColor, toneMix } from './pilotComponents.js';
import { DetailRows, OverlayForm, PilotTabs, downloadCsv, listModal, useOverlay } from './pilotOverlay.js';
import { usePilotSession } from './pilotSession.js';
import { PhotoUploadControl, PilotAvatar, shareProfileModal } from './pilotShare.js';
import {
  tabAllTests, tabBookmarks, tabCategoryRoles, tabCertificateRecords, tabCertificates,
  tabEducation, tabInternships, tabMyLearning, tabPastAttempts, tabProjects, tabScoreTrend,
} from './pilotTabData.js';
import {
  pilotAchievements, pilotBadges, pilotCanon, pilotCompanies, pilotContinueLearning,
  pilotDemandSkills, pilotDrives, pilotImprovements, pilotLearnRecommended,
  pilotLearningPaths, pilotLearningProgress, pilotLeftOff, pilotMilestones,
  pilotOpportunities, pilotOpportunityCategories, pilotPersona, pilotPopularCourses,
  pilotProfileChecklist, pilotProfileTips, pilotRecentActivity, pilotRecentTests,
  pilotRecommendedCourses, pilotRecommendedTests, pilotRoadmapPhases, pilotRoadmapSteps,
  pilotRoadmapTips, pilotSavedOpportunities, pilotScoreDistribution, pilotScores,
  pilotSkills, pilotStrengths, pilotTestCategories, pilotTodayPlan, pilotUpcoming,
  pilotUpcomingTests, pilotWeekProgress,
} from './pilotData.js';

/** All six Tier 1 pages. Presentation over the pilot dataset; no real records touched. */

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** The real application's advisory bands, lowest first. Readiness is never a number. */
const READINESS_LADDER: readonly string[] = ['Not enough evidence', 'Developing', 'Progressing', 'Ready for next step'];

export function PilotDashboard(): React.ReactElement {
  const canon = pilotCanon;
  const overlay = useOverlay();
  const session = usePilotSession();
  const [doneTasks, setDoneTasks] = useState<ReadonlySet<string>>(() => new Set(pilotTodayPlan.filter((task) => task.done).map((task) => task.title)));
  const toggleTask = (title: string): void => {
    setDoneTasks((previous) => {
      const next = new Set(previous);
      if (next.has(title)) next.delete(title); else { next.add(title); overlay.toast(`${title} marked done (sample).`); }
      return next;
    });
  };
  const baseGoalCompanies = pilotCompanies.slice(0, 4);
  const extraGoalCompanies = pilotCompanies.filter((company) => session.goalCompanies.includes(company.name));
  const remaining = pilotCompanies.filter((company) => !baseGoalCompanies.includes(company) && !session.goalCompanies.includes(company.name));
  const openAddCompany = (): void => {
    overlay.openModal({
      title: 'Add a target company', subtitle: 'Companies hiring for your goal', body: <div className="pilot-list">
        {remaining.length === 0 ? <p className="pilot-modal-text">All sample companies are already on your goal list.</p> : remaining.map((company) => (
          <div key={company.name} className="pilot-list-row" style={{ padding: '8px 2px' }}>
            <span className={`pilot-mark ${company.tone}`} style={{ width: 32, height: 32, fontSize: 11 }}>{company.mark}</span>
            <div className="grow"><strong style={{ fontSize: 12.5 }}>{company.name}</strong></div>
            <button type="button" className="pilot-btn ghost small"
              onClick={(event) => { event.stopPropagation(); session.addGoalCompany(company.name); overlay.closeModal(); overlay.toast(`${company.name} added to your career goal (sample).`); }}>Add</button>
          </div>
        ))}
      </div>,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Good morning, {pilotPersona.firstName}! 👋</h1>
          <p>Let&apos;s continue your journey and get one step closer to your dream career.</p>
        </div>
        <button type="button" className="pilot-btn ghost"><Icon name="calendar-small" size={16} /> View Calendar</button>
      </div>

      <div className="pilot-row" style={{ gridTemplateColumns: 'minmax(0, 2.4fr) repeat(5, minmax(0, 1fr))' }}>
        <section className="pilot-card">
          <h2>Career Readiness</h2>
          <div style={{ minWidth: 0 }}>
            <span style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1 }}>{canon.readinessBand}</span>
            <small style={{ display: 'block', color: 'var(--p-muted)', marginTop: 3 }}>Advisory band · never a score · never shown to employers</small>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginTop: 9 }} role="img" aria-label={`Readiness band ladder: ${canon.readinessBand}`}>
              {READINESS_LADDER.map((band) => (
                <span key={band} title={band} style={{ height: 7, borderRadius: 999, background: READINESS_LADDER.indexOf(band) <= READINESS_LADDER.indexOf(canon.readinessBand) ? 'var(--p-blue)' : '#edf1f7' }} />
              ))}
            </div>
            <div style={{ marginTop: 11 }}><button type="button" className="pilot-btn soft small">View Full Report</button></div>
          </div>
        </section>
        {pilotScores.map((score) => (
          <section key={score.label} className="pilot-card pilot-score-card">
            <header>{score.label}</header>
            <Ring value={score.value} size={62} stroke={7} tone={score.tone}><span style={{ fontSize: 12 }}>{score.value}</span></Ring>
            <div className="value">{score.value}<span>/100</span></div>
            <span className={`pilot-chip ${score.tone === 'green' || score.tone === 'blue' ? 'green' : 'amber'}`}>{score.band}</span>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-3">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Today&apos;s Plan</h2><span className="pilot-chip blue">4 Tasks</span></div>
          <div className="pilot-list">
            {pilotTodayPlan.map((task) => (
              <div key={task.title} className="pilot-list-row">
                <button type="button" className="pilot-check" aria-label={`Mark ${task.title} done`}
                  onClick={(event) => { event.stopPropagation(); toggleTask(task.title); }}>
                  <Icon name="check" size={16} style={{ color: doneTasks.has(task.title) ? '#12996b' : '#c2ccda' }} />
                </button>
                <div className="grow"><strong style={doneTasks.has(task.title) ? { color: 'var(--p-muted)' } : undefined}>{task.title}</strong></div>
                <small>{task.minutes} min</small>
              </div>
            ))}
          </div>
          <button type="button" className="pilot-btn soft small" style={{ marginTop: 10 }}>View Full Plan</button>
        </section>

        <section className="pilot-card">
          <h2>Continue Learning</h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="pilot-tile purple"><Icon name="learning" size={20} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ fontSize: 13 }}>Data Structures in C</strong>
              <small style={{ display: 'block', color: 'var(--p-muted)' }}>Arrays and Strings</small>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
            <div className="pilot-bar" style={{ flex: 1 }}><i style={{ width: '66%' }} /></div>
            <small style={{ color: 'var(--p-muted)' }}>66%</small>
          </div>
          <button type="button" className="pilot-btn soft small"><Icon name="arrow-right" size={16} /> Resume Lesson</button>
        </section>

        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Upcoming</h2><button type="button" className="pilot-link"
            onClick={(event) => { event.stopPropagation(); overlay.openModal(listModal('Upcoming This Week', `${pilotUpcoming.length + pilotDrives.length} scheduled items`, [...pilotUpcoming.map((item) => ({ title: item.title, detail: item.when })), ...pilotDrives.map((drive) => ({ title: drive.title, detail: `${drive.company} · ${drive.mode}`, trailing: drive.date }))])); }}>View All</button></div>
          <div className="pilot-list">
            {pilotUpcoming.map((item) => (
              <div key={item.title} className="pilot-list-row">
                <span className="pilot-tile blue"><Icon name="calendar" size={16} /></span>
                <div className="grow"><strong>{item.title}</strong><small>{item.when}</small></div>
                <Icon name="arrow-right" size={16} style={{ color: "#98a5ba" }} />
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Recommended for You</h2><button type="button" className="pilot-link">View All</button></div>
          <div className="pilot-row cols-4">
            {pilotRecommendedCourses.map((course) => (
              <div key={course.title} className="pilot-course-card">
                <span className="pilot-tile" style={{ background: toneMix(course.tone, 10), color: toneColor(course.tone) }}><Icon name="learning" size={20} /></span>
                <strong>{course.title}</strong>
                <small>{course.lessons} Lessons</small>
                <button type="button" className="pilot-btn soft small">Start</button>
              </div>
            ))}
          </div>
        </section>

        <section className="pilot-card">
          <h2>Quick Actions</h2>
          <div className="pilot-row cols-2">
            {[
              ['Take a Mock Test', 'assessments'], ['Practice Questions', 'targets'],
              ['Build Resume', 'resume'], ['Explore Roles', 'opportunities'],
              ['Update Profile', 'profile'], ['View Scholarships', 'scholarships'],
            ].map(([label, glyph]) => (
              <button key={label as string} type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}>
                <Icon name={glyph as IconName} size={16} />
                {label as string}
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <h2>Recent Activity</h2>
          <div className="pilot-list">
            {pilotRecentActivity.map((entry) => (
              <div key={entry.title} className="pilot-list-row">
                <span className={`pilot-tile ${entry.tone}`}><Icon name="analytics" size={16} /></span>
                <div className="grow"><strong>{entry.title}</strong></div>
                <small>{entry.when}</small>
              </div>
            ))}
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Badges Earned</h2><button type="button" className="pilot-link"
            onClick={(event) => { event.stopPropagation(); overlay.openModal(listModal('All Badges', `${pilotBadges.length} earned so far`, pilotBadges.map((badge) => ({ title: badge.label, detail: 'Earned this term' })))); }}>View All Badges</button></div>
          <div className="pilot-row cols-4">
            {pilotBadges.map((badge) => (
              <div key={badge.label} style={{ textAlign: 'center' }}>
                <span className={`pilot-tile ${badge.tone}`} style={{ margin: '0 auto 8px' }}><Icon name="offers" size={20} /></span>
                <small style={{ display: 'block', fontSize: 11, color: 'var(--p-ink-2)', fontWeight: 600 }}>{badge.label}</small>
              </div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--p-line)', marginTop: 14, paddingTop: 14 }}>
            <div className="pilot-card-head" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 13.5 }}>Career Goal · {pilotPersona.careerGoal}</h2><button type="button" className="pilot-link">Change Goal</button></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[...baseGoalCompanies, ...extraGoalCompanies].map((company) => (
                <span key={company.name} className={`pilot-chip ${company.tone}`}>{company.mark} · {company.name}</span>
              ))}
              <button type="button" className="pilot-chip slate" style={{ border: 0, cursor: 'pointer', font: 'inherit' }}
                onClick={(event) => { event.stopPropagation(); openAddCompany(); }}>+ Add More</button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head">
          <h2><Icon name="skills" size={16} style={{ color: "#f59e0b", verticalAlign: '-2px' }} /> {pilotCanon.streakDays} Day Streak</h2>
          <small style={{ color: 'var(--p-muted)' }}>Keep it up!</small>
        </div>
        <div className="pilot-streak-days">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
            <i key={index} className={index === 6 ? 'off' : ''}>{index === 6 ? day : '✓'}</i>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Your Progress This Week</h2><span className="pilot-chip blue">72%</span></div>
        <Spark points={pilotWeekProgress} />
      </section>
      <div className="pilot-quote">&ldquo;Discipline today. Success tomorrow.&rdquo;</div>
    </aside>
  </div>;
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

const PHASE_STEPS: Readonly<Record<string, readonly { readonly title: string; readonly detail: string; readonly status: 'completed' | 'current' | 'locked'; readonly score?: number; readonly progress?: number }[]>> = {
  Foundation: pilotRoadmapSteps,
  'Core Skills': [
    { title: 'Data Structures and Algorithms', detail: 'Trees, Graphs, Sorting, Searching', status: 'completed', score: 72 },
    { title: 'Advanced SQL', detail: 'Window functions, indexing, query tuning', status: 'current', progress: 35 },
    { title: 'API Development Basics', detail: 'REST, HTTP, JSON, versioning', status: 'locked' },
    { title: 'Version Control with Git', detail: 'Branching, merging, pull requests', status: 'locked' },
  ],
  Specialization: [
    { title: 'Backend Engineering Track', detail: 'Node.js, databases, deployment', status: 'locked' },
    { title: 'Cloud Fundamentals', detail: 'Compute, storage, networking basics', status: 'locked' },
    { title: 'System Design Basics', detail: 'Scaling, caching, load balancing', status: 'locked' },
  ],
  'Practice & Projects': [
    { title: 'Build a Portfolio Project', detail: 'End-to-end app with documentation', status: 'locked' },
    { title: 'Open Source Contribution', detail: 'One merged pull request', status: 'locked' },
    { title: 'Timed Coding Practice', detail: '100 problems across difficulty bands', status: 'locked' },
  ],
  'Career Ready': [
    { title: 'Resume and Portfolio Review', detail: 'Reviewed by placement cell', status: 'locked' },
    { title: 'Mock Interview Circuit', detail: 'Three rounds with feedback', status: 'locked' },
    { title: 'Application Sprint', detail: 'Apply to matched roles with tracking', status: 'locked' },
  ],
};

export function PilotRoadmap(): React.ReactElement {
  const roadmap = pilotCanon.roadmap;
  const overlay = useOverlay();
  const [activePhase, setActivePhase] = useState('Foundation');
  const phaseSteps = PHASE_STEPS[activePhase] ?? pilotRoadmapSteps;
  const openReview = (step: { readonly title: string; readonly detail: string; readonly score?: number }): void => {
    overlay.openModal({
      title: step.title, subtitle: 'Completed step · review', body: <div>
        <DetailRows rows={[
          ['Score', `${step.score ?? 0}/100`],
          ['Covered', step.detail],
          ['Completed', 'This term'],
          ['Time spent', '~9 hours'],
        ]} />
        <p className="pilot-modal-text" style={{ marginTop: 12 }}><strong>Reviewer note:</strong> strong fundamentals; revisit edge cases in control flow before the next assessment.</p>
      </div>,
    });
  };
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div>
          <h1>My Roadmap</h1>
          <p>Your personalized path to become a {pilotPersona.careerGoal}</p>
        </div>
        <div style={{ display: 'flex', gap: 9 }}>
          <button type="button" className="pilot-btn ghost">Roadmap Settings</button>
          <button type="button" className="pilot-btn">Change Goal</button>
        </div>
      </div>

      <section className="pilot-card">
        <div className="pilot-row cols-3">
          <div style={{ display: 'flex', gap: 13, alignItems: 'center' }}>
            <span className="pilot-tile green"><Icon name="targets" size={20} /></span>
            <div>
              <small style={{ color: 'var(--p-muted)' }}>Current Goal</small>
              <strong style={{ display: 'block', fontSize: 16 }}>{pilotPersona.careerGoal}</strong>
              <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
                {pilotCompanies.slice(0, 3).map((company) => <span key={company.mark} className={`pilot-chip ${company.tone}`}>{company.mark}</span>)}
                <span className="pilot-chip slate">+3</span>
              </div>
            </div>
          </div>
          <div>
            <small style={{ color: 'var(--p-muted)' }}>Overall Progress</small>
            <strong style={{ display: 'block', fontSize: 24 }}>{roadmap.progress}%</strong>
            <div className="pilot-bar" style={{ margin: '8px 0 6px' }}><i style={{ width: `${roadmap.progress}%` }} /></div>
            <small style={{ color: 'var(--p-muted)' }}>You&apos;re progressing well! Keep it up.</small>
          </div>
          <div>
            <small style={{ color: 'var(--p-muted)' }}>Estimated Time to Goal</small>
            <strong style={{ display: 'block', fontSize: 24 }}>{roadmap.monthsToGoal} <span style={{ fontSize: 13, fontWeight: 600 }}>months</span></strong>
            <span className="pilot-chip green" style={{ marginTop: 7 }}>On track</span>
          </div>
        </div>
      </section>

      <div className="pilot-phases">
        {pilotRoadmapPhases.map((phase) => (
          <button key={phase.label} type="button" className={`pilot-phase ${activePhase === phase.label ? 'active' : ''}`}
            onClick={(event) => { event.stopPropagation(); setActivePhase(phase.label); }}>
            <span className={`pilot-tile ${activePhase === phase.label ? 'green' : 'blue'}`} style={{ width: 32, height: 32 }}><Icon name="assessments" size={16} /></span>
            <div><strong>{phase.label}</strong><small>{phase.done} / {phase.total} Completed</small></div>
          </button>
        ))}
      </div>

      <div>
        {phaseSteps.map((step, index) => (
          <div key={step.title} className={`pilot-step ${step.status}`}>
            <div className="pilot-step-line"><span className="pilot-step-no">{step.status === 'completed' ? '✓' : index + 1}</span></div>
            <div className="pilot-step-card">
              <div className="grow">
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
                {step.status === 'current' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 7 }}>
                    <div className="pilot-bar thin" style={{ flex: 1, maxWidth: 220 }}><i style={{ width: `${step.progress}%` }} /></div>
                    <small>{step.progress}%</small>
                  </div>
                ) : null}
              </div>
              {step.status === 'completed' ? (
                <>
                  <span className="pilot-chip green">Completed</span>
                  <small style={{ color: 'var(--p-muted)' }}>Score <b>{step.score}/100</b></small>
                  <button type="button" className="pilot-btn ghost small"
                    onClick={(event) => { event.stopPropagation(); openReview(step); }}>Review</button>
                </>
              ) : step.status === 'current' ? (
                <button type="button" className="pilot-btn small">Continue</button>
              ) : (
                <span className="pilot-chip slate"><Icon name="lock" size={16} /> Locked</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Roadmap Progress</h2>
        <Ring value={roadmap.progress} size={112} stroke={12}><span style={{ fontSize: 21 }}>{roadmap.progress}%</span></Ring>
        <div className="pilot-row cols-3" style={{ marginTop: 12 }}>
          <div><b style={{ fontSize: 17 }}>{roadmap.tasksDone}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Tasks Completed</small></div>
          <div><b style={{ fontSize: 17 }}>{roadmap.tasksTotal}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Total Tasks</small></div>
          <div><b style={{ fontSize: 17 }}>{roadmap.milestones}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Milestones</small></div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Milestones</h2></div>
        {pilotMilestones.map((milestone) => (
          <div key={milestone.title} className="pilot-skill">
            <header><b>{milestone.title}</b><span>{milestone.progress}%</span></header>
            <small style={{ color: 'var(--p-muted)', display: 'block', marginBottom: 5 }}>{milestone.target}</small>
            <div className="pilot-bar thin"><i style={{ width: `${milestone.progress}%` }} /></div>
          </div>
        ))}
        <button type="button" className="pilot-link" style={{ marginTop: 6 }}>View All Milestones</button>
      </section>
      <section className="pilot-card">
        <h2>Recommended Next</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <span className="pilot-tile purple"><Icon name="coach" size={20} /></span>
          <div>
            <strong style={{ fontSize: 13 }}>Practice Array Problems</strong>
            <small style={{ display: 'block', color: 'var(--p-muted)', margin: '3px 0 8px' }}>Strengthen your problem solving skills with arrays.</small>
            <button type="button" className="pilot-btn soft small">Start Practice <Icon name="arrow-right" size={16} /></button>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <h2>Roadmap Tips</h2>
        <div className="pilot-list">
          {pilotRoadmapTips.map((tip) => (
            <div key={tip} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <Icon name="check" size={16} style={{ color: "#1f55e5" }} />
              <small style={{ color: 'var(--p-ink-2)' }}>{tip}</small>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}

// ---------------------------------------------------------------------------
// Learn
// ---------------------------------------------------------------------------

export function PilotLearn(): React.ReactElement {
  const overlay = useOverlay();
  const [tab, setTab] = useState(0);
  return <div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Learn</h1><p>Build skills with our expert-led courses and learning paths.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'My Learning', 'Learning Paths', 'Bookmarks', 'Certificates']} active={tab} onChange={setTab} />

      {tab === 1 ? (
        <section className="pilot-card">
          <h2>My Learning</h2>
          <div className="pilot-list">
            {tabMyLearning.map((course) => (
              <div key={course.title} className="pilot-list-row">
                <span className="pilot-tile purple"><Icon name="learning" size={16} /></span>
                <div className="grow"><strong>{course.title}</strong><small>{course.detail}</small></div>
                <div className="pilot-bar thin" style={{ width: 110 }}><i style={{ width: `${course.progress}%` }} /></div>
                <button type="button" className="pilot-btn ghost small">Resume</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 2 ? (
        <section className="pilot-card">
          <h2>Learning Paths</h2>
          <div className="pilot-row cols-2">
            {pilotLearningPaths.map((path) => (
              <div key={path.title} className="pilot-course-card">
                <span className="pilot-tile blue"><Icon name="targets" size={20} /></span>
                <strong>{path.title}</strong>
                <small>{path.detail}</small>
                <small>{path.courses} Courses · {path.hours} hrs</small>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="pilot-bar thin green" style={{ flex: 1 }}><i style={{ width: `${path.progress}%` }} /></div>
                  <small>{path.progress}%</small>
                </div>
                <button type="button" className="pilot-btn ghost small">Continue Path</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 3 ? (
        <section className="pilot-card">
          <h2>Bookmarks</h2>
          <div className="pilot-list">
            {tabBookmarks.map((entry) => (
              <div key={entry.title} className="pilot-list-row">
                <Icon name="career" size={16} style={{ color: "#1f55e5" }} />
                <div className="grow"><strong>{entry.title}</strong><small>{entry.detail}</small></div>
                <button type="button" className="pilot-btn ghost small">Start</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 4 ? (
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Certificates</h2><span className="pilot-chip green">{tabCertificates.length} earned</span></div>
          <div className="pilot-list">
            {tabCertificates.map((certificate) => (
              <div key={certificate.title} className="pilot-list-row">
                <span className="pilot-tile green"><Icon name="offers" size={16} /></span>
                <div className="grow"><strong>{certificate.title}</strong><small>{certificate.detail} · {certificate.id}</small></div>
                <button type="button" className="pilot-btn ghost small" onClick={(event) => {
                  event.stopPropagation();
                  downloadCsv(`${certificate.id}.csv`, [
                    ['ONE by AI8HT — Course Completion Certificate (sample)'],
                    ['Certificate ID', certificate.id],
                    ['Awarded to', 'Arjun Reddy'],
                    ['Course', certificate.title],
                    ['Detail', certificate.detail],
                  ]);
                  overlay.toast(`${certificate.id} downloaded (sample certificate).`);
                }}><Icon name="download" size={16} /> Download</button>
              </div>
            ))}
          </div>
          <small style={{ color: 'var(--p-muted)', display: 'block', marginTop: 10 }}>Certificates are issued automatically when a course or assessment is completed.</small>
        </section>
      ) : null}

      {tab === 0 ? <>
      <section className="pilot-hero">
        <div>
          <small style={{ color: 'var(--p-muted)', fontWeight: 600 }}>Continue Learning</small>
          <h2>{pilotContinueLearning.course}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9, maxWidth: 380 }}>
            <div className="pilot-bar" style={{ flex: 1 }}><i style={{ width: `${pilotContinueLearning.progress}%` }} /></div>
            <small>{pilotContinueLearning.progress}% complete</small>
          </div>
          <small style={{ color: 'var(--p-muted)' }}>{pilotContinueLearning.minutesLeft} mins left</small>
        </div>
        <button type="button" className="pilot-btn"><Icon name="arrow-right" size={16} /> Continue</button>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Popular Courses</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); overlay.openModal(listModal('All Courses', `${pilotPopularCourses.length + pilotLearnRecommended.length} available`, [...pilotPopularCourses.map((course) => ({ title: course.title, detail: `${course.level} · ${course.rating} rating`, trailing: `${course.progress}%` })), ...pilotLearnRecommended.map((course) => ({ title: course.title, detail: `${course.level} · ${course.rating} rating`, trailing: 'New' }))])); }}>View All Courses →</button></div>
        <div className="pilot-row cols-5">
          {pilotPopularCourses.map((course) => (
            <div key={course.title} className="pilot-course-card">
              <div className="pilot-course-art" style={{ background: `linear-gradient(135deg, ${toneMix(course.tone, 80)}, ${toneColor(course.tone)})` }}><Icon name="learning" size={24} /></div>
              <strong>{course.title}</strong>
              <small><Icon name="offers" size={16} style={{ color: "#f59e0b", verticalAlign: '-1px' }} /> {course.rating} ({course.learners}) · {course.level}</small>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="pilot-bar thin" style={{ flex: 1 }}><i style={{ width: `${course.progress}%` }} /></div>
                <small>{course.progress}%</small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Learning Paths</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); setTab(2); }}>View All Paths →</button></div>
        <div className="pilot-row cols-4">
          {pilotLearningPaths.map((path) => (
            <div key={path.title} className="pilot-course-card">
              <span className="pilot-tile blue"><Icon name="targets" size={20} /></span>
              <strong>{path.title}</strong>
              <small>{path.detail}</small>
              <small>{path.courses} Courses · {path.hours} hrs</small>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="pilot-bar thin green" style={{ flex: 1 }}><i style={{ width: `${path.progress}%` }} /></div>
                <small>{path.progress}%</small>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Continue Where You Left Off</h2><button type="button" className="pilot-link">View All →</button></div>
        <div className="pilot-list">
          {pilotLeftOff.map((entry) => (
            <div key={entry.title} className="pilot-list-row">
              <span className="pilot-tile indigo"><Icon name="arrow-right" size={16} /></span>
              <div className="grow"><strong>{entry.title}</strong><small>{entry.course} · Last watched {entry.watched}</small></div>
              <div className="pilot-bar thin" style={{ width: 110 }}><i style={{ width: `${entry.progress}%` }} /></div>
              <small>{entry.progress}%</small>
              <button type="button" className="pilot-btn ghost small">Resume</button>
            </div>
          ))}
        </div>
      </section>
      </> : null}
    </div>

    {tab === 0 ? <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Learning Progress</h2><button type="button" className="pilot-link">View Details</button></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: pilotLearningProgress.completed, color: '#12996b' },
            { value: pilotLearningProgress.inProgress, color: '#1f55e5' },
            { value: pilotLearningProgress.notStarted, color: '#6d4fd8' },
          ]}>62%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Overall</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#12996b' }} /> Completed <span className="num">{pilotLearningProgress.completed}</span></div>
            <div><i style={{ background: '#1f55e5' }} /> In Progress <span className="num">{pilotLearningProgress.inProgress}</span></div>
            <div><i style={{ background: '#6d4fd8' }} /> Not Started <span className="num">{pilotLearningProgress.notStarted}</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Weekly Goal</h2><button type="button" className="pilot-link">Edit Goal</button></div>
        <small style={{ color: 'var(--p-muted)' }}>Learn {pilotCanon.weeklyGoalHours} hours every week</small>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '9px 0' }}>
          <div className="pilot-bar" style={{ flex: 1 }}><i style={{ width: `${(pilotCanon.weeklyDoneHours / pilotCanon.weeklyGoalHours) * 100}%` }} /></div>
          <small><b>{pilotCanon.weeklyDoneHours}</b> / {pilotCanon.weeklyGoalHours} hrs</small>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recommended for You</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {pilotLearnRecommended.map((course) => (
            <div key={course.title} className="pilot-list-row">
              <span className="pilot-tile teal"><Icon name="learning" size={16} /></span>
              <div className="grow"><strong>{course.title}</strong><small>{course.level}</small></div>
              <small><Icon name="offers" size={16} style={{ color: "#f59e0b", verticalAlign: '-1px' }} /> {course.rating}</small>
              <Icon name="career" size={16} style={{ color: "#98a5ba" }} />
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Achievements</h2>
        <div className="pilot-row cols-3" style={{ textAlign: 'center' }}>
          <div><span className="pilot-tile amber" style={{ margin: '0 auto 6px' }}><Icon name="skills" size={16} /></span><b style={{ fontSize: 16 }}>{pilotCanon.streakDays}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Day Streak</small></div>
          <div><span className="pilot-tile purple" style={{ margin: '0 auto 6px' }}><Icon name="offers" size={16} /></span><b style={{ fontSize: 16 }}>{pilotCanon.coursesCompleted}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Courses Completed</small></div>
          <div><span className="pilot-tile green" style={{ margin: '0 auto 6px' }}><Icon name="offers" size={16} /></span><b style={{ fontSize: 16 }}>{pilotCanon.points}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>Points Earned</small></div>
        </div>
      </section>
    </aside> : null}
  </div>;
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

function TestTable({ rows }: { readonly rows: readonly typeof tabAllTests[number][] }): React.ReactElement {
  return <div className="pilot-table-wrap"><table className="pilot-table">
    <thead><tr><th>Test</th><th>Type</th><th>Questions</th><th>Duration</th><th>Difficulty</th><th></th></tr></thead>
    <tbody>
      {rows.map((test) => (
        <tr key={test.title}>
          <td><strong>{test.title}</strong></td>
          <td>{test.kind}</td>
          <td>{test.questions}</td>
          <td>{test.minutes} min</td>
          <td><span className={`pilot-chip ${test.difficulty === 'Easy' ? 'green' : test.difficulty === 'Medium' ? 'amber' : 'rose'}`}>{test.difficulty}</span></td>
          <td><button type="button" className="pilot-btn ghost small">Start Test</button></td>
        </tr>
      ))}
    </tbody>
  </table></div>;
}

export function PilotAssessments(): React.ReactElement {
  const distribution = pilotScoreDistribution;
  const [tab, setTab] = useState(0);
  return <div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Assessments</h1><p>Practice, evaluate and improve with our wide range of tests.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'All Tests', 'Mock Tests', 'Past Attempts', 'Analytics']} active={tab} onChange={setTab} />

      {tab === 1 ? <section className="pilot-card"><h2>All Tests</h2><TestTable rows={tabAllTests} /></section> : null}
      {tab === 2 ? <section className="pilot-card"><h2>Mock Tests</h2><TestTable rows={tabAllTests.filter((test) => test.kind === 'Mock')} /></section> : null}
      {tab === 3 ? (
        <section className="pilot-card">
          <h2>Past Attempts</h2>
          <div className="pilot-list">
            {tabPastAttempts.map((attempt) => (
              <div key={attempt.title} className="pilot-list-row">
                <span className="pilot-tile indigo" style={{ width: 34, height: 34 }}><Icon name="assessments" size={16} /></span>
                <div className="grow"><strong style={{ fontSize: 12.5 }}>{attempt.title}</strong><small>{attempt.when}</small></div>
                <span className={`pilot-chip ${attempt.score >= 70 ? 'green' : attempt.score >= 40 ? 'amber' : 'rose'}`}>{attempt.score}%</span>
                <button type="button" className="pilot-btn ghost small">Review Answers</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 4 ? (
        <div className="pilot-row cols-2">
          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Score Trend</h2><span className="pilot-chip green">+30 since first attempt</span></div>
            <Spark points={tabScoreTrend} tone="blue" height={140} />
          </section>
          <section className="pilot-card">
            <h2>Score Distribution</h2>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <MultiRing segments={[
                { value: distribution.high, color: '#0d6b4f' },
                { value: distribution.medium, color: '#b45309' },
                { value: distribution.low, color: '#a81f4d' },
              ]}>{pilotCanon.averageScore}%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Average</div></MultiRing>
              <div className="pilot-legend" style={{ flex: 1 }}>
                <div><i style={{ background: '#0d6b4f' }} /> High (&gt;= 70%) <span className="num">{distribution.high}</span></div>
                <div><i style={{ background: '#b45309' }} /> Medium (40–69%) <span className="num">{distribution.medium}</span></div>
                <div><i style={{ background: '#a81f4d' }} /> Low (&lt; 40%) <span className="num">{distribution.low}</span></div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {tab === 0 ? <>
      <section className="pilot-hero">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span className="pilot-tile blue" style={{ width: 48, height: 48 }}><Icon name="assessments" size={24} /></span>
          <div>
            <h2>Assess. Analyze. Advance.</h2>
            <p>Regular practice helps you identify strengths, improve weak areas and stay ahead.</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 26 }}>
          <div className="pilot-stat"><div><b>{pilotCanon.testsAttempted}</b><small>Tests Attempted</small></div></div>
          <div className="pilot-stat"><div><b>{pilotCanon.averageScore}%</b><small>Average Score</small></div></div>
          <div className="pilot-stat"><div><b>{pilotCanon.practiceHours} hrs</b><small>Total Practice Time</small></div></div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recommended for You</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-row cols-5">
          {pilotRecommendedTests.map((test) => (
            <div key={test.title} className="pilot-course-card">
              <span className="pilot-tile" style={{ background: toneMix(test.tone, 10), color: toneColor(test.tone) }}><Icon name="assessments" size={16} /></span>
              <strong>{test.title}</strong>
              <span className={`pilot-chip ${test.difficulty === 'Easy' ? 'green' : test.difficulty === 'Medium' ? 'amber' : 'rose'}`}>{test.difficulty}</span>
              <small>{test.questions} Qs · {test.minutes} mins</small>
              <small>{test.cohort}</small>
              <button type="button" className="pilot-btn ghost small">Start Test</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Browse by Category</h2><button type="button" className="pilot-link">View All Categories →</button></div>
        <div className="pilot-row cols-5">
          {pilotTestCategories.map((category) => (
            <div key={category.label} className="pilot-cat">
              <span className="pilot-tile blue" style={{ width: 32, height: 32 }}><Icon name="targets" size={16} /></span>
              <div><strong>{category.label}</strong><small>{category.count} Tests</small></div>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Tests</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-row cols-4">
          {pilotUpcomingTests.map((test) => (
            <div key={test.title} style={{ display: 'flex', gap: 11 }}>
              <div className="pilot-date"><b>{test.date.split(' ')[0]}</b><span>{test.date.split(' ')[1]}</span></div>
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 12.5, display: 'block' }}>{test.title}</strong>
                <small style={{ color: 'var(--p-muted)', display: 'block' }}>By {test.by}</small>
                <small style={{ color: 'var(--p-muted)', display: 'block', marginBottom: 6 }}>{test.detail}</small>
                <button type="button" className="pilot-btn ghost small">Register</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      </> : null}
    </div>

    {tab === 0 ? <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Performance Summary</h2><button type="button" className="pilot-link">View Full Report</button></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: distribution.high, color: '#12996b' },
            { value: distribution.medium, color: '#f59e0b' },
            { value: distribution.low, color: '#e5484d' },
          ]}>{pilotCanon.averageScore}%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Average</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#12996b' }} /> High (&gt;= 70%) <span className="num">{distribution.high}</span></div>
            <div><i style={{ background: '#f59e0b' }} /> Medium (40–69%) <span className="num">{distribution.medium}</span></div>
            <div><i style={{ background: '#e5484d' }} /> Low (&lt; 40%) <span className="num">{distribution.low}</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recent Test Activity</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {pilotRecentTests.map((test) => (
            <div key={test.title} className="pilot-list-row">
              <span className="pilot-tile indigo" style={{ width: 34, height: 34 }}><Icon name="assessments" size={16} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{test.title}</strong><small>{test.when}</small></div>
              <span className={`pilot-chip ${test.score >= 70 ? 'green' : test.score >= 40 ? 'amber' : 'rose'}`}>{test.score}%</span>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Strength &amp; Weakness</h2><button type="button" className="pilot-link">View Details</button></div>
        <div className="pilot-two">
          <div style={{ background: 'var(--p-green-soft)', borderRadius: 12, padding: '11px 13px' }}>
            <small style={{ fontWeight: 700, color: 'var(--p-green)' }}>↑ Top Strengths</small>
            {pilotStrengths.map((entry) => (
              <div key={entry.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 7 }}>
                <span>{entry.label}</span><b>{entry.value}%</b>
              </div>
            ))}
          </div>
          <div style={{ background: 'var(--p-rose-soft)', borderRadius: 12, padding: '11px 13px' }}>
            <small style={{ fontWeight: 700, color: 'var(--p-rose)' }}>↓ Areas to Improve</small>
            {pilotImprovements.map((entry) => (
              <div key={entry.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 7 }}>
                <span>{entry.label}</span><b>{entry.value}%</b>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Daily Goal</h2><button type="button" className="pilot-link">Edit Goal</button></div>
        <small style={{ color: 'var(--p-muted)' }}>Attempt 2 tests every day</small>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 9 }}>
          <div className="pilot-bar" style={{ flex: 1 }}><i style={{ width: '50%' }} /></div>
          <span className="pilot-chip amber"><Icon name="skills" size={16} /> {pilotCanon.streakDays} Day Streak</span>
        </div>
        <small style={{ color: 'var(--p-muted)' }}>1 / 2 tests completed</small>
      </section>
    </aside> : null}
  </div>;
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export function PilotOpportunities(): React.ReactElement {
  const applications = pilotCanon.applications;
  const insightTotal = applications.applied + applications.shortlisted + applications.interviews + applications.offers;
  const overlay = useOverlay();
  const session = usePilotSession();
  const [tab, setTab] = useState(0);
  const [appliedRoles, setAppliedRoles] = useState<ReadonlySet<string>>(new Set());
  const applyTo = (key: string, role: string, company: string): void => {
    overlay.openModal({
      title: `Apply — ${role}`,
      subtitle: `${company} · Sample application`,
      body: <OverlayForm
        fields={[
          { label: 'Applying as', value: 'Arjun Reddy · Lakeview Institute' },
          { label: 'Resume', type: 'select', value: 'Software Engineer Resume (score 78)', options: ['Software Engineer Resume (score 78)', 'Internship Resume (score 72)', 'Campus Placement Resume (score 68)'] },
          { label: 'Cover note', type: 'textarea', placeholder: 'A short note to the recruiter (optional)' },
        ]}
        submitLabel="Submit Application"
        success={`Application submitted to ${company} (sample).`}
        onSubmit={() => setAppliedRoles((previous) => new Set(previous).add(key))} />,
    });
  };
  const opportunityRow = (opportunity: typeof pilotOpportunities[number]): React.ReactElement => (
    <div key={`${opportunity.company.name}-${opportunity.role}`} className="pilot-list-row">
      <span className={`pilot-mark ${opportunity.company.tone}`}>{opportunity.company.mark}</span>
      <div className="grow">
        <strong>{opportunity.role}</strong>
        <small>{opportunity.company.name} · {opportunity.location} · {opportunity.experience}</small>
      </div>
      <b style={{ fontSize: 13 }}>{opportunity.match}%</b>
      {appliedRoles.has(`${opportunity.company.name}-${opportunity.role}`) ? (
        <button type="button" className="pilot-btn ghost small" disabled>Applied ✓</button>
      ) : (
        <button type="button" className="pilot-btn small"
          onClick={(event) => { event.stopPropagation(); applyTo(`${opportunity.company.name}-${opportunity.role}`, opportunity.role, opportunity.company.name); }}>Apply Now</button>
      )}
    </div>
  );
  return <div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Opportunities</h1><p>Discover jobs, internships and opportunities that match your skills and goals.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'Jobs', 'Internships', 'On Campus', 'Off Campus', 'Achievements']} active={tab} onChange={setTab} />

      {tab === 1 ? <section className="pilot-card"><h2>Jobs</h2><div className="pilot-list">{pilotOpportunities.filter((opportunity) => opportunity.type === 'Full-time').map(opportunityRow)}</div></section> : null}
      {tab === 2 ? <section className="pilot-card"><h2>Internships</h2><div className="pilot-list">{pilotOpportunities.filter((opportunity) => opportunity.type === 'Internship').map(opportunityRow)}</div></section> : null}
      {tab === 3 ? (
        <section className="pilot-card">
          <h2>On Campus</h2>
          <div className="pilot-list">
            {pilotDrives.map((drive) => (
              <div key={drive.title} className="pilot-list-row">
                <div className="pilot-date"><b>{drive.date.split(' ')[0]}</b><span>{drive.date.split(' ')[1]}</span></div>
                <div className="grow"><strong>{drive.title}</strong><small>{drive.company} · {drive.mode}</small></div>
                <button type="button" className="pilot-btn ghost small">Register</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 4 ? (
        <section className="pilot-card">
          <h2>Off Campus</h2>
          <div className="pilot-list">
            {pilotSavedOpportunities.map((saved) => (
              <div key={`${saved.company.name}-${saved.role}`} className="pilot-list-row">
                <span className={`pilot-mark ${saved.company.tone}`} style={{ width: 36, height: 36, fontSize: 11.5 }}>{saved.company.mark}</span>
                <div className="grow"><strong>{saved.role}</strong><small>{saved.company.name} · {saved.location} · Direct application</small></div>
                <button type="button" className="pilot-btn small">Apply Now</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 5 ? (
        <section className="pilot-card">
          <h2>Achievements</h2>
          <div className="pilot-row cols-4">
            {pilotAchievements.map((achievement) => (
              <div key={achievement.title} className="pilot-course-card">
                <span className={`pilot-tile ${achievement.tone}`}><Icon name="offers" size={16} /></span>
                <strong>{achievement.title}</strong>
                <small>{achievement.detail}</small>
                <small style={{ color: 'var(--p-muted)' }}>{achievement.when}</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tab === 0 ? <>
      <section className="pilot-hero">
        <div style={{ flex: 1 }}>
          <h2>Your Opportunity Overview</h2>
          <div className="pilot-row cols-4" style={{ marginTop: 12 }}>
            {[
              ['Applied', applications.applied, 'blue'], ['Shortlisted', applications.shortlisted, 'green'],
              ['Interviews', applications.interviews, 'purple'], ['Offers', applications.offers, 'amber'],
            ].map(([label, value, tone]) => (
              <div key={label as string} className="pilot-stat">
                <span className={`pilot-tile ${tone as string}`}><Icon name="company" size={16} /></span>
                <div><b>{value as number}</b><small>{label as string}</small></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recommended Opportunities</h2><button type="button" className="pilot-link">View All Jobs →</button></div>
        <div className="pilot-list">
          {pilotOpportunities.map((opportunity) => (
            <div key={`${opportunity.company.name}-${opportunity.role}`} className="pilot-list-row">
              <span className={`pilot-mark ${opportunity.company.tone}`}>{opportunity.company.mark}</span>
              <div className="grow">
                <strong>{opportunity.role}</strong>
                <small>{opportunity.company.name} · {opportunity.location} · {opportunity.type} · {opportunity.experience}</small>
              </div>
              <span className={`pilot-chip ${opportunity.matchBand === 'High Match' ? 'green' : opportunity.matchBand === 'Medium Match' ? 'amber' : 'blue'}`}>{opportunity.matchBand}</span>
              <b style={{ fontSize: 13 }}>{opportunity.match}%</b>
              <small style={{ color: 'var(--p-muted)' }}>{opportunity.posted}</small>
              <Icon name="career" size={16} style={{ color: "#98a5ba" }} />
              {appliedRoles.has(`${opportunity.company.name}-${opportunity.role}`) ? (
                <button type="button" className="pilot-btn ghost small" disabled>Applied ✓</button>
              ) : (
                <button type="button" className="pilot-btn small"
                  onClick={(event) => { event.stopPropagation(); applyTo(`${opportunity.company.name}-${opportunity.role}`, opportunity.role, opportunity.company.name); }}>Apply Now</button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <h2>Explore by Category</h2>
        <div className="pilot-row cols-3">
          {pilotOpportunityCategories.map((category) => (
            <button key={category.label} type="button" className="pilot-cat"
              onClick={(event) => {
                event.stopPropagation();
                overlay.openModal(listModal(category.label, `${category.count} roles in this category (sample)`, (tabCategoryRoles[category.label] ?? []).map((role) => ({ title: role }))));
              }}>
              <span className="pilot-tile indigo" style={{ width: 32, height: 32 }}><Icon name="company" size={16} /></span>
              <div><strong>{category.label}</strong><small>{category.count} Jobs</small></div>
            </button>
          ))}
        </div>
      </section>
      </> : null}
    </div>

    {tab === 0 ? <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Opportunity Insights</h2><small style={{ color: 'var(--p-muted)' }}>This Month</small></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: applications.applied, color: '#1f55e5' },
            { value: applications.shortlisted, color: '#12996b' },
            { value: applications.interviews, color: '#6d4fd8' },
            { value: applications.offers, color: '#f59e0b' },
          ]}>71%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Activity</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#1f55e5' }} /> Applied <span className="num">{applications.applied} ({Math.round((applications.applied / insightTotal) * 100)}%)</span></div>
            <div><i style={{ background: '#12996b' }} /> Shortlisted <span className="num">{applications.shortlisted}</span></div>
            <div><i style={{ background: '#6d4fd8' }} /> Interviews <span className="num">{applications.interviews}</span></div>
            <div><i style={{ background: '#f59e0b' }} /> Offers <span className="num">{applications.offers}</span></div>
          </div>
        </div>
      </section>
      <div className="pilot-banner"><Icon name="analytics" size={16} /> Keep applying! You&apos;re 20% more active than last month.</div>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Saved Opportunities</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {pilotSavedOpportunities.map((saved) => (
            <div key={`${saved.company.name}-${saved.role}`} className="pilot-list-row">
              <span className={`pilot-mark ${saved.company.tone}`} style={{ width: 36, height: 36, fontSize: 11.5 }}>{saved.company.mark}</span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{saved.role}</strong><small>{saved.company.name} · {saved.location}</small></div>
              <Icon name="career" size={16} style={{ color: "#1f55e5" }} />
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Drives</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {pilotDrives.map((drive) => (
            <div key={drive.title} className="pilot-list-row">
              <div className="pilot-date"><b>{drive.date.split(' ')[0]}</b><span>{drive.date.split(' ')[1]}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{drive.title}</strong><small>{drive.company} · {drive.mode}</small></div>
              <button type="button" className="pilot-btn ghost small">Register</button>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card" style={{ background: 'linear-gradient(135deg, #f2ecff, #eef3ff)' }}>
        <strong style={{ display: 'block', marginBottom: 4 }}>Get noticed by top recruiters!</strong>
        <small style={{ color: 'var(--p-muted)', display: 'block', marginBottom: 10 }}>Complete your profile and increase your visibility.</small>
        <button type="button" className="pilot-btn small"
          onClick={(event) => { event.stopPropagation(); session.navigate('profile'); }}>Complete Profile</button>
      </section>
    </aside> : null}
  </div>;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileRecordList({ title, rows, action }: { readonly title: string; readonly rows: readonly { readonly title: string; readonly detail: string }[]; readonly action?: string }): React.ReactElement {
  return <section className="pilot-card">
    <h2>{title}</h2>
    <div className="pilot-list">
      {rows.map((row) => (
        <div key={row.title} className="pilot-list-row">
          <span className="pilot-tile blue" style={{ width: 34, height: 34 }}><Icon name="offers" size={16} /></span>
          <div className="grow"><strong style={{ fontSize: 12.5 }}>{row.title}</strong><small>{row.detail}</small></div>
          {action ? <button type="button" className="pilot-btn ghost small">{action}</button> : null}
        </div>
      ))}
    </div>
  </section>;
}

/**
 * The student decides who sees what. Mirrors the real application's consent model:
 * evidence goes to an employer only for an application the student made, and the
 * readiness band never leaves ONE's student and college views.
 */
function ConsentCard(): React.ReactElement {
  const overlay = useOverlay();
  const [choices, setChoices] = useState<Readonly<Record<string, boolean>>>({
    'Share verified skill evidence with employers I apply to': true,
    'Let my placement cell nominate me for campus drives': true,
    'Show my public profile link to anyone I send it to': false,
  });
  return <section className="pilot-card">
    <h2>Privacy &amp; Consent</h2>
    <div className="pilot-list">
      {Object.entries(choices).map(([label, on]) => (
        <div key={label} className="pilot-list-row" style={{ padding: '8px 2px' }}>
          <div className="grow"><small style={{ color: 'var(--p-ink-2)' }}>{label}</small></div>
          <button type="button" className={`pilot-btn small ${on ? '' : 'ghost'}`} aria-pressed={on}
            onClick={(event) => {
              event.stopPropagation();
              setChoices((previous) => ({ ...previous, [label]: !on }));
              overlay.toast(`${on ? 'Turned off' : 'Turned on'}: ${label.toLowerCase()} (sample).`);
            }}>{on ? 'On' : 'Off'}</button>
        </div>
      ))}
      <div className="pilot-list-row" style={{ padding: '8px 2px' }}>
        <div className="grow"><small style={{ color: 'var(--p-ink-2)' }}>Readiness band visible to employers</small></div>
        <span className="pilot-chip slate">Never</span>
      </div>
    </div>
  </section>;
}

export function PilotProfile(): React.ReactElement {
  const done = pilotProfileChecklist.filter((item) => item.state === 'done').length;
  const overlay = useOverlay();
  const session = usePilotSession();
  const [tab, setTab] = useState(0);
  const requestDeletion = (): void => {
    overlay.openModal({
      title: 'Privacy & Account', subtitle: 'Your data, your control', body: <div>
        <p className="pilot-modal-text">You can export everything ONE holds about you, or ask for your account to be removed. Deletion starts a <strong>30-day grace period</strong> - sign in during that window to cancel, after which your data is permanently anonymised.</p>
        <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); overlay.closeModal(); overlay.toast('Data export prepared and emailed to you (sample).'); }}>Export My Data</button>
          <button type="button" className="pilot-btn" style={{ background: '#b91c1c' }}
            onClick={(event) => { event.stopPropagation(); overlay.closeModal(); overlay.toast('Deletion requested - 30-day grace period started (sample). Sign in anytime before then to cancel.'); }}>Request Account Deletion</button>
        </div>
      </div>,
    });
  };
  const editProfile = (): void => {
    overlay.openModal({
      title: 'Edit Profile', subtitle: 'Changes stay in this sample session', body: <OverlayForm
        fields={[
          { label: 'Full name', value: pilotPersona.name },
          { label: 'Email', type: 'email', value: pilotPersona.email },
          { label: 'Phone', value: pilotPersona.phone },
          { label: 'Location', value: pilotPersona.location },
          { label: 'Headline', value: `B.Tech CSE student at ${pilotPersona.institution}, aiming for ${pilotPersona.careerGoal} roles` },
        ]}
        submitLabel="Save Profile" success="Profile updated (sample)." />,
    });
  };
  return <div className="pilot-page" style={tab === 0 ? undefined : { gridTemplateColumns: '1fr' }}>
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>My Profile</h1><p>Manage your profile, track your progress and showcase your achievements.</p></div>
      </div>

      <section className="pilot-card" style={{ background: 'linear-gradient(120deg, #f5f8ff, #fdfdff)' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <PilotAvatar initials={pilotPersona.initials} size={64} fontSize={21} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 19 }}>{pilotPersona.name}</strong>
              <span className="pilot-chip green">Profile Complete {pilotPersona.profileComplete}%</span>
            </div>
            <small style={{ color: 'var(--p-muted)', display: 'block', marginTop: 3 }}>
              B.Tech Computer Science Engineering · {pilotPersona.institution} · Class of 2027
            </small>
            <small style={{ color: 'var(--p-muted)' }}>{pilotPersona.location} · {pilotPersona.email} · {pilotPersona.phone}</small>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PhotoUploadControl compact />
            <button type="button" className="pilot-btn ghost" onClick={(event) => { event.stopPropagation(); editProfile(); }}>Edit Profile</button>
          </div>
        </div>
      </section>

      <PilotTabs labels={['Overview', 'Education', 'Skills', 'Achievements', 'Certificates', 'Projects', 'Internships', 'Preferences']} active={tab} onChange={setTab} />

      {tab === 1 ? <ProfileRecordList title="Education" rows={tabEducation} /> : null}
      {tab === 2 ? (
        <section className="pilot-card">
          <h2>Skills</h2>
          <div className="pilot-two">
            {pilotSkills.map((skill) => (
              <div key={skill.label} className="pilot-skill">
                <header><b>{skill.label}</b><span>{skill.value}%</span></header>
                <div className={`pilot-bar thin ${skill.tone}`}><i style={{ width: `${skill.value}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 3 ? (
        <section className="pilot-card">
          <h2>Achievements</h2>
          <div className="pilot-row cols-4">
            {pilotAchievements.map((achievement) => (
              <div key={achievement.title} className="pilot-course-card">
                <span className={`pilot-tile ${achievement.tone}`}><Icon name="offers" size={16} /></span>
                <strong>{achievement.title}</strong>
                <small>{achievement.detail}</small>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === 4 ? <ProfileRecordList title="Certificates" rows={tabCertificateRecords} action="View" /> : null}
      {tab === 5 ? <ProfileRecordList title="Projects" rows={tabProjects} action="Open" /> : null}
      {tab === 6 ? <ProfileRecordList title="Internships" rows={tabInternships} /> : null}
      {tab === 7 ? (
        <section className="pilot-card" style={{ maxWidth: 560 }}>
          <h2>Preferences</h2>
          <OverlayForm
            fields={[
              { label: 'Preferred work location', type: 'select', value: 'Bengaluru', options: ['Bengaluru', 'Chennai', 'Hyderabad', 'Pune', 'Remote'] },
              { label: 'Role interests', value: 'Software Engineer, Backend Developer' },
              { label: 'Open to internships', type: 'select', value: 'Yes', options: ['Yes', 'No'] },
              { label: 'Notification frequency', type: 'select', value: 'Daily digest', options: ['Real-time', 'Daily digest', 'Weekly summary'] },
            ]}
            submitLabel="Save Preferences" success="Preferences saved (sample)." />
        </section>
      ) : null}

      {tab === 0 ? <>
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <h2>Profile Completion</h2>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <Ring value={pilotPersona.profileComplete} size={104} stroke={11} tone="green"><span style={{ fontSize: 19 }}>{pilotPersona.profileComplete}%</span></Ring>
            <div className="pilot-legend" style={{ flex: 1 }}>
              {pilotProfileChecklist.map((item) => (
                <div key={item.label}>
                  <Icon name="check" size={16} style={{ color: item.state === 'done' ? '#12996b' : item.state === 'progress' ? '#1f55e5' : '#c2ccda' }} />
                  <span style={{ color: item.state === 'todo' ? 'var(--p-muted)' : 'inherit' }}>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <small style={{ color: 'var(--p-muted)', display: 'block', marginTop: 10 }}>{done} of {pilotProfileChecklist.length} sections complete.</small>
        </section>

        <section className="pilot-card">
          <h2>Career Snapshot</h2>
          <div className="pilot-row cols-2">
            {[
              ['Assessments Taken', `${pilotCanon.testsAttempted}`, 'blue', 'assessments'],
              ['Average Score', `${pilotCanon.averageScore}%`, 'rose', 'analytics'],
              ['Companies Followed', '24', 'purple', 'company'],
              ['Applications', `${pilotCanon.applications.applied}`, 'green', 'applications'],
            ].map(([label, value, tone, glyph]) => (
              <div key={label as string} className="pilot-stat" style={{ border: '1px solid var(--p-line)', borderRadius: 12, padding: '11px 13px' }}>
                <span className={`pilot-tile ${tone as string}`}><Icon name={glyph as IconName} size={16} /></span>
                <div><b>{value as string}</b><small>{label as string}</small></div>
              </div>
            ))}
          </div>
          <button type="button" className="pilot-link" style={{ marginTop: 10 }}>View Full Analytics →</button>
        </section>
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Skills Overview</h2><button type="button" className="pilot-link">View All Skills →</button></div>
          <div className="pilot-two">
            {pilotSkills.map((skill) => (
              <div key={skill.label} className="pilot-skill">
                <header><b>{skill.label}</b><span>{skill.value}%</span></header>
                <div className={`pilot-bar thin ${skill.tone}`}><i style={{ width: `${skill.value}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Latest Activity</h2><button type="button" className="pilot-link">View All →</button></div>
          <div className="pilot-list">
            {pilotRecentActivity.map((entry) => (
              <div key={entry.title} className="pilot-list-row" style={{ padding: '9px 2px' }}>
                <span className={`pilot-tile ${entry.tone}`} style={{ width: 32, height: 32 }}><Icon name="analytics" size={16} /></span>
                <div className="grow"><strong style={{ fontSize: 12.5 }}>{entry.title}</strong></div>
                <small>{entry.when}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recent Achievements</h2><button type="button" className="pilot-link"
          onClick={(event) => { event.stopPropagation(); setTab(3); }}>View All →</button></div>
        <div className="pilot-row cols-4">
          {pilotAchievements.map((achievement) => (
            <div key={achievement.title} className="pilot-course-card">
              <span className={`pilot-tile ${achievement.tone}`}><Icon name="offers" size={16} /></span>
              <strong>{achievement.title}</strong>
              <small>{achievement.detail}</small>
              <small style={{ color: 'var(--p-muted)' }}>{achievement.when}</small>
            </div>
          ))}
        </div>
      </section>
      </> : null}
    </div>

    {tab === 0 ? <aside className="pilot-rail">
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Profile Strength</h2>
        <Ring value={pilotPersona.profileComplete} size={104} stroke={11} tone="green"><span style={{ fontSize: 15 }}>Strong</span></Ring>
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>Great job! Keep it updated.</small>
        <button type="button" className="pilot-link" style={{ marginTop: 6 }}>How to improve? →</button>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Top Skills in Demand</h2><button type="button" className="pilot-link">View All</button></div>
        {pilotDemandSkills.map((skill, index) => (
          <div key={skill.label} className="pilot-skill">
            <header><b>{index + 1}. {skill.label}</b><span className="pilot-chip green">High</span></header>
            <div className={`pilot-bar thin ${skill.tone}`}><i style={{ width: `${skill.value}%` }} /></div>
          </div>
        ))}
      </section>
      <section className="pilot-card">
        <h2>Profile Tips</h2>
        <div className="pilot-list">
          {pilotProfileTips.map((tip, index) => (
            <button key={tip.title} type="button" className="pilot-list-row pilot-tip-row" style={{ padding: '9px 2px' }}
              onClick={(event) => {
                event.stopPropagation();
                if (index === 0) setTab(5);
                else if (index === 1) setTab(4);
                else if (index === 2) session.navigate('learn');
                else setTab(7);
              }}>
              <span className="pilot-tile amber" style={{ width: 32, height: 32 }}><Icon name="coach" size={16} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{tip.title}</strong><small>{tip.detail}</small></div>
              <Icon name="arrow-right" size={16} style={{ color: "#98a5ba" }} />
            </button>
          ))}
        </div>
      </section>
      <ConsentCard />
      <section className="pilot-card">
        <h2>Quick Actions</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}><Icon name="clock" size={16} /> Download Resume</button>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}
            onClick={(event) => { event.stopPropagation(); overlay.openModal(shareProfileModal()); }}><Icon name="offers" size={16} /> Share Profile · QR</button>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}
            onClick={(event) => { event.stopPropagation(); setTab(7); }}><Icon name="targets" size={16} /> Manage Preferences</button>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}
            onClick={(event) => { event.stopPropagation(); requestDeletion(); }}><Icon name="lock" size={16} /> Privacy &amp; Account</button>
        </div>
      </section>
    </aside> : null}
  </div>;
}
