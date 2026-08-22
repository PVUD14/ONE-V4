import { Bell, BookOpen, BriefcaseBusiness, Building2, CalendarDays, ChevronDown, ClipboardCheck, FileText, Gauge, GraduationCap, Home, LayoutDashboard, Menu, MessageSquare, Search, Settings, ShieldCheck, Sparkles, Target, Trophy, UserRound, X, type LucideIcon } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { acceptInvitation, getApiHealth, getSecurityContext, type ApiHealth, type SecurityContextDto } from './api.js';
import { beginHostedLogin, completeHostedLoginFromLocation, getAccessToken, getAuthStatus, getAuthDebugStatus, signOut, type AuthStatus } from './auth.js';
import { AuthControls } from './authControls.js';
import { PageHeader, type PageMeta } from './studentComponents.js';
import { rolePortalFromPath } from './rolePortalConfig.js';
import { DemoPortalLauncher, RolePortal } from './rolePortalPages.js';
import { studentProfile } from './studentData.js';
import { ApplicationsPage, AssessmentsPage, CareerPath, CoachPage, Dashboard, DocumentsPage, ExperiencePage, InterviewsPage, Learning, OpportunitiesPage, ProfilePage, ReadinessPage, SettingsPage, SkillsPage } from './studentPages.js';
import { StudentPreviewProvider, useStudentPreview } from './studentPreviewState.js';
import { PlacementOfficerPortal } from './staffPages.js';
import { CareerReadinessApiPanel } from './careerReadinessApiPanel.js';

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

const productName = 'ONE';
const productTagline = 'LEARN | PREPARE | BUILD | GROW';
const showDevelopmentIndicators = import.meta.env.DEV;
const enableDemoPortal = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_PORTAL === 'true';
const protectedPortalRoots = ['/student', '/institution', '/employer', '/operations'] as const;
const portalChoices = [
  { family: 'Student', path: '/student', label: 'Student', detail: 'Learning, readiness, applications and personal growth.', icon: GraduationCap },
  { family: 'Institution', path: '/institution/admin', label: 'Institution', detail: 'Institution administration and student support.', icon: Building2 },
  { family: 'Employer', path: '/employer/recruiter', label: 'Employer', detail: 'Hiring workflows where backend support exists.', icon: BriefcaseBusiness },
  { family: 'Operations', path: '/operations/admin', label: 'Operations', detail: 'Platform administration and governance.', icon: ShieldCheck },
] as const;

type WorkspaceFamily = typeof portalChoices[number]['family'];
type WorkspaceResolution =
  | { readonly state: 'loading' }
  | { readonly state: 'resolved'; readonly choices: readonly typeof portalChoices[number][] }
  | { readonly state: 'error'; readonly message: string };

