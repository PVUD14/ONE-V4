import { useCallback, useState } from 'react';
import { Bell, BookOpen, Briefcase, Building2, CalendarDays, ClipboardCheck, FileText, GraduationCap, Home, MapPinned, MessageSquare, Route, Search, User, Users, Video, Wrench } from 'lucide-react';
import './pilot.css';
import { BrandLogo } from '../brand.js';
import { AssistantWidget } from '../assistantWidget.js';
import { pilotCompanies, pilotPersona, pilotPopularCourses } from './pilotData.js';
import { pilotApplicants, pilotEmployerPersona, pilotEmployerRoles, pilotInstitutionPersona, pilotRoster } from './pilotStaffData.js';
import {
  employerMessages, employerNotifications, institutionMessages, institutionNotifications,
  studentMessages, studentNotifications,
} from './pilotTabData.js';
import { PilotAssessments, PilotDashboard, PilotLearn, PilotOpportunities, PilotProfile, PilotRoadmap } from './pilotPages.js';
import { PilotCareerTools, PilotCompanyPrep, PilotPractice, PilotResumeBuilder, PilotScholarships } from './pilotPagesTier2.js';
import { InstitutionDashboard, InstitutionDrives, InstitutionReports, InstitutionStudents } from './pilotInstitutionPages.js';
import { EmployerApplicants, EmployerDashboard, EmployerInterviews, EmployerOpportunities } from './pilotEmployerPages.js';
import { EmployerCompany, EmployerOffers, InstitutionAssessments, InstitutionInterventions } from './pilotStaffExtraPages.js';
import { PilotOverlayProvider, usePilotClickFallback, type PilotShellConfig, type SearchEntry } from './pilotOverlay.js';
import { IdentityCardBody, NotificationsBody, PilotAvatar } from './pilotShare.js';
import { PilotSessionProvider, usePilotSession } from './pilotSession.js';

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
 * interfere with the real application's path handling. Every click lands
 * somewhere: bespoke handlers where the flow matters, the overlay fallback
 * (see pilotOverlay) everywhere else.
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
}

function ShellMain({ config, identity, onSignOut, email, children }: {
  readonly config: PilotShellConfig;
  readonly identity: { readonly name: string; readonly initials: string; readonly subtitle: string };
  readonly onSignOut: () => void;
  readonly email: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const fallback = usePilotClickFallback(config);
  const session = usePilotSession();
  const unread = session.notifications.filter((entry) => !entry.read).length;
  return <div className="pilot-main" onClick={fallback}>
    <header className="pilot-topbar">
      <div className="pilot-search"><Search size={15} /> Search…</div>
      <div className="pilot-topbar-actions">
        <span className="pilot-sample-chip" title={`Signed in as ${email}`}>Sample data</span>
        <button type="button" className="pilot-icon-button" aria-label="Messages"><MessageSquare size={16} /></button>
        <button type="button" className="pilot-icon-button" aria-label="Notifications"><Bell size={16} />{unread > 0 ? <span className="pilot-dot">{unread}</span> : null}</button>
        <div className="pilot-user" role="button" tabIndex={0}>
          <PilotAvatar initials={identity.initials} />
          <span><strong>{identity.name}</strong><small>{identity.subtitle}</small></span>
        </div>
        <button type="button" className="pilot-signout" onClick={(event) => { event.stopPropagation(); onSignOut(); }}>Sign out</button>
      </div>
    </header>
    {children}
  </div>;
}

const STUDENT_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'roadmap', label: 'My Roadmap', icon: Route },
  { key: 'learn', label: 'Learn', icon: BookOpen },
  { key: 'assessments', label: 'Assessments', icon: ClipboardCheck },
  { key: 'practice', label: 'Practice', icon: Wrench },
  { key: 'company-prep', label: 'Company Prep', icon: Building2 },
  { key: 'career-tools', label: 'Career Tools', icon: MapPinned },
  { key: 'opportunities', label: 'Opportunities', icon: Briefcase },
  { key: 'scholarships', label: 'Scholarships', icon: GraduationCap },
  { key: 'resume', label: 'Resume Builder', icon: FileText },
  { key: 'profile', label: 'Profile', icon: User },
];

