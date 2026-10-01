import { Bell, BookOpen, CircleHelp, BriefcaseBusiness, Building2, CalendarDays, ChevronDown, ClipboardCheck, FileText, Gauge, GraduationCap, Home, LayoutDashboard, MapPinned, Menu, MessageSquare, Search, Settings, ShieldCheck, Sparkles, Target, Trophy, UserRound, Wrench, X, type LucideIcon } from 'lucide-react';
import { BrandLogo } from './brand.js';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCEPTED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  acceptInvitation,
  ApiRequestError,
  archiveStudentDocument,
  createStudentDocument,
  downloadDocumentFile,
  uploadDocumentFile,
  getApiHealth,
  getSecurityContext,
  getCurrentStudent,
  getStudentProfile,
  listStudentDocuments,
  listStudentSavedOpportunities,
  removeStudentSavedOpportunity,
  saveStudentOpportunity,
  updateStudentProfile,
  type ApiHealth,
  type CurrentStudentDto,
  type SecurityContextDto,
  type StudentDocumentDto,
  type StudentProfileDto,
  type StudentSavedOpportunityDto,
} from './api.js';
import { beginHostedLogin, completeHostedLoginFromLocation, getAccessToken, getAuthStatus, getAuthDebugStatus, hasStoredAuthSession, restoreAuthenticatedSession, signInWithPassword, signOut, type AuthStatus } from './auth.js';
import { AuthControls } from './authControls.js';
import { PageHeader, type PageMeta } from './studentComponents.js';
import { rolePortalFromPath } from './rolePortalConfig.js';
import { DemoPortalLauncher, RolePortal } from './rolePortalPages.js';
import { studentProfile } from './studentData.js';
import { ApplicationsPage, AssessmentsPage, CareerPath, CoachPage, Dashboard, DocumentsPage, ExperiencePage, InterviewsPage, Learning, OpportunitiesPage, ProfilePage, ReadinessPage, SettingsPage, SkillsPage } from './studentPages.js';
import { StudentPreviewProvider, useStudentPreview } from './studentPreviewState.js';
import { PlacementOfficerPortal } from './staffPages.js';
import { StudentApplicationsPage, StudentOpportunitiesPage } from './hiringPages.js';
import { StudentPrivacyPanel } from './privacyPanel.js';
import { StudentOutcomesCard } from './studentOutcomes.js';
import { PilotApp } from './pilot/PilotApp.js';
import { isPilotIdentity } from './pilot/pilotIdentity.js';
import { CareerReadinessApiPanel } from './careerReadinessApiPanel.js';
import { ExamAttemptPanel } from './examAttemptPanel.js';
import { StudentMessagesFlyout, StudentNotificationsBell } from './notificationsBell.js';
import { AssistantWidget } from './assistantWidget.js';
import { ConsentGate } from './consentGate.js';
import { HelpFaqPanel } from './helpFaqPanel.js';
import { CalendarPage } from './calendarPage.js';
import { PublicProfilePage } from './publicProfilePage.js';
import { PublicEmployerAccessPage } from './publicEmployerAccessPage.js';
import { ShareProfilePanel } from './shareProfilePanel.js';
import { StudentTalentPoolCard } from './talentPool.js';
import { ScreeningAssessmentsPage } from './screeningAssessmentsPage.js';
import { V2EmptyState, V2Stat } from './dashboardsV2.js';
import { StudentDashboardV3 } from './studentDashboardV3.js';
import { StudentGoalsPanel } from './studentGoals.js';
import { StudentLearningPlan } from './studentLearning.js';
import { StudentCareerToolsPage, StudentCompanyPrepPage, StudentPracticePage, StudentResumeBuilderPage, StudentScholarshipsPage } from './pilotParityPages.js';
import { StudentAssessmentsV3, StudentLearningV3, StudentOpportunitiesV3, StudentProfileV3, StudentRoadmapV3 } from './parityWraps.js';

type RouteKey = 'dashboard' | 'career-path' | 'ai-coach' | 'readiness' | 'skills' | 'assessments' | 'learning' | 'experience' | 'opportunities' | 'applications' | 'interviews' | 'documents' | 'profile' | 'settings' | 'help' | 'practice' | 'company-prep' | 'career-tools' | 'scholarships' | 'resume-builder' | 'calendar';

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
  { label: 'Career Tools', path: '/student/career-tools', icon: MapPinned, group: 'Plan', route: 'career-tools' },
  { label: 'Readiness', path: '/student/readiness', icon: Gauge, group: 'Prepare', route: 'readiness' },
  { label: 'Skills', path: '/student/skills', icon: Sparkles, group: 'Prepare', route: 'skills' },
  { label: 'Assessments', path: '/student/assessments', icon: ClipboardCheck, group: 'Prepare', route: 'assessments' },
  { label: 'Learning', path: '/student/learning', icon: BookOpen, group: 'Prepare', route: 'learning' },
  { label: 'Practice', path: '/student/practice', icon: Wrench, group: 'Prepare', route: 'practice' },
  { label: 'Company Prep', path: '/student/company-prep', icon: Building2, group: 'Prepare', route: 'company-prep' },
  { label: 'Experience', path: '/student/experience', icon: Trophy, group: 'Prepare', route: 'experience' },
  { label: 'Opportunities', path: '/student/opportunities', icon: BriefcaseBusiness, group: 'Apply', route: 'opportunities' },
  { label: 'Applications', path: '/student/applications', icon: LayoutDashboard, group: 'Apply', route: 'applications' },
  { label: 'Interviews', path: '/student/interviews', icon: CalendarDays, group: 'Apply', route: 'interviews' },
  { label: 'Calendar', path: '/student/calendar', icon: CalendarDays, group: 'Apply', route: 'calendar' },
  { label: 'Scholarships', path: '/student/scholarships', icon: GraduationCap, group: 'Apply', route: 'scholarships' },
  { label: 'Resume Builder', path: '/student/resume-builder', icon: FileText, group: 'Account', route: 'resume-builder' },
  { label: 'Documents', path: '/student/documents', icon: FileText, group: 'Account', route: 'documents' },
  { label: 'Profile', path: '/student/profile', icon: UserRound, group: 'Account', route: 'profile' },
  { label: 'Settings', path: '/student/settings', icon: Settings, group: 'Account', route: 'settings' },
  { label: 'Help & FAQ', path: '/student/help', icon: CircleHelp, group: 'Account', route: 'help' },
];

const routeTitles: Record<RouteKey, PageMeta> = {
  dashboard: { title: 'Student Dashboard', eyebrow: 'Home', description: 'A guided summary of your career progress and next steps.' },
  practice: { title: 'Practice', eyebrow: 'Prepare', description: 'Sharpen your skills with coding, problems, projects and real-world challenges.' },
  'company-prep': { title: 'Company Preparation', eyebrow: 'Prepare', description: 'Prepare for your dream companies with tailored resources and practice.' },
  'career-tools': { title: 'Career Tools', eyebrow: 'Plan', description: 'Everything you need to plan, build and accelerate your career.' },
  scholarships: { title: 'Scholarships', eyebrow: 'Apply', description: 'Discover and apply for scholarships to support your education journey.' },
  'resume-builder': { title: 'Resume Builder', eyebrow: 'Account', description: 'Create professional resumes that showcase your skills and land your dream job.' },
  calendar: { title: 'Calendar', eyebrow: 'Apply', description: 'Interviews, exam windows, assigned tasks and deadlines already recorded across ONE.' },
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
  help: { title: 'Help & FAQ', eyebrow: 'Guidance', description: 'Answers for students, from the same guide that powers the ONE Assistant.' },
};