export function App(): React.ReactElement {
  const [path, setPath] = useState(currentPath());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [apiHealth, setApiHealth] = useState<ApiHealth>('checking');
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() => getAuthStatus());
  const [authNotice, setAuthNotice] = useState(getAuthDebugStatus());
  const [workspaceResolution, setWorkspaceResolution] = useState<WorkspaceResolution>({ state: 'loading' });
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    getApiHealth(abort.signal).then(setApiHealth);
    return () => abort.abort();
  }, []);

  useEffect(() => {
    let mounted = true;
    completeHostedLoginFromLocation()
      .then((completed) => {
        if (!mounted) return;
        setAuthStatus(getAuthStatus());
        if (completed) setAuthNotice('Signed in with the configured non-production identity provider.');
      })
      .catch(() => {
        if (!mounted) return;
        setAuthStatus(getAuthStatus());
        setAuthNotice('Sign-in could not be completed. Try again or verify the non-production Cognito configuration.');
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (authStatus.state !== 'authenticated') {
      setWorkspaceResolution({ state: 'loading' });
      return;
    }
    const token = getAccessToken();
    if (!token) {
      setWorkspaceResolution({ state: 'error', message: 'No protected access token is available for workspace resolution.' });
      return;
    }
    const controller = new AbortController();
    setWorkspaceResolution({ state: 'loading' });
    getSecurityContext(token, controller.signal)
      .then((context) => {
        const choices = resolveWorkspaceChoices(context);
        setWorkspaceResolution({ state: 'resolved', choices });
        if (choices.length === 1 && (currentPath() === '/auth/callback' || currentPath() === '/' || currentPath() === '/login')) {
          window.history.replaceState(null, '', choices[0]!.path);
          setPath(currentPath());
        }
      })
      .catch(() => setWorkspaceResolution({ state: 'error', message: 'ONE could not resolve an active workspace for this identity.' }));
    return () => controller.abort();
  }, [authStatus]);

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

  const demoPath = useMemo(() => demoTargetFromPath(path), [path]);
  const effectivePath = demoPath ?? path;
  const route = useMemo(() => routeFromPath(effectivePath), [effectivePath]);
  const rolePortal = useMemo(() => rolePortalFromPath(effectivePath), [effectivePath]);
  const authenticated = authStatus.state === 'authenticated';

  useEffect(() => {
    if (path === '/' || path === '/login' || path === '/demo' || effectivePath.startsWith('/institution/placement-officer') || rolePortal) return;
    const title = route === 'dashboard' ? 'Student Dashboard' : routeTitles[route].title;
    document.title = route === 'dashboard' ? `${title} | ${productName}` : `${title} - Student | ${productName}`;
  }, [effectivePath, path, rolePortal, route]);

  if (path === '/' || path === '/login') {
    return <LoginEntry authStatus={authStatus} authNotice={authNotice} workspaceResolution={workspaceResolution} onSignIn={handleSignIn} onSignOut={handleSignOut} onNavigate={(nextPath) => {
      window.history.pushState(null, '', nextPath);
      setPath(currentPath());
    }} />;
  }

  if (path === '/auth/callback' && authenticated) {
    return <WorkspaceChooser authStatus={authStatus} authNotice={authNotice} workspaceResolution={workspaceResolution} onSignIn={handleSignIn} onSignOut={handleSignOut} onNavigate={(nextPath) => {
      window.history.pushState(null, '', nextPath);
      setPath(currentPath());
    }} />;
  }

  if (isProtectedPortalPath(path) && !demoPath && !authenticated) {
    return <AuthRequiredPage requestedPath={path} authStatus={authStatus} authNotice={authNotice} onSignIn={handleSignIn} onSignOut={handleSignOut} />;
  }

  if (effectivePath.startsWith('/institution/placement-officer')) {
    return <PlacementOfficerPortal apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} onSignIn={handleSignIn} onSignOut={handleSignOut} showDevelopmentIndicators={showDevelopmentIndicators} />;
  }

  if (path === '/invitations/accept') {
    return <InvitationAcceptancePage authStatus={authStatus} authNotice={authNotice} onSignIn={handleSignIn} onSignOut={handleSignOut} />;
  }

  if ((path === '/demo' || path.startsWith('/demo/')) && enableDemoPortal && !demoPath) {
    return <DemoPortalLauncher onNavigate={(nextPath) => {
      window.history.pushState(null, '', demoRouteFor(nextPath));
      setPath(currentPath());
    }} />;
  }

  if (rolePortal) {
    return <RolePortal portal={rolePortal} apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} onSignIn={handleSignIn} onSignOut={handleSignOut} showDevelopmentIndicators={showDevelopmentIndicators} onNavigate={() => setPath(currentPath())} demoMode={Boolean(demoPath)} />;
  }

  return (
    <StudentPreviewProvider>
      {demoPath ? <DemoBoundaryBanner /> : null}
      <StudentShell
        apiHealth={apiHealth}
        authNotice={authNotice}
        authStatus={authStatus}
        demoMode={Boolean(demoPath)}
        drawerOpen={drawerOpen}
        menuButtonRef={menuButtonRef}
        path={effectivePath}
        route={route}
        setDrawerOpen={setDrawerOpen}
        setPath={setPath}
        setSidebarCollapsed={setSidebarCollapsed}
        sidebarCollapsed={sidebarCollapsed}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
      />
    </StudentPreviewProvider>
  );

  async function handleSignIn(): Promise<void> {
    try {
      await beginHostedLogin(`${window.location.pathname}${window.location.search}`);
    } catch {
      setAuthNotice('Cognito UAT login is not configured. Supply the approved non-production Hosted UI settings.');
    }
  }

  function handleSignOut(): void {
    signOut();
    setAuthStatus(getAuthStatus());
    setAuthNotice(getAuthDebugStatus());
  }
}