function StudentPilot({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  const navigate = useCallback((key: string) => setPage(key), []);
  return <PilotSessionProvider navigate={navigate} initialNotifications={studentNotifications}>
    <PilotShell
      identity={{ name: pilotPersona.name, initials: pilotPersona.initials, subtitle: pilotPersona.programme }}
      nav={STUDENT_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} email={email}
      notifications={studentNotifications} messages={studentMessages}
      searchExtras={[
        ...pilotPopularCourses.map((course) => ({ label: course.title, detail: `Course · ${course.level}`, navKey: 'learn' })),
        ...pilotCompanies.map((company) => ({ label: company.name, detail: 'Company · prep resources available', navKey: 'company-prep' })),
      ]}
      identityRows={[
        ['Programme', 'B.Tech CSE · Class of 2027'],
        ['Institution', pilotPersona.institution],
        ['Career goal', pilotPersona.careerGoal],
        ['Readiness', '72 / 100 · Nearly Job Ready'],
      ]}>
      {page === 'dashboard' ? <PilotDashboard /> : null}
      {page === 'roadmap' ? <PilotRoadmap /> : null}
      {page === 'learn' ? <PilotLearn /> : null}
      {page === 'assessments' ? <PilotAssessments /> : null}
      {page === 'practice' ? <PilotPractice /> : null}
      {page === 'company-prep' ? <PilotCompanyPrep /> : null}
      {page === 'career-tools' ? <PilotCareerTools /> : null}
      {page === 'opportunities' ? <PilotOpportunities /> : null}
      {page === 'scholarships' ? <PilotScholarships /> : null}
      {page === 'resume' ? <PilotResumeBuilder /> : null}
      {page === 'profile' ? <PilotProfile /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}

interface PilotShellProps {
  readonly identity: { readonly name: string; readonly initials: string; readonly subtitle: string };
  readonly nav: readonly NavEntry[];
  readonly page: string;
  readonly onNavigate: (key: string) => void;
  readonly onSignOut: () => void;
  readonly email: string;
  readonly notifications: readonly (readonly [string, string])[];
  readonly messages: readonly (readonly [string, string])[];
  readonly searchExtras: readonly SearchEntry[];
  readonly identityRows: readonly (readonly [string, string])[];
  readonly children: React.ReactNode;
}

function PilotShell({ identity, nav, page, onNavigate, onSignOut, email, notifications, messages, searchExtras, identityRows, children }: PilotShellProps): React.ReactElement {
  const activeLabel = nav.find((item) => item.key === page)?.label ?? page;
  const config: PilotShellConfig = {
    pageTitle: activeLabel,
    notifications,
    notificationsBody: <NotificationsBody />,
    messages,
    onNavigate,
    searchIndex: [
      ...nav.map((item) => ({ label: item.label, detail: 'Open this page', navKey: item.key })),
      ...searchExtras,
    ],
    identityCard: {
      title: identity.name,
      subtitle: identity.subtitle,
      body: <IdentityCardBody rows={identityRows} email={email} initials={identity.initials} />,
    },
  };
  return <div className="pilot">
    <PilotOverlayProvider>
      <aside className="pilot-sidebar" aria-label="Pilot navigation">
        <div className="pilot-brand">
          <BrandLogo height={46} />
          <span><small>LEARN | PREPARE | BUILD | GROW</small></span>
        </div>
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.key} type="button" className={`pilot-nav-item ${page === item.key ? 'active' : ''}`}
              aria-current={page === item.key ? 'page' : undefined} onClick={() => onNavigate(item.key)}>
              <Icon size={17} /> {item.label}
            </button>
          );
        })}
        <div className="pilot-side-note">
          <strong>ONE by AI8HT</strong>
          <p>Pilot preview environment.</p>
        </div>
      </aside>
      <ShellMain config={config} identity={identity} onSignOut={onSignOut} email={email}>
        {children}
      </ShellMain>
    </PilotOverlayProvider>
  </div>;
}