const productName = 'ONE by AI8HT';
const productTagline = 'LEARN | PREPARE | BUILD | GROW';
const showDevelopmentIndicators = import.meta.env.DEV;
/**
 * Exported so the predicate itself is testable: the constant below is fixed at
 * build time, which is exactly why the gate must be right per environment.
 */
export function demoPortalEnabled(env: { readonly DEV: boolean; readonly VITE_ENABLE_DEMO_PORTAL?: string } = import.meta.env): boolean {
  return env.DEV || env.VITE_ENABLE_DEMO_PORTAL === 'true';
}
// Written out rather than calling demoPortalEnabled() so the bundler sees a build-time
// literal: with the flag off, every branch guarded by it - and the pilot's fictional
// dataset it would pull in - is dropped from the production bundle, not merely hidden.
// deploy/vps/Dockerfile.web proves this on every image build (scripts/check-demo-boundary.mjs).
const enableDemoPortal = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_PORTAL === 'true';
const protectedPortalRoots = ['/student', '/institution', '/employer', '/operations', '/growth'] as const;
const portalChoices = [
  { family: 'Student', path: '/student', label: 'Student', detail: 'Learning, readiness, applications and personal growth.', icon: GraduationCap },
  { family: 'Institution', path: '/institution/admin', label: 'Institution', detail: 'Institution administration and student support.', icon: Building2 },
  { family: 'Employer', path: '/employer/recruiter', label: 'Employer', detail: 'Hiring workflows where backend support exists.', icon: BriefcaseBusiness },
  { family: 'Operations', path: '/operations/admin', label: 'Operations', detail: 'Platform administration and governance.', icon: ShieldCheck },
  // GROWTH-01 (ADR-040): AI8HT's partnerships field staff. Navigation approved (HG-3, 2026-09-30).
  { family: 'Growth', path: '/growth', label: 'Growth', detail: 'College and employer partnerships: leads, field visits, territory, targets and commission.', icon: MapPinned },
] as const;

type WorkspaceFamily = typeof portalChoices[number]['family'];
interface PortalChoice {
  readonly family: WorkspaceFamily;
  readonly path: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
}
type AuthorizedWorkspace = PortalChoice & {
  readonly role: string;
  readonly organizationId: string | null;
};
type WorkspaceResolution =
  | { readonly state: 'loading' }
  | { readonly state: 'resolved'; readonly choices: readonly AuthorizedWorkspace[] }
  | { readonly state: 'error'; readonly message: string; readonly correlationId?: string; readonly reason: WorkspaceResolutionFailureReason; readonly retryable: boolean };
type WorkspaceResolutionFailureReason =
  | 'TOKEN_REJECTED'
  | 'IDENTITY_NOT_MAPPED'
  | 'NO_ACTIVE_MEMBERSHIP'
  | 'NO_ACTIVE_STUDENT_RELATIONSHIP'
  | 'CONTEXT_REQUEST_FAILED';
type CurrentStudentState =
  | { readonly state: 'idle' | 'loading' }
  | { readonly state: 'resolved'; readonly student: CurrentStudentDto }
  | { readonly state: 'error'; readonly message: string };

