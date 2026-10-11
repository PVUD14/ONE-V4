import { useCallback, useState } from 'react';
import { Icon, type IconName } from '../icons/Icon.js';
import './pilot.css';
import { BrandLogo } from '../brand.js';
import { ThemeToggle } from '../themeToggle.js';
import { AssistantWidget } from '../assistantWidget.js';
import { pilotCanon, pilotCompanies, pilotPersona, pilotPopularCourses } from './pilotData.js';
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

/** What every pilot portal needs from whoever mounts it: the app (demo identities) or the demo site. */
export interface PilotPortalProps {
  readonly email: string;
  readonly onSignOut: () => void;
  /** The demo site has no accounts; its exit control returns to the role chooser instead. */
  readonly signOutLabel?: string;
}

export function pilotPersonaFor(email: string): PilotPersonaKind {
  const local = email.trim().toLowerCase();
  if (local.startsWith('demo.institution') || local.startsWith('demo.placement')) return 'institution';
  if (local.startsWith('demo.employer') || local.startsWith('demo.recruiter')) return 'employer';
  return 'student';
}

export interface NavEntry {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
}

function ShellMain({ config, identity, onSignOut, signOutLabel, email, children }: {
  readonly config: PilotShellConfig;
  readonly identity: { readonly name: string; readonly initials: string; readonly subtitle: string };
  readonly onSignOut: () => void;
  readonly signOutLabel: string;
  readonly email: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const fallback = usePilotClickFallback(config);
  const session = usePilotSession();
  const unread = session.notifications.filter((entry) => !entry.read).length;
  return <div className="pilot-main" onClick={fallback}>
    <header className="pilot-topbar">
      <div className="pilot-search"><Icon name="search" size={16} /> Search…</div>
      <div className="pilot-topbar-actions">
        <span className="pilot-sample-chip" title={`Signed in as ${email}`}>Demo — sample data</span>
        <ThemeToggle className="pilot-icon-button" />
        <button type="button" className="pilot-icon-button" aria-label="Messages"><Icon name="message" size={16} /></button>
        <button type="button" className="pilot-icon-button" aria-label="Notifications"><Icon name="bell" size={16} />{unread > 0 ? <span className="pilot-dot">{unread}</span> : null}</button>
        <div className="pilot-user" role="button" tabIndex={0}>
          <PilotAvatar initials={identity.initials} />
          <span><strong>{identity.name}</strong><small>{identity.subtitle}</small></span>
        </div>
        <button type="button" className="pilot-signout" onClick={(event) => { event.stopPropagation(); onSignOut(); }}>{signOutLabel}</button>
      </div>
    </header>
    {children}
  </div>;
}

const STUDENT_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'home' },
  { key: 'roadmap', label: 'My Roadmap', icon: 'career' },
  { key: 'learn', label: 'Learn', icon: 'learning' },
  { key: 'assessments', label: 'Assessments', icon: 'assessments' },
  { key: 'practice', label: 'Practice', icon: 'practice' },
  { key: 'company-prep', label: 'Company Prep', icon: 'company' },
  { key: 'career-tools', label: 'Career Tools', icon: 'tools' },
  { key: 'opportunities', label: 'Opportunities', icon: 'opportunities' },
  { key: 'scholarships', label: 'Scholarships', icon: 'scholarships' },
  { key: 'resume', label: 'Resume Builder', icon: 'resume' },
  { key: 'profile', label: 'Profile', icon: 'profile' },
];

