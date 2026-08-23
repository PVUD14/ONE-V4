import { useState } from 'react';
import { Bell, BookOpen, Briefcase, Building2, CalendarDays, ClipboardCheck, FileText, GraduationCap, Home, MapPinned, MessageSquare, Route, Search, User, Users, Video, Wrench } from 'lucide-react';
import './pilot.css';
import { pilotPersona } from './pilotData.js';
import { pilotEmployerPersona, pilotInstitutionPersona } from './pilotStaffData.js';
import { PilotAssessments, PilotDashboard, PilotLearn, PilotOpportunities, PilotProfile, PilotRoadmap } from './pilotPages.js';
import { InstitutionDashboard, InstitutionDrives, InstitutionReports, InstitutionStudents } from './pilotInstitutionPages.js';
import { EmployerApplicants, EmployerDashboard, EmployerInterviews, EmployerOpportunities } from './pilotEmployerPages.js';

/**
 * The pilot shell shown to demo identities, at sample fidelity over curated data.
 *
 * Which portal renders is decided by the demo identity itself: demo.institution*
 * sees the placement officer's college, demo.employer* sees the recruiter's company,
 * any other demo.* sees the student. The three tell one coherent story - the student
 * from the first demo appears in the institution's roster and the employer's
 * pipeline, which is the cross-portal moment a client demo is for.
 *
 * Navigation is internal state rather than URL routing so the pilot can never
 * interfere with the real application's path handling.
 */

type PilotPersonaKind = 'student' | 'institution' | 'employer';

export function pilotPersonaFor(email: string): PilotPersonaKind {
  const local = email.trim().toLowerCase();
  if (local.startsWith('demo.institution') || local.startsWith('demo.placement')) return 'institution';
  if (local.startsWith('demo.employer') || local.startsWith('demo.recruiter')) return 'employer';
  return 'student';
}

interface NavEntry {
  readonly key: string;
  readonly label: string;
  readonly icon: typeof Home;
  readonly soon?: boolean;
}

function PilotShell({ identity, nav, page, onNavigate, onSignOut, email, children }: {
  readonly identity: { readonly name: string; readonly initials: string; readonly subtitle: string };
  readonly nav: readonly NavEntry[];
  readonly page: string;
  readonly onNavigate: (key: string) => void;
  readonly onSignOut: () => void;
  readonly email: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <div className="pilot">
    <aside className="pilot-sidebar" aria-label="Pilot navigation">
      <div className="pilot-brand">
        <span className="pilot-brand-mark">8</span>
        <span><strong>ONE</strong><small>LEARN | PREPARE | BUILD | GROW</small></span>
      </div>
      {nav.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.key} type="button" className={`pilot-nav-item ${page === item.key ? 'active' : ''}`}
            aria-current={page === item.key ? 'page' : undefined} onClick={() => onNavigate(item.key)}>
            <Icon size={17} /> {item.label}{item.soon ? <small>Soon</small> : null}
          </button>
        );
      })}
      <div className="pilot-side-note">
        <strong>ONE by Ai8ht</strong>
        <p>Pilot preview environment.</p>
      </div>
    </aside>

    <div className="pilot-main">
      <header className="pilot-topbar">
        <div className="pilot-search"><Search size={15} /> Search…</div>
        <div className="pilot-topbar-actions">
          <span className="pilot-sample-chip" title={`Signed in as ${email}`}>Sample data</span>
          <button type="button" className="pilot-icon-button" aria-label="Messages"><MessageSquare size={16} /></button>
          <button type="button" className="pilot-icon-button" aria-label="Notifications"><Bell size={16} /><span className="pilot-dot">3</span></button>
          <div className="pilot-user">
            <span className="pilot-avatar">{identity.initials}</span>
            <span><strong>{identity.name}</strong><small>{identity.subtitle}</small></span>
          </div>
          <button type="button" className="pilot-signout" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      {children}
    </div>
  </div>;
}

const STUDENT_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'roadmap', label: 'My Roadmap', icon: Route },
  { key: 'learn', label: 'Learn', icon: BookOpen },
  { key: 'assessments', label: 'Assessments', icon: ClipboardCheck },
  { key: 'opportunities', label: 'Opportunities', icon: Briefcase },
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'practice', label: 'Practice', icon: Wrench, soon: true },
  { key: 'company-prep', label: 'Company Prep', icon: Building2, soon: true },
  { key: 'career-tools', label: 'Career Tools', icon: MapPinned, soon: true },
  { key: 'scholarships', label: 'Scholarships', icon: GraduationCap, soon: true },
  { key: 'resume', label: 'Resume Builder', icon: FileText, soon: true },
];

