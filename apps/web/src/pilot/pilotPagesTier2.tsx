import { Award, BookOpen, Bookmark, Briefcase, Building2, CheckCircle2, ClipboardCheck, Code2, Database, FileText, Flame, Landmark, Layers, LineChart, Mail, Map, PenTool, Search, Sparkles, Star, Target, Trophy, Upload, Wrench } from 'lucide-react';
import { MultiRing, Ring, WeekBars, toneColor } from './pilotComponents.js';
import { pilotCanon, pilotCompanies, pilotPersona } from './pilotData.js';
import { PilotTabs } from './pilotOverlay.js';

/**
 * Tier 2 student pages, built to the same sample fidelity as Tier 1.
 * All companies and scholarship providers are fictional; numbers stay
 * consistent with the pilot canon (streak, practice hours, readiness).
 */

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------

const PRACTICE_CONTINUE = [
  { title: 'Arrays: Easy Problems', kind: 'Problem List', progress: 60, meta: '12 / 20', tone: 'green' },
  { title: 'Two Pointers Technique', kind: 'Study Module', progress: 60, meta: '60%', tone: 'amber' },
  { title: 'Dynamic Programming', kind: 'Study Module', progress: 40, meta: '40%', tone: 'purple' },
  { title: 'Web Dev Project', kind: 'Task in Progress', progress: 75, meta: '75%', tone: 'blue' },
  { title: 'System Design Basics', kind: 'Learning Path', progress: 30, meta: '30%', tone: 'teal' },
] as const;

const PRACTICE_RECOMMENDED = [
  { title: 'Graph Theory - Basics', difficulty: 'Medium', problems: 20, tone: 'purple' },
  { title: 'Backtracking', difficulty: 'Medium', problems: 18, tone: 'amber' },
  { title: 'Binary Search', difficulty: 'Easy', problems: 15, tone: 'blue' },
  { title: 'Sorting Algorithms', difficulty: 'Easy', problems: 12, tone: 'green' },
  { title: 'Recursion Basics', difficulty: 'Easy', problems: 10, tone: 'rose' },
] as const;

const PRACTICE_SKILLS = [
  ['Data Structures', 238, Database], ['Algorithms', 312, Code2], ['Database', 96, Database],
  ['Web Development', 184, Layers], ['System Design', 92, Landmark], ['Operating Systems', 76, Wrench],
  ['Object Oriented', 145, Layers], ['Core CS', 68, BookOpen], ['Machine Learning', 54, LineChart],
  ['Aptitude', 120, Target],
] as const;

const PRACTICE_CONTESTS = [
  { name: 'CodeSprint 92', date: 'MAY 24', time: '6:00 PM - 9:00 PM' },
  { name: 'Weekly Contest 358', date: 'MAY 28', time: '7:30 PM - 10:30 PM' },
  { name: 'Mega Contest 61', date: 'JUN 01', time: '11:00 AM - 2:00 PM' },
] as const;