export function App(): React.ReactElement {
  const [path, setPath] = useState(currentPath());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [apiHealth, setApiHealth] = useState<ApiHealth>('checking');
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() => (hasStoredAuthSession() && !currentPath().startsWith('/demo') ? { state: 'restoring' } : getAuthStatus()));
  const [authNotice, setAuthNotice] = useState(getAuthDebugStatus());
  const [workspaceResolution, setWorkspaceResolution] = useState<WorkspaceResolution>({ state: 'loading' });
  const [workspaceRetryNonce, setWorkspaceRetryNonce] = useState(0);
  const [currentStudent, setCurrentStudent] = useState<CurrentStudentState>({ state: 'idle' });
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceRequestGeneration = useRef(0);
  const authenticatedEmail = authStatus.state === 'authenticated' ? authStatus.email : null;

  useEffect(() => {
    const abort = new AbortController();
    getApiHealth(abort.signal).then(setApiHealth);
    return () => abort.abort();
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (currentPath().startsWith('/demo')) return;
      const completed = await completeHostedLoginFromLocation();
      const restored = completed ? getAuthStatus() : await restoreAuthenticatedSession();
      if (!mounted) return;
      setAuthStatus(restored);
      if (completed) setAuthNotice('Signed in with the configured non-production identity provider.');
      else if (restored.state === 'authenticated') setAuthNotice('Restored your ONE session.');
    })()
      .catch(() => {
        if (!mounted) return;
        setAuthStatus(getAuthStatus());
        window.history.replaceState(null, '', '/login');
        setPath(currentPath());
        setAuthNotice('Sign-in could not be completed. Try again or verify the non-production Cognito configuration.');
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (authStatus.state !== 'authenticated') {
      workspaceRequestGeneration.current += 1;
      setWorkspaceResolution({ state: 'loading' });
      return;
    }
    const token = getAccessToken();
    if (!token) {
      setWorkspaceResolution({
        state: 'error',
        reason: 'TOKEN_REJECTED',
        retryable: false,
        message: 'We could not load your ONE workspace. Please sign in again.',
      });
      return;
    }
    const workspaceToken = token;
    const generation = ++workspaceRequestGeneration.current;
    const controller = new AbortController();
    let active = true;
    setWorkspaceResolution({ state: 'loading' });
    async function resolveWorkspace(): Promise<void> {
      try {
        const context = await getSecurityContext(workspaceToken, controller.signal);
        if (!active || generation !== workspaceRequestGeneration.current) return;
        const choices = resolveAuthorizedWorkspaces(context);
        setWorkspaceResolution({ state: 'resolved', choices });
        if (choices.length === 1 && (currentPath() === '/auth/callback' || currentPath() === '/' || currentPath() === '/login')) {
          window.history.replaceState(null, '', choices[0]!.path);
          setPath(currentPath());
        }
      } catch (error) {
        if (!active || generation !== workspaceRequestGeneration.current) return;
        if (isAbortError(error)) return;
        setWorkspaceResolution(workspaceResolutionFailureFromError(error));
      }
    }
    void resolveWorkspace();
    return () => {
      active = false;
      controller.abort();
    };
  }, [authenticatedEmail, authStatus.state, workspaceRetryNonce]);

  useEffect(() => {
    if (authStatus.state !== 'authenticated' || !workspaceResolution || !workspaceForPath('/student', workspaceResolution.state === 'resolved' ? workspaceResolution.choices : [])) {
      setCurrentStudent({ state: 'idle' });
      return;
    }
    const token = getAccessToken();
    if (!token) {
      setCurrentStudent({ state: 'error', message: 'No protected access token is available for Student identity.' });
      return;
    }
    const controller = new AbortController();
    setCurrentStudent({ state: 'loading' });
    getCurrentStudent(token, controller.signal)
      .then(({ student }) => setCurrentStudent({ state: 'resolved', student }))
      .catch(() => setCurrentStudent({ state: 'error', message: 'Student identity is not available for this authenticated session.' }));
    return () => controller.abort();
  }, [authStatus, workspaceResolution]);

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
  const activeWorkspace = workspaceResolution.state === 'resolved' ? workspaceForPath(path, workspaceResolution.choices) : null;

  useEffect(() => {
    if (path === '/' || path === '/login' || path === '/demo' || path === '/employer-access' || effectivePath.startsWith('/institution/placement-officer') || rolePortal) return;
    const title = route === 'dashboard' ? 'Student Dashboard' : routeTitles[route].title;
    document.title = route === 'dashboard' ? `${title} | ${productName}` : `${title} - Student | ${productName}`;
  }, [effectivePath, path, rolePortal, route]);

  if (authStatus.state === 'restoring') {
    return <SessionRestorationPage />;
  }

  // Demo identities render the pilot experience and nothing else; every other
  // signed-in user falls through to the real application untouched.
  // Only in a build with the demo flag on (local development, or the demo host): the
  // production build of oneby8.com carries no pilot at all - demos live on demo.oneby8.com.
  if (enableDemoPortal && authenticated && isPilotIdentity(authenticatedEmail)) {
    return <PilotApp email={authenticatedEmail ?? ''} onSignOut={handleSignOut} />;
  }

  // Local preview only: `import.meta.env.DEV` is false in production builds, so this
  // branch is eliminated from the shipped bundle entirely. The sub-path picks the
  // persona the same way a demo identity's address would.
  if (import.meta.env.DEV && path.startsWith('/pilot-preview')) {
    const previewPersona = path.endsWith('/institution') ? 'demo.institution' : path.endsWith('/employer') ? 'demo.employer' : 'demo.student';
    return <PilotApp email={`${previewPersona}@dev.local`} onSignOut={handleSignOut} />;
  }

  // The one route that renders without a session. It must be checked before anything that
  // looks at authStatus, or a signed-out visitor would be sent to the login screen instead
  // of the page they were given a link to.
  if (path.startsWith('/p/')) {
    const shareToken = path.slice(3);
    if (shareToken) return <PublicProfilePage token={shareToken} />;
  }

  // EMP-04: the public employer access request. Like /p/, it renders without a session and
  // creates nothing but a pending request for operations to review.
  if (path === '/employer-access') {
    return <PublicEmployerAccessPage onNavigate={(nextPath) => {
      window.history.pushState(null, '', nextPath);
      setPath(currentPath());
    }} />;
  }

  if (path === '/' || path === '/login') {
    return <LoginEntry authStatus={authStatus} authNotice={authNotice} workspaceResolution={workspaceResolution} onSignIn={handleSignIn} onHostedSignIn={handleHostedSignIn} onSignOut={handleSignOut} onRetryWorkspace={handleRetryWorkspace} onNavigate={(nextPath) => {
      window.history.pushState(null, '', nextPath);
      setPath(currentPath());
    }} />;
  }

  if (path === '/auth/callback' && authenticated) {
    return <WorkspaceChooser authStatus={authStatus} authNotice={authNotice} workspaceResolution={workspaceResolution} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} onRetryWorkspace={handleRetryWorkspace} onNavigate={(nextPath) => {
      window.history.pushState(null, '', nextPath);
      setPath(currentPath());
    }} />;
  }

  if (isProtectedPortalPath(path) && !demoPath && !authenticated) {
    return <AuthRequiredPage requestedPath={path} authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} />;
  }

  if (isProtectedPortalPath(path) && !demoPath && authenticated) {
    if (workspaceResolution.state === 'loading') {
      return <WorkspaceResolutionPage authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} />;
    }
    if (workspaceResolution.state === 'error') {
      return <AccessDeniedPage requestedPath={path} authStatus={authStatus} authNotice={authNotice} message={workspaceResolution.message} retryable={workspaceResolution.retryable} onRetryWorkspace={handleRetryWorkspace} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} />;
    }
    const familyRoot = protectedFamilyRoot(path);
    const firstFamilyWorkspace = familyRoot ? workspaceResolution.choices.find((choice) => choice.family.toLowerCase() === familyRoot) : undefined;
    if (firstFamilyWorkspace && normalizePath(path) === `/${familyRoot}` && firstFamilyWorkspace.path !== normalizePath(path)) {
      window.history.replaceState(null, '', firstFamilyWorkspace.path);
      setPath(currentPath());
      return <WorkspaceResolutionPage authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} />;
    }
    if (!activeWorkspace) {
      return <AccessDeniedPage requestedPath={path} authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} />;
    }
  }

  // The flag previously gated only the /demo launcher, while deep links such as
  // /demo/operations/admin fell through to the portal renderer with demoMode set and
  // no guard at all — fictional portals stayed publicly reachable with the flag off.
  // Every /demo path is refused here, before any demo-aware branch can run.
  if ((path === '/demo' || path.startsWith('/demo/')) && !enableDemoPortal) {
    return <DemoDisabledPage onNavigate={(nextPath) => { window.history.pushState(null, '', nextPath); setPath(currentPath()); }} />;
  }

  if (effectivePath.startsWith('/institution/placement-officer')) {
    // Authenticated placement admins fall through to the real role portal below,
    // which carries the live assessment engine their role is authorized for.
    if (demoPath || !authenticated) {
      return <PlacementOfficerPortal apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} showDevelopmentIndicators={showDevelopmentIndicators} />;
    }
  }

  if (path === '/invitations/accept') {
    return <InvitationAcceptancePage authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} />;
  }

  if ((path === '/demo' || path.startsWith('/demo/')) && enableDemoPortal && !demoPath) {
    return <DemoPortalLauncher onNavigate={(nextPath) => {
      window.history.pushState(null, '', demoRouteFor(nextPath));
      setPath(currentPath());
    }} />;
  }

  if (rolePortal) {
    return <RolePortal portal={rolePortal} apiHealth={apiHealth} authStatus={authStatus} authNotice={authNotice} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} showDevelopmentIndicators={showDevelopmentIndicators} onNavigate={() => setPath(currentPath())} demoMode={Boolean(demoPath)} authenticatedWorkspace={activeWorkspace ? { role: activeWorkspace.role, organizationId: activeWorkspace.organizationId } : undefined} />;
  }

  if (!demoPath && authenticated) {
    return <StudentShell
      apiHealth={apiHealth}
      authNotice={authNotice}
      authStatus={authStatus}
      currentStudent={currentStudent}
      demoMode={false}
      drawerOpen={drawerOpen}
      menuButtonRef={menuButtonRef}
      path={effectivePath}
      route={route}
      setDrawerOpen={setDrawerOpen}
      setPath={setPath}
      setSidebarCollapsed={setSidebarCollapsed}
      sidebarCollapsed={sidebarCollapsed}
      onSignIn={handleHostedSignIn}
      onSignOut={handleSignOut}
      workspace={activeWorkspace ?? undefined}
    />;
  }

  return (
    <StudentPreviewProvider>
      {demoPath ? <DemoBoundaryBanner /> : null}
      <DemoStudentShell apiHealth={apiHealth} authNotice={authNotice} authStatus={authStatus} currentStudent={currentStudent} demoMode={Boolean(demoPath)} drawerOpen={drawerOpen} menuButtonRef={menuButtonRef} path={effectivePath} route={route} setDrawerOpen={setDrawerOpen} setPath={setPath} setSidebarCollapsed={setSidebarCollapsed} sidebarCollapsed={sidebarCollapsed} onSignIn={handleHostedSignIn} onSignOut={handleSignOut} workspace={activeWorkspace ?? undefined} />
    </StudentPreviewProvider>
  );

  async function handleSignIn(email: string, password: string): Promise<void> {
    const result = await signInWithPassword(email, password);
    if (result.state === 'success') {
      setAuthStatus(getAuthStatus());
      setAuthNotice('Signed in to ONE.');
      window.history.replaceState(null, '', '/');
      setPath(currentPath());
      return;
    }
    setAuthStatus(getAuthStatus());
    window.history.replaceState(null, '', '/login');
    setPath(currentPath());
    setAuthNotice(loginNoticeFor(result.state));
  }

  async function handleHostedSignIn(): Promise<void> {
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

  function handleRetryWorkspace(): void {
    if (authStatus.state !== 'authenticated') return;
    setWorkspaceRetryNonce((value) => value + 1);
  }
}