export function StudentPilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  const navigate = useCallback((key: string) => setPage(key), []);
  return <PilotSessionProvider navigate={navigate} initialNotifications={studentNotifications}>
    <PilotShell
      identity={{ name: pilotPersona.name, initials: pilotPersona.initials, subtitle: pilotPersona.programme }}
      nav={STUDENT_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
      notifications={studentNotifications} messages={studentMessages}
      searchExtras={[
        ...pilotPopularCourses.map((course) => ({ label: course.title, detail: `Course · ${course.level}`, navKey: 'learn' })),
        ...pilotCompanies.map((company) => ({ label: company.name, detail: 'Company · prep resources available', navKey: 'company-prep' })),
      ]}
      identityRows={[
        ['Programme', 'B.Tech CSE · Class of 2027'],
        ['Institution', pilotPersona.institution],
        ['Career goal', pilotPersona.careerGoal],
        ['Readiness band', `${pilotCanon.readinessBand} (advisory)`],
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

export interface PilotShellProps {
  readonly identity: { readonly name: string; readonly initials: string; readonly subtitle: string };
  readonly nav: readonly NavEntry[];
  readonly page: string;
  readonly onNavigate: (key: string) => void;
  readonly onSignOut: () => void;
  readonly signOutLabel?: string | undefined;
  readonly email: string;
  readonly notifications: readonly (readonly [string, string])[];
  readonly messages: readonly (readonly [string, string])[];
  readonly searchExtras: readonly SearchEntry[];
  readonly identityRows: readonly (readonly [string, string])[];
  readonly children: React.ReactNode;
}

export function PilotShell({ identity, nav, page, onNavigate, onSignOut, signOutLabel = 'Sign out', email, notifications, messages, searchExtras, identityRows, children }: PilotShellProps): React.ReactElement {
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
          <BrandLogo width={96} />
          <span><small>LEARN | PREPARE | BUILD | GROW</small></span>
        </div>
        {nav.map((item) => {
          const glyph = item.icon;
          return (
            <button key={item.key} type="button" className={`pilot-nav-item one-icon-host ${page === item.key ? 'active' : ''}`}
              aria-current={page === item.key ? 'page' : undefined} onClick={() => onNavigate(item.key)}>
              <Icon name={glyph} size={16} active={page === item.key} animated /> {item.label}
            </button>
          );
        })}
        <div className="pilot-side-note">
          <strong>ONE by AI8HT</strong>
          <p>Demo environment · sample data only · resets when you reload.</p>
        </div>
      </aside>
      <ShellMain config={config} identity={identity} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}>
        {children}
      </ShellMain>
    </PilotOverlayProvider>
  </div>;
}

const INSTITUTION_NAV: readonly NavEntry[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'home' },
  { key: 'students', label: 'Students', icon: 'students' },
  { key: 'drives', label: 'Placement Drives', icon: 'placement' },
  { key: 'assessments', label: 'Assessments', icon: 'assessments' },
  { key: 'interventions', label: 'Interventions', icon: 'interventions' },
  { key: 'reports', label: 'Reports', icon: 'reports' },
];

export function InstitutionPilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  const navigate = useCallback((key: string) => setPage(key), []);
  return <PilotSessionProvider navigate={navigate} initialNotifications={institutionNotifications}>
    <PilotShell
      identity={{ name: pilotInstitutionPersona.name, initials: pilotInstitutionPersona.initials, subtitle: `${pilotInstitutionPersona.role} · Lakeview Institute` }}
      nav={INSTITUTION_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
      notifications={institutionNotifications} messages={institutionMessages}
      searchExtras={pilotRoster.map((student) => ({ label: student.name, detail: `Student · ${student.department} · ${student.band}`, navKey: 'students' }))}
      identityRows={[
        ['Role', pilotInstitutionPersona.role],
        ['Institution', 'Lakeview Institute'],
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
  { key: 'dashboard', label: 'Dashboard', icon: 'home' },
  { key: 'opportunities', label: 'Opportunities', icon: 'opportunities' },
  { key: 'applicants', label: 'Applicants', icon: 'applicants' },
  { key: 'interviews', label: 'Interviews', icon: 'interviews' },
  { key: 'offers', label: 'Offers', icon: 'offers' },
  { key: 'company', label: 'Company Profile', icon: 'company' },
];

export function EmployerPilot({ email, onSignOut, signOutLabel }: PilotPortalProps): React.ReactElement {
  const [page, setPage] = useState('dashboard');
  const navigate = useCallback((key: string) => setPage(key), []);
  return <PilotSessionProvider navigate={navigate} initialNotifications={employerNotifications}>
    <PilotShell
      identity={{ name: pilotEmployerPersona.name, initials: pilotEmployerPersona.initials, subtitle: pilotEmployerPersona.subtitle }}
      nav={EMPLOYER_NAV} page={page} onNavigate={setPage} onSignOut={onSignOut} signOutLabel={signOutLabel} email={email}
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
