import { Bell, BookOpen, BriefcaseBusiness, CalendarDays, ChevronDown, ClipboardCheck, FileText, Gauge, GraduationCap, Home, LayoutDashboard, Menu, MessageSquare, Search, Settings, Sparkles, Target, Trophy, UserRound, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiHealth, type ApiHealth } from './api.js';
import { PageHeader, type PageMeta } from './studentComponents.js';
import { rolePortalFromPath } from './rolePortalConfig.js';
import { DemoPortalLauncher, RolePortal } from './rolePortalPages.js';
import { studentProfile } from './studentData.js';
import { ApplicationsPage, AssessmentsPage, CareerPath, CoachPage, Dashboard, DocumentsPage, ExperiencePage, InterviewsPage, Learning, OpportunitiesPage, ProfilePage, ReadinessPage, SettingsPage, SkillsPage } from './studentPages.js';
import { StudentPreviewProvider, useStudentPreview } from './studentPreviewState.js';
import { PlacementOfficerPortal } from './staffPages.js';

type RouteKey = 'dashboard' | 'career-path' | 'ai-coach' | 'readiness' | 'skills' | 'assessments' | 'learning' | 'experience' | 'opportunities' | 'applications' | 'interviews' | 'documents' | 'profile' | 'settings';

interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly group: 'Plan' | 'Prepare' | 'Apply' | 'Account';
  readonly route: RouteKey;
}

const navItems: readonly NavItem[] = [
  { label: 'Home', path: '/student', icon: Home, group: 'Plan', route: 'dashboard' },
  { label: 'My Career', path: '/student/career-path', icon: Target, group: 'Plan', route: 'career-path' },
  { label: 'AI Career Coach', path: '/student/ai-coach', icon: Sparkles, group: 'Plan', route: 'ai-coach' },
  { label: 'Readiness', path: '/student/readiness', icon: Gauge, group: 'Prepare', route: 'readiness' },
  { label: 'Skills', path: '/student/skills', icon: Sparkles, group: 'Prepare', route: 'skills' },
  { label: 'Assessments', path: '/student/assessments', icon: ClipboardCheck, group: 'Prepare', route: 'assessments' },
  { label: 'Learning', path: '/student/learning', icon: BookOpen, group: 'Prepare', route: 'learning' },
  { label: 'Experience', path: '/student/experience', icon: Trophy, group: 'Prepare', route: 'experience' },
  { label: 'Opportunities', path: '/student/opportunities', icon: BriefcaseBusiness, group: 'Apply', route: 'opportunities' },
  { label: 'Applications', path: '/student/applications', icon: LayoutDashboard, group: 'Apply', route: 'applications' },
  { label: 'Interviews', path: '/student/interviews', icon: CalendarDays, group: 'Apply', route: 'interviews' },
  { label: 'Documents', path: '/student/documents', icon: FileText, group: 'Account', route: 'documents' },
  { label: 'Profile', path: '/student/profile', icon: UserRound, group: 'Account', route: 'profile' },
  { label: 'Settings', path: '/student/settings', icon: Settings, group: 'Account', route: 'settings' },
];

const routeTitles: Record<RouteKey, PageMeta> = {
  dashboard: { title: 'Student Dashboard', eyebrow: 'Home', description: 'A guided summary of your career progress and next steps.' },
  'career-path': { title: 'My Career Path', eyebrow: 'Target career', description: 'Milestones, skill gaps, learning, and experience needed for your goal.' },
  'ai-coach': { title: 'AI Career Coach', eyebrow: 'Preview guidance', description: 'Explainable, non-authoritative recommendations using demo-only Student data.' },
  readiness: { title: 'Readiness', eyebrow: 'Employability model', description: 'Category scores, blockers, history, interventions, and supporting evidence.' },
  skills: { title: 'Skills', eyebrow: 'Skill profile', description: 'Claimed, evidenced, institution-verified, and assessment-verified capabilities.' },
  assessments: { title: 'Assessments', eyebrow: 'Skill checks', description: 'Scheduled, available, completed, and recommended reassessments for your goal.' },
  learning: { title: 'Learning', eyebrow: 'Development plan', description: 'Courses and learning paths tied to your skill gaps.' },
  experience: { title: 'Experience', eyebrow: 'Evidence library', description: 'Projects, labs, internships, achievements, and verification state.' },
  opportunities: { title: 'Opportunities', eyebrow: 'Career marketplace', description: 'Matched roles with eligibility, requirements, deadlines, and explainable fit.' },
  applications: { title: 'Applications', eyebrow: 'Pipeline', description: 'Drafts, active applications, interviews, offers, closed roles, and next actions.' },
  interviews: { title: 'Interviews', eyebrow: 'Preparation', description: 'Upcoming and completed interview rounds, prep checklists, and mock practice.' },
  documents: { title: 'Documents', eyebrow: 'Controlled files', description: 'Resume, certificates, academic files, portfolio evidence, and access context.' },
  profile: { title: 'Profile', eyebrow: 'Student-owned identity', description: 'Academic profile, career objective, consent, visibility, and evidence status.' },
  settings: { title: 'Settings', eyebrow: 'Account and privacy', description: 'Preferences, notifications, privacy, consent, accessibility, and security overview.' },
};