function LoginEntry({ authStatus, authNotice, workspaceResolution, onSignIn, onSignOut, onNavigate }: { readonly authStatus: AuthStatus; readonly authNotice: string; readonly workspaceResolution: WorkspaceResolution; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly onNavigate: (path: string) => void }): React.ReactElement {
  useEffect(() => { document.title = `Sign in | ${productName}`; }, []);
  if (authStatus.state === 'authenticated') return <WorkspaceChooser authStatus={authStatus} authNotice={authNotice} workspaceResolution={workspaceResolution} onSignIn={onSignIn} onSignOut={onSignOut} onNavigate={onNavigate} />;
  const signInUnavailable = authStatus.state === 'unconfigured';
  function submitLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!signInUnavailable) onSignIn();
  }
  return <main className="login-shell">
    <section className="login-card" aria-labelledby="one-login-title">
      <p className="auth-eyebrow">ONE PLATFORM</p>
      <h1 id="one-login-title">Sign in</h1>
      <p className="auth-subtitle">Sign in to your verified ONE career-readiness workspace.</p>
      <form className="login-form" onSubmit={submitLogin} noValidate>
        <label htmlFor="one-login-email">Email</label>
        <input id="one-login-email" name="email" type="email" autoComplete="username" inputMode="email" disabled={signInUnavailable} aria-describedby={signInUnavailable ? 'one-auth-unavailable' : undefined} />
        <label htmlFor="one-login-password">Password</label>
        <input id="one-login-password" name="password" type="password" autoComplete="current-password" disabled={signInUnavailable} aria-describedby={signInUnavailable ? 'one-auth-unavailable' : undefined} />
        <button type="submit" disabled={signInUnavailable}>Sign in</button>
      </form>
      {signInUnavailable ? <p id="one-auth-unavailable" className="auth-boundary" role="status">Secure sign-in is not available in this UAT environment yet.</p> : null}
      <p className="auth-footnote">{productTagline}</p>
      {enableDemoPortal ? <button type="button" className="secondary" onClick={() => onNavigate('/demo')}>Open demo previews</button> : null}
    </section>
  </main>;
}

function WorkspaceChooser({ authStatus, authNotice, workspaceResolution, onSignIn, onSignOut, onNavigate }: { readonly authStatus: AuthStatus; readonly authNotice: string; readonly workspaceResolution: WorkspaceResolution; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly onNavigate: (path: string) => void }): React.ReactElement {
  useEffect(() => { document.title = `Choose workspace | ${productName}`; }, []);
  const choices = workspaceResolution.state === 'resolved' ? workspaceResolution.choices : [];
  return <main className="login-shell">
    <section className="login-card workspace-card">
      <span className="eyebrow">{productTagline}</span>
      <h1>Choose your ONE workspace</h1>
      <p>Workspace access is populated only from server-authorized active memberships. This chooser does not grant roles or bypass server authorization.</p>
      <AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />
      {workspaceResolution.state === 'loading' ? <p className="auth-boundary" role="status">Resolving authorized workspaces...</p> : null}
      {workspaceResolution.state === 'error' ? <p className="auth-boundary" role="alert">{workspaceResolution.message}</p> : null}
      {workspaceResolution.state === 'resolved' && choices.length === 0 ? <p className="auth-boundary" role="status">No active ONE workspace is available for this identity.</p> : null}
      {choices.length > 0 ? <div className="workspace-grid">{choices.map((choice) => { const Icon = choice.icon; return <button key={choice.path} type="button" onClick={() => onNavigate(choice.path)}><Icon size={20} /><strong>{choice.label}</strong><span>{choice.detail}</span></button>; })}</div> : null}
    </section>
  </main>;
}