function LoginEntry({ authStatus, authNotice, workspaceResolution, onSignIn, onHostedSignIn, onSignOut, onRetryWorkspace, onNavigate }: { readonly authStatus: AuthStatus; readonly authNotice: string; readonly workspaceResolution: WorkspaceResolution; readonly onSignIn: (email: string, password: string) => void | Promise<void>; readonly onHostedSignIn: () => void; readonly onSignOut: () => void; readonly onRetryWorkspace: () => void; readonly onNavigate: (path: string) => void }): React.ReactElement {
  useEffect(() => { document.title = `Sign in | ${productName}`; }, []);
  if (authStatus.state === 'authenticated') return <WorkspaceChooser authStatus={authStatus} authNotice={authNotice} workspaceResolution={workspaceResolution} onSignIn={onHostedSignIn} onSignOut={onSignOut} onRetryWorkspace={onRetryWorkspace} onNavigate={onNavigate} />;
  const signInUnavailable = authStatus.state === 'unconfigured';
  function submitLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (signInUnavailable) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    void onSignIn(email, password);
  }
  return <main className="login-shell">
    <section className="login-card" aria-labelledby="one-login-title">
      <BrandLogo className="login-logo" height={72} />
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
      {!signInUnavailable && authNotice ? <p className="auth-boundary" role={/failed|incorrect|required|expired|not configured/i.test(authNotice) ? 'alert' : 'status'}>{authNotice}</p> : null}
      <p className="auth-footnote">{productTagline}</p>
      {!signInUnavailable ? <button type="button" className="secondary" onClick={onHostedSignIn}>Use hosted sign-in fallback</button> : null}
      {enableDemoPortal ? <button type="button" className="secondary" onClick={() => onNavigate('/demo')}>Open demo previews</button> : null}
      <p className="auth-footnote">Hiring graduates? <a href="/employer-access" onClick={(event) => { event.preventDefault(); onNavigate('/employer-access'); }}>Request employer access</a></p>
    </section>
  </main>;
}

function loginNoticeFor(state: string): string {
  if (state === 'invalid_credentials') return 'Sign-in failed. Check your email and password.';
  if (state === 'password_reset_required') return 'Password reset is required before this account can sign in.';
  if (state === 'new_password_required') return 'A new password is required before this UAT account can continue.';
  if (state === 'mfa_required') return 'MFA is required for this account and is not completed in this UAT form yet.';
  if (state === 'session_expired') return 'The Cognito session expired. Please sign in again.';
  if (state === 'unconfigured') return 'Cognito UAT password sign-in is not configured.';
  return 'Sign-in could not be completed. Try again or verify the non-production Cognito configuration.';
}

function SessionRestorationPage(): React.ReactElement {
  useEffect(() => { document.title = `Restoring session | ${productName}`; }, []);
  return <main className="login-shell"><section className="login-card"><span className="eyebrow">{productTagline}</span><h1>Restoring your ONE session...</h1><p>ONE is checking your session-scoped Cognito tokens before opening a workspace.</p></section></main>;
}

function WorkspaceChooser({ authStatus, authNotice, workspaceResolution, onSignIn, onSignOut, onRetryWorkspace, onNavigate }: { readonly authStatus: AuthStatus; readonly authNotice: string; readonly workspaceResolution: WorkspaceResolution; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly onRetryWorkspace: () => void; readonly onNavigate: (path: string) => void }): React.ReactElement {
  useEffect(() => { document.title = `Choose workspace | ${productName}`; }, []);
  const choices = workspaceResolution.state === 'resolved' ? workspaceResolution.choices : [];
  return <main className="login-shell">
    <section className="login-card workspace-card">
      <BrandLogo className="login-logo" height={72} />
      <span className="eyebrow">{productTagline}</span>
      <h1>Choose your ONE workspace</h1>
      <p>Workspace access is populated only from server-authorized active memberships. This chooser does not grant roles or bypass server authorization.</p>
      <AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />
      {workspaceResolution.state === 'loading' ? <p className="auth-boundary" role="status">Resolving authorized workspaces...</p> : null}
      {workspaceResolution.state === 'error' ? <p className="auth-boundary" role="alert">{workspaceResolution.message}</p> : null}
      {workspaceResolution.state === 'error' && workspaceResolution.retryable ? <button type="button" onClick={onRetryWorkspace}>Retry workspace</button> : null}
      {workspaceResolution.state === 'resolved' && choices.length === 0 ? <p className="auth-boundary" role="status">No active ONE workspace is available for this identity.</p> : null}
      {choices.length > 0 ? <div className="workspace-grid">{choices.map((choice) => { const Icon = choice.icon; return <button key={choice.path} type="button" onClick={() => onNavigate(choice.path)}><Icon size={20} /><strong>{choice.label}</strong><span>{choice.detail}</span></button>; })}</div> : null}
    </section>
  </main>;
}

function resolveAuthorizedWorkspaces(context: SecurityContextDto): readonly AuthorizedWorkspace[] {
  const workspaces: AuthorizedWorkspace[] = [];
  const pushUnique = (workspace: AuthorizedWorkspace): void => {
    if (workspace.family === 'Growth') {
      // One Growth entry: a person who is both a manager and an executive works as the manager.
      const existing = workspaces.findIndex((item) => item.family === 'Growth');
      if (existing >= 0) {
        if (workspace.role === 'GROWTH_MANAGER') workspaces[existing] = workspace;
        return;
      }
    }
    if (workspace.family === 'Employer') {
      // One employer entry per organisation, as on Android: a person who is both owner and
      // recruiter of the same employer opens one portal, labelled with the broader role.
      const existing = workspaces.findIndex((item) => item.family === 'Employer' && item.organizationId === workspace.organizationId);
      if (existing >= 0) {
        if (employerRoleRank(workspace.role) < employerRoleRank(workspaces[existing]!.role)) workspaces[existing] = workspace;
        return;
      }
    }
    if (!workspaces.some((item) => item.path === workspace.path && item.role === workspace.role && item.organizationId === workspace.organizationId)) workspaces.push(workspace);
  };
  if ((context.studentRelationships?.length ?? 0) > 0) {
    pushUnique({ ...portalChoices[0], role: 'STUDENT', organizationId: context.studentRelationships?.[0]?.institutionId ?? null });
  } else if ((context.formerStudentRelationships?.length ?? 0) > 0) {
    // INST-10: someone who graduated, transferred or left keeps their student workspace for their
    // own data. No college is attached to it: they have left, and nothing may scope by it.
    pushUnique({ ...portalChoices[0], role: 'STUDENT', organizationId: null });
  }
  for (const membership of context.memberships) {
    const workspace = workspaceForMembership(membership);
    if (workspace) pushUnique(workspace);
  }
  return workspaces;
}

function workspaceResolutionFailureFromError(error: unknown): Extract<WorkspaceResolution, { readonly state: 'error' }> {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return workspaceError('TOKEN_REJECTED', error.correlationId, false);
    if (error.status === 403) return workspaceError('IDENTITY_NOT_MAPPED', error.correlationId, false);
    return workspaceError('CONTEXT_REQUEST_FAILED', error.correlationId, error.status >= 500);
  }
  return workspaceError('CONTEXT_REQUEST_FAILED', undefined, true);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function workspaceError(reason: WorkspaceResolutionFailureReason, correlationId?: string, retryable = false): Extract<WorkspaceResolution, { readonly state: 'error' }> {
  return {
    state: 'error',
    reason,
    retryable,
    ...(correlationId ? { correlationId } : {}),
    message: `We could not load your ONE workspace.${correlationId ? ` Reference: ${correlationId}` : ''}`,
  };
}

const employerRoleOrder = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'] as const;
function employerRoleRank(role: string): number {
  const rank = employerRoleOrder.indexOf(role as typeof employerRoleOrder[number]);
  return rank < 0 ? employerRoleOrder.length : rank;
}