const STUDENT_SOON: Readonly<Record<string, string>> = {
  practice: 'Practice', 'company-prep': 'Company Prep', 'career-tools': 'Career Tools',
  scholarships: 'Scholarships', resume: 'Resume Builder',
};

function StudentPilot({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  return <PilotShell
    identity={{ name: pilotPersona.name, initials: pilotPersona.initials, subtitle: pilotPersona.programme }}
    nav={STUDENT_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} email={email}>
    {page === 'dashboard' ? <PilotDashboard /> : null}
    {page === 'roadmap' ? <PilotRoadmap /> : null}
    {page === 'learn' ? <PilotLearn /> : null}
    {page === 'assessments' ? <PilotAssessments /> : null}
    {page === 'opportunities' ? <PilotOpportunities /> : null}
    {page === 'profile' ? <PilotProfile /> : null}
    {STUDENT_SOON[page] ? <ComingSoon label={STUDENT_SOON[page]} /> : null}
  </PilotShell>;
}

const INSTITUTION_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'students', label: 'Students', icon: Users },
  { key: 'drives', label: 'Placement Drives', icon: Building2 },
  { key: 'reports', label: 'Reports', icon: FileText },
  { key: 'assessments', label: 'Assessments', icon: ClipboardCheck, soon: true },
  { key: 'interventions', label: 'Interventions', icon: CalendarDays, soon: true },
];

const INSTITUTION_SOON: Readonly<Record<string, string>> = {
  assessments: 'Assessments', interventions: 'Interventions',
};

function InstitutionPilot({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  return <PilotShell
    identity={{ name: pilotInstitutionPersona.name, initials: pilotInstitutionPersona.initials, subtitle: `${pilotInstitutionPersona.role} · VIT Chennai` }}
    nav={INSTITUTION_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} email={email}>
    {page === 'dashboard' ? <InstitutionDashboard /> : null}
    {page === 'students' ? <InstitutionStudents /> : null}
    {page === 'drives' ? <InstitutionDrives /> : null}
    {page === 'reports' ? <InstitutionReports /> : null}
    {INSTITUTION_SOON[page] ? <ComingSoon label={INSTITUTION_SOON[page]} /> : null}
  </PilotShell>;
}

const EMPLOYER_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'opportunities', label: 'Opportunities', icon: Briefcase },
  { key: 'applicants', label: 'Applicants', icon: Users },
  { key: 'interviews', label: 'Interviews', icon: Video },
  { key: 'offers', label: 'Offers', icon: FileText, soon: true },
  { key: 'company', label: 'Company Profile', icon: Building2, soon: true },
];

const EMPLOYER_SOON: Readonly<Record<string, string>> = {
  offers: 'Offers', company: 'Company Profile',
};

function EmployerPilot({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  return <PilotShell
    identity={{ name: pilotEmployerPersona.name, initials: pilotEmployerPersona.initials, subtitle: pilotEmployerPersona.subtitle }}
    nav={EMPLOYER_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} email={email}>
    {page === 'dashboard' ? <EmployerDashboard /> : null}
    {page === 'opportunities' ? <EmployerOpportunities /> : null}
    {page === 'applicants' ? <EmployerApplicants /> : null}
    {page === 'interviews' ? <EmployerInterviews /> : null}
    {EMPLOYER_SOON[page] ? <ComingSoon label={EMPLOYER_SOON[page]} /> : null}
  </PilotShell>;
}

function ComingSoon({ label }: { readonly label: string }): React.ReactElement {
  return <div className="pilot-page" style={{ gridTemplateColumns: '1fr' }}><div className="pilot-content"><section className="pilot-card pilot-coming">
    <div>
      <span className="pilot-tile blue" style={{ width: 52, height: 52, margin: '0 auto' }}><Wrench size={22} /></span>
      <h2>{label} is coming to the pilot</h2>
      <p>This module is in build. The screens you can open on the left show the full experience with sample data.</p>
    </div>
  </section></div></div>;
}

export function PilotApp({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const persona = pilotPersonaFor(email);
  if (persona === 'institution') return <InstitutionPilot email={email} onSignOut={onSignOut} />;
  if (persona === 'employer') return <EmployerPilot email={email} onSignOut={onSignOut} />;
  return <StudentPilot email={email} onSignOut={onSignOut} />;
}