function resolveWorkspaceChoices(context: SecurityContextDto): readonly typeof portalChoices[number][] {
  const families = new Set<WorkspaceFamily>();
  for (const membership of context.memberships) {
    if (['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'].includes(membership.role)) families.add('Institution');
    if (['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(membership.role)) families.add('Employer');
    if (['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'].includes(membership.role)) families.add('Operations');
  }
  if ((context.studentRelationships?.length ?? 0) > 0) families.add('Student');
  return portalChoices.filter((choice) => families.has(choice.family));
}

function AuthRequiredPage({ requestedPath, authStatus, authNotice, onSignIn, onSignOut }: { readonly requestedPath: string; readonly authStatus: AuthStatus; readonly authNotice: string; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  useEffect(() => { document.title = `Sign in required | ${productName}`; }, []);
  const family = requestedPath.split('/')[1] || 'workspace';
  return <main className="login-shell">
    <section className="login-card">
      <span className="eyebrow">{productTagline}</span>
      <h1>Sign in required</h1>
      <p>The {family} portal is protected. ONE does not use role selection, fixture data, or browser-stored demo identities to authenticate a user.</p>
      <AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />
      {authStatus.state === 'unconfigured' ? <p className="auth-boundary">Cognito is not configured, so this route fails closed.</p> : null}
    </section>
  </main>;
}

function DemoBoundaryBanner(): React.ReactElement {
  return <section className="demo-boundary" role="note"><strong>DEMO PREVIEW</strong><span>Fictional data. This route is not authenticated and does not authorize a user.</span></section>;
}

function InvitationAcceptancePage({ authStatus, authNotice, onSignIn, onSignOut }: { readonly authStatus: AuthStatus; readonly authNotice: string; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  const [status, setStatus] = useState('Ready to accept your invitation after sign-in.');
  const [accepted, setAccepted] = useState(false);
  const idempotencyKey = useRef(`web-invite-${crypto.randomUUID()}`);
  const invitationToken = new URLSearchParams(window.location.search).get('token') ?? '';
  useEffect(() => {
    if (authStatus.state !== 'authenticated' || !invitationToken || accepted) return;
    const apiToken = getAccessToken();
    if (!apiToken) return;
    let cancelled = false;
    setStatus('Accepting invitation with your verified identity...');
    acceptInvitation(apiToken, invitationToken, idempotencyKey.current)
      .then(() => {
        if (cancelled) return;
        setAccepted(true);
        setStatus('Invitation accepted. Your organization access is now active.');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('Invitation could not be accepted. Confirm you are signed in as the invited, verified email and that the invitation has not expired or been used.');
      });
    return () => { cancelled = true; };
  }, [accepted, authStatus.state, invitationToken]);

  return <main className="invitation-acceptance">
    <section className="role-page-heading"><div><span className="eyebrow">Verified invitation</span><h1>Accept organization invitation</h1>
      <p>This page uses the existing protected invitation-acceptance API. The raw invitation token is read only from this link and is not stored in browser storage.</p></div>
      <AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} /></section>
    {!invitationToken ? <section className="role-empty"><h2>Invitation token missing</h2><p>Open the exact link delivered to the intended UAT email recipient.</p></section> : null}
    {authStatus.state !== 'authenticated' && invitationToken ? <section className="role-empty"><h2>Sign in required</h2><p>Sign in with the verified email address that received this invitation. If sign-in redirects away, reopen the Mailpit invitation link after the session is established.</p></section> : null}
    <section className="role-card role-wide" role="status"><h2>{accepted ? 'Accepted' : 'Status'}</h2><p>{status}</p></section>
  </main>;
}

function StudentShell({ apiHealth, authNotice, authStatus, demoMode, drawerOpen, menuButtonRef, path, route, setDrawerOpen, setPath, setSidebarCollapsed, sidebarCollapsed, onSignIn, onSignOut }: { readonly apiHealth: ApiHealth; readonly authNotice: string; readonly authStatus: AuthStatus; readonly demoMode: boolean; readonly drawerOpen: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly path: string; readonly route: RouteKey; readonly setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>; readonly setPath: React.Dispatch<React.SetStateAction<string>>; readonly setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>; readonly sidebarCollapsed: boolean; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  const { dispatch } = useStudentPreview();
  function navigate(item: NavItem): void {
    const nextPath = demoMode ? demoRouteFor(item.path) : item.path;
    window.history.pushState(null, '', nextPath);
    setPath(nextPath);
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
          authNotice={authNotice}
          authStatus={authStatus}
          showDevelopmentIndicators={showDevelopmentIndicators}
          menuButtonRef={menuButtonRef}
          onOpenMenu={() => setDrawerOpen(true)}
          onMessages={() => dispatch({ type: 'status', status: 'Student messages require the secure backend messaging workflow; no message inbox was opened in preview.' })}
          onNotifications={() => dispatch({ type: 'status', status: 'Student notifications preview: 3 reminders are represented by local demo data only.' })}
          onProfile={() => navigate(navItems.find((item) => item.route === 'profile')!)}
          profileActive={route === 'profile'}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
        />
        <main id="main-content" className="student-main">
          {showDevelopmentIndicators ? <PreviewBadge apiHealth={apiHealth} /> : null}
          <StudentPreviewStatus authenticated={authStatus.state === 'authenticated'} />
          <PageHeader meta={routeTitles[route]} />
          <RouteScreen route={route} authenticated={authStatus.state === 'authenticated'} />
        </main>
      </div>
    </div>
  );
}

function StudentPreviewStatus({ authenticated }: { readonly authenticated: boolean }): React.ReactElement {
  const { state, dispatch } = useStudentPreview();
  if (authenticated) {
    return <section className="student-preview-status" role="status" aria-live="polite"><div><strong>Authenticated API-backed mode</strong><span>Career Readiness data is loaded from the protected backend. Remaining preview-only modules stay labelled separately.</span></div></section>;
  }
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
      <div className="sidebar-brand"><span className="brand-mark" aria-hidden="true"><GraduationCap size={20} /></span><span className="brand-copy"><strong>ONE</strong><small>LEARN | PREPARE | BUILD | GROW</small></span><button className="icon-button sidebar-close" type="button" aria-label="Close navigation" onClick={onClose} autoFocus={drawerOpen}><X size={18} /></button></div>
      <nav className="sidebar-nav" aria-label="Grouped Student navigation">
        {groups.map((group) => <div className="nav-group" key={group}><span className="nav-group-label">{group}</span>{navItems.filter((item) => item.group === group).map((item) => { const Icon = item.icon; const active = normalizePath(path) === item.path; return <button key={item.path} type="button" className={`side-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item)}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></button>; })}</div>)}
      </nav>
      <div className="sidebar-footer"><button className="collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? 'Expand' : 'Collapse'}</button></div>
    </aside>
  );
}

function TopBar({ apiHealth, authNotice, authStatus, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onMessages, onNotifications, onProfile, profileActive, onSignIn, onSignOut }: { readonly apiHealth: ApiHealth; readonly authNotice: string; readonly authStatus: AuthStatus; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onMessages: () => void; readonly onNotifications: () => void; readonly onProfile: () => void; readonly profileActive: boolean; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  const identity = studentIdentityFromAuth(authStatus);
  return (
    <header className="student-topbar">
      <button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" onClick={onOpenMenu} aria-label="Open student navigation"><Menu size={20} /></button>
      <label className="global-search" role="search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search student workspace</span><input placeholder="Search opportunities, skills, assessments..." /></label>
      <div className="topbar-actions"><button className="icon-button" type="button" aria-label="Messages" onClick={onMessages}><MessageSquare size={18} /></button><button className="icon-button notification" type="button" aria-label="Notifications" onClick={onNotifications}><Bell size={18} /><span>3</span></button><AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />{showDevelopmentIndicators ? <span className={`api-dot ${apiHealth}`}>{apiHealth === 'online' ? 'API Online' : apiHealth === 'offline' ? 'API Offline' : 'Checking'}</span> : null}<button className="profile-menu" type="button" aria-label="Student profile menu" onClick={onProfile} disabled={profileActive}><span className="avatar">{identity.initials}</span><span><strong>{identity.name}</strong><small>{identity.detail}</small></span><ChevronDown size={15} aria-hidden="true" /></button></div>
    </header>
  );
}

function studentIdentityFromAuth(authStatus: AuthStatus): { readonly name: string; readonly initials: string; readonly detail: string } {
  if (authStatus.state !== 'authenticated' || !authStatus.email) {
    return { name: studentProfile.name, initials: studentProfile.initials, detail: `${studentProfile.program} | ${studentProfile.graduationYear}` };
  }
  const local = authStatus.email.split('@')[0] ?? authStatus.email;
  const words = local.split(/[._-]+/).filter(Boolean);
  const name = words.length ? words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(' ') : authStatus.email;
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || 'ST';
  return { name, initials, detail: `Verified email: ${authStatus.email}` };
}

function PreviewBadge({ apiHealth }: { readonly apiHealth: ApiHealth }): React.ReactElement {
  return <div className="preview-badge" aria-label="Preview mode"><span>DEMO PREVIEW</span><span className={`tiny-state ${apiHealth}`}>{apiHealth}</span></div>;
}

function RouteScreen({ route, authenticated }: { readonly route: RouteKey; readonly authenticated: boolean }): React.ReactElement {
  if (route === 'dashboard') return authenticated ? <><CareerReadinessApiPanel route="readiness" /><Dashboard authenticated /></> : <Dashboard />;
  if (route === 'ai-coach') return <CoachPage />;
  if (route === 'career-path') return <><CareerReadinessApiPanel route="roadmap" /><CareerPath /></>;
  if (route === 'readiness') return <><CareerReadinessApiPanel route="readiness" /><ReadinessPage /></>;
  if (route === 'skills') return <><CareerReadinessApiPanel route="skills" /><SkillsPage /></>;
  if (route === 'assessments') return <><CareerReadinessApiPanel route="assessments" /><AssessmentsPage /></>;
  if (route === 'learning') return <><CareerReadinessApiPanel route="learning" /><Learning /></>;
  if (route === 'settings') return <><CareerReadinessApiPanel route="notifications" /><SettingsPage /></>;
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
  return path.replace(/\/$/, '') || '/';
}

function routeFromPath(path: string): RouteKey {
  const normalized = normalizePath(path);
  return navItems.find((item) => item.path === normalized)?.route ?? 'dashboard';
}

function isProtectedPortalPath(path: string): boolean {
  const normalized = normalizePath(path);
  return protectedPortalRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function demoTargetFromPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === '/demo/student') return '/student';
  if (normalized.startsWith('/demo/student/')) return normalized.slice('/demo'.length);
  if (normalized === '/demo/institution') return '/institution/admin';
  if (normalized.startsWith('/demo/institution/')) return normalized.slice('/demo'.length);
  if (normalized === '/demo/employer') return '/employer/recruiter';
  if (normalized.startsWith('/demo/employer/')) return normalized.slice('/demo'.length);
  if (normalized === '/demo/operations') return '/operations/admin';
  if (normalized.startsWith('/demo/operations/')) return normalized.slice('/demo'.length);
  return null;
}

function demoRouteFor(path: string): string {
  if (path === '/student') return '/demo/student';
  if (path.startsWith('/student/')) return `/demo${path}`;
  if (path.startsWith('/institution/')) return `/demo${path}`;
  if (path.startsWith('/employer/')) return `/demo${path}`;
  if (path.startsWith('/operations/')) return `/demo${path}`;
  return path;
}