function workspaceForMembership(membership: SecurityContextDto['memberships'][number]): AuthorizedWorkspace | null {
  const organizationId = membership.organizationId;
  if (membership.role === 'INSTITUTION_OWNER' || membership.role === 'INSTITUTION_ADMIN') return { ...portalChoices[1], role: membership.role, organizationId };
  if (membership.role === 'PLACEMENT_ADMIN') return { ...portalChoices[1], path: '/institution/placement-officer', label: 'Placement Admin', detail: 'Placement operations for the authorized institution.', role: membership.role, organizationId };
  if (membership.role === 'FACULTY_LECTURER') return { ...portalChoices[1], path: '/institution/faculty', label: 'Faculty', detail: 'Faculty workspace for assigned academic support.', role: membership.role, organizationId };
  if (membership.role === 'DEPARTMENT_HEAD') return { ...portalChoices[1], path: '/institution/department-head', label: 'Department Head', detail: 'Department workspace for authorized academic oversight.', role: membership.role, organizationId };
  // Owners and admins run the same employer portal as recruiters; the server decides what each
  // role may do, and owner/admin-only screens check the role for display only (EMP-01).
  if (membership.role === 'EMPLOYER_OWNER') return { ...portalChoices[2], label: 'Employer Owner', detail: 'Employer workspace: hiring, team and company settings.', role: membership.role, organizationId };
  if (membership.role === 'EMPLOYER_ADMIN') return { ...portalChoices[2], label: 'Employer Admin', detail: 'Employer workspace: hiring, recruiters and reports.', role: membership.role, organizationId };
  if (membership.role === 'RECRUITER') return { ...portalChoices[2], role: membership.role, organizationId };
  if (membership.role === 'OPERATIONS_ADMIN') return { ...portalChoices[3], role: membership.role, organizationId };
  if (membership.role === 'PLATFORM_SUPER_ADMIN') return { ...portalChoices[3], label: 'Platform Super Admin', detail: 'Platform operations workspace; distinct super-admin UI is not yet implemented.', role: membership.role, organizationId };
  if (membership.role === 'SECURITY_ADMIN') return { ...portalChoices[3], label: 'Security Admin', detail: 'Operations workspace available; dedicated security-admin surface is not yet implemented.', role: membership.role, organizationId };
  // GROWTH-01: growth roles open the Growth portal only. They hold no internal capability, so
  // no Operations workspace is offered to them.
  if (membership.role === 'GROWTH_EXECUTIVE') return { ...portalChoices[4], label: 'Growth Executive', role: membership.role, organizationId };
  if (membership.role === 'GROWTH_MANAGER') return { ...portalChoices[4], label: 'Growth Manager', role: membership.role, organizationId };
  return null;
}

function workspaceForPath(path: string, workspaces: readonly AuthorizedWorkspace[]): AuthorizedWorkspace | null {
  const normalized = normalizePath(path);
  return workspaces.find((workspace) => normalized === workspace.path || normalized.startsWith(`${workspace.path}/`)) ?? null;
}