const showDevelopmentIndicators = import.meta.env.DEV;
const enableDemoPortal = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_PORTAL === 'true';

export function App(): React.ReactElement {
  const [path, setPath] = useState(currentPath());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [apiHealth, setApiHealth] = useState<ApiHealth>('checking');
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    getApiHealth(abort.signal).then(setApiHealth);
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const onPop = (): void => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const route = useMemo(() => routeFromPath(path), [path]);
  const rolePortal = useMemo(() => rolePortalFromPath(path), [path]);

  useEffect(() => {
    if (path === '/demo' || path.startsWith('/institution/placement-officer') || rolePortal) return;
    const title = route === 'dashboard' ? 'Student Dashboard' : routeTitles[route].title;
    document.title = route === 'dashboard' ? `${title} | PlanThePath` : `${title} — Student | PlanThePath`;
  }, [path, rolePortal, route]);

  if (path.startsWith('/institution/placement-officer')) {
    return <PlacementOfficerPortal apiHealth={apiHealth} showDevelopmentIndicators={showDevelopmentIndicators} />;
  }

  if (path === '/demo' && enableDemoPortal) {
    return <DemoPortalLauncher onNavigate={(nextPath) => {
      window.history.pushState(null, '', nextPath);
      setPath(currentPath());
    }} />;
  }

  if (rolePortal) {
    return <RolePortal portal={rolePortal} apiHealth={apiHealth} showDevelopmentIndicators={showDevelopmentIndicators} onNavigate={() => setPath(currentPath())} />;
  }

  return (
    <StudentPreviewProvider>
      <StudentShell
        apiHealth={apiHealth}
        drawerOpen={drawerOpen}
        menuButtonRef={menuButtonRef}
        path={path}
        route={route}
        setDrawerOpen={setDrawerOpen}
        setPath={setPath}
        setSidebarCollapsed={setSidebarCollapsed}
        sidebarCollapsed={sidebarCollapsed}
      />
    </StudentPreviewProvider>
  );
}

function StudentShell({ apiHealth, drawerOpen, menuButtonRef, path, route, setDrawerOpen, setPath, setSidebarCollapsed, sidebarCollapsed }: { readonly apiHealth: ApiHealth; readonly drawerOpen: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly path: string; readonly route: RouteKey; readonly setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>; readonly setPath: React.Dispatch<React.SetStateAction<string>>; readonly setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>; readonly sidebarCollapsed: boolean }): React.ReactElement {
  const { dispatch } = useStudentPreview();
  function navigate(item: NavItem): void {
    window.history.pushState(null, '', item.path);
    setPath(item.path);
    setDrawerOpen(false);
  }

  function closeDrawer(): void {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }

  return (
    <div className={`student-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Sidebar path={path} collapsed={sidebarCollapsed} drawerOpen={drawerOpen} onNavigate={navigate} onCollapse={() => setSidebarCollapsed((value) => !value)} onClose={closeDrawer} />
      {drawerOpen ? <button className="drawer-scrim" type="button" aria-label="Close navigation" onClick={closeDrawer} /> : null}
      <div className="student-workspace">
        <TopBar
          apiHealth={apiHealth}
          showDevelopmentIndicators={showDevelopmentIndicators}
          menuButtonRef={menuButtonRef}
          onOpenMenu={() => setDrawerOpen(true)}
          onMessages={() => dispatch({ type: 'status', status: 'Student messages require the secure backend messaging workflow; no message inbox was opened in preview.' })}
          onNotifications={() => dispatch({ type: 'status', status: 'Student notifications preview: 3 reminders are represented by local demo data only.' })}
          onProfile={() => navigate(navItems.find((item) => item.route === 'profile')!)}
          profileActive={route === 'profile'}
        />
        <main id="main-content" className="student-main">
          {showDevelopmentIndicators ? <PreviewBadge apiHealth={apiHealth} /> : null}
          <StudentPreviewStatus />
          <PageHeader meta={routeTitles[route]} />
          <RouteScreen route={route} />
        </main>
      </div>
    </div>
  );
}

function StudentPreviewStatus(): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  return (
    <section className="student-preview-status" role="status" aria-live="polite">
      <div><strong>{state.dirty ? 'Unsaved session changes' : 'Session-local preview'}</strong><span>{state.status}</span></div>
      {state.dirty ? <button type="button" className="secondary" onClick={() => dispatch({ type: 'reset' })}>Reset Student preview</button> : null}
    </section>
  );
}

function Sidebar({ path, collapsed, drawerOpen, onNavigate, onCollapse, onClose }: { readonly path: string; readonly collapsed: boolean; readonly drawerOpen: boolean; readonly onNavigate: (item: NavItem) => void; readonly onCollapse: () => void; readonly onClose: () => void }): React.ReactElement {
  const groups = ['Plan', 'Prepare', 'Apply', 'Account'] as const;
  return (
    <aside className={`student-sidebar ${drawerOpen ? 'drawer-open' : ''}`} aria-label="Student navigation">
      <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true"><GraduationCap size={20} /></span><span className="brand-copy"><strong>PlanThePath</strong><small>Student Portal</small></span><button className="icon-button sidebar-close" type="button" aria-label="Close navigation" onClick={onClose} autoFocus={drawerOpen}><X size={18} /></button></div>
      <nav className="sidebar-nav" aria-label="Grouped Student navigation">
        {groups.map((group) => <div className="nav-group" key={group}><span className="nav-group-label">{group}</span>{navItems.filter((item) => item.group === group).map((item) => { const Icon = item.icon; const active = normalizePath(path) === item.path; return <button key={item.path} type="button" className={`side-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item)}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></button>; })}</div>)}
      </nav>
      <div className="sidebar-footer"><button className="collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? 'Expand' : 'Collapse'}</button></div>
    </aside>
  );
}