const INSTITUTION_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'students', label: 'Students', icon: Users },
  { key: 'drives', label: 'Placement Drives', icon: Building2 },
  { key: 'assessments', label: 'Assessments', icon: ClipboardCheck },
  { key: 'interventions', label: 'Interventions', icon: CalendarDays },
  { key: 'reports', label: 'Reports', icon: FileText },
];

function InstitutionPilot({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  const navigate = useCallback((key: string) => setPage(key), []);
  return <PilotSessionProvider navigate={navigate} initialNotifications={institutionNotifications}>
    <PilotShell
      identity={{ name: pilotInstitutionPersona.name, initials: pilotInstitutionPersona.initials, subtitle: `${pilotInstitutionPersona.role} · VIT Chennai` }}
      nav={INSTITUTION_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} email={email}
      notifications={institutionNotifications} messages={institutionMessages}
      searchExtras={pilotRoster.map((student) => ({ label: student.name, detail: `Student · ${student.department} · readiness ${student.readiness}`, navKey: 'students' }))}
      identityRows={[
        ['Role', pilotInstitutionPersona.role],
        ['Institution', 'VIT Chennai'],
        ['Cohort', '1,284 active students · 412 placement-eligible'],
        ['Season', '103 offers so far'],
      ]}>
      {page === 'dashboard' ? <InstitutionDashboard /> : null}
      {page === 'students' ? <InstitutionStudents /> : null}
      {page === 'drives' ? <InstitutionDrives /> : null}
      {page === 'assessments' ? <InstitutionAssessments /> : null}
      {page === 'interventions' ? <InstitutionInterventions /> : null}
      {page === 'reports' ? <InstitutionReports /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}

const EMPLOYER_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home },
  { key: 'opportunities', label: 'Opportunities', icon: Briefcase },
  { key: 'applicants', label: 'Applicants', icon: Users },
  { key: 'interviews', label: 'Interviews', icon: Video },
  { key: 'offers', label: 'Offers', icon: FileText },
  { key: 'company', label: 'Company Profile', icon: Building2 },
];

function EmployerPilot({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  const navigate = useCallback((key: string) => setPage(key), []);
  return <PilotSessionProvider navigate={navigate} initialNotifications={employerNotifications}>
    <PilotShell
      identity={{ name: pilotEmployerPersona.name, initials: pilotEmployerPersona.initials, subtitle: pilotEmployerPersona.subtitle }}
      nav={EMPLOYER_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} email={email}
      notifications={employerNotifications} messages={employerMessages}
      searchExtras={[
        ...pilotApplicants.map((applicant) => ({ label: applicant.name, detail: `Candidate · ${applicant.roleApplied}`, navKey: 'applicants' })),
        ...pilotEmployerRoles.map((role) => ({ label: role.title, detail: `Role · ${role.location} · ${role.status}`, navKey: 'opportunities' })),
      ]}
      identityRows={[
        ['Role', pilotEmployerPersona.role],
        ['Company', pilotEmployerPersona.company.name],
        ['Open roles', '6 this season'],
        ['Pipeline', '92 active candidates'],
      ]}>
      {page === 'dashboard' ? <EmployerDashboard /> : null}
      {page === 'opportunities' ? <EmployerOpportunities /> : null}
      {page === 'applicants' ? <EmployerApplicants /> : null}
      {page === 'interviews' ? <EmployerInterviews /> : null}
      {page === 'offers' ? <EmployerOffers /> : null}
      {page === 'company' ? <EmployerCompany /> : null}
    </PilotShell>
  </PilotSessionProvider>;
}

export function PilotApp({ email, onSignOut }: { readonly email: string; readonly onSignOut: () => void }): React.ReactElement {
  const persona = pilotPersonaFor(email);
  const shell = persona === 'institution' ? <InstitutionPilot email={email} onSignOut={onSignOut} />
    : persona === 'employer' ? <EmployerPilot email={email} onSignOut={onSignOut} />
    : <StudentPilot email={email} onSignOut={onSignOut} />;
  return <>{shell}<AssistantWidget persona={persona} /></>;
}