function protectedFamilyRoot(path: string): string | null {
  const root = normalizePath(path).split('/')[1] ?? '';
  return protectedPortalRoots.some((portalRoot) => portalRoot === `/${root}`) ? root : null;
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

function WorkspaceResolutionPage({ authStatus, authNotice, onSignIn, onSignOut }: { readonly authStatus: AuthStatus; readonly authNotice: string; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  useEffect(() => { document.title = `Resolving workspace | ${productName}`; }, []);
  return <main className="login-shell">
    <section className="login-card">
      <span className="eyebrow">{productTagline}</span>
      <h1>Resolving workspace</h1>
      <p>ONE is verifying this route against your server-authorized memberships before opening a portal.</p>
      <AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />
    </section>
  </main>;
}

function AccessDeniedPage({ requestedPath, authStatus, authNotice, message, retryable = false, onRetryWorkspace, onSignIn, onSignOut }: { readonly requestedPath: string; readonly authStatus: AuthStatus; readonly authNotice: string; readonly message?: string; readonly retryable?: boolean; readonly onRetryWorkspace?: () => void; readonly onSignIn: () => void; readonly onSignOut: () => void }): React.ReactElement {
  useEffect(() => { document.title = `Workspace unavailable | ${productName}`; }, []);
  return <main className="login-shell">
    <section className="login-card">
      <span className="eyebrow">{productTagline}</span>
      <h1>You do not have access to this workspace</h1>
      <p>{message ?? `Your verified identity is not authorized for ${requestedPath}. ONE did not mount the requested portal UI.`}</p>
      {retryable && onRetryWorkspace ? <button type="button" onClick={onRetryWorkspace}>Retry workspace</button> : null}
      <AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />
    </section>
  </main>;
}

function DemoDisabledPage({ onNavigate }: { readonly onNavigate: (path: string) => void }): React.ReactElement {
  useEffect(() => { document.title = `Sign in | ${productName}`; }, []);
  return <main className="login-shell">
    <section className="login-card">
      <span className="eyebrow">ONE platform</span>
      <h1>Demo previews are switched off</h1>
      <p>This environment shows real accounts only. Sign in to use your workspace.</p>
      <button type="button" onClick={() => onNavigate('/login')}>Go to sign in</button>
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

function DemoStudentShell(props: Parameters<typeof StudentShell>[0]): React.ReactElement {
  const { dispatch } = useStudentPreview();
  return <StudentShell
    {...props}
    onMessages={() => dispatch({ type: 'status', status: 'Student messages require the secure backend messaging workflow; no message inbox was opened in preview.' })}
    onNotifications={() => dispatch({ type: 'status', status: 'Student notifications preview: 3 reminders are represented by local demo data only.' })}
  />;
}

function StudentShell({ apiHealth, authNotice, authStatus, currentStudent, demoMode, drawerOpen, menuButtonRef, path, route, setDrawerOpen, setPath, setSidebarCollapsed, sidebarCollapsed, onSignIn, onSignOut, workspace, onMessages, onNotifications }: { readonly apiHealth: ApiHealth; readonly authNotice: string; readonly authStatus: AuthStatus; readonly currentStudent: CurrentStudentState; readonly demoMode: boolean; readonly drawerOpen: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly path: string; readonly route: RouteKey; readonly setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>; readonly setPath: React.Dispatch<React.SetStateAction<string>>; readonly setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>; readonly sidebarCollapsed: boolean; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly workspace?: AuthorizedWorkspace | undefined; readonly onMessages?: () => void; readonly onNotifications?: () => void }): React.ReactElement {
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
    <ConsentGate>
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
          onMessages={onMessages ?? (() => undefined)}
          onNotifications={onNotifications ?? (() => undefined)}
          onProfile={() => navigate(navItems.find((item) => item.route === 'profile')!)}
          profileActive={route === 'profile'}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          workspace={workspace}
          currentStudent={currentStudent}
        />
        <main id="main-content" className="student-main">
          {demoMode && showDevelopmentIndicators ? <PreviewBadge apiHealth={apiHealth} /> : null}
          {demoMode ? <StudentPreviewStatus authenticated={false} /> : <AuthenticatedStudentStatus currentStudent={currentStudent} />}
          {/* Pilot-exact pages carry their own pilot page head. */}
          {['dashboard', 'practice', 'company-prep', 'career-tools', 'scholarships', 'resume-builder', 'career-path', 'learning', 'assessments', 'opportunities', 'profile'].includes(route) && authStatus.state === 'authenticated' ? null : <PageHeader meta={routeTitles[route]} />}
          <RouteScreen route={route} authenticated={authStatus.state === 'authenticated'} currentStudent={currentStudent} />
        </main>
      </div>
      <AssistantWidget persona="student" />
    </div>
    </ConsentGate>
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
      <div className="sidebar-brand"><BrandLogo height={collapsed ? 34 : 46} compact={collapsed} /><span className="brand-copy"><small>LEARN | PREPARE | BUILD | GROW</small></span><button className="icon-button sidebar-close" type="button" aria-label="Close navigation" onClick={onClose} autoFocus={drawerOpen}><X size={18} /></button></div>
      <nav className="sidebar-nav" aria-label="Grouped Student navigation">
        {groups.map((group) => <div className="nav-group" key={group}><span className="nav-group-label">{group}</span>{navItems.filter((item) => item.group === group).map((item) => { const Icon = item.icon; const active = normalizePath(path) === item.path; return <button key={item.path} type="button" className={`side-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onNavigate(item)}><Icon size={18} aria-hidden="true" /><span>{item.label}</span></button>; })}</div>)}
      </nav>
      <div className="sidebar-footer"><button className="collapse-button" type="button" onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? 'Expand' : 'Collapse'}</button></div>
    </aside>
  );
}

function TopBar({ apiHealth, authNotice, authStatus, showDevelopmentIndicators, menuButtonRef, onOpenMenu, onMessages, onNotifications, onProfile, profileActive, onSignIn, onSignOut, workspace, currentStudent }: { readonly apiHealth: ApiHealth; readonly authNotice: string; readonly authStatus: AuthStatus; readonly showDevelopmentIndicators: boolean; readonly menuButtonRef: React.RefObject<HTMLButtonElement | null>; readonly onOpenMenu: () => void; readonly onMessages: () => void; readonly onNotifications: () => void; readonly onProfile: () => void; readonly profileActive: boolean; readonly onSignIn: () => void; readonly onSignOut: () => void; readonly workspace?: AuthorizedWorkspace | undefined; readonly currentStudent: CurrentStudentState }): React.ReactElement {
  const identity = studentIdentityFromAuth(authStatus, currentStudent);
  return (
    <header className="student-topbar">
      <button ref={menuButtonRef} className="icon-button mobile-menu-button" type="button" onClick={onOpenMenu} aria-label="Open student navigation"><Menu size={20} /></button>
      <label className="global-search" role="search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search student workspace</span><input placeholder="Search opportunities, skills, assessments..." /></label>
      <div className="topbar-actions"><StudentMessagesFlyout /><StudentNotificationsBell /><AuthControls authStatus={authStatus} notice={authNotice} onSignIn={onSignIn} onSignOut={onSignOut} />{showDevelopmentIndicators ? <span className={`api-dot ${apiHealth}`}>{apiHealth === 'online' ? 'API Online' : apiHealth === 'offline' ? 'API Offline' : 'Checking'}</span> : null}<button className="profile-menu" type="button" aria-label="Student profile menu" onClick={onProfile} disabled={profileActive}><span className="avatar">{identity.initials}</span><span><strong>{identity.name}</strong><small>{workspace ? `Role: ${workspace.role}` : identity.detail}</small></span><ChevronDown size={15} aria-hidden="true" /></button></div>
    </header>
  );
}

function AuthenticatedStudentStatus({ currentStudent }: { readonly currentStudent: CurrentStudentState }): React.ReactElement {
  if (currentStudent.state === 'loading' || currentStudent.state === 'idle') {
    return <section className="student-preview-status" role="status" aria-live="polite"><div><strong>Loading real Student identity</strong><span>ONE is loading your protected Student profile from the API.</span></div></section>;
  }
  if (currentStudent.state === 'error') {
    return <section className="student-preview-status" role="alert"><div><strong>Student identity unavailable</strong><span>{currentStudent.message}</span></div></section>;
  }
  if (currentStudent.state !== 'resolved') {
    return <section className="student-preview-status" role="status" aria-live="polite"><div><strong>Loading real Student identity</strong><span>ONE is loading your protected Student profile from the API.</span></div></section>;
  }
  // INST-10: a former student is told plainly where they stand and what they keep.
  if (currentStudent.student.formerStudent) return <FormerStudentNotice student={currentStudent.student} />;
  // Resolved: render nothing. The top bar already shows the user's name and
  // role; repeating email and account state here read as debug output (UAT #18).
  return <></>;
}

const formerStudentWords: Readonly<Record<string, string>> = { GRADUATED: 'Graduated from', TRANSFERRED: 'Transferred from', ENDED: 'Left' };

/** What an alumnus sees above their workspace: where they stand, and what they keep (INST-10). */
export function FormerStudentNotice({ student }: { readonly student: CurrentStudentDto }): React.ReactElement {
  const college = student.institutionName ?? 'your college';
  const state = student.relationship?.state ?? student.academicStatus;
  const when = student.relationship?.effectiveTo
    ? new Date(student.relationship.effectiveTo).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  return <section className="student-preview-status" role="status" aria-live="polite"><div>
    <strong>{formerStudentWords[state] ?? 'Left'} {college}{when ? ` on ${when}` : ''}</strong>
    <span>Your ONE account, your records and your choices stay yours. {college} now sees only what happened before that date. You can still ask it to verify past results from Academic record.</span>
  </div></section>;
}

function studentIdentityFromAuth(authStatus: AuthStatus, currentStudent: CurrentStudentState): { readonly name: string; readonly initials: string; readonly detail: string } {
  if (authStatus.state === 'authenticated' && currentStudent.state === 'resolved') {
    return { name: currentStudent.student.fullName, initials: initialsForName(currentStudent.student.fullName), detail: `Verified email: ${currentStudent.student.verifiedEmail ?? authStatus.email ?? 'unavailable'}` };
  }
  if (authStatus.state !== 'authenticated' || !authStatus.email) {
    return { name: studentProfile.name, initials: studentProfile.initials, detail: `${studentProfile.program} | ${studentProfile.graduationYear}` };
  }
  const local = authStatus.email.split('@')[0] ?? authStatus.email;
  const words = local.split(/[._-]+/).filter(Boolean);
  const name = words.length ? words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(' ') : authStatus.email;
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || 'ST';
  return { name, initials, detail: `Verified email: ${authStatus.email}` };
}

function initialsForName(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || 'ST';
}

function PreviewBadge({ apiHealth }: { readonly apiHealth: ApiHealth }): React.ReactElement {
  return <div className="preview-badge" aria-label="Preview mode"><span>DEMO PREVIEW</span><span className={`tiny-state ${apiHealth}`}>{apiHealth}</span></div>;
}

function RouteScreen({ route, authenticated, currentStudent }: { readonly route: RouteKey; readonly authenticated: boolean; readonly currentStudent: CurrentStudentState }): React.ReactElement {
  if (authenticated) return <AuthenticatedStudentRoute route={route} currentStudent={currentStudent} />;
  if (route === 'dashboard') return <Dashboard />;
  if (route === 'ai-coach') return <CoachPage />;
  if (route === 'career-path') return <><CareerReadinessApiPanel route="roadmap" /><CareerPath /></>;
  if (route === 'readiness') return <><CareerReadinessApiPanel route="readiness" /><ReadinessPage /></>;
  if (route === 'skills') return <><CareerReadinessApiPanel route="skills" /><SkillsPage /></>;
  if (route === 'assessments') return <><ExamAttemptPanel /><CareerReadinessApiPanel route="assessments" /><AssessmentsPage /></>;
  if (route === 'learning') return <><CareerReadinessApiPanel route="learning" /><Learning /></>;
  if (route === 'settings') return <><CareerReadinessApiPanel route="notifications" /><SettingsPage /></>;
  if (route === 'help') return <HelpFaqPanel persona="student" />;
  if (route === 'experience') return <ExperiencePage />;
  if (route === 'opportunities') return <OpportunitiesPage />;
  if (route === 'applications') return <ApplicationsPage />;
  if (route === 'interviews') return <InterviewsPage />;
  if (route === 'documents') return <DocumentsPage />;
  if (route === 'profile') return <ProfilePage />;
  if (route === 'practice') return <StudentPracticePage />;
  if (route === 'company-prep') return <StudentCompanyPrepPage />;
  if (route === 'career-tools') return <StudentCareerToolsPage />;
  if (route === 'scholarships') return <StudentScholarshipsPage />;
  if (route === 'resume-builder') return <StudentResumeBuilderPage />;
  if (route === 'calendar') return <CalendarPage />;
  return <SettingsPage />;
}

function AuthenticatedStudentRoute({ route, currentStudent }: { readonly route: RouteKey; readonly currentStudent: CurrentStudentState }): React.ReactElement {
  if (route === 'dashboard') return <AuthenticatedStudentDashboard currentStudent={currentStudent} />;
  if (route === 'profile') return <StudentProfileV3><AuthenticatedStudentProfile /><ShareProfilePanel /><StudentTalentPoolCard /><StudentOutcomesCard /></StudentProfileV3>;
  if (route === 'documents') return <AuthenticatedStudentDocuments />;
  if (route === 'opportunities') return <StudentOpportunitiesV3><StudentOpportunitiesPage /><AuthenticatedStudentSavedOpportunities /></StudentOpportunitiesV3>;
  if (route === 'applications') return <StudentApplicationsPage />;
  if (route === 'career-path') return <StudentRoadmapV3><StudentGoalsPanel /><CareerReadinessApiPanel route="roadmap" /></StudentRoadmapV3>;
  if (route === 'readiness') return <CareerReadinessApiPanel route="readiness" />;
  if (route === 'skills') return <CareerReadinessApiPanel route="skills" />;
  if (route === 'assessments') return <StudentAssessmentsV3><ExamAttemptPanel /><ScreeningAssessmentsPage /><CareerReadinessApiPanel route="assessments" /></StudentAssessmentsV3>;
  if (route === 'learning') return <StudentLearningV3><StudentLearningPlan /><CareerReadinessApiPanel route="learning" /></StudentLearningV3>;
  if (route === 'settings') return <><CareerReadinessApiPanel route="notifications" /><StudentPrivacyPanel /></>;
  if (route === 'help') return <HelpFaqPanel persona="student" />;
  if (route === 'practice') return <StudentPracticePage />;
  if (route === 'company-prep') return <StudentCompanyPrepPage />;
  if (route === 'career-tools') return <StudentCareerToolsPage />;
  if (route === 'scholarships') return <StudentScholarshipsPage />;
  if (route === 'resume-builder') return <StudentResumeBuilderPage />;
  return <AuthenticatedStudentUnavailable route={route} />;
}

function AuthenticatedStudentDashboard({ currentStudent }: { readonly currentStudent: CurrentStudentState }): React.ReactElement {
  if (currentStudent.state !== 'resolved') {
    return <section className="card wide-card"><h2>Student profile</h2><p>{currentStudent.state === 'error' ? currentStudent.message : 'Loading protected Student profile...'}</p></section>;
  }
  return <StudentDashboardV3 studentName={currentStudent.student.fullName} />;
}

function AuthenticatedStudentProfile(): React.ReactElement {
  const [profile, setProfile] = useState<StudentProfileDto | null>(null);
  const [status, setStatus] = useState('Loading protected Student profile...');
  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      setStatus('No protected access token is available.');
      return undefined;
    }
    const controller = new AbortController();
    getStudentProfile(token, controller.signal).then(({ profile: next }) => {
      setProfile(next);
      setStatus('Profile loaded.');
    }).catch(() => setStatus('Profile could not be loaded.'));
    return () => controller.abort();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return setStatus('No protected access token is available.');
    const form = new FormData(event.currentTarget);
    const body = {
      targetCareer: String(form.get('targetCareer') ?? '').trim(),
      profileHeadline: String(form.get('profileHeadline') ?? '').trim(),
      profileSummary: String(form.get('profileSummary') ?? '').trim(),
      portfolioUrl: String(form.get('portfolioUrl') ?? '').trim(),
      visibilityState: String(form.get('visibilityState') ?? 'PRIVATE'),
      // EMP-14: being found by employers is joined and left only through the Talent pool card below,
      // which also records the consent; this form keeps whatever that set.
      employerDiscoveryEnabled: profile?.employerDiscoveryEnabled ?? false,
      careerInterests: String(form.get('careerInterests') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    };
    try {
      const response = await updateStudentProfile(token, body);
      setProfile(response.profile);
      setStatus('Profile saved.');
    } catch {
      setStatus('Profile save failed. Check field validation and try again.');
    }
  }
  return <div className="workspace-grid">
    <section className="card wide-card"><span className="eyebrow">Your profile</span><h2>Your career profile</h2><p>Only you can edit this. Your college and employers never see anything here that you have not chosen to share.</p><p role="status">{status}</p></section>
    <form className="card wide-card student-form" onSubmit={(event) => { void submit(event); }}>
      <label className="student-form-field"><span>Target career</span><input name="targetCareer" defaultValue={profile?.targetCareer ?? ''} maxLength={120} /></label>
      <label className="student-form-field"><span>Headline</span><input name="profileHeadline" defaultValue={profile?.profileHeadline ?? ''} maxLength={160} /></label>
      <label className="student-form-field"><span>Career interests, comma separated</span><input name="careerInterests" defaultValue={(profile?.careerInterests ?? []).join(', ')} /></label>
      <label className="student-form-field"><span>Portfolio URL</span><input name="portfolioUrl" defaultValue={profile?.portfolioUrl ?? ''} placeholder="https://..." /></label>
      <label className="student-form-field"><span>Summary</span><textarea name="profileSummary" defaultValue={profile?.profileSummary ?? ''} maxLength={2000} /></label>
      <label className="student-form-field"><span>Visibility</span><select key={profile?.visibilityState ?? 'PRIVATE'} name="visibilityState" defaultValue={profile?.visibilityState ?? 'PRIVATE'}><option>PRIVATE</option><option>INSTITUTION_VISIBLE</option>{profile?.visibilityState === 'EMPLOYER_DISCOVERY' ? <option>EMPLOYER_DISCOVERY</option> : null}</select></label>
      <button type="submit">Save profile</button>
    </form>
  </div>;
}

function AuthenticatedStudentDocuments(): React.ReactElement {
  const [documents, setDocuments] = useState<readonly StudentDocumentDto[]>([]);
  const [status, setStatus] = useState('Loading document metadata...');
  // `message` wins over the storage summary, so a confirmation survives the refresh
  // that follows it instead of being overwritten a moment later.
  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listStudentDocuments(token);
    setDocuments(response.documents);
    setStatus(message ?? response.storage.message);
  };
  useEffect(() => { void reload().catch(() => setStatus('Document metadata could not be loaded.')); }, []);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return setStatus('No protected access token is available.');
    const form = new FormData(event.currentTarget);
    try {
      await createStudentDocument(token, {
        title: String(form.get('title') ?? ''),
        documentType: String(form.get('documentType') ?? 'OTHER'),
        description: String(form.get('description') ?? ''),
      });
      event.currentTarget.reset();
      await reload();
      setStatus('Document metadata saved. File storage will be enabled in a later secure-storage phase.');
    } catch {
      setStatus('Document metadata save failed.');
    }
  }
  const verifiedCount = documents.filter((doc) => /verified/i.test(doc.verificationState ?? '')).length;
  const withFileCount = documents.filter((doc) => doc.file).length;
  return <div className="workspace-grid">
    <section className="card wide-card"><span className="eyebrow">Your documents</span><h2>Documents</h2><p role="status">{status}</p>
      <p>Add a document, then attach the file. Every file is checked for malware before it is stored, so it may take a moment to appear.</p></section>
    <div className="v2-row v2-cols-4 career-stat-strip wide-card">
      <V2Stat icon="📄" tone="blue" value={documents.length} label="Documents" />
      <V2Stat icon="📎" tone="purple" value={withFileCount} label="With files attached" />
      <V2Stat icon="✅" tone="green" value={verifiedCount} label="Verified" />
      <V2Stat icon="🛡️" tone="amber" value="Scanned" label="Malware-checked storage" />
    </div>
    <form className="card student-form" onSubmit={(event) => { void submit(event); }}>
      <h2>Add a document</h2>
      <label className="student-form-field"><span>Title</span><input name="title" required maxLength={160} placeholder="My CV" /></label>
      <label className="student-form-field"><span>Type</span><select name="documentType"><option>RESUME</option><option>CERTIFICATE</option><option>TRANSCRIPT</option><option>PORTFOLIO</option><option>OTHER</option></select></label>
      <label className="student-form-field"><span>Description</span><textarea name="description" maxLength={1000} /></label>
      <button type="submit">Add document</button>
    </form>
    <section className="card wide-card"><h2>Your documents</h2>{documents.length
      ? <div className="data-table-wrap"><table>
        <thead><tr><th>Title</th><th>Type</th><th>File</th><th>Verification</th><th>Actions</th></tr></thead>
        <tbody>{documents.map((doc) => <StudentDocumentRow key={doc.id} document={doc} onChanged={reload} onStatus={setStatus} />)}</tbody>
      </table></div>
      : <p>You have not added any documents yet.</p>}</section>
  </div>;
}

const DOCUMENT_UPLOAD_MESSAGES: Readonly<Record<string, string>> = {
  FILE_REJECTED_MALWARE: 'That file was rejected because a malware scan flagged it. Nothing was stored.',
  FILE_SCAN_UNAVAILABLE: 'The malware scanner is unavailable right now, so the file was not stored. Please try again shortly.',
  FILE_STORAGE_NOT_CONFIGURED: 'File uploads are not switched on yet.',
  UNSUPPORTED_FILE_TYPE: 'That file type is not accepted. Use a PDF, PNG, JPEG or Word document.',
  FILE_TOO_LARGE: 'That file is larger than 20 MB.',
  EMPTY_FILE: 'That file is empty.',
  FORBIDDEN: 'You cannot change that document.',
};

function StudentDocumentRow({ document: doc, onChanged, onStatus }: {
  readonly document: StudentDocumentDto;
  readonly onChanged: (message?: string) => Promise<void>;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function attach(file: File): Promise<void> {
    const token = getAccessToken();
    if (!token) return onStatus('You are not signed in.');
    if (file.size > MAX_DOCUMENT_BYTES) return onStatus(DOCUMENT_UPLOAD_MESSAGES.FILE_TOO_LARGE ?? 'That file is too large.');
    setBusy(true);
    onStatus(`Scanning ${file.name}…`);
    try {
      const result = await uploadDocumentFile(token, doc.id, file);
      await onChanged(`${result.file.filename} attached and scanned clean (version ${result.file.versionNumber}).`);
    } catch (error) {
      const code = error instanceof ApiRequestError ? error.code : undefined;
      onStatus((code && DOCUMENT_UPLOAD_MESSAGES[code]) ?? 'That file could not be attached.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function download(): Promise<void> {
    const token = getAccessToken();
    if (!token) return onStatus('You are not signed in.');
    try {
      const blob = await downloadDocumentFile(token, doc.id);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = doc.file?.filename ?? 'document';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      onStatus('That file could not be downloaded.');
    }
  }

  return <tr>
    <td>{doc.title}</td>
    <td>{doc.documentType}</td>
    <td>{doc.file
      ? <><strong>{doc.file.filename}</strong><br /><span className="hiring-meta">v{doc.file.versionNumber} · {Math.round(doc.file.byteSize / 1024)} KB · scanned clean</span></>
      : <span className="hiring-meta">No file attached</span>}</td>
    <td>{doc.verificationState}</td>
    <td><div className="hiring-actions">
      <input ref={inputRef} type="file" accept={ACCEPTED_DOCUMENT_TYPES} className="visually-hidden-file"
        aria-label={`Attach a file to ${doc.title}`} disabled={busy || Boolean(doc.archivedAt)}
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); }} />
      <button type="button" className="secondary" disabled={busy || Boolean(doc.archivedAt)} onClick={() => inputRef.current?.click()}>
        {busy ? 'Scanning…' : doc.file ? 'Replace file' : 'Attach file'}
      </button>
      {doc.file ? <button type="button" className="secondary" onClick={() => { void download(); }}>Download</button> : null}
      <button type="button" className="secondary" disabled={Boolean(doc.archivedAt)}
        onClick={() => { const token = getAccessToken(); if (token) void archiveStudentDocument(token, doc.id).then(() => onChanged('Document archived.')); }}>Archive</button>
    </div></td>
  </tr>;
}

function AuthenticatedStudentSavedOpportunities(): React.ReactElement {
  const [saved, setSaved] = useState<readonly StudentSavedOpportunityDto[]>([]);
  const [status, setStatus] = useState('Loading saved opportunities...');
  const reload = async (): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('No protected access token is available.');
    const response = await listStudentSavedOpportunities(token);
    setSaved(response.savedOpportunities);
    setStatus('Saved opportunities loaded.');
  };
  useEffect(() => { void reload().catch(() => setStatus('Saved opportunities could not be loaded.')); }, []);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return setStatus('No protected access token is available.');
    const form = new FormData(event.currentTarget);
    try {
      const response = await saveStudentOpportunity(token, {
        opportunityRef: String(form.get('opportunityRef') ?? ''),
        title: String(form.get('title') ?? ''),
        organizationName: String(form.get('organizationName') ?? ''),
        source: 'UAT_REFERENCE',
        notes: String(form.get('notes') ?? ''),
      });
      setSaved(response.savedOpportunities);
      event.currentTarget.reset();
      setStatus('Opportunity reference saved.');
    } catch {
      setStatus('Opportunity reference could not be saved.');
    }
  }
  return <div className="workspace-grid">
    <section className="card wide-card"><span className="eyebrow">Tracked elsewhere</span><h2>Roles you are tracking outside ONE</h2><p role="status">{status}</p><p>Applied somewhere else? Keep a note of it here so your whole search lives in one place.</p></section>
    <form className="card student-form" onSubmit={(event) => { void submit(event); }}>
      <h2>Save opportunity reference</h2>
      <label className="student-form-field"><span>Reference</span><input name="opportunityRef" required maxLength={128} /></label>
      <label className="student-form-field"><span>Title</span><input name="title" required maxLength={200} /></label>
      <label className="student-form-field"><span>Organization</span><input name="organizationName" maxLength={200} /></label>
      <label className="student-form-field"><span>Notes</span><textarea name="notes" maxLength={1000} /></label>
      <button type="submit">Save opportunity</button>
    </form>
    <section className="card wide-card"><h2>Saved list</h2>{saved.length ? <div className="data-table-wrap"><table><thead><tr><th>Title</th><th>Organization</th><th>Reference</th><th>Updated</th><th>Action</th></tr></thead><tbody>{saved.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.organizationName ?? 'Not provided'}</td><td>{item.opportunityRef}</td><td>{item.updatedAt}</td><td><button type="button" className="secondary" disabled={Boolean(item.archivedAt)} onClick={() => { const token = getAccessToken(); if (token) void removeStudentSavedOpportunity(token, item.id).then(reload); }}>Remove</button></td></tr>)}</tbody></table></div> : <p>No saved opportunity references yet.</p>}</section>
  </div>;
}

function AuthenticatedStudentUnavailable({ route }: { readonly route: RouteKey }): React.ReactElement {
  return <V2EmptyState icon="🧭" title={`${routeTitles[route].title} is not built yet`}
    note="This module is on the roadmap but has no live workflow behind it yet — nothing here is hidden or broken."
    hint="Your Home dashboard shows everything that is live for you today." />;
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
