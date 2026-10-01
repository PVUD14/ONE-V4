/**
 * The demo site served at demo.oneby8.com - a separate build (VITE_DEMO_SITE=true, see
 * src/main.tsx and deploy/vps/docker-compose.yml) that contains only this file's tree:
 * no sign-in, no API calls, no real data. The production build of oneby8.com contains
 * none of it (scripts/check-demo-boundary.mjs proves both on every image build).
 *
 * A visitor picks a role and walks that role's portal over clearly fictional sample
 * data. Every screen carries the "Demo — sample data" marker, and everything resets on
 * reload because nothing is stored anywhere.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, Briefcase, Building2, CheckCircle2, GraduationCap, Mail, MapPinned, School, ShieldCheck, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import '../pilot/pilot.css';
import { BrandLogo } from '../brand.js';
import { EmployerPilot, InstitutionPilot, StudentPilot, type PilotPortalProps } from '../pilot/PilotApp.js';
import { GraduatePilot, GrowthPilot, LecturerPilot, OperationsPilot } from './demoPortals.js';

export const DEMO_TAGLINE = 'LEARN | PREPARE | BUILD | GROW';
export const DEMO_MARKER = 'Demo — sample data';

interface DemoRole {
  readonly path: string;
  readonly role: string;
  readonly person: string;
  readonly summary: string;
  readonly tryThis: readonly string[];
  readonly icon: LucideIcon;
  readonly tone: string;
  readonly email: string;
  readonly Portal: (props: PilotPortalProps) => React.ReactElement;
}

export const DEMO_ROLES: readonly DemoRole[] = [
  {
    path: '/student', role: 'Student', person: 'Arjun Reddy · B.Tech CSE, final year', icon: GraduationCap, tone: 'blue', email: 'arjun.demo@one.example',
    summary: 'Practice, take placement tests, see skill gaps and a readiness band, follow a learning plan and apply for jobs.',
    tryThis: ['Dashboard → readiness band', 'Assessments → take a test', 'Opportunities → Apply Now'],
    Portal: StudentPilot,
  },
  {
    path: '/graduate', role: 'Graduate', person: 'Kavitha Selvam · graduated 2022', icon: BadgeCheck, tone: 'purple', email: 'kavitha.selvam@mail.example',
    summary: 'Already left college? Ask your old college to verify your degree and marks, then share them with employers.',
    tryThis: ['Verification → send a request', 'My Records → share profile'],
    Portal: GraduatePilot,
  },
  {
    path: '/placement-officer', role: 'Placement Officer', person: 'Prof. Meera Nair · Lakeview Institute', icon: School, tone: 'indigo', email: 'meera.demo@lakeview.example',
    summary: 'Upload the student roster, see readiness bands by batch and department, run campus drives and interventions.',
    tryThis: ['Students → Upload Roster', 'Dashboard → readiness bands', 'Placement Drives → Schedule Drive'],
    Portal: InstitutionPilot,
  },
  {
    path: '/lecturer', role: 'Lecturer', person: 'Prof. Suresh Raman · CSE', icon: UserRound, tone: 'teal', email: 'suresh.raman@lakeview.example',
    summary: 'Run class assessments, verify student evidence and former students’ records, assign practice.',
    tryThis: ['Evidence & Verification', 'Assessments → Create Assessment'],
    Portal: LecturerPilot,
  },
  {
    path: '/employer', role: 'Employer', person: 'Rohan Iyer · Zenvia Labs', icon: Briefcase, tone: 'green', email: 'rohan.demo@zenvia.example',
    summary: 'A verified employer posts roles, moves applicants through the pipeline and sees only the evidence students chose to share.',
    tryThis: ['Company Profile → verification', 'Opportunities → Post a Role', 'Applicants → Profile'],
    Portal: EmployerPilot,
  },
  {
    path: '/operations', role: 'Operations', person: 'Ananya Kulkarni · AI8HT', icon: ShieldCheck, tone: 'amber', email: 'ananya.ops@one.example',
    summary: 'Onboard a college, verify employers before they can hire, invite staff and keep the audit trail.',
    tryThis: ['Colleges → Onboard a College', 'Employer Verification → Review'],
    Portal: OperationsPilot,
  },
  {
    path: '/growth', role: 'Growth', person: 'Vikram Shetty · Partnerships', icon: MapPinned, tone: 'rose', email: 'vikram.growth@one.example',
    summary: 'The field team bringing colleges and employers onto ONE: leads, visits, territory, targets.',
    tryThis: ['Leads → Advance', 'Field Visits → Log Visit'],
    Portal: GrowthPilot,
  },
];

export const JOIN_PATH = '/student/join';

function currentPath(): string {
  const path = window.location.pathname.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

export function DemoSite(): React.ReactElement {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPop = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (next: string): void => {
    window.history.pushState(null, '', next);
    setPath(next);
    // A new role starts at the top of the page; jsdom (tests) has no layout to scroll.
    if (!/jsdom/i.test(window.navigator.userAgent)) window.scrollTo(0, 0);
  };
  const role = DEMO_ROLES.find((entry) => entry.path === path);
  useEffect(() => {
    document.title = path === JOIN_PATH ? 'Demo · Student joins | ONE by AI8HT' : role ? `Demo · ${role.role} | ONE by AI8HT` : 'Demo | ONE by AI8HT';
  }, [path, role]);

  if (path === JOIN_PATH) return <JoinWalkthrough onDone={() => go('/student')} onOpen={go} />;
  if (role) {
    const { Portal } = role;
    // Keyed by path: switching roles always starts that portal fresh.
    return <Portal key={role.path} email={role.email} onSignOut={() => go('/')} signOutLabel="Switch role" />;
  }
  return <DemoLanding onOpen={go} />;
}

function DemoSidebar({ onOpen, active }: { readonly onOpen: (path: string) => void; readonly active: string }): React.ReactElement {
  return <aside className="pilot-sidebar" aria-label="Demo roles">
    <div className="pilot-brand">
      <BrandLogo height={46} />
      <span><small>{DEMO_TAGLINE}</small></span>
    </div>
    <button type="button" className={`pilot-nav-item ${active === '/' ? 'active' : ''}`} onClick={() => onOpen('/')}><Building2 size={17} /> All roles</button>
    {DEMO_ROLES.map((entry) => {
      const Icon = entry.icon;
      return <button key={entry.path} type="button" className={`pilot-nav-item ${active === entry.path ? 'active' : ''}`} onClick={() => onOpen(entry.path)}><Icon size={17} /> {entry.role}</button>;
    })}
    <div className="pilot-side-note">
      <strong>ONE by AI8HT</strong>
      <p>Demo environment · sample data only · resets when you reload.</p>
    </div>
  </aside>;
}

function DemoTopbar(): React.ReactElement {
  return <header className="pilot-topbar">
    <strong style={{ fontSize: 13 }}>ONE product demo</strong>
    <div className="pilot-topbar-actions"><span className="pilot-sample-chip">{DEMO_MARKER}</span></div>
  </header>;
}

function DemoLanding({ onOpen }: { readonly onOpen: (path: string) => void }): React.ReactElement {
  return <div className="pilot">
    <DemoSidebar onOpen={onOpen} active="/" />
    <div className="pilot-main">
      <DemoTopbar />
      <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}>
        <div className="pilot-content">
          <section className="pilot-hero">
            <div>
              <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>See ONE through the eyes of everyone who uses it</h1>
              <p>ONE takes a student from campus to career: learn, prepare, build evidence of skills and grow into a job - with the college, the employer and AI8HT each seeing exactly what they should. Pick a role below. Everything here is fictional sample data.</p>
            </div>
            <button type="button" className="pilot-btn" onClick={() => onOpen(JOIN_PATH)}>Start with a student joining <ArrowRight size={15} /></button>
          </section>

          <div className="pilot-row cols-3">
            {DEMO_ROLES.map((entry) => {
              const Icon = entry.icon;
              return <section key={entry.path} className="pilot-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span className={`pilot-tile ${entry.tone}`}><Icon size={18} /></span>
                  <div style={{ minWidth: 0 }}><h2 style={{ margin: 0 }}>{entry.role}</h2><small style={{ color: 'var(--p-muted)' }}>{entry.person}</small></div>
                </div>
                <p className="pilot-modal-text">{entry.summary}</p>
                <div className="pilot-list">
                  {entry.tryThis.map((step) => (
                    <div key={step} className="pilot-list-row" style={{ padding: '5px 2px' }}>
                      <ArrowRight size={13} color="#98a5ba" /><small style={{ color: 'var(--p-ink-2)' }}>{step}</small>
                    </div>
                  ))}
                </div>
                <button type="button" className="pilot-btn" style={{ marginTop: 'auto' }} onClick={() => onOpen(entry.path)}>Open {entry.role} demo</button>
              </section>;
            })}
          </div>

          <section className="pilot-card">
            <h2>About this demo</h2>
            <div className="pilot-list">
              {[
                'Every person, college, company and number on this site is invented for the demo. Nothing you do here is saved; reload to start again.',
                'Readiness is always an advisory band - never a score - and it is never shown to employers. The demo follows the same rule.',
                'Some screens show what ONE is growing into. Ask the presenter which parts your college can use today.',
              ].map((line) => (
                <div key={line} className="pilot-list-row" style={{ padding: '8px 2px' }}>
                  <CheckCircle2 size={15} color="#0d6b4f" style={{ flexShrink: 0 }} />
                  <small style={{ color: 'var(--p-ink-2)' }}>{line}</small>
                </div>
              ))}
            </div>
            <small style={{ display: 'block', marginTop: 10, color: 'var(--p-muted)' }}>© AI8HT. All rights reserved.</small>
          </section>
        </div>
      </div>
    </div>
  </div>;
}

/** How a student arrives: an invitation from their college, a sign-in, a details check, consent. */
function JoinWalkthrough({ onDone, onOpen }: { readonly onDone: () => void; readonly onOpen: (path: string) => void }): React.ReactElement {
  const [step, setStep] = useState(0);
  const steps = ['Invitation', 'Sign in', 'Check details', 'Your choices'];
  return <div className="pilot">
    <DemoSidebar onOpen={onOpen} active="/student" />
    <div className="pilot-main">
      <DemoTopbar />
      <div className="pilot-page">
        <div className="pilot-content">
          <div className="pilot-page-head"><div className="pilot-greeting"><h1>Joining ONE</h1><p>Students join through their college: the placement cell uploads the roster and each student gets an invitation.</p></div></div>
          <div className="pilot-phases">
            {steps.map((label, index) => <span key={label} className={`pilot-phase ${index === step ? 'active' : ''}`}><span><strong>{index + 1}. {label}</strong><small>{index < step ? 'Done' : index === step ? 'Now' : 'Next'}</small></span></span>)}
          </div>
          <section className="pilot-card">
            {step === 0 ? <div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                <span className="pilot-tile blue"><Mail size={18} /></span>
                <div><strong>Lakeview Placement Cell invited you to ONE</strong><small style={{ display: 'block', color: 'var(--p-muted)' }}>To: arjun.demo@one.example · sample email</small></div>
              </div>
              <p className="pilot-modal-text">Hi Arjun, Lakeview Institute of Technology uses ONE for placement preparation. Accept this invitation to see your assessments, learning plan and campus drives.</p>
              <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="pilot-btn" onClick={() => setStep(1)}>Accept Invitation</button></div>
            </div> : null}
            {step === 1 ? <div style={{ maxWidth: 420 }}>
              <label className="pilot-field"><span>Email</span><input type="email" value="arjun.demo@one.example" readOnly /></label>
              <p className="pilot-modal-text">The student signs in with the email the college used. In the demo there is nothing to type.</p>
              <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="pilot-btn" onClick={() => setStep(2)}>Continue</button></div>
            </div> : null}
            {step === 2 ? <div>
              <div className="pilot-detail-rows">
                {[['Name', 'Arjun Reddy'], ['Registration', 'LIT2027-0412'], ['Programme', 'B.Tech CSE · Class of 2027'], ['College', 'Lakeview Institute of Technology']].map(([label, value]) => (
                  <div key={label}><small>{label}</small><strong>{value}</strong></div>
                ))}
              </div>
              <p className="pilot-modal-text" style={{ marginTop: 12 }}>These came from the college roster, so the student does not type them again.</p>
              <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="pilot-btn" onClick={() => setStep(3)}>These Are Right</button></div>
            </div> : null}
            {step === 3 ? <div>
              <div className="pilot-list">
                {[
                  ['Use my activity to build my readiness band and learning plan', 'Needed to use ONE'],
                  ['Share verified evidence with employers I apply to', 'You can change this any time'],
                  ['Readiness band visible to employers', 'Never - this is not a choice'],
                ].map(([label, detail]) => (
                  <div key={label} className="pilot-list-row" style={{ padding: '8px 2px' }}>
                    <CheckCircle2 size={15} color="#0d6b4f" style={{ flexShrink: 0 }} />
                    <div className="grow"><strong style={{ fontSize: 12.5 }}>{label}</strong><small>{detail}</small></div>
                  </div>
                ))}
              </div>
              <div className="pilot-modal-actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="pilot-btn" onClick={onDone}>Open My Dashboard <ArrowRight size={15} /></button></div>
            </div> : null}
          </section>
        </div>
        <aside className="pilot-rail">
          <section className="pilot-card">
            <h2>Why through the college?</h2>
            <p className="pilot-modal-text">The college vouches for who its students are. That is what makes a verified record on ONE worth something to an employer.</p>
          </section>
        </aside>
      </div>
    </div>
  </div>;
}