export function PilotPractice(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Practice</h1><p>Sharpen your skills with coding, problems, projects and real-world challenges.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'Coding', 'Problems', 'Projects', 'System Design', 'Contests', 'Interview Prep']} />

      <section className="pilot-hero">
        <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
          <div className="pilot-stat"><span className="pilot-tile green"><Code2 size={17} /></span><div><b>384</b><small>Problems Solved</small></div></div>
          <div className="pilot-stat"><span className="pilot-tile amber"><Trophy size={17} /></span><div><b>6</b><small>Contests Participated</small></div></div>
          <div className="pilot-stat"><span className="pilot-tile blue"><ClipboardCheck size={17} /></span><div><b>{pilotCanon.practiceHours} hrs</b><small>Practice Time</small></div></div>
          <div className="pilot-stat"><span className="pilot-tile rose"><Flame size={17} /></span><div><b>{pilotCanon.streakDays}</b><small>Day Streak</small></div></div>
          <div className="pilot-stat"><span className="pilot-tile teal"><LineChart size={17} /></span><div><b>82%</b><small>Success Rate</small></div></div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Continue Practicing</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-row cols-5">
          {PRACTICE_CONTINUE.map((entry) => (
            <div key={entry.title} className="pilot-course-card">
              <span className="pilot-tile" style={{ background: `${toneColor(entry.tone)}1a`, color: toneColor(entry.tone) }}><Code2 size={17} /></span>
              <strong>{entry.title}</strong>
              <small>{entry.kind}</small>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="pilot-bar thin" style={{ flex: 1 }}><i style={{ width: `${entry.progress}%` }} /></div>
                <small>{entry.meta}</small>
              </div>
              <button type="button" className="pilot-btn ghost small">Continue</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recommended for You</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-row cols-5">
          {PRACTICE_RECOMMENDED.map((entry) => (
            <div key={entry.title} className="pilot-course-card">
              <span className="pilot-tile" style={{ background: `${toneColor(entry.tone)}1a`, color: toneColor(entry.tone) }}><Target size={17} /></span>
              <strong>{entry.title}</strong>
              <span className={`pilot-chip ${entry.difficulty === 'Easy' ? 'green' : 'amber'}`}>{entry.difficulty}</span>
              <small>{entry.problems} problems</small>
              <button type="button" className="pilot-btn ghost small">Start Practice</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Practice by Skill</h2><button type="button" className="pilot-link">View All Skills</button></div>
        <div className="pilot-row cols-5">
          {PRACTICE_SKILLS.map(([label, count, Icon]) => (
            <div key={label as string} className="pilot-cat">
              {(() => { const Component = Icon as typeof Target; return <span className="pilot-tile blue" style={{ width: 32, height: 32 }}><Component size={14} /></span>; })()}
              <div><strong>{label as string}</strong><small>{count as number} problems</small></div>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Practice Overview</h2><button type="button" className="pilot-link">View Details</button></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: 384, color: '#0d6b4f' }, { value: 96, color: '#1f55e5' },
            { value: 63, color: '#b45309' }, { value: 57, color: '#5936cf' },
          ]}>72%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Overall</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#0d6b4f' }} /> Solved <span className="num">384</span></div>
            <div><i style={{ background: '#1f55e5' }} /> In Progress <span className="num">96</span></div>
            <div><i style={{ background: '#b45309' }} /> Attempted <span className="num">63</span></div>
            <div><i style={{ background: '#5936cf' }} /> Yet to Start <span className="num">57</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Weekly Activity</h2><button type="button" className="pilot-link">View Log</button></div>
        <WeekBars hours={[1.5, 2, 1, 2.5, 1.5, 2, 0.5]} />
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Contests</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {PRACTICE_CONTESTS.map((contest) => (
            <div key={contest.name} className="pilot-list-row">
              <div className="pilot-date"><b>{contest.date.split(' ')[0]}</b><span>{contest.date.split(' ')[1]}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{contest.name}</strong><small>{contest.time}</small></div>
              <button type="button" className="pilot-btn ghost small">Register</button>
            </div>
          ))}
        </div>
      </section>
      <div className="pilot-banner"><Sparkles size={17} /> Consistency is the key to mastery. Solve daily, learn continuously.</div>
    </aside>
  </div>;
}

// ---------------------------------------------------------------------------
// Company Preparation
// ---------------------------------------------------------------------------

const PREP_TOOLS = [
  { title: 'Interview Experiences', detail: 'Real experiences from students & alumni', action: 'Explore', tone: 'blue' },
  { title: 'Company Questions', detail: 'Curated questions asked in real interviews', action: 'Practice', tone: 'green' },
  { title: 'Mock Interviews', detail: 'Guided mock interviews with feedback', action: 'Start Now', tone: 'purple' },
  { title: 'Aptitude Prep', detail: 'Company-wise aptitude tests and solutions', action: 'Practice', tone: 'amber' },
  { title: 'GD & PI Prep', detail: 'Group discussion & personal interview prep', action: 'Prepare', tone: 'teal' },
] as const;

const PREP_INTERVIEWS = [
  { company: pilotCompanies[0]!, role: 'Graduate Software Engineer', when: '26 May, 02:00 PM' },
  { company: pilotCompanies[1]!, role: 'SDE Intern', when: '29 May, 11:00 AM' },
] as const;

const PREP_RESOURCES = [
  ['Zenvia Labs - Interview Guide', '2.1K views'], ['Kortex - Coding Questions', '1.6K views'],
  ['BlueRiver - Analyst Case Prep', '1.2K views'], ['Veridian - System Design Basics', '900 views'],
] as const;

export function PilotCompanyPrep(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Company Preparation</h1><p>Prepare for your dream companies with tailored resources and practice.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'Companies', 'Interview Prep', 'Aptitude Prep', 'Mock Interviews', 'Saved']} />

      <section className="pilot-hero">
        <div style={{ flex: 1 }}>
          <h2>Your gateway to top companies</h2>
          <p>Access company-specific resources, real interview questions and guided preparation.</p>
          <div className="pilot-row cols-4" style={{ marginTop: 12 }}>
            {[
              ['Companies', '24', 'blue', Building2], ['Interview Experiences', '168', 'purple', Mail],
              ['Questions Solved', '320', 'green', CheckCircle2], ['Profile Match', '85%', 'amber', Target],
            ].map(([label, value, tone, Icon]) => (
              <div key={label as string} className="pilot-stat">
                {(() => { const Component = Icon as typeof Target; return <span className={`pilot-tile ${tone as string}`}><Component size={16} /></span>; })()}
                <div><b>{value as string}</b><small>{label as string}</small></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Top Companies</h2><button type="button" className="pilot-link">View All →</button></div>
        <div className="pilot-row cols-5">
          {pilotCompanies.slice(0, 5).map((company, index) => (
            <div key={company.name} className="pilot-course-card" style={{ textAlign: 'center' }}>
              <span className={`pilot-mark ${company.tone}`} style={{ margin: '0 auto' }}>{company.mark}</span>
              <strong>{company.name}</strong>
              <small>{[124, 98, 87, 76, 64][index]} Resources</small>
              <span className={`pilot-chip ${index === 2 ? 'amber' : 'green'}`} style={{ margin: '0 auto' }}>{index === 2 ? 'Medium Match' : 'High Match'}</span>
              <button type="button" className="pilot-btn ghost small">Explore</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <h2>Company Preparation Tools</h2>
        <div className="pilot-row cols-5">
          {PREP_TOOLS.map((tool) => (
            <div key={tool.title} className="pilot-course-card">
              <span className="pilot-tile" style={{ background: `${toneColor(tool.tone)}1a`, color: toneColor(tool.tone) }}><Briefcase size={17} /></span>
              <strong>{tool.title}</strong>
              <small>{tool.detail}</small>
              <button type="button" className="pilot-btn ghost small">{tool.action} →</button>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Preparation Progress</h2><button type="button" className="pilot-link">View Details</button></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: 68, color: '#0d6b4f' }, { value: 24, color: '#1f55e5' },
            { value: 16, color: '#b45309' }, { value: 12, color: '#5936cf' },
          ]}>72%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Overall</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#0d6b4f' }} /> Completed <span className="num">68</span></div>
            <div><i style={{ background: '#1f55e5' }} /> In Progress <span className="num">24</span></div>
            <div><i style={{ background: '#b45309' }} /> Not Started <span className="num">16</span></div>
            <div><i style={{ background: '#5936cf' }} /> Saved <span className="num">12</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Interviews</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {PREP_INTERVIEWS.map((interview) => (
            <div key={interview.role} className="pilot-list-row">
              <span className={`pilot-mark ${interview.company.tone}`} style={{ width: 34, height: 34, fontSize: 11 }}>{interview.company.mark}</span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{interview.company.name} · {interview.role}</strong><small>{interview.when}</small></div>
              <button type="button" className="pilot-btn ghost small">Prepare</button>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Popular Resources</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {PREP_RESOURCES.map(([title, views]) => (
            <div key={title} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <FileText size={15} color="#1f55e5" />
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{title}</strong></div>
              <small>{views}</small>
            </div>
          ))}
        </div>
      </section>
      <div className="pilot-banner"><Sparkles size={17} /> Consistent practice and mock interviews sharply improve selection chances.</div>
    </aside>
  </div>;
}

// ---------------------------------------------------------------------------
// Career Tools
// ---------------------------------------------------------------------------

const CAREER_TOOLS = [
  { title: 'Resume Builder', detail: 'Create professional resumes with ready templates.', action: 'Create Resume', icon: FileText, tone: 'purple' },
  { title: 'Cover Letter Builder', detail: 'Write tailored cover letters for any role.', action: 'Create Cover Letter', icon: Mail, tone: 'green' },
  { title: 'Portfolio Builder', detail: 'Build an impressive portfolio to showcase your work.', action: 'Build Portfolio', icon: Briefcase, tone: 'amber' },
  { title: 'Interview Question Bank', detail: 'Role-wise and company-wise interview questions.', action: 'Explore Questions', icon: BookOpen, tone: 'blue' },
  { title: 'Salary Explorer', detail: 'Explore salary insights by role, company and location.', action: 'Explore Salaries', icon: LineChart, tone: 'teal' },
  { title: 'Career Roadmap Planner', detail: 'Plan your career path with customised roadmaps.', action: 'Plan Roadmap', icon: Map, tone: 'indigo' },
  { title: 'Goal Tracker', detail: 'Set goals and track your progress in one place.', action: 'Track Goals', icon: Target, tone: 'rose' },
  { title: 'Skill Gap Analyzer', detail: 'Find the skills you need to reach your goals.', action: 'Analyze Skills', icon: Search, tone: 'purple' },
] as const;

const TOOLS_RECENT = [
  ['Resume Builder', 'Used 2 days ago'], ['Skill Gap Analyzer', 'Used 5 days ago'], ['Career Roadmap', 'Used 1 week ago'],
] as const;

export function PilotCareerTools(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Career Tools</h1><p>Everything you need to plan, build and accelerate your career.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'Resume & Docs', 'Skill Tools', 'Planning', 'Career Insights', 'Job Search']} />

      <section className="pilot-hero">
        <div style={{ flex: 1 }}>
          <h2>Tools that empower your career growth</h2>
          <p>Use smart tools and resources to build your profile, enhance skills and achieve goals faster.</p>
          <div className="pilot-row cols-3" style={{ marginTop: 12 }}>
            <div className="pilot-stat"><span className="pilot-tile blue"><Wrench size={16} /></span><div><b>18</b><small>Tools Available</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile green"><CheckCircle2 size={16} /></span><div><b>7</b><small>Tools Used</small></div></div>
            <div className="pilot-stat"><span className="pilot-tile amber"><Star size={16} /></span><div><b>{pilotPersona.profileComplete}%</b><small>Profile Strength</small></div></div>
          </div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Popular Tools</h2><button type="button" className="pilot-link">View All Tools →</button></div>
        <div className="pilot-row cols-4">
          {CAREER_TOOLS.map((tool) => (
            <div key={tool.title} className="pilot-course-card">
              {(() => { const Component = tool.icon; return <span className="pilot-tile" style={{ background: `${toneColor(tool.tone)}1a`, color: toneColor(tool.tone) }}><Component size={17} /></span>; })()}
              <strong>{tool.title}</strong>
              <small>{tool.detail}</small>
              <button type="button" className="pilot-btn ghost small">{tool.action} →</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recently Used Tools</h2><button type="button" className="pilot-link">View History →</button></div>
        <div className="pilot-list">
          {TOOLS_RECENT.map(([title, when]) => (
            <div key={title} className="pilot-list-row">
              <span className="pilot-tile indigo" style={{ width: 34, height: 34 }}><Wrench size={15} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{title}</strong><small>{when}</small></div>
              <button type="button" className="pilot-btn ghost small">Open</button>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Tools Usage Overview</h2><small style={{ color: 'var(--p-muted)' }}>This month</small></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: 32, color: '#5936cf' }, { value: 24, color: '#0d6b4f' },
            { value: 18, color: '#b45309' }, { value: 16, color: '#1f55e5' },
          ]}>72%<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Tools Used</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#5936cf' }} /> Resume &amp; Docs <span className="num">32%</span></div>
            <div><i style={{ background: '#0d6b4f' }} /> Skill Tools <span className="num">24%</span></div>
            <div><i style={{ background: '#b45309' }} /> Planning <span className="num">18%</span></div>
            <div><i style={{ background: '#1f55e5' }} /> Job Search <span className="num">16%</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recommended for You</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {[
            ['Skill Gap Analyzer', 'Find skills you need to reach your goals.'],
            ['Mock Interview', 'Practice with guided and expert interviews.'],
            ['Placement Predictor', 'Get insights on your placement chances.'],
          ].map(([title, detail]) => (
            <div key={title} className="pilot-list-row" style={{ padding: '9px 2px' }}>
              <span className="pilot-tile teal" style={{ width: 32, height: 32 }}><Sparkles size={14} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{title}</strong><small>{detail}</small></div>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Quick Actions</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}><Upload size={15} /> Upload Resume</button>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}><Map size={15} /> Create New Roadmap</button>
          <button type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }}><Target size={15} /> Add New Goal</button>
        </div>
      </section>
    </aside>
  </div>;
}

// ---------------------------------------------------------------------------
// Scholarships
// ---------------------------------------------------------------------------

const SCHOLARSHIPS = [
  { name: 'Veridian Tech Future Engineers Grant', provider: 'Veridian Tech Foundation', kind: 'Merit Based', amount: '₹1,00,000', deadline: '30 Jun 2027', tone: 'green', mark: 'VD' },
  { name: 'Kortex STEM Excellence Scholarship', provider: 'Kortex Systems', kind: 'Merit Based', amount: '₹75,000', deadline: '15 Jul 2027', tone: 'indigo', mark: 'KX' },
  { name: 'BlueRiver Women in Analytics Award', provider: 'BlueRiver Analytics', kind: 'Merit + Need', amount: '₹1,25,000', deadline: '30 Jun 2027', tone: 'teal', mark: 'BR' },
  { name: 'Nimbus First-Generation Scholars', provider: 'Nimbus Digital', kind: 'Need Based', amount: '₹50,000', deadline: '10 Jul 2027', tone: 'amber', mark: 'ND' },
  { name: 'Orbitech Merit Scholarship', provider: 'Orbitech Solutions', kind: 'Merit Based', amount: '₹2,00,000', deadline: '20 Jun 2027', tone: 'rose', mark: 'OT' },
] as const;

const SCHOLARSHIP_DEADLINES = [
  ['Orbitech Merit Scholarship', '20 Jun', '5 days left'], ['Veridian Future Engineers', '30 Jun', '15 days left'],
  ['BlueRiver Women in Analytics', '30 Jun', '15 days left'], ['Nimbus First-Gen Scholars', '10 Jul', '25 days left'],
] as const;

export function PilotScholarships(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Scholarships</h1><p>Discover and apply for scholarships to support your education journey.</p></div>
      </div>
      <PilotTabs labels={['Overview', 'Recommended', 'Merit Based', 'Need Based', 'Deadlines']} />

      <section className="pilot-hero">
        <div style={{ flex: 1 }}>
          <h2>Your Scholarship Overview</h2>
          <p>Track your applications and never miss an opportunity.</p>
          <div className="pilot-row cols-5" style={{ marginTop: 12 }}>
            {[
              ['Available', '24', 'blue', Landmark], ['Applied', '7', 'indigo', PenTool],
              ['Shortlisted', '2', 'green', CheckCircle2], ['Awarded', '1', 'amber', Award],
              ['Potential Value', '₹1.25L', 'purple', Star],
            ].map(([label, value, tone, Icon]) => (
              <div key={label as string} className="pilot-stat">
                {(() => { const Component = Icon as typeof Award; return <span className={`pilot-tile ${tone as string}`}><Component size={16} /></span>; })()}
                <div><b>{value as string}</b><small>{label as string}</small></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Top Scholarships for You</h2><button type="button" className="pilot-link">View All →</button></div>
        <div className="pilot-list">
          {SCHOLARSHIPS.map((scholarship) => (
            <div key={scholarship.name} className="pilot-list-row">
              <span className={`pilot-mark ${scholarship.tone}`}>{scholarship.mark}</span>
              <div className="grow">
                <strong>{scholarship.name}</strong>
                <small>{scholarship.provider} · Apply by {scholarship.deadline}</small>
              </div>
              <span className={`pilot-chip ${scholarship.kind === 'Need Based' ? 'blue' : scholarship.kind === 'Merit + Need' ? 'amber' : 'green'}`}>{scholarship.kind}</span>
              <b style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Up to {scholarship.amount}</b>
              <Bookmark size={15} color="#98a5ba" />
              <button type="button" className="pilot-btn small">Apply Now</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <h2>Explore by Category</h2>
        <div className="pilot-row cols-5">
          {[
            ['Engineering', 8], ['Computer Science', 6], ['Commerce', 4], ['Arts & Humanities', 3], ['General', 3],
          ].map(([label, count]) => (
            <div key={label as string} className="pilot-cat">
              <span className="pilot-tile purple" style={{ width: 32, height: 32 }}><Landmark size={14} /></span>
              <div><strong>{label as string}</strong><small>{count as number} Scholarships</small></div>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Scholarship Insights</h2><small style={{ color: 'var(--p-muted)' }}>This month</small></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={[
            { value: 54, color: '#5936cf' }, { value: 22, color: '#1f55e5' },
            { value: 15, color: '#0d6b4f' }, { value: 9, color: '#b45309' },
          ]}>24<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Available</div></MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#5936cf' }} /> Merit Based <span className="num">54%</span></div>
            <div><i style={{ background: '#1f55e5' }} /> Need Based <span className="num">22%</span></div>
            <div><i style={{ background: '#0d6b4f' }} /> Corporate <span className="num">15%</span></div>
            <div><i style={{ background: '#b45309' }} /> Private <span className="num">9%</span></div>
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Deadlines</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {SCHOLARSHIP_DEADLINES.map(([name, date, left]) => (
            <div key={name} className="pilot-list-row" style={{ padding: '8px 2px' }}>
              <div className="pilot-date"><b>{date.split(' ')[1]}</b><span>{date.split(' ')[0]}</span></div>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{name}</strong></div>
              <span className="pilot-chip rose">{left}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Application Tracker</h2>
        <div className="pilot-row cols-4" style={{ textAlign: 'center' }}>
          {[['7', 'Applied', 'blue'], ['2', 'Shortlisted', 'purple'], ['1', 'Awarded', 'green'], ['2', 'Closed', 'rose']].map(([value, label, tone]) => (
            <div key={label}><span className={`pilot-tile ${tone}`} style={{ margin: '0 auto 6px' }}><Award size={16} /></span><b style={{ fontSize: 16 }}>{value}</b><small style={{ display: 'block', color: 'var(--p-muted)', fontSize: 10.5 }}>{label}</small></div>
          ))}
        </div>
      </section>
      <div className="pilot-banner"><Sparkles size={17} /> Complete your profile to get better scholarship recommendations.</div>
    </aside>
  </div>;
}

// ---------------------------------------------------------------------------
// Resume Builder
// ---------------------------------------------------------------------------

const RESUME_TEMPLATES: readonly { readonly name: string; readonly note: string; readonly selected?: boolean }[] = [
  { name: 'Modern', note: 'Recommended', selected: true }, { name: 'Professional', note: 'Clean & Simple' },
  { name: 'Creative', note: 'Stand Out' }, { name: 'Minimal', note: 'ATS Friendly' }, { name: 'Executive', note: 'For Experienced' },
];

const RECENT_RESUMES = [
  ['Software Engineer Resume', 'Updated 2 hours ago', 78], ['Internship Resume', 'Updated 2 days ago', 72],
  ['Campus Placement Resume', 'Updated 1 week ago', 68],
] as const;

const RESUME_TOOLS = [
  { title: 'Resume Editor', detail: 'Create and edit your resume with ease.', action: 'Create New', tone: 'green' },
  { title: 'Import Resume', detail: 'Upload your existing resume and improve it.', action: 'Import Now', tone: 'purple' },
  { title: 'Resume Score', detail: 'Get a score and tips to improve your resume.', action: 'Check Score', tone: 'amber' },
  { title: 'Content Helper', detail: 'Guided summaries, bullets and skills.', action: 'Get Suggestions', tone: 'blue' },
  { title: 'Download Resume', detail: 'Download your resume as PDF.', action: 'Download', tone: 'teal' },
] as const;

export function PilotResumeBuilder(): React.ReactElement {
  return <div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Resume Builder</h1><p>Create professional resumes that showcase your skills and land your dream job.</p></div>
        <button type="button" className="pilot-btn"><FileText size={15} /> Create New Resume</button>
      </div>
      <PilotTabs labels={['My Resumes', 'Templates', 'Examples', 'Resume Score']} />

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Choose a Template</h2><button type="button" className="pilot-link">View All Templates →</button></div>
        <div className="pilot-row cols-5">
          {RESUME_TEMPLATES.map((template) => (
            <div key={template.name} className="pilot-course-card" style={template.selected ? { outline: '2px solid #1f55e5', outlineOffset: 1 } : undefined}>
              <div className="pilot-course-art" style={{ background: template.selected ? 'linear-gradient(135deg, #1d4ed8, #1e3a8a)' : 'linear-gradient(135deg, #64748b, #334155)' }}><FileText size={22} /></div>
              <strong>{template.name}</strong>
              <small>{template.note}</small>
              <button type="button" className={`pilot-btn small ${template.selected ? '' : 'ghost'}`}>{template.selected ? 'Selected' : 'Use Template'}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <h2>Resume Tools</h2>
        <div className="pilot-row cols-5">
          {RESUME_TOOLS.map((tool) => (
            <div key={tool.title} className="pilot-course-card">
              <span className="pilot-tile" style={{ background: `${toneColor(tool.tone)}1a`, color: toneColor(tool.tone) }}><PenTool size={17} /></span>
              <strong>{tool.title}</strong>
              <small>{tool.detail}</small>
              <button type="button" className="pilot-btn ghost small">{tool.action} →</button>
            </div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <h2>Resume Best Practices</h2>
        <div className="pilot-row cols-4">
          {[
            ['Keep it concise', '1-2 pages ideal'], ['Use strong action verbs', 'Start with action words'],
            ['Quantify achievements', 'Use numbers & results'], ['Tailor to the job', 'Customise for each role'],
          ].map(([title, detail]) => (
            <div key={title} style={{ display: 'flex', gap: 10 }}>
              <CheckCircle2 size={16} color="#0d6b4f" style={{ flexShrink: 0, marginTop: 2 }} />
              <div><strong style={{ fontSize: 12.5, display: 'block' }}>{title}</strong><small style={{ color: 'var(--p-muted)' }}>{detail}</small></div>
            </div>
          ))}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Resume Overview</h2><button type="button" className="pilot-link">View Details</button></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Ring value={78} size={88} stroke={10} tone="blue"><span style={{ fontSize: 19 }}>78</span></Ring>
          <div className="pilot-legend" style={{ flex: 1 }}>
            <div><i style={{ background: '#0d6b4f' }} /> Content <span className="num">85/100</span></div>
            <div><i style={{ background: '#1f55e5' }} /> Format <span className="num">75/100</span></div>
            <div><i style={{ background: '#5936cf' }} /> Skills <span className="num">80/100</span></div>
            <div><i style={{ background: '#b45309' }} /> Impact <span className="num">72/100</span></div>
          </div>
        </div>
        <small style={{ display: 'block', marginTop: 10, color: 'var(--p-muted)' }}>Your resume is strong. Improve a few areas to make it exceptional.</small>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recent Resumes</h2><button type="button" className="pilot-link">View All</button></div>
        <div className="pilot-list">
          {RECENT_RESUMES.map(([title, when, score]) => (
            <div key={title as string} className="pilot-list-row">
              <span className="pilot-tile blue" style={{ width: 34, height: 34 }}><FileText size={15} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{title as string}</strong><small>{when as string}</small></div>
              <span className={`pilot-chip ${(score as number) >= 75 ? 'green' : 'amber'}`}>{score as number}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <h2>Resume Tips</h2>
        <div className="pilot-list">
          {[
            ['Top 10 resume formatting tips', 'Make your resume ATS friendly'],
            ['How to write a strong summary', 'Grab recruiter attention'],
            ['Skills to add in 2027', 'Top in-demand skills by industry'],
          ].map(([title, detail]) => (
            <div key={title} className="pilot-list-row" style={{ padding: '9px 2px' }}>
              <span className="pilot-tile amber" style={{ width: 32, height: 32 }}><Sparkles size={14} /></span>
              <div className="grow"><strong style={{ fontSize: 12.5 }}>{title}</strong><small>{detail}</small></div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  </div>;
}