function TopBar({ apiHealth, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onMessages, onNotifications, onProfile, profileActive }: { readonly apiHealth: ApiHealth; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onMessages: () => void; readonly onNotifications: () => void; readonly onProfile: () => void; readonly profileActive: boolean }): React.ReactElement {
  return (
    <header className="student-topbar">
      <button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" onClick={onOpenMenu} aria-label="Open student navigation"><Menu size={20} /></button>
      <label className="global-search" role="search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search student workspace</span><input placeholder="Search opportunities, skills, assessments..." /></label>
      <div className="topbar-actions"><button className="icon-button" type="button" aria-label="Messages" onClick={onMessages}><MessageSquare size={18} /></button><button className="icon-button notification" type="button" aria-label="Notifications" onClick={onNotifications}><Bell size={18} /><span>3</span></button>{showDevelopmentIndicators ? <span className={`api-dot ${apiHealth}`}>{apiHealth === 'online' ? 'API Online' : apiHealth === 'offline' ? 'API Offline' : 'Checking'}</span> : null}<button className="profile-menu" type="button" aria-label="Student profile menu" onClick={onProfile} disabled={profileActive}><span className="avatar">{studentProfile.initials}</span><span><strong>{studentProfile.name}</strong><small>{studentProfile.program} | {studentProfile.graduationYear}</small></span><ChevronDown size={15} aria-hidden="true" /></button></div>
    </header>
  );
}

function PreviewBadge({ apiHealth }: { readonly apiHealth: ApiHealth }): React.ReactElement {
  return <div className="preview-badge" aria-label="Preview mode"><span>Demo preview</span><span className={`tiny-state ${apiHealth}`}>{apiHealth}</span></div>;
}

function RouteScreen({ route }: { readonly route: RouteKey }): React.ReactElement {
  if (route === 'dashboard') return <Dashboard />;
  if (route === 'career-path') return <CareerPath />;
  if (route === 'ai-coach') return <CoachPage />;
  if (route === 'readiness') return <ReadinessPage />;
  if (route === 'skills') return <SkillsPage />;
  if (route === 'assessments') return <AssessmentsPage />;
  if (route === 'learning') return <Learning />;
  if (route === 'experience') return <ExperiencePage />;
  if (route === 'opportunities') return <OpportunitiesPage />;
  if (route === 'applications') return <ApplicationsPage />;
  if (route === 'interviews') return <InterviewsPage />;
  if (route === 'documents') return <DocumentsPage />;
  if (route === 'profile') return <ProfilePage />;
  return <SettingsPage />;
}

function currentPath(): string {
  return normalizePath(window.location.pathname);
}

function normalizePath(path: string): string {
  return path.replace(/\/$/, '') || '/student';
}

function routeFromPath(path: string): RouteKey {
  const normalized = normalizePath(path);
  return navItems.find((item) => item.path === normalized)?.route ?? 'dashboard';
}
